# ADR-001 — Agregar juicio humano con Dawid–Skene EM, no con voto mayoritario

- **Estado:** Aceptada
- **Fecha:** 2026-07-24
- **Deciden:** Mateo
- **Spec:** [`specs/consensus-aggregation.spec.md`](../specs/consensus-aggregation.spec.md)

## Contexto

Cuando varios revisores de Terac juzgan el borrador de consejo del agente (o una
acción escalada), hay que fundir sus juicios en un veredicto. El jurado del track
"Most Technically Impressive" verifica explícitamente que el core **no esté
hardcodeado**. Los revisores humanos difieren en confiabilidad: unos son expertos,
otros ruidosos, y alguno puede ser adversarial.

## Decision drivers

| Driver | Voto mayoritario | Dawid–Skene EM |
|---|---|---|
| Trata a todos los revisores igual | Sí (defecto ingenuo) | No — estima confiabilidad por revisor |
| Robustez a un revisor invertido/adversarial | Baja | Alta (aprende anti-correlación y lo invierte) |
| Salida probabilística (confianza) | No | Sí (`posterior[]`, `confidence`) |
| "Técnicamente impresionante, no hardcodeado" | No | Sí |
| Costo de implementación | Trivial | Medio (ya implementado + tests) |

## Decisión

Usar **Dawid & Skene (1979) EM** como agregador. Estima conjuntamente, solo desde los
votos (sin ground truth): el label latente por tarea, la matriz de confusión de cada
revisor (su confiabilidad) y el prior de clase. Se mantiene `majorityVote` únicamente
como **baseline de comparación** en el benchmark.

## Consecuencias

- ✅ Un revisor consistentemente equivocado se aprende como anti-correlacionado y sus votos se invierten en vez de contarse al valor nominal (BR-C2).
- ✅ La `confidence` del veredicto alimenta directamente el guardrail de escalado (ADR-002 / guardrail spec).
- ✅ Habilita la métrica estrella: delta de accuracy IA-sola vs IA+humanos, computado en código (`summarizeBenchmark`), no por un LLM.
- ⚠️ EM puede converger a óptimos locales con muy pocos votos; se mitiga con init desde voto mayoritario, smoothing de Laplace y tolerancia fija (determinismo, BR-C4).
- ⚠️ Con 1 solo revisor, Dawid–Skene degenera a ~voto mayoritario; el valor aparece con panel ≥3. Declararlo en el demo.
