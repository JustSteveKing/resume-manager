// Grounding: model output may only use numbers that appear in the facts it was given.

/** Numbers in a sentence, normalised: "1.2k" → 1200, "2,932" → 2932, "40%" → 40. */
export function numbersIn(text: string): number[] {
  return [...text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*([kKmM])?(?![\w])/g)].map(([, n, unit]) => {
    const v = Number(n!.replace(/,/g, ""));
    return unit?.toLowerCase() === "k" ? v * 1000 : unit?.toLowerCase() === "m" ? v * 1_000_000 : v;
  });
}

/** A claim is grounded if every number in it appears in the facts (allowing "1.2k"-style rounding of 1,234). */
export function isGrounded(claim: string, facts: string): boolean {
  const known = numbersIn(facts);
  return numbersIn(claim).every((n) => known.some((k) => k === n || (n >= 1000 && Math.abs(k - n) / n < 0.05)));
}
