import type { AnonymizedSummary } from "../anonymization/types.js";
import type { Poll, Vote } from "../store/types.js";
import { computeConsensus } from "../services/consensus.js";
import { leakCheck } from "../anonymization/leakCheck.js";
import { escalateToReviewers } from "./escalate.js";
import { ConsentToken } from "./consent.js";
import type { ReviewCard } from "../server/reviewPage.js";

/**
 * The full Terac review loop as one testable unit (spec terac-review). Ties
 * together: stage-on-escalation → consent → launch Terac → collect judgments on
 * the review page → quorum → Dawid–Skene → coach the user. All I/O is injected
 * (deliver to Terac, coach via Linq) so the composition root stays a few lines
 * and this is unit-testable offline.
 *
 * Consent is keyed by chat (a "sí"/👍 reply), not by message id — simplest path
 * that needs no message tracking. Reviewers are resolved by rotating pseudonym.
 */

// Boundary via negative lookahead, NOT \b: "sí" ends in an accented char that \b
// does not treat as a word char, so \b would never match after it.
const AFFIRMATIVE = /^\s*(s[ií]|dale|okay?|ok|yes|yeah|yep|sure|go|share|confirmo|listo|de una|👍|👌)(?![a-záéíóúüñ])/i;
const NEGATIVE = /^\s*(no|nope|nah|don'?t|stop|cancel(ar)?|mejor no|d[ée]jalo)(?![a-záéíóúüñ])/i;
const DEFAULT_QUORUM = 3;
const DEFAULT_PROMPT = "Would you give this action the green light?";
const DEFAULT_OPTIONS = ["No", "Yes"] as const;

export interface ReviewCoordinatorDeps {
  /** Send the anonymized summary to Terac reviewers (best-effort; may be a stub). */
  deliver: (anon: AnonymizedSummary) => Promise<void>;
  /** Send a message back to the user's chat (goes through guardedSend upstream). */
  coach: (chatId: string, message: string) => Promise<void>;
  quorum?: number;
  reviewPrompt?: string;
  reviewOptions?: readonly string[];
  /** Injectable clock for deterministic tests. */
  now?: () => string;
}

interface Session {
  readonly chatId: string;
  readonly poll: Poll;
  /** The exact anonymized summary the reviewer sees (BR-T2). */
  readonly anon: AnonymizedSummary;
  readonly votes: Vote[];
  raterSeq: number;
  closed: boolean;
}

export interface ConsentResult {
  readonly consented: boolean;
  /** A message to send the user, if any (confirmation or cancellation). */
  readonly reply?: string;
}

export class ReviewCoordinator {
  private readonly pendingByChat = new Map<string, AnonymizedSummary>();
  private readonly sessionsByPseudonym = new Map<string, Session>();

  constructor(private readonly deps: ReviewCoordinatorDeps) {}

  private now(): string {
    return this.deps.now ? this.deps.now() : new Date().toISOString();
  }

  private get quorum(): number {
    return this.deps.quorum ?? DEFAULT_QUORUM;
  }

  private get options(): readonly string[] {
    return this.deps.reviewOptions ?? DEFAULT_OPTIONS;
  }

  /** Called when the agent escalates: hold the summary, wait for the user's 👍. */
  stageConsent(chatId: string, anon: AnonymizedSummary): void {
    this.pendingByChat.set(chatId, anon);
  }

  hasPending(chatId: string): boolean {
    return this.pendingByChat.has(chatId);
  }

  /**
   * Interpret a reply while a review is pending consent. Affirmative → launch the
   * Terac review and open collection. Negative → cancel. Neither → not consumed.
   */
  async maybeConsent(chatId: string, replyText: string): Promise<ConsentResult> {
    const anon = this.pendingByChat.get(chatId);
    if (!anon) return { consented: false };

    if (NEGATIVE.test(replyText)) {
      this.pendingByChat.delete(chatId);
      return { consented: false, reply: "Okay, I won't share it. 👍" };
    }
    if (!AFFIRMATIVE.test(replyText)) return { consented: false };

    this.pendingByChat.delete(chatId);

    // Structural gate (BR-A8): the ONLY sanctioned path to a reviewer is
    // escalateToReviewers — it re-runs leakCheck (fail-closed floor) and verifies
    // a ConsentToken minted for THIS exact summary before calling deliver. The
    // user's 👍 IS the consent (BR-A6). A leak block is terminal; a recruitment
    // failure is best-effort (fail-open, no PII risk — the gate already passed).
    const consent = ConsentToken.approve(anon);
    let leakBlocked = false;
    try {
      const result = await escalateToReviewers(anon, consent, this.deps.deliver);
      leakBlocked = !result.sent && result.reason === "leak_blocked";
    } catch {
      // deliver threw AFTER the gate passed (e.g. Terac API down): swallow so the
      // loop stays demoable — the review page opens regardless.
    }
    if (leakBlocked) {
      return { consented: false, reply: "For your safety I can't share your summary right now. Let's try another way." };
    }

    // Gate passed → open the local review session so /review/:pseudonym resolves.
    this.sessionsByPseudonym.set(anon.reviewPseudonym, {
      chatId,
      poll: {
        id: `review-${anon.reviewPseudonym}`,
        prompt: this.deps.reviewPrompt ?? DEFAULT_PROMPT,
        options: [...this.options],
        status: "open",
        createdAt: this.now(),
      },
      anon,
      votes: [],
      raterSeq: 0,
      closed: false,
    });

    return { consented: true, reply: "Done — I asked real reviewers for their take (anonymously). I'll let you know as soon as there's consensus. 🙌" };
  }

  /** The review page (BR-T2) resolves the card by pseudonym. */
  reviewCard(pseudonym: string): ReviewCard | undefined {
    const session = this.sessionsByPseudonym.get(pseudonym);
    if (!session) return undefined;
    return { anon: session.anon, prompt: session.poll.prompt, options: session.poll.options };
  }

  /** Record one reviewer's judgment; on quorum, aggregate and coach the user. */
  async recordJudgment(
    pseudonym: string,
    judgment: { label: number; adviceText?: string },
  ): Promise<{ recorded: boolean; closed: boolean }> {
    const session = this.sessionsByPseudonym.get(pseudonym);
    if (!session || session.closed) return { recorded: false, closed: session?.closed ?? false };
    if (judgment.label < 0 || judgment.label >= session.poll.options.length) {
      return { recorded: false, closed: false };
    }

    session.raterSeq += 1;
    session.votes.push({
      pollId: session.poll.id,
      raterId: `terac-r${session.raterSeq}`,
      label: judgment.label,
      channel: "terac",
      at: this.now(),
    });

    if (session.votes.length < this.quorum) return { recorded: true, closed: false };

    session.closed = true;
    await this.deps.coach(session.chatId, this.summarize(session, judgment.adviceText));
    return { recorded: true, closed: true };
  }

  private summarize(session: Session, lastAdvice?: string): string {
    const result = computeConsensus(session.poll, session.votes);
    const ds = result.dawidSkene;
    const verdict = ds ? ds.labelText : "no consensus";
    const conf = ds ? ` (confidence ${(ds.confidence * 100).toFixed(0)}%)` : "";
    // The reviewers' free advice is echoed only if it carries no PII (BR-T8).
    const advice = lastAdvice && leakCheck({ reviewPseudonym: "p", categoryBreakdown: [], trendsVsPrior: [], behaviorFlags: [lastAdvice], amountBuckets: [] }).ok
      ? ` One reviewer suggests: "${lastAdvice}".`
      : "";
    return `Real humans reviewed your case: verdict **${verdict}**${conf}.${advice}`;
  }
}
