# Spec: Agregación de Consenso (Dawid–Skene)

- **Estado:** 🟢 Implementado (`src/core/aggregation/dawidSkene.ts` + tests)
- **ADR:** [ADR-001 — Dawid–Skene vs. voto mayoritario](../entregables/ADR-001-dawid-skene-vs-mayoria.md)
- **Rúbrica QA:** [`qa/rubrics/advice-quality.md`](../qa/rubrics/advice-quality.md)
- **Código:** [`src/core/aggregation/dawidSkene.ts`](../src/core/aggregation/dawidSkene.ts) · [`src/services/consensus.ts`](../src/services/consensus.ts)

> El corazón "técnicamente impresionante y no hardcodeado". Cuando varios revisores
> de Terac juzgan el borrador del agente, **aprendemos la confiabilidad de cada
> revisor** en vez de contar votos a ciegas. Este es el diferencial del track general.

---

## 1. Contrato de I/O

Contratos reales ya implementados (no reinventar):

```ts
// src/core/types.ts
interface Vote { taskId: string; raterId: string; label: number }
interface TaskVerdict { taskId: string; label: number; posterior: number[]; confidence: number }
interface RaterModel { raterId: string; confusion: number[][]; reliability: number }
interface AggregationResult { verdicts; raters; classPrior; iterations }

dawidSkene(votes: Vote[], { numLabels: K }): AggregationResult
```

```ts
// src/services/consensus.ts — comparación de métodos + benchmark before/after
computeConsensus(poll, votes): ConsensusResult   // model | majority | dawidSkene lado a lado
summarizeBenchmark(results): { modelAccuracy, majorityAccuracy, dawidSkeneAccuracy }
```

## 2. Reglas de negocio

| id | Regla |
|---|---|
| **BR-C1** | La agregación **no es voto mayoritario**: usa Dawid–Skene EM para estimar, solo desde los votos (sin ground truth), el label latente, la matriz de confusión por revisor y el prior de clase. |
| **BR-C2** | Un revisor consistentemente *equivocado* (adversarial/invertido) se aprende como anti-correlacionado y sus votos se **invierten**, no se cuentan al valor nominal. |
| **BR-C3** | El resultado es **probabilístico**: cada veredicto trae `posterior[]` y `confidence = max(posterior)`. La confianza alimenta el guardrail ([`guardrail-escalation.spec.md`](guardrail-escalation.spec.md)). |
| **BR-C4** | **Determinismo:** misma entrada → misma salida (init desde voto mayoritario, EM con `tolerance`/`smoothing` fijos). Sin `Math.random()`. |
| **BR-C5** | La **métrica estrella** se computa en código, no por LLM: `summarizeBenchmark` reporta accuracy de `model` (solo IA) vs `dawidSkene` (IA+humanos) sobre polls etiquetados. Ese delta es el "money shot" del jurado. |
| **BR-C6** | Los pesos/decisiones de agregación viven en el harness (TS puro, testeable), nunca en un prompt — evita *gaming* del modelo. |

## 3. Criterios de aceptación

```gherkin
# language: es
Característica: Agregación robusta del juicio humano

  Escenario: BR-C2 — un revisor invertido no envenena el consenso
    Dado 3 revisores confiables y 1 revisor que siempre responde lo contrario
    Cuando agrego con dawidSkene()
    Entonces el veredicto coincide con la mayoría confiable
    Y la reliability del revisor invertido es baja (anti-correlacionado)

  Escenario: BR-C4 — determinismo
    Dado el mismo conjunto de votos
    Cuando ejecuto dawidSkene() dos veces
    Entonces ambos AggregationResult son idénticos

  Escenario: BR-C5 — delta before/after medible
    Dado un set de polls etiquetados con votos humanos
    Cuando ejecuto summarizeBenchmark()
    Entonces obtengo modelAccuracy y dawidSkeneAccuracy
    Y el reporte muestra el delta (IA sola → IA+humanos) como número, no como opinión
```

## 4. Deuda / drift a resolver

- El vocabulario del código (`poll` / `task` / `vote`) es del framing "motor de consenso" previo al pivote. El producto ahora es "asesor financiero + revisión humana". **Decisión SDD:** el motor de agregación se conserva como *substrato reutilizable*; el spec de producto ([`PLAN.md`](../PLAN.md)) es la fuente de verdad del dominio. No renombrar el core durante el hackathon (riesgo > beneficio); documentar el mapeo aquí.
- Mapeo de dominio: `poll` = una decisión/consejo escalado · `label` = opción de veredicto · `rater` = revisor de Terac · `groundTruth` = respuesta correcta en el golden set de evaluación.
