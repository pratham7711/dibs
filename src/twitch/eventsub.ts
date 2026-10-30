import WebSocket from "ws";
import type { RawData } from "ws";

export const DEFAULT_EVENTSUB_URL = "wss://eventsub.wss.twitch.tv/ws";
export const DEFAULT_HELIX_URL = "https://api.twitch.tv/helix";

export interface EventSubEnvelope {
  metadata: {
    message_id: string;
    message_type: string;
    message_timestamp: string;
    subscription_type?: string;
  };
  payload: {
    session?: {
      id: string;
      keepalive_timeout_seconds: number;
      reconnect_url?: string | null;
    };
    subscription?: { type?: string; status?: string };
    event?: Record<string, any>;
  };
}

export interface TwitchNotification {
  messageId: string;
  timestamp: number;
  type: string;
  event: Record<string, any>;
}

export function parseEventSubTimestamp(timestamp: string): number {
  const fraction = timestamp.match(/\.(\d+)(?=Z|[+-]\d\d:\d\d$)/)?.[1];
  const wholeSecond = Date.parse(
    timestamp.replace(/\.\d+(?=Z|[+-]\d\d:\d\d$)/, ""),
  );
  if (!Number.isFinite(wholeSecond)) return Number.NaN;
  return wholeSecond + (fraction ? Number(`0.${fraction}`) * 1000 : 0);
}

export interface SocketLike {
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: RawData) => void): this;
  on(event: "close", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  close(): void;
}

interface EventSubOptions {
  clientId: string;
  broadcasterId: string;
  botUserId: string;
  getAccessToken: () => Promise<string>;
  onNotification: (notification: TwitchNotification) => void | Promise<void>;
  onRevocation?: (subscriptionType: string, status: string) => void;
  onConnectionChange?: (connected: boolean) => void;
  onError?: (error: Error) => void;
  fetch?: typeof fetch;
  socketFactory?: (url: string) => SocketLike;
  eventsubUrl?: string;
  helixUrl?: string;
  reconnectDelayMs?: number;
}

export class TwitchEventSub {
  private readonly fetcher: typeof fetch;
  private readonly socketFactory: (url: string) => SocketLike;
  private readonly eventsubUrl: string;
  private readonly helixUrl: string;
  private socket?: SocketLike;
  private keepaliveTimer: ReturnType<typeof setTimeout> | undefined;
  private keepaliveTimeoutSeconds: number | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private reconnectDelayMs: number;

  constructor(private readonly options: EventSubOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
    this.eventsubUrl =
      options.eventsubUrl ??
      process.env.DIBS_EVENTSUB_WS_URL ??
      DEFAULT_EVENTSUB_URL;
    this.helixUrl = (
      options.helixUrl ??
      process.env.DIBS_HELIX_URL ??
      DEFAULT_HELIX_URL
    ).replace(/\/$/, "");
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1000;
  }

  start(): void {
    this.closed = false;
    this.connect(this.eventsubUrl, false);
  }

  close(): void {
    this.closed = true;
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
  }

  private connect(
    url: string,
    isReconnect: boolean,
    oldSocket = this.socket,
  ): void {
    const nextSocket = this.socketFactory(url);
    if (!isReconnect) this.socket = nextSocket;

    nextSocket.on("message", (raw) => {
      void this.handleMessage(nextSocket, raw, isReconnect, oldSocket).catch(
        (error: unknown) => {
          this.options.onError?.(
            error instanceof Error ? error : new Error(String(error)),
          );
        },
      );
    });
    nextSocket.on("close", () => {
      if (this.closed) return;
      this.options.onConnectionChange?.(false);
      if (nextSocket === this.socket || isReconnect) this.scheduleReconnect();
    });
    nextSocket.on("error", (error) => this.options.onError?.(error));
  }

  private async handleMessage(
    socket: SocketLike,
    raw: RawData,
    isReconnect: boolean,
    oldSocket?: SocketLike,
  ): Promise<void> {
    let message: EventSubEnvelope;
    try {
      message = JSON.parse(raw.toString()) as EventSubEnvelope;
    } catch {
      this.options.onError?.(new Error("Received invalid EventSub JSON."));
      return;
    }
    this.resetKeepalive(message.payload.session?.keepalive_timeout_seconds);
    const type = message.metadata.message_type;

    if (type === "session_welcome") {
      this.options.onConnectionChange?.(true);
      if (isReconnect) {
        this.socket = socket;
        oldSocket?.close();
      } else {
        await this.subscribe(message.payload.session!.id);
        if (oldSocket && oldSocket !== socket) oldSocket.close();
      }
    } else if (type === "session_reconnect") {
      const reconnectUrl = message.payload.session?.reconnect_url;
      if (reconnectUrl) this.connect(reconnectUrl, true, socket);
    } else if (type === "notification") {
      await this.options.onNotification({
        messageId: message.metadata.message_id,
        timestamp: parseEventSubTimestamp(message.metadata.message_timestamp),
        type: message.metadata.subscription_type ?? "",
        event: message.payload.event ?? {},
      });
    } else if (type === "revocation") {
      this.options.onRevocation?.(
        message.payload.subscription?.type ??
          message.metadata.subscription_type ??
          "unknown",
        message.payload.subscription?.status ?? "unknown",
      );
    }
  }

  private resetKeepalive(seconds?: number): void {
    if (seconds !== undefined && seconds !== null) {
      this.keepaliveTimeoutSeconds = seconds;
    }
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
    if (this.keepaliveTimeoutSeconds === undefined) return;
    this.keepaliveTimer = setTimeout(
      () => this.scheduleReconnect(),
      this.keepaliveTimeoutSeconds * 1000,
    );
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect(this.eventsubUrl, false);
    }, this.reconnectDelayMs);
  }

  private async subscribe(sessionId: string): Promise<void> {
    const subscriptions = [
      {
        type: "channel.chat.message",
        version: "1",
        condition: {
          broadcaster_user_id: this.options.broadcasterId,
          user_id: this.options.botUserId,
        },
      },
      {
        type: "channel.channel_points_custom_reward_redemption.add",
        version: "1",
        condition: { broadcaster_user_id: this.options.broadcasterId },
      },
    ];
    const token = await this.options.getAccessToken();
    const results = await Promise.all(
      subscriptions.map(async (subscription) => {
        const response = await this.fetcher(
          `${this.helixUrl}/eventsub/subscriptions`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Client-Id": this.options.clientId,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              ...subscription,
              transport: { method: "websocket", session_id: sessionId },
            }),
          },
        );
        if (!response.ok) {
          const detail = await response.text();
          throw new Error(
            `EventSub subscription failed (${response.status}): ${detail}`,
          );
        }
      }),
    );
    void results;
  }
}
