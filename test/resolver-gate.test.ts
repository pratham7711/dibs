import { describe, expect, it, vi } from "vitest";
import type { Drop } from "../src/core/types.js";
import { ModelClient } from "../src/resolver/model.js";
import type { ModelMessage } from "../src/resolver/model.js";
import { ResolverPipeline } from "../src/resolver/pipeline.js";

const drop: Drop = {
  id: "drop",
  title: "Test drop",
  spots: 4,
  perViewerLimit: 1,
  settleMs: 1500,
  status: "open",
};

const requestExamples = [
  "could i maybe get one too?",
  "could I get one please?",
  "can I have one too",
  "may I get one?",
  "save one for me",
  "keep one for me please",
  "hold one for me",
  "can you save one for me?",
  "who is getting one?",
  "hold one for a friend",
  "could I maybe have that one too?",
  "i want that one",
  "mere liye ek rakhna",
  "ek mere liye bhi rakh do",
  "mujhe ek chahiye",
  "bhai ek mere liye bhi rakhna",
];

describe("resolver request gate", () => {
  it.each(requestExamples)(
    "sends request signal to model or resolves as claim: %s",
    async (text) => {
      const onBatch = vi.fn(async (messages: ModelMessage[]) =>
        messages.map((message) => ({
          id: message.id,
          kind: "claim" as const,
          qty: 1,
          confidence: 0.95,
          reason: "First-person request.",
        })),
      );
      const pipeline = new ResolverPipeline(drop, {
        onBatch,
        batchWindowMs: 0,
      });

      const result = await pipeline.resolve({
        id: "request",
        text,
        viewerId: "viewer",
      });
      if (text === "hold one for a friend") {
        expect(result).toMatchObject({ intent: "claim", source: "review" });
      } else {
        expect(result.intent).toBe("claim");
      }
      if (result.source !== "rules") expect(onBatch).toHaveBeenCalledOnce();
    },
  );

  it("keeps a third-party request in review instead of dropping it", async () => {
    const onBatch = vi.fn(async (messages: ModelMessage[]) =>
      messages.map((message) => ({
        id: message.id,
        kind: "claim" as const,
        qty: 1,
        confidence: 0.99,
        reason: "The message asks to reserve a spot.",
      })),
    );
    const pipeline = new ResolverPipeline(drop, { onBatch, batchWindowMs: 0 });

    const result = await pipeline.resolve({
      id: "proxy",
      text: "yo save one for my brother",
      viewerId: "viewer",
    });

    expect(onBatch).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      intent: "claim",
      confidence: 0.6,
      source: "review",
    });
    expect(result.why).toContain("another person");
  });
});

describe("request fallback safety", () => {
  it("keeps an ambiguous first-person request in review if the model calls it a question", async () => {
    const pipeline = new ResolverPipeline(drop, {
      batchWindowMs: 0,
      onBatch: async (messages) =>
        messages.map((message) => ({
          id: message.id,
          kind: "question" as const,
          qty: 0,
          confidence: 0.99,
          reason: "The user used a question mark.",
        })),
    });

    const result = await pipeline.resolve({
      id: "uncertain-request",
      text: "could i maybe get one too?",
      viewerId: "viewer",
    });

    expect(result).toMatchObject({
      intent: "claim",
      source: "review",
      confidence: 0.6,
    });
  });

  it("sends a request signal to review when no model key is configured", async () => {
    const pipeline = new ResolverPipeline(drop, {
      batchWindowMs: 0,
      client: new ModelClient({ env: {} }),
    });

    const result = await pipeline.resolve({
      id: "offline-request",
      text: "could i maybe get one too?",
      viewerId: "viewer",
    });

    expect(result).toMatchObject({
      intent: "claim",
      source: "review",
      confidence: 0.6,
    });
  });
});
