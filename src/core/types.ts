export type DropStatus = "open" | "closed";
export type ClaimSource = "chat" | "channel_points";
export interface Drop {
  id: string;
  title: string;
  spots: number;
  perViewerLimit: number;
  subsFirstSeconds?: number;
  settleMs: number;
  status: DropStatus;
}
export interface Claim {
  messageId: string;
  viewerId: string;
  login: string;
  display: string;
  isSubscriber: boolean;
  twitchTimestamp: number;
  receivedAt: number;
  qty: number;
  source: ClaimSource;
  confidence: number;
  reason: string;
}
export type DropEvent =
  | { type: "DropOpened"; at: number; drop: Drop }
  | ({ type: "ClaimReceived"; at: number } & Claim)
  | { type: "ClaimCancelled"; at: number; viewerId: string; reason?: string }
  | {
      type: "ClaimApproved";
      at: number;
      viewerId: string;
      qty?: number;
      reason?: string;
    }
  | { type: "ClaimRejected"; at: number; viewerId: string; reason?: string }
  | { type: "DropClosed"; at: number; reason?: string };
export interface Decision {
  at: number;
  viewerId?: string;
  messageId?: string;
  action: string;
  why: string;
}
export interface Allocation {
  drop?: Drop;
  winners: Claim[];
  waitlist: Claim[];
  reviewQueue: Claim[];
  perViewerCounts: Record<string, number>;
  decisionLog: Decision[];
  seenMessageIds: string[];
}
