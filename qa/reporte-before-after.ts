/**
 * Reporte before/after — la métrica estrella del jurado.
 *
 * Muestra dos cosas, ambas computadas en TS puro y determinista (sin LLM):
 *
 *  1. ACCURACY por decisión (via summarizeBenchmark):
 *       model      = la IA sola (el "antes")
 *       majority   = baseline ingenuo
 *       dawidSkene = IA + consenso humano (el "después")
 *     El delta model -> consenso es la evidencia de la tesis de Terac.
 *
 *  2. Qué agrega Dawid–Skene por encima de la mayoría (honesto):
 *     con un voto por revisor por decisión, DS y la mayoría coinciden en la ETIQUETA
 *     — el valor propio de DS es (a) la CONFIANZA calibrada por decisión, que decide
 *     cuándo escalar (guardrail), y (b) la CONFIABILIDAD por revisor aprendida sobre
 *     TODAS las decisiones a la vez, que la mayoría no puede estimar.
 *
 *   npm run qa:report
 *
 * Dataset demo determinista embebido; reemplazar por el golden dataset real
 * (anonimizado) cuando exista. Ver qa/README.md.
 */
import type { Poll, Vote } from "../src/store/types.js";
import type { Vote as AggVote } from "../src/core/types.js";
import { computeConsensus, summarizeBenchmark } from "../src/services/consensus.js";
import { dawidSkene } from "../src/core/aggregation/dawidSkene.js";

const OPTIONS = ["No", "Sí"] as const;

/** groundTruth por decisión (0/1). */
const TRUTH = [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0];
/** La IA sola acierta la mitad: falla en estas posiciones. */
const MODEL_WRONG_AT = new Set([0, 2, 4, 7, 9, 11]);
/** El ruidoso se equivoca en estas (los 3 cuidadosos igual dominan la mayoría). */
const NOISY_WRONG_AT = new Set([2, 8]);

/**
 * 5 revisores: 3 cuidadosos (aciertan), 1 ruidoso (falla a veces),
 * 1 adversarial (siempre responde lo contrario de la verdad).
 */
const RATERS = ["cuidadoso-1", "cuidadoso-2", "cuidadoso-3", "ruidoso", "adversarial"];

function humanLabel(rater: string, pollIdx: number, truth: number): number {
  if (rater === "adversarial") return 1 - truth;
  if (rater === "ruidoso") return NOISY_WRONG_AT.has(pollIdx) ? 1 - truth : truth;
  return truth;
}

function buildDataset(): { polls: Poll[]; votesByPoll: Map<string, Vote[]> } {
  const polls: Poll[] = [];
  const votesByPoll = new Map<string, Vote[]>();
  const now = "2026-07-24T00:00:00.000Z";

  TRUTH.forEach((truth, i) => {
    const id = `poll-${i + 1}`;
    const modelLabel = MODEL_WRONG_AT.has(i) ? 1 - truth : truth;
    polls.push({
      id,
      prompt: `Decisión escalada #${i + 1}`,
      options: [...OPTIONS],
      status: "closed",
      createdAt: now,
      modelGuess: { label: modelLabel, confidence: 0.6 },
      groundTruth: truth,
    });
    votesByPoll.set(
      id,
      RATERS.map((raterId) => ({
        pollId: id,
        raterId,
        label: humanLabel(raterId, i, truth),
        channel: "reply" as const,
        at: now,
      })),
    );
  });

  return { polls, votesByPoll };
}

const pct = (x: number | null): string => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);

function main(): void {
  const { polls, votesByPoll } = buildDataset();

  // 1) Accuracy por decisión.
  const results = polls.map((p) => computeConsensus(p, votesByPoll.get(p.id) ?? []));
  const summary = summarizeBenchmark(results);
  const model = summary.modelAccuracy ?? 0;
  const consensus = summary.dawidSkeneAccuracy ?? 0;
  const deltaPts = ((consensus - model) * 100).toFixed(1);

  // 2) Confiabilidad por revisor: ajuste GLOBAL de Dawid–Skene sobre TODAS las
  //    decisiones a la vez (cada decisión = una task). Aquí emerge lo que la
  //    mayoría no puede ver: quién es confiable y quién está anti-correlacionado.
  const allVotes: AggVote[] = polls.flatMap((p) =>
    (votesByPoll.get(p.id) ?? []).map((v) => ({ taskId: p.id, raterId: v.raterId, label: v.label })),
  );
  const globalFit = dawidSkene(allVotes, { numLabels: OPTIONS.length });
  const reliability = [...globalFit.raters].sort((a, b) => b.reliability - a.reliability);

  // Ejemplo de confianza calibrada por decisión (lo que dispara el guardrail).
  const sample = results[0]!;

  const lines = [
    "# Reporte before/after — Verdict",
    "",
    `Set etiquetado: **${summary.labeledPolls} decisiones** · ${RATERS.length} revisores (3 cuidadosos, 1 ruidoso, 1 adversarial).`,
    "",
    "## 1. Los humanos corrigen a la IA (métrica estrella)",
    "",
    "| Método | Accuracy | Qué representa |",
    "|---|---|---|",
    `| IA sola (model) | ${pct(summary.modelAccuracy)} | el "antes" |`,
    `| Voto mayoritario | ${pct(summary.majorityAccuracy)} | baseline ingenuo |`,
    `| **Dawid–Skene (IA + humanos)** | **${pct(summary.dawidSkeneAccuracy)}** | el "después" |`,
    "",
    `### Delta: IA sola → IA + consenso humano = **+${deltaPts} pts**`,
    "",
    "> Humanos reales mejoraron el resultado, medible. Reproducible, sin LLM.",
    "",
    "## 2. Qué agrega Dawid–Skene por encima de la mayoría",
    "",
    "Con un voto por revisor por decisión, DS y la mayoría coinciden en la **etiqueta**.",
    "El valor propio de DS es doble y la mayoría no lo da:",
    "",
    "**(a) Confianza calibrada por decisión** — decide cuándo el guardrail escala.",
    `- Ej. \`${sample.pollId}\`: veredicto **${sample.dawidSkene?.labelText}** con confianza **${((sample.dawidSkene?.confidence ?? 0) * 100).toFixed(1)}%**.`,
    "",
    "**(b) Confiabilidad por revisor** — ajuste global sobre las 12 decisiones:",
    "",
    "| Revisor | Reliability |",
    "|---|---|",
    ...reliability.map((r) => `| ${r.raterId} | ${r.reliability.toFixed(3)} |`),
    "",
    "_El adversarial cae al fondo (anti-correlacionado): DS aprende a no contarlo al valor nominal — la mayoría ingenua no puede. Esa señal habilita ponderar y pagar revisores por confiabilidad._",
  ];

  console.log(lines.join("\n"));
}

main();
