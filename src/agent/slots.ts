import type { Intent } from "./types.js";

/**
 * Required slots per intent (BR-P2). If any required slot is absent/empty, the
 * agent must re-ask instead of guessing.
 */
export const REQUIRED_SLOTS: Record<Intent, readonly string[]> = {
  pay: ["amount", "recipient"],
  split: ["total", "participants"],
  swap: ["fromAsset", "toAsset", "amount"],
  balance: [],
  spending_insight: ["period"],
  dashboard: ["period"],
  advice: ["question"],
  confirm: [],
  cancel: [],
  smalltalk: [],
  unknown: [],
};

/** Slots that are required for `intent` but missing/empty in `params`. */
export function missingSlots(intent: Intent, params: Readonly<Record<string, unknown>>): string[] {
  return REQUIRED_SLOTS[intent].filter((slot) => isEmpty(params[slot]));
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}
