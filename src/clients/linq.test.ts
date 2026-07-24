import { describe, it, expect } from "vitest";
import { LinqClient, LinqApiError, text, media, type FetchLike } from "./linq.js";

/** Capture the outgoing request so we can assert on the V3 wire format. */
interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(
  captured: Captured[],
  response: { status?: number; json?: unknown; text?: string; headers?: Record<string, string> },
): FetchLike {
  return async (url, init) => {
    const rawBody = init.body;
    captured.push({
      url,
      method: init.method ?? "GET",
      headers: (init.headers as Record<string, string>) ?? {},
      body: typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody,
    });
    const status = response.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => response.headers?.[k] ?? null } as unknown as Headers,
      json: async () => response.json,
      text: async () => response.text ?? JSON.stringify(response.json ?? ""),
    } as Response;
  };
}

const SEND_OK = {
  json: { chat_id: "chat-uuid", message: { id: "msg-uuid", service: null }, from_selection: { reason: "balanced" } },
  headers: { "X-Trace-ID": "trace-123" },
};

describe("LinqClient V3 transport", () => {
  it("send() posts to /messages with `to` and NO `from` (BR-L5)", async () => {
    // Arrange
    const captured: Captured[] = [];
    const client = new LinqClient("tok", "https://api.linqapp.com/api/partner/v3", fakeFetch(captured, SEND_OK));

    // Act
    await client.send("+12025550001", [text("hola")]);

    // Assert
    const req = captured[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://api.linqapp.com/api/partner/v3/messages");
    // Verified against live API: `to` is an array, parts nest under `message`.
    expect(req.body).toEqual({ to: ["+12025550001"], message: { parts: [{ type: "text", value: "hola" }] } });
    expect(req.body).not.toHaveProperty("from");
    expect((req.body as { message: object }).message).not.toHaveProperty("from");
  });

  it("send() uses Authorization: Bearer <token>", async () => {
    const captured: Captured[] = [];
    const client = new LinqClient("tok", "https://x/v3", fakeFetch(captured, SEND_OK));
    await client.send("+1", [text("hi")]);
    expect(captured[0]!.headers.Authorization).toBe("Bearer tok");
  });

  it("send() surfaces from_selection.reason and the X-Trace-ID header", async () => {
    const captured: Captured[] = [];
    const client = new LinqClient("tok", "https://x/v3", fakeFetch(captured, SEND_OK));
    const res = await client.send("+1", [text("hi")]);
    expect(res.messageId).toBe("msg-uuid");
    expect(res.chatId).toBe("chat-uuid");
    expect(res.service).toBeNull();
    expect(res.fromSelectionReason).toBe("balanced");
    expect(res.traceId).toBe("trace-123");
  });

  it("send() wraps effect, reply_to and preferred_service inside `message`", async () => {
    const captured: Captured[] = [];
    const client = new LinqClient("tok", "https://x/v3", fakeFetch(captured, SEND_OK));
    await client.send("+1", [text("hi")], {
      effect: "confetti",
      replyTo: { message_id: "m1", part_index: 0 },
      preferredService: "iMessage",
      idempotencyKey: "idem-1",
    });
    const msg = (captured[0]!.body as { message: Record<string, unknown> }).message;
    expect(msg.effect).toEqual({ name: "confetti" });
    expect(msg.reply_to).toEqual({ message_id: "m1", part_index: 0 });
    expect(msg.preferred_service).toBe("iMessage");
    expect(captured[0]!.headers["Idempotency-Key"]).toBe("idem-1");
  });

  it("react() is message-scoped: POST /messages/{id}/reactions (no chatId)", async () => {
    const captured: Captured[] = [];
    const client = new LinqClient("tok", "https://x/v3", fakeFetch(captured, { status: 204 }));
    await client.react("msg-uuid", "like");
    expect(captured[0]!.url).toBe("https://x/v3/messages/msg-uuid/reactions");
    expect(captured[0]!.body).toEqual({ reaction: "like", action: "add" });
  });

  it("createWebhookSubscription() hits the hyphenated /webhook-subscriptions path", async () => {
    const captured: Captured[] = [];
    const client = new LinqClient("tok", "https://x/v3", fakeFetch(captured, { json: { id: "wh-1" } }));
    await client.createWebhookSubscription("https://me/hook", ["message.received"]);
    expect(captured[0]!.url).toBe("https://x/v3/webhook-subscriptions");
  });

  it("media part references an attachment_id (not a URL)", async () => {
    const captured: Captured[] = [];
    const client = new LinqClient("tok", "https://x/v3", fakeFetch(captured, SEND_OK));
    await client.send("+1", [media("att-uuid")]);
    const parts = (captured[0]!.body as { message: { parts: unknown[] } }).message.parts;
    expect(parts).toEqual([{ type: "media", attachment_id: "att-uuid" }]);
  });

  it("parses the V3 structured error envelope into LinqApiError (code + trace_id)", async () => {
    const client = new LinqClient(
      "tok",
      "https://x/v3",
      fakeFetch([], {
        status: 400,
        text: JSON.stringify({
          success: false,
          error: { status: 400, code: 1005, message: "invalid chatId format", doc_url: "https://d/1005" },
          trace_id: "trace-err",
        }),
      }),
    );
    await expect(client.send("+1", [text("hi")])).rejects.toMatchObject({
      name: "LinqApiError",
      status: 400,
      code: 1005,
      traceId: "trace-err",
      docUrl: "https://d/1005",
    });
    await expect(client.send("+1", [text("hi")])).rejects.toBeInstanceOf(LinqApiError);
  });
});
