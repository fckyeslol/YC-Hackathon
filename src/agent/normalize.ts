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

  // Bare number fallback. Must handle BOTH conventions that share the "." char:
  //   - CO thousands: "1.500" -> 1500, "1.000.000" -> 1000000
  //   - decimals (USDC amounts like 0.01, 0.5, 1.50) -> kept as-is
  // A dot is a thousands separator ONLY when EVERY group after it is exactly 3
  // digits; otherwise it is a decimal point. Stripping every dot (the old bug)
  // turned "0.01" into 1 and would have sent 100× the intended USDC.
  const bare = t.match(/\d[\d.,]*/);
  if (bare) {
    const n = parseNumeric(bare[0]);
    if (!Number.isNaN(n)) return n;
  }
  return null;
}

/** Parse a bare number honoring CO thousands ("1.500") vs decimals ("0.01"). */
function parseNumeric(s: string): number {
  if (s.includes(",")) {
    // CO decimal comma: dots are thousands, comma is the decimal point.
    return parseFloat(s.replace(/\./g, "").replace(",", "."));
  }
  if (s.includes(".")) {
    const parts = s.split(".");
    const isThousands = parts.length > 1 && parts.slice(1).every((p) => p.length === 3);
    return isThousands ? Number(parts.join("")) : parseFloat(s);
  }
  return Number(s);
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
