import type { Reputation } from "./sendGuard.js";

/**
 * State the inbound webhook router reads/writes: event dedup, opt-out
 * suppression (terminal per BR-L2), and the shared line's reputation.
 * An interface so the router stays pure/testable and the store impl can vary.
 */
export interface ComplianceState {
  /** event_id dedup — webhooks are at-least-once with retries (see BR-L1 notes). */
  hasSeen(eventId: string): boolean;
  markSeen(eventId: string): void;
  isSuppressed(phone: string): boolean;
  /** Terminal until an explicit OPTIN (BR-L2/BR-L3). */
  suppress(phone: string): void;
  clearSuppression(phone: string): void;
  lineReputation(): Reputation;
  setReputation(reputation: Reputation): void;
}

/** In-memory implementation with a bounded seen-events window. */
export class InMemoryComplianceState implements ComplianceState {
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private readonly suppressed = new Set<string>();
  private reputation: Reputation = "HEALTHY";

  constructor(private readonly maxSeen = 5000) {}

  hasSeen(eventId: string): boolean {
    return this.seen.has(eventId);
  }

  markSeen(eventId: string): void {
    if (this.seen.has(eventId)) return;
    this.seen.add(eventId);
    this.seenOrder.push(eventId);
    if (this.seenOrder.length > this.maxSeen) {
      const oldest = this.seenOrder.shift();
      if (oldest) this.seen.delete(oldest);
    }
  }

  isSuppressed(phone: string): boolean {
    return this.suppressed.has(phone);
  }

  suppress(phone: string): void {
    this.suppressed.add(phone);
  }

  clearSuppression(phone: string): void {
    this.suppressed.delete(phone);
  }

  lineReputation(): Reputation {
    return this.reputation;
  }

  setReputation(reputation: Reputation): void {
    this.reputation = reputation;
  }
}
