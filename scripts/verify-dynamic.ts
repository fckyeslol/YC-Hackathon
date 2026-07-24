/**
 * Live verification of the Dynamic ports against Base Sepolia.
 *
 * Exercises the real signer (SIWE sign-in + MPC), so it MUST run on Linux/macOS —
 * on Windows the native addon throws at import (BR-D7). From this repo:
 *
 *   wsl -d Ubuntu-24.04 -- bash -lc 'cd /mnt/c/Users/mateo/OneDrive/Desktop/hacktahon-YC && npx tsx scripts/verify-dynamic.ts'
 *
 * Read-only by default: it signs in, reuses the stored wallet, and reports balances.
 * Pass --pay to execute one real transfer of the smallest configured amount.
 */
import { config } from "../src/config.js";
import { buildDynamicPorts, dynamicConfigured } from "../src/clients/dynamicPorts.js";
import { formatUsdc } from "../src/clients/dynamic.js";

async function main(): Promise<void> {
  console.log(`platform: ${process.platform}/${process.arch}`);

  if (!dynamicConfigured()) {
    console.error("Dynamic no configurado: falta DYNAMIC_ENVIRONMENT_ID / _AGENT_SIGNING_TOKEN / _WALLET_PASSWORD");
    process.exit(1);
  }

  console.log(`wallet store: ${config.DYNAMIC_WALLET_STORE_PATH}`);
  const ports = await buildDynamicPorts();
  if (!ports) {
    console.error("buildDynamicPorts devolvió null");
    process.exit(1);
  }

  console.log(`network:  ${ports.wallet.network}`);
  console.log(`address:  ${ports.address}`);
  console.log(`payees:   ${config.DYNAMIC_PAYEES || "(vacío)"}`);
  console.log(`cap/tx:   ${config.DYNAMIC_MAX_USDC_PER_TX} USDC`);

  const balance = await ports.ledger.answerQuery({
    intent: "balance",
    params: {},
    riskSignals: { amountBucket: "bajo", novelCounterparty: false, volatileSwap: false, modelConfidence: 1 },
    confidence: 1,
    missingSlots: [],
    rawText: "saldo",
  });
  console.log(`ledger:   ${balance}`);

  const summary = await ports.ledger.buildSummary();
  console.log(
    `summary:  ${summary.categoryTotals.length} categorías, balance on-chain ${summary.exactBalance} USDC`,
  );

  if (!process.argv.includes("--pay")) {
    console.log("\nOK (solo lectura). Añadí --pay para ejecutar una transferencia real.");
    return;
  }

  const [firstPayee] = config.DYNAMIC_PAYEES.split(",");
  const name = (firstPayee ?? "").split(":")[0]?.trim();
  if (!name) {
    console.error("--pay necesita al menos un destinatario en DYNAMIC_PAYEES");
    process.exit(1);
  }

  console.log(`\npagando 0.01 USDC a "${name}" ...`);
  const result = await ports.wallet.pay({
    intent: "pay",
    type: "payment",
    params: { amount: 0.01, currency: "USDC", recipient: name },
    riskSignals: { amountBucket: "bajo", novelCounterparty: false, volatileSwap: false, modelConfidence: 1 },
    confidence: 1,
    missingSlots: [],
    rawText: `paga 0.01 a ${name}`,
    actionId: `verify-${formatUsdc(10_000n)}-${name}`,
  });

  console.log(`tx:       ${result.txRef}`);
  console.log(`explorer: ${ports.wallet.explorerUrl(result.txRef)}`);
}

main().catch((error) => {
  console.error("FALLÓ:", error);
  process.exit(1);
});
