import { describe, test, expect } from "vitest";
import { toLedgerTxs, mapCategory, type RawSpend } from "./ledgerAdapter.js";

describe("ledgerAdapter (raw spend → LedgerTx)", () => {
  test("maps known categories and folds unknown to 'otros'", () => {
    expect(mapCategory("Comida")).toBe("comida");
    expect(mapCategory("vivienda")).toBe("hogar"); // seed vocabulary
    expect(mapCategory("educación")).toBe("educacion");
    expect(mapCategory("cripto-random")).toBe("otros");
  });

  test("converts COP → USDC at the explicit rate and defaults direction to expense", () => {
    const rows: RawSpend[] = [
      { id: "s1", amountCop: 180_000, date: "2026-07-05", category: "comida", merchant: "Rappi" },
      { id: "s2", amountCop: 4_000_000, date: "2026-07-01T09:00:00.000Z", category: "ingresos", direction: "income" },
    ];
    const [rappi, income] = toLedgerTxs(rows, 4000);
    expect(rappi).toEqual({ id: "s1", at: "2026-07-05T00:00:00.000Z", amountUsdc: 45, direction: "expense", category: "comida", merchant: "Rappi" });
    expect(income!.amountUsdc).toBe(1000);
    expect(income!.direction).toBe("income");
  });

  test("rejects a non-positive rate", () => {
    expect(() => toLedgerTxs([], 0)).toThrow();
  });
});
