# ADR-005 — Voz: entrada por nota de voz con transcripción propia; respuesta en voz como stretch

- **Estado:** Aceptada
- **Fecha:** 2026-07-24
- **Deciden:** Mateo
- **Spec:** [`specs/voice-transcription.spec.md`](../specs/voice-transcription.spec.md)
- **Rúbrica QA:** [`qa/rubrics/voice.md`](../qa/rubrics/voice.md)

## Contexto

Hablarle al asesor es natural para finanzas ("oye, ¿puedo gastar 200 en esto?"). Linq
entrega el audio del usuario en `message.received` como parte `media` con `url`
(cdn.linqapp.com) y permite responder con voz vía `POST /v3/chats/{id}/voicememo`
([`PLAN.md §14.2`](../PLAN.md)). Pero **Linq no transcribe**: la conversión audio→texto
es nuestra. El riesgo es obvio: una transcripción errónea que mueva dinero.

## Decision drivers

- Alto valor de UX, costo bajo (una transcripción por nota de voz).
- Seguridad: el dinero no puede depender de un "creí entender" sobre audio ruidoso.
- Simplicidad: no duplicar el pipeline; reutilizar el de texto.
- Priorización de hackathon: que el texto funcione antes que la voz saliente.

## Decisión

- **Entrada de voz = IN.** Flujo: `message.received` con `media` audio → descargar del
  CDN → **transcribir** (Whisper / gpt-4o-transcribe, `lang` default `es-CO`) →
  **mismo `parseIntent()` + guardrail** que el texto (BR-V5). No hay ruta paralela.
- **Fallback seguro (BR-V3):** si la transcripción falla o `confidence < MIN_CONFIDENCE`
  (0.5, calibrable), el agente pide que el usuario **lo escriba** — nunca adivina.
- **Eco de confirmación en dinero (BR-V4):** para acciones de dinero originadas en voz,
  el agente **devuelve el texto entendido** y pide confirmación explícita antes de firmar
  (refuerza BR-P5 del parser).
- **Respuesta en voz nativa (`voicememo`) = stretch (BR-V6):** solo tras que el texto esté sólido.
- **Privacidad (BR-V7):** audio y transcripción no se loguean crudos; se descartan tras procesar.

## Consecuencias

- ✅ Modo voice-first creíble en el demo, con un solo componente nuevo (`voice.ts`).
- ✅ Reutilizar el pipeline de texto evita divergencia y mantiene el guardrail como único punto de decisión de dinero.
- ✅ El eco de confirmación hace defendible el "no mueve plata por un audio mal entendido".
- ⚠️ Dependencia de un proveedor de STT externo (latencia + costo + PII en tránsito); se mitiga corriendo solo en notas de voz y descartando el audio.
- ⚠️ `MIN_CONFIDENCE` necesita calibración sobre un golden set es-CO (ver rúbrica); un umbral mal puesto genera repreguntas molestas o adivinanzas.
- ⚠️ La respuesta en voz queda fuera del alcance principal; declararlo honestamente si se muestra a medias.
