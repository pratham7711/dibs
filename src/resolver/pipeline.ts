import type { Drop } from "../core/types.js";
import { normalizeWhy } from "../core/why.js";
import {
  failureReason,
  MAX_BATCH_SIZE,
  MODEL_BATCH_WINDOW_MS,
  ModelClient,
} from "./model.js";
import type { ModelContext, ModelDecision, ModelMessage } from "./model.js";
import { classifyMessage } from "./rules.js";
import type { Intent, Resolution } from "./rules.js";

export type DecisionSource = "rules" | "model" | "review";
export interface ResolverInput {
  id: string;
  text: string;
  viewerId: string;
  spotsLeft?: number;
}
export interface ResolvedMessage extends Resolution {
  id: string;
  source: DecisionSource;
  why: string;
}
export interface ResolverOptions {
  client?: ModelClient;
  batchWindowMs?: number;
  onBatch?: (
    messages: ModelMessage[],
    context: ModelContext,
  ) => Promise<ModelDecision[]>;
}
interface PendingMessage {
  input: ResolverInput;
  ruleResult: Resolution;
  resolve: (result: ResolvedMessage) => void;
}

const FIRST_PERSON_CLAIM_CUE =
  /\b(?:i|i'm|im|i am|me|mine|dibs|!dibs|mujhe|mere liye|mera|le lunga|slot\s*#?\s*\d+)\b|#\s*\d+|\b\d+\s*(?:pls|please)\b|🙋|✋|\+1/i;
const REQUEST_SIGNAL =
  /\b(?:get(?:ting)?|have|save|saving|keep|keeping|hold|holding|reserve|reserving)\b.{0,50}\b(?:one|it|that|ek)\b|\b(?:one|ek)\b.{0,50}\b(?:for me|for my|mere liye|rakhna|rakh do|chahiye)\b|\b(?:can|could|may)\s+i\b|\bfor (?:me|my)\b|\b(?:i want|mere liye|rakhna|rakh do|chahiye)\b/i;
const PROXY_REQUEST =
  /\b(?:for (?:my|a|the) (?:brother|sister|friend|mom|mother|dad|father|sibling|partner|wife|husband|cousin|buddy|teammate|colleague|coworker|son|daughter|kid|grandma|grandpa|someone else)|for someone else|on behalf of|my (?:brother|sister|friend|mom|mother|dad|father|sibling|partner|wife|husband|cousin))\b/i;

export function validateModelDecision(
  message: ModelMessage,
  decision: ModelDecision,
  perViewerLimit: number,
): ResolvedMessage {
  const isClaim = decision.kind === "claim";
  const hasFirstPersonCue = FIRST_PERSON_CLAIM_CUE.test(message.text);
  const proxyRequest = PROXY_REQUEST.test(message.text);
  let confidence = clamp(decision.confidence, 0, 1);
  let why = normalizeWhy(
    decision.reason || "Classified by the ambiguity model.",
  );
  let source: DecisionSource = confidence >= 0.8 ? "model" : "review";

  // A model cannot promote a message with no first-person claim cue into an automatic grant.
  const ambiguousFirstPersonRequest =
    hasFirstPersonCue && REQUEST_SIGNAL.test(message.text) && !isClaim;
  if (proxyRequest) {
    confidence = Math.min(confidence, 0.6);
    source = "review";
    why = normalizeWhy(why, "Needs review: request is for another person.");
  } else if (ambiguousFirstPersonRequest) {
    confidence = Math.min(confidence, 0.6);
    source = "review";
    why = normalizeWhy(
      why,
      "Needs review: this may be a first-person request.",
    );
  } else if (isClaim && !hasFirstPersonCue) {
    confidence = Math.min(confidence, 0.6);
    source = "review";
    why = normalizeWhy(why, "Needs review: no first-person claim cue.");
  } else if (isClaim && confidence < 0.8) {
    source = "review";
    why = normalizeWhy(why, "Needs review: confidence is below 0.8.");
  }

  const intent =
    proxyRequest ||
    ambiguousFirstPersonRequest ||
    (isClaim && !hasFirstPersonCue)
      ? "claim"
      : decision.kind;
  return {
    id: message.id,
    intent,
    qty: isClaim
      ? clamp(
          Math.trunc(decision.qty),
          1,
          Math.min(perViewerLimit, message.viewerLimit),
        )
      : 0,
    confidence,
    source,
    reason: normalizeWhy(why),
    why: normalizeWhy(why),
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(
    minimum,
    Math.min(maximum, Number.isFinite(value) ? value : minimum),
  );
}

function toResolvedRule(
  input: ResolverInput,
  result: Resolution,
): ResolvedMessage {
  return {
    ...result,
    id: input.id,
    source: "rules",
    reason: normalizeWhy(result.reason),
    why: normalizeWhy(result.reason),
  };
}

function isClearNonClaim(result: Resolution, text: string): boolean {
  return (
    (result.intent === "question" || result.intent === "other") &&
    !REQUEST_SIGNAL.test(text)
  );
}

function fallbackResult(message: ModelMessage, why: string): ResolvedMessage {
  const hasFirstPersonCue = FIRST_PERSON_CLAIM_CUE.test(message.text);
  const needsClaimReview =
    PROXY_REQUEST.test(message.text) ||
    (hasFirstPersonCue && REQUEST_SIGNAL.test(message.text));
  return {
    id: message.id,
    intent: needsClaimReview ? "claim" : message.ruleResult.intent,
    qty: needsClaimReview
      ? Math.max(1, message.ruleResult.qty)
      : message.ruleResult.intent === "claim"
        ? message.ruleResult.qty
        : 0,
    confidence: Math.min(message.ruleResult.confidence, 0.6),
    source: "review",
    reason: normalizeWhy(why),
    why: normalizeWhy(why),
  };
}

export class ResolverPipeline {
  private readonly client: ModelClient;
  private readonly batchWindowMs: number;
  private readonly onBatch?: ResolverOptions["onBatch"];
  private pending: PendingMessage[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly drop: Drop,
    options: ResolverOptions = {},
  ) {
    this.client = options.client ?? new ModelClient();
    this.batchWindowMs = options.batchWindowMs ?? MODEL_BATCH_WINDOW_MS;
    this.onBatch = options.onBatch;
  }

  resolve(input: ResolverInput): Promise<ResolvedMessage> {
    const ruleResult = classifyMessage(input.text);
    if (
      ruleResult.confidence >= 0.85 &&
      (ruleResult.intent === "claim" || ruleResult.intent === "cancel")
    ) {
      return Promise.resolve(toResolvedRule(input, ruleResult));
    }
    if (isClearNonClaim(ruleResult, input.text)) {
      return Promise.resolve(toResolvedRule(input, ruleResult));
    }

    return new Promise((resolve) => {
      this.pending.push({ input, ruleResult, resolve });
      if (this.pending.length >= MAX_BATCH_SIZE) {
        void this.flush();
      } else if (!this.timer) {
        this.timer = setTimeout(() => void this.flush(), this.batchWindowMs);
      }
    });
  }

  private async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const batch = this.pending.splice(0, MAX_BATCH_SIZE);
    if (batch.length === 0) return;
    const context: ModelContext = {
      dropTitle: this.drop.title,
      spotsLeft: batch[0]!.input.spotsLeft ?? this.drop.spots,
      perViewerLimit: this.drop.perViewerLimit,
    };

    const messages: ModelMessage[] = batch.map(({ input, ruleResult }) => ({
      ...input,
      viewerLimit: this.drop.perViewerLimit,
      ruleResult,
    }));
    try {
      if (!this.onBatch && !this.client.hasKey) throw new Error("no model key");
      const decisions = this.onBatch
        ? await this.onBatch(messages, context!)
        : await this.client.classifyBatch(messages, context!);
      const byId = new Map(
        decisions.map((decision) => [decision.id, decision]),
      );
      for (const pending of batch) {
        const decision = byId.get(pending.input.id);
        if (!decision) {
          pending.resolve(
            fallbackResult(
              messages.find((m) => m.id === pending.input.id)!,
              "model busy",
            ),
          );
        } else {
          pending.resolve(
            validateModelDecision(
              messages.find((m) => m.id === pending.input.id)!,
              decision,
              this.drop.perViewerLimit,
            ),
          );
        }
      }
    } catch (error) {
      const reason = failureReason(error);
      batch.forEach((pending, index) =>
        pending.resolve(fallbackResult(messages[index]!, reason)),
      );
    }

    if (this.pending.length > 0) {
      this.timer = setTimeout(() => void this.flush(), this.batchWindowMs);
    }
  }
}
