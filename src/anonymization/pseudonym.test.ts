import { describe, test, expect } from "vitest";
import { newReviewId, pseudonymFor } from "./pseudonym.js";

describe("pseudonym (BR-A4, no linkability)", () => {
  test("BR-A4 — the same user in two reviews gets two different pseudonyms", () => {
    // Arrange: two distinct reviews (fresh review ids), conceptually same user.
    const reviewA = "review-aaa";
    const reviewB = "review-bbb";

    // Act
    const pa = pseudonymFor(reviewA);
    const pb = pseudonymFor(reviewB);

    // Assert: different, and neither derives from user identity.
    expect(pa).not.toBe(pb);
    expect(pa).not.toContain("Mateo");
    expect(pb).not.toContain("Mateo");
  });

  test("is a pure function of the review id (reproducible within one review)", () => {
    expect(pseudonymFor("review-xyz")).toBe(pseudonymFor("review-xyz"));
  });

  test("newReviewId returns unique ids", () => {
    const a = newReviewId();
    const b = newReviewId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });
});
