# ADR-002 — Mover dinero en Base Sepolia (testnet): pagos reales, swaps simulados

- **Estado:** Aceptada
- **Fecha:** 2026-07-24
- **Deciden:** Mateo
- **Spec:** [`specs/guardrail-escalation.spec.md`](../specs/guardrail-escalation.spec.md)

## Contexto

Verdict mueve stablecoins vía la wallet embebida no-custodial de **Dynamic** (uso
creativo: *agent wallet* que retiene fondos y firma sola). El pago genera un ledger
on-chain que es la fuente de verdad que el agente razona. Necesitamos trazabilidad
real y verificable **sin arriesgar dinero real** en un hackathon.

## Decision drivers

- Trazabilidad on-chain verificable en un block explorer (creíble para el jurado).
- Cero riesgo financiero / cero KYC.
- Liquidez de DEX suficiente para swaps reales.
- Honestidad en el demo.

## Decisión

Construir sobre **Base Sepolia (testnet)**.

- **Pagos USDC:** transacciones **reales** on-chain (faucet de Circle para USDC de prueba, faucet de Base Sepolia para gas ETH).
- **Swaps:** Base Sepolia casi no tiene liquidez de DEX → la **ejecución de swap se simula con precio de mercado real**; los pagos sí son on-chain reales.
- **Mainnet: prohibido** en todo el código (BR-G5). Ningún path ejecuta contra mainnet ni maneja dinero real.

## Consecuencias

- ✅ El demo muestra un hash de transacción real verificable → prueba la integración de Dynamic sin riesgo.
- ✅ Frase honesta para el video: *"pagos on-chain reales; swaps con precio de mercado real, ejecución simulada por liquidez de testnet."*
- ⚠️ El realismo de los swaps es parcial (precio real, fill simulado). Se declara explícitamente; no se presenta como trading real.
- ⚠️ Los faucets tienen rate limits; fondear la agent wallet **antes** de grabar el demo.
