---
name: sponsors
description: Contratos de integración de los tres sponsors (Linq, Terac, Dynamic) y la regla de testnet. Usar al escribir o modificar clientes de Linq/Terac/Dynamic, el servidor de webhooks, la agent wallet, la card de iMessage, o el reclutamiento de revisores.
---

# Integraciones de sponsors

Estrategia de premios y rol de cada sponsor: [`PLAN.md §3`](../../../PLAN.md).

## Linq — la interfaz (iMessage) · API v3
Cliente: [`src/clients/linq.ts`](../../../src/clients/linq.ts) (`LinqClient`).
- Parts: `text` / `media` / `link` / **`imessage_app`** (la card interactiva — primitivo estrella de Linq).
- `createChat`, `sendMessage` (con `effect`/`replyTo`), `react` (tapback = canal de voto), `startTyping`, `createWebhook`.
- Cuenta free Shared Line: **inbound-first** (el contacto debe escribir primero, máx 20 contactos).

## Terac — el juicio humano · API externa v2
Cliente: [`src/clients/terac.ts`](../../../src/clients/terac.ts) (`TeracClient`).
- `ensureProject` → `createOpportunity` → `launchOpportunity` → `listSubmissions` → `approveSubmission`.
- Los revisores solo reciben resúmenes **anonimizados** (ver skill `anonimizacion`). Nunca crudos.
- Tesis Terac = "humanos reales mejoraron el resultado, medible" → el delta before/after es la evidencia.

## Dynamic — wallet + fuente de verdad · pendiente
Cliente a crear: `src/clients/dynamic.ts`. Docs vía MCP (`dynamic.xyz/docs/mcp`).
- Uso creativo: **agent wallet** que retiene fondos y firma sola; paga en USDC al cerrar consenso.
- El ledger on-chain es lo que el agente lee para razonar.
- Requiere `DYNAMIC_ENVIRONMENT_ID` + `DYNAMIC_API_TOKEN` (en `.env`).

## Regla de testnet (innegociable)
**Base Sepolia.** Pagos USDC reales on-chain; swaps con precio real y ejecución simulada. **Cero mainnet, cero dinero real** (ADR-002, BR-G5).
