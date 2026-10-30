import { DEFAULT_HELIX_URL } from "./eventsub.js";

export type ReplyAction = "granted" | "waitlisted" | "promoted" | "cancelled";
export interface ChatReplyDecision {
  action: ReplyAction;
  display: string;
  parentMessageId: string;
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
  sleep?: (milliseconds: number) => Promise<void>;
}

export class TwitchChatReplies {
  private readonly fetcher: typeof fetch;
  private readonly helixUrl: string;
  private readonly batchWindowMs: number;
  private readonly minimumIntervalMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private queued: ChatReplyDecision[] = [];
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
    this.queued.push(decision);
    if (!this.timer && !this.sending) this.scheduleFlush();
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.sending || this.queued.length === 0) return;
    this.sending = true;
    const batch = this.queued.splice(0);
    try {
      const waitMs = this.minimumIntervalMs - (Date.now() - this.lastSentAt);
      if (this.lastSentAt && waitMs > 0) await this.sleep(waitMs);
      await this.send(batch);
      this.lastSentAt = Date.now();
    } finally {
      this.sending = false;
      if (this.queued.length > 0 && !this.timer) this.scheduleFlush();
    }
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

  private async send(batch: ChatReplyDecision[]): Promise<void> {
    const token = await this.options.getAccessToken();
    const response = await this.fetcher(`${this.helixUrl}/chat/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Client-Id": this.options.clientId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        broadcaster_id: this.options.broadcasterId,
        sender_id: this.options.senderId,
        message: summarizeBatch(batch),
        reply_parent_message_id: batch[0]!.parentMessageId,
      }),
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
        body: JSON.stringify({
          broadcaster_id: this.options.broadcasterId,
          sender_id: this.options.senderId,
          message: summarizeBatch(batch),
          reply_parent_message_id: batch[0]!.parentMessageId,
        }),
      });
      if (!retry.ok) throw new Error(`Chat reply failed (${retry.status}).`);
    } else if (!response.ok) {
      throw new Error(`Chat reply failed (${response.status}).`);
    }
  }
}

function summarizeBatch(batch: ChatReplyDecision[]): string {
  if (batch.length === 1) {
    const item = batch[0]!;
    if (item.action === "granted") return `@${item.display} you're in!`;
    if (item.action === "waitlisted")
      return `@${item.display} you're on the waitlist.`;
    if (item.action === "promoted")
      return `@${item.display} moved up from the waitlist!`;
    return `@${item.display} your spot was cancelled.`;
  }

  const counts = new Map<ReplyAction, number>();
  for (const item of batch)
    counts.set(item.action, (counts.get(item.action) ?? 0) + 1);
  const summary = [
    counts.has("granted") && `${counts.get("granted")} claimed`,
    counts.has("waitlisted") && `${counts.get("waitlisted")} waitlisted`,
    counts.has("promoted") && `${counts.get("promoted")} moved up`,
    counts.has("cancelled") && `${counts.get("cancelled")} cancelled`,
  ].filter(Boolean);
  return `Dibs update: ${summary.join(", ")}.`;
}
