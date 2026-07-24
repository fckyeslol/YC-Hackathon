# Spec: Mensajería Linq (compliance & deliverability)

- **Estado:** 🟢 Implementado (core) — 2026-07-24 (`src/clients/linq.ts` V3 + `src/domain/{optout,sendGuard,guardedSend,linqSignature,complianceState,webhookRouter}` + `src/server/` + tests). ⚠️ Pendiente: contact card inbound-first (BR-L7), reputación en vivo, opt-out difuso (capa LLM de BR-L2), y verificación del formato HMAC/`POST` contra Linq en vivo (token muerto).
- **ADR:** [ADR-004 — Linq compliance & deliverability](../entregables/ADR-004-linq-compliance.md)
- **Rúbrica QA:** [`qa/rubrics/linq-compliance.md`](../qa/rubrics/linq-compliance.md)
- **Producto:** [`PLAN.md §13`](../PLAN.md) (auditoría) · [`PLAN.md §14`](../PLAN.md) (diseño end-to-end)
- **Código:** [`src/clients/linq.ts`](../src/clients/linq.ts) (hoy solo-envío; falta la capa de este spec)

> Linq es **la interfaz** del producto (§3): hablas con el asesor por iMessage. Como
> enviamos a un humano real, el **opt-out es una regla dura de compliance** y el
> gating por salud/reputación protege la entregabilidad. **Linq NO suprime por ti** —
> es responsabilidad de este componente. Fail-safe hacia "no enviar".

---

## 1. Contrato de I/O

```
INBOUND (POST /webhooks/linq):
  evento ──► verifyHmac()  ──► routeEvent()
    message.received ──► scanOptOut()
                          ├─ match  ──► suppress(from) + 1 confirmación  (TERMINAL)
                          └─ no     ──► [media/audio?] → transcribe (voice.spec) ──► agente
    "OPTIN"            ──► clearSuppression(from)
    reaction.*         ──► resolvePending(message_id)     // 👍 confirmar / 👎 cancelar
    phone_number.status_updated ──► updateLineReputation(new_reputation)

OUTBOUND (todo envío pasa por el guard):
  send(to, parts) ──► canSend(to) ──► POST /v3/messages { to, parts }  (SIN from)
                                       └─ record(from_selection.reason, message_id, volumen)
```

```ts
type HealthStatus = "HEALTHY" | "AT_RISK" | "CRITICAL" | "OPTED_OUT";
type Reputation   = "HEALTHY" | "AT_RISK" | "CRITICAL";

interface SendDecision {
  allowed: boolean;
  reason: "ok" | "suppressed" | "opted_out" | "critical" | "rate_limited";
  throttle?: boolean;            // true cuando AT_RISK → bajar ritmo
}

const OPT_OUT_KEYWORDS = ["STOP","UNSUBSCRIBE","OPTOUT","CANCEL","END","QUIT"]; // exacto, case-sensitive
```

## 2. Reglas de negocio

| id | Regla |
|---|---|
| **BR-L1** | **HMAC obligatorio:** cada webhook se verifica con `X-Linq-Signature` = `HMAC-SHA256(secret, "{timestamp}.{body}")`, con chequeo de timestamp reciente (anti-replay). Firma inválida o vieja → `401`, no se procesa. |
| **BR-L2** | **Opt-out (compliance):** en `message.received` se escanea el texto contra `OPT_OUT_KEYWORDS` (match **exacto, case-sensitive**) **más** intención clara de "dejen de escribirme". Al match: marcar al remitente *suppressed*, **frenar todo outbound**, mandar **una** confirmación. Es **terminal**. Linq no lo suprime por nosotros. |
| **BR-L3** | **OPTIN revierte:** si el remitente envía `OPTIN`, se limpia la supresión y el chat vuelve a su bucket de salud según señales actuales. |
| **BR-L4** | **`canSend()` antes de cada envío:** no enviar si el remitente está *suppressed* o el chat está `OPTED_OUT` (terminal); `CRITICAL` → **pausar**; `AT_RISK` → **bajar ritmo** (throttle); `HEALTHY` → enviar. |
| **BR-L5** | **Envío sin `from`:** usar `POST /v3/messages` con `to` y **sin** `from`. Linq elige línea, balancea y hace failover; se registra `from_selection.reason`. Prohibido fijar `from` o crear el primer mensaje vía `POST /chats` con `from`. |
| **BR-L6** | **`available_number` solo en onboarding**, nunca por-mensaje: se llama al dar de alta a un usuario nuevo para obtener la mejor línea + `vcf_url`. |
| **BR-L7** | **Contact card inbound-first:** crear la card 1× (`POST /v3/contact_card`); compartirla (`POST /v3/chats/{id}/share_contact_card`) **solo tras ≥1 outbound** en el chat; re-compartir ~1×/día. |
| **BR-L8** | **Volumen/burst:** mantener <7.000 msgs/día/línea (in+out) y <30 msgs/60s por par remitente–destinatario; al exceder, **diferir**. |
| **BR-L9** | **Cadencia:** diseñar para respuestas (objetivo 3+ replies temprano, ratio ~1:2 in:out); si el usuario deja de responder, bajar ritmo y luego parar. |
| **BR-L10** | **Sin card nativa:** la parte `imessage_app` (card interactiva mutante) queda **fuera de alcance** — exige una extensión iMessage registrada en Apple. La "UI" se hace con `link` tokenizado + tapbacks + typing + effects (§14.3). |
| **BR-L11** | **Media/audio entrante:** un `message.received` con parte `media` se descarga del CDN y, si es audio, se transcribe ([`voice-transcription.spec.md`](voice-transcription.spec.md)) antes de entrar al agente. |
| **BR-L12** | **Sin PII en logs:** teléfonos, contenido de mensajes y URLs de media no se loguean crudos (redacción por defecto, coherente con `anonymization.spec`). |

## 3. Criterios de aceptación

```gherkin
# language: es
Característica: Mensajería Linq con compliance y deliverability

  Escenario: BR-L2 — "STOP" frena todo outbound
    Dado un chat activo con un usuario
    Cuando llega un message.received con el texto exacto "STOP"
    Entonces el remitente queda marcado como suppressed
    Y canSend() para ese remitente devuelve allowed=false reason="suppressed"
    Y se envía exactamente una confirmación y ningún mensaje más

  Escenario: BR-L2 — case-sensitive, no falso positivo
    Dado un chat activo
    Cuando llega el texto "stop, ¿me explicas eso?"
    Entonces NO se marca opt-out (no es match exacto case-sensitive)
    Y el mensaje sigue al agente normalmente

  Escenario: BR-L1 — firma inválida se rechaza
    Dado un webhook con X-Linq-Signature que no valida
    Cuando llega al handler
    Entonces responde 401 y no se procesa el evento

  Escenario: BR-L5 — el envío no fija from
    Dada una acción de enviar un mensaje a un destinatario
    Cuando el guard permite el envío
    Entonces se llama POST /v3/messages con "to" y sin "from"
    Y se registra from_selection.reason de la respuesta

  Escenario: BR-L4 — CRITICAL pausa el envío
    Dado un chat cuyo health_status es "CRITICAL"
    Cuando intento enviar
    Entonces canSend() devuelve allowed=false reason="critical"

  Escenario: BR-L3 — OPTIN reactiva
    Dado un remitente previamente suppressed por opt-out
    Cuando envía "OPTIN"
    Entonces se limpia la supresión
    Y canSend() vuelve a permitir envío según la salud del chat
```

## 4. Fuera de alcance

- **Load-balancing multi-línea:** hoy es un free Shared Line (1 número); `available_number`/failover multi-línea se respetan en contrato pero no se ejercitan.
- **Card interactiva `imessage_app`** (BR-L10): requiere extensión nativa de Apple, inviable en el hackathon.
- **Flujos específicos SMS/RCS** más allá del fallback automático de Linq.
- Verificación regulatoria (10DLC/registros de campaña): no aplica al alcance del demo; declararlo honestamente.
