import { describe, it, expect } from "vitest";
import { extractJson, parseLeakHits } from "./anthropicBrain.js";

/**
 * Tests cover the PURE mapping helpers (JSON extraction + leak-hit parsing).
 * The network calls are thin wrappers over the Anthropic SDK and are exercised
 * live, not here. The contract that matters: the classifier's raw output is
 * re-validated by parseIntent (BR-P1), and the leak layer is fail-closed (BR-A5).
 */

describe("extractJson", () => {
  it("parses a bare JSON object", () => {
    expect(extractJson('{"intent":"pay","confidence":0.9,"slots":{}}')).toEqual({
      intent: "pay",
      confidence: 0.9,
      slots: {},
    });
  });

  it("tolerates code fences and surrounding prose", () => {
    const out = extractJson('Aquí tenés:\n```json\n{"intent":"balance","confidence":0.8}\n```\n');
    expect(out).toEqual({ intent: "balance", confidence: 0.8 });
  });

  it("throws when there is no JSON object (parser then fails closed to unknown)", () => {
    expect(() => extractJson("no puedo ayudarte con eso")).toThrow();
  });
});

describe("parseLeakHits (BR-A5 fail-closed)", () => {
  it("returns [] for a clean verdict", () => {
    expect(parseLeakHits('{"hits":[]}')).toEqual([]);
  });

  it("maps hits with gate/evidence/why", () => {
    const hits = parseLeakHits('{"hits":[{"gate":"G2","evidence":"Juan Pérez","why":"nombre propio"}]}');
    expect(hits).toEqual([{ gate: "G2", evidence: "Juan Pérez", why: "nombre propio" }]);
  });

  it("blocks on an unparseable verdict instead of passing", () => {
    const hits = parseLeakHits("el modelo se cayó");
    expect(hits.length).toBe(1);
    expect(hits[0]!.gate).toBe("G-LLM");
  });

  it("fills defaults for a malformed hit object", () => {
    const hits = parseLeakHits('{"hits":[{"evidence":"algo"}]}');
    expect(hits[0]).toEqual({ gate: "G-LLM", evidence: "algo", why: "leak-check LLM" });
  });
});
