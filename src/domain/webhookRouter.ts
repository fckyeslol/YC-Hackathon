import { isOptOut, isOptIn } from "./optout.js";
import type { ComplianceState } from "./complianceState.js";
import type { Reputation } from "./sendGuard.js";

/**
 * Inbound webhook routing (spec `linq-messaging.spec.md` §1 INBOUND).
 *
 * Operates on a NORMALIZED event so the routing/compliance logic stays stable
 * and independent of Linq's exact wire fields (mapping lives in the server-side
 * parser, which is the ⚠️ VERIFICAR surface). Order matters: dedup → opt-out →
 * opt-in → agent. Opt-out/opt-in are resolved here, BEFORE the intent parser
 * ever sees the text (intent-parser BR-P9).
 */

export interface NormalizedInbound {
  eventId: string;
  type: "message" | "reaction" | "phone_status" | "other";
  rawEventType: string;
  /** message: originating chat id (for replying into the same thread). */
  chatId?: string;
  /** message: sender phone (E.164). */
  from?: string;
  /** message: the message body text. */
  text?: string;
  /** message: true when a media part is audio (routes to transcription, BR-L11). */
  hasAudio?: boolean;
  /** message: CDN URL of the audio part, to download + transcribe (BR-V1/V2). */
  audioUrl?: string;
  messageId?: string;
  /** reaction: emoji/tapback + whether added or removed. */
  reaction?: string;
  reactionAction?: "add" | "remove";
  /** phone_status: new line reputation. */
  reputation?: Reputation;
}

export type RouteAction =
  | { kind: "ignore_duplicate"; eventId: string }
  | { kind: "suppress"; phone: string; confirmation: string }
  | { kind: "reactivate"; phone: string }
  | { kind: "to_agent"; phone: string; text: string; needsTranscription: boolean; audioUrl?: string; messageId?: string }
  | { kind: "resolve_vote"; messageId: string; reaction: string; action: "add" | "remove" }
  | { kind: "update_reputation"; reputation: Reputation }
  | { kind: "observe"; eventType: string };

/** The single confirmation sent on opt-out (BR-L2). It bypasses `canSend` — it IS the allowed message. */
export const OPTOUT_CONFIRMATION =
  "Listo, no volveremos a escribirte. Respondé OPTIN si querés reactivar.";

export function routeLinqEvent(ev: NormalizedInbound, state: ComplianceState): RouteAction {
  // Dedup first: at-least-once delivery with retries.
  if (state.hasSeen(ev.eventId)) return { kind: "ignore_duplicate", eventId: ev.eventId };
  state.markSeen(ev.eventId);

  switch (ev.type) {
    case "message": {
      const phone = ev.from;
      const text = ev.text ?? "";
      // Fail-safe: without a sender we cannot suppress/route — just observe.
      if (!phone) return { kind: "observe", eventType: ev.rawEventType };

      if (isOptOut(text)) {
        // Terminal (BR-L2): if already suppressed, do NOT re-send the confirmation.
        // A repeated STOP must not produce a second outbound.
        if (state.isSuppressed(phone)) return { kind: "observe", eventType: ev.rawEventType };
        state.suppress(phone);
        return { kind: "suppress", phone, confirmation: OPTOUT_CONFIRMATION };
      }
      if (isOptIn(text)) {
        state.clearSuppression(phone);
        return { kind: "reactivate", phone };
      }
      return {
        kind: "to_agent",
        phone,
        text,
        needsTranscription: ev.hasAudio ?? false,
        ...(ev.audioUrl ? { audioUrl: ev.audioUrl } : {}),
        ...(ev.messageId ? { messageId: ev.messageId } : {}),
      };
    }

    case "reaction":
      if (!ev.messageId) return { kind: "observe", eventType: ev.rawEventType };
      return {
        kind: "resolve_vote",
        messageId: ev.messageId,
        reaction: ev.reaction ?? "",
        action: ev.reactionAction ?? "add",
      };

    case "phone_status":
      if (!ev.reputation) return { kind: "observe", eventType: ev.rawEventType };
      state.setReputation(ev.reputation);
      return { kind: "update_reputation", reputation: ev.reputation };

    default:
      return { kind: "observe", eventType: ev.rawEventType };
  }
}
