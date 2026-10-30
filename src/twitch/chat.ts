import { DEFAULT_HELIX_URL } from "./eventsub.js";

export type ReplyAction = "granted" | "waitlisted" | "promoted" | "cancelled";
export interface ChatReplyDecision {
  action: ReplyAction;
  display: string;
  login?: string;
  parentMessageId: string;
  spotNumber?: number;
  spotsTotal?: number;
  waitlistNumber?: number;
}

export interface ChatReplyText {
  message: string;
  parentMessageId?: string;
}

interface ChatOptions {
  clientId: string;
  broadcasterId: string;
  senderId: string;
  getAccessToken: () => Promise<string>;
  fetch?: typeof fetch;
  helixUrl?: string;
  batchWindowMs?: number;
  minimumIntervalMs?: number;
  onError?: (error: Error) => void;
  onSend?: (message: string, parentMessageId?: string) => void;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class TwitchChatReplies {
  private readonly fetcher: typeof fetch;
  private readonly helixUrl: string;
  private readonly batchWindowMs: number;
  private readonly minimumIntervalMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private queued: ChatReplyDecision[] = [];
  private directQueue: ChatReplyText[] = [];
  private statusQueue: ChatReplyText | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sending = false;
  private lastSentAt = 0;

  constructor(private readonly options: ChatOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.helixUrl = (
      options.helixUrl ??
      process.env.DIBS_HELIX_URL ??
      DEFAULT_HELIX_URL
    ).replace(/\/$/, "");
    this.batchWindowMs = options.batchWindowMs ?? 150;
    this.minimumIntervalMs = options.minimumIntervalMs ?? 1600;
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  enqueue(decision: ChatReplyDecision): void {
    this.statusQueue = undefined;
    this.queued.push(decision);
    if (!this.timer && !this.sending) this.scheduleFlush();
  }

  enqueueDirect(reply: ChatReplyText): void {
    this.statusQueue = undefined;
    this.directQueue.push(reply);
    if (!this.timer && !this.sending) this.scheduleFlush();
  }

  enqueueAnnouncement(message: string): void {
    this.enqueueDirect({ message });
  }

  enqueueStatus(reply: ChatReplyText): boolean {
    if (
      this.queued.length > 0 ||
      this.directQueue.length > 0 ||
      this.statusQueue ||
      this.sending
    )
      return false;
    this.statusQueue = reply;
    if (!this.timer) this.scheduleFlush();
    return true;
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.sending) return;
    const batch = this.queued.splice(0);
    const direct = batch.length === 0 ? this.directQueue.shift() : undefined;
    const status =
      batch.length === 0 && !direct ? this.takeStatus() : undefined;
    if (batch.length === 0 && !direct && !status) return;

    this.sending = true;
    try {
      const waitMs = this.minimumIntervalMs - (Date.now() - this.lastSentAt);
      if (this.lastSentAt && waitMs > 0) await this.sleep(waitMs);
      if (status && (this.queued.length > 0 || this.directQueue.length > 0)) {
        // Status is low priority; discard it if a decision reply arrived while waiting.
        this.sending = false;
        this.scheduleFlush();
        return;
      }
      if (direct && this.queued.length > 0) {
        this.directQueue.unshift(direct);
        this.sending = false;
        this.scheduleFlush();
        return;
      }
      const message = batch.length
        ? summarizeBatch(batch)
        : (direct ?? status)!.message;
      const parentMessageId =
        batch[0]?.parentMessageId ?? (direct ?? status)?.parentMessageId;
      await this.send(message, parentMessageId);
      this.lastSentAt = Date.now();
    } finally {
      this.sending = false;
      if (
        (this.queued.length > 0 ||
          this.directQueue.length > 0 ||
          this.statusQueue) &&
        !this.timer
      ) {
        this.scheduleFlush();
      }
    }
  }

  private takeStatus(): ChatReplyText | undefined {
    const status = this.statusQueue;
    this.statusQueue = undefined;
    return status;
  }

  private scheduleFlush(): void {
    this.timer = setTimeout(() => {
      void this.flush().catch((error: unknown) => {
        const failure =
          error instanceof Error ? error : new Error(String(error));
        if (this.options.onError) this.options.onError(failure);
        else console.error(failure.message);
      });
    }, this.batchWindowMs);
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async send(message: string, parentMessageId?: string): Promise<void> {
    if (this.options.onSend) {
      this.options.onSend(message, parentMessageId);
      return;
    }
    const token = await this.options.getAccessToken();
    const response = await this.fetcher(`${this.helixUrl}/chat/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Client-Id": this.options.clientId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(chatRequest(this.options, message, parentMessageId)),
    });
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("Retry-After") ?? 1);
      await this.sleep(Math.max(1, retryAfter) * 1000);
      const retry = await this.fetcher(`${this.helixUrl}/chat/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await this.options.getAccessToken()}`,
          "Client-Id": this.options.clientId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          chatRequest(this.options, message, parentMessageId),
        ),
      });
      if (!retry.ok) throw new Error(`Chat reply failed (${retry.status}).`);
    } else if (!response.ok) {
      throw new Error(`Chat reply failed (${response.status}).`);
    }
  }
}

function chatRequest(
  options: ChatOptions,
  message: string,
  parentMessageId?: string,
) {
  return {
    broadcaster_id: options.broadcasterId,
    sender_id: options.senderId,
    message,
    ...(parentMessageId ? { reply_parent_message_id: parentMessageId } : {}),
  };
}

export function summarizeBatch(batch: ChatReplyDecision[]): string {
  if (batch.length === 1) return summarizeOne(batch[0]!);

  const winners = batch.filter(
    (item) => item.action === "granted" || item.action === "promoted",
  );
  const waitlist = batch.filter((item) => item.action === "waitlisted");
  const cancelled = batch.filter((item) => item.action === "cancelled");
  const units: string[] = [];
  winners.forEach((item, index) => {
    const position = item.spotNumber ?? index + 1;
    units.push(`${index === 0 ? "✅ " : " · "}#${position} @${item.display}`);
  });
  waitlist.forEach((item, index) => {
    units.push(`${index === 0 ? " · ⏳ waitlist: " : ", "}@${item.display}`);
  });
  cancelled.forEach((item, index) => {
    units.push(`${index === 0 ? " · ↩ cancelled: " : ", "}@${item.display}`);
  });
  return capUnits(
    units.map((unit, index) => (index === 0 ? unit.replace(/^ · /, "") : unit)),
  );
}

function summarizeOne(item: ChatReplyDecision): string {
  const name = `@${item.display}`;
  if (item.action === "granted") {
    const rank = item.spotNumber
      ? `#${item.spotNumber} of ${item.spotsTotal ?? "?"}`
      : "in";
    return capText(`✅ ${name} — you're ${rank}!`);
  }
  if (item.action === "waitlisted")
    return capText(`⏳ ${name} — waitlist #${item.waitlistNumber ?? "?"}.`);
  if (item.action === "promoted")
    return capText(`⬆ ${name} moved up into spot #${item.spotNumber ?? "?"}!`);
  return capText(`↩ ${name}, your spot was cancelled.`);
}

function capUnits(units: string[]): string {
  let message = "";
  for (let index = 0; index < units.length; index += 1) {
    const candidate = `${message}${units[index]}`;
    const omitted = units.length - index - 1;
    const suffix = omitted > 0 ? ` · +${omitted} more` : "";
    if (candidate.length + suffix.length > 500) {
      const skipped = units.length - index;
      const overflow = `${message ? " · " : ""}+${skipped} more`;
      return `${message}${overflow}`.slice(0, 500);
    }
    message = candidate;
  }
  return message.slice(0, 500);
}

function capText(message: string): string {
  return message.length <= 500 ? message : `${message.slice(0, 490)}…`;
}
