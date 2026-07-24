# Rúbrica QA — Capa conversacional

> Oracle de [`specs/conversation.spec.md`](../../specs/conversation.spec.md). Verifica que el agente
> converse y responda datos factuales **sin** cruzar la línea del consejo (que sigue escalando a humanos).

Tests que la ejecutan: [`src/agent/orchestrator.test.ts`](../../src/agent/orchestrator.test.ts) (comportamiento
end-to-end) y [`src/clients/runwareBrain.test.ts`](../../src/clients/runwareBrain.test.ts) (adapter).

| Gate | Regla | Criterio | Cómo se verifica |
|---|---|---|---|
| C1 | BR-CV1 | `smalltalk` → respuesta conversacional del adapter, no "no entendí" | orchestrator: chat() usado, texto ≠ NOT_UNDERSTOOD (AC1) |
| C2 | BR-CV2 | Respuesta de datos fundada SOLO en el summary propio | orchestrator: `buildSummary` pasado a `answerFromData` (AC2) |
| C3 | BR-CV2/CV6 | El prompt de datos NO filtra identidad ni transacciones crudas | runwareBrain: userMsg sin nombre/cédula/comercio |
| C4 | BR-CV3 | Consejo sigue escalando a humanos; la capa conversacional no lo toca | orchestrator: `advice` → `escalated`, chat/answerFromData NO llamados (AC4) |
| C5 | BR-CV3 | Dinero sigue pidiendo confirmación; la capa no lo toca | orchestrator: `pay` → `confirm_required`, chat NO llamado (AC6) |
| C6 | BR-CV4 | Fail-closed suave: sin adapter/con error → bienvenida o answerQuery, nunca crash | orchestrator: WELCOME y fallback a `answerQuery` (AC5) |
| C7 | BR-CV5 | `unknown` conserva "no te entendí" (distinto de smalltalk) | orchestrator: `unknown` → NOT_UNDERSTOOD |

**Manual (demo):** enviar "hola" → saludo natural; "¿en qué se me va la plata?" → desglose real;
"¿debería cancelar Netflix?" → escala a humanos (no lo responde el agente solo).
