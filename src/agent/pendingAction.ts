import type { Action } from "./types.js";
import type { WalletPort } from "./ports.js";

/**
 * Payment confirmation state machine (spec: specs/payment-confirmation.spec.md).
 *
 * The missing link between "the agent understood a payment" and "money moved".
 * `handleAgentMessage` returns `confirm_required` and STAGES here; nothing is
 * signed. A later "sí" / 👍 resolves the pending and only then calls
 * `wallet.pay()`. Twin of PendingReviewStore, which does the same for Terac consent.
 *
 * Two safety properties worth stating explicitly:
 *
 * - The pending is removed BEFORE `pay()` is awaited, so two confirmations racing
 *   cannot both reach the wallet (BR-C4 also guards this via actionId idempotency,
 *   but defence in depth is cheap here and the failure mode is a double payment).
 * - A confirmation with nothing staged pays nothing at all (BR-C5). The agent never
 *   infers which payment a bare "sí" meant.
 */

export interface PendingAction {
  readonly action: Action;
  /** ISO timestamp, for the TTL check (BR-C5). */
  readonly stagedAt: string;
  /** Id of the proposal message, so a tapback can find this pending (BR-C2). */
  readonly messageId?: string;
}

/**
 * Exactly the four outcomes the spec defines. An expired pending reports
 * `nothing_pending` — it is discarded, so from the caller's view nothing is staged,
 * and the reply for that case already asks the user to restate the request (BR-C5).
 */
export type ResolveOutcome =
  | { readonly kind: "paid"; readonly txRef: string }
  | { readonly kind: "nothing_pending" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed"; readonly reason: string };

/** Default staging lifetime: long enough to answer a text, short enough to be safe. */
export const DEFAULT_PENDING_TTL_MS = 10 * 60 * 1000;

export interface PendingActionStoreOptions {
  readonly ttlMs?: number;
  /** Injectable clock so the TTL is testable without waiting (BR-C5). */
  readonly now?: () => number;
}

export class PendingActionStore {
  private readonly byChat = new Map<string, PendingAction>();
  /** proposal messageId -> chatId, for tapback resolution. */
  private readonly messageIndex = new Map<string, string>();

  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: PendingActionStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_PENDING_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Stage a money action awaiting confirmation (BR-C1). Replaces any previous
   * pending for the chat — the newest proposal is the one in play.
   */
  stage(chatId: string, action: Action, messageId?: string): void {
    const previous = this.byChat.get(chatId);
    if (previous?.messageId !== undefined) this.messageIndex.delete(previous.messageId);

    this.byChat.set(chatId, {
      action,
      stagedAt: new Date(this.now()).toISOString(),
      ...(messageId !== undefined ? { messageId } : {}),
    });
    if (messageId !== undefined) this.messageIndex.set(messageId, chatId);
  }

  has(chatId: string): boolean {
    return this.peek(chatId) !== undefined;
  }

  /** The staged action, or undefined when absent or expired. */
  peek(chatId: string): PendingAction | undefined {
    const entry = this.byChat.get(chatId);
    if (entry === undefined) return undefined;

    if (this.isExpired(entry)) {
      this.discard(chatId);
      return undefined;
    }
    return entry;
  }

  /** Which chat a tapback on `messageId` belongs to (BR-C2). */
  chatForMessage(messageId: string): string | undefined {
    const chatId = this.messageIndex.get(messageId);
    if (chatId === undefined) return undefined;
    // Expiry check also clears a stale message index entry.
    return this.peek(chatId) === undefined ? undefined : chatId;
  }

  /** User declined (BR-C2): drop it without paying. */
  cancel(chatId: string): ResolveOutcome {
    const existed = this.peek(chatId) !== undefined;
    this.discard(chatId);
    return existed ? { kind: "cancelled" } : { kind: "nothing_pending" };
  }

  /**
   * User confirmed: execute the staged payment (BR-C2).
   *
   * The pending is discarded first, so neither a race nor a thrown error can leave
   * a payable action behind (BR-C7 requires the pending to be dropped on failure).
   */
  async resolve(chatId: string, wallet: WalletPort): Promise<ResolveOutcome> {
    const entry = this.peek(chatId);
    if (entry === undefined) return { kind: "nothing_pending" };

    this.discard(chatId);

    try {
      const { txRef } = await wallet.pay(entry.action);
      return { kind: "paid", txRef };
    } catch (error) {
      // BR-C9: the reason names the failure class, never the payee or amount.
      const reason = error instanceof Error ? error.message : "error desconocido";
      return { kind: "failed", reason };
    }
  }

  private isExpired(entry: PendingAction): boolean {
    return this.now() - Date.parse(entry.stagedAt) > this.ttlMs;
  }

  private discard(chatId: string): void {
    const entry = this.byChat.get(chatId);
    if (entry?.messageId !== undefined) this.messageIndex.delete(entry.messageId);
    this.byChat.delete(chatId);
  }
}

/**
 * Tapbacks that mean yes / no (BR-C2).
 *
 * ONLY thumbs-up confirms. ❤️, ‼️ and 😂 are deliberately excluded: the spec
 * authorizes 👍, and on a payment proposal an ambiguous reaction must not be read
 * as consent — someone reacting "haha" to "enviar 5.000 a ana" has not agreed to
 * anything.
 */
const AFFIRMATIVE_REACTIONS = new Set(["👍", "thumbsup", "thumbs_up", "like"]);
const NEGATIVE_REACTIONS = new Set(["👎", "thumbsdown", "thumbs_down", "dislike"]);

export type ReactionIntent = "confirm" | "cancel" | "ignore";

/**
 * Reads a tapback as confirm / cancel / neither.
 *
 * Anything unrecognized is ignored rather than guessed, because the cost of a wrong
 * guess here is an unintended payment.
 */
export function reactionIntent(reaction: string, action: "add" | "remove"): ReactionIntent {
  if (action === "remove") return "ignore";

  const normalized = reaction.trim().toLowerCase();
  if (AFFIRMATIVE_REACTIONS.has(normalized) || AFFIRMATIVE_REACTIONS.has(reaction.trim())) {
    return "confirm";
  }
  if (NEGATIVE_REACTIONS.has(normalized) || NEGATIVE_REACTIONS.has(reaction.trim())) {
    return "cancel";
  }
  return "ignore";
}
