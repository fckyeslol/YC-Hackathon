import type { LlmClassifier } from "../agent/types.js";
import type { AnonymizedSummary, LeakHit } from "../anonymization/types.js";

/**
 * Live "brain" adapters — Anthropic Claude models reached through Runware's
 * OpenAI-compatible chat-completions endpoint (ADR-006). Runware exposes Claude
 * over the OpenAI protocol, so this talks plain `fetch` to `${base}/chat/completions`
 * (no SDK, keeps the dep tree small — same style as the Groq STT adapter).
 *
 * Two ports plug in here, both against contracts defined elsewhere so this file
 * is the ONLY place that touches the model gateway (composition-root discipline):
 *
 *   1. LlmClassifier (intent-parser BR-P1): text -> raw UNVALIDATED guess.
 *      parseIntent re-validates with Zod and fail-closes to `unknown`.
 *   2. leak-check LLM layer (anonymization BR-A5): scans an AnonymizedSummary
 *      for reidentifying PII. Additive-only and FAIL-CLOSED: on error it BLOCKS.
 *
 * Privacy (BR-A7/BR-V7): nothing here logs message text or summary contents.
 */

// --- Intent classifier (brain: "entender mensajes") ---

/** Kept in sync with the Intent union in agent/types.ts. */
const INTENTS = [
  "pay",
  "split",
  "swap",
  "balance",
  "spending_insight",
  "dashboard",
  "advice",
  "confirm",
  "cancel",
  "smalltalk",
  "unknown",
] as const;

export const CLASSIFIER_SYSTEM = `Sos el parser de intención de Verdict, un asesor financiero que vive en iMessage y le habla a un usuario colombiano.

Tu ÚNICA salida es un objeto JSON (sin texto alrededor, sin \`\`\`) con esta forma:
{
  "intent": uno de ${INTENTS.join(" | ")},
  "confidence": número entre 0 y 1,
  "slots": { ...entidades extraídas... },
  "rawText": el texto original
}

Reglas:
- Clasificá la intención y extraé slots. NO decidas si la acción es riesgosa ni si se auto-ejecuta — eso lo hace otra capa (BR-P4). Solo entendé.
- Slots por intención:
  - pay: amount, currency, recipient, memo
  - split: total, participants (array), recipient
  - swap: from_asset, to_asset, amount
  - balance / spending_insight / dashboard: period, category, scope
  - advice: question
- Dejá los montos coloquiales TAL CUAL ("50 lucas", "medio palo") y los períodos en lenguaje natural ("este mes"): otra capa los normaliza.
- Si falta un dato clave (p.ej. destinatario en un pago), igual clasificá la intención y omití el slot; no lo inventes.
- Español coloquial colombiano e inglés básico. Cualquier otro idioma o mensaje incomprensible → intent "unknown" con confidence baja.
- confirm/cancel: respuestas a una propuesta pendiente ("sí, dale" → confirm). smalltalk: charla. unknown: no entendés.`;

const LEAK_SYSTEM = `Sos un auditor de privacidad adversarial. Recibís un resumen financiero YA anonimizado que se le va a mostrar a un revisor humano externo. Tu trabajo es intentar REIDENTIFICAR al usuario o encontrar cualquier dato crudo filtrado.

Un revisor NUNCA puede ver: nombre, teléfono, email, cédula, número de cuenta, una transacción individual (comercio+monto+fecha), nombre de contraparte, saldo exacto, ni detalle de categorías sensibles (salud, legal, religión, política).

Respondé SOLO con JSON (sin texto alrededor):
{ "hits": [ { "gate": "G1".."G6", "evidence": "el fragmento exacto", "why": "por qué filtra" } ] }

Si el resumen está limpio, devolvé { "hits": [] }. Ante la duda, marcá el hit — es fail-closed: preferimos bloquear de más que filtrar.`;

/**
 * Pull a JSON object out of the model's text, tolerant of stray prose or code
 * fences. Returns `unknown` — parseIntent validates it (BR-P1). Throws if there
 * is no parseable object, so parseIntent fail-closes to `unknown` (BR-P10).
 */
export function extractJson(text: string): unknown {
  const fenced = text.replace(/```(?:json)?/gi, "").trim();
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("no JSON object in model output");
  }
  return JSON.parse(fenced.slice(start, end + 1));
}

/** Parse the model's leak verdict into LeakHit[]. Tolerant; never throws. */
export function parseLeakHits(text: string): LeakHit[] {
  let obj: unknown;
  try {
    obj = extractJson(text);
  } catch {
    // Unparseable verdict from a fail-closed auditor → treat as "cannot clear".
    return [{ gate: "G-LLM", evidence: "unparseable-verdict", why: "leak-check LLM devolvió algo no interpretable; se bloquea (fail-closed)" }];
  }
  const hits = (obj as { hits?: unknown }).hits;
  if (!Array.isArray(hits)) return [];
  return hits
    .filter((h): h is Record<string, unknown> => h !== null && typeof h === "object")
    .map((h) => ({
      gate: typeof h.gate === "string" ? h.gate : "G-LLM",
      evidence: typeof h.evidence === "string" ? h.evidence : "",
      why: typeof h.why === "string" ? h.why : "leak-check LLM",
    }));
}

export interface BrainOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl: string;
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

interface ChatCompletion {
  readonly choices?: readonly { readonly message?: { readonly content?: string } }[];
}

/** One OpenAI-compatible chat call to Runware. Throws on non-2xx. */
async function chat(opts: BrainOptions, system: string, user: string): Promise<string> {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`${opts.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model,
      temperature: 0, // deterministic extraction/audit
      max_tokens: 1024,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`runware chat failed: ${res.status}`);
  const json = (await res.json()) as ChatCompletion;
  return json.choices?.[0]?.message?.content ?? "";
}

/**
 * Real LLM classifier for parseIntent (Claude via Runware). A hard failure
 * THROWS on purpose so the parser catches it and returns `unknown`
 * (fail-closed, BR-P10) — we never fabricate a money action from a broken call.
 */
export function makeClaudeClassifier(opts: BrainOptions): LlmClassifier {
  return async (userText: string): Promise<unknown> => {
    return extractJson(await chat(opts, CLASSIFIER_SYSTEM, userText));
  };
}

/**
 * Async intelligent leak scan over an anonymized summary (Claude via Runware).
 * Returns LeakHit[]: empty means "found nothing" (the regex floor still runs
 * separately). On ANY error it returns a blocking hit — a down auditor must
 * never silently let a summary through (BR-A5 fail-closed).
 *
 * NOTE: leakCheck's `extraScan` port is synchronous, so the caller pre-resolves
 * this promise and hands the result in as `() => hits`.
 */
export function makeClaudeLeakScan(
  opts: BrainOptions,
): (anon: AnonymizedSummary) => Promise<readonly LeakHit[]> {
  return async (anon: AnonymizedSummary): Promise<readonly LeakHit[]> => {
    try {
      return parseLeakHits(await chat(opts, LEAK_SYSTEM, JSON.stringify(anon)));
    } catch {
      return [{ gate: "G-LLM", evidence: "llm-scan-failed", why: "leak-check LLM no disponible; se bloquea el envío (fail-closed)" }];
    }
  };
}
