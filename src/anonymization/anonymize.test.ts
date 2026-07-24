import { describe, test, expect } from "vitest";
import { computeSummary, anonymize } from "./anonymize.js";
import { SENSITIVE_GROUP } from "./types.js";
import type { FinancialProfile, RawTransaction, Category } from "./types.js";

/** Build N raw transactions spread across the given categories. */
function makeTx(n: number, categories: readonly Category[]): RawTransaction[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `tx${i}`,
    merchant: i % 2 === 0 ? "Juan Pérez" : "Supermercado XYZ",
    amount: 10_000 + i * 1_000,
    currency: "COP",
    date: `2026-07-${String((i % 27) + 1).padStart(2, "0")}`,
    category: categories[i % categories.length]!,
  }));
}

const PROFILE: FinancialProfile = {
  identity: { name: "Mateo", cedula: "1140891234", phone: "+573001234567", email: "mateo@correo.com" },
  transactions: makeTx(40, ["comida", "transporte", "suscripciones", "salud"]),
  monthlyIncome: 5_000_000,
  exactBalance: 1_234_567,
  priorPeriodTotals: { suscripciones: 50_000 },
};

describe("anonymize (BR-A1/A2/A3)", () => {
  test("BR-A1 — strips every direct identifier and raw transaction", () => {
    // Arrange
    const summary = computeSummary(PROFILE);

    // Act
    const anon = anonymize(summary);
    const serialized = JSON.stringify(anon);

    // Assert: no name, cédula, phone, email, merchant, exact balance leak through.
    expect(serialized).not.toContain("Mateo");
    expect(serialized).not.toContain("1140891234");
    expect(serialized).not.toContain("573001234567");
    expect(serialized).not.toContain("mateo@correo.com");
    expect(serialized).not.toContain("Juan Pérez");
    expect(serialized).not.toContain("1234567"); // exact balance
    expect(serialized).not.toContain("tx0"); // no raw transaction ids
  });

  test("BR-A2 — exposes only percentages, trends, flags and buckets", () => {
    const anon = anonymize(computeSummary(PROFILE));

    expect(Object.keys(anon).sort()).toEqual(
      ["amountBuckets", "behaviorFlags", "categoryBreakdown", "reviewPseudonym", "trendsVsPrior"].sort(),
    );
    const totalPct = anon.categoryBreakdown.reduce((s, c) => s + c.pct, 0);
    expect(totalPct).toBeGreaterThan(99);
    expect(totalPct).toBeLessThan(101);
    expect(anon.amountBuckets.length).toBeGreaterThan(0);
  });

  test("BR-A3 — sensitive categories are collapsed, never detailed", () => {
    const anon = anonymize(computeSummary(PROFILE));
    const labels = anon.categoryBreakdown.map((c) => c.category);

    // "salud" was in the input but must not appear by name.
    expect(labels).not.toContain("salud");
    expect(labels).toContain(SENSITIVE_GROUP);
    expect(anon.trendsVsPrior.map((t) => t.category)).not.toContain("salud");
  });

  test("computeSummary keeps PII internally (so anonymize has something to strip)", () => {
    const summary = computeSummary(PROFILE);
    expect(summary.identity.name).toBe("Mateo");
    expect(summary.rawTransactions).toHaveLength(40);
    // A behavior flag is derived (pattern-level, no PII).
    expect(summary.behaviorFlags.length).toBeGreaterThan(0);
  });
});
