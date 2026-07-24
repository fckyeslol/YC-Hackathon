import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Linq webhook signature verification (spec BR-L1). Linq uses TWO schemes;
 * both were checked against Linq's docs and live traffic (2026-07-24), so we
 * accept either (each still requires the correct secret — trying both is safe):
 *
 *  1. **Standard Webhooks (svix)** — production `webhooks create`.
 *     Headers `webhook-id` / `webhook-timestamp` / `webhook-signature`
 *     (`v1,{base64}`). Signed content `{id}.{timestamp}.{body}`. HMAC-SHA256,
 *     base64. Key = base64-decode of the secret after stripping `whsec_`.
 *  2. **Legacy `x-webhook-*`** — the `linq webhooks listen --forward-to` relay
 *     (deprecated). Headers `x-webhook-timestamp` / `x-webhook-signature` (bare
 *     hex). Signed content `{timestamp}.{body}`. HMAC-SHA256, hex. Key = the raw
 *     `whsec_...` string. (Reverse-engineered from a real captured request.)
 *
 * A webhook is processed only if a signature validates AND the timestamp is
 * recent (anti-replay). All checks are pure; the caller passes `now`.
 */

export const DEFAULT_TOLERANCE_SEC = 300;

export interface VerifyInput {
  /** Signing secret, `whsec_<base64>`. */
  secret: string;
  /** `webhook-timestamp` (or legacy `x-webhook-timestamp`), unix seconds. */
  timestamp: number;
  /** Raw request body string, byte-for-byte as received (do not re-serialize). */
  rawBody: string;
  /** The signature header value (`webhook-signature` or legacy `x-webhook-signature`). */
  signatureHeader: string;
  /** Standard Webhooks `webhook-id`. Absent for the legacy scheme. */
  webhookId?: string;
  /** Current time in unix seconds. */
  now: number;
  toleranceSec?: number;
}

/** Raw HMAC key bytes for the Standard Webhooks scheme (base64 after `whsec_`). */
function standardKey(secret: string): Buffer {
  const b64 = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  return Buffer.from(b64, "base64");
}

/** Standard Webhooks: base64(HMAC-SHA256(decoded-key, `{id}.{ts}.{body}`)). */
export function computeStandardSignature(secret: string, webhookId: string, timestamp: number, rawBody: string): string {
  return createHmac("sha256", standardKey(secret)).update(`${webhookId}.${timestamp}.${rawBody}`).digest("base64");
}

/** Legacy x-webhook-*: hex(HMAC-SHA256(raw `whsec_` string, `{ts}.{body}`)). */
export function computeLegacySignature(secret: string, timestamp: number, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

/** Back-compat alias — the Standard Webhooks signature. */
export const computeLinqSignature = computeStandardSignature;

function timingEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}

export function verifyLinqSignature(input: VerifyInput): boolean {
  const tolerance = input.toleranceSec ?? DEFAULT_TOLERANCE_SEC;

  if (!Number.isFinite(input.timestamp)) return false;
  // Anti-replay: reject timestamps outside the tolerance window (past or future).
  if (Math.abs(input.now - input.timestamp) > tolerance) return false;
  if (!input.signatureHeader) return false;

  const candidates: string[] = [computeLegacySignature(input.secret, input.timestamp, input.rawBody)];
  if (input.webhookId) {
    candidates.push(computeStandardSignature(input.secret, input.webhookId, input.timestamp, input.rawBody));
  }

  // Header may carry several space-separated signatures (`v1,{sig}` or bare). Any match passes.
  for (const entry of input.signatureHeader.split(" ")) {
    if (!entry) continue;
    const comma = entry.indexOf(",");
    const token = comma >= 0 ? entry.slice(comma + 1) : entry;
    for (const candidate of candidates) {
      if (timingEqualStr(token, candidate)) return true;
    }
  }
  return false;
}
