import { describe, it, expect, vi } from "vitest";
import { deriveConfidence, parseGroqTranscription, makeGroqTranscriber } from "./groqStt.js";

/** Build a minimal Response-like object for the injected fetch. */
function fakeResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(8),
  } as unknown as Response;
}

describe("deriveConfidence", () => {
  it("is high for clean speech (logprob near 0, no_speech near 0)", () => {
    const c = deriveConfidence([{ avg_logprob: -0.1, no_speech_prob: 0.02 }]);
    expect(c).toBeGreaterThan(0.8);
  });

  it("is low for noisy audio (very negative logprob, high no_speech)", () => {
    const c = deriveConfidence([{ avg_logprob: -2.5, no_speech_prob: 0.8 }]);
    expect(c).toBeLessThan(0.5);
  });

  it("is 0 with no segments", () => {
    expect(deriveConfidence([])).toBe(0);
    expect(deriveConfidence(undefined)).toBe(0);
  });

  it("stays within [0,1]", () => {
    const c = deriveConfidence([{ avg_logprob: 0, no_speech_prob: 0 }]);
    expect(c).toBeLessThanOrEqual(1);
    expect(c).toBeGreaterThanOrEqual(0);
  });
});

describe("parseGroqTranscription", () => {
  it("trims text and carries language + derived confidence", () => {
    const t = parseGroqTranscription(
      { text: "  ¿en qué gasté este mes?  ", language: "es", segments: [{ avg_logprob: -0.1, no_speech_prob: 0.01 }] },
      "es",
    );
    expect(t.text).toBe("¿en qué gasté este mes?");
    expect(t.lang).toBe("es");
    expect(t.confidence).toBeGreaterThan(0.8);
  });

  it("falls back to the default language when absent", () => {
    const t = parseGroqTranscription({ text: "hola" }, "es");
    expect(t.lang).toBe("es");
    expect(t.confidence).toBe(0);
  });
});

describe("makeGroqTranscriber", () => {
  it("downloads audio then posts to Groq and maps the response", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(null)) // audio download
      .mockResolvedValueOnce(
        fakeResponse({ text: "mandale 200 a Ana", language: "es", segments: [{ avg_logprob: -0.15, no_speech_prob: 0.03 }] }),
      );
    const transcribe = makeGroqTranscriber({ apiKey: "k", model: "whisper-large-v3", lang: "es", fetchImpl });

    const t = await transcribe("https://cdn.linqapp.com/audio.m4a");

    expect(t.text).toBe("mandale 200 a Ana");
    expect(t.confidence).toBeGreaterThan(0.8);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // Second call carries the bearer token to Groq's transcription endpoint.
    const [url, init] = fetchImpl.mock.calls[1]!;
    expect(String(url)).toContain("groq.com");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer k" });
  });

  it("throws when the audio download fails (voice then fails closed to 'failed')", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(fakeResponse(null, false, 404));
    const transcribe = makeGroqTranscriber({ apiKey: "k", model: "whisper-large-v3", lang: "es", fetchImpl });
    await expect(transcribe("https://cdn.linqapp.com/gone.m4a")).rejects.toThrow();
  });

  it("throws when Groq returns a non-2xx (fail closed)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(null))
      .mockResolvedValueOnce(fakeResponse({ error: "bad" }, false, 500));
    const transcribe = makeGroqTranscriber({ apiKey: "k", model: "whisper-large-v3", lang: "es", fetchImpl });
    await expect(transcribe("https://cdn.linqapp.com/audio.m4a")).rejects.toThrow();
  });
});
