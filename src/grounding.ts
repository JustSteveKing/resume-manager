// Grounding: model output may only use numbers, and strong credentials, that appear in the facts it was given.

/** Numbers in a sentence, normalised: "1.2k" → 1200, "2,932" → 2932, "40%" → 40. */
export function numbersIn(text: string): number[] {
  return [...text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*([kKmM])?(?![\w])/g)].map(([, n, unit]) => {
    const v = Number(n!.replace(/,/g, ""));
    return unit?.toLowerCase() === "k" ? v * 1000 : unit?.toLowerCase() === "m" ? v * 1_000_000 : v;
  });
}

/**
 * Credentials and accolades a model likes to add ("Award-winning engineer…"). Each may only appear in
 * output when the facts mention it too. Numbers can't catch these: they're claims without digits.
 */
const CREDENTIALS: RegExp[] = [
  /\baward/i,
  /\bprize/i,
  /\bcertifi(?:ed|cation)/i,
  /\baccredit/i,
  /\bchartered\b/i,
  /\bpatent/i,
  /\bbest[- ]?sell/i,
  /\bworld[- ]class\b/i,
  /\bindustry[- ]leading\b/i,
  /\brenowned\b/i,
  /\bacclaimed\b/i,
  /\btop[- ]rated\b/i,
  /\bkeynote/i,
  /\b(?:phd|ph\.d|doctorate)\b/i,
];

/** Credentials in the claim that the facts don't mention. */
export function unsupportedCredentials(claim: string, facts: string): string[] {
  return CREDENTIALS.filter((re) => re.test(claim) && !re.test(facts)).map((re) => claim.match(re)![0]);
}

/**
 * A claim is grounded if every number in it appears in the facts (allowing "1.2k"-style rounding of 1,234)
 * and it adds no credential the facts don't mention.
 */
export function isGrounded(claim: string, facts: string): boolean {
  const known = numbersIn(facts);
  const numbersOk = numbersIn(claim).every((n) => known.some((k) => k === n || (n >= 1000 && Math.abs(k - n) / n < 0.05)));
  return numbersOk && unsupportedCredentials(claim, facts).length === 0;
}
