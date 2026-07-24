# Spec: Pipeline de Anonimización

- **Estado:** 🟢 Implementado y verificado — 2026-07-24 (`src/anonymization/` + `src/escalation/` + tests)
- **ADR:** [ADR-003 — Diseño de anonimización](../entregables/ADR-003-anonimizacion.md)
- **Rúbrica QA:** [`qa/rubrics/anonymization-safety.md`](../qa/rubrics/anonymization-safety.md)
- **Producto:** [`PLAN.md §6`](../PLAN.md)

> La pieza más delicada del producto. **Un revisor de Terac debe poder aconsejar sin
> poder identificar al usuario ni ver una sola transacción cruda.** Si esto falla, el
> producto es indefendible. Por eso tiene el bloqueo más estricto (fail-closed).

---

## 1. Contrato de I/O

```
Ledger (Dynamic) + categorización  ──►  computeSummary()  ──►  Summary (con PII, interno)
Summary                            ──►  anonymize()       ──►  AnonymizedSummary
AnonymizedSummary                  ──►  leakCheck()        ──►  { ok: true } | { ok: false, hits }
AnonymizedSummary                  ──►  preview()          ──►  usuario aprueba/tacha
AnonymizedSummary (aprobado)       ──►  Terac opportunity  ──►  revisores humanos
```

Tipos (a definir en `src/anonymization/types.ts`; deben reflejar este contrato):

```ts
interface AnonymizedSummary {
  reviewPseudonym: string;          // rotativo por revisión, NO reutilizable entre revisiones
  categoryBreakdown: { category: string; pct: number }[];   // suma ≈ 100
  trendsVsPrior: { category: string; deltaPct: number }[];
  behaviorFlags: string[];          // p.ej. "3 suscripciones sin uso en 60 días"
  amountBuckets: { label: string; bucket: "bajo" | "medio" | "alto" | "muy_alto" }[];
  // NUNCA: name, phone, email, cédula, accountNumber, rawTransactions, counterparties, exactBalance
}
```

## 2. Reglas de negocio

| id | Regla |
|---|---|
| **BR-A1** | El revisor **nunca** ve: nombre, teléfono, email, cédula, número de cuenta, transacción individual (comercio+monto+fecha), nombre de contraparte, saldo exacto. |
| **BR-A2** | El revisor **sí** ve: reparto por categoría en %, tendencias vs. período previo, flags de comportamiento, montos normalizados al ingreso o en buckets gruesos, un pseudónimo rotativo. |
| **BR-A3** | Categorías sensibles (salud, legal, religión, política) se **agrupan o excluyen** — nunca detalle. |
| **BR-A4** | El pseudónimo es **rotativo por revisión**: ningún ID puede enlazar una revisión con otra (no linkability). |
| **BR-A5** | **Fail-closed:** `leakCheck()` (regex + LLM) corre antes de cualquier envío. Un solo hit **bloquea el envío**. No hay override silencioso. |
| **BR-A6** | **Consentimiento con preview:** el usuario ve *exactamente* lo que verá el revisor y puede tachar antes de aprobar. Sin aprobación explícita no sale nada. El consentimiento se materializa como un **`ConsentToken` infalsificable** (constructor privado, atado por digest al resumen exacto) — no un booleano que el caller pasa a mano. |
| **BR-A7** | Cero datos crudos en logs/telemetría (disciplina heredada de FinancialOS: redacción por defecto). |
| **BR-A8** | **Gate estructural, no convencional:** el único camino a los revisores es `escalation/escalateToReviewers(anon, consent, deliver)`. Es imposible llegar a `deliver` (Terac) sin pasar `anonymize` → `leakCheck` (ok) → `ConsentToken.matches(anon)`. `anonymize()` **acuña su propio `reviewId` opaco** (BR-A4): el caller no puede inyectar un id derivable. |

## 3. Criterios de aceptación

```gherkin
# language: es
Característica: Anonimización fail-closed

  Escenario: BR-A1 — se elimina toda PII directa
    Dado un Summary con nombre "Mateo", cédula y 40 transacciones crudas
    Cuando ejecuto anonymize()
    Entonces el AnonymizedSummary no contiene ningún nombre, cédula ni transacción individual
    Y solo expone porcentajes por categoría, tendencias, flags y buckets

  Escenario: BR-A5 — un leak bloquea el envío
    Dado un AnonymizedSummary al que se le coló el texto "pago a Juan Pérez"
    Cuando ejecuto leakCheck() antes de enviar a Terac
    Entonces el resultado es { ok: false } con al menos un hit
    Y el envío a Terac NO se ejecuta

  Escenario: BR-A4 — no linkabilidad entre revisiones
    Dado el mismo usuario en dos revisiones distintas
    Cuando genero el pseudónimo de cada una
    Entonces los dos pseudónimos son diferentes
    Y ninguno permite derivar la identidad ni enlazar ambas revisiones

  Escenario: BR-A6 — sin consentimiento no se envía
    Dado un AnonymizedSummary que pasó el leak-check
    Cuando el usuario NO aprueba el preview
    Entonces el envío a Terac NO se ejecuta
```

## 4. Fuera de alcance

- Anonimización con garantías formales de privacidad diferencial (k-anonymity aproximado por buckets es suficiente para el hackathon; documentar el límite honestamente).
- Reversión / des-anonimización: no existe by design.
