# Spec: Revisión humana vía Terac (recruit → review → cosecha → agregación)

- **Estado:** 🟡 Aprobado + núcleo implementado (2026-07-24). ✅ Hecho y testeado (16 tests): `TeracClient.getSubmissionAnswers` (BR-T3), canal `"terac"` en `Vote`, `harvest.ts` (BR-T3/T4/T7/T8), `pendingReview.ts` (BR-T6), página `reviewPage.ts` (BR-T2). ⏳ Pendiente: montar estos módulos en el composition root (`server/index.ts`), verificación en vivo de `createOpportunity`/`getSubmissionAnswers` (BR-T9), y rúbrica QA. No sube a 🟢 hasta que esté cableado en el servidor y verificado contra la API real.
- **ADR:** [ADR-001 (Dawid–Skene)](../entregables/ADR-001-dawid-skene-vs-mayoria.md) · [ADR-003 (anonimización)](../entregables/ADR-003-anonimizacion.md)
- **Rúbrica QA:** [`qa/rubrics/terac-review.md`](../qa/rubrics/terac-review.md) *(por crear)*
- **Depende de:** [`anonymization.spec.md`](anonymization.spec.md) · [`consensus-aggregation.spec.md`](consensus-aggregation.spec.md) · [`guardrail-escalation.spec.md`](guardrail-escalation.spec.md)
- **Código:** [`src/clients/terac.ts`](../src/clients/terac.ts) · [`src/escalation/teracDelivery.ts`](../src/escalation/teracDelivery.ts) · [`src/store/types.ts`](../src/store/types.ts)
- **Producto:** [`PLAN.md §3, §7`](../PLAN.md)

> Terac es **el juicio humano** del producto: revisores reales miran un resumen
> **anonimizado** y devuelven criterio. La **"ida"** (reclutar + mandar la tarea) ya
> está construida. Este spec cubre lo que falta: la **página de review**, la **cosecha**
> de los juicios, su **agregación con Dawid–Skene**, y el **disparador de consentimiento**
> — cerrando el loop "humanos reales mejoraron el resultado, medible".

---

## 1. Contrato de I/O

```
IDA (ya construida):
  consentimiento 👍 ─► completeConsentedEscalation(anon, makeTeracDeliver(terac, cfg))
                       └─► ensureProject → createOpportunity(anon) → launchOpportunity
                           (crea/actualiza un Poll con teracOpportunityId)

VUELTA (este spec — falta):
  reviewer abre task_url ─► GET /review/:pseudonym ─► ve SOLO el AnonymizedSummary
                            └─► emite ReviewerJudgment { label, adviceText? }
  harvest (poll/pull) ─► listSubmissions(oppId) + fetchAnswers(oppId, subId)   ← método NUEVO
                         └─► por cada submission: Panelist(source:"terac") + Vote
  Vote[] ─► dawidSkene ─► TaskVerdict (label + confianza) + RaterModel (confiabilidad)
         └─► coaching al usuario (Linq)  +  ejemplo de entrenamiento (store)
```

Tipos (aterrizados en los contratos existentes — **no reinventar** `Poll`/`Panelist`/`Vote`/`Vote(agg)`):

```ts
// El resumen que cruza a Terac YA es AnonymizedSummary (PII-free por construcción).
// Cada review corresponde a un Poll del store:
//   Poll.teracOpportunityId  ← id de la oportunidad Terac
//   Poll.options             ← el set fijo de opciones que el revisor elige
//   Poll.prompt              ← la pregunta (p.ej. "¿Apruebas este consejo?")

interface ReviewerJudgment {
  opportunityId: string;
  submissionId: string;       // Terac Submission.id
  participantId: string;      // Terac Submission.participant_id (interno)
  label: number;              // índice en Poll.options (lo que alimenta Dawid–Skene)
  adviceText?: string;        // consejo libre opcional (se muestra al usuario, NUNCA al agregador como PII)
}

// Método NUEVO requerido en TeracClient (hoy NO existe — solo hay estado, no contenido):
//   getSubmissionAnswers(opportunityId, submissionId): Promise<{ answers: unknown }>
// (o listResponses(opportunityId) según lo que exponga la API real — ver BR-T9)
```

## 2. Reglas de negocio

| id | Regla |
|---|---|
| **BR-T1** | **Solo cruza lo anonimizado.** Lo único que se manda a Terac y se muestra en la página de review es un `AnonymizedSummary` que ya pasó leakCheck + `ConsentToken` (BR-A5/A6). La página **nunca** consulta ni renderiza datos crudos. |
| **BR-T2** | **Página de review PII-free.** `GET /review/:pseudonym` resuelve el review por **pseudónimo rotativo** (no por userId/phone), muestra el `AnonymizedSummary` y recoge un `ReviewerJudgment` estructurado (un `label` del set fijo `Poll.options` + `adviceText?` opcional). |
| **BR-T3** | **Cosecha del juicio, no solo del estado.** El sistema debe traer el **contenido** de la respuesta de cada revisor (`getSubmissionAnswers`), no solo `Submission.status`. Cada submission → un `Panelist{source:"terac", teracSubmissionId}` + un `Vote{pollId, raterId, label}`. |
| **BR-T4** | **Agregación con Dawid–Skene.** Los `Vote[]` cosechados se agregan con `dawidSkene` (reusar `consensus-aggregation`), produciendo `TaskVerdict` (label + confianza) y `RaterModel` (confiabilidad por revisor). **No** voto mayoritario como resultado final. |
| **BR-T5** | **"Ambos" (el doble uso).** El resultado agregado (a) llega al **usuario** como coaching por Linq, y (b) se guarda como **ejemplo de entrenamiento** (la corrección humana mejora al agente). Métrica estrella: % de borradores aprobados sin edición, antes/después. |
| **BR-T6** | **Disparador de consentimiento.** El envío a Terac solo ocurre tras el 👍 del usuario: `tapback → resolvePending(pollId) → completeConsentedEscalation(anon, makeTeracDeliver(...))`. Requiere una capa `pending_action`/`pending_review` por chat (hoy inexistente). |
| **BR-T7** | **Idempotencia / dedup.** Una submission se cuenta **una** vez; el último juicio por `(pollId, participantId)` gana (coherente con "latest vote per (poll,rater) wins" del store). Reintentos de cosecha no duplican votos. |
| **BR-T8** | **No-linkabilidad de revisores.** El `participantId` de Terac se mapea a un `raterId` **local por review**; ningún ID debe permitir enlazar dos reviews del mismo usuario (coherente con BR-A4). El `adviceText` libre pasa por leakCheck antes de mostrarse (un revisor podría, sin querer, escribir algo identificable). |
| **BR-T9** | **Verificar contra la API real.** `createOpportunity`/`getSubmissionAnswers` se implementaron/­especifican con campos **asumidos** (`task_type`, `review_type`, forma de las respuestas). Antes de 🟢 hay que confirmar el shape real contra la doc/entorno vivo de Terac (el GET de contexto ya funciona; el POST y la lectura de respuestas, no). |
| **BR-T10** | **Quórum y timeout.** Un review define panel mínimo (`num_participants`) y un timeout. Si no se junta el quórum a tiempo, **degradar seguro**: avisar al usuario que no hubo consenso humano y **no** ejecutar la acción riesgosa (fail-safe, coherente con BR-G3). |
| **BR-T11** | **Compensación vía Terac.** A los revisores los paga Terac desde el balance de la organización (`pricing.cost_per_participant_cents`); **no** el agent wallet de Dynamic. La confiabilidad aprendida (BR-T4) puede informar futura ponderación/pago, pero eso queda fuera de alcance. |
| **BR-T12** | **Sin PII en logs.** IDs de Terac, `participantId`, `adviceText` y contenido no se loguean crudos (coherente con BR-A7 / BR-L12). |

## 3. Criterios de aceptación

```gherkin
# language: es
Característica: Loop de revisión humana vía Terac

  Escenario: BR-T2 — la página de review solo expone lo anonimizado
    Dado un review con un AnonymizedSummary y un pseudónimo
    Cuando un revisor abre GET /review/:pseudonym
    Entonces ve el reparto por categoría, tendencias, flags y buckets
    Y NO ve nombre, cédula, transacciones ni saldo exacto

  Escenario: BR-T3 — se cosecha el contenido del juicio, no solo el estado
    Dada una oportunidad Terac con 3 submissions completadas
    Cuando ejecuto la cosecha
    Entonces obtengo 3 ReviewerJudgment con su label elegido
    Y se crean 3 Panelist(source:"terac") y 3 Vote en el store

  Escenario: BR-T4 — el veredicto sale de Dawid–Skene, no de mayoría
    Dados los Vote cosechados de un panel con un revisor poco confiable
    Cuando agrego con dawidSkene
    Entonces obtengo un TaskVerdict con confianza
    Y la confiabilidad del revisor poco confiable es menor

  Escenario: BR-T6 — sin 👍 no se envía a Terac
    Dado un review pendiente de consentimiento
    Cuando el usuario NO da tapback 👍
    Entonces makeTeracDeliver NUNCA se invoca

  Escenario: BR-T7 — reintentar la cosecha no duplica votos
    Dada una submission ya cosechada
    Cuando corro la cosecha otra vez
    Entonces el Vote de ese revisor no se duplica (gana el último)

  Escenario: BR-T10 — sin quórum a tiempo, se degrada seguro
    Dado un review con quórum 3 y solo 1 respuesta al vencer el timeout
    Cuando evalúo el resultado
    Entonces NO se ejecuta la acción riesgosa
    Y se avisa al usuario que no hubo consenso humano

  Escenario: BR-T8 — el adviceText libre pasa por leakCheck
    Dado un revisor que escribió "llamá a Juan Pérez al 3001234567"
    Cuando se procesa su adviceText antes de mostrarlo al usuario
    Entonces leakCheck lo bloquea/redacta (no se propaga PII de terceros)
```

## 4. Adiciones de contrato requeridas (la lista de trabajo)

Esto es exactamente lo que falta construir para cerrar Terac, cada una con su archivo:

1. **`TeracClient.getSubmissionAnswers(oppId, subId)`** — método nuevo en [`src/clients/terac.ts`](../src/clients/terac.ts): hoy solo hay `listSubmissions` (estado) y `approveSubmission`. Falta traer el **contenido** de la respuesta. *(BR-T3, BR-T9)*
2. **Canal `"terac"` en `Vote`** — [`src/store/types.ts`](../src/store/types.ts): `VoteChannel` hoy es `"reply" | "tapback"`; agregar `"terac"`. *(BR-T3)*
3. **Servicio de cosecha** — `src/escalation/harvest.ts` (nuevo): `listSubmissions → getSubmissionAnswers → ReviewerJudgment[] → Vote[]` con dedup (BR-T7) + leakCheck del `adviceText` (BR-T8), y `dawidSkene` para el veredicto (BR-T4).
4. **Página de review** — ruta Fastify `GET /review/:pseudonym` + `POST /review/:pseudonym` en `src/server/`: renderiza el `AnonymizedSummary` y recibe el `ReviewerJudgment`. *(BR-T2)*
5. **Capa `pending_review`** — store por chat que guarda el `anon` + `pollId` mientras espera el 👍; el tapback la resuelve y dispara `completeConsentedEscalation`. *(BR-T6)*
6. **Verificación en vivo** de `createOpportunity` + `getSubmissionAnswers` contra la API real (org context ya responde 200, $275 balance). *(BR-T9)*
7. **Rúbrica QA** `qa/rubrics/terac-review.md` + tests que ejecuten los escenarios de §3.

## 5. Fuera de alcance

- Ponderar/pagar a revisores según su confiabilidad aprendida (BR-T4 la produce; usarla es futuro).
- Selección/segmentación fina de revisores (`filters`, `screening_questions` de Terac) — se usa el panel por defecto.
- Webhooks de Terac para cosecha push: se usa **pull/polling** de `listSubmissions` (más simple para el hackathon); si Terac ofrece webhook de "submission completed", se migra luego.
- Multi-idioma de la página de review (español solo).
