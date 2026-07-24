# Spec: Guardrail de Escalado a Consenso Humano

- **Estado:** 🟢 Implementado — 2026-07-24 (`src/guardrail/classify.ts` + tests: BR-G1/G2/G3/G5/G6). ⚠️ BR-G4 (orquestación del escalado vía anonimización + Terac) pendiente de integración cuando exista el servidor/cliente Terac.
- **ADR:** [ADR-002 — Base Sepolia testnet](../entregables/ADR-002-base-sepolia-testnet.md)
- **Depende de:** [`consensus-aggregation.spec.md`](consensus-aggregation.spec.md)
- **Producto:** [`PLAN.md §5`](../PLAN.md)

> El twist que hace al agente seguro *e* impresionante: una IA que maneja dinero real
> pero **pide permiso a humanos cuando duda**. El guardrail decide cuándo el agente
> ejecuta solo y cuándo escala a consenso humano vía Terac.

---

## 1. Contrato de I/O

```
Intención del usuario (texto)  ──► parseIntent() ──► Action { type, params, riskSignals }
Action                         ──► classify()    ──► "auto" | "escalate"
  "auto"      → Dynamic agent wallet ejecuta (USDC en Base Sepolia)
  "escalate"  → Terac opportunity → revisores → dawidSkene → decisión → responde por Linq
```

```ts
type ActionType = "payment" | "swap" | "portfolio_query" | "advice";
interface RiskSignals {
  amountBucket: "bajo" | "medio" | "alto" | "muy_alto";
  novelCounterparty: boolean;   // destinatario nunca visto
  volatileSwap: boolean;
  modelConfidence: number;      // 0..1 — confianza del propio agente
}
```

## 2. Reglas de negocio

| id | Regla |
|---|---|
| **BR-G1** | Acción **clara y de bajo riesgo** (consulta de portfolio, pago pequeño a contraparte conocida) → el agente ejecuta solo. |
| **BR-G2** | Acción **ambigua o riesgosa** → escala a consenso humano. Detonantes: monto alto/muy_alto, contraparte nueva, swap volátil, o `modelConfidence` bajo. |
| **BR-G3** | Ante duda, **escala** (fail-safe hacia el humano). Nunca ejecutar un movimiento de dinero riesgoso en modo autopilot. |
| **BR-G4** | El escalado usa el pipeline de anonimización ([`anonymization.spec.md`](anonymization.spec.md)) cuando expone contexto financiero al revisor. |
| **BR-G5** | Toda ejecución de dinero es **testnet (Base Sepolia)**: pagos reales on-chain, swaps con precio real y ejecución simulada. Cero mainnet, cero dinero real (ver ADR-002). |
| **BR-G6** | Las razones del escalado se registran (qué señal lo disparó) para el reporte y la auditoría — sin PII. |

## 3. Criterios de aceptación

```gherkin
# language: es
Característica: Guardrail de escalado

  Escenario: BR-G1 — pago pequeño a contraparte conocida se ejecuta solo
    Dada una intención "mándale 5 USDC a mi amigo de siempre"
    Y contraparte conocida y monto en bucket bajo
    Cuando clasifico la acción
    Entonces la clasificación es "auto"

  Escenario: BR-G2 — monto alto escala a humanos
    Dada una intención de pago con monto en bucket "muy_alto"
    Cuando clasifico la acción
    Entonces la clasificación es "escalate"

  Escenario: BR-G3 — baja confianza escala aunque el monto sea bajo
    Dada una acción con modelConfidence 0.4 y monto bajo
    Cuando clasifico la acción
    Entonces la clasificación es "escalate"

  Escenario: BR-G5 — nunca mainnet
    Dada cualquier ejecución de pago
    Entonces la red es Base Sepolia (testnet)
    Y ningún path ejecuta contra mainnet
```

## 4. Fuera de alcance

- Modelo de riesgo aprendido (ML). El clasificador es reglas explícitas + umbral de confianza — suficiente y auditable para el hackathon.
- Límites regulatorios reales (KYC/AML): no aplica en testnet; declararlo honestamente.
