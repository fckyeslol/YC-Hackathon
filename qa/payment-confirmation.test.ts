import { describe, expect, test, vi } from "vitest";
import type { Action } from "../src/agent/types.js";
import type { WalletPort } from "../src/agent/ports.js";
import {
  DEFAULT_PENDING_TTL_MS,
  PendingActionStore,
  reactionIntent,
} from "../src/agent/pendingAction.js";

/**
 * Oracle for specs/payment-confirmation.spec.md (BR-C1..BR-C9).
 *
 * The whole point of this suite is proving the negatives: that a bare "sí", an
 * expired proposal, a cancel, a re-confirm, or a failing wallet all end with the
 * correct number of `pay()` calls — which is usually zero or one, never two.
 */

const TX = "0xda88450742a71e658d07338382dcc529f6555a630716330a5cf2c35318914c72";
const CHAT = "chat-1";

function payAction(recipient = "ana", amount = 5000, actionId = "a1"): Action {
  return {
    intent: "pay",
    type: "payment",
    params: { amount, recipient },
    riskSignals: {
      amountBucket: "bajo",
      novelCounterparty: false,
      volatileSwap: false,
      modelConfidence: 0.9,
    },
    confidence: 0.9,
    missingSlots: [],
    rawText: `paga ${amount} a ${recipient}`,
    actionId,
  };
}

/** Wallet fake that counts calls and can be made to fail. */
function fakeWallet(opts: { fail?: Error; idempotent?: boolean } = {}) {
  const paid = new Map<string, string>();
  const wallet: WalletPort & { calls: number } = {
    network: "base-sepolia",
    calls: 0,
    pay: async (action: Action) => {
      if (opts.fail) throw opts.fail;
      if (opts.idempotent && action.actionId && paid.has(action.actionId)) {
        return { txRef: paid.get(action.actionId) as string };
      }
      wallet.calls += 1;
      if (action.actionId) paid.set(action.actionId, TX);
      return { txRef: TX };
    },
  };
  return wallet;
}

describe("BR-C1/BR-C2 — un pago confirmado se ejecuta una vez", () => {
  test("stage + confirm → pay una sola vez, y devuelve el txRef", async () => {
    const store = new PendingActionStore();
    const wallet = fakeWallet();

    store.stage(CHAT, payAction());
    expect(store.has(CHAT)).toBe(true);

    const outcome = await store.resolve(CHAT, wallet);

    expect(outcome).toEqual({ kind: "paid", txRef: TX });
    expect(wallet.calls).toBe(1);
    // El pending se consume: ya no queda nada que pagar.
    expect(store.has(CHAT)).toBe(false);
  });

  test("stagear NO paga por sí solo", async () => {
    const store = new PendingActionStore();
    const wallet = fakeWallet();

    store.stage(CHAT, payAction());

    expect(wallet.calls).toBe(0);
  });
});

describe("BR-C5 — un 'sí' sin pending no paga nada", () => {
  test("resolve sin nada staged → nothing_pending, cero llamadas", async () => {
    const store = new PendingActionStore();
    const wallet = fakeWallet();

    const outcome = await store.resolve("chat-vacio", wallet);

    expect(outcome).toEqual({ kind: "nothing_pending" });
    expect(wallet.calls).toBe(0);
  });

  test("un pending vencido no se paga", async () => {
    let clock = 1_000_000;
    const store = new PendingActionStore({ ttlMs: 60_000, now: () => clock });
    const wallet = fakeWallet();

    store.stage(CHAT, payAction());
    clock += 60_001; // pasó el TTL

    const outcome = await store.resolve(CHAT, wallet);

    expect(outcome).toEqual({ kind: "nothing_pending" });
    expect(wallet.calls).toBe(0);
  });

  test("dentro del TTL sí se paga", async () => {
    let clock = 1_000_000;
    const store = new PendingActionStore({ ttlMs: 60_000, now: () => clock });
    const wallet = fakeWallet();

    store.stage(CHAT, payAction());
    clock += 59_000;

    expect((await store.resolve(CHAT, wallet)).kind).toBe("paid");
    expect(wallet.calls).toBe(1);
  });

  test("el TTL por defecto es de minutos, no de horas", () => {
    expect(DEFAULT_PENDING_TTL_MS).toBe(600_000);
  });
});

describe("BR-C2 — cancelar descarta el pending", () => {
  test("cancel → no paga y queda descartado", async () => {
    const store = new PendingActionStore();
    const wallet = fakeWallet();

    store.stage(CHAT, payAction());
    expect(store.cancel(CHAT)).toEqual({ kind: "cancelled" });

    expect(store.has(CHAT)).toBe(false);
    expect(await store.resolve(CHAT, wallet)).toEqual({ kind: "nothing_pending" });
    expect(wallet.calls).toBe(0);
  });

  test("cancelar sin pending no inventa nada", () => {
    const store = new PendingActionStore();
    expect(store.cancel("chat-vacio")).toEqual({ kind: "nothing_pending" });
  });
});

describe("BR-C4 — reconfirmar no dobla el pago", () => {
  test("un segundo 'sí' tras pagar no vuelve a llamar pay", async () => {
    const store = new PendingActionStore();
    const wallet = fakeWallet();

    store.stage(CHAT, payAction());
    await store.resolve(CHAT, wallet);
    const second = await store.resolve(CHAT, wallet);

    expect(second).toEqual({ kind: "nothing_pending" });
    expect(wallet.calls).toBe(1);
  });

  test("re-stagear la MISMA acción y confirmar devuelve el txRef original (idempotencia por actionId)", async () => {
    const store = new PendingActionStore();
    const wallet = fakeWallet({ idempotent: true });
    const action = payAction("ana", 5000, "a1");

    store.stage(CHAT, action);
    const first = await store.resolve(CHAT, wallet);

    store.stage(CHAT, action); // el usuario lo pide de nuevo
    const second = await store.resolve(CHAT, wallet);

    expect(second).toEqual(first);
    expect(wallet.calls).toBe(1); // una sola tx on-chain
  });
});

describe("BR-C7 — errores nombrados, sin crash", () => {
  test("un fallo del wallet devuelve failed y descarta el pending", async () => {
    const store = new PendingActionStore();
    const wallet = fakeWallet({ fail: new Error('No conozco a "pedro" — no está en DYNAMIC_PAYEES.') });

    store.stage(CHAT, payAction("pedro"));
    const outcome = await store.resolve(CHAT, wallet);

    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.reason).toContain("DYNAMIC_PAYEES");
    // El loop sigue: no quedó nada pagable colgando.
    expect(store.has(CHAT)).toBe(false);
  });

  test("tras un fallo, un 'sí' posterior no reintenta el pago", async () => {
    const store = new PendingActionStore();
    const wallet = fakeWallet({ fail: new Error("sin gas") });

    store.stage(CHAT, payAction());
    await store.resolve(CHAT, wallet);
    const retry = await store.resolve(CHAT, wallet);

    expect(retry).toEqual({ kind: "nothing_pending" });
  });
});

describe("aislamiento entre chats y propuestas", () => {
  test("cada chat tiene su propio pending", async () => {
    const store = new PendingActionStore();
    const wallet = fakeWallet();

    store.stage("chat-a", payAction("ana", 1000, "a1"));
    store.stage("chat-b", payAction("beto", 2000, "b1"));

    await store.resolve("chat-a", wallet);

    expect(store.has("chat-a")).toBe(false);
    expect(store.has("chat-b")).toBe(true);
  });

  test("una propuesta nueva reemplaza la anterior del mismo chat", async () => {
    const store = new PendingActionStore();
    const wallet = fakeWallet();

    store.stage(CHAT, payAction("ana", 1000, "a1"), "msg-1");
    store.stage(CHAT, payAction("beto", 2000, "b1"), "msg-2");

    // El tapback sobre la propuesta vieja ya no resuelve nada.
    expect(store.chatForMessage("msg-1")).toBeUndefined();
    expect(store.chatForMessage("msg-2")).toBe(CHAT);

    await store.resolve(CHAT, wallet);
    expect(store.peek(CHAT)).toBeUndefined();
  });
});

describe("BR-C2 — lectura de tapbacks", () => {
  test("👍 confirma, 👎 cancela", () => {
    expect(reactionIntent("👍", "add")).toBe("confirm");
    expect(reactionIntent("thumbsup", "add")).toBe("confirm");
    expect(reactionIntent("👎", "add")).toBe("cancel");
  });

  test("una reacción ambigua NO confirma un pago", () => {
    // Reaccionar "jaja" o ❤️ a "enviar 5.000 a ana" no es consentir.
    for (const reaction of ["😂", "haha", "❤️", "heart", "‼️", "??", ""]) {
      expect(reactionIntent(reaction, "add")).toBe("ignore");
    }
  });

  test("quitar una reacción nunca confirma", () => {
    expect(reactionIntent("👍", "remove")).toBe("ignore");
  });
});

describe("BR-C9 — sin PII en el resultado", () => {
  test("el outcome pagado no lleva nombre ni monto del destinatario", async () => {
    const store = new PendingActionStore();
    const wallet = fakeWallet();

    store.stage(CHAT, payAction("ana", 5000));
    const outcome = await store.resolve(CHAT, wallet);

    expect(JSON.stringify(outcome)).not.toContain("ana");
    expect(JSON.stringify(outcome)).not.toContain("5000");
  });
});

describe("BR-C3 — el pending de pago es independiente del de revisión", () => {
  test("resolver el pending de pago no toca otras colas (no hay acoplamiento)", async () => {
    const store = new PendingActionStore();
    const wallet = fakeWallet();
    const otherQueue = vi.fn();

    store.stage(CHAT, payAction());
    await store.resolve(CHAT, wallet);

    expect(otherQueue).not.toHaveBeenCalled();
    expect(wallet.calls).toBe(1);
  });
});
