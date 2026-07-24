import type { AnonymizedSummary, LeakHit, LeakResult } from "./types.js";

/**
 * Fail-closed leak-check (BR-A5). Runs BEFORE anything reaches a reviewer.
 * A single hit blocks the send — there is no silent override.
 *
 * It scans the FREE-FORM string surface (behavior flags, category labels,
 * bucket labels) — the fields where PII could actually hide — and NOT the
 * numeric fields (pct/deltaPct) nor the system-generated reviewPseudonym: the
 * pseudonym is opaque hex, safe by construction, so scanning it only produces
 * false positives (a digit-heavy hex trips the digit patterns) that would
 * spuriously block a legitimate escalation. Fail-closed must not mean fail-random.
 *
 * This is the deterministic (regex) layer, the floor. An optional `extraScan`
 * is where a slower LLM layer plugs in; it can only ADD hits, never clear them.
 */

interface PiiPattern {
  readonly gate: string;
  readonly re: RegExp;
  readonly why: string;
}

// Tuned NOT to fire on clean summaries (category names, coarse buckets,
// hyphenated pseudonyms, short flag numbers like "3" or "60 días").
const PII_PATTERNS: readonly PiiPattern[] = [
  { gate: "G1", re: /[\w.+-]+@[\w-]+\.[a-z]{2,}/i, why: "email" },
  // 7+ char digit run (cédula, account, phone), tolerant of dots/spaces/dashes.
  { gate: "G1", re: /\d[\d.\s-]{5,}\d/, why: "secuencia larga de dígitos (cédula/cuenta/teléfono)" },
  // Bare 4+ digit figure — a raw amount/balance never belongs in an anonymized field.
  { gate: "G3", re: /(?<![\d.,])\d{4,}(?![\d.,])/, why: "cifra cruda de 4+ dígitos (posible monto/saldo)" },
  { gate: "G2", re: /(\$|COP|USD|USDC|€)\s?\d/i, why: "monto crudo con moneda" },
  // Movement verb pointing at a party.
  { gate: "G2", re: /\b(pago|pagos|transferencia|env[ií]o|dep[oó]sito)\b/i, why: "referencia a una transacción individual" },
  // Two adjacent capitalized words -> a person/full name (e.g. "Juan Pérez").
  { gate: "G2", re: /[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+/, why: "posible nombre propio / contraparte" },
];

export interface LeakCheckOptions {
  /** Optional extra (e.g. LLM) scanner over the free-form text. Additive only — can only block more. */
  readonly extraScan?: (scanText: string, anon: AnonymizedSummary) => readonly LeakHit[];
}

/** The free-form string surface a reviewer would read — the only place PII can hide. */
function collectFreeText(anon: AnonymizedSummary): string {
  // reviewPseudonym is deliberately excluded: it is system-generated opaque hex
  // (a hash of a random review id), so it can never carry user PII; scanning it
  // only causes random false positives on its digit runs (the flaky-escalation bug).
  return [
    ...anon.behaviorFlags,
    ...anon.categoryBreakdown.map((c) => c.category),
    ...anon.trendsVsPrior.map((t) => t.category),
    ...anon.amountBuckets.map((b) => `${b.label} ${b.bucket}`),
  ].join(" | ");
}

export function leakCheck(anon: AnonymizedSummary, opts: LeakCheckOptions = {}): LeakResult {
  const scanText = collectFreeText(anon);
  const hits: LeakHit[] = [];

  for (const p of PII_PATTERNS) {
    const m = scanText.match(p.re);
    if (m) hits.push({ gate: p.gate, evidence: m[0], why: p.why });
  }

  if (opts.extraScan) hits.push(...opts.extraScan(scanText, anon));

  // Fail-closed: ok ONLY when nothing at all was found.
  return { ok: hits.length === 0, hits };
}
