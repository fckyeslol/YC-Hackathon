import type { Category, Direction, LedgerTx } from "./types.js";

/**
 * Adapts raw spend rows (COP, free-text category) into normalized `LedgerTx`
 * (USDC, typed `Category`) that `buildDashboard` reads. Decoupled from the
 * anonymization/Dynamic types on purpose: the dashboard is the PERSONAL flow
 * (BR-D1) and must not import anonymization code.
 *
 * ⚠️ VERIFICAR: the demo source is the seed profile (COP amounts, hand-tagged
 * categories). Swap for the real transaction source before claiming the numbers
 * are the user's own. On-chain (Basescan) gives amounts/dates, not merchants or
 * categories — those still need a categorizer upstream.
 */

export interface RawSpend {
  readonly id: string;
  readonly amountCop: number;
  readonly date: string; // ISO or YYYY-MM-DD
  readonly category: string; // free text → mapped to Category, else "otros"
  readonly merchant?: string;
  readonly direction?: Direction; // default "expense"
  readonly txHash?: string;
}

/** Known upstream category strings → the dashboard taxonomy. Unknown → "otros". */
const CATEGORY_MAP: Record<string, Category> = {
  comida: "comida",
  mercado: "mercado",
  transporte: "transporte",
  servicios: "servicios",
  suscripciones: "suscripciones",
  compras: "compras",
  salud: "salud",
  entretenimiento: "entretenimiento",
  hogar: "hogar",
  vivienda: "hogar", // seed uses "vivienda"; the taxonomy calls it "hogar"
  educacion: "educacion",
  educación: "educacion",
  ingresos: "ingresos",
  transferencias: "transferencias",
  otros: "otros",
};

export function mapCategory(raw: string): Category {
  return CATEGORY_MAP[raw.trim().toLowerCase()] ?? "otros";
}

/** COP → USDC at an explicit rate (config, not a market oracle — BR-D10 mirror). */
export function toLedgerTxs(rows: readonly RawSpend[], copPerUsdc: number): LedgerTx[] {
  if (copPerUsdc <= 0) throw new Error("copPerUsdc must be positive");
  return rows.map((r) => {
    const at = r.date.length === 10 ? `${r.date}T00:00:00.000Z` : r.date;
    return {
      id: r.id,
      at,
      amountUsdc: Math.round((r.amountCop / copPerUsdc) * 100) / 100,
      direction: r.direction ?? "expense",
      category: mapCategory(r.category),
      ...(r.merchant ? { merchant: r.merchant } : {}),
      ...(r.txHash ? { txHash: r.txHash } : {}),
    };
  });
}
