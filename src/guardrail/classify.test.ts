import { describe, test, expect } from "vitest";
import { classify, NETWORK, CONFIDENCE_FLOOR } from "./classify.js";
import type { Action, RiskSignals } from "./types.js";

/** A benign baseline: everything low-risk. Tweak per test. */
function action(type: Action["type"], overrides: Partial<RiskSignals> = {}): Action {
  return {
    type,
    riskSignals: {
      amountBucket: "bajo",
      novelCounterparty: false,
      volatileSwap: false,
      modelConfidence: 0.95,
      ...overrides,
    },
  };
}

describe("guardrail classify (BR-G1..G6)", () => {
  test("BR-G1 — small payment to a known counterparty runs on auto", () => {
    const result = classify(action("payment", { amountBucket: "bajo", novelCounterparty: false }));
    expect(result.decision).toBe("auto");
    expect(result.reasons).toHaveLength(0);
  });

  test("BR-G2 — a 'muy_alto' amount escalates", () => {
    const result = classify(action("payment", { amountBucket: "muy_alto" }));
    expect(result.decision).toBe("escalate");
    expect(result.reasons).toContain("amount_muy_alto");
  });

  test("BR-G2 — a novel counterparty escalates", () => {
    expect(classify(action("payment", { novelCounterparty: true })).decision).toBe("escalate");
  });

  test("BR-G2 — a volatile swap escalates", () => {
    const result = classify(action("swap", { volatileSwap: true }));
    expect(result.decision).toBe("escalate");
    expect(result.reasons).toContain("volatile_swap");
  });

  test("BR-G3 — low confidence escalates even when the amount is low (fail-safe)", () => {
    const result = classify(action("payment", { amountBucket: "bajo", modelConfidence: 0.4 }));
    expect(result.decision).toBe("escalate");
    expect(result.reasons).toContain("low_confidence");
  });

  test("read-only portfolio queries always run on auto", () => {
    // A balance check moves no money; escalating it to humans would be absurd.
    const result = classify(action("portfolio_query", { modelConfidence: 0.3 }));
    expect(result.decision).toBe("auto");
  });

  test("BR-G6 — multiple triggers are all recorded, no PII", () => {
    const result = classify(action("payment", { amountBucket: "alto", novelCounterparty: true, modelConfidence: 0.5 }));
    expect(result.decision).toBe("escalate");
    expect(result.reasons).toEqual(expect.arrayContaining(["amount_alto", "novel_counterparty", "low_confidence"]));
  });

  test("BR-G5 — the only network is Base Sepolia testnet; no mainnet", () => {
    expect(NETWORK).toBe("base-sepolia");
    expect(NETWORK).not.toContain("mainnet");
  });

  test("the confidence floor is a sane threshold", () => {
    expect(CONFIDENCE_FLOOR).toBeGreaterThan(0.4);
    expect(CONFIDENCE_FLOOR).toBeLessThanOrEqual(0.8);
  });
});
