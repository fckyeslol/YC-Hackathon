import { createHash } from "node:crypto";
import type { Poll, Vote } from "../store/types.js";
import type { Submission, SubmissionAnswers } from "../clients/terac.js";
import { computeConsensus, type ConsensusResult } from "../services/consensus.js";
import { leakCheck } from "../anonymization/leakCheck.js";
import type { AnonymizedSummary } from "../anonymization/types.js";

/**
 * Harvest reviewer judgments from Terac and aggregate them (spec terac-review,
 * the "vuelta"). Terac's `listSubmissions` only gives STATUS; we pull the actual
 * CONTENT (BR-T3), turn each into a store Vote (channel "terac"), dedup per
 * participant (BR-T7), and aggregate with Dawid–Skene via computeConsensus (BR-T4).
 *
 * The reviewer's free-text advice is passed through leakCheck (BR-T8): if it
 * carries PII (a reviewer typing a name/number), the text is dropped — only the
 * structured label survives. The port is injected so this is testable offline.
 */

export interface ReviewerJudgment {
  readonly submissionId: string;
  readonly participantId: string;
  /** Index into poll.options — the value that feeds Dawid–Skene. */
  readonly label: number;
  /** Optional free advice, present only when it passed the leak-check. */
  readonly adviceText?: string;
}

/** The slice of TeracClient harvest needs (injectable). */
export interface TeracHarvestPort {
  listSubmissions(opportunityId: string, status?: Submission["status"]): Promise<{ data: Submission[] }>;
  getSubmissionAnswers(opportunityId: string, submissionId: string): Promise<SubmissionAnswers>;
}

export interface HarvestResult {
  readonly votes: readonly Vote[];
  readonly consensus: ConsensusResult;
  /** How many advice texts were dropped for carrying PII (BR-T8). */
  readonly droppedAdvice: number;
}

/** Per-review, non-linkable rater id (BR-T8): opaque, scoped to this poll. */
export function raterIdFor(pollId: string, participantId: string): string {
  return createHash("sha256").update(`${pollId}:${participantId}`).digest("hex").slice(0, 16);
}

/** True iff the free text carries no PII — reuses the SAME vetted patterns as the gate. */
function adviceIsClean(text: string): boolean {
  const probe: AnonymizedSummary = {
    reviewPseudonym: "probe",
    categoryBreakdown: [],
    trendsVsPrior: [],
    behaviorFlags: [text],
    amountBuckets: [],
  };
  return leakCheck(probe).ok;
}

/**
 * Map one reviewer's raw answers into a judgment. Pure — isolates the assumed
 * Terac answer shape (BR-T9) in one place. Returns null if no valid option was
 * chosen (an abstention is not counted rather than guessed).
 */
export function parseJudgment(poll: Poll, answer: SubmissionAnswers): ReviewerJudgment | null {
  let label = -1;
  let adviceText: string | undefined;

  for (const r of answer.responses) {
    const value = r.value.trim();
    const optIdx = poll.options.findIndex((o) => o.toLowerCase() === value.toLowerCase());
    if (optIdx >= 0 && label < 0) {
      label = optIdx;
      continue;
    }
    if (/consejo|advice|comentario|recomendaci/i.test(r.prompt)) adviceText = value;
  }

  if (label < 0) return null;
  return {
    submissionId: answer.submission_id,
    participantId: answer.participant_id,
    label,
    ...(adviceText ? { adviceText } : {}),
  };
}

export async function harvestReviews(
  poll: Poll,
  port: TeracHarvestPort,
  opts: { at: string },
): Promise<HarvestResult> {
  if (!poll.teracOpportunityId) throw new Error("poll has no teracOpportunityId — nothing to harvest");
  const oppId = poll.teracOpportunityId;

  const { data: submissions } = await port.listSubmissions(oppId);
  // Only completed reviews carry a judgment; in_progress/rejected do not.
  const done = submissions.filter((s) => s.status === "awaiting_review" || s.status === "approved");

  // Dedup: latest judgment per participant wins (BR-T7).
  const byParticipant = new Map<string, Vote>();
  let droppedAdvice = 0;

  for (const sub of done) {
    const answer = await port.getSubmissionAnswers(oppId, sub.id);
    const judgment = parseJudgment(poll, answer);
    if (!judgment) continue;
    if (judgment.adviceText && !adviceIsClean(judgment.adviceText)) droppedAdvice++;

    byParticipant.set(judgment.participantId, {
      pollId: poll.id,
      raterId: raterIdFor(poll.id, judgment.participantId),
      label: judgment.label,
      channel: "terac",
      at: opts.at,
    });
  }

  const votes = [...byParticipant.values()];
  const consensus = computeConsensus(poll, votes);
  return { votes, consensus, droppedAdvice };
}
