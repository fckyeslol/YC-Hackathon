import { describe, it, expect, vi } from "vitest";
import { extractJson, parseLeakHits, makeClaudeClassifier, makeClaudeLeakScan, makeClaudeConversation } from "./runwareBrain.js";
import type { AnonymizedSummary, Summary } from "../anonymization/types.js";

/** Minimal OpenAI-compatible chat response for the injected fetch. */
function chatResponse(content: string, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => ({ choices: [{ message: { content } }] }),
  } as unknown as Response;
}

const OPTS = { apiKey: "k", model: "anthropic-claude-haiku-4-5", baseUrl: "https://api.runware.ai/v1" };

describe("extractJson", () => {
  it("parses a bare JSON object", () => {
    expect(extractJson('{"intent":"pay","confidence":0.9,"slots":{}}')).toEqual({
      intent: "pay",
      confidence: 0.9,
      slots: {},
    });
  });

  it("tolerates code fences and surrounding prose", () => {
    expect(extractJson('Listo:\n```json\n{"intent":"balance","confidence":0.8}\n```')).toEqual({
      intent: "balance",
      confidence: 0.8,
    });
  });

  it("throws when there is no JSON object (parser then fails closed to unknown)", () => {
    expect(() => extractJson("no puedo ayudarte")).toThrow();
  });
});

describe("parseLeakHits (BR-A5 fail-closed)", () => {
  it("returns [] for a clean verdict", () => {
    expect(parseLeakHits('{"hits":[]}')).toEqual([]);
  });

  it("maps hits with gate/evidence/why", () => {
    expect(parseLeakHits('{"hits":[{"gate":"G2","evidence":"Juan Pérez","why":"nombre"}]}')).toEqual([
      { gate: "G2", evidence: "Juan Pérez", why: "nombre" },
    ]);
  });

  it("blocks on an unparseable verdict instead of passing", () => {
    const hits = parseLeakHits("el modelo se cayó");
    expect(hits.length).toBe(1);
    expect(hits[0]!.gate).toBe("G-LLM");
  });
});

describe("makeClaudeClassifier", () => {
  it("posts to Runware chat/completions with the Claude model + bearer key, returns raw guess", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(chatResponse('{"intent":"spending_insight","confidence":0.9,"slots":{"period":"este mes"}}'));
    const classify = makeClaudeClassifier({ ...OPTS, fetchImpl });

    const raw = await classify("¿en qué gasté este mes?");

    expect(raw).toEqual({ intent: "spending_insight", confidence: 0.9, slots: { period: "este mes" } });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.runware.ai/v1/chat/completions");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer k" });
    expect(JSON.parse((init as RequestInit).body as string).model).toBe("anthropic-claude-haiku-4-5");
  });

  it("throws on non-2xx so parseIntent fails closed to unknown", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(chatResponse("", false, 401));
    const classify = makeClaudeClassifier({ ...OPTS, fetchImpl });
    await expect(classify("hola")).rejects.toThrow();
  });
});

describe("makeClaudeLeakScan (fail-closed)", () => {
  const anon: AnonymizedSummary = {
    reviewPseudonym: "abc",
    categoryBreakdown: [{ category: "comida", pct: 100 }],
    trendsVsPrior: [],
    behaviorFlags: [],
    amountBuckets: [],
  };

  it("returns [] when the auditor finds nothing", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(chatResponse('{"hits":[]}'));
    const scan = makeClaudeLeakScan({ ...OPTS, fetchImpl });
    expect(await scan(anon)).toEqual([]);
  });

  it("returns a blocking hit when the call fails (never passes silently)", async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error("network down"));
    const scan = makeClaudeLeakScan({ ...OPTS, fetchImpl });
    const hits = await scan(anon);
    expect(hits.length).toBe(1);
    expect(hits[0]!.evidence).toBe("llm-scan-failed");
  });
});

describe("makeClaudeConversation (spec: conversation.spec.md)", () => {
  const summary: Summary = {
    identity: { name: "Mateo", cedula: "1140891234" },
    categoryTotals: [{ category: "comida", total: 60_000 }],
    trendsVsPrior: [],
    behaviorFlags: [],
    totalSpend: 100_000,
    monthlyIncome: 5_000_000,
    exactBalance: 42_000,
    rawTransactions: [{ id: "t1", merchant: "Super", amount: 60_000, currency: "COP", date: "2026-07-01", category: "comida" }],
  };

  it("chat() returns the model's small-talk text", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(chatResponse("¡Hola! Puedo mover tu plata 💸"));
    const conv = makeClaudeConversation({ ...OPTS, fetchImpl });
    expect(await conv.chat("hola")).toBe("¡Hola! Puedo mover tu plata 💸");
  });

  it("answerFromData() grounds on aggregates and OMITS identity + raw transactions (BR-CV2/BR-CV6)", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(chatResponse("Comida es tu mayor gasto."));
    const conv = makeClaudeConversation({ ...OPTS, fetchImpl });

    const answer = await conv.answerFromData("¿en qué gasté?", summary);

    expect(answer).toBe("Comida es tu mayor gasto.");
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    const userMsg = body.messages[1].content as string;
    expect(userMsg).toContain("comida");
    // The projection must not leak identity or raw transactions into the prompt.
    expect(userMsg).not.toContain("Mateo");
    expect(userMsg).not.toContain("1140891234");
    expect(userMsg).not.toContain("Super");
  });
});
