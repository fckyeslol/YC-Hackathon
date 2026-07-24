import { describe, test, expect } from "vitest";
import { dawidSkene } from "./dawidSkene.js";
import { majorityVote } from "./majority.js";
import type { Vote } from "../types.js";

/** Deterministic PRNG so the crowd simulation is reproducible (no Math.random seed drift). */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("dawidSkene", () => {
  test("recovers truth exactly when all raters are perfect", () => {
    // Arrange: 3 tasks, truth [0,1,0], three flawless raters.
    const truth = [0, 1, 0];
    const votes: Vote[] = [];
    for (const r of ["a", "b", "c"]) {
      truth.forEach((label, j) => votes.push({ taskId: `t${j}`, raterId: r, label }));
    }

    // Act
    const { verdicts } = dawidSkene(votes, { numLabels: 2 });

    // Assert
    verdicts.forEach((v, j) => {
      expect(v.label).toBe(truth[j]);
      // Laplace smoothing caps a perfect rater's estimated accuracy below 1.0.
      expect(v.confidence).toBeGreaterThan(0.95);
    });
  });

  test("learns that an inverted rater is anti-correlated with truth", () => {
    // Arrange: 6 tasks, 4 always-correct raters anchor polarity; 1 rater always inverts.
    const truth = [0, 1, 0, 1, 0, 1];
    const votes: Vote[] = [];
    for (const r of ["e1", "e2", "e3", "e4"]) {
      truth.forEach((label, j) => votes.push({ taskId: `t${j}`, raterId: r, label }));
    }
    truth.forEach((label, j) => votes.push({ taskId: `t${j}`, raterId: "liar", label: 1 - label }));

    // Act
    const { verdicts, raters } = dawidSkene(votes, { numLabels: 2 });

    // Assert: verdict still tracks truth, and the liar is learned as below-random.
    verdicts.forEach((v, j) => expect(v.label).toBe(truth[j]));
    const liar = raters.find((r) => r.raterId === "liar")!;
    const expert = raters.find((r) => r.raterId === "e1")!;
    expect(liar.reliability).toBeLessThan(0.5);
    expect(expert.reliability).toBeGreaterThan(0.8);
  });

  test("beats majority vote when a reliable minority is drowned out by spammers", () => {
    // Arrange: 150 tasks, 3 reliable raters (85%) + 6 spammers (coin-flip).
    const rng = mulberry32(1234);
    const numTasks = 150;
    const truth = Array.from({ length: numTasks }, () => (rng() < 0.5 ? 0 : 1));

    const reliable = ["r1", "r2", "r3"];
    const spammers = ["s1", "s2", "s3", "s4", "s5", "s6"];
    const votes: Vote[] = [];
    truth.forEach((label, j) => {
      for (const r of reliable) {
        const reported = rng() < 0.85 ? label : 1 - label;
        votes.push({ taskId: `t${j}`, raterId: r, label: reported });
      }
      for (const s of spammers) {
        votes.push({ taskId: `t${j}`, raterId: s, label: rng() < 0.5 ? 0 : 1 });
      }
    });

    // Act
    const maj = majorityVote(votes, 2);
    const { verdicts } = dawidSkene(votes, { numLabels: 2 });

    const majAcc = truth.filter((label, j) => maj.get(`t${j}`) === label).length / numTasks;
    const dsAcc = verdicts.filter((v, j) => v.label === truth[Number(v.taskId.slice(1))]).length / numTasks;

    // Assert: Dawid-Skene meaningfully beats the naive baseline.
    // (This is exactly the before/after we surface to judges.)
    expect(dsAcc).toBeGreaterThan(majAcc);
    expect(dsAcc).toBeGreaterThan(0.8);
  });

  test("handles empty input gracefully", () => {
    const result = dawidSkene([], { numLabels: 3 });
    expect(result.verdicts).toHaveLength(0);
    expect(result.classPrior).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  test("rejects out-of-range labels", () => {
    expect(() => dawidSkene([{ taskId: "t0", raterId: "a", label: 5 }], { numLabels: 2 })).toThrow();
  });
});
