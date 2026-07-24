/**
 * `canSend()` — the central outbound guard (spec BR-L4 / BR-L8, ADR-004).
 *
 * Every outbound MUST pass this gate. Fail-safe toward "no enviar": hard blocks
 * are evaluated first, and any doubt resolves to not-allowed. This function is
 * pure — state (suppression, health, counters) is resolved by the caller from
 * the store / webhook signals.
 */

export type HealthStatus = "HEALTHY" | "AT_RISK" | "CRITICAL" | "OPTED_OUT";
export type Reputation = "HEALTHY" | "AT_RISK" | "CRITICAL";

export interface SendDecision {
  allowed: boolean;
  reason: "ok" | "suppressed" | "opted_out" | "critical" | "rate_limited";
  /** true when AT_RISK → keep sending but slow the cadence (BR-L4). */
  throttle?: boolean;
}

/** BR-L8 deliverability limits. */
export const MAX_MSGS_PER_DAY_PER_LINE = 7000;
export const MAX_MSGS_PER_60S_PER_PAIR = 30;

export interface SendGuardState {
  /** Sender is suppressed by a prior opt-out (terminal until OPTIN). */
  suppressed: boolean;
  healthStatus: HealthStatus;
  /** Messages (in+out) on the sending line in the rolling 24h window. */
  dailyLineCount?: number;
  /** Messages in the last 60s for this sender↔recipient pair. */
  pairCount60s?: number;
}

export function canSend(state: SendGuardState): SendDecision {
  // Hard blocks first (fail-safe order).
  if (state.suppressed) return { allowed: false, reason: "suppressed" };
  if (state.healthStatus === "OPTED_OUT") return { allowed: false, reason: "opted_out" };
  if (state.healthStatus === "CRITICAL") return { allowed: false, reason: "critical" };

  // Volume / burst (BR-L8): at or above the limit → defer.
  const daily = state.dailyLineCount ?? 0;
  const pair = state.pairCount60s ?? 0;
  if (daily >= MAX_MSGS_PER_DAY_PER_LINE || pair >= MAX_MSGS_PER_60S_PER_PAIR) {
    return { allowed: false, reason: "rate_limited" };
  }

  // AT_RISK still sends, but throttled.
  if (state.healthStatus === "AT_RISK") return { allowed: true, reason: "ok", throttle: true };

  return { allowed: true, reason: "ok" };
}
