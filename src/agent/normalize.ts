/**
 * Colloquial Colombian normalization (BR-P8).
 * Turns spoken money slang and relative dates into canonical values, so the
 * rest of the pipeline never reasons over "50 lucas" or "este mes".
 */

export type Period = "this_month" | "last_month" | "this_week" | "last_week";

const UNIT_MULTIPLIER: Record<string, number> = {
  luca: 1_000,
  lucas: 1_000,
  mil: 1_000,
  palo: 1_000_000,
  palos: 1_000_000,
  millon: 1_000_000,
  millón: 1_000_000,
  millones: 1_000_000,
};

const WORD_QTY: Record<string, number> = { medio: 0.5, media: 0.5, un: 1, una: 1, uno: 1 };

/**
 * Parse a colloquial amount to a canonical number, or null if none found.
 *   "50 lucas" -> 50000 · "medio palo" -> 500000 · "2 millones" -> 2000000 · "200" -> 200
 */
export function normalizeAmount(text: string): number | null {
  const t = text.toLowerCase().trim();

  // <qty?> <unit> — e.g. "50 lucas", "medio palo", "un millón".
  const withUnit = t.match(/(\d+(?:[.,]\d+)?|medio|media|un|una|uno)?\s*(lucas?|palos?|mill[oó]n|millones|mil)\b/);
  if (withUnit) {
    const rawQty = withUnit[1];
    const unit = withUnit[2]!;
    const qty = rawQty === undefined ? 1 : (WORD_QTY[rawQty] ?? parseFloat(rawQty.replace(",", ".")));
    const mult = UNIT_MULTIPLIER[unit] ?? 1;
    if (!Number.isNaN(qty)) return Math.round(qty * mult);
  }

  // Bare number fallback — "200", "1.500" (CO thousands separator), "1,50".
  const bare = t.match(/\d[\d.]*/);
  if (bare) {
    const n = Number(bare[0].replace(/\./g, ""));
    if (!Number.isNaN(n)) return n;
  }
  return null;
}

/** Parse a relative period (ES + EN), or null. */
export function normalizePeriod(text: string): Period | null {
  const t = text.toLowerCase();
  if (/mes pasad|mes anterior|último mes|ultimo mes|last month|previous month/.test(t)) return "last_month";
  if (/este mes|del mes|mensual|this month|monthly/.test(t)) return "this_month";
  if (/semana pasad|última semana|ultima semana|last week/.test(t)) return "last_week";
  if (/esta semana|semanal|this week|weekly/.test(t)) return "this_week";
  return null;
}
