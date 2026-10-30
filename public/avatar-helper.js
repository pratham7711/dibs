export function firstGrapheme(value) {
  const text = String(value ?? "");
  const first = new Intl.Segmenter(undefined, { granularity: "grapheme" })
    .segment(text)
    [Symbol.iterator]()
    .next();
  return first.done ? "" : first.value.segment;
}
