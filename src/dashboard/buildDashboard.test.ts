import { describe, test, expect } from "vitest";
import { buildDashboard } from "./buildDashboard.js";
import type { Category, LedgerTx } from "./types.js";

const AT = "2026-07-24T00:00:00.000Z";

function tx(over: Partial<LedgerTx> & Pick<LedgerTx, "id" | "amountUsdc" | "direction" | "category">): LedgerTx {
  return { at: "2026-07-10T12:00:00.000Z", ...over };
}

describe("buildDashboard (spec: dashboard-visualization §4)", () => {
  test("BR-D3 — transfers do not inflate spend", () => {
    const data = buildDashboard(
      [
        tx({ id: "a", amountUsdc: 100, direction: "expense", category: "comida", merchant: "Rappi" }),
        tx({ id: "b", amountUsdc: 500, direction: "transfer", category: "transferencias", merchant: "Ahorro" }),
      ],
      "mes",
      { generatedAt: AT },
    );

    expect(data.kpis.spent).toBe(100);
    expect(data.spendByCategory.some((s) => s.category === "transferencias")).toBe(false);
    expect(data.topMerchants.some((m) => m.merchant === "Ahorro")).toBe(false);
  });

  test("BR-D5 — more than 8 categories fold into 'otros' (≤9 slices)", () => {
    const cats: Category[] = [
      "comida", "mercado", "transporte", "servicios", "suscripciones",
      "compras", "salud", "entretenimiento", "hogar", "educacion", "compras",
    ];
    // 11 expenses across 10 distinct categories with descending amounts.
    const txs = cats.map((c, i) =>
      tx({ id: `t${i}`, amountUsdc: 110 - i, direction: "expense", category: c, merchant: `m${i}` }),
    );

    const data = buildDashboard(txs, "mes", { generatedAt: AT });

    expect(data.spendByCategory.length).toBeLessThanOrEqual(9);
    const others = data.spendByCategory.find((s) => s.category === "otros");
    expect(others).toBeDefined();
    // BR-D4: named categories ranked descending; "otros" (the fold) pinned last
    // even if its aggregate exceeds an individual category (dataviz convention).
    expect(data.spendByCategory[data.spendByCategory.length - 1]!.category).toBe("otros");
    const named = data.spendByCategory.filter((s) => s.category !== "otros").map((s) => s.amount);
    expect([...named].sort((a, b) => b - a)).toEqual(named);
    // Total spend is preserved across the fold.
    const totalSlices = data.spendByCategory.reduce((s, c) => s + c.amount, 0);
    expect(totalSlices).toBeCloseTo(data.kpis.spent, 2);
  });

  test("pre-existing 'otros' merges with the folded tail, never duplicates", () => {
    const txs: LedgerTx[] = [
      tx({ id: "o", amountUsdc: 5, direction: "expense", category: "otros", merchant: "x" }),
      ...(["comida", "mercado", "transporte", "servicios", "suscripciones", "compras", "salud", "hogar", "educacion"] as Category[]).map(
        (c, i) => tx({ id: `n${i}`, amountUsdc: 100 - i, direction: "expense", category: c, merchant: `m${i}` }),
      ),
    ];
    const data = buildDashboard(txs, "mes", { generatedAt: AT });
    const others = data.spendByCategory.filter((s) => s.category === "otros");
    expect(others.length).toBe(1); // exactly one "otros"
  });

  test("top merchants keep 7 named + a folded 'Otros'", () => {
    const txs = Array.from({ length: 10 }, (_, i) =>
      tx({ id: `m${i}`, amountUsdc: 100 - i, direction: "expense", category: "compras", merchant: `Tienda${i}` }),
    );
    const data = buildDashboard(txs, "mes", { generatedAt: AT });
    expect(data.topMerchants.length).toBe(8); // 7 + Other
    expect(data.topMerchants[data.topMerchants.length - 1]!.merchant).toBe("Other");
  });

  test("KPIs: net, txCount (transfers excluded), subscriptions", () => {
    const data = buildDashboard(
      [
        tx({ id: "i", amountUsdc: 1000, direction: "income", category: "ingresos" }),
        tx({ id: "e1", amountUsdc: 100, direction: "expense", category: "comida", merchant: "Rappi" }),
        tx({ id: "s1", amountUsdc: 15, direction: "expense", category: "suscripciones", merchant: "Netflix" }),
        tx({ id: "s2", amountUsdc: 12, direction: "expense", category: "suscripciones", merchant: "Spotify" }),
        tx({ id: "t", amountUsdc: 300, direction: "transfer", category: "transferencias" }),
      ],
      "mes",
      { generatedAt: AT },
    );

    expect(data.kpis.spent).toBe(127);
    expect(data.kpis.net).toBe(873); // 1000 − 127
    expect(data.kpis.txCount).toBe(4); // transfer excluded
    expect(data.kpis.activeSubscriptions).toEqual({ count: 2, monthlyUsdc: 27 });
  });

  test("spentDeltaPct uses the prior base when provided, else null", () => {
    const txs = [tx({ id: "e", amountUsdc: 120, direction: "expense", category: "comida" })];
    expect(buildDashboard(txs, "mes", { generatedAt: AT }).kpis.spentDeltaPct).toBeNull();
    expect(buildDashboard(txs, "mes", { generatedAt: AT, priorSpent: 100 }).kpis.spentDeltaPct).toBe(20);
  });

  test("monthly trend buckets by calendar month, chronological, one scale", () => {
    const data = buildDashboard(
      [
        tx({ id: "a", at: "2026-05-03T00:00:00Z", amountUsdc: 50, direction: "expense", category: "comida" }),
        tx({ id: "b", at: "2026-06-03T00:00:00Z", amountUsdc: 70, direction: "expense", category: "comida" }),
        tx({ id: "c", at: "2026-06-10T00:00:00Z", amountUsdc: 900, direction: "income", category: "ingresos" }),
      ],
      "3meses",
      { generatedAt: AT },
    );
    expect(data.monthlyTrend.map((p) => p.period)).toEqual(["2026-05", "2026-06"]);
    expect(data.monthlyTrend[1]).toEqual({ period: "2026-06", expense: 70, income: 900 });
  });
});
