import { describe, it, expect } from "vitest";
import { fillPending, isFreshCommand, SlotFillStore } from "./slotFill.js";
import { buildAction } from "./parseIntent.js";
import type { Action } from "./types.js";

/** A cold, contentless parse of a bare follow-up like "200usd" or "this month". */
function coldUnknown(rawText: string): Action {
  return buildAction("unknown", {}, 0, rawText);
}

describe("isFreshCommand", () => {
  it("treats an unknown/bare follow-up as a slot value, not a new command", () => {
    expect(isFreshCommand("unknown", "pay")).toBe(false);
    expect(isFreshCommand("smalltalk", "pay")).toBe(false);
  });
  it("treats a different actionable intent as a new command", () => {
    expect(isFreshCommand("dashboard", "pay")).toBe(true);
    expect(isFreshCommand("balance", "spending_insight")).toBe(true);
  });
  it("does not switch when the follow-up repeats the same intent", () => {
    expect(isFreshCommand("pay", "pay")).toBe(false);
  });
});

describe("fillPending", () => {
  it("recovers a bare amount and completes the pay action (the reported bug)", () => {
    const pending = buildAction("pay", { recipient: "dad" }, 0.9, "pay my dad"); // missing amount
    expect(pending.missingSlots).toEqual(["amount"]);

    const merged = fillPending(pending, coldUnknown("200usd"), "200usd");
    expect(merged.intent).toBe("pay");
    expect(merged.params.amount).toBe(200);
    expect(merged.params.recipient).toBe("dad");
    expect(merged.missingSlots).toEqual([]);
    // A complete money action gets an idempotency id.
    expect(merged.actionId).toBeDefined();
  });

  it("recomputes the risk bucket from the FILLED amount, not the empty first turn", () => {
    const pending = buildAction("pay", { recipient: "dad" }, 0.9, "pay my dad");
    expect(pending.riskSignals.amountBucket).toBe("bajo"); // amount 0 on turn one
    const merged = fillPending(pending, coldUnknown("5000000"), "5000000");
    expect(merged.params.amount).toBe(5_000_000);
    expect(merged.riskSignals.amountBucket).toBe("muy_alto"); // a big fill escalates
  });

  it("recovers a relative period for a spending query", () => {
    const pending = buildAction("spending_insight", {}, 0.8, "how much did I spend"); // missing period
    const merged = fillPending(pending, coldUnknown("this month"), "this month");
    expect(merged.params.period).toBe("this_month");
    expect(merged.missingSlots).toEqual([]);
  });

  it("does not turn a bare number into a recipient when both slots are missing", () => {
    const pending = buildAction("pay", {}, 0.5, "send money"); // missing amount AND recipient
    const merged = fillPending(pending, coldUnknown("200"), "200");
    expect(merged.params.amount).toBe(200);
    expect(merged.params.recipient).toBeUndefined();
    expect(merged.missingSlots).toEqual(["recipient"]); // still needs who
  });

  it("uses a slot the follow-up parse did extract", () => {
    const pending = buildAction("pay", { amount: 50 }, 0.7, "send 50"); // missing recipient
    const probe = buildAction("pay", { recipient: "Ana" }, 0.9, "to Ana");
    const merged = fillPending(pending, probe, "to Ana");
    expect(merged.params.recipient).toBe("Ana");
    expect(merged.missingSlots).toEqual([]);
  });
});

describe("SlotFillStore", () => {
  it("stages, peeks, and clears; expires past its TTL", () => {
    let t = 1000;
    const store = new SlotFillStore({ ttlMs: 100, now: () => t });
    const action = buildAction("pay", { recipient: "dad" }, 0.9, "pay my dad");

    store.stage("chatA", action);
    expect(store.has("chatA")).toBe(true);
    expect(store.peek("chatA")?.params.recipient).toBe("dad");

    t += 101; // lapse
    expect(store.has("chatA")).toBe(false);
    expect(store.peek("chatA")).toBeUndefined();
  });
});
