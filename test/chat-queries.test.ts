import { describe, expect, it } from "vitest";
import { initialAllocation, reduceEvent } from "../src/core/reducer.js";
import type { Claim } from "../src/core/types.js";
import { DibsRuntime } from "../src/runtime.js";
import {
  classifyChatQuery,
  publicStatusLine,
  spotReplyForViewer,
  StatusReplyThrottle,
} from "../src/twitch/chat-queries.js";

const winner = (
  viewerId: string,
  display: string,
  timestamp: number,
): Claim => ({
  messageId: `claim-${viewerId}`,
  viewerId,
  login: display.toLowerCase(),
  display,
  isSubscriber: false,
  twitchTimestamp: timestamp,
  receivedAt: timestamp,
  qty: 1,
  source: "chat",
  confidence: 0.97,
  reason: "Clear claim.",
});

function makeState() {
  const drop = {
    id: "drop",
    title: "Test drop",
    spots: 5,
    perViewerLimit: 1,
    settleMs: 1500,
    status: "open" as const,
  };
  let state = reduceEvent(initialAllocation(), {
    type: "DropOpened",
    at: 1000,
    drop,
  });
  state = reduceEvent(state, {
    type: "ClaimReceived",
    at: 1100,
    ...winner("winner-a", "EarlyBird", 1100),
  });
  state = reduceEvent(state, {
    type: "ClaimReceived",
    at: 1200,
    ...winner("winner-b", "Oak", 1200),
  });
  state = reduceEvent(state, {
    type: "ClaimReceived",
    at: 1300,
    ...winner("winner-c", "Tix", 1300),
  });
  state = reduceEvent(state, {
    type: "ClaimReceived",
    at: 1400,
    ...winner("winner-d", "Robin", 1400),
  });
  state = reduceEvent(state, {
    type: "ClaimReceived",
    at: 1500,
    ...winner("winner-e", "Fern", 1500),
  });
  state = reduceEvent(state, {
    type: "ClaimReceived",
    at: 1600,
    ...winner("waiter-a", "Moss", 1600),
  });
  state = reduceEvent(state, {
    type: "ClaimReceived",
    at: 1700,
    ...winner("review-a", "Cloud", 1700),
    confidence: 0.6,
  });
  return state;
}

describe("chat query handling", () => {
  it("keeps every supported query out of the allocator and shows the rehearsal bot reply", async () => {
    const runtime = new DibsRuntime({ mode: "rehearsal", env: {} });
    runtime.openDrop({ title: "Query test", spots: 3 });
    for (const [index, text] of [
      "!spot",
      "where am i",
      "did i get one?",
      "am i in",
      "mera number?",
      "who got it?",
      "is it over?",
      "how many left?",
      "kitne bache?",
    ].entries()) {
      await runtime.handleNotification({
        messageId: `question-${index}`,
        timestamp: Date.now() + index,
        type: "channel.chat.message",
        event: {
          chatter_user_id: "viewer-query",
          chatter_user_login: "viewerquery",
          chatter_user_name: "ViewerQuery",
          message: { text },
        },
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(runtime.snapshot.seenMessageIds).toEqual([]);
    expect(runtime.snapshot.winners).toEqual([]);
    expect(
      runtime.view.feed.some(
        (item) =>
          item.display === "🤖 Dibs" &&
          item.why === "rehearsal: not sent to Twitch",
      ),
    ).toBe(true);
    runtime.stop();
  });

  it("announces sold out once with elapsed time in rehearsal", async () => {
    let clock = 1000;
    const runtime = new DibsRuntime({
      mode: "rehearsal",
      env: {},
      now: () => clock,
    });
    runtime.openDrop({ title: "One seat", spots: 1 });
    clock = 1100;
    await runtime.handleNotification({
      messageId: "last-seat",
      timestamp: 1100,
      type: "channel.chat.message",
      event: {
        chatter_user_id: "last-viewer",
        chatter_user_login: "lastviewer",
        chatter_user_name: "LastViewer",
        message: { text: "dibs" },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 350));
    const announcements = runtime.view.feed.filter(
      (item) => item.display === "🤖 Dibs" && item.text.startsWith("SOLD OUT"),
    );
    expect(announcements).toHaveLength(1);
    expect(announcements[0]?.text).toContain("in 0.0 s");
    runtime.stop();
  });

  it("recognizes personal spot questions and status questions without treating them as claims", () => {
    for (const text of [
      "!spot",
      "where am i",
      "did i get one?",
      "am i in",
      "mera number?",
    ])
      expect(classifyChatQuery(text)).toBe("spot");
    for (const text of [
      "who got it?",
      "is it over?",
      "how many left?",
      "kitne bache?",
    ])
      expect(classifyChatQuery(text)).toBe("status");
  });

  it("answers winner, waitlist, review and no-claim states", () => {
    const state = makeState();
    expect(spotReplyForViewer(state, "winner-b")).toBe("you're #2 of 5");
    expect(spotReplyForViewer(state, "waiter-a")).toBe("waitlist #1");
    expect(spotReplyForViewer(state, "review-a")).toBe(
      "in review, the streamer will decide",
    );
    expect(spotReplyForViewer(state, "new-viewer")).toBe(
      "no claim yet, say dibs",
    );
  });

  it("throttles public status answers once per 15 seconds per drop", () => {
    const throttle = new StatusReplyThrottle();
    throttle.reset("drop-a");
    expect(throttle.canSend("drop-a", 10_000)).toBe(true);
    throttle.markSent("drop-a", 10_000);
    expect(throttle.canSend("drop-a", 24_999)).toBe(false);
    expect(throttle.canSend("drop-a", 25_000)).toBe(true);
    expect(throttle.canSend("drop-b", 10_001)).toBe(true);
  });

  it("answers with an open-drop line and a timed sold-out announcement", () => {
    const state = makeState();
    state.winners.splice(3);
    state.waitlist = [];
    expect(publicStatusLine(state, 1000, undefined, 2000)).toContain(
      "2 of 5 left, say dibs",
    );
    const soldOut = makeState();
    soldOut.waitlist.push(
      { ...winner("practice-waiter-a", "PracticeA", 1800), practice: true },
      { ...winner("practice-waiter-b", "PracticeB", 1900), practice: true },
    );
    expect(publicStatusLine(soldOut, 1000, 4400, 5000)).toBe(
      "SOLD OUT in 3.4 s: @EarlyBird @Oak @Tix @Robin @Fern · 3 on the waitlist · +2 practice",
    );
  });
});
