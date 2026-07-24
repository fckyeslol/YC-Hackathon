import type { Vote, AggregationResult, TaskVerdict, RaterModel } from "../types.js";
import { majorityVote } from "./majority.js";

export interface DawidSkeneOptions {
  /** Number of possible labels (options) per task. */
  readonly numLabels: number;
  /** Max EM iterations. */
  readonly maxIterations?: number;
  /** Convergence threshold on the L1 change in task posteriors. */
  readonly tolerance?: number;
  /** Laplace smoothing added to confusion-matrix counts. Keeps estimates off 0/1. */
  readonly smoothing?: number;
}

const DEFAULTS = { maxIterations: 100, tolerance: 1e-4, smoothing: 0.5 } as const;

/**
 * Dawid & Skene (1979) EM estimator for crowd-sourced labels.
 *
 * Jointly estimates, from votes alone (no ground truth):
 *   - the latent true label of each task,
 *   - each rater's confusion matrix (their reliability), and
 *   - the class prior.
 *
 * The key property over majority vote: a rater who is consistently *wrong*
 * (adversarial or inverted) is learned to be anti-correlated with truth, so
 * their votes are effectively flipped rather than counted at face value.
 *
 * Model:
 *   T[j][k]        = P(task j has true label k)         (soft assignment)
 *   pi[i][k][l]    = P(rater i reports l | truth is k)  (confusion matrix)
 *   prior[k]       = P(true label = k)
 *
 * E-step:  T[j][k] ∝ prior[k] * Π_i Π_l pi[i][k][l]^count[i][j][l]
 * M-step:  re-estimate prior and pi as expected counts weighted by T.
 */
export function dawidSkene(votes: readonly Vote[], opts: DawidSkeneOptions): AggregationResult {
  const K = opts.numLabels;
  const maxIterations = opts.maxIterations ?? DEFAULTS.maxIterations;
  const tolerance = opts.tolerance ?? DEFAULTS.tolerance;
  const smoothing = opts.smoothing ?? DEFAULTS.smoothing;

  if (K < 2) throw new Error("numLabels must be >= 2");
  if (votes.length === 0) {
    return { verdicts: [], raters: [], classPrior: new Array<number>(K).fill(1 / K), iterations: 0 };
  }

  const taskIds = [...new Set(votes.map((v) => v.taskId))];
  const raterIds = [...new Set(votes.map((v) => v.raterId))];
  const taskIndex = new Map(taskIds.map((id, i) => [id, i]));
  const raterIndex = new Map(raterIds.map((id, i) => [id, i]));
  const J = taskIds.length;
  const I = raterIds.length;

  // count[i][j][l] — how many times rater i gave task j label l (usually 0 or 1).
  const count = arr3(I, J, K);
  for (const v of votes) {
    if (v.label < 0 || v.label >= K) throw new Error(`label ${v.label} out of range`);
    count[raterIndex.get(v.raterId)!]![taskIndex.get(v.taskId)!]![v.label]! += 1;
  }

  // Initialise T from majority vote (hard -> soft).
  const maj = majorityVote(votes, K);
  let T = taskIds.map((id) => {
    const row = new Array<number>(K).fill(0);
    row[maj.get(id) ?? 0] = 1;
    return row;
  });

  let prior = new Array<number>(K).fill(1 / K);
  let pi = arr3(I, K, K);
  let iterations = 0;

  for (let iter = 0; iter < maxIterations; iter++) {
    iterations = iter + 1;

    // ---- M-step: prior ----
    const nextPrior = new Array<number>(K).fill(0);
    for (let j = 0; j < J; j++) for (let k = 0; k < K; k++) nextPrior[k]! += T[j]![k]!;
    normalize(nextPrior);
    prior = nextPrior;

    // ---- M-step: confusion matrices ----
    const nextPi = arr3(I, K, K);
    for (let i = 0; i < I; i++) {
      for (let k = 0; k < K; k++) {
        const rowTotals = new Array<number>(K).fill(smoothing);
        for (let j = 0; j < J; j++) {
          const w = T[j]![k]!;
          if (w === 0) continue;
          for (let l = 0; l < K; l++) rowTotals[l]! += w * count[i]![j]![l]!;
        }
        const sum = rowTotals.reduce((a, b) => a + b, 0);
        for (let l = 0; l < K; l++) nextPi[i]![k]![l]! = rowTotals[l]! / sum;
      }
    }
    pi = nextPi;

    // ---- E-step: task posteriors (in log space for stability) ----
    const nextT = taskIds.map(() => new Array<number>(K).fill(0));
    let delta = 0;
    for (let j = 0; j < J; j++) {
      const logP = new Array<number>(K);
      for (let k = 0; k < K; k++) {
        let lp = Math.log(prior[k]! + 1e-12);
        for (let i = 0; i < I; i++) {
          for (let l = 0; l < K; l++) {
            const c = count[i]![j]![l]!;
            if (c !== 0) lp += c * Math.log(pi[i]![k]![l]! + 1e-12);
          }
        }
        logP[k] = lp;
      }
      const post = softmax(logP);
      for (let k = 0; k < K; k++) {
        delta += Math.abs(post[k]! - T[j]![k]!);
        nextT[j]![k]! = post[k]!;
      }
    }
    T = nextT;

    if (delta < tolerance) break;
  }

  const verdicts: TaskVerdict[] = taskIds.map((taskId, j) => {
    const posterior = T[j]!;
    let label = 0;
    for (let k = 1; k < K; k++) if (posterior[k]! > posterior[label]!) label = k;
    return { taskId, label, posterior: [...posterior], confidence: posterior[label]! };
  });

  const raters: RaterModel[] = raterIds.map((raterId, i) => {
    const confusion = pi[i]!.map((row) => [...row]);
    let diag = 0;
    for (let k = 0; k < K; k++) diag += confusion[k]![k]!;
    return { raterId, confusion, reliability: diag / K };
  });

  return { verdicts, raters, classPrior: [...prior], iterations };
}

// --- helpers ---

function arr3(a: number, b: number, c: number): number[][][] {
  return Array.from({ length: a }, () => Array.from({ length: b }, () => new Array<number>(c).fill(0)));
}

function normalize(v: number[]): void {
  const sum = v.reduce((a, b) => a + b, 0);
  if (sum === 0) return;
  for (let i = 0; i < v.length; i++) v[i]! /= sum;
}

function softmax(logits: readonly number[]): number[] {
  const max = Math.max(...logits);
  const exps = logits.map((x) => Math.exp(x - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}
