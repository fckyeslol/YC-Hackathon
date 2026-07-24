/**
 * Guardrail types (spec: specs/guardrail-escalation.spec.md).
 *
 * The guardrail is the twist that makes the agent safe: an AI that moves real
 * (testnet) money but asks humans for permission when it doubts. It consumes
 * RAW risk signals from the parser and decides auto-execute vs. escalate — the
 * parser never makes that call (BR-P4).
 */

/** Coarse amount bucket — same vocabulary as the anonymization pipeline. */
export type AmountBucket = "bajo" | "medio" | "alto" | "muy_alto";

export type ActionType = "payment" | "swap" | "portfolio_query" | "advice";

/** Raw risk signals emitted by the parser; the guardrail classifies them. */
export interface RiskSignals {
  readonly amountBucket: AmountBucket;
  /** Recipient never seen before. */
  readonly novelCounterparty: boolean;
  readonly volatileSwap: boolean;
  /** The agent's own confidence in its reading, 0..1. */
  readonly modelConfidence: number;
}

export interface Action {
  readonly type: ActionType;
  readonly riskSignals: RiskSignals;
}

export type Decision = "auto" | "escalate";

/** Classification result; `reasons` records what triggered an escalation (BR-G6). */
export interface ClassifyResult {
  readonly decision: Decision;
  /** Machine tags of the signals that forced escalation. Empty when auto. No PII. */
  readonly reasons: readonly string[];
}
