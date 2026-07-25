import type { Action, Intent, ParseDeps } from "./types.js";
import { buildAction } from "./parseIntent.js";
import { normalizeAmount, normalizePeriod } from "./normalize.js";

/**
 * Multi-turn slot-filling (spec: intent-parser BR-P2; PLAN §5.3 rules 1 & 6).
 *
 * When the agent re-asks for a missing slot ("How much?"), the partial action is
 * staged here. The user's next message ("200usd") is a slot VALUE, not a new
 * command — so we merge it into the pending action instead of parsing it cold
 * (which returns `unknown` and drops the whole request on the floor).
 *
 * `fillPending` rebuilds the action from the FILLED params via `buildAction`, so
 * the risk signals, missing-slot set and idempotency id are all recomputed — a
 * big amount filled on turn two still escalates correctly, never stays "bajo"
 * from the empty first turn.
 */

/** Intents that stand on their own as a new command — they override a pending fill. */
const COMMAND_INTENTS: ReadonlySet<Intent> = new Set([
  "pay",
  "split",
  "swap",
  "balance",
  "spending_insight",
  "dashboard",
  "advice",
]);

/**
 * Should the follow-up be treated as a NEW command rather than a slot value?
 * "How much?" → "actually, show my dashboard" switches intent; "200usd" does not.
 */
export function isFreshCommand(probeIntent: Intent, pendingIntent: Intent): boolean {
  return COMMAND_INTENTS.has(probeIntent) && probeIntent !== pendingIntent;
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Merge a follow-up reply into a pending partial action and rebuild it.
 * For each still-missing slot: prefer a value the cold parse happened to extract,
 * else pull it deterministically from the raw text (amounts via `normalizeAmount`,
 * periods via `normalizePeriod`; a free-text slot takes the whole reply only when
 * it is the ONLY thing missing, so a bare "200" never becomes a recipient name).
 */
export function fillPending(
  pending: Action,
  probe: Action,
  rawText: string,
  deps: Pick<ParseDeps, "allowlist" | "seenActionIds"> = {},
): Action {
  const filled: Record<string, unknown> = { ...pending.params };
  const soleMissing = pending.missingSlots.length === 1;

  for (const slot of pending.missingSlots) {
    const fromProbe = probe.params[slot];
    if (!isEmpty(fromProbe)) {
      filled[slot] = fromProbe;
      continue;
    }
    if (slot === "amount" || slot === "total") {
      const n = normalizeAmount(rawText);
      if (n !== null) filled[slot] = n;
    } else if (slot === "period") {
      const p = normalizePeriod(rawText);
      if (p !== null) filled[slot] = p;
    } else if (soleMissing && (slot === "recipient" || slot === "question" || slot === "fromAsset" || slot === "toAsset")) {
      const t = rawText.trim();
      if (t) filled[slot] = t;
    }
  }

  const confidence = Math.max(pending.confidence, probe.confidence);
  return buildAction(pending.intent, filled, confidence, rawText, deps);
}

// --- pending slot-fill store (per chat/session) --------------------------------

interface Pending {
  readonly action: Action;
  readonly stagedAt: number;
}

/** Default lifetime for an unfinished request: enough to type an answer, then it lapses. */
export const DEFAULT_SLOTFILL_TTL_MS = 10 * 60 * 1000;

export interface SlotFillStoreOptions {
  readonly ttlMs?: number;
  readonly now?: () => number;
}

/**
 * Per-chat store of the one partial action awaiting a follow-up value. A new
 * reprompt replaces the previous pending (the newest incomplete request wins),
 * mirroring PendingActionStore's shape for consistency.
 */
export class SlotFillStore {
  private readonly byChat = new Map<string, Pending>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: SlotFillStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_SLOTFILL_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  stage(chatId: string, action: Action): void {
    this.byChat.set(chatId, { action, stagedAt: this.now() });
  }

  peek(chatId: string): Action | undefined {
    const entry = this.byChat.get(chatId);
    if (entry === undefined) return undefined;
    if (this.now() - entry.stagedAt > this.ttlMs) {
      this.byChat.delete(chatId);
      return undefined;
    }
    return entry.action;
  }

  has(chatId: string): boolean {
    return this.peek(chatId) !== undefined;
  }

  clear(chatId: string): void {
    this.byChat.delete(chatId);
  }
}
