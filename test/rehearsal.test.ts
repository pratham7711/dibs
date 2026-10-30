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
      "Robin",
      "Moss",
      "Finch",
    ]);
    expect(runtime.snapshot.waitlist).toHaveLength(10);
    expect(runtime.snapshot.reviewQueue).toHaveLength(4);
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
    expect(runtime.view.mode).toBe("rehearsal");
  });
});
