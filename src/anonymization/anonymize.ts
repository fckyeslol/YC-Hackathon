import {
  SENSITIVE_CATEGORIES,
  SENSITIVE_GROUP,
  type AmountBucket,
  type AnonymizedSummary,
  type Category,
  type FinancialProfile,
  type Summary,
} from "./types.js";
import { newReviewId, pseudonymFor } from "./pseudonym.js";

const SUBSCRIPTION_SHARE_FLAG = 0.15;
const CONCENTRATION_SHARE_FLAG = 0.4;
const LOW_LIQUIDITY_MONTHS = 0.5; // balance < half a month of income
const TREND_SPIKE_PCT = 20;

/**
 * computeSummary — aggregate the raw profile into an intermediate Summary.
 * STILL carries PII (identity + raw transactions); it is internal only. The
 * whole reason it holds PII is so `anonymize` has something concrete to strip.
 */
export function computeSummary(profile: FinancialProfile): Summary {
  const totals = new Map<Category, number>();
  for (const tx of profile.transactions) {
    totals.set(tx.category, (totals.get(tx.category) ?? 0) + tx.amount);
  }
  const categoryTotals = [...totals.entries()].map(([category, total]) => ({ category, total }));
  const totalSpend = categoryTotals.reduce((s, c) => s + c.total, 0);

  const trendsVsPrior = categoryTotals
    .filter((c) => profile.priorPeriodTotals?.[c.category] !== undefined)
    .map((c) => {
      const prior = profile.priorPeriodTotals![c.category]!;
      const deltaPct = prior === 0 ? 100 : Math.round(((c.total - prior) / prior) * 100);
      return { category: c.category, deltaPct };
    });

  const behaviorFlags = deriveFlags(profile, categoryTotals, totalSpend, trendsVsPrior);

  return {
    identity: profile.identity,
    categoryTotals,
    trendsVsPrior,
    behaviorFlags,
    totalSpend,
    monthlyIncome: profile.monthlyIncome,
    exactBalance: profile.exactBalance,
    rawTransactions: profile.transactions,
  };
}

/**
 * anonymize — the only function allowed to produce reviewer-facing data.
 * It COPIES nothing sensitive: identity, raw transactions, counterparties and
 * exact balance are simply absent from the output shape (BR-A1/A2). Sensitive
 * categories are collapsed into one opaque group (BR-A3).
 *
 * The review pseudonym is minted from a FRESH internal review id (BR-A4): callers
 * cannot inject a stable/derivable id, so two reviews of the same user can never
 * be linked. Each call is a distinct, non-linkable review.
 */
export function anonymize(summary: Summary): AnonymizedSummary {
  const income = summary.monthlyIncome;

  // Collapse sensitive categories into a single opaque group.
  const collapsed = new Map<string, number>();
  for (const { category, total } of summary.categoryTotals) {
    const key = SENSITIVE_CATEGORIES.includes(category) ? SENSITIVE_GROUP : category;
    collapsed.set(key, (collapsed.get(key) ?? 0) + total);
  }

  const categoryBreakdown = [...collapsed.entries()].map(([category, total]) => ({
    category,
    pct: summary.totalSpend === 0 ? 0 : round1((total / summary.totalSpend) * 100),
  }));

  // Trends exclude sensitive categories entirely — never even a delta.
  const trendsVsPrior = summary.trendsVsPrior
    .filter((t) => !SENSITIVE_CATEGORIES.includes(t.category))
    .map((t) => ({ category: t.category as string, deltaPct: t.deltaPct }));

  const topCategory = [...summary.categoryTotals].sort((a, b) => b.total - a.total)[0];
  const amountBuckets: { label: string; bucket: AmountBucket }[] = [
    { label: "gasto mensual", bucket: bucketByIncomeShare(summary.totalSpend, income) },
  ];
  if (topCategory) {
    amountBuckets.push({ label: "mayor categoría", bucket: bucketByIncomeShare(topCategory.total, income) });
  }

  return {
    reviewPseudonym: pseudonymFor(newReviewId()),
    categoryBreakdown,
    trendsVsPrior,
    behaviorFlags: [...summary.behaviorFlags], // pattern-level, no PII
    amountBuckets,
  };
}

// --- helpers ---

function deriveFlags(
  profile: FinancialProfile,
  categoryTotals: readonly { category: Category; total: number }[],
  totalSpend: number,
  trends: readonly { category: Category; deltaPct: number }[],
): string[] {
  const flags: string[] = [];
  if (totalSpend > 0) {
    const subs = categoryTotals.find((c) => c.category === "suscripciones");
    if (subs && subs.total / totalSpend >= SUBSCRIPTION_SHARE_FLAG) {
      flags.push("las suscripciones son una parte notable del gasto mensual");
    }
    if (categoryTotals.some((c) => c.total / totalSpend >= CONCENTRATION_SHARE_FLAG)) {
      flags.push("el gasto está concentrado en una sola categoría");
    }
  }
  if (profile.monthlyIncome > 0 && profile.exactBalance < profile.monthlyIncome * LOW_LIQUIDITY_MONTHS) {
    flags.push("el colchón de liquidez es bajo frente al ingreso mensual");
  }
  if (trends.some((t) => t.deltaPct >= TREND_SPIKE_PCT)) {
    flags.push("una categoría de gasto creció fuerte frente al período anterior");
  }
  return flags;
}

function bucketByIncomeShare(amount: number, income: number): AmountBucket {
  if (income <= 0) return "muy_alto";
  const ratio = amount / income;
  if (ratio < 0.25) return "bajo";
  if (ratio < 0.5) return "medio";
  if (ratio < 1) return "alto";
  return "muy_alto";
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
