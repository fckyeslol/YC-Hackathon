import { config } from "../config.js";
import { InMemoryComplianceState } from "../domain/complianceState.js";
import { linq, text } from "../clients/linq.js";
import { guardedSend } from "../domain/guardedSend.js";
import type { SendGuardState } from "../domain/sendGuard.js";
import { buildLinqApp } from "./linqWebhook.js";
import { parseIntent } from "../agent/parseIntent.js";
import type { LlmClassifier } from "../agent/types.js";
import type { LedgerPort } from "../agent/ports.js";
import { handleAgentMessage, type AgentOutcome, type OrchestratorDeps } from "../agent/orchestrator.js";
import { RETRY_PROMPT, transcribeVoice, type Transcriber } from "../agent/voice.js";
import type { DynamicWallet } from "../clients/dynamic.js";
import {
  PendingActionStore,
  reactionIntent,
  type ResolveOutcome,
} from "../agent/pendingAction.js";
import { buildDynamicPorts, dynamicConfigured } from "../clients/dynamicPorts.js";
import { makeClaudeClassifier, makeClaudeLeakScan, makeClaudeConversation } from "../clients/runwareBrain.js";
import { makeGroqTranscriber } from "../clients/groqStt.js";
import { terac } from "../clients/terac.js";
import { makeTeracDeliver } from "../escalation/teracDelivery.js";
import { ReviewCoordinator } from "../escalation/reviewCoordinator.js";
import { registerReviewRoutes } from "./reviewPage.js";
import { registerDashboardRoutes } from "./dashboardPage.js";
import { buildDashboard } from "../dashboard/buildDashboard.js";
import { toLedgerTxs } from "../dashboard/ledgerAdapter.js";
import { createDashboardLinkStore, dashboardUrl } from "../dashboard/link.js";
import { DEMO_SPEND } from "../dashboard/demoSeed.js";
import type { Range } from "../dashboard/types.js";

/**
 * Verdict server bootstrap: Linq inbound webhook + compliance state + the agent
 * loop. This is the composition root — it wires the ports. Adapters that need
 * live credentials (LLM, STT, Dynamic wallet, Terac) are NOT available yet, so
 * they are wired as fail-closed stubs: the loop is structurally complete and
 * every outbound still passes `canSend()` via `guardedSend` (BR-L4 / fix B2).
 */
const state = new InMemoryComplianceState();

/** Map the compliance store into the shape `canSend()` needs. */
function resolveState(phone: string): SendGuardState {
  return { suppressed: state.isSuppressed(phone), healthStatus: state.lineReputation() };
}

/**
 * Every agent reply goes through the guard — there is no unguarded send path.
 *
 * Returns the sent message's id when one was actually delivered, so a payment
 * proposal can be resolved later by a tapback on that exact message (BR-C2).
 * Undefined means the guard suppressed the send.
 */
async function guardedReply(to: string, body: string): Promise<string | undefined> {
  let messageId: string | undefined;
  await guardedSend(to, [text(body)], resolveState, async (dst, parts) => {
    const result = await linq.send(dst, parts);
    messageId = result.messageId;
  });
  return messageId;
}

// --- Ports (fail-closed stubs until the live adapters are wired) ---

const notConfiguredLlm: LlmClassifier = async () => {
  // No model key in this environment → parseIntent will fall back to "unknown".
  throw new Error("LLM adapter not configured");
};

/**
 * The brain: Claude reached through Runware's OpenAI-compatible endpoint when
 * RUNWARE_API_KEY is set, else the fail-closed stub (parseIntent → "unknown",
 * never guesses money, BR-P10). See ADR-006.
 */
const classify: LlmClassifier = config.RUNWARE_API_KEY
  ? makeClaudeClassifier({ apiKey: config.RUNWARE_API_KEY, model: config.RUNWARE_LLM_MODEL, baseUrl: config.RUNWARE_BASE_URL })
  : notConfiguredLlm;

/**
 * The leak-check LLM layer (BR-A5): an adversarial auditor that runs ON TOP of
 * the deterministic regex floor before any summary is staged for a reviewer.
 * Fail-closed — if the auditor is down it returns a blocking hit. Without
 * RUNWARE_API_KEY it is absent and only the regex floor runs (which still
 * enforces BR-A5's deterministic layer). See ADR-006.
 */
const leakScan = config.RUNWARE_API_KEY
  ? makeClaudeLeakScan({ apiKey: config.RUNWARE_API_KEY, model: config.RUNWARE_LLM_MODEL, baseUrl: config.RUNWARE_BASE_URL })
  : undefined;

/**
 * Speech-to-text: Groq Whisper when GROQ_API_KEY is set, else undefined → the
 * voice branch asks the user to type instead of guessing (BR-V3).
 */
const transcriber: Transcriber | undefined = config.GROQ_API_KEY
  ? makeGroqTranscriber({ apiKey: config.GROQ_API_KEY, model: config.GROQ_STT_MODEL, lang: config.STT_LANG })
  : undefined;

const stubLedger: LedgerPort = {
  answerQuery: async () => "I haven't connected your wallet to answer that yet 🙈 (Dynamic integration pending).",
  buildSummary: async () => ({
    identity: { name: "" },
    categoryTotals: [],
    trendsVsPrior: [],
    behaviorFlags: [],
    totalSpend: 0,
    monthlyIncome: 0,
    exactBalance: 0,
    rawTransactions: [],
  }),
};

/**
 * The live Dynamic ledger replaces the stub once the wallet signs in (BR-D7 makes
 * that async: the MPC SDK is imported lazily). Until then queries still answer,
 * they just answer "not connected" — the loop never blocks on the wallet.
 */
let liveLedger: LedgerPort = stubLedger;

// --- Personal spending dashboard (spec: dashboard-visualization) ------------
// Tokenized-link store + a dashboard-aware ledger wrapper: a "dashboard" query
// mints a token, builds the page data server-side, and answers with the link
// (BR-D2). All other queries pass through to the live/stub ledger untouched.
const dashboardLinks = createDashboardLinkStore();

function rangeOf(action: { params: Record<string, unknown> }): Range {
  const p = String(action.params.period ?? "").toLowerCase();
  if (p.includes("año") || p.includes("12")) return "12meses";
  if (p.includes("trimestre") || p.includes("3")) return "3meses";
  return "mes";
}

/** Delegates per call, so `agentDeps` stays const while the adapter is upgraded. */
const delegatingLedger: LedgerPort = {
  answerQuery: async (action) => {
    if (action.intent === "dashboard") {
      const txs = toLedgerTxs(DEMO_SPEND, config.DYNAMIC_COP_PER_USDC);
      const data = buildDashboard(txs, rangeOf(action), { generatedAt: new Date().toISOString() });
      const token = dashboardLinks.mint(data);
      return `Here's your spending dashboard 📊\n${dashboardUrl(config.PUBLIC_URL, token)}\n(the link expires in 15 min and is yours only)`;
    }
    return liveLedger.answerQuery(action);
  },
  buildSummary: () => liveLedger.buildSummary(),
};

/** The agent wallet, available once the Dynamic adapter signs in. */
let liveWallet: DynamicWallet | undefined;

export function agentWallet(): DynamicWallet | undefined {
  return liveWallet;
}

/**
 * Payment confirmations awaiting a "sí"/👍 (spec: payment-confirmation).
 * Staging happens on `confirm_required`; nothing is signed until resolved.
 */
const pendingActions = new PendingActionStore();

/** Renders a resolved payment for the user (BR-C6 / BR-C7). */
function paymentReply(outcome: ResolveOutcome): string | undefined {
  switch (outcome.kind) {
    case "paid": {
      const link = liveWallet?.explorerUrl(outcome.txRef);
      return `Done, paid ✅\ntx: ${outcome.txRef}${link ? `\n${link}` : ""}`;
    }
    case "cancelled":
      return "Cancelled. Nothing moved.";
    case "failed":
      return `I couldn't complete the payment 🛑\n${outcome.reason}`;
    case "nothing_pending":
      // BR-C5: never infer which payment a bare "sí" meant.
      return undefined;
  }
}

/**
 * Conversational adapter (spec: conversation.spec.md): natural small-talk +
 * factual data answers grounded in the user's own summary. Absent without
 * RUNWARE_API_KEY → the orchestrator degrades to a canned welcome / structured
 * answer (BR-CV4). Read-only: never moves money or reroutes advice (BR-CV3).
 */
const conversation = config.RUNWARE_API_KEY
  ? makeClaudeConversation({ apiKey: config.RUNWARE_API_KEY, model: config.RUNWARE_LLM_MODEL, baseUrl: config.RUNWARE_BASE_URL })
  : undefined;

const agentDeps: OrchestratorDeps = {
  parse: (t) => parseIntent(t, { classify }),
  ledger: delegatingLedger,
  // Live LLM leak auditor when configured; absent → regex floor only (BR-A5).
  ...(leakScan ? { llmLeakScan: leakScan } : {}),
  // Live conversational layer when configured; absent → canned welcome (BR-CV4).
  ...(conversation ? { conversation } : {}),
};

/** Turn an outcome into the user-facing text to send (preview/confirm/reply). */
function outcomeText(outcome: AgentOutcome): string {
  switch (outcome.kind) {
    case "reply":
    case "answer":
    case "reprompt":
    case "blocked":
      return outcome.text;
    case "confirm_required":
      return outcome.text;
    case "escalated":
      return outcome.previewText;
  }
}

// --- Terac human review (spec terac-review) ---

const TERAC_PROJECT = "verdict";
const REVIEW_PANEL = 3;

/** Best-effort recruit: the review page opens regardless; a live Terac failure is swallowed. */
const teracDeliver = config.TERAC_API_KEY
  ? makeTeracDeliver(terac, { projectName: TERAC_PROJECT, numReviewers: REVIEW_PANEL, publicUrl: config.PUBLIC_URL })
  : async () => {
      console.warn("[verdict] Terac not configured — review recruit skipped");
    };

/** Ties escalation → consent → Terac recruit → review page → Dawid–Skene → coaching. */
const reviewCoordinator = new ReviewCoordinator({
  deliver: teracDeliver,
  coach: async (chatId, message) => {
    await guardedReply(chatId, message);
  },
});

const app = buildLinqApp({
  ...(config.LINQ_WEBHOOK_SECRET ? { secret: config.LINQ_WEBHOOK_SECRET } : {}),
  state,
  // The opt-out confirmation is the one send that bypasses the guard (BR-L2).
  send: async (to, body) => {
    await linq.send(to, [text(body)]);
  },
  onAgent: async ({ phone, text: msgText, needsTranscription, audioUrl }) => {
    // Voice note: transcribe first, then run the SAME pipeline as text (BR-V5),
    // flagging fromVoice so money actions echo the transcript for confirmation
    // (BR-V4). No STT / no audio URL / low confidence → ask to type (BR-V3).
    let text = msgText;
    let fromVoice = false;
    if (needsTranscription) {
      if (!transcriber || !audioUrl) {
        await guardedReply(phone, RETRY_PROMPT);
        return;
      }
      const voice = await transcribeVoice(audioUrl, transcriber);
      if (!voice.ok) {
        await guardedReply(phone, RETRY_PROMPT);
        return;
      }
      text = voice.text;
      fromVoice = true;
    }
    // A review awaiting the user's consent: a "sí"/"no" here resolves it (BR-T6).
    if (reviewCoordinator.hasPending(phone)) {
      const consent = await reviewCoordinator.maybeConsent(phone, text);
      if (consent.reply) await guardedReply(phone, consent.reply);
      if (consent.consented || consent.reply) return; // consumed (launched or cancelled)
    }
    // A payment awaiting confirmation: "sí" executes it, "no" drops it (BR-C2).
    // Checked AFTER the review queue on purpose: if both were somehow pending, a
    // "sí" resolving consent moves no money, while the reverse would (BR-C3).
    if (pendingActions.has(phone)) {
      const probe = await agentDeps.parse(text);
      if (probe.intent === "confirm" || probe.intent === "cancel") {
        const wallet = liveWallet;
        if (probe.intent === "cancel" || !wallet) {
          const reply = paymentReply(pendingActions.cancel(phone));
          if (!wallet && probe.intent === "confirm") {
            await guardedReply(phone, "My wallet isn't connected right now, so I didn't execute anything 🙈");
          } else if (reply) {
            await guardedReply(phone, reply);
          }
          return;
        }
        const reply = paymentReply(await pendingActions.resolve(phone, wallet));
        if (reply) await guardedReply(phone, reply);
        return;
      }
    }

    const outcome = await handleAgentMessage(text, fromVoice, agentDeps);
    // On escalation, stage the summary and wait for the user's 👍 (BR-T6).
    if (outcome.kind === "escalated") reviewCoordinator.stageConsent(phone, outcome.anon);

    const sentId = await guardedReply(phone, outcomeText(outcome));

    // Stage AFTER the proposal is sent, so the pending carries that message's id
    // and a tapback on it can resolve the payment (BR-C1/BR-C2).
    if (outcome.kind === "confirm_required") {
      pendingActions.stage(phone, outcome.action, sentId);
    }
  },
  // Tapback on a proposal: 👍 pays, 👎 cancels, anything else is ignored (BR-C2).
  onVote: async ({ messageId, reaction, action }) => {
    const intent = reactionIntent(reaction, action);
    if (intent === "ignore") return;

    const chatId = pendingActions.chatForMessage(messageId);
    if (chatId === undefined) return; // not one of our proposals, or expired (BR-C5)

    const wallet = liveWallet;
    if (intent === "cancel" || !wallet) {
      const reply = paymentReply(pendingActions.cancel(chatId));
      if (reply) await guardedReply(chatId, reply);
      return;
    }

    const reply = paymentReply(await pendingActions.resolve(chatId, wallet));
    if (reply) await guardedReply(chatId, reply);
  },
});

// Reviewer-facing page (BR-T2): Terac points participants at /review/:pseudonym.
registerReviewRoutes(app, {
  getReview: (pseudonym) => reviewCoordinator.reviewCard(pseudonym),
  submitJudgment: async (pseudonym, judgment) => {
    await reviewCoordinator.recordJudgment(pseudonym, judgment);
  },
});

// Personal dashboard page (BR-D2): tokenized link the user opens from iMessage.
registerDashboardRoutes(app, { resolve: (token) => dashboardLinks.resolve(token) });

app
  .listen({ port: config.PORT, host: "0.0.0.0" })
  .then((address) => {
    console.log(`[verdict] listening on ${address}`);
    if (!config.LINQ_WEBHOOK_SECRET) {
      console.warn("[verdict] LINQ_WEBHOOK_SECRET not set — /webhooks/linq will reject all events (fail closed)");
    }
    // Upgrade the ledger/wallet in the background: a slow SIWE sign-in must not
    // delay accepting webhooks, and a failure must leave the stub in place.
    if (dynamicConfigured()) {
      buildDynamicPorts()
        .then((ports) => {
          if (!ports) return;
          liveLedger = ports.ledger;
          liveWallet = ports.wallet;
          console.log(`[verdict] Dynamic agent wallet live on ${ports.wallet.network}: ${ports.address}`);
        })
        .catch((err) => {
          // Fail-closed: keep the stub, say so, keep serving.
          console.error("[verdict] Dynamic wallet unavailable — keeping fail-closed stub:", err);
        });
    } else {
      console.warn("[verdict] Dynamic not configured (DYNAMIC_ENVIRONMENT_ID / _AGENT_SIGNING_TOKEN / _WALLET_PASSWORD) — ledger stubbed");
    }
    console.log(
      `[verdict] brain LLM: ${config.RUNWARE_API_KEY ? `Claude via Runware (${config.RUNWARE_LLM_MODEL})` : "STUB (set RUNWARE_API_KEY)"} · leak-check: ${config.RUNWARE_API_KEY ? "LLM + regex" : "regex-only (set RUNWARE_API_KEY for the LLM layer)"} · voice STT: ${config.GROQ_API_KEY ? `Groq (${config.GROQ_STT_MODEL})` : "STUB (set GROQ_API_KEY)"}`,
    );
  })
  .catch((err) => {
    console.error("[verdict] failed to start:", err);
    process.exit(1);
  });
