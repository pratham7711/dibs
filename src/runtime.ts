import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { reduceEvent, initialAllocation } from "./core/reducer.js";
import type { Allocation, Drop, DropEvent } from "./core/types.js";
import { ResolverPipeline } from "./resolver/pipeline.js";
import type { ResolvedMessage } from "./resolver/pipeline.js";
import { TwitchAuth } from "./twitch/auth.js";
import { TwitchChatReplies } from "./twitch/chat.js";
import type { ReplyAction } from "./twitch/chat.js";
import { TwitchEventSub } from "./twitch/eventsub.js";
import type { TwitchNotification } from "./twitch/eventsub.js";

export interface RuntimeOptions {
  auth?: TwitchAuth;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  eventSubFactory?: (
    options: ConstructorParameters<typeof TwitchEventSub>[0],
  ) => TwitchEventSub;
  chatFactory?: (
    options: ConstructorParameters<typeof TwitchChatReplies>[0],
  ) => TwitchChatReplies;
  resolverFactory?: (drop: Drop) => Pick<ResolverPipeline, "resolve">;
  onState?: (state: Allocation) => void;
  batchWindowMs?: number;
  eventSubUrl?: string;
  helixUrl?: string;
  socketFactory?: ConstructorParameters<
    typeof TwitchEventSub
  >[0]["socketFactory"];
}

export class DibsRuntime {
  private readonly env: Record<string, string | undefined>;
  private readonly fetcher: typeof fetch;
  private readonly auth: TwitchAuth;
  private state: Allocation = initialAllocation();
  private eventSub?: TwitchEventSub;
  private chat?: TwitchChatReplies;
  private resolver?: Pick<ResolverPipeline, "resolve">;
  private readonly listeners = new Set<(state: Allocation) => void>();
  private readonly seenPointsRedemptions = new Set<string>();
  private tokenValidationTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: RuntimeOptions = {}) {
    this.env = options.env ?? process.env;
    this.fetcher = options.fetch ?? fetch;
    this.auth =
      options.auth ?? new TwitchAuth({ env: this.env, fetch: this.fetcher });
  }

  get snapshot(): Allocation {
    return this.state;
  }

  subscribe(listener: (state: Allocation) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    const channelLogin = this.env.TWITCH_CHANNEL;
    const clientId = this.env.TWITCH_CLIENT_ID;
    if (!channelLogin || !clientId)
      throw new Error("Set TWITCH_CHANNEL and TWITCH_CLIENT_ID first.");
    const token = this.auth.validateAccessToken
      ? (await this.auth.validateAccessToken()).access_token
      : await this.auth.getAccessToken();
    const [broadcaster, bot] = await Promise.all([
      this.getUserByLogin(channelLogin, token, clientId),
      this.getCurrentUser(token, clientId),
    ]);
    const tokenProvider = () => this.auth.getAccessToken();
    this.chat = (
      this.options.chatFactory ?? ((config) => new TwitchChatReplies(config))
    )({
      clientId,
      broadcasterId: broadcaster.id,
      senderId: bot.id,
      getAccessToken: tokenProvider,
      fetch: this.fetcher,
      ...(this.options.helixUrl ? { helixUrl: this.options.helixUrl } : {}),
    });
    this.eventSub = (
      this.options.eventSubFactory ?? ((config) => new TwitchEventSub(config))
    )({
      clientId,
      broadcasterId: broadcaster.id,
      botUserId: bot.id,
      getAccessToken: tokenProvider,
      fetch: this.fetcher,
      ...(this.options.helixUrl ? { helixUrl: this.options.helixUrl } : {}),
      ...(this.options.eventSubUrl
        ? { eventsubUrl: this.options.eventSubUrl }
        : {}),
      ...(this.options.socketFactory
        ? { socketFactory: this.options.socketFactory }
        : {}),
      onNotification: (notification) => this.handleNotification(notification),
      onRevocation: (type, status) =>
        console.error(`EventSub ${type} revoked: ${status}`),
      onError: (error) => console.error(error.message),
    });
    this.eventSub.start();
    this.tokenValidationTimer = setInterval(
      () => {
        void this.auth.validateAccessToken().catch((error: unknown) => {
          console.error(error instanceof Error ? error.message : error);
          this.stop();
        });
      },
      60 * 60 * 1000,
    );
    this.tokenValidationTimer.unref?.();
  }

  stop(): void {
    if (this.tokenValidationTimer) clearInterval(this.tokenValidationTimer);
    this.tokenValidationTimer = undefined;
    this.eventSub?.close();
    this.chat?.close();
  }

  openDrop(input: Partial<Drop> & Pick<Drop, "title" | "spots">): Allocation {
    if (this.state.drop?.status === "open") {
      throw new Error("Close the current drop before opening another one.");
    }
    if (!input.title.trim()) throw new Error("Drop title is required.");
    if (!Number.isInteger(input.spots) || input.spots <= 0) {
      throw new Error("Drop spots must be a positive integer.");
    }
    const perViewerLimit = input.perViewerLimit ?? 1;
    if (!Number.isInteger(perViewerLimit) || perViewerLimit <= 0) {
      throw new Error("Per-viewer limit must be a positive integer.");
    }
    if (input.settleMs !== undefined && input.settleMs < 0) {
      throw new Error("Settle window cannot be negative.");
    }
    if (input.subsFirstSeconds !== undefined && input.subsFirstSeconds < 0) {
      throw new Error("Subscriber window cannot be negative.");
    }
    if (this.state.drop?.status === "closed") this.state = initialAllocation();
    const drop: Drop = {
      id: input.id ?? crypto.randomUUID(),
      title: input.title,
      spots: input.spots,
      perViewerLimit,
      settleMs: input.settleMs ?? 1500,
      status: "open",
      ...(input.subsFirstSeconds === undefined
        ? {}
        : { subsFirstSeconds: input.subsFirstSeconds }),
    };
    this.resolver =
      this.options.resolverFactory?.(drop) ?? new ResolverPipeline(drop);
    this.apply({ type: "DropOpened", at: Date.now(), drop });
    return this.state;
  }

  closeDrop(): Allocation {
    if (this.state.drop) this.apply({ type: "DropClosed", at: Date.now() });
    return this.state;
  }

  async handleNotification(notification: TwitchNotification): Promise<void> {
    if (!this.state.drop || this.state.drop.status !== "open" || !this.resolver)
      return;
    const { event } = notification;
    if (
      notification.type ===
      "channel.channel_points_custom_reward_redemption.add"
    ) {
      if (this.seenPointsRedemptions.has(notification.messageId)) return;
      this.seenPointsRedemptions.add(notification.messageId);
      const text = `dibs ${String(event.reward?.title ?? "channel points redemption")}`;
      await this.processClaim({
        id: notification.messageId,
        text,
        viewerId: String(event.user_id),
        login: String(event.user_login ?? event.user_name ?? event.user_id),
        display: String(event.user_name ?? event.user_login ?? event.user_id),
        isSubscriber: false,
        twitchTimestamp: notification.timestamp,
        source: "channel_points",
      });
      return;
    }
    if (notification.type !== "channel.chat.message") return;
    const badges = Array.isArray(event.badges) ? event.badges : [];
    await this.processClaim({
      id: notification.messageId,
      text: String(event.message?.text ?? ""),
      viewerId: String(event.chatter_user_id),
      login: String(
        event.chatter_user_login ??
          event.chatter_user_name ??
          event.chatter_user_id,
      ),
      display: String(
        event.chatter_user_name ??
          event.chatter_user_login ??
          event.chatter_user_id,
      ),
      isSubscriber: badges.some(
        (badge: { set_id?: string }) => badge.set_id === "subscriber",
      ),
      twitchTimestamp: notification.timestamp,
      source: "chat",
    });
  }

  approveClaim(messageId: string, qty?: number): Allocation {
    const claim = this.state.reviewQueue.find(
      (item) => item.messageId === messageId,
    );
    if (!claim) throw new Error("Review claim was not found.");
    this.apply({
      type: "ClaimApproved",
      at: Date.now(),
      viewerId: claim.viewerId,
      messageId: claim.messageId,
      ...(qty === undefined ? {} : { qty }),
    });
    return this.state;
  }

  rejectClaim(messageId: string): Allocation {
    const claim = this.state.reviewQueue.find(
      (item) => item.messageId === messageId,
    );
    const winner = this.state.winners.find(
      (item) => item.messageId === messageId,
    );
    const target = claim ?? winner;
    if (!target) throw new Error("Claim was not found.");
    this.apply({
      type: "ClaimRejected",
      at: Date.now(),
      viewerId: target.viewerId,
    });
    return this.state;
  }

  cancelClaim(messageId: string): Allocation {
    const target = [...this.state.winners, ...this.state.waitlist].find(
      (item) => item.messageId === messageId,
    );
    if (!target) throw new Error("Claim was not found.");
    this.apply({
      type: "ClaimCancelled",
      at: Date.now(),
      viewerId: target.viewerId,
    });
    this.chat?.enqueue({
      action: "cancelled",
      display: target.display,
      parentMessageId: messageId,
    });
    return this.state;
  }

  private async processClaim(input: {
    id: string;
    text: string;
    viewerId: string;
    login: string;
    display: string;
    isSubscriber: boolean;
    twitchTimestamp: number;
    source: "chat" | "channel_points";
  }): Promise<void> {
    const resolution: ResolvedMessage = await this.resolver!.resolve({
      id: input.id,
      text: input.text,
      viewerId: input.viewerId,
      spotsLeft: Math.max(
        0,
        (this.state.drop?.spots ?? 0) -
          this.state.winners.reduce((total, item) => total + item.qty, 0),
      ),
    });
    if (resolution.intent === "cancel") {
      const priorClaim = [...this.state.winners, ...this.state.waitlist].find(
        (claim) => claim.viewerId === input.viewerId,
      );
      this.apply({
        type: "ClaimCancelled",
        at: Date.now(),
        viewerId: input.viewerId,
        ...(priorClaim ? { messageId: priorClaim.messageId } : {}),
        reason: resolution.why,
      });
      if (priorClaim)
        this.chat?.enqueue({
          action: "cancelled",
          display: input.display,
          parentMessageId: input.id,
        });
      return;
    }
    if (resolution.intent !== "claim") return;

    this.apply({
      type: "ClaimReceived",
      at: Date.now(),
      messageId: input.id,
      viewerId: input.viewerId,
      login: input.login,
      display: input.display,
      isSubscriber: input.isSubscriber,
      twitchTimestamp: input.twitchTimestamp,
      receivedAt: Date.now(),
      qty: resolution.qty,
      source: input.source,
      confidence: resolution.confidence,
      reason: resolution.why,
    });
  }

  private apply(event: DropEvent): void {
    const previousDecisionCount = this.state.decisionLog.length;
    this.state = reduceEvent(this.state, event);
    const newDecisions = this.state.decisionLog.slice(previousDecisionCount);
    for (const decision of newDecisions) {
      const action = replyAction(decision.action);
      if (!action || !decision.messageId) continue;
      const claim = [...this.state.winners, ...this.state.waitlist].find(
        (item) => item.messageId === decision.messageId,
      );
      if (claim)
        this.chat?.enqueue({
          action,
          display: claim.display,
          parentMessageId: claim.messageId,
        });
    }
    this.options.onState?.(this.state);
    for (const listener of this.listeners) listener(this.state);
  }

  private async getUserByLogin(
    login: string,
    token: string,
    clientId: string,
  ): Promise<{ id: string }> {
    const users = await this.helixGet(
      `/users?login=${encodeURIComponent(login)}`,
      token,
      clientId,
    );
    const user = users.data?.[0] as { id?: string } | undefined;
    if (!user?.id) throw new Error(`Twitch channel "${login}" was not found.`);
    return { id: user.id };
  }

  private async getCurrentUser(
    token: string,
    clientId: string,
  ): Promise<{ id: string }> {
    const users = await this.helixGet("/users", token, clientId);
    const user = users.data?.[0] as { id?: string } | undefined;
    if (!user?.id)
      throw new Error("Could not identify the signed-in Twitch bot account.");
    return { id: user.id };
  }

  private async helixGet(
    path: string,
    token: string,
    clientId: string,
  ): Promise<{ data?: unknown[] }> {
    const helixUrl = (
      this.options.helixUrl ??
      this.env.DIBS_HELIX_URL ??
      "https://api.twitch.tv/helix"
    ).replace(/\/$/, "");
    const response = await this.fetcher(`${helixUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}`, "Client-Id": clientId },
    });
    if (!response.ok)
      throw new Error(
        `Twitch request failed (${response.status}): ${await response.text()}`,
      );
    return (await response.json()) as { data?: unknown[] };
  }
}

function replyAction(action: string): ReplyAction | undefined {
  if (action === "granted" || action === "granted_by_timestamp")
    return "granted";
  if (action === "waitlisted") return "waitlisted";
  if (action === "promoted") return "promoted";
  return undefined;
}

export function createDibsHttpServer(runtime: DibsRuntime) {
  const clients = new Set<ServerResponse>();
  runtime.subscribe((state) => {
    const payload = `data: ${JSON.stringify(state)}\n\n`;
    for (const client of clients) client.write(payload);
  });
  return createServer(async (request, response) => {
    try {
      await routeRequest(runtime, clients, request, response);
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Request failed.",
      });
    }
  });
}

async function routeRequest(
  runtime: DibsRuntime,
  clients: Set<ServerResponse>,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "GET" && url.pathname === "/events") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    clients.add(response);
    response.write(`data: ${JSON.stringify(runtime.snapshot)}\n\n`);
    request.on("close", () => clients.delete(response));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/drop/winners.csv") {
    sendCsv(response, runtime.snapshot);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/drop") {
    sendJson(response, 200, runtime.snapshot);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/drop") {
    const body = await readJson(request);
    sendJson(
      response,
      201,
      runtime.openDrop(body as Partial<Drop> & Pick<Drop, "title" | "spots">),
    );
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/drop/close") {
    sendJson(response, 200, runtime.closeDrop());
    return;
  }
  const reviewMatch = url.pathname.match(
    /^\/api\/review\/([^/]+)\/(approve|reject)$/,
  );
  if (request.method === "POST" && reviewMatch) {
    const claimId = decodeURIComponent(reviewMatch[1]!);
    const body = await readJson(request);
    const state =
      reviewMatch[2] === "approve"
        ? runtime.approveClaim(claimId, body.qty as number | undefined)
        : runtime.rejectClaim(claimId);
    sendJson(response, 200, state);
    return;
  }
  const cancelMatch = url.pathname.match(/^\/api\/claims\/([^/]+)\/cancel$/);
  if (request.method === "POST" && cancelMatch) {
    sendJson(
      response,
      200,
      runtime.cancelClaim(decodeURIComponent(cancelMatch[1]!)),
    );
    return;
  }
  if (request.method === "GET" && url.pathname === "/overlay") {
    sendHtml(
      response,
      "<main><h1>Dibs live overlay</h1><p>Live drop race view is coming next.</p></main>",
    );
    return;
  }
  if (request.method === "GET" && url.pathname === "/dashboard") {
    sendHtml(
      response,
      "<main><h1>Dibs dashboard</h1><p>Drop controls are available through the API.</p></main>",
    );
    return;
  }
  sendJson(response, 404, { error: "Not found." });
}

async function readJson(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  if (size === 0) return {};
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a JSON object.");
  return value as Record<string, unknown>;
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

function sendHtml(response: ServerResponse, content: string): void {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html><body>${content}</body></html>`);
}

function sendCsv(response: ServerResponse, state: Allocation): void {
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const rows = [
    ["login", "display", "qty", "twitch_timestamp"],
    ...state.winners.map((claim) => [
      claim.login,
      claim.display,
      String(claim.qty),
      new Date(claim.twitchTimestamp).toISOString(),
    ]),
  ];
  response.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": "attachment; filename=dibs-winners.csv",
  });
  response.end(rows.map((row) => row.map(quote).join(",")).join("\r\n"));
}
