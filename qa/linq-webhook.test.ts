import { describe, it, expect } from "vitest";
import { routeLinqEvent, type NormalizedInbound } from "../src/domain/webhookRouter.js";
import { InMemoryComplianceState } from "../src/domain/complianceState.js";
import { buildLinqApp } from "../src/server/linqWebhook.js";
import { computeLinqSignature, computeLegacySignature } from "../src/domain/linqSignature.js";
import { parseLinqEvent } from "../src/server/parseLinqEvent.js";

/** Oracle for the INBOUND flow of `specs/linq-messaging.spec.md` §1. */

const ev = (over: Partial<NormalizedInbound> & { eventId: string; rawEventType: string }): NormalizedInbound => ({
  type: "message",
  ...over,
});

describe("webhook router (pure) — INBOUND flow", () => {
  it("dedups by event_id (at-least-once delivery)", () => {
    const state = new InMemoryComplianceState();
    const e = ev({ eventId: "e1", rawEventType: "message.received", from: "+1", text: "hola" });
    expect(routeLinqEvent(e, state).kind).toBe("to_agent");
    expect(routeLinqEvent(e, state)).toEqual({ kind: "ignore_duplicate", eventId: "e1" });
  });

  it("BR-L2 — STOP suppresses the sender and yields the single confirmation", () => {
    const state = new InMemoryComplianceState();
    const action = routeLinqEvent(ev({ eventId: "e2", rawEventType: "message.received", from: "+15551234", text: "STOP" }), state);
    expect(action.kind).toBe("suppress");
    expect(state.isSuppressed("+15551234")).toBe(true);
  });

  it("BR-L2 — a repeated STOP is terminal: no second confirmation", () => {
    const state = new InMemoryComplianceState();
    const first = routeLinqEvent(ev({ eventId: "s1", rawEventType: "message.received", from: "+15559999", text: "STOP" }), state);
    const second = routeLinqEvent(ev({ eventId: "s2", rawEventType: "message.received", from: "+15559999", text: "STOP" }), state);
    expect(first.kind).toBe("suppress"); // first STOP → the single confirmation
    expect(second.kind).toBe("observe"); // already suppressed → no re-confirm
    expect(state.isSuppressed("+15559999")).toBe(true);
  });

  it("BR-L3 — OPTIN clears suppression", () => {
    const state = new InMemoryComplianceState();
    state.suppress("+15551234");
    const action = routeLinqEvent(ev({ eventId: "e3", rawEventType: "message.received", from: "+15551234", text: "OPTIN" }), state);
    expect(action.kind).toBe("reactivate");
    expect(state.isSuppressed("+15551234")).toBe(false);
  });

  it("normal text routes to the agent; audio flags transcription (BR-L11)", () => {
    const state = new InMemoryComplianceState();
    const txt = routeLinqEvent(ev({ eventId: "e4", rawEventType: "message.received", from: "+1", text: "¿puedo gastar 200?" }), state);
    expect(txt).toMatchObject({ kind: "to_agent", needsTranscription: false });
    const audio = routeLinqEvent(ev({ eventId: "e5", rawEventType: "message.received", from: "+1", text: "", hasAudio: true }), state);
    expect(audio).toMatchObject({ kind: "to_agent", needsTranscription: true });
  });

  it("reaction resolves a pending vote; phone status updates reputation", () => {
    const state = new InMemoryComplianceState();
    const r = routeLinqEvent(ev({ eventId: "e6", rawEventType: "reaction.added", type: "reaction", messageId: "m1", reaction: "like", reactionAction: "add" }), state);
    expect(r).toEqual({ kind: "resolve_vote", messageId: "m1", reaction: "like", action: "add" });
    routeLinqEvent(ev({ eventId: "e7", rawEventType: "phone_number.status_updated", type: "phone_status", reputation: "AT_RISK" }), state);
    expect(state.lineReputation()).toBe("AT_RISK");
  });
});

/**
 * A real message.received payload captured live from the RAW webhook (2026-07-25).
 * The inbound text lives in `data.parts[].value` (type "text") — NOT `data.body`.
 * `data.body` only appears in the CLI relay's flattened terminal display; the
 * actual JSON never has it. Reading `body` was the bug that made every inbound
 * text extract as "" → classify as `unknown` → "I didn't quite get that".
 */
const REAL_INBOUND = {
  api_version: "v3",
  webhook_version: "2026-02-03",
  event_type: "message.received",
  event_id: "af907c16-1064-4517-90c5-bf01dac957c9",
  trace_id: "8b81acbd8a158a0ded72d883f2b4bc2e",
  partner_id: "3838d05b-ba83-560c-a3d4-7c5aa61d1f5f",
  data: {
    id: "3b4baae9-41e3-4096-9dbc-bf96a8f91108",
    direction: "inbound",
    service: "iMessage",
    parts: [{ text_decorations: null, type: "text", value: "Hiii" }],
    sender_handle: { handle: "+573187474092", is_me: false, service: "iMessage" },
    chat: { id: "87a2bea6-e50d-4277-b349-7e8ff132e8ae", is_group: false, health_status: { status: "HEALTHY" } },
  },
};

describe("parseLinqEvent — real V3 wire shapes", () => {
  it("extracts inbound text from data.parts[].value (the REAL shape, not data.body)", () => {
    const ev = parseLinqEvent(REAL_INBOUND);
    expect(ev).toMatchObject({
      type: "message",
      eventId: "af907c16-1064-4517-90c5-bf01dac957c9",
      from: "+573187474092",
      text: "Hiii",
      chatId: "87a2bea6-e50d-4277-b349-7e8ff132e8ae",
      messageId: "3b4baae9-41e3-4096-9dbc-bf96a8f91108",
      hasAudio: false,
    });
  });

  it("falls back to data.body when there are no text parts (relay/legacy shape)", () => {
    const ev = parseLinqEvent({
      event_type: "message.received",
      event_id: "legacy-1",
      data: { id: "m0", body: "hola", sender_handle: { handle: "+1" }, chat: { id: "c0" } },
    });
    expect(ev).toMatchObject({ type: "message", text: "hola" });
  });

  it("routes a real inbound to the agent", () => {
    const state = new InMemoryComplianceState();
    const action = routeLinqEvent(parseLinqEvent(REAL_INBOUND), state);
    expect(action).toMatchObject({ kind: "to_agent", phone: "+573187474092", text: "Hiii" });
  });

  it("maps an audio media message to needsTranscription", () => {
    const ev = parseLinqEvent({
      event_type: "message.received",
      event_id: "audio-1",
      data: { id: "m1", body: "", sender_handle: { handle: "+1" }, chat: { id: "c1" }, attachments: [{ content_type: "audio/m4a" }] },
    });
    expect(ev.hasAudio).toBe(true);
  });
});

describe("webhook HTTP (Fastify inject) — BR-L1 + STOP end-to-end (Standard Webhooks)", () => {
  const secret = "whsec_dGVzdC1zZWNyZXQtMTIzNDU2Nzg5MA==";
  const ts = 1_700_000_000;

  function signed(obj: unknown, id: string): { body: string; headers: Record<string, string> } {
    const body = JSON.stringify(obj);
    const sig = computeLinqSignature(secret, id, ts, body);
    return {
      body,
      headers: {
        "content-type": "application/json",
        "webhook-id": id,
        "webhook-timestamp": String(ts),
        "webhook-signature": `v1,${sig}`,
      },
    };
  }

  const inbound = (eventId: string, sender: string, body: string) => ({
    event_type: "message.received",
    event_id: eventId,
    data: { id: `m-${eventId}`, body, direction: "inbound", sender_handle: { handle: sender }, chat: { id: `c-${eventId}` } },
  });

  it("BR-L1 — invalid signature → 401, event not processed", async () => {
    const state = new InMemoryComplianceState();
    const app = buildLinqApp({ secret, state, send: async () => {}, now: () => ts });
    const { body } = signed(inbound("x1", "+1", "STOP"), "x1");
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/linq",
      headers: { "content-type": "application/json", "webhook-id": "x1", "webhook-timestamp": String(ts), "webhook-signature": "v1,ZGVhZGJlZWY=" },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    expect(state.isSuppressed("+1")).toBe(false);
    await app.close();
  });

  it("valid signature + STOP → 200, sender suppressed, one confirmation sent", async () => {
    const state = new InMemoryComplianceState();
    const sent: Array<{ to: string; text: string }> = [];
    const app = buildLinqApp({ secret, state, send: async (to, text) => { sent.push({ to, text }); }, now: () => ts });
    const { body, headers } = signed(inbound("x2", "+15550001", "STOP"), "x2");
    const res = await app.inject({ method: "POST", url: "/webhooks/linq", headers, payload: body });
    expect(res.statusCode).toBe(200);
    expect(state.isSuppressed("+15550001")).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("+15550001");
    await app.close();
  });

  it("valid signature + real inbound → 200, routed to agent", async () => {
    const state = new InMemoryComplianceState();
    const agentSeen: string[] = [];
    const app = buildLinqApp({
      secret,
      state,
      send: async () => {},
      onAgent: ({ text }) => { agentSeen.push(text); },
      now: () => ts,
    });
    const { body, headers } = signed({ ...REAL_INBOUND, event_id: "real-1" }, "real-1");
    const res = await app.inject({ method: "POST", url: "/webhooks/linq", headers, payload: body });
    expect(res.statusCode).toBe(200);
    expect(agentSeen).toEqual(["Hiii"]);
    await app.close();
  });

  it("legacy x-webhook-* scheme (dev relay: hex sig over {ts}.{body}) → 200", async () => {
    const state = new InMemoryComplianceState();
    const agentSeen: string[] = [];
    const app = buildLinqApp({ secret, state, send: async () => {}, onAgent: ({ text }) => { agentSeen.push(text); }, now: () => ts });
    const body = JSON.stringify(inbound("leg1", "+15551234", "hola legacy"));
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/linq",
      headers: {
        "content-type": "application/json",
        "x-webhook-timestamp": String(ts),
        "x-webhook-signature": computeLegacySignature(secret, ts, body), // bare hex, no v1, prefix
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(agentSeen).toEqual(["hola legacy"]);
    await app.close();
  });

  it("anti-replay: stale timestamp → 401", async () => {
    const state = new InMemoryComplianceState();
    const app = buildLinqApp({ secret, state, send: async () => {}, now: () => ts + 10_000 });
    const { body, headers } = signed(inbound("x3", "+1", "hola"), "x3");
    const res = await app.inject({ method: "POST", url: "/webhooks/linq", headers, payload: body });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("no secret configured → fail closed (401)", async () => {
    const state = new InMemoryComplianceState();
    const app = buildLinqApp({ state, send: async () => {}, now: () => ts });
    const { body, headers } = signed(inbound("x4", "+1", "hola"), "x4");
    const res = await app.inject({ method: "POST", url: "/webhooks/linq", headers, payload: body });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
