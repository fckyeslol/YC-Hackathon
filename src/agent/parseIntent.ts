import { createHash } from "node:crypto";
import { z } from "zod";
import { INTENT_TO_ACTION_TYPE, type Action, type Intent, type ParseDeps } from "./types.js";
import type { AmountBucket } from "../guardrail/types.js";
import { normalizeAmount, normalizePeriod } from "./normalize.js";
import { missingSlots } from "./slots.js";

/**
 * The intent parser (spec: specs/intent-parser.spec.md).
 * Validates the injected LLM's raw guess (BR-P1), normalizes slots (BR-P8),
 * resolves the recipient (BR-P3), emits raw risk signals (BR-P4) and computes
 * missing slots (BR-P2). It never decides auto/escalate and never invents a
 * money action from an unreadable message (BR-P10).
 */

const MONEY_INTENTS: readonly Intent[] = ["pay", "split", "swap"];

const INTENTS = [
  "pay", "split", "swap", "balance", "spending_insight",
  "dashboard", "advice", "confirm", "cancel", "smalltalk", "unknown",
] as const;

/** Schema the LLM's raw output must satisfy, or we reject it (BR-P1). */
const rawSchema = z.object({
  intent: z.enum(INTENTS),
  confidence: z.number().min(0).max(1),
  slots: z.record(z.unknown()).default({}),
  rawText: z.string().optional(),
});

export async function parseIntent(text: string, deps: ParseDeps): Promise<Action> {
  let raw: unknown;
  try {
    raw = await deps.classify(text);
  } catch {
    return unknownAction(text); // model failure -> never guess (BR-P10)
  }

  const parsed = rawSchema.safeParse(raw);
  if (!parsed.success) return unknownAction(text); // invalid shape -> unknown (BR-P1)

  const rawText = parsed.data.rawText ?? text;
  return buildAction(parsed.data.intent, parsed.data.slots, parsed.data.confidence, rawText, deps);
}

/**
 * Derive a validated Action from an intent + raw slots (BR-P2/P3/P4/P6/P8).
 * Split out from `parseIntent` so multi-turn slot-filling (slotFill.ts) can
 * rebuild an action after merging a follow-up value — with the risk signals,
 * missing-slot set and idempotency id all recomputed from the FILLED params,
 * never left stale from the half-filled first turn.
 */
export function buildAction(
  intent: Intent,
  slots: Record<string, unknown>,
  confidence: number,
  rawText: string,
  deps: Pick<ParseDeps, "allowlist" | "seenActionIds"> = {},
): Action {
  const params = normalizeParams(slots);

  const recipient = typeof params.recipient === "string" ? params.recipient : undefined;
  const novelCounterparty = recipient !== undefined && !isKnown(recipient, deps.allowlist);

  const amount = pickAmount(params);
  const riskSignals = {
    amountBucket: bucketAmount(amount),
    novelCounterparty,
    volatileSwap: intent === "swap",
    modelConfidence: confidence,
  };

  const missing = missingSlots(intent, params);
  const type = INTENT_TO_ACTION_TYPE[intent];

  // A money action gets a deterministic id ONLY once it is complete — so a
  // resend of the same complete request dedupes, and half-filled ones don't.
  const actionId =
    MONEY_INTENTS.includes(intent) && missing.length === 0 ? contentId(intent, params) : undefined;

  return { intent, type, params, riskSignals, confidence, missingSlots: missing, rawText, actionId };
}

/** True if this action was already seen (idempotency, BR-P6). */
export function isDuplicate(action: Action, seen: ReadonlySet<string> | undefined): boolean {
  return action.actionId !== undefined && seen !== undefined && seen.has(action.actionId);
}

export function bucketAmount(amount: number): AmountBucket {
  if (amount < 20_000) return "bajo";
  if (amount < 200_000) return "medio";
  if (amount < 2_000_000) return "alto";
  return "muy_alto";
}

// --- helpers ---

function normalizeParams(slots: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...slots };
  for (const key of ["amount", "total"]) {
    if (typeof out[key] === "string") {
      const n = normalizeAmount(out[key]);
      if (n !== null) out[key] = n;
    }
  }
  if (typeof out.period === "string") {
    const p = normalizePeriod(out.period);
    if (p !== null) out.period = p;
  }
  return out;
}

function pickAmount(params: Record<string, unknown>): number {
  const a = params.amount ?? params.total;
  return typeof a === "number" ? a : 0;
}

function isKnown(recipient: string, allowlist: readonly string[] | undefined): boolean {
  if (!allowlist) return false;
  const norm = recipient.trim().toLowerCase();
  return allowlist.some((c) => c.trim().toLowerCase() === norm);
}

function contentId(intent: Intent, params: Record<string, unknown>): string {
  // Sort param keys so the id is stable regardless of slot order (BR-P6).
  const sortedParams = Object.fromEntries(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)));
  const canonical = JSON.stringify({ intent, params: sortedParams });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function unknownAction(rawText: string): Action {
  return {
    intent: "unknown",
    type: undefined,
    params: {},
    riskSignals: { amountBucket: "bajo", novelCounterparty: false, volatileSwap: false, modelConfidence: 0 },
    confidence: 0,
    missingSlots: [],
    rawText,
  };
}
