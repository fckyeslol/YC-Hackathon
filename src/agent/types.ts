import type { ActionType, RiskSignals } from "../guardrail/types.js";

/**
 * Intent parser types (spec: specs/intent-parser.spec.md).
 *
 * The parser UNDERSTANDS a message; it never executes or classifies final risk
 * (BR-P4). It emits an Action with raw `riskSignals` that the guardrail then
 * classifies auto/escalate. The LLM is injected (see LlmClassifier) so all the
 * logic around it — validation, normalization, slot-filling, idempotency — is
 * pure and testable without a live model.
 */

export type Intent =
  | "pay"
  | "split"
  | "swap"
  | "balance"
  | "spending_insight"
  | "dashboard"
  | "advice"
  | "confirm"
  | "cancel"
  | "smalltalk"
  | "unknown";

/**
 * Maps an intent to the guardrail ActionType. Conversational/control intents
 * (confirm/cancel/smalltalk/unknown) are not guardrail actions → undefined.
 */
export const INTENT_TO_ACTION_TYPE: Record<Intent, ActionType | undefined> = {
  pay: "payment",
  split: "payment",
  swap: "swap",
  balance: "portfolio_query",
  spending_insight: "portfolio_query",
  dashboard: "portfolio_query",
  advice: "advice",
  confirm: undefined,
  cancel: undefined,
  smalltalk: undefined,
  unknown: undefined,
};

export interface Action {
  readonly intent: Intent;
  /** Guardrail action type; present only for actionable intents (BR-P4 feeds classify()). */
  readonly type?: ActionType | undefined;
  readonly params: Readonly<Record<string, unknown>>;
  /** Raw signals — the guardrail classifies, the parser only reports (BR-P4). */
  readonly riskSignals: RiskSignals;
  readonly confidence: number;
  /** Non-empty → the agent must re-ask instead of guessing (BR-P2). */
  readonly missingSlots: readonly string[];
  readonly rawText: string;
  /** Stable id for money actions, for idempotency (BR-P6). */
  readonly actionId?: string | undefined;
}

/**
 * The injected LLM step: text -> raw, UNVALIDATED structured guess.
 * The real implementation is a thin adapter over a model with structured
 * output; tests pass a stub. Returns `unknown` on purpose — parseIntent
 * validates it with Zod (BR-P1).
 */
export type LlmClassifier = (text: string) => Promise<unknown>;

export interface ParseDeps {
  readonly classify: LlmClassifier;
  /** Known recipients; anything outside is a novel counterparty (BR-P3). */
  readonly allowlist?: readonly string[];
  /** Already-seen action ids, for idempotency dedup (BR-P6). */
  readonly seenActionIds?: ReadonlySet<string>;
}
