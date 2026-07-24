import { config } from "../config.js";

/**
 * Message part shapes accepted by V3 send endpoints.
 *
 * `imessage_app` (native interactive card) is intentionally absent: it requires
 * a native Apple-registered iMessage extension and is out of scope
 * (spec BR-L10 / ADR-004). The product "card" is built from `link` + tapbacks.
 */
export type MessagePart =
  | { type: "text"; value: string }
  | { type: "media"; attachment_id: string }
  | { type: "media"; url: string }
  | { type: "link"; url: string };

/** 11 screen effects + 4 bubble effects (V3). */
export type ScreenEffect =
  | "confetti"
  | "fireworks"
  | "lasers"
  | "sparkles"
  | "balloons"
  | "love"
  | "spotlight"
  | "echo"
  | "shooting_star"
  | "celebration"
  | "happy_birthday";
export type BubbleEffect = "slam" | "loud" | "gentle" | "invisible_ink";
export type Effect = ScreenEffect | BubbleEffect;

/** Protocol targeting (V3 `preferred_service`). */
export type PreferredService = "iMessage" | "RCS" | "SMS";

/** Tapback / custom emoji reaction. V3 allows any emoji on top of the standard set. */
export type Reaction =
  | "like"
  | "dislike"
  | "love"
  | "laugh"
  | "emphasize"
  | "question"
  | (string & {});

/** Threaded reply target (V3 full threading). */
export interface ReplyTo {
  message_id: string;
  part_index?: number;
}

export interface SendOptions {
  effect?: Effect;
  replyTo?: ReplyTo;
  preferredService?: PreferredService;
  /** Linq idempotency key; dedupes retries of the same logical send. */
  idempotencyKey?: string;
}

export const text = (value: string): MessagePart => ({ type: "text", value });
export const link = (url: string): MessagePart => ({ type: "link", url });
export const media = (attachmentId: string): MessagePart => ({ type: "media", attachment_id: attachmentId });

/** Structured V3 error: carries numeric `code` and `traceId` for support/debugging. */
export class LinqApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    readonly traceId?: string,
    readonly docUrl?: string,
  ) {
    super(message);
    this.name = "LinqApiError";
  }
}

/** Result of a send: chat + message ids plus V3 async/deliverability metadata. */
export interface SendResult {
  chatId: string;
  messageId: string;
  /** `null` on the initial response; confirmed later via the `message.delivered` webhook. */
  service: string | null;
  /** Why Linq picked the sending line (BR-L5); `null` if not reported. */
  fromSelectionReason: string | null;
  /** V3 `X-Trace-ID` — log it to correlate this request with its webhook events. */
  traceId: string | null;
}

interface RawSendResponse {
  chat_id: string;
  message: { id: string; delivery_status?: string; service?: string | null; parts?: MessagePart[] };
  from_selection?: { reason?: string };
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Thin, typed transport wrapper over the Linq partner API **v3**.
 *
 * Scope: transport only. It deliberately does NOT decide *whether* a send is
 * allowed — opt-out suppression, health/reputation gating and `canSend()` live
 * in the compliance layer (spec `linq-messaging.spec.md`, still pending). This
 * client never logs PII (phone numbers, message content, media URLs) — BR-L12.
 *
 * V3 vs V2: async model. Send returns a `message_id` immediately plus a
 * `trace_id` in the `X-Trace-ID` header; outcomes arrive via webhooks
 * (`message.sent` → `message.delivered` | `message.failed`).
 */
export class LinqClient {
  constructor(
    private readonly apiKey: string = config.LINQ_API_KEY,
    private readonly base: string = config.LINQ_API_BASE,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<{ body: T; traceId: string | null }> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...extraHeaders,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    const traceId = res.headers.get("X-Trace-ID");

    if (!res.ok) {
      throw await this.toError(res, method, path);
    }
    if (res.status === 204) return { body: undefined as T, traceId };
    return { body: (await res.json()) as T, traceId };
  }

  /** Parse the V3 structured error envelope; fall back to raw text. */
  private async toError(res: Response, method: string, path: string): Promise<LinqApiError> {
    const raw = await res.text().catch(() => "");
    try {
      const parsed = JSON.parse(raw) as {
        error?: { status?: number; code?: number; message?: string; doc_url?: string };
        trace_id?: string;
      };
      if (parsed.error) {
        return new LinqApiError(
          `Linq ${method} ${path} -> ${res.status} (code ${parsed.error.code}): ${parsed.error.message ?? ""}`,
          parsed.error.status ?? res.status,
          parsed.error.code,
          parsed.trace_id ?? res.headers.get("X-Trace-ID") ?? undefined,
          parsed.error.doc_url,
        );
      }
    } catch {
      // not JSON; fall through to raw
    }
    return new LinqApiError(
      `Linq ${method} ${path} -> ${res.status}: ${raw.slice(0, 200)}`,
      res.status,
      undefined,
      res.headers.get("X-Trace-ID") ?? undefined,
    );
  }

  private buildMessage(parts: MessagePart[], opts: SendOptions): Record<string, unknown> {
    const message: Record<string, unknown> = { parts };
    // `effect` is an object inside `message` (verified live: response echoes {name, type}).
    if (opts.effect) message.effect = { name: opts.effect };
    if (opts.replyTo) {
      message.reply_to = { message_id: opts.replyTo.message_id, ...(opts.replyTo.part_index !== undefined ? { part_index: opts.replyTo.part_index } : {}) };
    }
    if (opts.preferredService) message.preferred_service = opts.preferredService;
    return message;
  }

  /**
   * Primary send (BR-L5 / ADR-004): `POST /v3/messages` with `to` and **no `from`**.
   * Linq selects the line, balances and fails over; we surface `from_selection.reason`.
   * Resolves the chat automatically — do NOT pre-create a chat with `from`.
   */
  async send(to: string, parts: MessagePart[], opts: SendOptions = {}): Promise<SendResult> {
    // Verified against the live V3 API: `to` is an ARRAY and parts nest under `message`.
    // Setting `from` is rejected by the API (403 code 2006) — BR-L5 enforced server-side.
    const { body, traceId } = await this.request<RawSendResponse>(
      "POST",
      "/messages",
      { to: [to], message: this.buildMessage(parts, opts) },
      opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : undefined,
    );
    return {
      chatId: body.chat_id,
      messageId: body.message.id,
      service: body.message.service ?? null,
      fromSelectionReason: body.from_selection?.reason ?? null,
      traceId,
    };
  }

  /** Send a follow-up into an existing chat: `POST /v3/chats/{chatId}/messages`. */
  async sendToChat(chatId: string, parts: MessagePart[], opts: SendOptions = {}): Promise<SendResult> {
    const { body, traceId } = await this.request<RawSendResponse>(
      "POST",
      `/chats/${chatId}/messages`,
      { message: this.buildMessage(parts, opts) },
      opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : undefined,
    );
    return {
      chatId: body.chat_id ?? chatId,
      messageId: body.message.id,
      service: body.message.service ?? null,
      fromSelectionReason: body.from_selection?.reason ?? null,
      traceId,
    };
  }

  /** Add or remove a reaction/tapback: `POST /v3/messages/{messageId}/reactions` (message-scoped in V3). */
  async react(messageId: string, reaction: Reaction, action: "add" | "remove" = "add"): Promise<void> {
    await this.request("POST", `/messages/${messageId}/reactions`, { reaction, action });
  }

  async startTyping(chatId: string): Promise<void> {
    await this.request("POST", `/chats/${chatId}/typing`);
  }

  async stopTyping(chatId: string): Promise<void> {
    await this.request("DELETE", `/chats/${chatId}/typing`);
  }

  async listMessages(chatId: string, limit = 20): Promise<LinqMessage[]> {
    const { body } = await this.request<{ data: LinqMessage[] }>(
      "GET",
      `/chats/${chatId}/messages?limit=${limit}`,
    );
    return body.data;
  }

  /** Check whether a recipient is reachable over iMessage: `POST /v3/capability/check_imessage`. Body uses `address`. */
  async checkImessage(address: string): Promise<{ available: boolean }> {
    const { body } = await this.request<{ available: boolean }>("POST", "/capability/check_imessage", { address });
    return body;
  }

  /**
   * Step 1 of the presigned attachment flow: `POST /v3/attachments`.
   * Returns the `attachment_id` to reference in a `media` part and the S3 upload URL.
   * ⚠️ VERIFICAR: response field names against the Attachments guide.
   */
  async createAttachment(input: {
    filename: string;
    content_type: string;
    size_bytes: number;
  }): Promise<{ attachment_id: string; upload_url: string }> {
    const { body } = await this.request<{ attachment_id: string; upload_url: string }>(
      "POST",
      "/attachments",
      input,
    );
    return body;
  }

  /** Step 2: PUT the bytes to the presigned S3 URL (no Linq auth header, raw body). */
  async uploadToPresigned(uploadUrl: string, bytes: Uint8Array | Blob, contentType: string): Promise<void> {
    const res = await this.fetchImpl(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: bytes as NonNullable<RequestInit["body"]>,
    });
    if (!res.ok) {
      throw new LinqApiError(`Linq attachment upload -> ${res.status}`, res.status);
    }
  }

  /** Register a webhook subscription: `POST /v3/webhook-subscriptions` (hyphenated in V3). */
  async createWebhookSubscription(url: string, events: string[]): Promise<{ id: string }> {
    const { body } = await this.request<{ id: string }>("POST", "/webhook-subscriptions", { url, events });
    return body;
  }
}

export interface LinqMessage {
  id: string;
  chat_id: string;
  parts: MessagePart[];
  sent_at: string;
  is_from_me: boolean;
  service: string;
}

export const linq = new LinqClient();
