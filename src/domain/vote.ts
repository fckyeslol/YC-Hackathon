import type { Poll } from "../store/types.js";
import type { Reaction } from "../clients/linq.js";

/**
 * Map an inbound iMessage into a vote label for a poll, treating messaging
 * primitives as UI. Returns the option index, or null if unparseable.
 *
 * Reply text is matched (in order) against:
 *   1. a 1-based option number ("2")
 *   2. a letter ("B")
 *   3. the option label text (case-insensitive, substring)
 *
 * Tapbacks map by convention for 2-option polls: 👍/like -> option 0,
 * 👎/dislike -> option 1 (e.g. Yes/No, True/False).
 */
export function parseReplyVote(poll: Poll, replyText: string): number | null {
  const trimmed = replyText.trim();
  if (!trimmed) return null;

  const asNumber = Number.parseInt(trimmed, 10);
  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= poll.options.length) {
    return asNumber - 1;
  }

  if (/^[a-z]$/i.test(trimmed)) {
    const idx = trimmed.toLowerCase().charCodeAt(0) - "a".charCodeAt(0);
    if (idx >= 0 && idx < poll.options.length) return idx;
  }

  const lower = trimmed.toLowerCase();
  const exact = poll.options.findIndex((o) => o.toLowerCase() === lower);
  if (exact >= 0) return exact;

  const substring = poll.options.findIndex(
    (o) => lower.includes(o.toLowerCase()) || o.toLowerCase().includes(lower),
  );
  return substring >= 0 ? substring : null;
}

export function parseReactionVote(poll: Poll, reaction: Reaction): number | null {
  if (poll.options.length !== 2) return null; // tapback shorthand only for binary polls
  if (reaction === "like" || reaction === "love") return 0;
  if (reaction === "dislike") return 1;
  return null;
}
