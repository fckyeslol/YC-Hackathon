# ADR-003 — Anonimización fail-closed con consentimiento previo del usuario

- **Estado:** Aceptada
- **Fecha:** 2026-07-24
- **Deciden:** Mateo
- **Spec:** [`specs/anonymization.spec.md`](../specs/anonymization.spec.md)
- **Rúbrica QA:** [`qa/rubrics/anonymization-safety.md`](../qa/rubrics/anonymization-safety.md)

## Contexto

Los revisores de Terac deben aconsejar sobre las finanzas del usuario **sin poder
identificarlo ni ver una transacción cruda**. Un resumen mal hecho filtra identidad
por combinación de detalles (huella única), aunque no lleve el nombre. Esta es la
pieza que hace el producto defendible o indefendible.

## Decision drivers

- Privacidad real, no cosmética (el revisor ve un *patrón*, no una huella).
- Fallo seguro: ante duda, no enviar.
- Control del usuario (transparencia + consentimiento).
- Reutilizar disciplina probada (FinancialOS: cifrado, telemetría redactada, cero crudos en logs).

## Decisión

Pipeline de 5 pasos, **fail-closed**:

1. **Computar** el resumen desde el ledger (Dynamic) + categorización.
2. **Anonimizar:** quitar PII → buckets de montos → comercios a categorías → coarsen categorías sensibles → pseudónimo **rotativo por revisión** (no linkable).
3. **Leak-check (regex + LLM):** corre antes de cualquier envío; **un solo hit bloquea** (sin override silencioso).
4. **Consentimiento con preview:** el usuario ve exactamente lo que verá el revisor y puede tachar; sin aprobación no sale nada.
5. **Enviar** a Terac.

Lo que el revisor **nunca** ve vs. **sí** ve está tabulado en [`PLAN.md §6`](../PLAN.md) y normado como BR-A1..A7 en el spec.

## Consecuencias

- ✅ Privacidad por diseño; el revisor recibe un patrón que podría ser de miles de personas.
- ✅ El leak-check fail-closed y el preview con consentimiento son demostrables en vivo (momento fuerte del pitch: "esto es lo único que un humano llega a ver").
- ⚠️ No hay garantía formal de privacidad diferencial; los buckets dan k-anonymity aproximado. Se declara el límite honestamente.
- ⚠️ El leak-check con LLM agrega latencia y costo; aceptable porque corre solo en el escalado, no en cada mensaje.
- ⚠️ Falsos positivos del leak-check pueden bloquear envíos legítimos; preferible (fail-closed) a filtrar PII.
