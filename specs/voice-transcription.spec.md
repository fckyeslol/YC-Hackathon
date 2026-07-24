# Spec: Voz / Transcripción

- **Estado:** 🟢 Implementado (core determinista) — 2026-07-24 (`src/agent/voice.ts` + tests: BR-V2/V3/V5). ⚠️ Adapter STT real (Whisper/gpt-4o-transcribe) pendiente de key; `voicememo` de salida sigue stretch (BR-V6).
- **ADR:** [ADR-005 — Voz: entrada por nota de voz + transcripción propia](../entregables/ADR-005-voz.md)
- **Rúbrica QA:** [`qa/rubrics/voice.md`](../qa/rubrics/voice.md)
- **Producto:** [`PLAN.md §5.2`](../PLAN.md) · capacidad Linq en [`PLAN.md §14.2`](../PLAN.md)
- **Alimenta a:** [`intent-parser.spec.md`](intent-parser.spec.md)
- **Depende de:** [`linq-messaging.spec.md`](linq-messaging.spec.md) (media entrante)

> Le puedes **hablar** al asesor por nota de voz — natural para finanzas ("¿puedo
> gastar 200 en esto?"). Linq entrega el audio pero **no lo transcribe**: lo hacemos
> nosotros y el texto entra al **mismo** pipeline que un mensaje escrito.

---

## 1. Contrato de I/O

```
message.received (parte media, audio) ──► download(cdnUrl) ──► transcribe() ──► { text, confidence, lang }
  confidence baja / fallo ──► pedir al usuario que escriba (NO adivinar)
  ok ──► text ──► parseIntent()  (mismo pipeline que texto tecleado)

(stretch) respuesta del agente ──► tts() ──► m4a ──► POST /v3/chats/{id}/voicememo
```

```ts
interface Transcription {
  text: string;
  confidence: number;     // 0..1
  lang: string;           // default "es-CO"
}
const MIN_CONFIDENCE = 0.5;   // umbral para aceptar sin repreguntar (calibrable)
```

## 2. Reglas de negocio

| id | Regla |
|---|---|
| **BR-V1** | **Detección:** un `message.received` con parte `media` de tipo audio (M4A/AAC/MP3/WAV/AIFF/CAF/AMR) dispara el flujo de voz; se descarga del CDN de Linq. |
| **BR-V2** | **Transcripción propia:** Linq no transcribe. Se usa Whisper / gpt-4o-transcribe, con `lang` default `es-CO`. |
| **BR-V3** | **Fallback seguro:** si la transcripción falla o `confidence < MIN_CONFIDENCE`, el agente responde *"no te entendí bien, ¿me lo escribes?"* — **nunca adivina** una acción. |
| **BR-V4** | **Eco de confirmación en dinero:** para acciones de dinero originadas en voz, el agente **devuelve el texto transcrito** para confirmar ("entendí: enviar $200 a Ana — ¿confirmas? 👍") antes de ejecutar. Refuerza BR-P5. |
| **BR-V5** | **Pipeline único:** el texto transcrito entra al **mismo** `parseIntent()` + guardrail que el texto escrito; no hay ruta de ejecución paralela para voz. |
| **BR-V6** | **Respuesta en voz = stretch:** el TTS→`voicememo` es opcional y solo se aborda cuando el flujo de texto está sólido. |
| **BR-V7** | **Privacidad:** el archivo de audio y su transcripción no se loguean crudos; se descartan tras procesar (coherente con `anonymization.spec` y BR-L12). |

## 3. Criterios de aceptación

```gherkin
# language: es
Característica: Entrada de voz

  Escenario: BR-V5 — una nota de voz clara actúa como texto
    Dada una nota de voz que dice "¿en qué gasté este mes?"
    Cuando se transcribe con confidence alta
    Entonces el texto entra a parseIntent() igual que si estuviera escrito
    Y se resuelve como intent="spending_insight"

  Escenario: BR-V3 — transcripción dudosa no adivina
    Dada una nota de voz con audio ruidoso y confidence 0.3
    Cuando intento procesarla
    Entonces el agente pide que el usuario lo escriba
    Y NO se crea ninguna acción de dinero

  Escenario: BR-V4 — dinero por voz pide eco de confirmación
    Dada una nota de voz "mándale 200 a Ana" transcrita con confidence alta
    Cuando el parser produce la acción de pago
    Entonces el agente devuelve el texto entendido y pide confirmación explícita
    Y no ejecuta hasta recibir la confirmación

  Escenario: BR-V7 — sin audio crudo en logs
    Dado el procesamiento de una nota de voz
    Cuando termina
    Entonces ni el archivo de audio ni la transcripción quedan en logs
```

## 4. Fuera de alcance

- Diarización / múltiples hablantes: la nota de voz se asume de un solo usuario.
- Respuesta en voz nativa (`voicememo`) como camino principal: es stretch (BR-V6).
- Detección de idioma robusta más allá de es-CO / inglés básico.
