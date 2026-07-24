import { describe, it, expect } from "vitest";
import { isOptOut, isOptIn, OPT_OUT_KEYWORDS } from "../src/domain/optout.js";
import { canSend, MAX_MSGS_PER_60S_PER_PAIR, type SendGuardState } from "../src/domain/sendGuard.js";
import { verifyLinqSignature, computeLinqSignature } from "../src/domain/linqSignature.js";

/**
 * Oracle ejecutable de la rúbrica `qa/rubrics/linq-compliance.md`.
 * Ejercita los criterios Given/When/Then de `specs/linq-messaging.spec.md`.
 * Compliance es binario: fail-safe hacia "no enviar".
 */

const HEALTHY: SendGuardState = { suppressed: false, healthStatus: "HEALTHY" };

describe("Linq compliance — opt-out (BR-L2 / gates G2, G3)", () => {
  it('BR-L2 — "STOP" exacto marca opt-out y frena todo outbound', () => {
    // Dado un chat activo; Cuando llega el texto exacto "STOP"
    expect(isOptOut("STOP")).toBe(true);

    // Entonces el remitente queda suppressed y canSend() lo bloquea
    const decision = canSend({ ...HEALTHY, suppressed: true });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("suppressed");
  });

  it("BR-L2 — todas las keywords canónicas son opt-out (exactas)", () => {
    for (const kw of OPT_OUT_KEYWORDS) expect(isOptOut(kw)).toBe(true);
    expect(isOptOut("  QUIT  ")).toBe(true); // se permite whitespace alrededor
  });

  it('G3 — case-sensitive: "stop, ¿me explicas eso?" NO es opt-out', () => {
    expect(isOptOut("stop, ¿me explicas eso?")).toBe(false);
    expect(isOptOut("stop")).toBe(false); // minúsculas no matchean
    expect(isOptOut("Please STOP now")).toBe(false); // solo contiene, no es exacto
  });
});

describe("Linq compliance — OPTIN revierte (BR-L3)", () => {
  it("BR-L3 — OPTIN limpia la supresión y canSend vuelve a permitir según salud", () => {
    // Dado un remitente previamente suppressed; Cuando envía "OPTIN"
    expect(isOptIn("OPTIN")).toBe(true);
    expect(isOptIn("optin")).toBe(false); // case-sensitive

    // Entonces, limpiada la supresión, canSend permite según la salud actual
    const decision = canSend({ suppressed: false, healthStatus: "HEALTHY" });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("ok");
  });
});

describe("Linq compliance — canSend gating (BR-L4 / gates G4, G5)", () => {
  it("BR-L4 — CRITICAL pausa el envío", () => {
    const decision = canSend({ suppressed: false, healthStatus: "CRITICAL" });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("critical");
  });

  it("BR-L4 — OPTED_OUT (terminal) nunca envía", () => {
    const decision = canSend({ suppressed: false, healthStatus: "OPTED_OUT" });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("opted_out");
  });

  it("G5 — AT_RISK envía pero con throttle", () => {
    const decision = canSend({ suppressed: false, healthStatus: "AT_RISK" });
    expect(decision.allowed).toBe(true);
    expect(decision.throttle).toBe(true);
  });

  it("HEALTHY envía sin throttle", () => {
    const decision = canSend(HEALTHY);
    expect(decision.allowed).toBe(true);
    expect(decision.throttle).toBeUndefined();
  });

  it("suppressed tiene precedencia sobre la salud (fail-safe)", () => {
    const decision = canSend({ suppressed: true, healthStatus: "HEALTHY" });
    expect(decision).toEqual({ allowed: false, reason: "suppressed" });
  });
});

describe("Linq compliance — volumen/burst (BR-L8 / gate G7)", () => {
  it("G7 — al alcanzar el límite por par (60s) difiere el envío", () => {
    const decision = canSend({ ...HEALTHY, pairCount60s: MAX_MSGS_PER_60S_PER_PAIR });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("rate_limited");
  });

  it("G7 — por debajo del límite envía normal", () => {
    const decision = canSend({ ...HEALTHY, pairCount60s: MAX_MSGS_PER_60S_PER_PAIR - 1 });
    expect(decision.allowed).toBe(true);
  });
});

describe("Linq compliance — HMAC de webhooks (BR-L1 / gate G1, Standard Webhooks)", () => {
  // Real Linq secret format: whsec_ + base64. Here a base64 test key.
  const secret = "whsec_dGVzdC1zZWNyZXQtMTIzNDU2Nzg5MA==";
  const id = "msg_2abc";
  const ts = 1_700_000_000;
  const body = '{"event_type":"message.received","data":{}}';
  const goodSig = `v1,${computeLinqSignature(secret, id, ts, body)}`;

  it("BR-L1 — firma válida y timestamp reciente → se acepta", () => {
    expect(
      verifyLinqSignature({ secret, webhookId: id, timestamp: ts, rawBody: body, signatureHeader: goodSig, now: ts + 5 }),
    ).toBe(true);
  });

  it("BR-L1 — firma inválida se rechaza (handler devuelve 401)", () => {
    const badSig = `v1,${computeLinqSignature("whsec_b3Ryby1zZWNyZXQ=", id, ts, body)}`;
    expect(
      verifyLinqSignature({ secret, webhookId: id, timestamp: ts, rawBody: body, signatureHeader: badSig, now: ts + 5 }),
    ).toBe(false);
  });

  it("BR-L1 — anti-replay: timestamp viejo se rechaza aunque la firma valide", () => {
    expect(
      verifyLinqSignature({ secret, webhookId: id, timestamp: ts, rawBody: body, signatureHeader: goodSig, now: ts + 10_000 }),
    ).toBe(false);
  });

  it("BR-L1 — body alterado invalida la firma", () => {
    const tampered = body.replace("received", "sent");
    expect(
      verifyLinqSignature({ secret, webhookId: id, timestamp: ts, rawBody: tampered, signatureHeader: goodSig, now: ts + 5 }),
    ).toBe(false);
  });

  it("BR-L1 — acepta múltiples firmas en el header (rotación de claves)", () => {
    const header = `v1,AAAA v1,${computeLinqSignature(secret, id, ts, body)}`;
    expect(
      verifyLinqSignature({ secret, webhookId: id, timestamp: ts, rawBody: body, signatureHeader: header, now: ts + 5 }),
    ).toBe(true);
  });
});
