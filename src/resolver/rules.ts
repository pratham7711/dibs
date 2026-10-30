export type Intent = "claim" | "cancel" | "question" | "other";
export interface Resolution {
  intent: Intent;
  qty: number;
  confidence: number;
  reason: string;
}
const result = (
  intent: Intent,
  qty: number,
  confidence: number,
  reason: string,
): Resolution => ({ intent, qty, confidence, reason });
export function classifyMessage(input: string): Resolution {
  const s = input
    .trim()
    .toLowerCase()
    .replace(/[.!?,]+$/g, "")
    .replace(/\s+/g, " ");
  if (!s) return result("other", 0, 1, "Empty message.");
  if (
    /^(nvm|never mind|cancel(?: mine)?|drop me|nahi chahiye|mat do|mera cancel)$/.test(
      s,
    )
  )
    return result(
      "cancel",
      0,
      0.97,
      "Clear cancellation of the viewer’s claim.",
    );
  if (/^(he|she|they) (wants|want|got|gets)\b/.test(s))
    return result(
      "other",
      0,
      0.99,
      "Third-person statements are not first-person claims.",
    );
  // Questions ask for information; even polite requests stay below auto-grant confidence.
  if (
    /^(is it free|who got it|did .+ get it|can anyone get one|when does .+ (end|start)|me when the drop ends lol)\??$/.test(
      s,
    )
  )
    return result(
      "question",
      0,
      0.99,
      "Asks about the drop or another viewer; it is not a first-person claim.",
    );
  if (
    /^(i don't want|i do not want|i didnt want|i didn't want|i wanted|he wants|she wants|they want)\b/.test(
      s,
    )
  )
    return result(
      "other",
      0,
      0.99,
      "Negated, third-person, or past-tense intent is not a claim.",
    );
  if (
    /^(can i get (one|it)|could i get (one|it)|may i have (one|it))\??$/.test(s)
  )
    return result(
      "claim",
      1,
      0.68,
      "Polite request may be a claim, but needs intent review.",
    );
  const qtyMatch = s.match(
    /^(?:i(?:'ll| will) take|put me down for|(?:i want|give me)|)(?:\s*)(\d+|one|two|three)\s*(?:please|pls)?$/,
  );
  if (qtyMatch) {
    const q =
      ({ one: 1, two: 2, three: 3 } as Record<string, number>)[qtyMatch[1]!] ??
      Number(qtyMatch[1]);
    return result(
      "claim",
      q,
      0.96,
      "Explicit first-person request with quantity.",
    );
  }
  if (/^slot\s*\d+(?:\s+pls| please)?$/.test(s))
    return result(
      "claim",
      1,
      0.66,
      "Could name a preferred slot rather than request a spot; review intent.",
    );
  if (
    /^(dibs|!dibs|me|mine|i'm in|im in|i am in|i'll take it|ill take it|put me down|mujhe chahiye|mujhe ek chahiye|mera|le lunga|🙋|🙋‍♀️|🙋‍♂️|✋|\+1)$/.test(
      s,
    )
  )
    return result("claim", 1, 0.97, "Unambiguous first-person claim.");
  if (/^(me|mine|dibs|!dibs|i'm in|im in)\b/.test(s))
    return result(
      "claim",
      1,
      0.88,
      "Likely first-person claim with extra chat text.",
    );
  if (/\?/.test(input))
    return result(
      "question",
      0,
      0.9,
      "Question without a clear first-person claim.",
    );
  return result(
    "other",
    0,
    0.75,
    "No clear first-person claim or cancellation pattern.",
  );
}
