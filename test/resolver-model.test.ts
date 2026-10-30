import { afterEach, describe, expect, it, vi } from "vitest";
import type { Drop } from "../src/core/types.js";
import { ModelClient, resetModelState } from "../src/resolver/model.js";
import type { ModelDecision } from "../src/resolver/model.js";
import {
  ResolverPipeline,
  validateModelDecision,
} from "../src/resolver/pipeline.js";
import type { ModelMessage } from "../src/resolver/model.js";
import { classifyMessage } from "../src/resolver/rules.js";

const drop: Drop = {
  id: "drop-1",
  title: "Game slots",
  spots: 3,
  perViewerLimit: 2,
  settleMs: 1500,
  status: "open",
};

function modelDecision(
  id: string,
  overrides: Partial<ModelDecision> = {},
): ModelDecision {
  return {
    id,
    kind: "claim",
    qty: 1,
    confidence: 0.92,
    reason: "The viewer asks for a spot.",
    ...overrides,
  };
}

function completion(
  decisions: ModelDecision[],
  usage = { prompt_tokens: 10, completion_tokens: 5 },
): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ decisions }) } }],
      usage,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function ambiguousMessage(id: string, text = "can I get one?"): ModelMessage {
  return {
    id,
    text,
    viewerId: `viewer-${id}`,
    viewerLimit: drop.perViewerLimit,
    ruleResult: classifyMessage(text),
  };
}

function modelClient(
  fetcher: typeof fetch,
  extraEnv: Record<string, string | undefined> = {},
) {
  return new ModelClient({
    fetch: fetcher,
    env: { GROQ_API_KEY: "test-key", ...extraEnv },
  });
}

afterEach(() => {
  vi.useRealTimers();
  resetModelState();
});

describe("model client", () => {
  it("caches successful decisions by exact message text across clients", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(completion([modelDecision("first-cache-id")]));
    const context = { dropTitle: drop.title, spotsLeft: 3, perViewerLimit: 2 };
    const first = await modelClient(fetcher).classifyBatch(
      [ambiguousMessage("first-cache-id", "cache this exact sentence")],
      context,
    );
    const second = await modelClient(fetcher).classifyBatch(
      [ambiguousMessage("second-cache-id", "cache this exact sentence")],
      context,
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(first[0]?.id).toBe("first-cache-id");
    expect(second[0]).toMatchObject({ id: "second-cache-id", kind: "claim" });
  });

  it("batches messages into one request and includes drop context and schema", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        completion([modelDecision("m1"), modelDecision("m2")]),
      );
    const pipeline = new ResolverPipeline(drop, {
      client: modelClient(fetcher),
      batchWindowMs: 10,
    });

    const results = await Promise.all([
      pipeline.resolve({ id: "m1", text: "can I get one?", viewerId: "a" }),
      pipeline.resolve({ id: "m2", text: "could I get one?", viewerId: "b" }),
    ]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(request.reasoning_effort).toBe("low");
    expect(request.response_format.type).toBe("json_schema");
    expect(request.messages[1].content).toContain("Game slots");
    expect(results.map((result) => result.source)).toEqual(["model", "model"]);
  });

  it("retries once with json_object when the provider rejects json_schema", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("unsupported", { status: 400 }))
      .mockResolvedValueOnce(completion([modelDecision("m1")]));
    const client = modelClient(fetcher);

    await client.classifyBatch([ambiguousMessage("m1")], {
      dropTitle: drop.title,
      spotsLeft: 3,
      perViewerLimit: 2,
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    const fallbackRequest = JSON.parse(
      String(fetcher.mock.calls[1]?.[1]?.body),
    );
    expect(fallbackRequest.response_format.type).toBe("json_object");
  });

  it("routes timed out calls to review", async () => {
    vi.useFakeTimers();
    const fetcher: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    const pipeline = new ResolverPipeline(drop, {
      client: modelClient(fetcher),
      batchWindowMs: 1,
    });
    const resultPromise = pipeline.resolve({
      id: "timeout",
      text: "can I get one?",
      viewerId: "a",
    });
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(2500);

    await expect(resultPromise).resolves.toMatchObject({
      source: "review",
      why: "model busy (timed out).",
    });
  });

  it("routes HTTP 429 responses to review", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("busy", { status: 429 }));
    const pipeline = new ResolverPipeline(drop, {
      client: modelClient(fetcher),
      batchWindowMs: 1,
    });

    const result = await pipeline.resolve({
      id: "busy",
      text: "can I get one?",
      viewerId: "a",
    });
    expect(result).toMatchObject({
      source: "review",
      why: "model busy (rate limited).",
    });
  });

  it("routes to review without a configured model key", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new ModelClient({ fetch: fetcher, env: {} });
    const pipeline = new ResolverPipeline(drop, { client, batchWindowMs: 1 });

    const result = await pipeline.resolve({
      id: "no-key",
      text: "can I get one?",
      viewerId: "a",
    });
    expect(result).toMatchObject({ source: "review", why: "no model key." });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("caps a claim without a first-person claim cue for human review", () => {
    const message = ambiguousMessage("third-person", "ava wants one");
    const result = validateModelDecision(
      message,
      modelDecision(message.id, { confidence: 0.99 }),
      drop.perViewerLimit,
    );

    expect(result).toMatchObject({
      intent: "claim",
      confidence: 0.6,
      source: "review",
    });
  });

  it("clamps requested quantity to the configured per-viewer limit", () => {
    const message = ambiguousMessage("quantity");
    const result = validateModelDecision(
      message,
      modelDecision(message.id, { qty: 99 }),
      drop.perViewerLimit,
    );

    expect(result.qty).toBe(drop.perViewerLimit);
  });

  it("stops calling the model after the token budget is consumed", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      completion([modelDecision("first"), modelDecision("second")], {
        prompt_tokens: 8,
        completion_tokens: 2,
      }),
    );
    const client = modelClient(fetcher, { DIBS_LLM_TOKEN_BUDGET: "10" });
    const context = { dropTitle: drop.title, spotsLeft: 3, perViewerLimit: 2 };

    await client.classifyBatch(
      [ambiguousMessage("first", "budget guard first line")],
      context,
    );
    await expect(
      client.classifyBatch(
        [ambiguousMessage("second", "budget guard second line")],
        context,
      ),
    ).rejects.toThrow("token budget");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("never calls the model for clear rule decisions or clear non-claims", async () => {
    const onBatch = vi.fn(async () => []);
    const pipeline = new ResolverPipeline(drop, { onBatch });

    const claim = await pipeline.resolve({
      id: "clear-claim",
      text: "dibs",
      viewerId: "a",
    });
    const question = await pipeline.resolve({
      id: "clear-question",
      text: "is it free?",
      viewerId: "b",
    });

    expect(claim.source).toBe("rules");
    expect(question.source).toBe("rules");
    expect(onBatch).not.toHaveBeenCalled();
  });
});
