import { describe, test, expect } from "vitest";
import { missingSlots } from "./slots.js";

describe("missingSlots (BR-P2)", () => {
  test("pay without recipient reports 'recipient' missing", () => {
    expect(missingSlots("pay", { amount: 200 })).toEqual(["recipient"]);
  });

  test("pay with amount and recipient is complete", () => {
    expect(missingSlots("pay", { amount: 200, recipient: "ana" })).toEqual([]);
  });

  test("empty-string slots count as missing", () => {
    expect(missingSlots("pay", { amount: 200, recipient: "   " })).toEqual(["recipient"]);
  });

  test("swap needs from/to/amount", () => {
    expect(missingSlots("swap", { fromAsset: "USDC" }).sort()).toEqual(["amount", "toAsset"]);
  });

  test("queries with no required slots are always complete", () => {
    expect(missingSlots("balance", {})).toEqual([]);
  });
});
