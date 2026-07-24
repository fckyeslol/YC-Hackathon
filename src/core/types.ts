/**
 * Core domain types for Verdict.
 *
 * A "task" is a single judgment question (e.g. "Is this claim true?").
 * Panelists (real humans recruited via Terac) each cast a "vote" — a label
 * drawn from a fixed set of options. We aggregate votes into a calibrated
 * verdict, modelling that raters differ in reliability.
 */

/** A label is the index of a chosen option (0-based) for a task. */
export type Label = number;

/** One panelist's judgment on one task. */
export interface Vote {
  readonly taskId: string;
  readonly raterId: string;
  /** Index into the task's option list. */
  readonly label: Label;
}

/** Aggregated result for a single task. */
export interface TaskVerdict {
  readonly taskId: string;
  /** MAP (most probable) label given the model. */
  readonly label: Label;
  /** Posterior probability over each label; sums to 1. Index = label. */
  readonly posterior: readonly number[];
  /** Confidence in the MAP label = max(posterior). */
  readonly confidence: number;
}

/**
 * Estimated per-rater confusion matrix.
 * confusion[trueLabel][reportedLabel] = P(rater reports `reportedLabel` | truth is `trueLabel`).
 * The trace (diagonal mass) is a proxy for the rater's reliability.
 */
export interface RaterModel {
  readonly raterId: string;
  readonly confusion: readonly (readonly number[])[];
  /** Mean diagonal probability — 1.0 = perfect, ~1/K = random, <1/K = anti-correlated. */
  readonly reliability: number;
}

export interface AggregationResult {
  readonly verdicts: readonly TaskVerdict[];
  readonly raters: readonly RaterModel[];
  /** Estimated class prior over labels. */
  readonly classPrior: readonly number[];
  /** EM iterations run before convergence. */
  readonly iterations: number;
}
