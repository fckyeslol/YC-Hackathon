import { z } from "zod";
import type { NormalizedInbound } from "../domain/webhookRouter.js";
import type { Reputation } from "../domain/sendGuard.js";

/**
 * Maps the V3 webhook wire payload → `NormalizedInbound`.
 *
 * Field mapping VERIFIED against a real `message.received` event captured live
 * (2026-07-24): the payload is nested, and inbound text lives in `data.body`
 * (a string), the sender in `data.sender_handle.handle`, the chat in
 * `data.chat.id`, and the message id in `data.id`.
 */

export const linqWebhookEventSchema = z.object({
  api_version: z.string().optional(),
  webhook_version: z.string().optional(),
  // Real payloads use `event_type`; accept `type` as a fallback just in case.
  event_type: z.string().optional(),
  type: z.string().optional(),
  event_id: z.string().min(1),
  created_at: z.string().optional(),
  trace_id: z.string().optional(),
  partner_id: z.string().optional(),
  data: z.record(z.string(), z.unknown()).default({}),
});

export type LinqWebhookEvent = z.infer<typeof linqWebhookEventSchema>;

const asObj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

const AUDIO_EXT = /\.(m4a|aac|mp3|wav|aiff|caf|amr|ogg)$/i;

/** Is this media part audio (by content type or filename/url extension)? */
function isAudioPart(c: Record<string, unknown>): boolean {
  const ct = str(c.content_type);
  if (ct && ct.toLowerCase().startsWith("audio")) return true;
  const name = str(c.filename) ?? str(c.url) ?? str(c.name);
  return name ? AUDIO_EXT.test(name) : false;
}

/** All media parts across the shapes a media message might use. */
function mediaParts(data: Record<string, unknown>): Array<Record<string, unknown>> {
  const candidates: Array<Record<string, unknown>> = [];
  if (Array.isArray(data.attachments)) candidates.push(...(data.attachments as unknown[]).map(asObj));
  if (Array.isArray(data.parts)) candidates.push(...(data.parts as unknown[]).map(asObj));
  return candidates;
}

/** Best-effort audio detection across the shapes a media message might use. */
function hasAudioMedia(data: Record<string, unknown>): boolean {
  return mediaParts(data).some(isAudioPart);
}

/** CDN URL of the first audio part, to download + transcribe (BR-V1/V2). */
function audioMediaUrl(data: Record<string, unknown>): string | undefined {
  const part = mediaParts(data).find(isAudioPart);
  return part ? (str(part.url) ?? str(part.media_url) ?? str(part.download_url)) : undefined;
}

function mapReputation(data: Record<string, unknown>): Reputation | undefined {
  const raw = (
    str(asObj(data.reputation).status) ??
    str(asObj(asObj(data.phone_number).reputation).status) ??
    str(data.reputation) ??
    str(data.status) ??
    ""
  ).toUpperCase();
  if (raw === "HEALTHY" || raw === "AT_RISK" || raw === "CRITICAL") return raw;
  return undefined;
}

export function parseLinqEvent(raw: unknown): NormalizedInbound {
  const ev = linqWebhookEventSchema.parse(raw);
  const eventType = ev.event_type ?? ev.type ?? "";
  const data = ev.data as Record<string, unknown>;
  const base = { eventId: ev.event_id, rawEventType: eventType } as const;

  if (eventType === "message.received") {
    const from = str(asObj(data.sender_handle).handle);
    const text = str(data.body) ?? "";
    const chatId = str(asObj(data.chat).id);
    const messageId = str(data.id);
    const audioUrl = audioMediaUrl(data);
    return {
      ...base,
      type: "message",
      ...(from ? { from } : {}),
      text,
      hasAudio: hasAudioMedia(data),
      ...(audioUrl ? { audioUrl } : {}),
      ...(chatId ? { chatId } : {}),
      ...(messageId ? { messageId } : {}),
    };
  }

  if (eventType === "reaction.added" || eventType === "reaction.removed") {
    const messageId = str(data.message_id) ?? str(asObj(data.message).id) ?? str(data.target_message_id);
    // Real payload uses `reaction_type` (e.g. "love"); accept common aliases too.
    const reaction = str(data.reaction_type) ?? str(data.reaction) ?? str(data.emoji) ?? str(data.type);
    return {
      ...base,
      type: "reaction",
      ...(messageId ? { messageId } : {}),
      ...(reaction ? { reaction } : {}),
      reactionAction: eventType === "reaction.added" ? "add" : "remove",
    };
  }

  if (eventType === "phone_number.status_updated") {
    const reputation = mapReputation(data);
    return { ...base, type: "phone_status", ...(reputation ? { reputation } : {}) };
  }

  return { ...base, type: "other" };
}
