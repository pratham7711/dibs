import { describe, expect, it } from "vitest";
import { ModelClient } from "../src/resolver/model.js";
import { ResolverPipeline } from "../src/resolver/pipeline.js";
import { DibsRuntime } from "../src/runtime.js";
import { runRehearsal } from "../src/rehearsal.js";

describe("rehearsal crowd", () => {
  it("runs the fictional crowd through the resolver and allocator", async () => {
    let clock = Date.now();
    const runtime = new DibsRuntime({
      mode: "rehearsal",
      env: {},
      now: () => clock,
      resolverFactory: (drop) =>
        new ResolverPipeline(drop, {
          client: new ModelClient({ env: {} }),
          batchWindowMs: 0,
        }),
    });

    await runRehearsal(runtime, {
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
    });

    expect(runtime.snapshot.winners.map((claim) => claim.display)).toEqual([
      "EarlyBird",
      "Oak",
      "Tix",
      "Robin",
      "Pebble",
    ]);
    expect(runtime.snapshot.waitlist.map((claim) => claim.display)).toEqual([
      "Moss",
      "Wren",
      "Cloud",
      "Noodle",
      "Teammate",
      "Daisy",
      "Orbit",
      "Fern",
      "Poppy",
      "Mochi",
      "Bubbles",
      "Lime",
    ]);
    expect(runtime.snapshot.reviewQueue.map((claim) => claim.display)).toEqual([
      "Bhai",
      "Comet",
    ]);
    expect(
      runtime.snapshot.decisionLog.every((item) => item.why.length <= 90),
    ).toBe(true);
    expect(
      runtime.snapshot.decisionLog.some(
        (item) => item.action === "duplicate_ignored",
      ),
    ).toBe(true);
    expect(
      runtime.snapshot.decisionLog.filter((item) => item.action === "promoted"),
    ).toHaveLength(2);
    expect(
      runtime.snapshot.decisionLog.some(
        (item) =>
          item.action === "granted_by_timestamp" &&
          item.viewerId === "rehearsal-EarlyBird",
      ),
    ).toBe(true);
    expect(
      runtime.snapshot.decisionLog.find((item) => item.action === "promoted")
        ?.viewerId,
    ).toBe("rehearsal-Robin");
    expect(
      runtime.view.feed.find((item) => item.text === "can anyone get one?")
        ?.action,
    ).toBe("question");
    expect(
      runtime.view.feed.find((item) => item.text === "!spot")?.action,
    ).toBe("question");
    expect(runtime.snapshot.seenMessageIds).not.toContain("spot-query");
    expect(runtime.snapshot.seenMessageIds).not.toContain("trap-who");
    expect(
      runtime.snapshot.winners.find(
        (claim) => claim.source === "channel_points",
      )?.display,
    ).toBe("Tix");
    expect(runtime.view.mode).toBe("rehearsal");
    expect(runtime.snapshot.drop?.status).toBe("closed");
    expect(
      runtime.snapshot.decisionLog.some(
        (item) =>
          item.action === "approval_waitlisted" &&
          item.viewerId === "rehearsal-Teammate",
      ),
    ).toBe(true);
    for (const text of [
      "is it free?",
      "who got it?",
      "can anyone get one?",
      "I don't want it",
    ]) {
      expect(runtime.view.feed.some((item) => item.text === text)).toBe(true);
      expect(
        runtime.snapshot.winners.some((claim) => claim.display === text),
      ).toBe(false);
    }
  });
});
