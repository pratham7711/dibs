const MAX_WHY_LENGTH = 90;

function asSentence(value: string): string {
  const sentence = value.trim();
  if (!sentence) return "";
  return /[.!?…]$/.test(sentence) ? sentence : `${sentence}.`;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 0) return "";
  if (maxLength === 1) return "…";
  const prefix = value.slice(0, maxLength - 1).trimEnd();
  const boundary = prefix.lastIndexOf(" ");
  const words = boundary > 0 ? prefix.slice(0, boundary) : prefix;
  return `${words}…`;
}

export function normalizeWhy(...reasons: string[]): string {
  const sentences = reasons.map(asSentence).filter(Boolean);
  const combined = sentences.join(" ");
  if (combined.length <= MAX_WHY_LENGTH) return combined;
  if (sentences.length < 2) return truncate(combined, MAX_WHY_LENGTH);

  const prioritySentence = truncate(sentences.pop()!, MAX_WHY_LENGTH - 10);
  const prefixBudget = MAX_WHY_LENGTH - prioritySentence.length - 1;
  const prefix = truncate(sentences.join(" "), prefixBudget);
  return `${prefix} ${prioritySentence}`.trim();
}
