import type { AnonymizedSummary } from "../anonymization/types.js";
import type { LeakCheckOptions } from "../anonymization/leakCheck.js";
import { ConsentToken } from "./consent.js";
import { escalateToReviewers, type EscalationResult } from "./escalate.js";

/**
 * The consent trigger (spec terac-review BR-T6). When the agent escalates, it
 * STAGES the anonymized summary here and shows the user a preview. Nothing goes
 * to Terac yet. When the user taps 👍, `resolveConsent` mints a ConsentToken for
 * that exact summary and runs the structural gate (escalateToReviewers) → deliver.
 *
 * Keyed by chat/poll id so a tapback can find its pending review. The reviewer
 * page (BR-T2) looks up by pseudonym instead — never by user id.
 */

interface PendingEntry {
  readonly anon: AnonymizedSummary;
  readonly pseudonym: string;
}

export type ResolveOutcome = EscalationResult | { readonly sent: false; readonly reason: "nothing_pending" };

export class PendingReviewStore {
  private readonly byKey = new Map<string, PendingEntry>();

  /** Stage a review awaiting the user's consent. `key` = chat/poll id. */
  stage(key: string, anon: AnonymizedSummary): void {
    this.byKey.set(key, { anon, pseudonym: anon.reviewPseudonym });
  }

  has(key: string): boolean {
    return this.byKey.has(key);
  }

  /** Reviewer-page lookup (BR-T2): resolve the anonymized summary by pseudonym. */
  findByPseudonym(pseudonym: string): AnonymizedSummary | undefined {
    for (const entry of this.byKey.values()) {
      if (entry.pseudonym === pseudonym) return entry.anon;
    }
    return undefined;
  }

  /**
   * User consented (tapback 👍). Resolve the pending review through the gate and
   * clear it. No-op-safe: if nothing is pending, returns without delivering.
   */
  async resolveConsent(
    key: string,
    deliver: (anon: AnonymizedSummary) => Promise<void>,
    opts?: LeakCheckOptions,
  ): Promise<ResolveOutcome> {
    const entry = this.byKey.get(key);
    if (!entry) return { sent: false, reason: "nothing_pending" };
    this.byKey.delete(key);
    const consent = ConsentToken.approve(entry.anon);
    return escalateToReviewers(entry.anon, consent, deliver, opts ?? {});
  }
}
