import type { Vote, Label } from "../types.js";

/**
 * Baseline: plurality vote per task. This is the naive "before" we beat with
 * Dawid-Skene. Ties break toward the lowest label index (deterministic).
 */
export function majorityVote(votes: readonly Vote[], numLabels: number): Map<string, Label> {
  const tallies = new Map<string, number[]>();

  for (const { taskId, label } of votes) {
    if (label < 0 || label >= numLabels) {
      throw new Error(`Vote label ${label} out of range [0, ${numLabels})`);
    }
    const counts = tallies.get(taskId) ?? new Array<number>(numLabels).fill(0);
    counts[label] = (counts[label] ?? 0) + 1;
    tallies.set(taskId, counts);
  }

  const result = new Map<string, Label>();
  for (const [taskId, counts] of tallies) {
    let best = 0;
    for (let k = 1; k < counts.length; k++) {
      if ((counts[k] ?? 0) > (counts[best] ?? 0)) best = k;
    }
    result.set(taskId, best);
  }
  return result;
}
