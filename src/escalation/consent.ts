import { createHash } from "node:crypto";
import type { AnonymizedSummary } from "../anonymization/types.js";

/**
 * Consent, made unforgeable (fixes the B1 "boolean passed by hand" footgun).
 *
 * A `boolean consented` can be set to true by a caller who never showed a
 * preview. A ConsentToken cannot: its constructor is private, so the ONLY way
 * to obtain one is `ConsentToken.approve(anon)` — which represents the user
 * approving that exact preview. The token is bound by digest to the specific
 * anonymized summary, so approving summary A can never authorize sending B.
 */

/** Stable digest of the exact anonymized content the user previewed (BR-A6). */
export function digestOf(anon: AnonymizedSummary): string {
  return createHash("sha256").update(JSON.stringify(anon)).digest("hex");
}

export class ConsentToken {
  private constructor(private readonly forDigest: string) {}

  /** The ONLY constructor. Call after showing the user this exact preview. */
  static approve(anon: AnonymizedSummary): ConsentToken {
    return new ConsentToken(digestOf(anon));
  }

  /** True iff this token was minted for exactly `anon`. */
  matches(anon: AnonymizedSummary): boolean {
    return this.forDigest === digestOf(anon);
  }
}
