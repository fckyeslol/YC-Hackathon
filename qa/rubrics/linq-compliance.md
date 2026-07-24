# Rúbrica: Compliance & deliverability de Linq (compuerta binaria)

- **Versión:** 1.0
- **Spec:** [`specs/linq-messaging.spec.md`](../../specs/linq-messaging.spec.md) · **ADR:** [`ADR-004`](../../entregables/ADR-004-linq-compliance.md)
- **Uso:** verificación del componente de mensajería. **Fail-safe hacia "no enviar":** si cualquier compuerta de envío falla, no se manda nada.

> No promedia. Compliance es binario: una regla dura violada (opt-out ignorado, envío
> sin verificar salud, HMAC no validado) invalida el componente aunque todo lo demás pase.
> La mayoría de estas compuertas son deterministas → se ejercitan con tests, no con LLM.

## Compuertas de envío (todas deben pasar antes de un outbound)

| # | Compuerta | Falla si… | BR |
|---|---|---|---|
| G1 | HMAC verificado | se procesa un webhook cuya `X-Linq-Signature` no valida o cuyo timestamp no es reciente (replay). | BR-L1 |
| G2 | Opt-out respetado | tras un match exacto case-sensitive de `OPT_OUT_KEYWORDS` (o intención clara) se envía **algo más** que la única confirmación; el remitente no queda *suppressed*. | BR-L2 |
| G3 | Opt-out sin falso positivo | un texto que solo **contiene** una keyword (p.ej. `"stop, ¿me explicas?"`) marca opt-out. | BR-L2 |
| G4 | `canSend()` obligatorio | se envía a un chat `OPTED_OUT` (terminal) o `CRITICAL` (pausa), o a un remitente *suppressed*. | BR-L4 |
| G5 | Throttle en `AT_RISK` | una línea/chat `AT_RISK` sigue enviando al ritmo normal en vez de bajar el ritmo. | BR-L4 |
| G6 | Envío sin `from` | el envío fija `from` o usa `POST /chats` con `from` en vez de `POST /v3/messages` solo con `to`. | BR-L5 |
| G7 | Volumen/burst | se supera <7.000 msgs/día/línea o <30 msgs/60s por par sin diferir. | BR-L8 |
| G8 | Sin PII en logs | teléfono, contenido de mensaje o URL de media aparece crudo en logs/telemetría. | BR-L12 |

## Compuertas de onboarding/UI (deben pasar cuando aplican)

| # | Compuerta | Falla si… | BR |
|---|---|---|---|
| G9 | Contact card inbound-first | la card se comparte antes de ≥1 outbound en el chat, o se re-comparte más de ~1×/día. | BR-L7 |
| G10 | Sin card nativa | el código intenta usar la parte `imessage_app` (fuera de alcance). | BR-L10 |
| G11 | Media/audio ruteado | un `message.received` con parte `media` de audio no pasa por transcripción antes del agente. | BR-L11 |

## Salida (JSON)

```json
{
  "ok": false,
  "hits": [
    { "gate": "G2", "evidence": "outbound enviado tras STOP", "why": "opt-out no frenó el pipeline; riesgo legal" }
  ]
}
```

- `ok: true` **solo** si `hits` está vacío.
- Ante duda sobre si un envío es seguro → tratar como no permitido (fail-safe hacia "no enviar").
