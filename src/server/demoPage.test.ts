import { describe, it, expect } from "vitest";
import { handleDemoTurn, type DemoDeps } from "./demoPage.js";
import type { AgentOutcome } from "../agent/orchestrator.js";
import type { Action } from "../agent/types.js";
import type { AnonymizedSummary } from "../anonymization/types.js";

/**
 * The demo playground turn handler: it drives the SAME agent outcomes but keeps
 * per-session pending state, simulates payments (moves no money) and simulates
 * consensus through the real Dawid–Skene aggregator. These tests pin the routing.
 */

const anon: AnonymizedSummary = {
  reviewPseudonym: "azul-42",
  categoryBreakdown: [{ category: "vivienda", pct: 66.5 }],
  trendsVsPrior: [],
  behaviorFlags: [],
  amountBuckets: [],
};

function payAction(): Action {
  return {
    intent: "pay",
    type: "payment",
    params: { amount: 200, recipient: "Ana" },
    riskSignals: { amountBucket: "medio", novelCounterparty: true, volatileSwap: false, modelConfidence: 0.9 },
    confidence: 0.9,
    missingSlots: [],
    rawText: "Send $200 to Ana",
  };
}

/** Deps whose outcome/parse are stubbed per test; nothing hits a live model. */
function deps(overrides: Partial<DemoDeps>): DemoDeps {
  return {
    handle: async (): Promise<AgentOutcome> => ({ kind: "reply", text: "hi" }),
    parse: async (): Promise<Action> => payAction(),
    dashboardAnswer: async () => "dashboard-link",
    ...overrides,
  };
}

describe("handleDemoTurn", () => {
  it("routes a dashboard intent to the tokenized link, not the agent loop", async () => {
    const session = { lastSeen: 0 };
    const d = deps({
      parse: async () => ({ ...payAction(), intent: "dashboard", type: "portfolio_query", missingSlots: [] }),
      dashboardAnswer: async () => "Here's your dashboard 📊 http://x/dashboard/tok",
    });
    const reply = await handleDemoTurn("show my dashboard", session, d);
    expect(reply.bubbles[0]?.text).toContain("/dashboard/tok");
  });

  it("stages an escalation and shows the anonymized preview (nothing sent yet)", async () => {
    const session: { pendingConsent?: unknown; lastSeen: number } = { lastSeen: 0 };
    const d = deps({ handle: async () => ({ kind: "escalated", previewText: "reviewer sees: vivienda 66.5%", anon }) });
    const reply = await handleDemoTurn("Send $200 to Ana", session, d);
    expect(reply.bubbles.some((b) => b.text.includes("vivienda 66.5%"))).toBe(true);
    expect(session.pendingConsent).toBeDefined();
    expect(reply.effect).toBeUndefined();
  });

  it("on consent 'yes' for a money escalation, simulates the payment with confetti", async () => {
    const session = { pendingConsent: { anon, action: payAction() }, lastSeen: 0 };
    const reply = await handleDemoTurn("yes", session, deps({}));
    expect(reply.effect).toBe("confetti");
    expect(reply.bubbles.some((b) => b.text.toLowerCase().includes("simulated on base sepolia"))).toBe(true);
    expect(reply.bubbles.some((b) => b.text.includes("Dawid–Skene"))).toBe(true);
    expect(session.pendingConsent).toBeUndefined();
  });

  it("on consent 'no', shares nothing and moves no money", async () => {
    const session = { pendingConsent: { anon, action: payAction() }, lastSeen: 0 };
    const reply = await handleDemoTurn("no", session, deps({}));
    expect(reply.effect).toBeUndefined();
    expect(reply.bubbles[0]?.text.toLowerCase()).toContain("won't share");
    expect(session.pendingConsent).toBeUndefined();
  });

  it("passes plain replies through untouched", async () => {
    const session = { lastSeen: 0 };
    const d = deps({
      parse: async () => ({ ...payAction(), intent: "smalltalk", type: undefined }),
      handle: async () => ({ kind: "reply", text: "Hey! 👋" }),
    });
    const reply = await handleDemoTurn("hey", session, d);
    expect(reply.bubbles[0]?.text).toBe("Hey! 👋");
  });
});
