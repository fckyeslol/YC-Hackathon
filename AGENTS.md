# AGENTS.md — Contrato del repo (neutral, cualquier arnés)

> Contrato leído por cualquier agente compatible (Claude Code, Codex, OpenCode…).
> La configuración específica de Claude Code vive en [`CLAUDE.md`](CLAUDE.md).

## Identidad

**Verdict** — un asesor financiero personal que vive en iMessage, cuyos consejos son
revisados y mejorados por humanos reales, **sin que esos humanos puedan identificar al
usuario ni ver una sola transacción cruda**. Build para el hackathon YC SS (solo,
TypeScript/Node). Fuente de verdad del producto: [`PLAN.md`](PLAN.md).

## Principio innegociable: Spec-Driven Development

**El spec es el contrato. No hay código nuevo sin un spec aprobado.**

```
spec  →  aprobar  →  test (oracle)  →  código  →  verificar contra el spec
```

- Antes de implementar comportamiento, existe un spec en [`specs/`](specs/) con
  criterios `Given/When/Then` y reglas `BR-N`. Si no existe, se escribe y aprueba primero.
- El spec manda sobre el código. Si discrepan, el código está mal (o el spec se corrige
  aquí *primero*).
- Índice y estado de specs: [`specs/README.md`](specs/README.md).
- El "por qué" de cada trade-off vive en [`entregables/`](entregables/) (ADRs).

## Estructura del repo

```
PLAN.md              # spec de producto (qué + el loop + sponsors + alcance)
specs/               # specs de componente ejecutables (SDD spine)
  README.md          #   índice + estado + regla de oro
  anonymization.spec.md
  consensus-aggregation.spec.md
  guardrail-escalation.spec.md
entregables/         # ADRs (decisiones con trade-offs)
qa/                  # oracle: rúbricas + reporte before/after (métrica estrella)
src/
  config.ts          # env validado con zod (Linq, Terac, Dynamic, PUBLIC_URL)
  clients/           # linq.ts, terac.ts (wrappers REST tipados) + dynamic (pendiente)
  core/              # types.ts + aggregation/ (dawidSkene, majority)
  services/          # consensus.ts (computeConsensus, summarizeBenchmark)
  store/             # modelo persistido (Poll, Panelist, Vote)
  domain/            # vote.ts
.claude/             # skills + sub-agentes + settings (ver CLAUDE.md)
```

## Contratos de I/O (reales, no reinventar)

| Integración | Contrato | Archivo |
|---|---|---|
| **Linq** (iMessage) | `LinqClient`: createChat/sendMessage/react/typing/webhook. Parts: `text`/`media`/`link`/`imessage_app` (la card interactiva). API v3. | [`src/clients/linq.ts`](src/clients/linq.ts) |
| **Terac** (humanos) | `TeracClient`: ensureProject/createOpportunity/launch/listSubmissions/approve. API externa v2. | [`src/clients/terac.ts`](src/clients/terac.ts) |
| **Dynamic** (wallet) | Pendiente. Agent wallet + pagos USDC en Base Sepolia. Docs vía MCP. | `src/clients/dynamic.ts` (por crear) |
| **Agregación** | `dawidSkene(votes, {numLabels})` → `AggregationResult`. `Vote{taskId,raterId,label}`. | [`src/core/aggregation/dawidSkene.ts`](src/core/aggregation/dawidSkene.ts) |
| **Benchmark** | `summarizeBenchmark(results)` → accuracy model/majority/dawidSkene. | [`src/services/consensus.ts`](src/services/consensus.ts) |

## Cómo operar

| Comando | Efecto |
|---|---|
| `npm run dev` | servidor Fastify (webhooks de Linq) con watch |
| `npm test` | vitest (unit + specs ejecutados como tests) |
| `npm run typecheck` | `tsc --noEmit` |

- Node 24, npm (no pnpm), ESM (`type: module`, imports con `.js`).
- Validar entradas de sistema con **zod** en los boundaries.

## Lo que un agente NO debe hacer

1. **Escribir código de comportamiento sin spec aprobado.** Rompe SDD → bloqueante.
2. **Filtrar PII a los revisores.** Ninguna PII/transacción cruda sale sin pasar el
   leak-check fail-closed + consentimiento (ver [`specs/anonymization.spec.md`](specs/anonymization.spec.md)).
3. **Hardcodear el agregador ni decidir veredictos por prompt.** La agregación es
   Dawid–Skene en TS puro y testeable (BR-C6).
4. **Ejecutar contra mainnet ni mover dinero real.** Solo Base Sepolia testnet (BR-G5).
5. **Ejecutar acciones de dinero riesgosas en autopilot.** Ante duda, escalar a humanos (BR-G3).
6. Crear archivos `*-v2.md` / `*-old.md` / `*-backup.md`. El historial es git.

## Referencias rápidas

- Producto: [`PLAN.md`](PLAN.md) · Specs: [`specs/README.md`](specs/README.md) · Decisiones: [`entregables/`](entregables/)
- Estrategia de premios y anonimización: `PLAN.md §3` y `§6`.
