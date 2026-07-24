import type { Poll, Vote } from "../store/types.js";
import type { Vote as AggVote } from "../core/types.js";
import { dawidSkene } from "../core/aggregation/dawidSkene.js";
import { majorityVote } from "../core/aggregation/majority.js";

export interface MethodVerdict {
  label: number;
  labelText: string;
  confidence: number;
  correct: boolean | null;
}

export interface RaterReliability {
  raterId: string;
  reliability: number;
}

/** Live consensus snapshot for a single poll. */
export interface ConsensusResult {
  pollId: string;
  prompt: string;
  options: readonly string[];
  numVotes: number;
  numRaters: number;
  tally: number[];
  groundTruth: number | null;
  model: MethodVerdict | null;
  majority: MethodVerdict | null;
  dawidSkene: (MethodVerdict & { posterior: number[]; raters: RaterReliability[] }) | null;
}

function correctness(label: number, groundTruth: number | null): boolean | null {
  return groundTruth === null ? null : label === groundTruth;
}

/** Compute the model / majority / Dawid-Skene verdicts for one poll from its votes. */
export function computeConsensus(poll: Poll, votes: readonly Vote[]): ConsensusResult {
  const K = poll.options.length;
  const gt = poll.groundTruth ?? null;

  const tally = new Array<number>(K).fill(0);
  for (const v of votes) if (v.label >= 0 && v.label < K) tally[v.label]! += 1;

  const raterIds = new Set(votes.map((v) => v.raterId));

  const model: MethodVerdict | null = poll.modelGuess
    ? {
        label: poll.modelGuess.label,
        labelText: poll.options[poll.modelGuess.label] ?? "?",
        confidence: poll.modelGuess.confidence,
        correct: correctness(poll.modelGuess.label, gt),
      }
    : null;

  if (votes.length === 0) {
    return {
      pollId: poll.id,
      prompt: poll.prompt,
      options: poll.options,
      numVotes: 0,
      numRaters: 0,
      tally,
      groundTruth: gt,
      model,
      majority: null,
      dawidSkene: null,
    };
  }

  const aggVotes: AggVote[] = votes.map((v) => ({ taskId: poll.id, raterId: v.raterId, label: v.label }));

  const majMap = majorityVote(aggVotes, K);
  const majLabel = majMap.get(poll.id) ?? 0;
  const majority: MethodVerdict = {
    label: majLabel,
    labelText: poll.options[majLabel] ?? "?",
    confidence: (tally[majLabel] ?? 0) / votes.length,
    correct: correctness(majLabel, gt),
  };

  const ds = dawidSkene(aggVotes, { numLabels: K });
  const dsVerdict = ds.verdicts[0]!;
  const dawidSkeneResult = {
    label: dsVerdict.label,
    labelText: poll.options[dsVerdict.label] ?? "?",
    confidence: dsVerdict.confidence,
    correct: correctness(dsVerdict.label, gt),
    posterior: [...dsVerdict.posterior],
    raters: ds.raters.map((r) => ({ raterId: r.raterId, reliability: r.reliability })),
  };

  return {
    pollId: poll.id,
    prompt: poll.prompt,
    options: poll.options,
    numVotes: votes.length,
    numRaters: raterIds.size,
    tally,
    groundTruth: gt,
    model,
    majority,
    dawidSkene: dawidSkeneResult,
  };
}

/** Aggregate accuracy across labeled polls — the headline before/after. */
export interface BenchmarkSummary {
  labeledPolls: number;
  modelAccuracy: number | null;
  majorityAccuracy: number | null;
  dawidSkeneAccuracy: number | null;
}

export function summarizeBenchmark(results: ConsensusResult[]): BenchmarkSummary {
  const labeled = results.filter((r) => r.groundTruth !== null && r.numVotes > 0);
  if (labeled.length === 0) {
    return { labeledPolls: 0, modelAccuracy: null, majorityAccuracy: null, dawidSkeneAccuracy: null };
  }
  const rate = (pick: (r: ConsensusResult) => boolean | null | undefined) => {
    const vals = labeled.map(pick).filter((v): v is boolean => v !== null && v !== undefined);
    return vals.length ? vals.filter(Boolean).length / vals.length : null;
  };
  return {
    labeledPolls: labeled.length,
    modelAccuracy: rate((r) => r.model?.correct),
    majorityAccuracy: rate((r) => r.majority?.correct),
    dawidSkeneAccuracy: rate((r) => r.dawidSkene?.correct),
  };
}
