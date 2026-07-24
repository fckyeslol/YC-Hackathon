/**
 * Builds the live Dynamic ports from configuration (spec: dynamic-payments).
 *
 * Fail-closed by design: if the wallet credentials are absent, this returns null
 * and the composition root keeps its stub. Nothing here throws at import time, and
 * the native MPC addon is only loaded when credentials exist AND we are actually
 * asked to build a signer (BR-D7).
 */
import { config } from "../config.js";
import type { FinancialProfile } from "../anonymization/types.js";
import {
  DynamicLedger,
  DynamicWallet,
  createDynamicSigner,
  parsePayees,
  type OnchainSigner,
} from "./dynamic.js";

export interface DynamicPorts {
  readonly ledger: DynamicLedger;
  readonly wallet: DynamicWallet;
  readonly address: `0x${string}`;
}

/**
 * Seed financial profile for the demo (BR-D3).
 *
 * ⚠️ VERIFICAR: the chain knows balances and USDC transfers, not merchants or spend
 * categories. Until a real transaction source exists, the categorized profile is
 * this seed; only `exactBalance` is replaced with the true on-chain balance by
 * DynamicLedger. Swap this for the real source before claiming the numbers are the
 * user's own.
 */
const SEED_PROFILE: FinancialProfile = {
  identity: { name: "Mateo Pirela", phone: config.LINQ_NUMBER },
  transactions: [
    { id: "s1", merchant: "Rappi", amount: 180_000, currency: "COP", date: "2026-07-05", category: "comida" },
    { id: "s2", merchant: "Uber", amount: 95_000, currency: "COP", date: "2026-07-07", category: "transporte" },
    { id: "s3", merchant: "Netflix", amount: 42_000, currency: "COP", date: "2026-07-08", category: "suscripciones" },
    { id: "s4", merchant: "Arriendo", amount: 1_400_000, currency: "COP", date: "2026-07-01", category: "vivienda" },
    { id: "s5", merchant: "Claro", amount: 70_000, currency: "COP", date: "2026-07-10", category: "servicios" },
  ],
  monthlyIncome: 4_000_000,
  exactBalance: 0, // overridden by the on-chain balance
  priorPeriodTotals: { comida: 120_000, transporte: 110_000, suscripciones: 42_000 },
};

/** True when every credential the agent wallet needs is present. */
export function dynamicConfigured(): boolean {
  return (
    config.DYNAMIC_ENVIRONMENT_ID !== undefined &&
    config.DYNAMIC_AGENT_SIGNING_TOKEN !== undefined &&
    config.DYNAMIC_WALLET_PASSWORD !== undefined
  );
}

/**
 * Constructs the live ports, or null when unconfigured.
 *
 * `signerFactory` is injectable so this can be exercised without the native SDK.
 */
export async function buildDynamicPorts(
  signerFactory: (o: Parameters<typeof createDynamicSigner>[0]) => Promise<OnchainSigner> =
    createDynamicSigner,
  profile: () => Promise<FinancialProfile> = async () => SEED_PROFILE,
): Promise<DynamicPorts | null> {
  if (!dynamicConfigured()) return null;

  const signer = await signerFactory({
    environmentId: config.DYNAMIC_ENVIRONMENT_ID as string,
    agentSigningToken: config.DYNAMIC_AGENT_SIGNING_TOKEN as `0x${string}`,
    walletPassword: config.DYNAMIC_WALLET_PASSWORD as string,
    appOrigin: config.DYNAMIC_APP_ORIGIN,
    rpcUrl: config.DYNAMIC_RPC_URL,
    usdcAddress: config.DYNAMIC_USDC_ADDRESS as `0x${string}`,
  });

  const wallet = new DynamicWallet({
    signer,
    payees: parsePayees(config.DYNAMIC_PAYEES),
    copPerUsdc: config.DYNAMIC_COP_PER_USDC,
    maxUsdcPerTx: config.DYNAMIC_MAX_USDC_PER_TX,
  });

  return { ledger: new DynamicLedger({ signer, profile }), wallet, address: signer.address };
}
