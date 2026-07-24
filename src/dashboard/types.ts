/**
 * Dashboard domain types (spec: dashboard-visualization §1).
 *
 * This is the PERSONAL view — the user's own data, full detail (BR-D1). It is the
 * OPPOSITE of the anonymization pipeline: nothing here is redacted, and no code
 * from `anonymization/` is reused. Do not confuse the two flows.
 */

export type Direction = "expense" | "income" | "transfer";
export type Range = "mes" | "3meses" | "12meses";

/** Fixed order — defines the categorical color order downstream (BR-D6). */
export type Category =
  | "comida"
  | "mercado"
  | "transporte"
  | "servicios"
  | "suscripciones"
  | "compras"
  | "salud"
  | "entretenimiento"
  | "hogar"
  | "educacion"
  | "ingresos"
  | "transferencias"
  | "otros";

/** One normalized on-chain movement the dashboard READS (never computes). */
export interface LedgerTx {
  readonly id: string;
  readonly at: string; // ISO 8601
  readonly amountUsdc: number; // positive magnitude; sign comes from `direction`
  readonly direction: Direction;
  readonly category: Category;
  readonly merchant?: string;
  readonly account?: string;
  readonly txHash?: string;
}

export interface Kpis {
  readonly spent: number;
  readonly spentDeltaPct: number | null;
  readonly net: number; // income − spent (signed)
  readonly txCount: number;
  readonly activeSubscriptions: { readonly count: number; readonly monthlyUsdc: number };
}

export interface CategorySlice {
  readonly category: Category;
  readonly amount: number;
  readonly pct: number; // 0..100 over total spend
}

export interface TrendPoint {
  readonly period: string; // "2026-05"
  readonly expense: number;
  readonly income: number;
}

export interface MerchantSlice {
  readonly merchant: string; // "Otros" folds the tail
  readonly amount: number;
}

export interface DayCell {
  readonly date: string; // "2026-05-14"
  readonly amount: number;
}

export interface DashboardData {
  readonly range: Range;
  readonly generatedAt: string; // ISO
  readonly currency: "USDC";
  readonly kpis: Kpis;
  readonly spendByCategory: readonly CategorySlice[]; // Panel 1
  readonly monthlyTrend: readonly TrendPoint[]; // Panel 2
  readonly topMerchants: readonly MerchantSlice[]; // Panel 3
  readonly dailyRhythm?: readonly DayCell[]; // Panel 4 (optional)
}

/** Max named categories before the tail folds into "otros" (BR-D5). */
export const MAX_VISIBLE_CATEGORIES = 8;
/** Max named merchants before the tail folds into "Otros" (spec §3, Panel 3). */
export const MAX_VISIBLE_MERCHANTS = 7;
