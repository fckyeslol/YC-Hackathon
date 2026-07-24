import { describe, test, expect, vi } from "vitest";
import { escalateToReviewers } from "./escalate.js";
import { ConsentToken } from "./consent.js";
import type { AnonymizedSummary } from "../anonymization/types.js";

const CLEAN: AnonymizedSummary = {
  reviewPseudonym: "Revisor-anonimo-4f2a91b0c3d2",
  categoryBreakdown: [
    { category: "comida", pct: 60 },
    { category: "otros", pct: 40 },
  ],
  trendsVsPrior: [],
  behaviorFlags: ["las suscripciones son una parte notable del gasto mensual"],
  amountBuckets: [{ label: "gasto mensual", bucket: "medio" }],
};

/** Same shape but with a leaked counterparty smuggled into a flag. */
const DIRTY: AnonymizedSummary = { ...CLEAN, behaviorFlags: ["pago a Juan Pérez"] };

describe("escalateToReviewers (B1 — the gate is structural, BR-A5/A6)", () => {
  test("happy path — clean summary + consent for it delivers exactly once", async () => {
    const deliver = vi.fn(async () => {});
    const consent = ConsentToken.approve(CLEAN);

    const result = await escalateToReviewers(CLEAN, consent, deliver);

    expect(result.sent).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(CLEAN);
  });

  test("BR-A5 — a leak blocks before consent is even checked; deliver never runs", async () => {
    const deliver = vi.fn(async () => {});
    const consent = ConsentToken.approve(DIRTY); // even WITH a token...

    const result = await escalateToReviewers(DIRTY, consent, deliver);

    expect(result.sent).toBe(false);
    expect(result.reason).toBe("leak_blocked");
    expect(deliver).not.toHaveBeenCalled();
  });

  test("BR-A6 — consent minted for a DIFFERENT summary cannot authorize this one", async () => {
    const deliver = vi.fn(async () => {});
    const other: AnonymizedSummary = { ...CLEAN, behaviorFlags: ["otra cosa distinta"] };
    const consentForOther = ConsentToken.approve(other);

    const result = await escalateToReviewers(CLEAN, consentForOther, deliver);

    expect(result.sent).toBe(false);
    expect(result.reason).toBe("consent_missing_or_mismatch");
    expect(deliver).not.toHaveBeenCalled();
  });

  test("a fabricated non-token cannot pass the gate", async () => {
    const deliver = vi.fn(async () => {});
    // A caller trying to fake consent with a look-alike object.
    const fake = { forDigest: "whatever", matches: () => true } as unknown as ConsentToken;

    const result = await escalateToReviewers(CLEAN, fake, deliver);

    expect(result.sent).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });

  test("the LLM layer (extraScan) can veto an otherwise-clean summary", async () => {
    const deliver = vi.fn(async () => {});
    const consent = ConsentToken.approve(CLEAN);

    const result = await escalateToReviewers(CLEAN, consent, deliver, {
      extraScan: () => [{ gate: "G5", evidence: "huella única", why: "reidentificable" }],
    });

    expect(result.sent).toBe(false);
    expect(result.reason).toBe("leak_blocked");
    expect(deliver).not.toHaveBeenCalled();
  });
});
