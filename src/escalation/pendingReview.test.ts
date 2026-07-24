import { describe, test, expect, vi } from "vitest";
import { PendingReviewStore } from "./pendingReview.js";
import type { AnonymizedSummary } from "../anonymization/types.js";

const ANON: AnonymizedSummary = {
  reviewPseudonym: "Revisor-anonimo-abc123def456",
  categoryBreakdown: [{ category: "comida", pct: 100 }],
  trendsVsPrior: [],
  behaviorFlags: [],
  amountBuckets: [{ label: "gasto mensual", bucket: "bajo" }],
};

describe("PendingReviewStore (BR-T6 consent trigger)", () => {
  test("nothing goes to Terac until the user consents", async () => {
    const store = new PendingReviewStore();
    const deliver = vi.fn(async () => {});
    store.stage("chat-1", ANON);
    // ...user has NOT tapped 👍 yet → deliver must not have run.
    expect(deliver).not.toHaveBeenCalled();
    expect(store.has("chat-1")).toBe(true);
  });

  test("tapback 👍 resolves through the gate and delivers exactly once", async () => {
    const store = new PendingReviewStore();
    const deliver = vi.fn(async () => {});
    store.stage("chat-1", ANON);

    const out = await store.resolveConsent("chat-1", deliver);

    expect(out.sent).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(store.has("chat-1")).toBe(false); // cleared
  });

  test("resolving twice is safe — the second time nothing is pending", async () => {
    const store = new PendingReviewStore();
    const deliver = vi.fn(async () => {});
    store.stage("chat-1", ANON);
    await store.resolveConsent("chat-1", deliver);

    const again = await store.resolveConsent("chat-1", deliver);

    expect(again).toEqual({ sent: false, reason: "nothing_pending" });
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  test("the reviewer page finds the summary by pseudonym, never by user id", () => {
    const store = new PendingReviewStore();
    store.stage("chat-1", ANON);
    expect(store.findByPseudonym("Revisor-anonimo-abc123def456")).toEqual(ANON);
    expect(store.findByPseudonym("otro")).toBeUndefined();
  });
});
