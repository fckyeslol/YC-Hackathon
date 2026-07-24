/**
 * Opt-out / opt-in detection (spec BR-L2 / BR-L3).
 *
 * Compliance is our responsibility — **Linq does NOT suppress opt-outs for us.**
 * The deterministic core is an **exact, case-sensitive** match of the full
 * (trimmed) message against the keyword set. A message that merely *contains* a
 * keyword (e.g. "stop, ¿me explicas?") is NOT an opt-out — that is the explicit
 * no-false-positive gate G3.
 *
 * The spec also allows "intención clara de dejen de escribirme" beyond the exact
 * keywords; that fuzzy layer (LLM-classified) sits above this deterministic gate
 * and must fail-safe toward opt-out. This module is the deterministic floor.
 */

/** Exact, case-sensitive opt-out keywords (BR-L2). */
export const OPT_OUT_KEYWORDS = ["STOP", "UNSUBSCRIBE", "OPTOUT", "CANCEL", "END", "QUIT"] as const;

/** Exact, case-sensitive opt-in keyword that reverses suppression (BR-L3). */
export const OPT_IN_KEYWORD = "OPTIN";

/** True when the whole message is exactly one opt-out keyword (case-sensitive). */
export function isOptOut(text: string): boolean {
  const trimmed = text.trim();
  return (OPT_OUT_KEYWORDS as readonly string[]).includes(trimmed);
}

/** True when the whole message is exactly the opt-in keyword (case-sensitive). */
export function isOptIn(text: string): boolean {
  return text.trim() === OPT_IN_KEYWORD;
}
