# ADR-006 — Adapters en vivo del cerebro: Claude vía Runware para el LLM, Groq (Whisper) para STT

- **Estado:** Aceptada
- **Fecha:** 2026-07-24
- **Deciden:** Mateo
- **Specs:** [`specs/intent-parser.spec.md`](../specs/intent-parser.spec.md) (BR-P1) · [`specs/voice-transcription.spec.md`](../specs/voice-transcription.spec.md) (BR-V2) · [`specs/anonymization.spec.md`](../specs/anonymization.spec.md) (BR-A5)

## Contexto

Los specs del parser de intención, la transcripción de voz y el leak-check ya estaban
🟢 con su lógica pura implementada y testeada, pero corriendo contra **stubs fail-closed**
porque faltaban las keys/SDK de los modelos. Este ADR fija qué proveedores implementan
esos puertos y por qué — **no cambia ningún contrato**: los puertos (`LlmClassifier`,
`Transcriber`, `LeakCheckOptions.extraScan`) quedan idénticos; los adapters se cablean
solo en el composition root.

## Decisión

1. **Cerebro (LLM) = Claude vía Runware.** Mateo aporta una key de Runware, no una de
   Anthropic directa. Runware expone los modelos Claude por un endpoint **OpenAI-compatible**
   (`https://api.runware.ai/v1/chat/completions`), así que el adapter habla ese protocolo
   con `fetch` (sin SDK, mantiene el árbol chico — mismo estilo que el adapter de Groq).
   Modelo por defecto `anthropic-claude-haiku-4-5` (barato/rápido para clasificar con $35),
   configurable con `RUNWARE_LLM_MODEL`. Vive en [`src/clients/runwareBrain.ts`](../src/clients/runwareBrain.ts).
2. **Voz (STT) = Groq (Whisper large-v3).** Implementa el puerto `Transcriber` vía `fetch`
   contra el endpoint OpenAI-compatible de Groq. Vive en [`src/clients/groqStt.ts`](../src/clients/groqStt.ts).
3. **Leak-check inteligente (BR-A5) = Claude vía Runware, aditivo y fail-closed.**
   `makeClaudeLeakScan()` en el mismo módulo. Como el puerto `extraScan` es **síncrono**,
   el llamador **pre-resuelve** el escaneo async y pasa `() => hits`. Si el modelo falla,
   devuelve un hit que **bloquea** (nunca deja pasar). Se cablea en el flujo de escalación a Terac.
4. **Fail-closed por ausencia de key.** Sin `RUNWARE_API_KEY` el parser cae a `unknown`
   (BR-P10, no adivina dinero); sin `GROQ_API_KEY` la voz pide que el usuario escriba (BR-V3).
   El servidor arranca igual y lo dice en el log.

## Decision drivers

- **BR-P1:** salida estructurada validada por Zod. El adapter devuelve JSON crudo; `parseIntent`
  lo re-valida y descarta lo inválido — el adapter no necesita ser confiable, solo intentar.
- **Runware solo expone protocolo OpenAI para texto**, no el de Anthropic — por eso NO se usa el
  SDK oficial `@anthropic-ai/sdk` (que habla `/v1/messages`), sino `fetch` OpenAI-compatible.
  Decisión explícita de Mateo de usar su key de Runware como pasarela a Claude.
- **Presupuesto ($35):** Haiku 4.5 por defecto para clasificación de alto volumen; `RUNWARE_LLM_MODEL`
  permite subir a `anthropic-claude-sonnet-4-6` / `anthropic-claude-opus-4-8` sin tocar código.
  Groq/Whisper cuesta centavos por nota de voz.
- **Privacidad (BR-A7/BR-V7):** ningún adapter loguea texto de mensajes, audio ni resúmenes.

## Consecuencias

- ✅ El cerebro entiende mensajes de verdad y la voz entra al **mismo** pipeline de texto (BR-V5).
- ✅ Contratos intactos → la suite sigue verde; los adapters se prueban con `fetch` inyectado
  (forma de request + mapeo de respuesta) además de sus helpers puros.
- ✅ Un solo punto de cambio de proveedor (composition root); el core sigue agnóstico y testeable.
- ✅ Una sola key (Runware) cubre el parser Y el leak-check; una sola cuenta para todo el LLM.
- ⚠️ Se pasa por una **pasarela de terceros** (Runware) además del proveedor del modelo:
  un salto más de latencia y de datos en tránsito. Se mitiga no logueando contenido y usando
  modelos baratos. Alternativa no elegida: key directa de Anthropic + SDK oficial.
- ⚠️ El **leak-check LLM** queda implementado y testeado; su cableado en vivo depende del flujo de escalación.
- ⚠️ La confianza de Whisper es un **heurístico** (`avg_logprob`/`no_speech_prob`); `MIN_CONFIDENCE=0.5`
  necesita calibración con audio es-CO real.

## Variables de entorno nuevas

| Var | Requerida | Default | Rol |
|---|---|---|---|
| `RUNWARE_API_KEY` | para el cerebro | — (stub si falta) | LLM parser + leak-check (Claude vía Runware) |
| `RUNWARE_BASE_URL` | no | `https://api.runware.ai/v1` | endpoint OpenAI-compatible de Runware |
| `RUNWARE_LLM_MODEL` | no | `anthropic-claude-haiku-4-5` | id del modelo Claude en Runware (subir para más capacidad) |
| `GROQ_API_KEY` | para la voz | — (stub si falta) | transcripción Whisper |
| `GROQ_STT_MODEL` | no | `whisper-large-v3` | modelo STT |
| `STT_LANG` | no | `es` | idioma de transcripción (BR-V2) |

Model ids de Claude en Runware (verificados contra `GET /v1/models`, 2026-07-24):
`anthropic-claude-haiku-4-5`, `anthropic-claude-sonnet-4-6`, `anthropic-claude-opus-4-7`,
`anthropic-claude-opus-4-8`, `anthropic-claude-fable-5`.
