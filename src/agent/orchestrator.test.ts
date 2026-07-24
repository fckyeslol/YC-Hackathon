import { describe, test, expect, vi } from "vitest";
import { handleAgentMessage, completeConsentedEscalation, type OrchestratorDeps } from "./orchestrator.js";
import type { Action, Intent } from "./types.js";
import type { LedgerPort } from "./ports.js";
import { computeSummary } from "../anonymization/anonymize.js";
import type { AnonymizedSummary, FinancialProfile } from "../anonymization/types.js";

const PROFILE: FinancialProfile = {
  identity: { name: "Mateo", cedula: "1140891234" },
  transactions: [
    { id: "t1", merchant: "Super", amount: 30_000, currency: "COP", date: "2026-07-01", category: "comida" },
    { id: "t2", merchant: "Netflix", amount: 20_000, currency: "COP", date: "2026-07-02", category: "suscripciones" },
  ],
  monthlyIncome: 5_000_000,
  exactBalance: 100_000,
};

function fakeLedger(over: Partial<LedgerPort> = {}): LedgerPort {
  return {
    answerQuery: async () => "Gastaste 60% en comida.",
    buildSummary: async () => computeSummary(PROFILE),
    ...over,
  };
}

function action(intent: Intent, over: Partial<Action> = {}): Action {
  return {
    intent,
    params: {},
    riskSignals: { amountBucket: "bajo", novelCounterparty: false, volatileSwap: false, modelConfidence: 0.95 },
    confidence: 0.95,
    missingSlots: [],
    rawText: "x",
    ...over,
  };
}

const deps = (a: Action, over: Partial<OrchestratorDeps> = {}): OrchestratorDeps => ({
  parse: async () => a,
  ledger: fakeLedger(),
  ...over,
});

describe("handleAgentMessage (end-to-end loop)", () => {
  test("unknown → safe reply", async () => {
    const out = await handleAgentMessage("???", false, deps(action("unknown")));
    expect(out.kind).toBe("reply");
  });

  test("query → read-only answer from the ledger (auto, BR-G1)", async () => {
    const answerQuery = vi.fn(async () => "Gastaste 60% en comida.");
    const out = await handleAgentMessage("¿en qué gasté?", false, deps(action("spending_insight"), { ledger: fakeLedger({ answerQuery }) }));
    expect(out).toEqual({ kind: "answer", text: "Gastaste 60% en comida." });
    expect(answerQuery).toHaveBeenCalled();
  });

  test("BR-P2 — missing recipient → reprompt, no execution", async () => {
    const out = await handleAgentMessage("manda 200", false, deps(action("pay", { type: "payment", params: { amount: 200 }, missingSlots: ["recipient"] })));
    expect(out.kind).toBe("reprompt");
  });

  test("BR-P5 — a low-risk payment still requires confirmation before executing", async () => {
    const a = action("pay", { type: "payment", params: { amount: 5_000, recipient: "ana" } });
    const out = await handleAgentMessage("mándale 5000 a ana", false, deps(a));
    expect(out.kind).toBe("confirm_required");
  });

  test("BR-V4 — a money action from voice echoes the understanding", async () => {
    const a = action("pay", { type: "payment", params: { amount: 5_000, recipient: "ana" } });
    const out = await handleAgentMessage("audio", true, deps(a));
    expect(out.kind).toBe("confirm_required");
    if (out.kind === "confirm_required") expect(out.text).toContain("nota de voz");
  });

  test("BR-G2 — a risky payment escalates with an anonymized preview", async () => {
    const buildSummary = vi.fn(async () => computeSummary(PROFILE));
    const a = action("pay", { type: "payment", params: { amount: 9_000_000, recipient: "ana" }, riskSignals: { amountBucket: "muy_alto", novelCounterparty: false, volatileSwap: false, modelConfidence: 0.95 } });
    const out = await handleAgentMessage("págale 9 millones a ana", false, deps(a, { ledger: fakeLedger({ buildSummary }) }));
    expect(out.kind).toBe("escalated");
    if (out.kind === "escalated") {
      expect(out.anon.reviewPseudonym).toMatch(/^Revisor-anonimo-/);
      expect(JSON.stringify(out.anon)).not.toContain("Mateo");
    }
    expect(buildSummary).toHaveBeenCalled();
  });

  test("BR-A5 — if the summary would leak, escalation is blocked (fail-closed)", async () => {
    const a = action("advice", { type: "advice", params: { question: "¿cancelo todo?" }, riskSignals: { amountBucket: "bajo", novelCounterparty: false, volatileSwap: false, modelConfidence: 0.4 } });
    const out = await handleAgentMessage("¿debería cancelar todo?", false, deps(a, {
      leakOpts: { extraScan: () => [{ gate: "G5", evidence: "x", why: "reidentificable" }] },
    }));
    expect(out.kind).toBe("blocked");
  });

  test("completeConsentedEscalation delivers through the structural gate", async () => {
    const anon: AnonymizedSummary = {
      reviewPseudonym: "Revisor-anonimo-abc123def456",
      categoryBreakdown: [{ category: "comida", pct: 100 }],
      trendsVsPrior: [],
      behaviorFlags: [],
      amountBuckets: [{ label: "gasto mensual", bucket: "bajo" }],
    };
    const deliver = vi.fn(async () => {});
    const result = await completeConsentedEscalation(anon, deliver);
    expect(result.sent).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});
