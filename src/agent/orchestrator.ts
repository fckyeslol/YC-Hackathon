import type { Action } from "./types.js";
import type { LedgerPort, ConversationPort } from "./ports.js";
import type { AnonymizedSummary, LeakHit } from "../anonymization/types.js";
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
  /** Optional synchronous extra-scan injection (used by tests). Additive, fail-closed. */
  leakOpts?: LeakCheckOptions;
  /**
   * Optional async LLM leak auditor (BR-A5 "regex + LLM"). `leakCheck`'s
   * `extraScan` port is synchronous (ADR-006), so we pre-resolve this promise
   * here and fold its hits into the check. Additive-only and fail-closed:
   * `makeClaudeLeakScan` returns a blocking hit when the auditor is unavailable.
   */
  llmLeakScan?: (anon: AnonymizedSummary) => Promise<readonly LeakHit[]>;
  /**
   * Optional conversational adapter (spec: conversation.spec.md). When present,
   * small-talk gets a natural reply and factual data questions are answered in
   * natural language grounded in the user's own summary. Absent → fail-closed to
   * a canned welcome / the structured `answerQuery` (BR-CV4). Read-only: never
   * touches money or advice routing (BR-CV3).
   */
  conversation?: ConversationPort;
}

/** Friendly canned welcome when no conversational adapter is available (BR-CV4). */
export const WELCOME =
  "¡Hola! 👋 Soy tu asesor financiero. Puedo mover tu plata, mostrarte en qué gastás y darte consejo revisado por humanos reales. ¿Qué necesitás?";

/** Distinct from small-talk: we genuinely didn't understand (BR-CV5). */
export const NOT_UNDERSTOOD = "No te entendí del todo 🙏 ¿me lo explicás de otra forma?";

/** Fold pre-resolved LLM hits into the (optional) sync leak options. Additive-only. */
function composeLeakOpts(base: LeakCheckOptions | undefined, llmHits: readonly LeakHit[]): LeakCheckOptions {
  if (llmHits.length === 0) return base ?? {};
  const baseScan = base?.extraScan;
  return { extraScan: (scanText, anon) => [...(baseScan?.(scanText, anon) ?? []), ...llmHits] };
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

  // Small-talk → natural conversation (BR-CV1), distinct from unknown (BR-CV5).
  if (intent === "smalltalk") {
    if (deps.conversation) {
      try {
        return { kind: "reply", text: await deps.conversation.chat(action.rawText) };
      } catch {
        // Fail-closed soft: a down brain still greets, never "no entendí" (BR-CV4).
      }
    }
    return { kind: "reply", text: WELCOME };
  }
  if (intent === "unknown") {
    return { kind: "reply", text: NOT_UNDERSTOOD };
  }
  if (intent === "confirm" || intent === "cancel") {
    // pending_action resolution (BR-P7) is wired at the tapback layer; ack here.
    return { kind: "reply", text: intent === "confirm" ? "Dale, confirmado ✅" : "Listo, lo cancelo." };
  }
  if (QUERY_INTENTS.has(intent)) {
    // Read-only → auto (BR-G1). No money moves. When a conversational adapter is
    // present, answer in natural language grounded in the user's OWN summary
    // (their data, full detail — BR-CV2/BR-CV6); else the structured answer.
    if (deps.conversation) {
      try {
        const summary = await deps.ledger.buildSummary();
        return { kind: "answer", text: await deps.conversation.answerFromData(action.rawText, summary) };
      } catch {
        // Fail-closed soft: fall back to the structured answer (BR-CV4).
      }
    }
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
    // BR-A5 "regex + LLM": pre-resolve the async LLM audit (extraScan is sync,
    // ADR-006) and fold it into the deterministic floor. Both layers fail-closed.
    const llmHits = deps.llmLeakScan ? await deps.llmLeakScan(anon) : [];
    const leak = leakCheck(anon, composeLeakOpts(deps.leakOpts, llmHits));
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
