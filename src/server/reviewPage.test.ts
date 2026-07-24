import { describe, test, expect, vi } from "vitest";
import { buildReviewApp, type ReviewCard } from "./reviewPage.js";

const CARD: ReviewCard = {
  anon: {
    reviewPseudonym: "Revisor-anonimo-abc123def456",
    categoryBreakdown: [
      { category: "comida", pct: 42 },
      { category: "reservado", pct: 10 },
    ],
    trendsVsPrior: [{ category: "suscripciones", deltaPct: 20 }],
    behaviorFlags: ["las suscripciones son una parte notable del gasto mensual"],
    amountBuckets: [{ label: "gasto mensual", bucket: "medio" }],
  },
  prompt: "¿Apruebas este consejo?",
  options: ["rechazar", "editar", "aprobar"],
};

function deps(over: Partial<Parameters<typeof buildReviewApp>[0]> = {}) {
  return {
    getReview: (p: string) => (p === "Revisor-anonimo-abc123def456" ? CARD : undefined),
    submitJudgment: vi.fn(async () => {}),
    ...over,
  };
}

describe("review page (BR-T2)", () => {
  test("GET renders ONLY anonymized content + the option form", async () => {
    const app = buildReviewApp(deps());
    const res = await app.inject({ method: "GET", url: "/review/Revisor-anonimo-abc123def456" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("comida");
    expect(res.body).toContain("aprobar");
    expect(res.body).toContain("Revisor-anonimo-abc123def456");
    // No PII surface whatsoever.
    expect(res.body).not.toContain("Mateo");
    await app.close();
  });

  test("GET on an unknown pseudonym → 404 (no leak of existence)", async () => {
    const app = buildReviewApp(deps());
    const res = await app.inject({ method: "GET", url: "/review/desconocido" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  test("POST a valid label records the judgment", async () => {
    const d = deps();
    const app = buildReviewApp(d);
    const res = await app.inject({
      method: "POST",
      url: "/review/Revisor-anonimo-abc123def456",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "label=2&adviceText=ojo con las suscripciones",
    });

    expect(res.statusCode).toBe(200);
    expect(d.submitJudgment).toHaveBeenCalledWith("Revisor-anonimo-abc123def456", {
      label: 2,
      adviceText: "ojo con las suscripciones",
    });
    await app.close();
  });

  test("POST an out-of-range label → 400, nothing recorded", async () => {
    const d = deps();
    const app = buildReviewApp(d);
    const res = await app.inject({
      method: "POST",
      url: "/review/Revisor-anonimo-abc123def456",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "label=9",
    });

    expect(res.statusCode).toBe(400);
    expect(d.submitJudgment).not.toHaveBeenCalled();
    await app.close();
  });
});
