# Spec: Pagos & Agent Wallet (Dynamic) — puertos

- **Estado:** 🟢 Implementado — 2026-07-24. Cliente en vivo en [`src/clients/dynamic.ts`](../src/clients/dynamic.ts); agent wallet fondeada en Base Sepolia y tx real liquidada.
- **ADR:** [ADR-002 — Base Sepolia testnet](../entregables/ADR-002-base-sepolia-testnet.md)
- **Depende de:** [`guardrail-escalation.spec.md`](guardrail-escalation.spec.md) (solo ejecuta lo que el guardrail marca `auto` **y** el usuario confirma)
- **Código:** [`src/agent/ports.ts`](../src/agent/ports.ts) (`WalletPort`, `LedgerPort`) · consumidos por [`src/agent/orchestrator.ts`](../src/agent/orchestrator.ts)

> Dynamic es **el músculo + la fuente de verdad**: agent wallet no-custodial que
> ejecuta pagos USDC y un ledger on-chain que el agente lee para razonar. Este
> spec define los **puertos** (contratos) que el loop consume; el cliente real se
> escribe contra los endpoints de Dynamic cuando carguen sus MCP docs.

---

## 1. Contrato de I/O (puertos)

```ts
interface LedgerPort {                       // lado lectura
  answerQuery(action: Action): Promise<string>;   // respuesta read-only (balance/insight/dashboard) → auto
  buildSummary(): Promise<Summary>;                // resumen interno CON PII, SOLO como input de escalado
}

interface WalletPort {                       // lado escritura
  readonly network: "base-sepolia";          // BR-G5: nunca mainnet
  pay(action: Action): Promise<{ txRef: string }>; // ejecuta SOLO tras confirmación explícita (BR-P5)
}
```

## 2. Reglas de negocio

| id | Regla |
|---|---|
| **BR-D1** | **Testnet only:** `network` es `"base-sepolia"`. Ningún path ejecuta contra mainnet ni maneja dinero real (BR-G5, ADR-002). |
| **BR-D2** | **Nunca ejecuta en autopilot:** `pay()` se invoca **solo** después de (a) el guardrail marcó `auto` **y** (b) el usuario confirmó explícitamente (tapback 👍 / link) — BR-P5. Riesgoso → el guardrail escala, no se paga. |
| **BR-D3** | **`buildSummary()` produce el `Summary` interno con PII** que alimenta la anonimización; su salida **nunca** se envía cruda: pasa por `anonymize → leakCheck → consentimiento` (BR-A5/A6/A8). |
| **BR-D4** | **Idempotencia:** `pay()` usa el `actionId` determinista del parser (BR-P6) + el idempotency-key de la tx para no doblar ejecución ante reenvío. |
| **BR-D5** | **Swaps:** ejecución simulada con precio de mercado real (liquidez de testnet); los **pagos** sí son txs reales on-chain (ADR-002). |
| **BR-D6** | **Sin PII en logs** de la wallet/ledger (coherente con BR-A7 / BR-L12). |
| **BR-D7** | **Runtime Linux/macOS:** el firmador MPC de Dynamic es un addon nativo (Neon) compilado solo para `linux_x64/arm64` y `macos_x64/arm64`. En Windows lanza `Neon: unsupported system: win32` **al importar**, y no corre bajo Bun, Deno ni edge runtimes. El import del SDK es **perezoso** (`await import()`) para que la suite siga corriendo en cualquier plataforma con fakes; solo `pay()` real exige Linux/WSL. |
| **BR-D8** | **Gas explícito:** un pago persona-a-persona es un `transfer()` ERC-20 que la wallet paga con ETH nativo. Antes de firmar se verifica saldo de gas y de USDC, y se falla con causa nombrada (`InsufficientGasError` / `InsufficientUsdcError`) en vez de un revert opaco. (x402 sí es gasless porque lo liquida el facilitador — no aplica a `pay()`.) |
| **BR-D9** | **Resolución de destinatario fail-closed:** `params.recipient` es un nombre ("mama"), no una dirección. Se resuelve contra `DYNAMIC_PAYEES` (`nombre:0x…`). Un destinatario desconocido **no se paga**: lanza `UnknownPayeeError`. Coherente con BR-P3 (contraparte novel). |
| **BR-D11** | **Trazabilidad del pago:** todo pago liquidado expone su `txRef` y una URL de explorador verificable (`DynamicWallet.explorerUrl()` → `sepolia.basescan.org/tx/…`), para que el usuario compruebe la tx por fuera de la app. Consumido por [`payment-confirmation.spec.md`](payment-confirmation.spec.md) BR-C6. |
| **BR-D10** | **Moneda:** el parser normaliza montos en **COP** (`bucketAmount`: 20k/200k/2M) pero la liquidación es en **USDC**. `pay()` convierte con `DYNAMIC_COP_PER_USDC` (explícito, no adivinado) salvo que `params.currency` sea `USDC`/`USD`, y aplica un techo `DYNAMIC_MAX_USDC_PER_TX` como límite duro por transacción. ⚠️ VERIFICAR: la tasa es de configuración, no un oráculo de mercado. |

## 3. Criterios de aceptación

```gherkin
# language: es
Característica: Puertos de pagos Dynamic

  Escenario: BR-D2 — no se paga sin confirmación
    Dada una acción de pago marcada "auto" por el guardrail
    Cuando el usuario aún no confirma
    Entonces WalletPort.pay NO se invoca

  Escenario: BR-D1 — la red siempre es testnet
    Dada cualquier implementación de WalletPort
    Entonces network es "base-sepolia"

  Escenario: BR-D9 — destinatario desconocido no se paga
    Dada una acción de pago cuyo recipient no está en DYNAMIC_PAYEES
    Cuando se invoca pay
    Entonces lanza UnknownPayeeError y no se firma nada

  Escenario: BR-D4 — reenvío del mismo actionId no dobla el pago
    Dada una acción de pago ya ejecutada con actionId "a1"
    Cuando se invoca pay otra vez con el mismo actionId
    Entonces devuelve el txRef original y no emite una segunda transacción

  Escenario: BR-D8 — sin gas no se firma
    Dada una wallet con USDC pero sin ETH nativo
    Cuando se invoca pay
    Entonces lanza InsufficientGasError antes de producir una firma

  Escenario: BR-D10 — techo duro por transacción
    Dada una acción de pago que excede DYNAMIC_MAX_USDC_PER_TX
    Cuando se invoca pay
    Entonces lanza AmountCapExceededError y no se firma nada
```

## 4. Fuera de alcance
- Custodia / gestión de claves de dinero real: prohibido (solo testnet).
- Multi-cadena: solo Base Sepolia en el hackathon.
