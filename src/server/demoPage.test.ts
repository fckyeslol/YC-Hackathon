import { describe, it, expect } from "vitest";
import { handleDemoTurn, isAffirmative, isNegative, type DemoDeps } from "./demoPage.js";
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

describe("isAffirmative / isNegative", () => {
  it("accepts a bare 👍 and casual yeses (the reported consent bug)", () => {
    for (const t of ["👍", "yeah sure", "yeah", "yep", "yup", "sure", "ok", "sí", "do it", "share it", "  👍  "]) {
      expect(isAffirmative(t)).toBe(true);
    }
  });
  it("recognizes negatives", () => {
    for (const t of ["👎", "no", "nope", "nah", "keep it private", "don't"]) {
      expect(isNegative(t)).toBe(true);
    }
  });
  it("does not read a negative as a yes", () => {
    expect(isAffirmative("no")).toBe(false);
    expect(isAffirmative("nope")).toBe(false);
    expect(isNegative("yeah sure")).toBe(false);
  });
});

/** A staged escalation consent, resolved by an affirmation. */
describe("consent affirmation", () => {
  it("resolves consent on '👍' and on 'yeah sure' (not just literal 'yes')", async () => {
    for (const reply of ["👍", "yeah sure"]) {
      const session = { pendingConsent: { anon, action: payAction() }, lastSeen: 0 };
      const out = await handleDemoTurn(reply, session, {
        handle: async () => ({ kind: "reply", text: "hi" }),
        parse: async () => payAction(),
        dashboardAnswer: async () => "x",
      });
      expect(out.effect).toBe("confetti");
      expect(session.pendingConsent).toBeUndefined();
    }
  });
});

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
    const session: { pendingConsent?: { anon: AnonymizedSummary; action: Action }; lastSeen: number } = { lastSeen: 0 };
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

  it("fills a missing slot from a follow-up value instead of parsing it cold", async () => {
    // Turn 1: "pay my dad" → missing amount → reprompt stages the partial action.
    const session: { pendingSlot?: Action; lastSeen: number } = { lastSeen: 0 };
    const partial: Action = {
      ...payAction(),
      params: { recipient: "dad" },
      missingSlots: ["amount"],
      rawText: "pay my dad",
    };
    const turn1 = await handleDemoTurn("pay my dad", session, deps({
      parse: async () => partial,
      handle: async () => ({ kind: "reprompt", text: "How much?", missing: ["amount"], action: partial }),
    }));
    expect(turn1.bubbles[0]?.text).toBe("How much?");
    expect(session.pendingSlot).toBeDefined();

    // Turn 2: "200usd" is a slot value — the cold parse returns `unknown`, but the
    // merge must recover amount=200 and hand a COMPLETE pay action to the loop.
    let handledAction: Action | undefined;
    const turn2 = await handleDemoTurn("200usd", session, deps({
      parse: async () => ({ ...payAction(), intent: "unknown", type: undefined, params: {}, missingSlots: [] }),
      handle: async (_t, _v, pre) => {
        handledAction = pre;
        return { kind: "confirm_required", text: "send 200 to dad — confirm? 👍", action: pre! };
      },
    }));
    expect(handledAction?.intent).toBe("pay");
    expect(handledAction?.params.amount).toBe(200);
    expect(handledAction?.params.recipient).toBe("dad");
    expect(handledAction?.missingSlots.length).toBe(0);
    expect(turn2.bubbles[0]?.text).toContain("confirm");
    expect(session.pendingSlot).toBeUndefined();
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
