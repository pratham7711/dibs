import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { TwitchAuth } from "../src/twitch/auth.js";
import { TwitchChatReplies } from "../src/twitch/chat.js";
import {
  parseEventSubTimestamp,
  TwitchEventSub,
} from "../src/twitch/eventsub.js";
import { DibsRuntime } from "../src/runtime.js";
import type { TwitchNotification } from "../src/twitch/eventsub.js";

const temporaryDirectories: string[] = [];
const servers: WebSocketServer[] = [];
const runtimes: DibsRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.stop();
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const directory of temporaryDirectories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function envelope(
  type: string,
  payload: unknown,
  extra: Record<string, unknown> = {},
) {
  return JSON.stringify({
    metadata: {
      message_id: `meta-${type}-${Math.random()}`,
      message_type: type,
      message_timestamp: new Date().toISOString(),
      ...extra,
    },
    payload,
  });
}

function chatNotification(
  id: string,
  viewer: number,
  timestamp: number,
): TwitchNotification {
  return {
    messageId: id,
    timestamp,
    type: "channel.chat.message",
    event: {
      chatter_user_id: `viewer-${viewer}`,
      chatter_user_login: `viewer${viewer}`,
      chatter_user_name: `Viewer${viewer}`,
      message: { text: "dibs" },
      badges: [],
    },
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  if (!predicate())
    throw new Error("Timed out waiting for expected Twitch event.");
}

describe("Twitch auth", () => {
  it("refreshes expiring tokens and stores the rotated refresh token", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dibs-auth-"));
    temporaryDirectories.push(directory);
    await writeFile(
      join(directory, "tokens.json"),
      JSON.stringify({
        access_token: "old",
        refresh_token: "refresh-old",
        expires_at: Date.now() - 1000,
      }),
    );
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        access_token: "new",
        refresh_token: "refresh-new",
        expires_in: 3600,
        scope: ["user:read:chat"],
      }),
    );
    const auth = new TwitchAuth({
      clientId: "client",
      directory,
      fetch: fetcher,
    });

    await expect(auth.getAccessToken()).resolves.toBe("new");
    const body = new URLSearchParams(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("refresh-old");
    await expect(
      readFile(join(directory, "tokens.json"), "utf8"),
    ).resolves.toContain("refresh-new");
  });
});

describe("Twitch chat replies", () => {
  it("turns a 30-claim burst into one batched chat reply", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ data: [{ is_sent: true }] }));
    const chat = new TwitchChatReplies({
      clientId: "client",
      broadcasterId: "broadcaster",
      senderId: "bot",
      getAccessToken: async () => "token",
      fetch: fetcher,
      batchWindowMs: 1000,
      minimumIntervalMs: 0,
    });
    for (let index = 0; index < 30; index += 1) {
      chat.enqueue({
        action: "granted",
        display: `Viewer${index}`,
        parentMessageId: `message-${index}`,
      });
    }
    await chat.flush();

    expect(fetcher).toHaveBeenCalledOnce();
    const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(request.message).toBe("Dibs update: 30 claimed.");
    expect(request.reply_parent_message_id).toBe("message-0");
    chat.close();
  });
});

describe("Twitch EventSub WebSocket", () => {
  it("retains sub-millisecond precision from Twitch timestamps", () => {
    const first = parseEventSubTimestamp("2026-10-30T10:00:00.000001000Z");
    const second = parseEventSubTimestamp("2026-10-30T10:00:00.000002000Z");
    expect(second).toBeGreaterThan(first);
  });
  it("welcomes, subscribes, receives notifications, handles keepalive and reconnects", async () => {
    const server = new WebSocketServer({ port: 0 });
    servers.push(server);
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected a WebSocket server address.");
    const socketUrl = `ws://127.0.0.1:${address.port}`;
    const connected: WebSocket[] = [];
    server.on("connection", (socket) => {
      connected.push(socket);
      const sessionId = `session-${connected.length}`;
      socket.send(
        envelope("session_welcome", {
          session: { id: sessionId, keepalive_timeout_seconds: 60 },
        }),
      );
      if (connected.length === 2) {
        socket.once("open", () => undefined);
      }
    });
    const subscribed: Record<string, unknown>[] = [];
    const notifications: TwitchNotification[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
      subscribed.push(
        JSON.parse(String(init?.body)) as Record<string, unknown>,
      );
      return jsonResponse({ data: [] }, 202);
    };
    const client = new TwitchEventSub({
      clientId: "client",
      broadcasterId: "broadcaster",
      botUserId: "bot",
      getAccessToken: async () => "token",
      onNotification: (notification) => {
        notifications.push(notification);
      },
      fetch: fetcher,
      eventsubUrl: socketUrl,
      reconnectDelayMs: 20,
    });
    client.start();
    await waitFor(() => connected.length === 1 && subscribed.length === 2);
    expect(subscribed[0]?.transport).toEqual({
      method: "websocket",
      session_id: "session-1",
    });

    connected[0]!.send(
      envelope(
        "notification",
        { event: { hello: "world" } },
        {
          subscription_type: "channel.chat.message",
          message_id: "notification-1",
        },
      ),
    );
    await waitFor(() => notifications.length === 1);
    connected[0]!.send(envelope("session_keepalive", {}));
    connected[0]!.send(
      envelope("session_reconnect", { session: { reconnect_url: socketUrl } }),
    );
    await waitFor(() => connected.length === 2);
    await waitFor(() => connected[0]!.readyState === 3);
    expect(subscribed).toHaveLength(2);
    client.close();
  });
});

describe("Dibs runtime", () => {
  it("deduplicates EventSub ids and promotes the waitlist after a cancellation", async () => {
    const states: Array<{ winners: string[]; waitlist: string[] }> = [];
    const auth = {
      getAccessToken: async () => "token",
    } as unknown as TwitchAuth;
    const fakeChat = { enqueue: vi.fn(), close: vi.fn() };
    const runtime = new DibsRuntime({
      auth,
      env: { TWITCH_CLIENT_ID: "client", TWITCH_CHANNEL: "streamer" },
      fetch: vi.fn(async (url: string | URL | Request) => {
        const target = String(url);
        if (target.includes("login=streamer"))
          return jsonResponse({ data: [{ id: "broadcaster" }] });
        return jsonResponse({ data: [{ id: "bot" }] });
      }) as typeof fetch,
      eventSubFactory: () =>
        ({ start: vi.fn(), close: vi.fn() }) as unknown as TwitchEventSub,
      chatFactory: () => fakeChat as unknown as TwitchChatReplies,
      onState: (state) =>
        states.push({
          winners: state.winners.map((claim) => claim.viewerId),
          waitlist: state.waitlist.map((claim) => claim.viewerId),
        }),
    });
    runtimes.push(runtime);
    await runtime.start();
    runtime.openDrop({ title: "Three game seats", spots: 3, settleMs: 1500 });

    const sentOrder = [6, 1, 5, 2, 4, 3];
    const baseTime = Date.now();
    for (const [index, viewer] of sentOrder.entries()) {
      await runtime.handleNotification(
        chatNotification(`message-${viewer}`, viewer, baseTime + viewer),
      );
      if (index === 0) {
        await runtime.handleNotification(
          chatNotification(`message-${viewer}`, 99, baseTime + viewer),
        );
      }
    }

    expect(runtime.snapshot.winners.map((claim) => claim.viewerId)).toEqual([
      "viewer-1",
      "viewer-2",
      "viewer-3",
    ]);
    expect(runtime.snapshot.waitlist.map((claim) => claim.viewerId)).toEqual([
      "viewer-4",
      "viewer-5",
      "viewer-6",
    ]);
    expect(
      runtime.snapshot.decisionLog.filter(
        (decision) => decision.action === "duplicate_ignored",
      ),
    ).toHaveLength(1);

    runtime.cancelClaim("message-2");
    expect(runtime.snapshot.winners.map((claim) => claim.viewerId)).toEqual([
      "viewer-1",
      "viewer-3",
      "viewer-4",
    ]);
    expect(states.length).toBeGreaterThan(1);
  });
});
