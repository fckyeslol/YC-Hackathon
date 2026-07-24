import type { Action } from "./types.js";
import type { LedgerPort } from "./ports.js";
import type { AnonymizedSummary } from "../anonymization/types.js";
import { classify } from "../guardrail/classify.js";
import { anonymize } from "../anonymization/anonymize.js";
import { leakCheck, type LeakCheckOptions } from "../anonymization/leakCheck.js";
import { escalateToReviewers, type EscalationResult } from "../escalation/escalate.js";
import { ConsentToken } from "../escalation/consent.js";

/**
 * The agent loop core (spec: intent-parser + guardrail + anonymization).
 *
 * inbound text ─► parse ─► [query] answer directly (read-only, auto)
 *                        ├─ [missing slots] re-ask (BR-P2)
 *                        ├─ [money + auto] confirm first (BR-P5; echo if voice BR-V4)
 *                        └─ [risky/advice] escalate: anonymize → leakCheck → preview
 *
 * It returns an OUTCOME; the actual I/O (guardedSend, preview link, tapback
 * handling) is performed by the composition root, so this stays pure/testable.
 * Money is NEVER executed here — execution happens post-confirmation via WalletPort.
 */

export type AgentOutcome =
  | { kind: "reply"; text: string }
  | { kind: "answer"; text: string }
  | { kind: "reprompt"; text: string; missing: readonly string[] }
  | { kind: "confirm_required"; text: string; action: Action }
  | { kind: "escalated"; previewText: string; anon: AnonymizedSummary }
  | { kind: "blocked"; text: string };

export interface OrchestratorDeps {
  parse: (text: string) => Promise<Action>;
  ledger: LedgerPort;
  /** Optional extra leak scanner (LLM layer). Additive, fail-closed. */
  leakOpts?: LeakCheckOptions;
}

const MONEY_INTENTS = new Set(["pay", "split", "swap"]);
const QUERY_INTENTS = new Set(["balance", "spending_insight", "dashboard"]);

export async function handleAgentMessage(
  text: string,
  fromVoice: boolean,
  deps: OrchestratorDeps,
): Promise<AgentOutcome> {
  const action = await deps.parse(text);
  const { intent } = action;

  if (intent === "unknown" || intent === "smalltalk") {
    return { kind: "reply", text: "No te entendí del todo 🙏 ¿me lo explicás de otra forma?" };
  }
  if (intent === "confirm" || intent === "cancel") {
    // pending_action resolution (BR-P7) is wired at the tapback layer; ack here.
    return { kind: "reply", text: intent === "confirm" ? "Dale, confirmado ✅" : "Listo, lo cancelo." };
  }
  if (QUERY_INTENTS.has(intent)) {
    // Read-only → auto (BR-G1). No money moves.
    return { kind: "answer", text: await deps.ledger.answerQuery(action) };
  }

  // Actionable: pay / split / swap / advice.
  if (action.missingSlots.length > 0) {
    return { kind: "reprompt", text: repromptText(action), missing: [...action.missingSlots] };
  }

  const decision = classify({ type: action.type ?? "advice", riskSignals: action.riskSignals });

  if (decision.decision === "escalate") {
    const summary = await deps.ledger.buildSummary();
    const anon = anonymize(summary); // mints its own opaque reviewId (BR-A4)
    const leak = leakCheck(anon, deps.leakOpts ?? {});
    if (!leak.ok) {
      // Fail-closed (BR-A5): never send a leaky summary; degrade safely.
      return { kind: "blocked", text: "Por seguridad no puedo compartir tu resumen ahora. Probemos de otra forma." };
    }
    return { kind: "escalated", previewText: previewText(anon), anon };
  }

  // auto + money → still confirm before executing (BR-P5); echo when it came from voice (BR-V4).
  if (MONEY_INTENTS.has(intent)) {
    return { kind: "confirm_required", text: confirmText(action, fromVoice), action };
  }
  // auto advice → answer directly.
  return { kind: "answer", text: "Con gusto — acá va mi lectura." };
}

/**
 * Completes an escalation once the user approves the preview (their tapback 👍
 * IS the consent, BR-A6). Mints the token for the exact previewed summary and
 * runs the structural gate before anything reaches Terac.
 */
export async function completeConsentedEscalation(
  anon: AnonymizedSummary,
  deliver: (summary: AnonymizedSummary) => Promise<void>,
  opts?: LeakCheckOptions,
): Promise<EscalationResult> {
  const consent = ConsentToken.approve(anon);
  return escalateToReviewers(anon, consent, deliver, opts ?? {});
}

// --- user-facing text (echoes the user's OWN data back to them; no third-party PII) ---

function repromptText(action: Action): string {
  if (action.missingSlots.includes("recipient")) return "¿A quién se lo envío? 🙂";
  if (action.missingSlots.includes("amount")) return "¿Qué monto?";
  return `Me falta un dato para seguir: ${action.missingSlots.join(", ")}.`;
}

function confirmText(action: Action, fromVoice: boolean): string {
  const amount = action.params.amount ?? action.params.total;
  const recipient = action.params.recipient;
  const base =
    action.intent === "swap"
      ? `Entendí: cambiar ${amount ?? ""} ${String(action.params.fromAsset ?? "")} → ${String(action.params.toAsset ?? "")}`
      : `Entendí: enviar ${amount ?? ""}${recipient ? ` a ${String(recipient)}` : ""}`;
  const echo = fromVoice ? " (por tu nota de voz)" : "";
  return `${base}${echo} — ¿confirmás? 👍`;
}

function previewText(anon: AnonymizedSummary): string {
  const top = anon.categoryBreakdown
    .slice(0, 3)
    .map((c) => `${c.category} ${c.pct}%`)
    .join(", ");
  return `Esto es lo ÚNICO que verá el revisor (anónimo): ${top}. ¿Lo comparto? 👍`;
}
