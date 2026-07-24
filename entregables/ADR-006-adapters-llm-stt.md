# ADR-006 — Adapters en vivo del cerebro: Anthropic (Claude) para el LLM, Groq (Whisper) para STT

- **Estado:** Aceptada
- **Fecha:** 2026-07-24
- **Deciden:** Mateo
- **Specs:** [`specs/intent-parser.spec.md`](../specs/intent-parser.spec.md) (BR-P1) · [`specs/voice-transcription.spec.md`](../specs/voice-transcription.spec.md) (BR-V2) · [`specs/anonymization.spec.md`](../specs/anonymization.spec.md) (BR-A5)

## Contexto

Los specs del parser de intención, la transcripción de voz y el leak-check ya estaban
🟢 con su lógica pura implementada y testeada, pero corriendo contra **stubs fail-closed**
porque faltaban las keys/SDK de los modelos (nota `‡` en [`specs/README.md`](../specs/README.md)).
Este ADR fija qué proveedores implementan esos puertos y por qué — **no cambia ningún
contrato**: los puertos (`LlmClassifier`, `Transcriber`, `LeakCheckOptions.extraScan`)
quedan idénticos; los adapters se cablean solo en el composition root.

## Decisión

1. **Cerebro (LLM) = Anthropic/Claude, primario.** Se implementa el puerto `LlmClassifier`
   con el **SDK oficial `@anthropic-ai/sdk`** (no un shim OpenAI-compatible). Modelo por
   defecto `claude-opus-4-8`, configurable con `ANTHROPIC_MODEL`. Vive en
   [`src/clients/anthropicBrain.ts`](../src/clients/anthropicBrain.ts).
2. **Voz (STT) = Groq (Whisper large-v3).** Se implementa el puerto `Transcriber` contra
   el endpoint OpenAI-compatible de Groq vía `fetch` (sin dependencia nueva; mantiene el
   árbol chico). Vive en [`src/clients/groqStt.ts`](../src/clients/groqStt.ts).
3. **Leak-check inteligente (BR-A5) = Claude, aditivo y fail-closed.** Se implementa
   `makeAnthropicLeakScan()` en el mismo módulo. Como el puerto `extraScan` es **síncrono**
   por diseño, el llamador **pre-resuelve** el escaneo async y pasa `() => hits`. Si el
   modelo falla, devuelve un hit que **bloquea** (nunca deja pasar). Queda listo para
   cablearse cuando exista la entrega a Terac (hoy ese flujo no está en el composition root).
4. **Fail-closed por ausencia de key.** Sin `ANTHROPIC_API_KEY` el parser cae a `unknown`
   (BR-P10, no adivina dinero); sin `GROQ_API_KEY` la voz pide que el usuario escriba (BR-V3).
   El servidor arranca igual y lo dice en el log.

## Decision drivers

- **BR-P1:** salida estructurada validada por Zod. El adapter devuelve JSON crudo; `parseIntent`
  lo re-valida y descarta lo inválido — el adapter no necesita ser confiable, solo intentar.
- **Regla del repo (claude-api):** el código Claude debe usar el SDK oficial, nunca un shim.
- **Presupuesto ($35):** Opus 4.8 es caro para clasificación de alto volumen; por eso
  `ANTHROPIC_MODEL` permite bajar a `claude-haiku-4-5` (~5× más barato) sin tocar código.
  Groq/Whisper cuesta centavos por nota de voz.
- **Privacidad (BR-A7/BR-V7):** ningún adapter loguea texto de mensajes, audio ni resúmenes.

## Consecuencias

- ✅ El cerebro entiende mensajes de verdad y la voz entra al **mismo** pipeline de texto (BR-V5).
- ✅ Contratos intactos → los 164 tests siguen verdes; los adapters se prueban por sus helpers puros.
- ✅ Un solo punto de cambio de proveedor (composition root); el core sigue agnóstico y testeable.
- ⚠️ **Falta la `ANTHROPIC_API_KEY`**: Mateo aportó Runware + Groq, no una key directa de Anthropic.
  Hay que agregarla al `.env`. Alternativa (no elegida): rutear Claude por Runware (OpenAI-compatible),
  que el SDK oficial no soporta — sería un adapter aparte.
- ⚠️ El leak-check inteligente queda **implementado y testeado pero no cableado en vivo** hasta que
  exista la entrega a Terac; el piso regex de `leakCheck()` sigue protegiendo mientras tanto.
- ⚠️ La confianza de Whisper es un **heurístico** derivado de `avg_logprob`/`no_speech_prob`
  (Whisper no da un score único); `MIN_CONFIDENCE=0.5` necesita calibración sobre audio es-CO real.

## Variables de entorno nuevas

| Var | Requerida | Default | Rol |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | para el cerebro | — (stub si falta) | LLM parser + leak-check |
| `ANTHROPIC_MODEL` | no | `claude-opus-4-8` | modelo Claude (bajar a `claude-haiku-4-5` para ahorrar) |
| `GROQ_API_KEY` | para la voz | — (stub si falta) | transcripción Whisper |
| `GROQ_STT_MODEL` | no | `whisper-large-v3` | modelo STT |
| `STT_LANG` | no | `es` | idioma de transcripción (BR-V2) |
