import { describe, test, expect } from "vitest";
import { transcribeVoice, type Transcriber } from "./voice.js";

const clear: Transcriber = async () => ({ text: "¿en qué gasté este mes?", confidence: 0.92, lang: "es-CO" });
const noisy: Transcriber = async () => ({ text: "algo", confidence: 0.3, lang: "es-CO" });
const broken: Transcriber = async () => {
  throw new Error("stt down");
};

describe("transcribeVoice (BR-V2/V3/V5)", () => {
  test("BR-V5 — a clear note yields text for the same pipeline", async () => {
    const r = await transcribeVoice("cdn://a.m4a", clear);
    expect(r).toEqual({ ok: true, text: "¿en qué gasté este mes?", confidence: 0.92 });
  });

  test("BR-V3 — low confidence does not guess", async () => {
    const r = await transcribeVoice("cdn://a.m4a", noisy);
    expect(r).toEqual({ ok: false, reason: "low_confidence" });
  });

  test("BR-V3 — transcription failure does not guess", async () => {
    const r = await transcribeVoice("cdn://a.m4a", broken);
    expect(r).toEqual({ ok: false, reason: "failed" });
  });

  test("empty transcript is treated as low confidence", async () => {
    const r = await transcribeVoice("cdn://a.m4a", async () => ({ text: "   ", confidence: 0.99, lang: "es-CO" }));
    expect(r.ok).toBe(false);
  });
});
