/**
 * Dynamic: agent wallet (write) + on-chain ledger (read).
 * Spec: specs/dynamic-payments.spec.md — BR-D1..BR-D10.
 *
 * The agent authenticates as its OWN Dynamic user via SIWE with an agent signing
 * token, so the wallet belongs to that user and no human approves each signature.
 * Verified end-to-end on Base Sepolia before this file existed.
 *
 * Two things shape the design:
 *
 * - BR-D7: Dynamic's MPC signer is a native Neon addon built only for linux/macOS.
 *   Importing it on Windows throws at module load. So the SDK is imported LAZILY,
 *   behind `OnchainSigner`, and every test injects a fake. Nothing here loads a
 *   native binary until a real payment is actually attempted.
 * - BR-D2: this module NEVER decides to pay. It executes what the orchestrator
 *   already routed through guardrail + explicit user confirmation.
 */
import type { Action } from "../agent/types.js";
import type { LedgerPort, WalletPort } from "../agent/ports.js";
import type { FinancialProfile, Summary } from "../anonymization/types.js";
import { computeSummary } from "../anonymization/anonymize.js";

/** Base Sepolia. Hardcoded, not configurable — BR-D1 leaves no path to mainnet. */
export const CHAIN_ID = 84532 as const;
export const NETWORK = "base-sepolia" as const;
const USDC_DECIMALS = 6n;
const USDC_SCALE = 10n ** USDC_DECIMALS;
const EXPLORER_TX = "https://sepolia.basescan.org/tx/";

export class UnknownPayeeError extends Error {
  constructor(recipient: string) {
    super(`No conozco a "${recipient}" — no está en DYNAMIC_PAYEES. No se paga (BR-D9).`);
    this.name = "UnknownPayeeError";
  }
}

export class InsufficientGasError extends Error {
  constructor(address: string) {
    super(`La wallet ${address} no tiene ETH nativo para el gas del transfer (BR-D8).`);
    this.name = "InsufficientGasError";
  }
}

export class InsufficientUsdcError extends Error {
  constructor(have: string, need: string) {
    super(`Saldo ${have} USDC, el pago necesita ${need} USDC (BR-D8).`);
    this.name = "InsufficientUsdcError";
  }
}

export class AmountCapExceededError extends Error {
  constructor(requested: string, cap: string) {
    super(`El pago de ${requested} USDC excede el techo de ${cap} USDC por tx (BR-D10).`);
    this.name = "AmountCapExceededError";
  }
}

export class MissingAmountError extends Error {
  constructor() {
    super("La acción de pago no trae monto utilizable.");
    this.name = "MissingAmountError";
  }
}

/**
 * The narrow on-chain surface the wallet needs. Implemented for real by
 * `createDynamicSigner` (lazy native SDK) and by fakes in tests — which is what
 * keeps BR-D7 from making this module untestable off Linux.
 */
export interface OnchainSigner {
  readonly address: `0x${string}`;
  nativeBalance(): Promise<bigint>;
  usdcBalance(): Promise<bigint>;
  transferUsdc(to: `0x${string}`, amountUnits: bigint): Promise<`0x${string}`>;
}

/** Records which actionIds already paid, so a resend cannot double-spend (BR-D4). */
export interface PaidActionStore {
  get(actionId: string): Promise<string | undefined>;
  set(actionId: string, txRef: string): Promise<void>;
}

export function inMemoryPaidActions(): PaidActionStore {
  const seen = new Map<string, string>();
  return {
    get: async (id) => seen.get(id),
    set: async (id, tx) => void seen.set(id, tx),
  };
}

export interface DynamicWalletOptions {
  readonly signer: OnchainSigner;
  /** name -> address, from DYNAMIC_PAYEES (BR-D9). */
  readonly payees: ReadonlyMap<string, `0x${string}`>;
  readonly copPerUsdc: number;
  readonly maxUsdcPerTx: number;
  readonly paidActions?: PaidActionStore;
}

/** Parses "mama:0xabc,juan:0xdef" into a lookup map. Invalid entries are dropped. */
export function parsePayees(raw: string): ReadonlyMap<string, `0x${string}`> {
  const payees = new Map<string, `0x${string}`>();

  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;

    const sep = trimmed.lastIndexOf(":");
    if (sep === -1) continue;

    const name = trimmed.slice(0, sep).trim().toLowerCase();
    const address = trimmed.slice(sep + 1).trim();
    if (name !== "" && /^0x[0-9a-fA-F]{40}$/.test(address)) {
      payees.set(name, address as `0x${string}`);
    }
  }

  return payees;
}

/** Decimal USDC string -> atomic units, without floats. */
export function usdcToUnits(value: string): bigint {
  const trimmed = value.trim().replace(/^\$/, "");
  if (trimmed === "" || trimmed === "." || !/^\d*(\.\d*)?$/.test(trimmed)) {
    throw new Error(`Monto USDC inválido: "${value}"`);
  }

  const [whole = "", fraction = ""] = trimmed.split(".");
  const truncated = fraction.slice(0, Number(USDC_DECIMALS));
  const padded = truncated.padEnd(Number(USDC_DECIMALS), "0");
  return BigInt(whole === "" ? "0" : whole) * USDC_SCALE + BigInt(padded || "0");
}

/** Atomic units -> decimal USDC string, for logs and user-facing text. */
export function formatUsdc(units: bigint): string {
  const whole = units / USDC_SCALE;
  const fraction = (units % USDC_SCALE).toString().padStart(Number(USDC_DECIMALS), "0");
  return `${whole}.${fraction}`.replace(/\.?0+$/, "") || "0";
}

/**
 * Resolves the payable amount in USDC atomic units (BR-D10).
 *
 * The parser normalizes amounts in COP, so a bare number is COP and gets converted
 * at the configured rate. An explicit USDC/USD currency is taken at face value.
 */
export function resolveAmountUnits(
  params: Readonly<Record<string, unknown>>,
  copPerUsdc: number,
): bigint {
  const raw = params.amount ?? params.total;
  const amount = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(amount) || amount <= 0) throw new MissingAmountError();

  const currency = String(params.currency ?? "COP").toUpperCase();
  const isUsd = currency === "USDC" || currency === "USD";
  const usdc = isUsd ? amount : amount / copPerUsdc;

  // Round to the 6 decimals USDC actually has, then go through the string parser
  // so the bigint conversion never sees a float.
  const units = usdcToUnits(usdc.toFixed(Number(USDC_DECIMALS)));
  if (units <= 0n) throw new MissingAmountError();
  return units;
}

/**
 * The Dynamic agent wallet. Write side of the loop.
 *
 * `pay()` assumes the guardrail said `auto` AND the user confirmed — it does not
 * re-check that (BR-D2 is enforced upstream in the orchestrator), but it does
 * enforce every money-safety rule it can see locally: payee, cap, gas, balance.
 */
export class DynamicWallet implements WalletPort {
  readonly network = NETWORK;

  private readonly paidActions: PaidActionStore;

  constructor(private readonly opts: DynamicWalletOptions) {
    this.paidActions = opts.paidActions ?? inMemoryPaidActions();
  }

  get address(): `0x${string}` {
    return this.opts.signer.address;
  }

  async pay(action: Action): Promise<{ txRef: string }> {
    // BR-D4: a resend of the same action returns the original tx, never a new one.
    const { actionId } = action;
    if (actionId !== undefined) {
      const already = await this.paidActions.get(actionId);
      if (already !== undefined) return { txRef: already };
    }

    const recipient = action.params.recipient;
    if (typeof recipient !== "string" || recipient.trim() === "") {
      throw new UnknownPayeeError(String(recipient ?? ""));
    }

    const to = this.opts.payees.get(recipient.trim().toLowerCase());
    if (to === undefined) throw new UnknownPayeeError(recipient);

    const amountUnits = resolveAmountUnits(action.params, this.opts.copPerUsdc);

    const cap = usdcToUnits(String(this.opts.maxUsdcPerTx));
    if (amountUnits > cap) {
      throw new AmountCapExceededError(formatUsdc(amountUnits), formatUsdc(cap));
    }

    // BR-D8: name the cause before signing, instead of an opaque revert after.
    const [gas, usdc] = await Promise.all([
      this.opts.signer.nativeBalance(),
      this.opts.signer.usdcBalance(),
    ]);
    if (gas === 0n) throw new InsufficientGasError(this.opts.signer.address);
    if (usdc < amountUnits) {
      throw new InsufficientUsdcError(formatUsdc(usdc), formatUsdc(amountUnits));
    }

    const txHash = await this.opts.signer.transferUsdc(to, amountUnits);

    if (actionId !== undefined) await this.paidActions.set(actionId, txHash);

    // BR-D6: no PII in wallet logs — amount and tx only, never the payee's name.
    console.log(`[dynamic] paid ${formatUsdc(amountUnits)} USDC on ${NETWORK} tx=${txHash}`);

    return { txRef: txHash };
  }

  explorerUrl(txRef: string): string {
    return `${EXPLORER_TX}${txRef}`;
  }
}

export interface DynamicLedgerOptions {
  readonly signer: OnchainSigner;
  /**
   * Categorized financial profile (BR-D3). The chain knows balances and transfers
   * but not merchants or categories, so this comes from outside; the on-chain USDC
   * balance overrides `exactBalance` so the summary agrees with reality.
   */
  readonly profile: () => Promise<FinancialProfile>;
}

/** Read side: answers queries and builds the (PII-bearing, internal) escalation summary. */
export class DynamicLedger implements LedgerPort {
  constructor(private readonly opts: DynamicLedgerOptions) {}

  async answerQuery(action: Action): Promise<string> {
    const units = await this.opts.signer.usdcBalance();
    const balance = formatUsdc(units);

    if (action.intent === "balance") {
      return `Tenés ${balance} USDC en tu wallet (Base Sepolia) 💧`;
    }

    // spending_insight / dashboard: lean on the categorized profile.
    const summary = computeSummary(await this.buildProfileWithChainBalance());
    const top = summary.categoryTotals
      .slice()
      .sort((a, b) => b.total - a.total)
      .slice(0, 3)
      .map((c) => `${c.category}`)
      .join(", ");

    return top === ""
      ? `Todavía no tengo movimientos categorizados. Tu saldo es ${balance} USDC.`
      : `Donde más se te va: ${top}. Saldo actual: ${balance} USDC.`;
  }

  async buildSummary(): Promise<Summary> {
    return computeSummary(await this.buildProfileWithChainBalance());
  }

  private async buildProfileWithChainBalance(): Promise<FinancialProfile> {
    const profile = await this.opts.profile();
    const units = await this.opts.signer.usdcBalance();
    return { ...profile, exactBalance: Number(formatUsdc(units)) };
  }
}

/**
 * Persists the agent's wallet metadata so the SAME wallet is reused across restarts.
 *
 * This is not an optimization. `createWalletAccount()` is not idempotent, and the
 * environment allows multiple embedded wallets per chain — so without this, every
 * boot would silently mint a NEW empty wallet at a new address and strand the funds
 * on the old one. The metadata is non-sensitive (ids + address); the MPC key shares
 * live with Dynamic, guarded by the wallet password.
 */
export interface WalletMetadataStore {
  load(): Promise<unknown | undefined>;
  save(metadata: unknown): Promise<void>;
}

/** Default store: a JSON file. Gitignore its directory. */
export function fileWalletMetadataStore(path: string): WalletMetadataStore {
  return {
    load: async () => {
      const { readFile } = await import("node:fs/promises");
      try {
        return JSON.parse(await readFile(path, "utf8")) as unknown;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    save: async (metadata) => {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(metadata, null, 2));
    },
  };
}

export interface CreateSignerOptions {
  readonly environmentId: string;
  readonly agentSigningToken: `0x${string}`;
  readonly walletPassword: string;
  readonly appOrigin: string;
  readonly rpcUrl: string;
  readonly usdcAddress: `0x${string}`;
  /** Where the wallet metadata is remembered. Omit → wallet is created every time. */
  readonly metadataStore?: WalletMetadataStore;
}

/**
 * Builds the real signer against Dynamic's Node SDK.
 *
 * Every import here is dynamic on purpose (BR-D7): `@dynamic-labs-wallet/node`
 * pulls a native MPC addon that throws `Neon: unsupported system: win32` at load
 * time, so merely importing this module must not drag it in.
 *
 * The wallet is created on first use and reused afterwards; its MPC shares are
 * backed up to Dynamic under `walletPassword`.
 */
export async function createDynamicSigner(opts: CreateSignerOptions): Promise<OnchainSigner> {
  const [{ DynamicEvmWalletClient }, walletNode, { privateKeyToAccount }, viem] = await Promise.all([
    import("@dynamic-labs-wallet/node-evm"),
    import("@dynamic-labs-wallet/node"),
    import("viem/accounts"),
    import("viem"),
  ]);
  const { createAuthClient, generateSessionKeyPair, signSessionMessage } = walletNode;
  const { ThresholdSignatureScheme } = await import("@dynamic-labs-wallet/core");

  const { publicKeyHex, privateKeyJwk } = await generateSessionKeyPair();
  const agentAccount = privateKeyToAccount(opts.agentSigningToken);

  const auth = createAuthClient({
    environmentId: opts.environmentId,
    appOrigin: opts.appOrigin,
  });

  // SIWE sign-in: the agent signs with its own key and mints its own user JWT.
  const { jwt } = await auth.wallet.signIn({
    address: agentAccount.address,
    signMessage: (message: string) => agentAccount.signMessage({ message }),
    sessionPublicKey: publicKeyHex,
    statement: "Verdict agent sign-in",
  });

  const client = new DynamicEvmWalletClient({ environmentId: opts.environmentId });
  await client.authenticateJwt(jwt, {
    getSessionSignature: (message: string) => signSessionMessage(message, privateKeyJwk),
  });

  // Reuse the existing wallet when we have it; only create one the first time.
  const stored = await opts.metadataStore?.load();
  let walletMetadata: Awaited<ReturnType<typeof client.createWalletAccount>>["walletMetadata"];

  if (stored !== undefined) {
    walletMetadata = stored as typeof walletMetadata;
    console.log(`[dynamic] reusing wallet ${(walletMetadata as { accountAddress: string }).accountAddress}`);
  } else {
    const created = await client.createWalletAccount({
      thresholdSignatureScheme: ThresholdSignatureScheme.TWO_OF_TWO,
      password: opts.walletPassword,
      backUpToDynamic: true,
    });
    walletMetadata = created.walletMetadata;
    await opts.metadataStore?.save(walletMetadata);
    console.log(`[dynamic] created wallet ${walletMetadata.accountAddress}`);
  }

  const walletClient = (
    await client.getWalletClient({
      walletMetadata,
      password: opts.walletPassword,
      chainId: CHAIN_ID,
      rpcUrl: opts.rpcUrl,
    })
  ).extend(viem.publicActions);

  const address = walletMetadata.accountAddress as `0x${string}`;

  return {
    address,
    nativeBalance: () => walletClient.getBalance({ address }),
    usdcBalance: () =>
      walletClient.readContract({
        address: opts.usdcAddress,
        abi: viem.erc20Abi,
        functionName: "balanceOf",
        args: [address],
      }) as Promise<bigint>,
    transferUsdc: (to, amountUnits) =>
      walletClient.writeContract({
        address: opts.usdcAddress,
        abi: viem.erc20Abi,
        functionName: "transfer",
        args: [to, amountUnits],
      }) as Promise<`0x${string}`>,
  };
}
