import type { AnonymizedSummary } from "../anonymization/types.js";
import type { TeracClient, CreateOpportunityInput } from "../clients/terac.js";

/**
 * The sanctioned Terac delivery adapter (closes B1).
 *
 * This is the ONLY code that turns reviewer-bound content into a Terac
 * opportunity. It accepts an `AnonymizedSummary` — never raw data — so what
 * reaches Terac is PII-free by type. It is meant to be used as the `deliver`
 * passed to `escalateToReviewers` / `completeConsentedEscalation`, which run
 * leakCheck (BR-A5) + ConsentToken (BR-A6) BEFORE this ever executes. So the
 * full path is: anonymize → leakCheck → consent → THIS. There is no shape here
 * that could carry a name, cédula, counterparty, raw tx or exact balance.
 */

export interface TeracDeliveryConfig {
  /** Terac project the review opportunities live under. */
  readonly projectName: string;
  /** How many human reviewers form the panel. */
  readonly numReviewers: number;
  /** Public base URL of the review page (no trailing slash). */
  readonly publicUrl: string;
  /** Minutes budgeted per reviewer (drives Terac pricing). */
  readonly durationMinutes?: number;
}

const DEFAULT_DURATION_MIN = 5;

/**
 * Pure mapping: AnonymizedSummary → Terac opportunity draft. Exported for
 * testing the shape without any live call. Only reads the anonymized fields.
 */
export function toOpportunityInput(
  anon: AnonymizedSummary,
  projectId: string,
  cfg: TeracDeliveryConfig,
): CreateOpportunityInput {
  const breakdown = anon.categoryBreakdown.map((c) => `${c.category} ${c.pct}%`).join(", ");
  const trends = anon.trendsVsPrior.map((t) => `${t.category} ${t.deltaPct > 0 ? "+" : ""}${t.deltaPct}%`).join(", ");
  const flags = anon.behaviorFlags.join("; ");

  const description = [
    `Perfil anónimo (${anon.reviewPseudonym}). No hay identidad ni transacciones individuales.`,
    breakdown && `Reparto por categoría: ${breakdown}.`,
    trends && `Tendencias vs. período previo: ${trends}.`,
    flags && `Señales: ${flags}.`,
    "¿Qué consejo financiero le darías a esta persona?",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    title: "Revisión anónima de finanzas — pedimos tu criterio",
    internal_title: `verdict-review-${anon.reviewPseudonym}`,
    description,
    project_id: projectId,
    num_participants: cfg.numReviewers,
    business_type: "b2c",
    tasks: [
      {
        sequence: 1,
        task_type: "activity",
        review_type: "manual_review",
        task_url: `${cfg.publicUrl}/review/${anon.reviewPseudonym}`,
        duration_minutes: cfg.durationMinutes ?? DEFAULT_DURATION_MIN,
      },
    ],
  };
}

/**
 * Build the `deliver` callback for `escalateToReviewers`. Ensures the project
 * exists, creates the opportunity from the anonymized summary, and launches it.
 * `terac` is injected so this is unit-testable without hitting the live API.
 */
export function makeTeracDeliver(
  terac: TeracClient,
  cfg: TeracDeliveryConfig,
): (anon: AnonymizedSummary) => Promise<void> {
  return async (anon: AnonymizedSummary): Promise<void> => {
    const projectId = await terac.ensureProject(cfg.projectName);
    const opportunity = await terac.createOpportunity(toOpportunityInput(anon, projectId, cfg));
    await terac.launchOpportunity(opportunity.id);
  };
}
