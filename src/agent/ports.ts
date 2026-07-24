import type { Action } from "./types.js";
import type { Summary } from "../anonymization/types.js";

/**
 * Outbound ports the agent loop depends on. These are CONTRACTS, not
 * implementations — the live adapters (Dynamic wallet, financial ledger) are
 * wired at the composition root. Keeping them as interfaces lets the whole loop
 * be tested end-to-end with fakes, and keeps SDD honest: the Dynamic client
 * (which needs its MCP docs + Base Sepolia) is not written speculatively.
 */

/** Read side: answers queries and builds the escalation context. */
export interface LedgerPort {
  /** Human-facing answer to a read-only query (balance/insight/dashboard). */
  answerQuery(action: Action): Promise<string>;
  /** Internal, PII-bearing summary used ONLY as escalation input (never sent raw). */
  buildSummary(): Promise<Summary>;
}

/** Write side: the Dynamic agent wallet. Testnet only (BR-G5). */
export interface WalletPort {
  readonly network: "base-sepolia";
  /** Execute a money action. Called ONLY after explicit user confirmation (BR-P5). */
  pay(action: Action): Promise<{ txRef: string }>;
}
