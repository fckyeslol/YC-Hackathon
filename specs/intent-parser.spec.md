# Spec: Parser de Intención

- **Estado:** 🟢 Implementado (core determinista) — 2026-07-24 (`src/agent/` + tests: BR-P1/P2/P3/P4/P6/P8/P10). ⚠️ Pendiente de integración: adapter LLM real (BR-P1, necesita SDK+key), `pending_action`/estado conversacional (BR-P7), confirmación de dinero en UI (BR-P5). BR-P9 vive en el spec de Linq.
- **ADR:** — (se apoya en la decisión del guardrail, [ADR-002](../entregables/ADR-002-base-sepolia-testnet.md))
- **Rúbrica QA:** [`qa/rubrics/intent-parser.md`](../qa/rubrics/intent-parser.md)
- **Producto:** [`PLAN.md §5.3`](../PLAN.md)
- **Alimenta a:** [`guardrail-escalation.spec.md`](guardrail-escalation.spec.md)
- **Consume de:** [`voice-transcription.spec.md`](voice-transcription.spec.md) (texto ya transcrito)

> El cerebro que convierte un mensaje (texto **o** audio transcrito) en una **acción
> estructurada**. No-hardcodeado: LLM con *structured output* validado por schema Zod,
> no regex frágil. El parser **extrae y clasifica**; **no decide** ejecutar dinero —
> esa decisión es del guardrail.

---

## 1. Contrato de I/O

```
texto ──► parseIntent() ──► Action { type, params, riskSignals, confidence, missingSlots }
Action ──► (si money) guardrail.classify() ──► "auto" | "escalate"   // el guardrail decide
Action ──► (si missingSlots ≠ []) repreguntar por Linq               // slot-filling, no adivinar
```

Alineado con el contrato ya definido en el guardrail (no reinventar `Action`/`RiskSignals`):

```ts
type Intent =
  | "pay" | "split" | "swap"          // acciones de dinero → mapean a ActionType del guardrail
  | "balance" | "spending_insight" | "dashboard"  // consultas (bajo riesgo)
  | "advice"                          // consejo (riesgo según impacto)
  | "confirm" | "cancel"              // resuelven pending_action (o vía tapback)
  | "smalltalk" | "unknown";          // fallback

interface Action {
  intent: Intent;
  type?: ActionType;                  // presente SOLO en intents accionables (payment|swap|portfolio_query|advice);
                                      // confirm/cancel/smalltalk/unknown no mapean a acción del guardrail
  params: Record<string, unknown>;    // slots extraídos (amount, currency, recipient, period, ...)
  riskSignals: RiskSignals;           // CRUDAS — el guardrail las clasifica (BR-P4)
  confidence: number;                 // 0..1
  missingSlots: string[];             // dispara repregunta
  rawText: string;
  actionId?: string;                  // id determinista por contenido; se acuña SOLO cuando una acción de
                                      // dinero está completa (sin missingSlots) → idempotencia (BR-P6)
}
```

**Slots por intención:** `pay {amount, currency, recipient, memo?}` · `split {total, participants[], recipient?}` · `swap {fromAsset, toAsset, amount}` · `spending_insight {period, category?}` · `dashboard {period}` · `balance {scope?}` · `advice {question}`.

## 2. Reglas de negocio

| id | Regla |
|---|---|
| **BR-P1** | **Salida estructurada, no regex:** el parser produce un objeto validado contra un schema **Zod**; si el LLM devuelve algo que no valida, se reintenta/rechaza. Nunca parsear intención con heurísticas de string a mano. |
| **BR-P2** | **Slot-filling explícito:** si `missingSlots` no está vacío, el agente **repregunta** ("¿a quién le envío los $200?") en vez de asumir. Multi-turno con `pending_action` por chat. |
| **BR-P3** | **Desambiguación de destinatario:** `recipient` se resuelve contra la allowlist/contactos; si es ambiguo o desconocido → repreguntar y/o **subir la señal de riesgo** (`novelCounterparty=true`). |
| **BR-P4** | **El parser NO clasifica riesgo final:** emite `RiskSignals` **crudas** (`amountBucket`, `novelCounterparty`, `volatileSwap`, `modelConfidence`). La decisión `auto`/`escalate` es del guardrail (BR-G*). *(Resuelve el drift de PLAN §5.3, que hablaba de un `risk` pre-clasificado.)* |
| **BR-P5** | **Confirmación obligatoria para dinero:** aunque `confidence` sea alta, toda acción `pay`/`split`/`swap` requiere confirmación explícita del usuario (tapback 👍 o link tokenizado) **antes** de firmar la tx con Dynamic. |
| **BR-P6** | **Idempotencia:** cada acción de dinero genera un `actionId`; se usa junto al `idempotency_key` de Linq y el de la tx para evitar doble ejecución si el usuario reenvía. |
| **BR-P7** | **Estado conversacional por chat:** `pending_action` permite resolver `confirm`/`cancel` (por texto o tapback) y completar slots en turnos sucesivos. |
| **BR-P8** | **Normalización coloquial (CO):** montos en jerga ("50 lucas", "medio palo") y fechas relativas ("este mes") se normalizan a valores canónicos; ante ambigüedad de moneda, se marca `missingSlots`. |
| **BR-P9** | **Precedencia de compliance:** `optout`/`optin` se resuelven **antes** del parser ([`linq-messaging.spec.md`](linq-messaging.spec.md) BR-L2/BR-L3); el parser nunca los ve. |
| **BR-P10** | **Fallback seguro:** `unknown`/baja `confidence` → responder pidiendo aclaración, nunca inventar una acción de dinero. |

## 3. Criterios de aceptación

```gherkin
# language: es
Característica: Parser de intención estructurado

  Escenario: BR-P2 — destinatario faltante dispara repregunta
    Dada la intención "manda 200"
    Cuando ejecuto parseIntent()
    Entonces intent="pay" y "recipient" está en missingSlots
    Y el agente repregunta por el destinatario en vez de ejecutar

  Escenario: BR-P3 — destinatario desconocido sube el riesgo
    Dada "mándale 20 USDC a Pepe" con "Pepe" no en la allowlist
    Cuando ejecuto parseIntent()
    Entonces riskSignals.novelCounterparty es true

  Escenario: BR-P4 — el parser no clasifica, solo señaliza
    Dada una acción de pago en bucket "muy_alto"
    Cuando ejecuto parseIntent()
    Entonces el Action trae riskSignals.amountBucket="muy_alto"
    Y NO trae una decisión auto/escalate (esa la toma el guardrail)

  Escenario: BR-P5 — dinero siempre confirma
    Dada "cámbiame 100 USDC a ETH" con confidence 0.98
    Cuando el parser produce la acción swap
    Entonces se solicita confirmación explícita antes de firmar la tx

  Escenario: BR-P1 — salida inválida se rechaza
    Dado un mensaje cuyo análisis produce un objeto que no cumple el schema Zod
    Cuando ejecuto parseIntent()
    Entonces no se devuelve una Action inválida (reintento o unknown)
```

## 4. Fuera de alcance

- NLU multi-idioma completo: se optimiza español (CO) + inglés básico; otros idiomas → `unknown` con repregunta.
- Memoria de largo plazo / perfil aprendido del usuario: fuera del hackathon.
- Ejecución de la acción: este componente solo **entiende**; ejecutar es del guardrail + cliente Dynamic.
