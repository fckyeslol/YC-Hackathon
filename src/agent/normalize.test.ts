import { describe, test, expect } from "vitest";
import { normalizeAmount, normalizePeriod } from "./normalize.js";

describe("normalizeAmount (BR-P8)", () => {
  test("'50 lucas' -> 50000", () => expect(normalizeAmount("50 lucas")).toBe(50_000));
  test("'medio palo' -> 500000", () => expect(normalizeAmount("medio palo")).toBe(500_000));
  test("'un millón' -> 1000000", () => expect(normalizeAmount("un millón")).toBe(1_000_000));
  test("'2 millones' -> 2000000", () => expect(normalizeAmount("2 millones")).toBe(2_000_000));
  test("'50 mil' -> 50000", () => expect(normalizeAmount("50 mil")).toBe(50_000));
  test("bare number '200' -> 200", () => expect(normalizeAmount("200")).toBe(200));
  test("CO thousands separator '1.500' -> 1500", () => expect(normalizeAmount("1.500")).toBe(1_500));
  test("no amount -> null", () => expect(normalizeAmount("hola qué tal")).toBeNull());
});

describe("normalizePeriod (BR-P8)", () => {
  test("'este mes' -> this_month", () => expect(normalizePeriod("¿en qué gasté este mes?")).toBe("this_month"));
  test("'el mes pasado' -> last_month", () => expect(normalizePeriod("gastos del mes pasado")).toBe("last_month"));
  test("'esta semana' -> this_week", () => expect(normalizePeriod("esta semana")).toBe("this_week"));
  test("no period -> null", () => expect(normalizePeriod("mándale plata a ana")).toBeNull());
});
