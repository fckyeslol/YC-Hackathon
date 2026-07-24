import { describe, test, expect } from "vitest";
import { createDashboardLinkStore, dashboardUrl } from "./link.js";
import type { DashboardData } from "./types.js";

const DATA: DashboardData = {
  range: "mes",
  generatedAt: "2026-07-24T00:00:00.000Z",
  currency: "USDC",
  kpis: { spent: 100, spentDeltaPct: null, net: 50, txCount: 3, activeSubscriptions: { count: 1, monthlyUsdc: 10 } },
  spendByCategory: [{ category: "comida", amount: 100, pct: 100 }],
  monthlyTrend: [],
  topMerchants: [{ merchant: "Rappi", amount: 100 }],
};

describe("dashboard link store (BR-D2)", () => {
  test("mint → resolve returns the exact payload", () => {
    const store = createDashboardLinkStore(() => 1000);
    const token = store.mint(DATA);
    expect(token).toMatch(/^[0-9a-f]{48}$/); // 24 bytes hex, not guessable
    expect(store.resolve(token)).toBe(DATA);
  });

  test("an unknown token resolves to undefined (no data leak)", () => {
    const store = createDashboardLinkStore(() => 1000);
    expect(store.resolve("deadbeef")).toBeUndefined();
  });

  test("an expired token resolves to undefined and is dropped", () => {
    let now = 1000;
    const store = createDashboardLinkStore(() => now);
    const token = store.mint(DATA, 5000); // expires at 6000
    now = 5999;
    expect(store.resolve(token)).toBe(DATA);
    now = 6000; // exactly at expiry → gone
    expect(store.resolve(token)).toBeUndefined();
    now = 7000;
    expect(store.resolve(token)).toBeUndefined();
  });

  test("dashboardUrl builds the tokenized URL, trimming a trailing slash", () => {
    expect(dashboardUrl("https://v.app/", "abc")).toBe("https://v.app/dashboard/abc");
    expect(dashboardUrl("https://v.app", "abc")).toBe("https://v.app/dashboard/abc");
  });
});
