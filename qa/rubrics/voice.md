# Rúbrica: Voz / transcripción (compuertas duras + calidad de transcripción)

- **Versión:** 1.0
- **Spec:** [`specs/voice-transcription.spec.md`](../../specs/voice-transcription.spec.md) · **ADR:** [`ADR-005`](../../entregables/ADR-005-voz.md)
- **Uso:** híbrida. **Parte A** = compuertas deterministas (tests). **Parte B** = calidad de transcripción sobre un golden set de audios.

> La voz entra al **mismo** pipeline que el texto. La regla que no se negocia: ante
> transcripción dudosa **no se adivina**, y el dinero por voz siempre pide **eco de
> confirmación** antes de ejecutar. Un audio ruidoso nunca debe mover plata.

## Parte A — Compuertas duras (todas deben pasar)

| # | Compuerta | Falla si… | BR |
|---|---|---|---|
| G1 | Detección de audio | un `message.received` con parte `media` de audio (M4A/AAC/MP3/WAV/AIFF/CAF/AMR) no dispara el flujo de voz. | BR-V1 |
| G2 | Transcripción propia | se asume que Linq transcribe en vez de descargar del CDN y transcribir server-side. | BR-V2 |
| G3 | Fallback seguro | con fallo o `confidence < MIN_CONFIDENCE` se adivina una acción en vez de pedir que el usuario escriba. | BR-V3 |
| G4 | Eco en dinero | una acción de dinero originada en voz se ejecuta sin devolver el texto entendido y pedir confirmación. | BR-V4 |
| G5 | Pipeline único | existe una ruta de ejecución paralela para voz distinta de `parseIntent()` + guardrail. | BR-V5 |
| G6 | Privacidad | el archivo de audio o la transcripción quedan crudos en logs, o no se descartan tras procesar. | BR-V7 |

## Parte B — Calidad de transcripción (sobre golden set es-CO)

| # | Dimensión | Peso | Qué mide |
|---|---|---|---|
| D1 | Fidelidad (WER) | 50% | Word Error Rate bajo contra la transcripción de referencia; los slots de dinero (monto, destinatario) se transcriben correctos. |
| D2 | Calibración de `confidence` | 30% | Audio claro → `confidence` alta; audio ruidoso → baja (dispara el fallback G3). No sobre-confía en ruido. |
| D3 | Idioma/normalización | 20% | Detecta es-CO por defecto; jerga y montos hablados se pasan al parser en forma normalizable. |

Escala: **1** inaceptable · **3** aceptable · **5** excelente. Score = Σ(score_i × peso_i)/5, en 0..1.

## Salida (JSON)

```json
{
  "scores": { "D1": 4, "D2": 5, "D3": 4 },
  "hardFails": [],
  "rationale": "una frase factual por dimensión"
}
```

Go/no-go lo decide el harness: `hardFails.length === 0 && weighted >= umbral`. Fallar cualquier compuerta de Parte A entra como `hardFail`. Nota: **respuesta en voz (`voicememo`) es stretch (BR-V6)** y no se puntúa aquí hasta abordarse.
