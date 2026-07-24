---
name: anonimizacion
description: Reglas de la pipeline de anonimización fail-closed. Usar SIEMPRE que se compute o envíe un resumen financiero a revisores de Terac, se toque PII, leak-check, buckets de montos, pseudónimos, o cualquier cosa que exponga datos del usuario a un humano externo.
---

# Anonimización fail-closed (la pieza crítica)

Spec: [`specs/anonymization.spec.md`](../../../specs/anonymization.spec.md) · ADR: [`ADR-003`](../../../entregables/ADR-003-anonimizacion.md)

> Un revisor de Terac debe poder aconsejar **sin identificar al usuario ni ver una
> transacción cruda**. Si esto falla, el producto es indefendible.

## Pipeline (5 pasos, en orden, fail-closed)
1. **Computar** resumen desde el ledger (Dynamic) + categorización.
2. **Anonimizar:** quitar PII → buckets de montos → comercios a categorías → coarsen sensibles → pseudónimo rotativo por revisión.
3. **Leak-check (regex + LLM):** corre antes de cualquier envío. **Un solo hit bloquea.** Sin override silencioso (BR-A5).
4. **Consentimiento con preview:** el usuario ve exactamente lo del revisor y puede tachar. Sin aprobación no sale nada (BR-A6).
5. **Enviar** a Terac.

## El revisor NUNCA ve
nombre, teléfono, email, cédula, número de cuenta, transacción individual, nombre de contraparte, saldo exacto, detalle de categorías sensibles (salud/legal/religión/política), ni ID que enlace revisiones (BR-A1, A3, A4).

## El revisor SÍ ve
% por categoría, tendencias vs. período previo, flags de comportamiento, montos en buckets o normalizados al ingreso, pseudónimo rotativo (BR-A2).

## No negociable
- Cero datos crudos en logs/telemetría (BR-A7).
- Si dudás si algo es PII, tratalo como PII y no lo envíes.
