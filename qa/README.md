# QA — Oracle ejecutable de Verdict

> El oracle de SDD: aquí los criterios `Given/When/Then` de [`specs/`](../specs/) se
> vuelven verificables, y aquí se computa **la métrica estrella del jurado**.

Adaptación del harness *Persona + Juez (LLM-as-Judge)* del curso, calibrada a hackathon.

## Qué hay acá

```
qa/
├── README.md
├── rubrics/                     # rúbricas versionadas = única fuente de verdad de calidad
│   ├── advice-quality.md        #   Juez del borrador de consejo del agente
│   ├── anonymization-safety.md  #   Juez del resumen anonimizado (leak-check, fail-closed)
│   ├── linq-compliance.md       #   Compuerta binaria de opt-out / salud / envío Linq
│   ├── intent-parser.md         #   Compuertas duras + juez de calidad del parser
│   └── voice.md                 #   Compuertas de voz + calidad de transcripción
└── reporte-before-after.ts      # CLI: delta accuracy IA-sola → IA+humanos (money shot)
```

## Dos tipos de verificación

1. **Reglas deterministas** → tests en `src/**/*.test.ts` y (a futuro) feature files BDD.
   Ejecutan los `BR-N` binarios (p.ej. "un leak bloquea el envío").
2. **Calidad no binaria** → Juez con rúbrica. El LLM puntúa 1–5 por dimensión; **los pesos
   los aplica el harness en código, no el LLM** (evita *gaming*). Las rúbricas viven en
   `rubrics/` y son la fuente de verdad.

## La métrica estrella

```bash
npm run qa:report            # corre el reporte before/after con dataset demo
```

Compara, sobre un set etiquetado, la accuracy de:
- **model** — la IA sola (el "antes").
- **majority** — baseline ingenuo.
- **dawidSkene** — IA + consenso humano agregado (el "después").

El **delta model → dawidSkene** es la evidencia literal de la tesis de Terac: *"humanos
reales mejoraron el resultado, medible"*. Se computa en TS puro (`summarizeBenchmark` en
[`src/services/consensus.ts`](../src/services/consensus.ts)), reproducible y sin LLM.

> Métrica gemela en producción (loop de mejora): **% de borradores del agente aprobados
> sin edición, antes vs. después** del feedback humano agregado (ver [`PLAN.md §7`](../PLAN.md)).

## Calibración (antes de usar el Juez para go/no-go)

Un Juez LLM solo se usa para decisiones cuando su correlación con juicio humano ≥ 0.8
sobre un golden dataset. Para el hackathon: dataset chico anonimizado; declarar el
tamaño y el límite honestamente en el pitch.
