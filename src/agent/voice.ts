/**
 * Voice input pipeline (spec: specs/voice-transcription.spec.md).
 *
 * Linq delivers the audio but does NOT transcribe — we do, then the text enters
 * the SAME pipeline as a typed message (BR-V5). The transcriber is injected so
 * this is testable without a live STT model. Fail-safe: dubious audio never
 * becomes an action (BR-V3). Nothing here logs the audio or transcript (BR-V7).
 */

export interface Transcription {
  readonly text: string;
  readonly confidence: number; // 0..1
  readonly lang: string; // default es-CO
}

/** Injected speech-to-text step (Whisper / gpt-4o-transcribe adapter in prod). */
export type Transcriber = (mediaUrl: string) => Promise<Transcription>;

/** Below this, we ask the user to type instead of guessing (calibrable). */
export const MIN_CONFIDENCE = 0.5;

/** What the agent replies when it will not guess a fuzzy transcription (BR-V3). */
export const RETRY_PROMPT = "I couldn't quite catch that audio 🙏 could you type it?";

export type VoiceResult =
  | { readonly ok: true; readonly text: string; readonly confidence: number }
  | { readonly ok: false; readonly reason: "low_confidence" | "failed" };

export async function transcribeVoice(
  mediaUrl: string,
  transcribe: Transcriber,
  minConfidence: number = MIN_CONFIDENCE,
): Promise<VoiceResult> {
  let t: Transcription;
  try {
    t = await transcribe(mediaUrl);
  } catch {
    return { ok: false, reason: "failed" }; // BR-V3: failure -> ask to type, never guess
  }
  if (t.text.trim() === "" || t.confidence < minConfidence) {
    return { ok: false, reason: "low_confidence" }; // BR-V3
  }
  return { ok: true, text: t.text, confidence: t.confidence };
}
