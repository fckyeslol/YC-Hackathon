# Spec: Confirmación y Ejecución de Pago (`pending_action`)

- **Estado:** 🟡 Aprobado por Mateo — 2026-07-24 (código pendiente)
- **ADR:** se apoya en [ADR-002](../entregables/ADR-002-base-sepolia-testnet.md) (testnet)
- **Realiza:** [`intent-parser.spec.md`](intent-parser.spec.md) BR-P7 (`pending_action`) + BR-P5 (confirmar antes de firmar) · [`dynamic-payments.spec.md`](dynamic-payments.spec.md) BR-D2/BR-D4 (pagar solo tras confirmar, idempotente)
- **Depende de:** [`guardrail-escalation.spec.md`](guardrail-escalation.spec.md) (solo ejecuta lo que el guardrail marca `auto`)
- **Código previsto:** `src/agent/pendingAction.ts` (store) + cableado en [`src/server/index.ts`](../src/server/index.ts) (`onAgent` + `onVote`) · consume `WalletPort` de [`src/agent/ports.ts`](../src/agent/ports.ts)

> El eslabón que falta para que "la IA mueve plata" sea verdad. Hoy el orchestrator
> produce `confirm_required` pero **nadie ejecuta**: `confirm` solo responde "confirmado ✅"
> y el composition root ni consume los tapbacks. Este spec define la **máquina de estado
> de confirmación por chat**: stagear la acción propuesta, resolverla con 👍/"sí" (o
> 👎/"no"), y recién ahí invocar `wallet.pay()`. Es el gemelo de
> [`pendingReview.ts`](../src/escalation/pendingReview.ts) (que ya hace esto para el consentimiento a Terac).

---

## 1. Contrato de I/O

```
Action (money, guardrail=auto)  ──► handleAgentMessage ──► { kind: "confirm_required", action }
confirm_required                ──► PendingActionStore.stage(chatId, action)   // NO ejecuta
usuario "sí"/👍                  ──► PendingActionStore.resolve(chatId, wallet) ──► wallet.pay(action)
usuario "no"/👎                  ──► PendingActionStore.cancel(chatId)          // descarta
pago OK                         ──► confirmación al usuario con txRef + link al explorer (BR-C6)
```

```ts
interface PendingAction {
  readonly action: Action;      // la acción de dinero completa (con actionId, BR-P6)
  readonly stagedAt: string;    // ISO — para TTL (BR-C5)
  readonly messageId?: string;  // id del mensaje de propuesta, para resolver por tapback
}

interface PayResult { readonly txRef: string }        // de WalletPort.pay (dynamic-payments)

type ResolveOutcome =
  | { readonly kind: "paid"; readonly txRef: string }
  | { readonly kind: "nothing_pending" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed"; readonly reason: string };  // causa nombrada, sin PII
```

## 2. Reglas de negocio

| id | Regla |
|---|---|
| **BR-C1** | **Stage, no ejecución.** Cuando el guardrail marca `auto` una acción de dinero (`pay`/`split`/`swap`), el orchestrator devuelve `confirm_required` y el composition root **stagea** un `PendingAction` por `chatId`. Nada se firma en este paso (BR-P5/BR-D2). |
| **BR-C2** | **Resolución por confirmación explícita.** Un `confirm` (texto "sí/dale") **o** un tapback 👍 sobre el mensaje de propuesta resuelve el pending → `wallet.pay(action)`. Un `cancel` ("no") o 👎 lo descarta. |
| **BR-C3** | **Solo lo `auto` llega acá.** Las acciones que el guardrail marcó `escalate` van a `pendingReview` (consentimiento a Terac), **nunca** a `pay()`. Ambas colas son independientes; un chat puede tener a lo sumo una de cada una. |
| **BR-C4** | **Idempotencia (BR-D4/BR-P6).** El `actionId` determinista viaja a `wallet.pay()`; reconfirmar el mismo pending devuelve el `txRef` original y **no** emite una segunda tx. |
| **BR-C5** | **Fail-closed sin pending.** Un "sí"/👍 **sin** pending activo **no ejecuta nada** (no adivina un pago). Un pending vencido (TTL configurable) se descarta y el agente pide reformular — nunca paga algo viejo. |
| **BR-C6** | **Confirmación trazable.** Tras un pago OK, el agente responde por Linq con el `txRef` y el link al explorer de Base Sepolia (BR-D11). El envío pasa por `guardedSend` (gate B2). |
| **BR-C7** | **Errores nombrados, sin crash.** `UnknownPayeeError`/`InsufficientGasError`/`AmountCapExceededError` (dynamic-payments BR-D8/D9/D10) se traducen a un mensaje claro al usuario; el pending se descarta y el loop sigue. |
| **BR-C8** | **Eco de voz (BR-V4).** Si la acción vino de una nota de voz, el texto de `confirm_required` ecoa lo entendido ("Entendí: enviar 5.000 a ana — ¿confirmás? 👍") antes de ejecutar. |
| **BR-C9** | **Sin PII en logs** del pending ni del pago (coherente con BR-A7/BR-D6/BR-L12). |

## 3. Criterios de aceptación

```gherkin
# language: es
Característica: Confirmación y ejecución de pago

  Escenario: BR-C1/BR-C2 — un pago confirmado se ejecuta una vez
    Dada una acción "pay 5000 a ana" marcada auto por el guardrail
    Cuando el usuario recibe la propuesta y responde "sí"
    Entonces se invoca wallet.pay exactamente una vez con esa acción
    Y el usuario recibe el txRef

  Escenario: BR-C5 — un "sí" sin pending no paga nada
    Dado un chat sin acción pendiente
    Cuando el usuario escribe "sí"
    Entonces wallet.pay NO se invoca

  Escenario: BR-C2 — cancelar descarta el pending
    Dada una acción de pago pendiente de confirmación
    Cuando el usuario responde "no"
    Entonces wallet.pay NO se invoca
    Y el pending queda descartado

  Escenario: BR-C4 — reconfirmar no dobla el pago
    Dada una acción de pago ya ejecutada con actionId "a1"
    Cuando el usuario confirma otra vez la misma acción
    Entonces se devuelve el txRef original y no se emite una segunda tx

  Escenario: BR-C7 — destinatario desconocido no rompe el loop
    Dada una acción de pago a un recipient fuera de DYNAMIC_PAYEES
    Cuando el usuario confirma
    Entonces el agente responde con un error claro
    Y el pending se descarta sin crashear

  Escenario: BR-C3 — lo escalado no entra a esta cola
    Dada una acción de pago marcada escalate por el guardrail
    Entonces se stagea para consentimiento a Terac (pendingReview)
    Y nunca se stagea como pending_action de pago
```

## 4. Fuera de alcance

- Slot-filling multi-turno (completar `recipient`/`amount` faltantes): ya cubierto por el parser (BR-P2), no se re-especifica aquí.
- Persistencia del pending entre reinicios: en memoria por chat (para el demo alcanza; el store on-disk es futuro).
- Swaps reales: ejecución simulada por liquidez de testnet (dynamic-payments BR-D5); el flujo de confirmación es idéntico.
