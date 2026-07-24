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
import { buildDynamicPorts, dynamicConfigured } from "../clients/dynamicPorts.js";
import { makeAnthropicClassifier } from "../clients/anthropicBrain.js";
import { makeGroqTranscriber } from "../clients/groqStt.js";
import { terac } from "../clients/terac.js";
import { makeTeracDeliver } from "../escalation/teracDelivery.js";
import { ReviewCoordinator } from "../escalation/reviewCoordinator.js";
import { registerReviewRoutes } from "./reviewPage.js";

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

/** Every agent reply goes through the guard — there is no unguarded send path. */
async function guardedReply(to: string, body: string): Promise<void> {
  await guardedSend(to, [text(body)], resolveState, async (dst, parts) => {
    await linq.send(dst, parts);
  });
}

// --- Ports (fail-closed stubs until the live adapters are wired) ---

const notConfiguredLlm: LlmClassifier = async () => {
  // No model key in this environment → parseIntent will fall back to "unknown".
  throw new Error("LLM adapter not configured");
};

/**
 * The brain: Claude via the official Anthropic SDK when ANTHROPIC_API_KEY is set,
 * else the fail-closed stub (parseIntent → "unknown", never guesses money, BR-P10).
 */
const classify: LlmClassifier = config.ANTHROPIC_API_KEY
  ? makeAnthropicClassifier({ apiKey: config.ANTHROPIC_API_KEY, model: config.ANTHROPIC_MODEL })
  : notConfiguredLlm;

/**
 * Speech-to-text: Groq Whisper when GROQ_API_KEY is set, else undefined → the
 * voice branch asks the user to type instead of guessing (BR-V3).
 */
const transcriber: Transcriber | undefined = config.GROQ_API_KEY
  ? makeGroqTranscriber({ apiKey: config.GROQ_API_KEY, model: config.GROQ_STT_MODEL, lang: config.STT_LANG })
  : undefined;

const stubLedger: LedgerPort = {
  answerQuery: async () => "Todavía no conecté tu billetera para responder eso 🙈 (integración Dynamic pendiente).",
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

/** Delegates per call, so `agentDeps` stays const while the adapter is upgraded. */
const delegatingLedger: LedgerPort = {
  answerQuery: (action) => liveLedger.answerQuery(action),
  buildSummary: () => liveLedger.buildSummary(),
};

/**
 * The agent wallet, available once configured. Execution is deliberately NOT wired
 * to `confirm` here: that hop needs `pending_action` (BR-P7), which belongs to
 * intent-parser.spec and is still listed pending there. Wiring it without that spec
 * would let a bare "sí" pay an action nobody tracked.
 */
let liveWallet: DynamicWallet | undefined;

export function agentWallet(): DynamicWallet | undefined {
  return liveWallet;
}

const agentDeps: OrchestratorDeps = {
  parse: (t) => parseIntent(t, { classify }),
  ledger: delegatingLedger,
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
  coach: (chatId, message) => guardedReply(chatId, message),
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
    const outcome = await handleAgentMessage(text, fromVoice, agentDeps);
    // On escalation, stage the summary and wait for the user's 👍 (BR-T6).
    if (outcome.kind === "escalated") reviewCoordinator.stageConsent(phone, outcome.anon);
    await guardedReply(phone, outcomeText(outcome));
  },
});

// Reviewer-facing page (BR-T2): Terac points participants at /review/:pseudonym.
registerReviewRoutes(app, {
  getReview: (pseudonym) => reviewCoordinator.reviewCard(pseudonym),
  submitJudgment: async (pseudonym, judgment) => {
    await reviewCoordinator.recordJudgment(pseudonym, judgment);
  },
});

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
      `[verdict] brain LLM: ${config.ANTHROPIC_API_KEY ? `Claude (${config.ANTHROPIC_MODEL})` : "STUB (set ANTHROPIC_API_KEY)"} · voice STT: ${config.GROQ_API_KEY ? `Groq (${config.GROQ_STT_MODEL})` : "STUB (set GROQ_API_KEY)"}`,
    );
  })
  .catch((err) => {
    console.error("[verdict] failed to start:", err);
    process.exit(1);
  });
