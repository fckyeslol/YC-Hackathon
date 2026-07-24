import { describe, test, expect } from "vitest";
import { buildDashboardApp } from "./dashboardPage.js";
import { buildDashboard } from "../dashboard/buildDashboard.js";
import { toLedgerTxs } from "../dashboard/ledgerAdapter.js";
import type { DashboardData } from "../dashboard/types.js";

function sampleData(): DashboardData {
  const txs = toLedgerTxs(
    [
      { id: "s1", amountCop: 180_000, date: "2026-07-05", category: "comida", merchant: "Rappi" },
      { id: "s2", amountCop: 42_000, date: "2026-07-08", category: "suscripciones", merchant: "Netflix" },
      { id: "s3", amountCop: 4_000_000, date: "2026-07-01", category: "ingresos", direction: "income" },
    ],
    4000,
  );
  return buildDashboard(txs, "mes", { generatedAt: "2026-07-24T00:00:00.000Z" });
}

describe("dashboard page route (BR-D2 / BR-D1)", () => {
  test("a valid token renders the full personal page", async () => {
    const data = sampleData();
    const app = buildDashboardApp({ resolve: (t) => (t === "good" ? data : undefined) });

    const res = await app.inject({ method: "GET", url: "/dashboard/good" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    // Full detail — real merchant names (BR-D1: personal view, NOT anonymized).
    expect(res.body).toContain("Rappi");
    expect(res.body).toContain("Netflix");
    // Accessible table view exists (BR-D8).
    expect(res.body).toContain("View as table");
    await app.close();
  });

  test("an invalid/expired token is a 404 with no financial data (BR-D2)", async () => {
    const data = sampleData();
    const app = buildDashboardApp({ resolve: (t) => (t === "good" ? data : undefined) });

    const res = await app.inject({ method: "GET", url: "/dashboard/bogus" });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("Rappi");
    expect(res.body).not.toContain("Netflix");
    await app.close();
  });
});
