import { describe, test, expect } from "vitest";
import { parseIntent, isDuplicate } from "./parseIntent.js";
import type { LlmClassifier, ParseDeps } from "./types.js";

/** Build deps whose LLM step returns a fixed raw guess. */
function deps(raw: unknown, extra: Partial<ParseDeps> = {}): ParseDeps {
  const classify: LlmClassifier = async () => raw;
  return { classify, ...extra };
}

describe("parseIntent (BR-P1/P2/P3/P4/P6/P8/P10)", () => {
  test("BR-P1 — invalid LLM output falls back to 'unknown', never an invalid action", async () => {
    const result = await parseIntent("???", deps({ garbage: true }));
    expect(result.intent).toBe("unknown");
    expect(result.type).toBeUndefined();
    expect(result.actionId).toBeUndefined();
  });

  test("BR-P10 — a thrown LLM never invents a money action", async () => {
    const classify: LlmClassifier = async () => {
      throw new Error("model down");
    };
    const result = await parseIntent("mándale 200 a ana", { classify });
    expect(result.intent).toBe("unknown");
    expect(result.actionId).toBeUndefined();
  });

  test("BR-P2 — missing recipient triggers a re-ask, not execution", async () => {
    const result = await parseIntent("manda 200", deps({ intent: "pay", confidence: 0.9, slots: { amount: 200 } }));
    expect(result.intent).toBe("pay");
    expect(result.missingSlots).toContain("recipient");
    expect(result.actionId).toBeUndefined(); // incomplete -> no executable id yet
  });

  test("BR-P3 — a recipient outside the allowlist is a novel counterparty", async () => {
    const raw = { intent: "pay", confidence: 0.9, slots: { amount: 20, recipient: "Pepe" } };
    const result = await parseIntent("mándale 20 USDC a Pepe", deps(raw, { allowlist: ["ana", "hermano"] }));
    expect(result.riskSignals.novelCounterparty).toBe(true);
  });

  test("BR-P3 — a known recipient is not novel", async () => {
    const raw = { intent: "pay", confidence: 0.9, slots: { amount: 20, recipient: "Ana" } };
    const result = await parseIntent("mándale 20 a Ana", deps(raw, { allowlist: ["ana"] }));
    expect(result.riskSignals.novelCounterparty).toBe(false);
  });

  test("BR-P4 — the parser only signals; it emits no auto/escalate decision", async () => {
    const raw = { intent: "pay", confidence: 0.9, slots: { amount: 9_000_000, recipient: "ana" } };
    const result = await parseIntent("págale 9 millones a ana", deps(raw, { allowlist: ["ana"] }));
    expect(result.riskSignals.amountBucket).toBe("muy_alto");
    expect(result).not.toHaveProperty("decision");
    expect(JSON.stringify(result)).not.toMatch(/escalate|auto/);
  });

  test("BR-P8 — colloquial amount in a slot is normalized", async () => {
    const raw = { intent: "pay", confidence: 0.9, slots: { amount: "50 lucas", recipient: "ana" } };
    const result = await parseIntent("mándale 50 lucas a ana", deps(raw, { allowlist: ["ana"] }));
    expect(result.params.amount).toBe(50_000);
  });

  test("BR-P6 — the same complete money action yields the same id and dedupes on resend", async () => {
    const raw = { intent: "pay", confidence: 0.95, slots: { amount: 200, recipient: "ana" } };
    const first = await parseIntent("mándale 200 a ana", deps(raw, { allowlist: ["ana"] }));
    const resend = await parseIntent("mándale 200 a ana", deps(raw, { allowlist: ["ana"] }));

    expect(first.actionId).toBeDefined();
    expect(resend.actionId).toBe(first.actionId);
    const seen = new Set([first.actionId!]);
    expect(isDuplicate(resend, seen)).toBe(true);
  });

  test("a query maps to a portfolio_query action type", async () => {
    const result = await parseIntent("¿en qué gasté este mes?", deps({
      intent: "spending_insight",
      confidence: 0.9,
      slots: { period: "este mes" },
    }));
    expect(result.type).toBe("portfolio_query");
    expect(result.params.period).toBe("this_month");
    expect(result.missingSlots).toEqual([]);
  });
});
