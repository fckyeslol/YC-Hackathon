# ADR-004 — Compliance & deliverability de Linq: opt-out propio, gating por salud, envío sin `from`

- **Estado:** Aceptada
- **Fecha:** 2026-07-24
- **Deciden:** Mateo
- **Spec:** [`specs/linq-messaging.spec.md`](../specs/linq-messaging.spec.md)
- **Rúbrica QA:** [`qa/rubrics/linq-compliance.md`](../qa/rubrics/linq-compliance.md)

## Contexto

Linq es **la interfaz** del producto: el usuario habla con el asesor por iMessage
([`PLAN.md §3`](../PLAN.md)). Vamos a enviar iMessage a un humano real (Mateo, en el
demo), así que la entregabilidad y el compliance dejan de ser "stretch": son la
condición para el primer envío en vivo. El cliente actual [`src/clients/linq.ts`](../src/clients/linq.ts)
es **solo-envío** y **fija `from`**; no hay handler de webhooks, ni opt-out, ni
gating por salud/reputación (auditoría en [`PLAN.md §13`](../PLAN.md)). Dato duro:
**Linq NO suprime opt-outs por nosotros** — es responsabilidad de la app.

## Decision drivers

- Riesgo legal/deliverability: un "STOP" ignorado es inaceptable y quema la línea.
- La API de Linq balancea y hace failover **solo si no fijamos `from`**.
- Fail-safe: ante duda sobre si un envío es seguro, no enviar.
- Hackathon: superficie mínima pero suficiente para un envío en vivo defendible.

## Decisión

Construir la capa de compliance como componente propio, con estas decisiones firmes
(normadas BR-L1..L12 en el spec):

1. **Opt-out propio y terminal:** escanear `message.received` con match **exacto,
   case-sensitive** de `STOP/UNSUBSCRIBE/OPTOUT/CANCEL/END/QUIT` + intención; al match,
   *suppress* del remitente, frenar todo outbound, una sola confirmación. `OPTIN` revierte.
2. **`canSend()` como guard central** antes de cada envío: *suppressed* u `OPTED_OUT` →
   nunca; `CRITICAL` → pausar; `AT_RISK` → bajar ritmo; `HEALTHY` → enviar.
3. **Envío con `POST /v3/messages` usando `to` y SIN `from`** (Linq elige línea, balancea,
   failover); se registra `from_selection.reason`. Se abandona `POST /chats` con `from`.
4. **HMAC obligatorio** (`X-Linq-Signature`, timestamp reciente anti-replay) o `401`.
5. **Contact card inbound-first**; card nativa `imessage_app` **fuera de alcance** (exige
   extensión nativa registrada en Apple) → la "UI" se hace con link tokenizado + tapbacks.
6. **Volumen/cadencia**: <7k/día/línea, <30/60s por par, diseñar para respuestas.

## Consecuencias

- ✅ Podemos enviar iMessage en vivo sin riesgo legal ni de reputación; el opt-out es demostrable.
- ✅ `POST /v3/messages` sin `from` nos da failover y resolución de chat correctos gratis.
- ✅ El pivote a link tokenizado + tapbacks evita la dependencia de una extensión nativa de Apple inviable en el hackathon.
- ⚠️ Hay que construir superficie nueva (webhook router, `optout.ts`, `sendGuard.ts`, `phoneNumbers.ts`, `contactCard.ts`) — es el grueso del paso 6 de [`PLAN.md §12`](../PLAN.md).
- ⚠️ Free Shared Line: 1 número, máx 20 contactos, inbound-first. OK para el demo (un usuario); el load-balancing multi-línea queda como contrato no ejercitado.
- ⚠️ Registros regulatorios (10DLC/campañas) no aplican al alcance del demo; se declara honestamente.
