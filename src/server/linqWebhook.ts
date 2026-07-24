import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { verifyLinqSignature } from "../domain/linqSignature.js";
import { routeLinqEvent, type RouteAction } from "../domain/webhookRouter.js";
import type { ComplianceState } from "../domain/complianceState.js";
import { parseLinqEvent } from "./parseLinqEvent.js";

/**
 * Fastify wiring for `POST /webhooks/linq` (spec §1 INBOUND).
 * Flow: raw body → verify HMAC (BR-L1, fail closed) → parse → route → execute.
 * The plugin is dependency-injected so it can be exercised with `app.inject`
 * without a live Linq token or the real config.
 */

export interface LinqWebhookDeps {
  /** HMAC secret. Absent → every webhook is rejected 401 (fail closed). */
  secret?: string;
  state: ComplianceState;
  /** Sends the single opt-out confirmation. It bypasses `canSend` by design (BR-L2). */
  send: (to: string, text: string) => Promise<void>;
  /** Optional downstream hooks; no-ops if omitted. */
  onAgent?: (input: { phone: string; text: string; needsTranscription: boolean; audioUrl?: string; messageId?: string }) => Promise<void> | void;
  onVote?: (input: { messageId: string; reaction: string; action: "add" | "remove" }) => Promise<void> | void;
  onReactivate?: (phone: string) => Promise<void> | void;
  toleranceSec?: number;
  /** Injectable clock (unix seconds) for testing anti-replay. */
  now?: () => number;
}

interface RawBodyRequest extends FastifyRequest {
  rawBody?: string;
}

/**
 * Parse Standard Webhooks headers (`webhook-id` / `webhook-timestamp` /
 * `webhook-signature`), falling back to the legacy `x-webhook-*` names.
 */
export function parseSignatureHeaders(headers: Record<string, unknown>): {
  webhookId: string | null;
  timestamp: number | null;
  signatureHeader: string | null;
} {
  const h = (name: string): string | null => (typeof headers[name] === "string" ? (headers[name] as string) : null);

  const webhookId = h("webhook-id") ?? h("x-webhook-id");
  const tsRaw = h("webhook-timestamp") ?? h("x-webhook-timestamp");
  const signatureHeader = h("webhook-signature") ?? h("x-webhook-signature");
  const timestamp = tsRaw !== null && Number.isFinite(Number(tsRaw)) ? Number(tsRaw) : null;

  return { webhookId, timestamp, signatureHeader };
}

async function executeAction(action: RouteAction, deps: LinqWebhookDeps): Promise<void> {
  switch (action.kind) {
    case "suppress":
      await deps.send(action.phone, action.confirmation);
      return;
    case "reactivate":
      await deps.onReactivate?.(action.phone);
      return;
    case "to_agent":
      await deps.onAgent?.({
        phone: action.phone,
        text: action.text,
        needsTranscription: action.needsTranscription,
        ...(action.audioUrl ? { audioUrl: action.audioUrl } : {}),
        ...(action.messageId ? { messageId: action.messageId } : {}),
      });
      return;
    case "resolve_vote":
      await deps.onVote?.({ messageId: action.messageId, reaction: action.reaction, action: action.action });
      return;
    case "update_reputation":
      // Reputation is applied to state inside the router; nothing to do here.
      return;
    case "ignore_duplicate":
    case "observe":
      return;
  }
}

export function buildLinqApp(deps: LinqWebhookDeps): FastifyInstance {
  // Body logging is intentionally off: webhook payloads carry PII (BR-L12).
  const app = Fastify({ logger: false });

  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const raw = typeof body === "string" ? body : body.toString();
    (_req as RawBodyRequest).rawBody = raw;
    try {
      done(null, raw ? JSON.parse(raw) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.get("/health", async () => ({ ok: true }));

  app.post("/webhooks/linq", async (request, reply) => {
    // BR-L1: no secret configured → fail closed.
    if (!deps.secret) return reply.code(401).send({ error: "webhook secret not configured" });

    const raw = (request as RawBodyRequest).rawBody ?? "";
    const { webhookId, timestamp, signatureHeader } = parseSignatureHeaders(request.headers as Record<string, unknown>);
    const now = deps.now ? deps.now() : Math.floor(Date.now() / 1000);

    if (
      timestamp === null ||
      signatureHeader === null ||
      !verifyLinqSignature({
        secret: deps.secret,
        timestamp,
        rawBody: raw,
        signatureHeader,
        // webhookId is present for Standard Webhooks, absent for the legacy scheme.
        ...(webhookId !== null ? { webhookId } : {}),
        now,
        ...(deps.toleranceSec !== undefined ? { toleranceSec: deps.toleranceSec } : {}),
      })
    ) {
      return reply.code(401).send({ error: "invalid signature" });
    }

    let action: RouteAction;
    try {
      const event = parseLinqEvent(JSON.parse(raw));
      action = routeLinqEvent(event, deps.state);
    } catch {
      return reply.code(400).send({ error: "invalid payload" });
    }

    await executeAction(action, deps);
    return reply.code(200).send({ ok: true, action: action.kind });
  });

  return app;
}
