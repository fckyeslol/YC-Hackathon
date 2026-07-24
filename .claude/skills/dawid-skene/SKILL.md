---
name: dawid-skene
description: Convenciones del agregador de consenso Dawid–Skene. Usar al tocar agregación de votos/juicios humanos, cálculo de veredictos, confiabilidad de revisores, benchmark model-vs-humanos, o cualquier cosa en src/core/aggregation o src/services/consensus.
---

# Agregación Dawid–Skene

Spec: [`specs/consensus-aggregation.spec.md`](../../../specs/consensus-aggregation.spec.md) · ADR: [`ADR-001`](../../../entregables/ADR-001-dawid-skene-vs-mayoria.md)

## Reglas duras
- **Nunca voto mayoritario** como agregador final. `majorityVote` es solo baseline de comparación e init del EM.
- **Nunca decidir veredictos por prompt.** La agregación es TS puro y testeable (BR-C6). Sin `Math.random()` (determinismo, BR-C4).
- La salida es probabilística: `posterior[]` + `confidence`. La `confidence` alimenta el guardrail de escalado.
- Un revisor invertido/adversarial se aprende anti-correlacionado y sus votos se invierten (BR-C2).

## Contratos (no reinventar)
```ts
dawidSkene(votes: Vote[], { numLabels: K }): AggregationResult  // src/core/aggregation/dawidSkene.ts
summarizeBenchmark(results): { modelAccuracy, majorityAccuracy, dawidSkeneAccuracy }  // src/services/consensus.ts
```
- `Vote { taskId, raterId, label }`. Mapeo de dominio: task = decisión escalada, rater = revisor Terac, label = opción de veredicto.

## Métrica estrella
`summarizeBenchmark` produce el delta accuracy **IA-sola → IA+humanos** sobre polls etiquetados. Es el "money shot" del jurado; se computa en código, no por LLM (BR-C5).
