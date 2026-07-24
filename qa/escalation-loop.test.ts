import { describe, test, expect, vi } from "vitest";
import { handleAgentMessage, type OrchestratorDeps } from "../src/agent/orchestrator.js";
import { ReviewCoordinator } from "../src/escalation/reviewCoordinator.js";
import { computeSummary } from "../src/anonymization/anonymize.js";
import type { Action } from "../src/agent/types.js";
import type { LedgerPort } from "../src/agent/ports.js";
import type { AnonymizedSummary, FinancialProfile } from "../src/anonymization/types.js";

/**
 * End-to-end oracle for THE loop (spec: intent-parser + guardrail + anonymization
 * + terac-review). Every other suite tests one component in isolation; this one
 * stitches the two halves together EXACTLY as the composition root (server/index.ts)
 * wires them — orchestrator (parse → guardrail → anonymize → leakCheck) handing an
 * escalation to the ReviewCoordinator (consent gate → Terac deliver → Dawid–Skene →
 * coaching) — and drives one risky message from inbound to human verdict.
 *
 * It proves the halves connect and that NO raw PII crosses the boundary at any hop.
 */

// A real profile WITH PII — the whole point is that none of it survives to Terac.
const PROFILE: FinancialProfile = {
  identity: { name: "Mateo Pirela", cedula: "1140891234", phone: "+573001234567" },
  transactions: [
    { id: "t1", merchant: "Rappi", amount: 180_000, currency: "COP", date: "2026-07-05", category: "comida" },
    { id: "t2", merchant: "Netflix", amount: 42_000, currency: "COP", date: "2026-07-08", category: "suscripciones" },
    { id: "t3", merchant: "Arriendo", amount: 1_400_000, currency: "COP", date: "2026-07-01", category: "vivienda" },
  ],
  monthlyIncome: 4_000_000,
  exactBalance: 250_000,
  priorPeriodTotals: { suscripciones: 35_000 },
};

/** A high-amount payment: the guardrail must escalate this (BR-G2). */
const RISKY_PAYMENT: Action = {
  intent: "pay",
  type: "payment",
  params: { amount: 9_000_000, recipient: "ana" },
  riskSignals: { amountBucket: "muy_alto", novelCounterparty: false, volatileSwap: false, modelConfidence: 0.95 },
  confidence: 0.95,
  missingSlots: [],
  rawText: "págale 9 millones a ana",
};

describe("THE loop end-to-end (inbound → escalation → human verdict)", () => {
  test("a risky payment travels the full loop, PII-free, to a Dawid–Skene verdict", async () => {
    const phone = "+573007654321";

    // --- Compose the ports exactly like server/index.ts ---
    const buildSummary = vi.fn(async () => computeSummary(PROFILE));
    const ledger: LedgerPort = {
      answerQuery: async () => "n/a",
      buildSummary,
    };
    // Live LLM leak auditor, returning "clean" for this run (regex floor still runs).
    const llmLeakScan = vi.fn(async () => []);
    const agentDeps: OrchestratorDeps = {
      parse: async () => RISKY_PAYMENT,
      ledger,
      llmLeakScan,
    };

    const deliver = vi.fn(async (_anon: AnonymizedSummary) => {});
    const coach = vi.fn(async (_chatId: string, _message: string) => {});
    const reviewCoordinator = new ReviewCoordinator({
      deliver,
      coach,
      quorum: 3,
      now: () => "2026-07-24T00:00:00.000Z",
    });

    // --- Hop 1: inbound → orchestrator → escalation with an anonymized preview ---
    const outcome = await handleAgentMessage(RISKY_PAYMENT.rawText, false, agentDeps);
    expect(outcome.kind).toBe("escalated");
    if (outcome.kind !== "escalated") return; // narrow
    expect(buildSummary).toHaveBeenCalledOnce();
    expect(llmLeakScan).toHaveBeenCalledOnce(); // the LLM audit layer ran (BR-A5)

    // The preview and the anon carry ZERO PII from the profile.
    const previewBlob = outcome.previewText + JSON.stringify(outcome.anon);
    for (const pii of ["Mateo", "Pirela", "1140891234", "573001234567", "Rappi", "Netflix", "Arriendo"]) {
      expect(previewBlob).not.toContain(pii);
    }
    expect(outcome.anon.reviewPseudonym).toMatch(/^Revisor-anonimo-/);

    // --- Hop 2: stage consent, user replies 👍 → structural gate → Terac deliver ---
    reviewCoordinator.stageConsent(phone, outcome.anon);
    expect(reviewCoordinator.hasPending(phone)).toBe(true);

    const consent = await reviewCoordinator.maybeConsent(phone, "sí, dale");
    expect(consent.consented).toBe(true);
    expect(deliver).toHaveBeenCalledOnce();
    // What crossed to Terac is the exact anonymized summary — still PII-free.
    const delivered = JSON.stringify(deliver.mock.calls[0]![0]);
    expect(delivered).not.toContain("Mateo");
    expect(delivered).not.toMatch(/\d{7,}/);

    // --- Hop 3: three reviewers judge on the review page → quorum → Dawid–Skene ---
    const pseudonym = outcome.anon.reviewPseudonym;
    expect(reviewCoordinator.reviewCard(pseudonym)?.prompt).toBeTruthy();

    const r1 = await reviewCoordinator.recordJudgment(pseudonym, { label: 1 }); // "Sí"
    const r2 = await reviewCoordinator.recordJudgment(pseudonym, { label: 1 });
    expect(coach).not.toHaveBeenCalled(); // quorum (3) not yet reached
    const r3 = await reviewCoordinator.recordJudgment(pseudonym, { label: 0 }); // one dissenter

    expect(r1.recorded && r2.recorded && r3.recorded).toBe(true);
    expect(r3.closed).toBe(true);

    // --- Hop 4: the human verdict comes back to the user via coaching ---
    expect(coach).toHaveBeenCalledOnce();
    expect(coach.mock.calls[0]![0]).toBe(phone);
    expect(coach.mock.calls[0]![1]).toMatch(/verdict/i);
  });

  test("if the LLM auditor flags a leak, the loop halts before Terac (fail-closed)", async () => {
    const ledger: LedgerPort = {
      answerQuery: async () => "n/a",
      buildSummary: async () => computeSummary(PROFILE),
    };
    const agentDeps: OrchestratorDeps = {
      parse: async () => RISKY_PAYMENT,
      ledger,
      llmLeakScan: async () => [{ gate: "G-LLM", evidence: "huella", why: "reidentificable" }],
    };

    const outcome = await handleAgentMessage(RISKY_PAYMENT.rawText, false, agentDeps);
    expect(outcome.kind).toBe("blocked"); // never reaches stageConsent / Terac
  });
});
