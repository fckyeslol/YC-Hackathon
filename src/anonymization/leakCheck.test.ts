import { describe, test, expect } from "vitest";
import { leakCheck } from "./leakCheck.js";
import type { AnonymizedSummary } from "./types.js";

/** A clean, well-formed anonymized summary — must pass. */
const CLEAN: AnonymizedSummary = {
  reviewPseudonym: "Revisor-anonimo-4f2a",
  categoryBreakdown: [
    { category: "comida", pct: 42 },
    { category: "transporte", pct: 18 },
    { category: "reservado", pct: 10 },
    { category: "otros", pct: 30 },
  ],
  trendsVsPrior: [{ category: "suscripciones", deltaPct: 20 }],
  behaviorFlags: ["3 suscripciones sin uso en 60 días"],
  amountBuckets: [{ label: "gasto mensual", bucket: "medio" }],
};

describe("leakCheck (BR-A5, fail-closed)", () => {
  test("a clean summary passes", () => {
    const result = leakCheck(CLEAN);
    expect(result.ok).toBe(true);
    expect(result.hits).toHaveLength(0);
  });

  test("BR-A5 — a leaked counterparty + raw amount blocks", () => {
    // Arrange: the canonical leak from the spec sneaks into a flag.
    const dirty: AnonymizedSummary = {
      ...CLEAN,
      behaviorFlags: [...CLEAN.behaviorFlags, "pago a Juan Pérez $340.000 el 3/6"],
    };

    // Act
    const result = leakCheck(dirty);

    // Assert
    expect(result.ok).toBe(false);
    expect(result.hits.length).toBeGreaterThan(0);
  });

  test("blocks a leaked email", () => {
    const dirty = { ...CLEAN, behaviorFlags: ["contacto: mateo@correo.com"] };
    expect(leakCheck(dirty).ok).toBe(false);
  });

  test("blocks a leaked cédula / long id", () => {
    const dirty = { ...CLEAN, behaviorFlags: ["cédula 1140891234"] };
    expect(leakCheck(dirty).ok).toBe(false);
  });

  test("blocks a raw currency amount even without a name", () => {
    const dirty = { ...CLEAN, behaviorFlags: ["saldo COP 1.234.567"] };
    expect(leakCheck(dirty).ok).toBe(false);
  });

  test("A2 — blocks a bare 4+ digit figure with no currency ('gastó 45000')", () => {
    const dirty = { ...CLEAN, behaviorFlags: ["gastó 45000 este mes"] };
    expect(leakCheck(dirty).ok).toBe(false);
  });

  test("an injected extra scanner (LLM layer) can only add blocks, never clear them", () => {
    // Fail-closed: the extra layer runs on top; if it finds something, block.
    const result = leakCheck(CLEAN, {
      extraScan: () => [{ gate: "G5", evidence: "huella única inferida", why: "reidentificable" }],
    });
    expect(result.ok).toBe(false);
    expect(result.hits.some((h) => h.gate === "G5")).toBe(true);
  });
});
