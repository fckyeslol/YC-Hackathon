import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const schema = z.object({
  LINQ_API_KEY: z.string().min(1, "LINQ_API_KEY missing (run `linq whoami`)"),
  LINQ_NUMBER: z.string().regex(/^\+\d{7,15}$/, "LINQ_NUMBER must be E.164, e.g. +12054011434"),
  TERAC_API_KEY: z.string().min(1, "TERAC_API_KEY missing"),
  /** HMAC secret for Linq webhook verification (BR-L1). Absent → webhooks fail closed (401). */
  LINQ_WEBHOOK_SECRET: z.string().min(1).optional(),

  /**
   * Anthropic key for the "brain" (intent parser, BR-P1) and the intelligent
   * leak-check layer (BR-A5). Absent → the LLM adapter stays a fail-closed stub
   * and parseIntent falls back to `unknown` (never guesses money).
   */
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  /**
   * Claude model for the brain. Defaults to Opus 4.8 (Anthropic guidance).
   * For this classification/leak-check workload, `claude-haiku-4-5` cuts cost
   * ~5x — set it here if you want to stretch the hackathon budget.
   */
  ANTHROPIC_MODEL: z.string().default("claude-opus-4-8"),

  /**
   * Groq key for speech-to-text (voice notes, BR-V2). Absent → voice stays a
   * fail-closed stub: the agent asks the user to type instead of guessing (BR-V3).
   */
  GROQ_API_KEY: z.string().min(1).optional(),
  /** Groq Whisper model for transcription. */
  GROQ_STT_MODEL: z.string().default("whisper-large-v3"),
  /** Default transcription language (BR-V2: Spanish). */
  STT_LANG: z.string().default("es"),

  PORT: z.coerce.number().default(3000),
  /**
   * Public base URL this server is reachable at (no trailing slash).
   * Used to build the Terac task_url and the Linq webhook target.
   * Locally this is set by the tunnel/forwarder; in prod it's the deploy URL.
   */
  PUBLIC_URL: z.string().url().default("http://localhost:3000"),

  // --- Dynamic: agent wallet + on-chain ledger (spec: dynamic-payments) -------
  // All optional: absent → the composition root keeps the fail-closed stub, so
  // the loop and the whole suite still run without wallet credentials.
  DYNAMIC_ENVIRONMENT_ID: z.string().min(1).optional(),
  /** Route 2 (agent wallets) needs no API token; kept for the server-wallet route. */
  DYNAMIC_API_TOKEN: z.string().min(1).optional(),
  /** 32-byte secp256k1 key that IS the agent's Dynamic user identity. */
  DYNAMIC_AGENT_SIGNING_TOKEN: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "DYNAMIC_AGENT_SIGNING_TOKEN must be 0x + 64 hex chars")
    .optional(),
  /** Protects MPC key shares backed up to Dynamic. */
  DYNAMIC_WALLET_PASSWORD: z.string().min(1).optional(),
  /** Origin presented during the agent's SIWE sign-in; must be CORS-allowlisted. */
  DYNAMIC_APP_ORIGIN: z.string().url().default("http://localhost:3000"),
  /** Public RPC by default — a shared/rate-limited key is a demo-time hazard. */
  DYNAMIC_RPC_URL: z.string().url().default("https://sepolia.base.org"),
  /** USDC on Base Sepolia. */
  DYNAMIC_USDC_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .default("0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
  /** Payee book: "mama:0xabc...,juan:0xdef..." — BR-D9 resolves recipients here. */
  DYNAMIC_PAYEES: z.string().default(""),
  /** COP per 1 USDC (BR-D10). Configuration, NOT a market oracle. */
  DYNAMIC_COP_PER_USDC: z.coerce.number().positive().default(4000),
  /** Hard per-transaction ceiling in USDC (BR-D10). */
  DYNAMIC_MAX_USDC_PER_TX: z.coerce.number().positive().default(5),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const config = {
  ...parsed.data,
  LINQ_API_BASE: "https://api.linqapp.com/api/partner/v3",
  TERAC_API_BASE: "https://terac.com/api/external/v2",
} as const;

export type Config = typeof config;
