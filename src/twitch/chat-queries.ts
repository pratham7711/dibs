import type { Allocation, Claim } from "../core/types.js";

export type ChatQueryKind = "spot" | "status";

export class StatusReplyThrottle {
  private dropId: string | undefined;
  private lastSentAt: number | undefined;

  reset(dropId?: string): void {
    this.dropId = dropId;
    this.lastSentAt = undefined;
  }

  canSend(dropId: string | undefined, now: number): boolean {
    if (dropId !== this.dropId) return true;
    return this.lastSentAt === undefined || now - this.lastSentAt >= 15_000;
  }

  markSent(dropId: string | undefined, now: number): void {
    this.dropId = dropId;
    this.lastSentAt = now;
  }
}

export function classifyChatQuery(text: string): ChatQueryKind | undefined {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[?!.,]+$/g, "")
    .replace(/\s+/g, " ");
  if (
    normalized === "!spot" ||
    /^(where am i|did i get (?:one|it|a spot)|am i in|mera number)$/.test(
      normalized,
    )
  )
    return "spot";
  if (
    /^(who got it|who won|is it over|how many (?:spots? )?(?:are )?left|how many spots are left|kitne bache)$/.test(
      normalized,
    )
  )
    return "status";
  return undefined;
}

export function spotReplyForViewer(
  state: Allocation,
  viewerId: string,
): string {
  const winners = ordered(state.winners);
  let spotNumber = 1;
  for (const claim of winners) {
    if (claim.viewerId === viewerId) {
      return `you're #${spotNumber} of ${state.drop?.spots ?? "?"}`;
    }
    spotNumber += claim.qty;
  }
  const waiting = ordered(state.waitlist);
  const waitlistNumber = waiting.findIndex(
    (claim) => claim.viewerId === viewerId,
  );
  if (waitlistNumber >= 0) return `waitlist #${waitlistNumber + 1}`;
  if (state.reviewQueue.some((claim) => claim.viewerId === viewerId))
    return "in review, the streamer will decide";
  return "no claim yet, say dibs";
}

export function publicStatusLine(
  state: Allocation,
  firstClaimAt: number | undefined,
  soldOutAt: number | undefined,
  now: number,
): string {
  const drop = state.drop;
  if (!drop || (drop.status === "closed" && !state.winners.length))
    return "No drop is open right now.";
  const claimed = state.winners.reduce((total, claim) => total + claim.qty, 0);
  const left = Math.max(0, drop.spots - claimed);
  const waiters = ordered(state.waitlist);
  if (left === 0) {
    const soldOutSeconds =
      firstClaimAt === undefined
        ? ""
        : ` in ${Math.max(0, ((soldOutAt ?? now) - firstClaimAt) / 1000).toFixed(1)} s`;
    const names = ordered(state.winners).map(displayName).join(" ");
    return capStatusLine(
      `SOLD OUT${soldOutSeconds}: ${names} · ${waiters.length} on the waitlist`,
    );
  }
  if (drop.status === "closed")
    return `DROP CLOSED · ${left} of ${drop.spots} left`;
  const names = ordered(state.winners).map(displayName);
  return capStatusLine(
    `${left} of ${drop.spots} left, say dibs${names.length ? ` · in: ${names.join(", ")}` : ""}`,
  );
}

function ordered(claims: Claim[]): Claim[] {
  return [...claims].sort((a, b) => a.twitchTimestamp - b.twitchTimestamp);
}

function displayName(claim: Claim): string {
  return `@${claim.display || claim.login}`;
}

function capStatusLine(message: string): string {
  return message.length <= 500 ? message : `${message.slice(0, 496)}…`;
}
