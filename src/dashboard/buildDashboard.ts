import {
  MAX_VISIBLE_CATEGORIES,
  MAX_VISIBLE_MERCHANTS,
  type Category,
  type CategorySlice,
  type DashboardData,
  type Kpis,
  type LedgerTx,
  type MerchantSlice,
  type Range,
  type TrendPoint,
} from "./types.js";

/**
 * buildDashboard — the pure data transform behind the personal spending page
 * (spec: dashboard-visualization §1.2). No I/O, no rendering: it takes the
 * ledger movements for a period and pre-computes exactly what each chart paints.
 *
 * Key rules enforced here:
 *  - BR-D3: transfers are excluded from spend (KPIs, categories, merchants).
 *  - BR-D5: at most 8 named categories; the tail folds into "otros" (≤9 slices).
 *  - Panel 3: at most 7 named merchants; the tail folds into "Otros".
 *  - BR-D4: category/merchant slices are ranked (desc by amount).
 * Color (BR-D6) and the single Y axis (BR-D7) are RENDER concerns, not here.
 */

export interface BuildDashboardOptions {
  /** Spend of the prior comparable period, for the KPI delta. Null → no base. */
  readonly priorSpent?: number;
  /** Injected clock for deterministic output (the runtime forbids Date.now in some contexts). */
  readonly generatedAt: string;
}

const SUBSCRIPTIONS: Category = "suscripciones";
const OTHERS_CATEGORY: Category = "otros";
const OTHERS_MERCHANT = "Other";

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function buildDashboard(
  txs: readonly LedgerTx[],
  range: Range,
  opts: BuildDashboardOptions,
): DashboardData {
  // BR-D3: transfers never count as spend. Expenses drive every spend panel.
  const expenses = txs.filter((t) => t.direction === "expense");
  const incomes = txs.filter((t) => t.direction === "income");

  const spent = round2(sum(expenses.map((t) => t.amountUsdc)));
  const income = round2(sum(incomes.map((t) => t.amountUsdc)));

  const kpis: Kpis = {
    spent,
    spentDeltaPct: deltaPct(spent, opts.priorSpent),
    net: round2(income - spent),
    // "# transactions" excludes internal transfers (they are not user activity).
    txCount: txs.filter((t) => t.direction !== "transfer").length,
    activeSubscriptions: subscriptionSummary(expenses),
  };

  return {
    range,
    generatedAt: opts.generatedAt,
    currency: "USDC",
    kpis,
    spendByCategory: spendByCategory(expenses, spent),
    monthlyTrend: monthlyTrend(expenses, incomes),
    topMerchants: topMerchants(expenses),
  };
}

// --- helpers ---

function sum(ns: readonly number[]): number {
  return ns.reduce((a, b) => a + b, 0);
}

function deltaPct(spent: number, prior?: number): number | null {
  if (prior === undefined) return null;
  if (prior === 0) return spent === 0 ? 0 : 100;
  return Math.round(((spent - prior) / prior) * 100);
}

function subscriptionSummary(expenses: readonly LedgerTx[]): Kpis["activeSubscriptions"] {
  const subs = expenses.filter((t) => t.category === SUBSCRIPTIONS);
  const distinct = new Set(subs.map((t) => t.merchant ?? t.id));
  return { count: distinct.size, monthlyUsdc: round2(sum(subs.map((t) => t.amountUsdc))) };
}

/**
 * Rank expenses by category, keep the top 8, fold the rest (plus any pre-existing
 * "otros") into a single "otros" slice (BR-D4/BR-D5 → ≤9 slices). pct is over the
 * period's total spend.
 */
function spendByCategory(expenses: readonly LedgerTx[], totalSpend: number): CategorySlice[] {
  const totals = new Map<Category, number>();
  for (const t of expenses) totals.set(t.category, (totals.get(t.category) ?? 0) + t.amountUsdc);

  // Separate the fold bucket so it never double-counts.
  const preFolded = totals.get(OTHERS_CATEGORY) ?? 0;
  totals.delete(OTHERS_CATEGORY);

  const named = [...totals.entries()]
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);

  const visible = named.slice(0, MAX_VISIBLE_CATEGORIES);
  const tail = named.slice(MAX_VISIBLE_CATEGORIES);
  const othersAmount = preFolded + sum(tail.map((e) => e.amount));

  const slices = visible.map((e) => e);
  if (othersAmount > 0) slices.push({ category: OTHERS_CATEGORY, amount: othersAmount });

  return slices.map((s) => ({
    category: s.category,
    amount: round2(s.amount),
    pct: totalSpend > 0 ? Math.round((s.amount / totalSpend) * 100) : 0,
  }));
}

/** Top 7 merchants by spend + a folded "Otros" (spec §3, Panel 3). */
function topMerchants(expenses: readonly LedgerTx[]): MerchantSlice[] {
  const totals = new Map<string, number>();
  for (const t of expenses) {
    const key = t.merchant ?? OTHERS_MERCHANT;
    totals.set(key, (totals.get(key) ?? 0) + t.amountUsdc);
  }

  const ranked = [...totals.entries()]
    .map(([merchant, amount]) => ({ merchant, amount }))
    .sort((a, b) => b.amount - a.amount);

  const visible = ranked.slice(0, MAX_VISIBLE_MERCHANTS);
  const tail = ranked.slice(MAX_VISIBLE_MERCHANTS);
  const othersAmount = sum(tail.map((e) => e.amount));

  const slices = visible.map((e) => ({ merchant: e.merchant, amount: round2(e.amount) }));
  if (othersAmount > 0) slices.push({ merchant: OTHERS_MERCHANT, amount: round2(othersAmount) });
  return slices;
}

/** Expense vs income bucketed by calendar month, chronological (BR-D7: one axis). */
function monthlyTrend(expenses: readonly LedgerTx[], incomes: readonly LedgerTx[]): TrendPoint[] {
  const byPeriod = new Map<string, { expense: number; income: number }>();
  const bump = (t: LedgerTx, key: "expense" | "income"): void => {
    const period = t.at.slice(0, 7); // "YYYY-MM"
    const cur = byPeriod.get(period) ?? { expense: 0, income: 0 };
    cur[key] += t.amountUsdc;
    byPeriod.set(period, cur);
  };
  for (const t of expenses) bump(t, "expense");
  for (const t of incomes) bump(t, "income");

  return [...byPeriod.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, v]) => ({ period, expense: round2(v.expense), income: round2(v.income) }));
}
