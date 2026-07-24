import type { AnonymizedSummary, LeakHit } from "../anonymization/types.js";
import { leakCheck, type LeakCheckOptions } from "../anonymization/leakCheck.js";
import { ConsentToken } from "./consent.js";

/**
 * The ONLY sanctioned path to put financial context in front of Terac reviewers
 * (spec: anonymization BR-A5/A6 + guardrail BR-G4). Fixes B1 by making the gate
 * structural rather than conventional:
 *
 *   1. what crosses the boundary is an AnonymizedSummary — never raw data;
 *   2. leakCheck() must pass, fail-closed (BR-A5);
 *   3. a ConsentToken minted for THIS exact summary must be present (BR-A6) —
 *      a hand-passed boolean cannot satisfy it.
 *
 * Only when all three hold is `deliver` (e.g. an adapter over
 * terac.createOpportunity) invoked. Raw PII therefore cannot reach a reviewer:
 * there is no path to `deliver` that skips anonymize → leakCheck → consent.
 */

export interface EscalationResult {
  readonly sent: boolean;
  readonly reason: "ok" | "leak_blocked" | "consent_missing_or_mismatch";
  readonly hits?: readonly LeakHit[];
}

export async function escalateToReviewers(
  anon: AnonymizedSummary,
  consent: ConsentToken,
  deliver: (summary: AnonymizedSummary) => Promise<void>,
  opts: LeakCheckOptions = {},
): Promise<EscalationResult> {
  // 1+2: fail-closed leak-check on the exact summary that would be sent.
  const leak = leakCheck(anon, opts);
  if (!leak.ok) return { sent: false, reason: "leak_blocked", hits: leak.hits };

  // 3: consent must be a real token minted for THIS summary.
  if (!(consent instanceof ConsentToken) || !consent.matches(anon)) {
    return { sent: false, reason: "consent_missing_or_mismatch" };
  }

  await deliver(anon);
  return { sent: true, reason: "ok" };
}
