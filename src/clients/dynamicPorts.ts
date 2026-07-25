/**
 * Builds the live Dynamic ports from configuration (spec: dynamic-payments).
 *
 * Fail-closed by design: if the wallet credentials are absent, this returns null
 * and the composition root keeps its stub. Nothing here throws at import time, and
 * the native MPC addon is only loaded when credentials exist AND we are actually
 * asked to build a signer (BR-D7).
 */
import { config } from "../config.js";
import type { Category, FinancialProfile } from "../anonymization/types.js";
import { DEMO_SPEND } from "../dashboard/demoSeed.js";
import type { RawSpend } from "../dashboard/ledgerAdapter.js";
import {
  DynamicLedger,
  DynamicWallet,
  createDynamicSigner,
  fileWalletMetadataStore,
  parsePayees,
  type OnchainSigner,
} from "./dynamic.js";

export interface DynamicPorts {
  readonly ledger: DynamicLedger;
  readonly wallet: DynamicWallet;
  readonly address: `0x${string}`;
}

/**
 * The demo spending source, shared with the dashboard (BR-D3).
 *
 * There used to be a second hand-written seed here, which meant the dashboard the
 * user sees and the summary the Terac reviewers judge described the same month with
 * DIFFERENT numbers. For a product whose whole thesis is "humans improved this
 * specific advice", that is not a cosmetic bug — the reviewers were grading data the
 * user never saw. One source now feeds both.
 *
 * ⚠️ VERIFICAR: still example data. The chain knows amounts and dates, not merchants
 * or categories, so a genuine spending profile needs a categorized transaction
 * source upstream. Only the balance is real (see DynamicLedger).
 */

/** Dashboard's free-text categories → the anonymization taxonomy. */
const CATEGORY_TO_ANON: Record<string, Category> = {
  comida: "comida",
  mercado: "comida",
  transporte: "transporte",
  vivienda: "vivienda",
  suscripciones: "suscripciones",
  entretenimiento: "entretenimiento",
  servicios: "servicios",
  salud: "salud",
  compras: "otros",
  otros: "otros",
};

function toAnonCategory(raw: string): Category {
  return CATEGORY_TO_ANON[raw.trim().toLowerCase()] ?? "otros";
}

/** "2026-07-05" → "2026-07" */
function monthOf(date: string): string {
  return date.slice(0, 7);
}

const isIncome = (row: RawSpend): boolean => row.direction === "income";

/**
 * Derives the PII-bearing profile from the shared spend rows.
 *
 * Current period = the most recent month present; prior period = the month before
 * it, which is what gives `computeSummary` real month-over-month trends instead of
 * invented ones.
 */
export function profileFromSpend(rows: readonly RawSpend[] = DEMO_SPEND): FinancialProfile {
  const months = [...new Set(rows.map((r) => monthOf(r.date)))].sort();
  const current = months[months.length - 1] ?? "";
  const prior = months[months.length - 2];

  const inCurrent = rows.filter((r) => monthOf(r.date) === current);

  const transactions = inCurrent
    .filter((r) => !isIncome(r))
    .map((r) => ({
      id: r.id,
      merchant: r.merchant ?? "—",
      amount: r.amountCop,
      currency: "COP",
      date: r.date,
      category: toAnonCategory(r.category),
    }));

  const monthlyIncome = inCurrent
    .filter(isIncome)
    .reduce((sum, r) => sum + r.amountCop, 0);

  const priorPeriodTotals: Partial<Record<Category, number>> = {};
  if (prior !== undefined) {
    for (const row of rows) {
      if (monthOf(row.date) !== prior || isIncome(row)) continue;
      const category = toAnonCategory(row.category);
      priorPeriodTotals[category] = (priorPeriodTotals[category] ?? 0) + row.amountCop;
    }
  }

  return {
    identity: { name: "Mateo Pirela", phone: config.LINQ_NUMBER },
    transactions,
    monthlyIncome,
    exactBalance: 0, // replaced with the real on-chain balance by DynamicLedger
    priorPeriodTotals,
  };
}

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
  profile: () => Promise<FinancialProfile> = async () => profileFromSpend(),
): Promise<DynamicPorts | null> {
  if (!dynamicConfigured()) return null;

  const signer = await signerFactory({
    environmentId: config.DYNAMIC_ENVIRONMENT_ID as string,
    agentSigningToken: config.DYNAMIC_AGENT_SIGNING_TOKEN as `0x${string}`,
    walletPassword: config.DYNAMIC_WALLET_PASSWORD as string,
    appOrigin: config.DYNAMIC_APP_ORIGIN,
    rpcUrl: config.DYNAMIC_RPC_URL,
    usdcAddress: config.DYNAMIC_USDC_ADDRESS as `0x${string}`,
    // Without this the wallet is re-created on every boot and the funds strand.
    metadataStore: fileWalletMetadataStore(config.DYNAMIC_WALLET_STORE_PATH),
  });

  const wallet = new DynamicWallet({
    signer,
    payees: parsePayees(config.DYNAMIC_PAYEES),
    copPerUsdc: config.DYNAMIC_COP_PER_USDC,
    maxUsdcPerTx: config.DYNAMIC_MAX_USDC_PER_TX,
  });

  return {
    ledger: new DynamicLedger({ signer, profile, copPerUsdc: config.DYNAMIC_COP_PER_USDC }),
    wallet,
    address: signer.address,
  };
}
