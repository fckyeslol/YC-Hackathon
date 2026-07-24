import type { Action, ActionType, ClassifyResult } from "./types.js";

/**
 * Guardrail classifier (spec: specs/guardrail-escalation.spec.md).
 *
 * Decides whether the agent may execute an action itself ("auto") or must
 * escalate to human consensus ("escalate"). Fail-safe toward the human: any
 * risk trigger escalates, and the reasons are recorded (BR-G6, no PII).
 */

/** The ONLY network money ever touches — testnet, no mainnet path (BR-G5, ADR-002). */
export const NETWORK = "base-sepolia" as const;

/** Below this self-confidence, escalate regardless of amount (BR-G3). */
export const CONFIDENCE_FLOOR = 0.6;

const MONEY_ACTIONS: readonly ActionType[] = ["payment", "swap"];

export function classify(action: Action): ClassifyResult {
  const { type, riskSignals: r } = action;

  // Read-only queries move no money → always auto (escalating them is absurd).
  if (type === "portfolio_query") return { decision: "auto", reasons: [] };

  const isMoney = MONEY_ACTIONS.includes(type);
  const reasons: string[] = [];

  // BR-G2: high amount on a money action.
  if (isMoney && (r.amountBucket === "alto" || r.amountBucket === "muy_alto")) {
    reasons.push(`amount_${r.amountBucket}`);
  }
  // BR-G2: brand-new recipient on a money action.
  if (isMoney && r.novelCounterparty) reasons.push("novel_counterparty");
  // BR-G2: volatile swap.
  if (r.volatileSwap) reasons.push("volatile_swap");
  // BR-G3: fail-safe on low self-confidence.
  if (r.modelConfidence < CONFIDENCE_FLOOR) reasons.push("low_confidence");

  // BR-G1/G3: escalate if anything tripped; otherwise the agent runs it.
  return { decision: reasons.length > 0 ? "escalate" : "auto", reasons };
}
