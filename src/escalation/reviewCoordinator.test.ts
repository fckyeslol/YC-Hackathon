import { describe, test, expect, vi } from "vitest";
import { ReviewCoordinator, type ReviewCoordinatorDeps } from "./reviewCoordinator.js";
import type { AnonymizedSummary } from "../anonymization/types.js";

const ANON: AnonymizedSummary = {
  reviewPseudonym: "Revisor-anonimo-abc123def456",
  categoryBreakdown: [{ category: "comida", pct: 100 }],
  trendsVsPrior: [],
  behaviorFlags: [],
  amountBuckets: [{ label: "gasto mensual", bucket: "muy_alto" }],
};

function make(over: Partial<ReviewCoordinatorDeps> = {}) {
  const deliver = vi.fn(async (_anon: AnonymizedSummary) => {});
  const coach = vi.fn(async (_chatId: string, _message: string) => {});
  const coord = new ReviewCoordinator({ deliver, coach, quorum: 2, now: () => "2026-07-24T00:00:00.000Z", ...over });
  return { coord, deliver, coach };
}

describe("ReviewCoordinator (terac-review E2E glue)", () => {
  test("nothing is delivered until the user consents (BR-T6)", async () => {
    const { coord, deliver } = make();
    coord.stageConsent("chat-1", ANON);
    expect(coord.hasPending("chat-1")).toBe(true);
    expect(deliver).not.toHaveBeenCalled();
  });

  test("an affirmative reply launches Terac and opens the review (BR-T6)", async () => {
    const { coord, deliver } = make();
    coord.stageConsent("chat-1", ANON);

    const out = await coord.maybeConsent("chat-1", "sí, dale");

    expect(out.consented).toBe(true);
    expect(deliver).toHaveBeenCalledWith(ANON);
    expect(coord.hasPending("chat-1")).toBe(false);
    // Review page can now resolve the card by pseudonym.
    expect(coord.reviewCard("Revisor-anonimo-abc123def456")?.prompt).toBeTruthy();
  });

  test("a reply with no pending review is not consumed", async () => {
    const { coord } = make();
    const out = await coord.maybeConsent("chat-1", "sí");
    expect(out.consented).toBe(false);
  });

  test("a negative reply cancels and clears the pending review", async () => {
    const { coord, deliver } = make();
    coord.stageConsent("chat-1", ANON);
    const out = await coord.maybeConsent("chat-1", "no, mejor no");
    expect(out.consented).toBe(false);
    expect(out.reply).toMatch(/won't share/i);
    expect(coord.hasPending("chat-1")).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });

  test("a live Terac failure does not break consent (best-effort recruit)", async () => {
    const { coord } = make({ deliver: vi.fn(async () => { throw new Error("terac 401"); }) });
    coord.stageConsent("chat-1", ANON);
    const out = await coord.maybeConsent("chat-1", "sí");
    expect(out.consented).toBe(true); // review page still open; no PII risk
  });

  test("the structural gate blocks a leaky summary at consent time — deliver never runs (BR-A8)", async () => {
    const { coord, deliver } = make();
    const leaky: AnonymizedSummary = {
      reviewPseudonym: "Revisor-anonimo-deadbeef0001",
      categoryBreakdown: [{ category: "comida", pct: 100 }],
      trendsVsPrior: [],
      behaviorFlags: ["pago a Juan Pérez"], // trips the leakCheck floor
      amountBuckets: [],
    };
    coord.stageConsent("chat-9", leaky);

    const out = await coord.maybeConsent("chat-9", "sí");

    expect(out.consented).toBe(false);
    expect(out.reply).toMatch(/safety/i);
    expect(deliver).not.toHaveBeenCalled();
    // No session opened for a blocked summary.
    expect(coord.reviewCard("Revisor-anonimo-deadbeef0001")).toBeUndefined();
  });

  test("judgments accumulate and coach the user once quorum is reached (BR-T4/T5)", async () => {
    const { coord, coach } = make();
    coord.stageConsent("chat-1", ANON);
    await coord.maybeConsent("chat-1", "sí");
    const p = "Revisor-anonimo-abc123def456";

    const first = await coord.recordJudgment(p, { label: 1 }); // "Sí"
    expect(first).toEqual({ recorded: true, closed: false });
    expect(coach).not.toHaveBeenCalled(); // quorum not reached

    const second = await coord.recordJudgment(p, { label: 1 });
    expect(second.closed).toBe(true);
    expect(coach).toHaveBeenCalledTimes(1);
    expect(coach.mock.calls[0]![0]).toBe("chat-1");
    expect(coach.mock.calls[0]![1]).toMatch(/verdict/i);
  });

  test("out-of-range labels and unknown pseudonyms are rejected", async () => {
    const { coord } = make();
    coord.stageConsent("chat-1", ANON);
    await coord.maybeConsent("chat-1", "sí");
    const p = "Revisor-anonimo-abc123def456";
    expect(await coord.recordJudgment(p, { label: 9 })).toEqual({ recorded: false, closed: false });
    expect(await coord.recordJudgment("desconocido", { label: 0 })).toEqual({ recorded: false, closed: false });
    expect(coord.reviewCard("desconocido")).toBeUndefined();
  });
});
