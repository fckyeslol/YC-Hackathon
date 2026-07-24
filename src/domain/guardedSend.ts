import { canSend, type SendGuardState, type SendDecision } from "./sendGuard.js";
import type { MessagePart } from "../clients/linq.js";

/**
 * The inevitable outbound gate (fixes B2). Every agent-facing send MUST go
 * through this wrapper: `canSend()` is evaluated first and `deliver` (the raw
 * Linq client) is only reachable when the guard allows it. A caller cannot
 * "forget" the guard — there is no other sanctioned path to `deliver`.
 *
 * The one exception is the opt-out confirmation, which by design bypasses the
 * guard because it IS the allowed terminal message (BR-L2, handled elsewhere).
 */

export interface GuardedSendResult {
  readonly sent: boolean;
  readonly decision: SendDecision;
}

export async function guardedSend(
  to: string,
  parts: MessagePart[],
  resolveState: (to: string) => SendGuardState,
  deliver: (to: string, parts: MessagePart[]) => Promise<void>,
): Promise<GuardedSendResult> {
  const decision = canSend(resolveState(to));
  if (!decision.allowed) return { sent: false, decision };
  await deliver(to, parts);
  return { sent: true, decision };
}
