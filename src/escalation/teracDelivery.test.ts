import { describe, test, expect, vi } from "vitest";
import { toOpportunityInput, makeTeracDeliver, type TeracDeliveryConfig } from "./teracDelivery.js";
import type { TeracClient } from "../clients/terac.js";
import type { AnonymizedSummary } from "../anonymization/types.js";

const CFG: TeracDeliveryConfig = { projectName: "verdict", numReviewers: 3, publicUrl: "https://verdict.app" };

const ANON: AnonymizedSummary = {
  reviewPseudonym: "Revisor-anonimo-4f2a91b0c3d2",
  categoryBreakdown: [
    { category: "comida", pct: 42 },
    { category: "reservado", pct: 10 },
    { category: "otros", pct: 48 },
  ],
  trendsVsPrior: [{ category: "suscripciones", deltaPct: 20 }],
  behaviorFlags: ["las suscripciones son una parte notable del gasto mensual"],
  amountBuckets: [{ label: "gasto mensual", bucket: "medio" }],
};

/** Minimal fake Terac client — only the methods the deliver touches. */
function fakeTerac(over: Partial<TeracClient> = {}): TeracClient {
  return {
    ensureProject: vi.fn(async () => "proj-1"),
    createOpportunity: vi.fn(async () => ({ id: "opp-1", status: "draft", title: "t", num_participants: 3 })),
    launchOpportunity: vi.fn(async () => ({ id: "opp-1", status: "live", title: "t", num_participants: 3 })),
    ...over,
  } as unknown as TeracClient;
}

describe("teracDelivery (B1 — sanctioned Terac deliver, PII-free by construction)", () => {
  test("toOpportunityInput carries no PII and points the task at the pseudonymed review page", () => {
    const input = toOpportunityInput(ANON, "proj-1", CFG);
    const serialized = JSON.stringify(input);

    // Only anonymized content — never identity/raw tx/counterparty/exact balance.
    expect(serialized).not.toContain("Mateo");
    expect(serialized).not.toMatch(/\d{7,}/); // no cédula/account/exact balance
    expect(input.project_id).toBe("proj-1");
    expect(input.num_participants).toBe(3);
    expect(input.tasks[0]!.task_url).toBe("https://verdict.app/review/Revisor-anonimo-4f2a91b0c3d2");
    expect(input.description).toContain("comida 42%");
    expect(input.description).toContain("Perfil anónimo");
  });

  test("makeTeracDeliver ensures project, creates the opportunity, then launches it", async () => {
    const terac = fakeTerac();
    const deliver = makeTeracDeliver(terac, CFG);

    await deliver(ANON);

    expect(terac.ensureProject).toHaveBeenCalledWith("verdict");
    expect(terac.createOpportunity).toHaveBeenCalledTimes(1);
    expect(terac.launchOpportunity).toHaveBeenCalledWith("opp-1");

    // The created opportunity was built from the anonymized summary.
    const passed = (terac.createOpportunity as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(JSON.stringify(passed)).not.toContain("Mateo");
    expect(passed.internal_title).toContain("Revisor-anonimo-");
  });
});
