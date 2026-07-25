import type { FinancialProfile } from "./types.js";

/**
 * Demo financial profile for the public playground (`/demo`) and any pre-Dynamic
 * run. A realistic Colombian July window (COP) with June as the prior period, so
 * the anonymized reviewer preview and the natural-language spending answers have
 * real shape instead of the empty fail-closed stub. Fake data — no PII — and it
 * mirrors the dashboard seed (`dashboard/demoSeed`). The real on-chain ledger via
 * Dynamic replaces this once the wallet signs in.
 */
export const DEMO_PROFILE: FinancialProfile = {
  identity: { name: "Demo User" },
  monthlyIncome: 4_000_000,
  exactBalance: 1_200_000,
  transactions: [
    { id: "d1", merchant: "Rent", amount: 1_400_000, currency: "COP", date: "2026-07-01", category: "vivienda" },
    { id: "d2", merchant: "Rappi", amount: 180_000, currency: "COP", date: "2026-07-05", category: "comida" },
    { id: "d3", merchant: "Uber", amount: 95_000, currency: "COP", date: "2026-07-07", category: "transporte" },
    { id: "d4", merchant: "Netflix", amount: 42_000, currency: "COP", date: "2026-07-08", category: "suscripciones" },
    { id: "d5", merchant: "Spotify", amount: 38_000, currency: "COP", date: "2026-07-09", category: "suscripciones" },
    { id: "d6", merchant: "Claro", amount: 70_000, currency: "COP", date: "2026-07-10", category: "servicios" },
    { id: "d7", merchant: "Falabella", amount: 220_000, currency: "COP", date: "2026-07-12", category: "otros" },
    { id: "d8", merchant: "Crepes", amount: 60_000, currency: "COP", date: "2026-07-15", category: "comida" },
  ],
  priorPeriodTotals: {
    vivienda: 1_400_000,
    comida: 210_000,
    transporte: 130_000,
    suscripciones: 80_000,
    servicios: 70_000,
    otros: 180_000,
  },
};
