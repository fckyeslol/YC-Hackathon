# Rúbrica: Seguridad de anonimización (Juez de leak-check)

- **Versión:** 1.0
- **Spec:** [`specs/anonymization.spec.md`](../../specs/anonymization.spec.md) · **ADR:** [`ADR-003`](../../entregables/ADR-003-anonimizacion.md)
- **Uso:** capa LLM del leak-check (paso 3 del pipeline). **Fail-closed: un solo hit bloquea el envío.**

> Esta rúbrica no promedia. Es una compuerta binaria adversarial: si CUALQUIER dimensión
> falla, el resultado es `{ ok: false }` y el envío a Terac no ocurre.

## Compuertas (todas deben pasar)

| # | Compuerta | Falla si… |
|---|---|---|
| G1 | Sin PII directa (BR-A1) | aparece nombre, teléfono, email, cédula, número de cuenta. |
| G2 | Sin transacción cruda (BR-A1) | aparece un comercio+monto+fecha individual o nombre de contraparte. |
| G3 | Sin saldo exacto (BR-A1) | aparece un balance preciso en vez de bucket/normalizado. |
| G4 | Sensibles agrupadas (BR-A3) | hay detalle de salud, legal, religión o política. |
| G5 | No reidentificable | la combinación de detalles forma una huella plausiblemente única. |
| G6 | Sin linkabilidad (BR-A4) | hay un ID que enlaza esta revisión con otra; el pseudónimo no es rotativo. |

## Salida (JSON)

```json
{
  "ok": false,
  "hits": [
    { "gate": "G2", "evidence": "pago a Juan Pérez $340.000 el 3/6", "why": "transacción cruda + contraparte identificable" }
  ]
}
```

- `ok: true` **solo** si `hits` está vacío.
- Ante duda, tratar como PII → `ok: false`. Preferimos un falso positivo (bloquea envío legítimo) a filtrar datos.
