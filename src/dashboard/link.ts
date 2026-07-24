import { randomBytes } from "node:crypto";
import type { DashboardData } from "./types.js";

/**
 * Tokenized-link store for the personal dashboard (spec BR-D2). A dashboard is
 * minted under an unguessable token with a TTL; without a valid, unexpired token
 * the page is a 404. Never a public, guessable URL with someone's finances.
 *
 * In-memory for the demo (a redeploy drops links; that's fine — they're
 * regenerated on the next request). Clock is injectable for deterministic tests.
 */

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes
const TOKEN_BYTES = 24; // 192 bits of entropy → not guessable

interface Entry {
  readonly data: DashboardData;
  readonly expiresAt: number;
}

export interface DashboardLinkStore {
  /** Mint a token for this dashboard payload. Returns the opaque token. */
  mint(data: DashboardData, ttlMs?: number): string;
  /** Resolve a token to its payload, or undefined if missing/expired (BR-D2). */
  resolve(token: string): DashboardData | undefined;
}

export function createDashboardLinkStore(now: () => number = () => Date.now()): DashboardLinkStore {
  const byToken = new Map<string, Entry>();

  return {
    mint(data, ttlMs = DEFAULT_TTL_MS) {
      const token = randomBytes(TOKEN_BYTES).toString("hex");
      byToken.set(token, { data, expiresAt: now() + ttlMs });
      return token;
    },
    resolve(token) {
      const entry = byToken.get(token);
      if (!entry) return undefined;
      if (now() >= entry.expiresAt) {
        byToken.delete(token); // expired → gone (BR-D2)
        return undefined;
      }
      return entry.data;
    },
  };
}

/** Build the full tokenized URL to hand to Linq as a `link` message part. */
export function dashboardUrl(publicBase: string, token: string): string {
  return `${publicBase.replace(/\/$/, "")}/dashboard/${token}`;
}
