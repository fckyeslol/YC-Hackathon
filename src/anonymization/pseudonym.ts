import { createHash, randomUUID } from "node:crypto";

/**
 * Rotating, non-linkable pseudonyms (BR-A4).
 *
 * The pseudonym is derived ONLY from a per-review id — never from the user's
 * identity. Each review gets a fresh, random `reviewId`, so:
 *   - two reviews of the same user yield different pseudonyms (no linkability), and
 *   - the pseudonym cannot be reversed to the user (it carries none of their data).
 */

/** A fresh, unguessable id for one review. Not tied to the user. */
export function newReviewId(): string {
  return randomUUID();
}

/** Deterministic pseudonym for a review id. Pure: same id -> same label. */
export function pseudonymFor(reviewId: string): string {
  // 12 hex chars = 48 bits of entropy — enough to avoid collisions across reviews.
  const digest = createHash("sha256").update(reviewId).digest("hex");
  return `Revisor-anonimo-${digest.slice(0, 12)}`;
}
