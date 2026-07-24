import Fastify, { type FastifyInstance } from "fastify";
import type { AnonymizedSummary } from "../anonymization/types.js";

/**
 * The reviewer-facing page (spec terac-review BR-T2). Terac points each task at
 * `GET /review/:pseudonym`; the reviewer sees ONLY the AnonymizedSummary (no
 * identity, no raw transactions) and returns a structured judgment.
 *
 * Resolution is by rotating pseudonym — never by user id/phone (no linkability).
 * Dependency-injected so it runs under `app.inject` without a live backend.
 */

export interface ReviewCard {
  readonly anon: AnonymizedSummary;
  /** The question the reviewer answers, e.g. "¿Apruebas este consejo?" */
  readonly prompt: string;
  /** Ordered option labels; the reviewer picks one → its index is the vote. */
  readonly options: readonly string[];
}

export interface ReviewPageDeps {
  getReview: (pseudonym: string) => ReviewCard | undefined;
  submitJudgment: (pseudonym: string, judgment: { label: number; adviceText?: string }) => Promise<void>;
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

function renderCard(pseudonym: string, card: ReviewCard): string {
  const breakdown = card.anon.categoryBreakdown
    .map((c) => `<li>${esc(c.category)}: <strong>${c.pct}%</strong></li>`)
    .join("");
  const trends = card.anon.trendsVsPrior
    .map((t) => `<li>${esc(t.category)}: ${t.deltaPct > 0 ? "+" : ""}${t.deltaPct}%</li>`)
    .join("");
  const flags = card.anon.behaviorFlags.map((f) => `<li>${esc(f)}</li>`).join("");
  const buckets = card.anon.amountBuckets.map((b) => `<li>${esc(b.label)}: ${esc(b.bucket)}</li>`).join("");
  const opts = card.options
    .map((o, i) => `<label><input type="radio" name="label" value="${i}" required> ${esc(o)}</label>`)
    .join("<br>");

  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="robots" content="noindex"><title>Revisión anónima</title></head>
<body>
<h1>Revisión anónima — ${esc(pseudonym)}</h1>
<p>Estás viendo un <strong>perfil anónimo</strong>. No hay identidad ni transacciones individuales.</p>
<h2>Reparto por categoría</h2><ul>${breakdown}</ul>
${trends ? `<h2>Tendencias vs. período previo</h2><ul>${trends}</ul>` : ""}
${flags ? `<h2>Señales</h2><ul>${flags}</ul>` : ""}
${buckets ? `<h2>Montos (rangos)</h2><ul>${buckets}</ul>` : ""}
<hr>
<form method="POST" action="/review/${encodeURIComponent(pseudonym)}">
  <h2>${esc(card.prompt)}</h2>
  ${opts}
  <p><label>Consejo (opcional):<br><textarea name="adviceText" rows="3" cols="40"></textarea></label></p>
  <button type="submit">Enviar</button>
</form>
</body></html>`;
}

/** Register the review routes on an existing Fastify app (used by the server root). */
export function registerReviewRoutes(app: FastifyInstance, deps: ReviewPageDeps): void {
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    try {
      const params = new URLSearchParams(typeof body === "string" ? body : body.toString());
      const obj: Record<string, string> = {};
      for (const [k, v] of params) obj[k] = v;
      done(null, obj);
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.get<{ Params: { pseudonym: string } }>("/review/:pseudonym", async (request, reply) => {
    const card = deps.getReview(request.params.pseudonym);
    if (!card) return reply.code(404).type("text/html").send("<h1>Revisión no encontrada</h1>");
    return reply.code(200).type("text/html").send(renderCard(request.params.pseudonym, card));
  });

  app.post<{ Params: { pseudonym: string }; Body: { label?: string; adviceText?: string } }>(
    "/review/:pseudonym",
    async (request, reply) => {
      const card = deps.getReview(request.params.pseudonym);
      if (!card) return reply.code(404).send({ error: "review not found" });

      const label = Number.parseInt(request.body?.label ?? "", 10);
      if (!Number.isInteger(label) || label < 0 || label >= card.options.length) {
        return reply.code(400).send({ error: "invalid label" });
      }

      const advice = request.body?.adviceText?.trim();
      await deps.submitJudgment(request.params.pseudonym, {
        label,
        ...(advice ? { adviceText: advice } : {}),
      });
      return reply.code(200).type("text/html").send("<h1>¡Gracias! Tu criterio quedó registrado.</h1>");
    },
  );
}

/** Standalone app (used by tests). Production mounts routes on the main server. */
export function buildReviewApp(deps: ReviewPageDeps): FastifyInstance {
  const app = Fastify({ logger: false }); // no logging: review content is sensitive
  registerReviewRoutes(app, deps);
  return app;
}
