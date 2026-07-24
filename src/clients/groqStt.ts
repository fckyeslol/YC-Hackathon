import type { Transcriber, Transcription } from "../agent/voice.js";

/**
 * Live speech-to-text adapter over Groq (Whisper large-v3).
 *
 * Implements the injected `Transcriber` port (voice-transcription BR-V2). Linq
 * does not transcribe, so we download the audio from the Linq CDN URL and post
 * it to Groq's OpenAI-compatible transcription endpoint. Fail-closed: any HTTP
 * or network error THROWS, so transcribeVoice returns `{ ok:false }` and the
 * agent asks the user to type instead of guessing (BR-V3).
 *
 * Privacy (BR-V7): nothing here logs the audio bytes or the transcript.
 */

const GROQ_TRANSCRIBE_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

/** One Whisper segment from a `verbose_json` response (fields we use). */
interface GroqSegment {
  readonly avg_logprob?: number;
  readonly no_speech_prob?: number;
}

interface GroqVerboseResponse {
  readonly text?: string;
  readonly language?: string;
  readonly segments?: readonly GroqSegment[];
}

/**
 * Derive a 0..1 confidence from Whisper segment stats. Whisper has no single
 * confidence field, so we combine per-segment `avg_logprob` (log-prob of the
 * chosen tokens) with `no_speech_prob` (chance the segment is silence/noise):
 *
 *   segmentConfidence = exp(avg_logprob) * (1 - no_speech_prob)
 *
 * and average across segments. Clean speech lands ~0.7–0.95; noisy/empty audio
 * drops below the MIN_CONFIDENCE gate (0.5) so BR-V3 asks the user to retype.
 * No segments → 0 (treated as low confidence).
 */
export function deriveConfidence(segments: readonly GroqSegment[] | undefined): number {
  if (!segments || segments.length === 0) return 0;
  let sum = 0;
  for (const s of segments) {
    const logprob = typeof s.avg_logprob === "number" ? s.avg_logprob : -5;
    const noSpeech = typeof s.no_speech_prob === "number" ? s.no_speech_prob : 1;
    const conf = Math.exp(logprob) * (1 - noSpeech);
    sum += conf;
  }
  const avg = sum / segments.length;
  return Math.max(0, Math.min(1, avg));
}

/** Map a Groq verbose_json response to the Transcription port shape. */
export function parseGroqTranscription(res: GroqVerboseResponse, fallbackLang: string): Transcription {
  return {
    text: (res.text ?? "").trim(),
    confidence: deriveConfidence(res.segments),
    lang: res.language ?? fallbackLang,
  };
}

export interface GroqSttOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly lang: string;
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

export function makeGroqTranscriber(opts: GroqSttOptions): Transcriber {
  const doFetch = opts.fetchImpl ?? fetch;
  return async (mediaUrl: string): Promise<Transcription> => {
    // 1. Download the audio from the Linq CDN.
    const audioRes = await doFetch(mediaUrl);
    if (!audioRes.ok) throw new Error(`audio download failed: ${audioRes.status}`);
    const audioBytes = await audioRes.arrayBuffer();

    // 2. Send to Groq Whisper (multipart form).
    const form = new FormData();
    form.append("file", new Blob([audioBytes]), "audio.m4a");
    form.append("model", opts.model);
    form.append("language", opts.lang);
    form.append("response_format", "verbose_json");

    const sttRes = await doFetch(GROQ_TRANSCRIBE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      body: form,
    });
    if (!sttRes.ok) throw new Error(`groq transcription failed: ${sttRes.status}`);

    const json = (await sttRes.json()) as GroqVerboseResponse;
    return parseGroqTranscription(json, opts.lang);
  };
}
