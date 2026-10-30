import { normalizeWhy } from "./why.js";
import type { Allocation, Claim, Decision, DropEvent } from "./types.js";

export const initialAllocation = (): Allocation => ({
  winners: [],
  waitlist: [],
  reviewQueue: [],
  perViewerCounts: {},
  decisionLog: [],
  seenMessageIds: [],
});

function compareClaims(a: Claim, b: Claim): number {
  return (
    a.twitchTimestamp - b.twitchTimestamp ||
    a.receivedAt - b.receivedAt ||
    a.messageId.localeCompare(b.messageId)
  );
}

function addDecision(
  state: Allocation,
  event: DropEvent,
  action: string,
  why: string,
  claim?: Claim,
): void {
  const decision: Decision = { at: event.at, action, why: normalizeWhy(why) };
  if (claim) {
    decision.viewerId = claim.viewerId;
    decision.messageId = claim.messageId;
  }
  state.decisionLog.push(decision);
}

function countViewerWinners(state: Allocation, viewerId: string): number {
  return state.winners
    .filter((claim) => claim.viewerId === viewerId)
    .reduce((total, claim) => total + claim.qty, 0);
}

function countWinnerSpots(state: Allocation): number {
  return state.winners.reduce((total, claim) => total + claim.qty, 0);
}

function cloneAllocation(previous: Allocation): Allocation {
  return {
    ...previous,
    winners: [...previous.winners],
    waitlist: [...previous.waitlist],
    reviewQueue: [...previous.reviewQueue],
    perViewerCounts: { ...previous.perViewerCounts },
    decisionLog: [...previous.decisionLog],
    seenMessageIds: [...previous.seenMessageIds],
  };
}

function refreshViewerCounts(state: Allocation): void {
  const viewerIds = new Set([
    ...state.winners.map((claim) => claim.viewerId),
    ...state.waitlist.map((claim) => claim.viewerId),
  ]);
  state.perViewerCounts = Object.fromEntries(
    [...viewerIds].map((viewerId) => [
      viewerId,
      countViewerWinners(state, viewerId),
    ]),
  );
}

function promoteWaitlist(
  state: Allocation,
  event: DropEvent,
  why: string,
): void {
  const drop = state.drop;
  if (!drop) return;

  while (countWinnerSpots(state) < drop.spots && state.waitlist.length > 0) {
    const nextClaim = state.waitlist.shift()!;
    const viewerAllowance =
      drop.perViewerLimit - countViewerWinners(state, nextClaim.viewerId);
    const openSpots = drop.spots - countWinnerSpots(state);
    const quantity = Math.min(nextClaim.qty, viewerAllowance, openSpots);
    if (quantity <= 0) continue;

    const promotedClaim = { ...nextClaim, qty: quantity };
    state.winners.push(promotedClaim);
    addDecision(
      state,
      event,
      "promoted",
      `${why} ${nextClaim.display} moved up from the waitlist.`,
      promotedClaim,
    );
  }

  state.winners.sort(compareClaims);
  refreshViewerCounts(state);
}

function handleClaimReceived(
  state: Allocation,
  event: Extract<DropEvent, { type: "ClaimReceived" }>,
): void {
  if (state.seenMessageIds.includes(event.messageId)) {
    addDecision(
      state,
      event,
      "duplicate_ignored",
      "This Twitch message was already processed.",
      event,
    );
    return;
  }
  state.seenMessageIds.push(event.messageId);

  if (state.drop?.status !== "open") {
    addDecision(state, event, "not_admitted", "The drop is closed.", event);
    return;
  }
  if (event.confidence < 0.8) {
    state.reviewQueue.push(event);
    addDecision(
      state,
      event,
      "needs_review",
      event.reason || "Intent is ambiguous; no spot was granted.",
      event,
    );
    return;
  }
  if (
    state.drop.subsFirstSeconds !== undefined &&
    event.at - (state.openedAt ?? 0) < state.drop.subsFirstSeconds * 1000 &&
    !event.isSubscriber
  ) {
    state.waitlist.push(event);
    addDecision(
      state,
      event,
      "waitlisted",
      "Subscribers have priority during the opening window.",
      event,
    );
    return;
  }

  const perViewerAllowance = Math.max(
    0,
    state.drop.perViewerLimit - countViewerWinners(state, event.viewerId),
  );
  const openSpots = state.drop.spots - countWinnerSpots(state);
  const quantity = Math.min(
    event.qty,
    perViewerAllowance,
    Math.max(openSpots, 1),
  );
  if (quantity <= 0) {
    addDecision(
      state,
      event,
      "limit_reached",
      "This viewer already has the allowed number of spots.",
      event,
    );
    return;
  }

  const claim = { ...event, qty: quantity };
  if (openSpots > 0) {
    grantOpenSpot(state, event, claim);
  } else {
    settleOrWaitlist(state, event, claim);
  }
  state.waitlist.sort(compareClaims);
  state.perViewerCounts[event.viewerId] = countViewerWinners(
    state,
    event.viewerId,
  );
}

function grantOpenSpot(
  state: Allocation,
  event: Extract<DropEvent, { type: "ClaimReceived" }>,
  claim: Claim,
): void {
  state.winners.push(claim);
  state.winners.sort(compareClaims);
  addDecision(
    state,
    event,
    "granted",
    event.reason || "Clear first-person claim; spot granted.",
    claim,
  );
}

function settleOrWaitlist(
  state: Allocation,
  event: Extract<DropEvent, { type: "ClaimReceived" }>,
  claim: Claim,
): void {
  const latestWinner = [...state.winners].sort(compareClaims).at(-1)!;
  const earlierTimestamp = compareClaims(claim, latestWinner) < 0;
  // Late arrivals can only displace a winner during that winner's settle window.
  const insideSettleWindow =
    event.at - latestWinner.receivedAt < state.drop!.settleMs;

  if (earlierTimestamp && insideSettleWindow) {
    state.winners.splice(state.winners.indexOf(latestWinner), 1);
    state.waitlist.push(latestWinner);
    state.winners.push(claim);
    state.winners.sort(compareClaims);
    addDecision(
      state,
      event,
      "granted_by_timestamp",
      `${claim.display} sent an earlier claim; it displaced ${latestWinner.display} within the settle window.`,
      claim,
    );
    addDecision(
      state,
      event,
      "displaced_to_waitlist",
      `An earlier timestamp arrived within ${state.drop!.settleMs} ms; ${latestWinner.display} moved to the waitlist.`,
      latestWinner,
    );
    return;
  }

  state.waitlist.push(claim);
  const reason = earlierTimestamp
    ? "The settle window expired, so the existing winner remains."
    : "All spots are filled; this claim is next on the waitlist.";
  addDecision(state, event, "waitlisted", reason, claim);
}

function handleCancellationOrRejection(
  state: Allocation,
  event: Extract<DropEvent, { type: "ClaimCancelled" | "ClaimRejected" }>,
): void {
  const isRejection = event.type === "ClaimRejected";
  const matchesTarget = (claim: Claim) =>
    claim.viewerId === event.viewerId &&
    (event.messageId === undefined || claim.messageId === event.messageId);
  const winner = state.winners.find(matchesTarget);
  if (!winner) {
    state.waitlist = state.waitlist.filter((claim) => !matchesTarget(claim));
    if (isRejection) {
      state.reviewQueue = state.reviewQueue.filter(
        (claim) => !matchesTarget(claim),
      );
    }
    addDecision(
      state,
      event,
      "removed",
      isRejection
        ? "Streamer rejected the pending claim."
        : "Viewer cancelled their waitlisted claim.",
    );
    state.perViewerCounts[event.viewerId] = countViewerWinners(
      state,
      event.viewerId,
    );
    return;
  }

  state.winners.splice(state.winners.indexOf(winner), 1);
  addDecision(
    state,
    event,
    isRejection ? "rejected" : "cancelled",
    isRejection
      ? (event.reason ?? "Streamer rejected the claim.")
      : (event.reason ?? "Viewer cancelled their claim."),
    winner,
  );
  promoteWaitlist(
    state,
    event,
    isRejection ? "The previous winner was rejected." : "A winner cancelled.",
  );
  state.perViewerCounts[event.viewerId] = countViewerWinners(
    state,
    event.viewerId,
  );
}

function handleApproval(
  state: Allocation,
  event: Extract<DropEvent, { type: "ClaimApproved" }>,
): void {
  const claim = state.reviewQueue.find(
    (item) =>
      item.viewerId === event.viewerId &&
      (event.messageId === undefined || item.messageId === event.messageId),
  );
  if (!claim) {
    addDecision(
      state,
      event,
      "approval_ignored",
      "No pending review claim exists for this viewer.",
    );
    return;
  }

  state.reviewQueue = state.reviewQueue.filter((item) => item !== claim);
  const viewerAllowance =
    state.drop!.perViewerLimit - countViewerWinners(state, event.viewerId);
  const quantity = Math.min(event.qty ?? claim.qty, viewerAllowance);
  if (quantity > 0 && countWinnerSpots(state) < state.drop!.spots) {
    const approvedClaim = {
      ...claim,
      qty: Math.min(quantity, state.drop!.spots - countWinnerSpots(state)),
    };
    state.winners.push(approvedClaim);
    state.winners.sort(compareClaims);
    addDecision(
      state,
      event,
      "approved",
      event.reason ?? "Streamer approved this claim.",
      approvedClaim,
    );
    state.perViewerCounts[event.viewerId] = countViewerWinners(
      state,
      event.viewerId,
    );
  } else {
    state.waitlist.push(claim);
    state.waitlist.sort(compareClaims);
    addDecision(
      state,
      event,
      "approval_waitlisted",
      "No eligible spot remains; approved claim was placed on the waitlist.",
      claim,
    );
  }
}

export function reduceEvent(
  previous: Allocation,
  event: DropEvent,
): Allocation {
  const state = cloneAllocation(previous);
  if (event.type === "DropOpened") {
    state.drop = { ...event.drop };
    state.openedAt = event.at;
    addDecision(
      state,
      event,
      "opened",
      `Drop “${event.drop.title}” opened with ${event.drop.spots} spots.`,
    );
    return state;
  }
  if (!state.drop) return state;

  if (event.type === "DropClosed") {
    state.drop = { ...state.drop, status: "closed" };
    addDecision(
      state,
      event,
      "closed",
      event.reason ?? "The streamer closed the drop.",
    );
  } else if (event.type === "ClaimReceived") {
    handleClaimReceived(state, event);
  } else if (
    event.type === "ClaimCancelled" ||
    event.type === "ClaimRejected"
  ) {
    handleCancellationOrRejection(state, event);
  } else if (event.type === "ClaimApproved") {
    handleApproval(state, event);
  }
  return state;
}

export function reduceEvents(events: DropEvent[]): Allocation {
  return events.reduce(reduceEvent, initialAllocation());
}
