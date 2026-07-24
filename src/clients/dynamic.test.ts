import { describe, expect, test, vi } from "vitest";
import type { Action } from "../agent/types.js";
import type { FinancialProfile } from "../anonymization/types.js";
import {
  AmountCapExceededError,
  DynamicLedger,
  DynamicWallet,
  InsufficientGasError,
  InsufficientUsdcError,
  MissingAmountError,
  NETWORK,
  UnknownPayeeError,
  formatUsdc,
  inMemoryPaidActions,
  parsePayees,
  resolveAmountUnits,
  usdcToUnits,
  type OnchainSigner,
} from "./dynamic.js";

/**
 * Oracle for specs/dynamic-payments.spec.md (BR-D1..BR-D10).
 *
 * Everything runs against a fake signer — no network, no native MPC addon — which
 * is exactly what BR-D7 requires so this suite passes on Windows too.
 */

const PAYEE = "0xb42857974D0B8340207c4cD369daF678c1531D03" as const;
const AGENT = "0x50A65139B8d824A0eaFD57077F42684b89e91b7A" as const;
const TX = "0xda88450742a71e658d07338382dcc529f6555a630716330a5cf2c35318914c72" as const;

interface FakeOpts {
  gas?: bigint;
  usdc?: bigint;
  onTransfer?: (to: `0x${string}`, units: bigint) => void;
}

function fakeSigner(opts: FakeOpts = {}): OnchainSigner & { transfers: number } {
  const state = {
    address: AGENT,
    transfers: 0,
    nativeBalance: async () => opts.gas ?? 10_000_000_000_000n,
    usdcBalance: async () => opts.usdc ?? 20_000_000n, // 20 USDC
    transferUsdc: async (to: `0x${string}`, units: bigint) => {
      state.transfers += 1;
      opts.onTransfer?.(to, units);
      return TX;
    },
  };
  return state;
}

function payAction(params: Record<string, unknown>, actionId?: string): Action {
  return {
    intent: "pay",
    type: "payment",
    params,
    riskSignals: {
      amountBucket: "bajo",
      novelCounterparty: false,
      volatileSwap: false,
      modelConfidence: 0.9,
    },
    confidence: 0.9,
    missingSlots: [],
    rawText: "pago de prueba",
    actionId,
  };
}

function wallet(signer: OnchainSigner, over: Partial<{ maxUsdcPerTx: number; copPerUsdc: number }> = {}) {
  return new DynamicWallet({
    signer,
    payees: parsePayees(`mama:${PAYEE}`),
    copPerUsdc: over.copPerUsdc ?? 4000,
    maxUsdcPerTx: over.maxUsdcPerTx ?? 5,
    paidActions: inMemoryPaidActions(),
  });
}

describe("money math", () => {
  test("usdcToUnits/formatUsdc roundtrip without floats", () => {
    expect(usdcToUnits("0.001")).toBe(1000n);
    expect(usdcToUnits("1")).toBe(1_000_000n);
    expect(usdcToUnits("$0.05")).toBe(50_000n);
    expect(formatUsdc(1000n)).toBe("0.001");
    expect(formatUsdc(1_000_000n)).toBe("1");
    expect(formatUsdc(0n)).toBe("0");
    expect(formatUsdc(usdcToUnits("0.123456"))).toBe("0.123456");
  });

  test("BR-D10 — a bare amount is COP and gets converted", () => {
    // 40 000 COP / 4000 = 10 USDC
    expect(resolveAmountUnits({ amount: 40_000 }, 4000)).toBe(10_000_000n);
  });

  test("BR-D10 — explicit USDC is taken at face value", () => {
    expect(resolveAmountUnits({ amount: 2, currency: "USDC" }, 4000)).toBe(2_000_000n);
    expect(resolveAmountUnits({ amount: 2, currency: "usd" }, 4000)).toBe(2_000_000n);
  });

  test("rejects missing or non-positive amounts", () => {
    expect(() => resolveAmountUnits({}, 4000)).toThrow(MissingAmountError);
    expect(() => resolveAmountUnits({ amount: 0 }, 4000)).toThrow(MissingAmountError);
    expect(() => resolveAmountUnits({ amount: -5 }, 4000)).toThrow(MissingAmountError);
  });

  test("parsePayees ignores malformed entries", () => {
    const payees = parsePayees(`mama:${PAYEE},roto,juan:0x123,  :${PAYEE}`);
    expect([...payees.keys()]).toEqual(["mama"]);
  });
});

describe("WalletPort — spec criteria", () => {
  test("BR-D1 — network is always base-sepolia", () => {
    expect(wallet(fakeSigner()).network).toBe(NETWORK);
    expect(wallet(fakeSigner()).network).toBe("base-sepolia");
  });

  test("pays a known payee and returns the tx ref", async () => {
    const seen: Array<{ to: string; units: bigint }> = [];
    const signer = fakeSigner({ onTransfer: (to, units) => seen.push({ to, units }) });

    const result = await wallet(signer).pay(payAction({ amount: 2, currency: "USDC", recipient: "mama" }));

    expect(result.txRef).toBe(TX);
    expect(seen).toEqual([{ to: PAYEE, units: 2_000_000n }]);
  });

  test("resolves the payee case-insensitively", async () => {
    const signer = fakeSigner();
    await expect(
      wallet(signer).pay(payAction({ amount: 1, currency: "USDC", recipient: "MaMa" })),
    ).resolves.toEqual({ txRef: TX });
  });

  test("BR-D9 — an unknown payee is never paid", async () => {
    const signer = fakeSigner();
    await expect(
      wallet(signer).pay(payAction({ amount: 1, currency: "USDC", recipient: "pedro" })),
    ).rejects.toThrow(UnknownPayeeError);
    expect(signer.transfers).toBe(0);
  });

  test("BR-D9 — a missing recipient is never paid", async () => {
    const signer = fakeSigner();
    await expect(wallet(signer).pay(payAction({ amount: 1, currency: "USDC" }))).rejects.toThrow(
      UnknownPayeeError,
    );
    expect(signer.transfers).toBe(0);
  });

  test("BR-D10 — over the per-tx cap nothing is signed", async () => {
    const signer = fakeSigner();
    await expect(
      wallet(signer, { maxUsdcPerTx: 5 }).pay(
        payAction({ amount: 6, currency: "USDC", recipient: "mama" }),
      ),
    ).rejects.toThrow(AmountCapExceededError);
    expect(signer.transfers).toBe(0);
  });

  test("BR-D8 — no native ETH means no signature", async () => {
    const signer = fakeSigner({ gas: 0n });
    await expect(
      wallet(signer).pay(payAction({ amount: 1, currency: "USDC", recipient: "mama" })),
    ).rejects.toThrow(InsufficientGasError);
    expect(signer.transfers).toBe(0);
  });

  test("BR-D8 — insufficient USDC is named, not reverted", async () => {
    const signer = fakeSigner({ usdc: 500_000n }); // 0.5 USDC
    await expect(
      wallet(signer).pay(payAction({ amount: 1, currency: "USDC", recipient: "mama" })),
    ).rejects.toThrow(InsufficientUsdcError);
    expect(signer.transfers).toBe(0);
  });

  test("BR-D4 — replaying the same actionId returns the original tx, no second transfer", async () => {
    const signer = fakeSigner();
    const w = wallet(signer);
    const action = payAction({ amount: 1, currency: "USDC", recipient: "mama" }, "a1");

    const first = await w.pay(action);
    const second = await w.pay(action);

    expect(second.txRef).toBe(first.txRef);
    expect(signer.transfers).toBe(1);
  });

  test("BR-D4 — different actionIds do execute separately", async () => {
    const signer = fakeSigner();
    const w = wallet(signer);

    await w.pay(payAction({ amount: 1, currency: "USDC", recipient: "mama" }, "a1"));
    await w.pay(payAction({ amount: 1, currency: "USDC", recipient: "mama" }, "a2"));

    expect(signer.transfers).toBe(2);
  });

  test("BR-D6 — the log line carries no payee name", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await wallet(fakeSigner()).pay(payAction({ amount: 1, currency: "USDC", recipient: "mama" }));
      const lines = log.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(lines).not.toContain("mama");
      expect(lines).toContain(TX);
    } finally {
      log.mockRestore();
    }
  });
});

const PROFILE: FinancialProfile = {
  identity: { name: "Mateo Pirela", phone: "+573187474092" },
  transactions: [
    { id: "t1", merchant: "Rappi", amount: 60_000, currency: "COP", date: "2026-07-01", category: "comida" },
    { id: "t2", merchant: "Uber", amount: 30_000, currency: "COP", date: "2026-07-02", category: "transporte" },
    { id: "t3", merchant: "Netflix", amount: 20_000, currency: "COP", date: "2026-07-03", category: "suscripciones" },
  ],
  monthlyIncome: 4_000_000,
  exactBalance: 1_000_000,
};

describe("LedgerPort", () => {
  test("balance query reports the on-chain USDC balance", async () => {
    const ledger = new DynamicLedger({
      signer: fakeSigner({ usdc: 19_999_000n }),
      profile: async () => PROFILE,
    });

    const answer = await ledger.answerQuery({ ...payAction({}), intent: "balance" });

    expect(answer).toContain("19.999");
    expect(answer).toContain("USDC");
  });

  test("BR-D3 — buildSummary keeps PII internally for the anonymizer to strip", async () => {
    const ledger = new DynamicLedger({
      signer: fakeSigner({ usdc: 2_500_000n }),
      profile: async () => PROFILE,
    });

    const summary = await ledger.buildSummary();

    expect(summary.identity.name).toBe("Mateo Pirela");
    expect(summary.rawTransactions.length).toBe(3);
    // The chain is the source of truth for balance (2.5 USDC), overriding the seed.
    expect(summary.exactBalance).toBe(2.5);
  });

  test("spending insight names the top categories", async () => {
    const ledger = new DynamicLedger({
      signer: fakeSigner(),
      profile: async () => PROFILE,
    });

    const answer = await ledger.answerQuery({ ...payAction({}), intent: "spending_insight" });
    expect(answer).toContain("comida");
  });
});
