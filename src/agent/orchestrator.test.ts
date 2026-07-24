import { describe, test, expect, vi } from "vitest";
import { handleAgentMessage, completeConsentedEscalation, WELCOME, NOT_UNDERSTOOD, type OrchestratorDeps } from "./orchestrator.js";
import type { Action, Intent } from "./types.js";
import type { LedgerPort, ConversationPort } from "./ports.js";
import { computeSummary } from "../anonymization/anonymize.js";
import type { AnonymizedSummary, FinancialProfile, Summary } from "../anonymization/types.js";

function fakeConversation(over: Partial<ConversationPort> = {}): ConversationPort {
  return {
    chat: async () => "¡Hola! Soy tu asesor 💸",
    answerFromData: async () => "Comida es tu mayor gasto.",
    ...over,
  };
}

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

  test("BR-A5 — the async LLM audit layer blocks an otherwise-clean summary (fail-closed)", async () => {
    const a = action("advice", { type: "advice", params: { question: "¿cancelo todo?" }, riskSignals: { amountBucket: "bajo", novelCounterparty: false, volatileSwap: false, modelConfidence: 0.4 } });
    const llmLeakScan = vi.fn(async () => [{ gate: "G-LLM", evidence: "huella única", why: "reidentificable" }]);
    const out = await handleAgentMessage("¿debería cancelar todo?", false, deps(a, { llmLeakScan }));
    expect(out.kind).toBe("blocked");
    expect(llmLeakScan).toHaveBeenCalledOnce();
  });

  test("BR-A5 — a clean LLM audit lets the escalation through", async () => {
    const a = action("advice", { type: "advice", params: { question: "¿cancelo todo?" }, riskSignals: { amountBucket: "bajo", novelCounterparty: false, volatileSwap: false, modelConfidence: 0.4 } });
    const llmLeakScan = vi.fn(async () => []);
    const out = await handleAgentMessage("¿debería cancelar todo?", false, deps(a, { llmLeakScan }));
    expect(out.kind).toBe("escalated");
    expect(llmLeakScan).toHaveBeenCalledOnce();
  });

  // --- conversational layer (spec: conversation.spec.md) ---

  test("BR-CV1/AC1 — smalltalk uses the conversation adapter, not the 'no entendí' line", async () => {
    const chat = vi.fn(async () => "¡Hola! puedo mover tu plata 💸");
    const out = await handleAgentMessage("hola", false, deps(action("smalltalk", { rawText: "hola" }), { conversation: fakeConversation({ chat }) }));
    expect(out).toEqual({ kind: "reply", text: "¡Hola! puedo mover tu plata 💸" });
    expect(chat).toHaveBeenCalledWith("hola");
  });

  test("BR-CV4/AC5 — smalltalk without an adapter falls back to WELCOME (never 'no entendí')", async () => {
    const out = await handleAgentMessage("hola", false, deps(action("smalltalk")));
    expect(out).toEqual({ kind: "reply", text: WELCOME });
    expect((out as { text: string }).text).not.toBe(NOT_UNDERSTOOD);
  });

  test("BR-CV4 — smalltalk falls back to WELCOME if the adapter throws (fail-closed soft)", async () => {
    const chat = vi.fn(async () => {
      throw new Error("brain down");
    });
    const out = await handleAgentMessage("hola", false, deps(action("smalltalk"), { conversation: fakeConversation({ chat }) }));
    expect(out).toEqual({ kind: "reply", text: WELCOME });
  });

  test("BR-CV5 — unknown keeps the 'no entendí' reply, distinct from smalltalk", async () => {
    const out = await handleAgentMessage("asdkfj", false, deps(action("unknown")));
    expect(out).toEqual({ kind: "reply", text: NOT_UNDERSTOOD });
  });

  test("BR-CV2/AC2 — a data question is answered from the user's OWN summary", async () => {
    const answerFromData = vi.fn(async (_text: string, _summary: Summary) => "Comida es tu mayor gasto: 60%.");
    const buildSummary = vi.fn(async () => computeSummary(PROFILE));
    const out = await handleAgentMessage(
      "¿en qué se me va la plata?",
      false,
      deps(action("spending_insight", { rawText: "¿en qué se me va la plata?" }), {
        ledger: fakeLedger({ buildSummary }),
        conversation: fakeConversation({ answerFromData }),
      }),
    );
    expect(out).toEqual({ kind: "answer", text: "Comida es tu mayor gasto: 60%." });
    expect(buildSummary).toHaveBeenCalled();
    // grounded: the user's summary is what the adapter received (BR-CV2).
    expect(answerFromData.mock.calls[0]![1]).toMatchObject({ categoryTotals: expect.anything() });
  });

  test("BR-CV4 — a data question falls back to structured answerQuery if the adapter throws", async () => {
    const answerQuery = vi.fn(async () => "Gastaste 60% en comida.");
    const answerFromData = vi.fn(async () => {
      throw new Error("brain down");
    });
    const out = await handleAgentMessage(
      "¿cuánto gasté?",
      false,
      deps(action("spending_insight"), { ledger: fakeLedger({ answerQuery }), conversation: fakeConversation({ answerFromData }) }),
    );
    expect(out).toEqual({ kind: "answer", text: "Gastaste 60% en comida." });
    expect(answerQuery).toHaveBeenCalled();
  });

  test("BR-CV3/AC4 — advice still escalates to humans even with a conversation adapter", async () => {
    const chat = vi.fn(async () => "x");
    const answerFromData = vi.fn(async () => "x");
    const a = action("advice", {
      type: "advice",
      params: { question: "¿cancelo Netflix?" },
      riskSignals: { amountBucket: "bajo", novelCounterparty: false, volatileSwap: false, modelConfidence: 0.4 },
    });
    const out = await handleAgentMessage("¿debería cancelar Netflix?", false, deps(a, { conversation: fakeConversation({ chat, answerFromData }) }));
    expect(out.kind).toBe("escalated");
    expect(chat).not.toHaveBeenCalled();
    expect(answerFromData).not.toHaveBeenCalled();
  });

  test("BR-CV3/AC6 — money still requires confirmation even with a conversation adapter", async () => {
    const chat = vi.fn(async () => "x");
    const a = action("pay", { type: "payment", params: { amount: 5_000, recipient: "ana" } });
    const out = await handleAgentMessage("mándale 5000 a ana", false, deps(a, { conversation: fakeConversation({ chat }) }));
    expect(out.kind).toBe("confirm_required");
    expect(chat).not.toHaveBeenCalled();
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
