# Verdict — Especificaciones (SDD)

> **Spec-Driven Development es la ley de este repo.** El spec es el contrato: la IA
> ejecuta contra él y el humano valida contra él. Ningún código nuevo entra sin un
> spec aprobado que lo respalde. Antídoto contra el *vibe coding*.

Adaptación del modelo del curso Hardcore AI 30X (`Curso-IA/`) calibrada para un
hackathon: conservamos **la disciplina SDD** entera y descartamos la maquinaria
pesada (AI-DLC vendorizado, OpenSymphony/Linear, Terraform). Ver
[`ADR-000-modelo-sdd-calibrado`](../entregables/ADR-000-modelo-sdd-calibrado.md).

---

## La regla de oro

```
1. spec  →  2. aprobar  →  3. test (oracle ejecutable)  →  4. código  →  5. verificar contra el spec
```

- **No hay paso 4 sin paso 2.** Si vas a tocar comportamiento, primero hay un spec
  aprobado. Si el spec no existe, se escribe y se aprueba antes.
- **El spec manda sobre el código.** Cuando el código y el spec discrepan, el bug
  está en el código (o el spec está desactualizado y se corrige *primero*, aquí).
- **Los criterios de aceptación son ejecutables**, en formato `Given / When / Then`.
  La suite [`qa/`](../qa/) es el oracle que los verifica.
- **Trazabilidad:** cada regla de negocio tiene id `BR-N`; cada spec enlaza su ADR y
  su rúbrica de QA.

---

## Jerarquía de specs

| Nivel | Artefacto | Rol |
|---|---|---|
| Producto (visión) | [`../PLAN.md`](../PLAN.md) | one-liner, JTBD, el loop, sponsors, alcance. Fuente de verdad del **qué**. |
| Decisiones | [`../entregables/`](../entregables/) | ADRs — el **por qué** de cada trade-off. |
| Componente (ejecutable) | este directorio | el **cómo** verificable, con contratos y `Given/When/Then`. |
| Oracle | [`../qa/`](../qa/) | rúbricas + reporte before/after que *ejecutan* los criterios. |

---

## Índice de specs de componente

| Spec | Componente | Estado | ADR | Rúbrica QA |
|---|---|---|---|---|
| [`anonymization.spec.md`](anonymization.spec.md) | Pipeline de anonimización (la pieza crítica de privacidad) | 🟢 Implementado | [ADR-003](../entregables/ADR-003-anonimizacion.md) | [`anonymization-safety.md`](../qa/rubrics/anonymization-safety.md) |
| [`consensus-aggregation.spec.md`](consensus-aggregation.spec.md) | Agregación Dawid–Skene del juicio humano | 🟢 Implementado | [ADR-001](../entregables/ADR-001-dawid-skene-vs-mayoria.md) | [`advice-quality.md`](../qa/rubrics/advice-quality.md) |
| [`guardrail-escalation.spec.md`](guardrail-escalation.spec.md) | Guardrail: cuándo el agente escala a consenso humano | 🟢 Implementado* | [ADR-002](../entregables/ADR-002-base-sepolia-testnet.md) | — |
| [`dashboard-visualization.spec.md`](dashboard-visualization.spec.md) | Dashboards visuales de gastos bajo demanda (link tokenizado) | 🟡 Aprobado | — | — |
| [`linq-messaging.spec.md`](linq-messaging.spec.md) | Mensajería Linq: opt-out, health/reputation gating, `canSend()`, lifecycle | 🟢 Implementado‡ | [ADR-004](../entregables/ADR-004-linq-compliance.md) | [`linq-compliance.md`](../qa/rubrics/linq-compliance.md) |
| [`intent-parser.spec.md`](intent-parser.spec.md) | Parser de intención (structured output → `Action`) | 🟢 Implementado† | [ADR-006](../entregables/ADR-006-adapters-llm-stt.md) | [`intent-parser.md`](../qa/rubrics/intent-parser.md) |
| [`voice-transcription.spec.md`](voice-transcription.spec.md) | Entrada de voz → transcripción → pipeline de texto | 🟢 Implementado‡ | [ADR-005](../entregables/ADR-005-voz.md) · [ADR-006](../entregables/ADR-006-adapters-llm-stt.md) | [`voice.md`](../qa/rubrics/voice.md) |
| [`dynamic-payments.spec.md`](dynamic-payments.spec.md) | Puertos de pagos & agent wallet (Dynamic), testnet | 🟡 Aprobado‡ | [ADR-002](../entregables/ADR-002-base-sepolia-testnet.md) | — |
| [`terac-review.spec.md`](terac-review.spec.md) | Revisión humana Terac: página de review → cosecha de juicios → Dawid–Skene → coaching (el "vuelta") | 🟡 Aprobado | [ADR-001](../entregables/ADR-001-dawid-skene-vs-mayoria.md) · [ADR-003](../entregables/ADR-003-anonimizacion.md) | [`terac-review.md`](../qa/rubrics/terac-review.md) *(por crear)* |

Leyenda de estado: 🟢 implementado y verificado · 🟡 spec aprobado, código pendiente/parcial · 🔴 draft sin aprobar.

> \* **Guardrail:** el clasificador `classify()` (BR-G1/G2/G3/G5/G6) está implementado y verificado; falta **BR-G4** (orquestación del escalado vía anonimización + Terac), que se integra cuando exista el servidor/cliente Terac.
>
> † **Parser:** el core determinista (validación Zod, normalización CO, slot-filling, desambiguación, idempotencia, fallback) está implementado y verificado con el LLM inyectado/mockeado. Pendiente de integración: adapter LLM real (necesita SDK+key), estado `pending_action` (BR-P7) y confirmación de dinero en UI (BR-P5).
>
> ‡ **Loop cableado end-to-end con puertos:** `src/agent/orchestrator.ts` compone inbound → parse → guardrail → (auto: confirma / query: responde / riesgoso: anonimiza+leakCheck+preview) y toda respuesta pasa por `guardedSend` (gate B2 inevitable). Los adapters en vivo (LLM, STT, wallet Dynamic, deliver Terac) corren como **stubs fail-closed** en el composition root ([`src/server/index.ts`](../src/server/index.ts)) hasta tener keys/OAuth/MCP. **Sin fuga activa:** nada cruza a Terac salvo por el gate estructural con `ConsentToken`.

---

## Cómo agregar o cambiar un spec

1. Crea/edita el `*.spec.md` con contrato, reglas `BR-N` y criterios `Given/When/Then`.
2. Marca su estado en la tabla de arriba como 🔴 y pide aprobación humana.
3. Al aprobar → 🟡. Escribe los tests en [`qa/`](../qa/) que ejecutan los criterios.
4. Implementa hasta que los tests pasen → 🟢.
5. Prohibido: archivos `*-v2.md` / `*-old.md` / `*-backup.md`. El historial vive en git.
