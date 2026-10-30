import type { Allocation, Claim, Decision, Drop, DropEvent } from './types.js';

const empty = (): Allocation => ({ winners: [], waitlist: [], reviewQueue: [], perViewerCounts: {}, decisionLog: [], seenMessageIds: [] });
const claimOrder = (a: Claim, b: Claim) => a.twitchTimestamp - b.twitchTimestamp || a.receivedAt - b.receivedAt || a.messageId.localeCompare(b.messageId);
const decide = (state: Allocation, event: DropEvent, action: string, why: string, claim?: Claim) => {
  const item: Decision = { at: event.at, action, why };
  if (claim) { item.viewerId = claim.viewerId; item.messageId = claim.messageId; }
  state.decisionLog.push(item);
};
const count = (state: Allocation, viewerId: string) => state.winners.filter(c => c.viewerId === viewerId).reduce((n, c) => n + c.qty, 0);
function promote(state: Allocation, at: number, why: string) {
  const drop = state.drop;
  while (drop && state.winners.reduce((n, c) => n + c.qty, 0) < drop.spots && state.waitlist.length) {
    const next = state.waitlist.shift()!;
    const allowance = drop.perViewerLimit - count(state, next.viewerId);
    const qty = Math.min(next.qty, allowance, drop.spots - state.winners.reduce((n,c)=>n+c.qty,0));
    if (qty <= 0) continue;
    state.winners.push({ ...next, qty });
    decide(state, { type: 'ClaimReceived', at, ...next }, 'promoted', `${why} ${next.display} moved up from the waitlist.` , next);
  }
  state.winners.sort(claimOrder);
  state.perViewerCounts = Object.fromEntries([...new Set([...state.winners.map(c=>c.viewerId), ...state.waitlist.map(c=>c.viewerId)])].map(id => [id, count(state,id)]));
}

export function reduceEvent(previous: Allocation, event: DropEvent): Allocation {
  const s: Allocation = { ...previous, winners: [...previous.winners], waitlist: [...previous.waitlist], reviewQueue: [...previous.reviewQueue], perViewerCounts: { ...previous.perViewerCounts }, decisionLog: [...previous.decisionLog], seenMessageIds: [...previous.seenMessageIds] };
  if (event.type === 'DropOpened') { s.drop = { ...event.drop }; decide(s,event,'opened',`Drop “${event.drop.title}” opened with ${event.drop.spots} spots.`); return s; }
  if (!s.drop) return s;
  if (event.type === 'DropClosed') { s.drop = { ...s.drop, status: 'closed' }; decide(s,event,'closed',event.reason ?? 'The streamer closed the drop.'); return s; }
  if (event.type === 'ClaimReceived') {
    if (s.seenMessageIds.includes(event.messageId)) { decide(s,event,'duplicate_ignored','This Twitch message was already processed.',event); return s; }
    s.seenMessageIds.push(event.messageId);
    if (s.drop.status !== 'open') { decide(s,event,'not_admitted','The drop is closed.',event); return s; }
    if (event.confidence < 0.85) { s.reviewQueue.push(event); decide(s,event,'needs_review',event.reason || 'Intent is ambiguous; no spot was granted.',event); return s; }
    if (s.drop.subsFirstSeconds !== undefined && event.at < s.drop.subsFirstSeconds * 1000 && !event.isSubscriber) { s.waitlist.push(event); decide(s,event,'waitlisted','Subscribers have priority during the opening window.',event); return s; }
    const existing = count(s,event.viewerId);
    const allowed = Math.max(0, s.drop.perViewerLimit - existing);
    const remainingSpots = s.drop.spots - s.winners.reduce((n,c)=>n+c.qty,0);
    const qty = Math.min(event.qty, allowed, Math.max(remainingSpots, 1));
    if (qty <= 0) { decide(s,event,'limit_reached','This viewer already has the allowed number of spots.',event); return s; }
    const claim = { ...event, qty };
    const filled = s.winners.reduce((n,c)=>n+c.qty,0);
    if (filled < s.drop.spots) { s.winners.push(claim); s.winners.sort(claimOrder); decide(s,event,'granted',event.reason || 'Clear first-person claim; spot granted.',claim); }
    else {
      const latest = [...s.winners].sort(claimOrder).at(-1)!;
      if (claimOrder(claim,latest) < 0 && event.at - latest.receivedAt < s.drop.settleMs) {
        s.winners.splice(s.winners.indexOf(latest),1); s.waitlist.push(latest); s.winners.push(claim); s.winners.sort(claimOrder);
        decide(s,event,'granted_by_timestamp',`${claim.display} sent an earlier claim; it displaced ${latest.display} within the settle window.`,claim);
        decide(s,event,'displaced_to_waitlist',`An earlier timestamp arrived within ${s.drop.settleMs} ms; ${latest.display} moved to the waitlist.`,latest);
      } else { s.waitlist.push(claim); decide(s,event,'waitlisted',claimOrder(claim,latest)<0?'The settle window expired, so the existing winner remains.':'All spots are filled; this claim is next on the waitlist.',claim); }
    }
    s.waitlist.sort(claimOrder); s.perViewerCounts[event.viewerId] = count(s,event.viewerId); return s;
  }
  const viewerId = event.viewerId;
  if (event.type === 'ClaimCancelled' || event.type === 'ClaimRejected') {
    const target = s.winners.find(c=>c.viewerId===viewerId);
    if (target) {
      s.winners.splice(s.winners.indexOf(target),1); decide(s,event,event.type==='ClaimRejected'?'rejected':'cancelled', event.type==='ClaimRejected'?(event.reason ?? 'Streamer rejected the claim.'): (event.reason ?? 'Viewer cancelled their claim.'),target);
      promote(s,event.at,event.type==='ClaimRejected'?'The previous winner was rejected.':'A winner cancelled.');
    } else { s.waitlist = s.waitlist.filter(c=>c.viewerId!==viewerId); decide(s,event,'removed',event.type==='ClaimRejected'?'Streamer rejected the waitlisted claim.':'Viewer cancelled their waitlisted claim.'); }
    s.perViewerCounts[viewerId] = count(s,viewerId); return s;
  }
  if (event.type === 'ClaimApproved') {
    const claim = s.reviewQueue.find(c=>c.viewerId===viewerId);
    if (!claim) { decide(s,event,'approval_ignored','No pending review claim exists for this viewer.'); return s; }
    s.reviewQueue = s.reviewQueue.filter(c=>c!==claim);
    const qty = Math.min(event.qty ?? claim.qty, s.drop.perViewerLimit-count(s,viewerId));
    if (qty > 0 && s.winners.reduce((n,c)=>n+c.qty,0)<s.drop.spots) { const approved={...claim,qty}; s.winners.push(approved); s.winners.sort(claimOrder); decide(s,event,'approved',event.reason ?? 'Streamer approved this claim.',approved); }
    else { s.waitlist.push(claim); s.waitlist.sort(claimOrder); decide(s,event,'approval_waitlisted','No eligible spot remains; approved claim was placed on the waitlist.',claim); }
    return s;
  }
  return s;
}
export function reduceEvents(events: DropEvent[]): Allocation { return events.reduce(reduceEvent, empty()); }
export const initialAllocation = empty;
