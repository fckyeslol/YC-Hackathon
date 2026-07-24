/**
 * Types for the anonymization pipeline (spec: specs/anonymization.spec.md).
 *
 * The whole point: a Terac reviewer must be able to advise WITHOUT identifying
 * the user or seeing a single raw transaction. So there are two worlds here:
 *
 *   - INTERNAL types (RawTransaction, UserIdentity, Summary) carry PII. They
 *     never leave the process untouched.
 *   - The AnonymizedSummary is the ONLY shape allowed to reach a reviewer. By
 *     construction it cannot hold a name, cédula, counterparty, raw tx or exact
 *     balance — those fields simply do not exist on it.
 */

/** Coarse amount bucket, shared vocabulary with the guardrail spec. */
export type AmountBucket = "bajo" | "medio" | "alto" | "muy_alto";

/**
 * Spend category. Includes sensitive ones (BR-A3) so `computeSummary` can see
 * them internally; `anonymize` collapses them into a single opaque group.
 */
export type Category =
  | "comida"
  | "transporte"
  | "vivienda"
  | "suscripciones"
  | "entretenimiento"
  | "servicios"
  | "salud"
  | "legal"
  | "religion"
  | "politica"
  | "otros";

/** Categories that must never reach a reviewer in detail (BR-A3). */
export const SENSITIVE_CATEGORIES: readonly Category[] = ["salud", "legal", "religion", "politica"];

/** The opaque bucket sensitive categories collapse into. */
export const SENSITIVE_GROUP = "reservado";

/** Direct identifiers — the reviewer must NEVER see any of these (BR-A1). */
export interface UserIdentity {
  readonly name: string;
  readonly phone?: string;
  readonly email?: string;
  readonly cedula?: string;
  readonly accountNumber?: string;
}

/** A single raw transaction (merchant + amount + date) — never exposed (BR-A1). */
export interface RawTransaction {
  readonly id: string;
  readonly merchant: string;
  readonly amount: number;
  readonly currency: string;
  readonly date: string; // ISO
  readonly category: Category;
}

/** Raw financial profile fed into the pipeline (fully PII-bearing, internal). */
export interface FinancialProfile {
  readonly identity: UserIdentity;
  readonly transactions: readonly RawTransaction[];
  readonly monthlyIncome: number;
  readonly exactBalance: number;
  /** Prior-period totals per category, to compute trends. */
  readonly priorPeriodTotals?: Partial<Record<Category, number>>;
}

/**
 * Intermediate summary — aggregated but still PII-bearing (carries identity +
 * raw transactions). Internal only; the output of `computeSummary`.
 */
export interface Summary {
  readonly identity: UserIdentity;
  readonly categoryTotals: readonly { category: Category; total: number }[];
  readonly trendsVsPrior: readonly { category: Category; deltaPct: number }[];
  readonly behaviorFlags: readonly string[];
  readonly totalSpend: number;
  readonly monthlyIncome: number;
  readonly exactBalance: number;
  readonly rawTransactions: readonly RawTransaction[];
}

/**
 * The ONLY shape allowed to reach a reviewer. No identity, no raw transactions,
 * no counterparties, no exact balance — by construction (BR-A1/A2).
 */
export interface AnonymizedSummary {
  /** Rotating per-review pseudonym; not linkable across reviews (BR-A4). */
  readonly reviewPseudonym: string;
  /** Category split in %, sensitive collapsed into SENSITIVE_GROUP. Sums ≈ 100. */
  readonly categoryBreakdown: readonly { category: string; pct: number }[];
  /** Trend vs prior period, per (non-sensitive) category. */
  readonly trendsVsPrior: readonly { category: string; deltaPct: number }[];
  /** Pattern-level behavior flags (no PII). */
  readonly behaviorFlags: readonly string[];
  /** Amounts normalized to coarse buckets — never exact figures (BR-A2). */
  readonly amountBuckets: readonly { label: string; bucket: AmountBucket }[];
}

/** A single leak-check hit (BR-A5). */
export interface LeakHit {
  readonly gate: string; // maps to a rubric gate G1..G6
  readonly evidence: string;
  readonly why: string;
}

/** Leak-check verdict. Fail-closed: ok === true ONLY if hits is empty. */
export interface LeakResult {
  readonly ok: boolean;
  readonly hits: readonly LeakHit[];
}
