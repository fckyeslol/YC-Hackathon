import type { RawSpend } from "./ledgerAdapter.js";

/**
 * Demo spending source for the dashboard (BR-D1 personal view). A realistic
 * Colombian 3-month window in COP so the month-over-month trend has real shape.
 *
 * ⚠️ VERIFICAR: this is example data for the demo. The chain (Basescan) knows
 * amounts and dates, not merchants or categories, so a real "spending profile"
 * needs a categorized transaction source. Swap this before claiming the numbers
 * are the user's own. The real on-chain payments are separate and ARE traceable.
 */
export const DEMO_SPEND: readonly RawSpend[] = [
  // --- May 2026 ---
  { id: "m0", amountCop: 4_000_000, date: "2026-05-01", category: "ingresos", direction: "income" },
  { id: "m1", amountCop: 1_400_000, date: "2026-05-01", category: "vivienda", merchant: "Rent" },
  { id: "m2", amountCop: 120_000, date: "2026-05-06", category: "comida", merchant: "Rappi" },
  { id: "m3", amountCop: 110_000, date: "2026-05-09", category: "transporte", merchant: "Uber" },
  { id: "m4", amountCop: 42_000, date: "2026-05-08", category: "suscripciones", merchant: "Netflix" },
  { id: "m5", amountCop: 70_000, date: "2026-05-10", category: "servicios", merchant: "Claro" },

  // --- June 2026 ---
  { id: "j0", amountCop: 4_000_000, date: "2026-06-01", category: "ingresos", direction: "income" },
  { id: "j1", amountCop: 1_400_000, date: "2026-06-01", category: "vivienda", merchant: "Rent" },
  { id: "j2", amountCop: 210_000, date: "2026-06-05", category: "comida", merchant: "Rappi" },
  { id: "j3", amountCop: 130_000, date: "2026-06-11", category: "transporte", merchant: "Uber" },
  { id: "j4", amountCop: 42_000, date: "2026-06-08", category: "suscripciones", merchant: "Netflix" },
  { id: "j5", amountCop: 38_000, date: "2026-06-09", category: "suscripciones", merchant: "Spotify" },
  { id: "j6", amountCop: 70_000, date: "2026-06-10", category: "servicios", merchant: "Claro" },
  { id: "j7", amountCop: 180_000, date: "2026-06-18", category: "compras", merchant: "Falabella" },

  // --- July 2026 ---
  { id: "d0", amountCop: 4_000_000, date: "2026-07-01", category: "ingresos", direction: "income" },
  { id: "d1", amountCop: 1_400_000, date: "2026-07-01", category: "vivienda", merchant: "Rent" },
  { id: "d2", amountCop: 180_000, date: "2026-07-05", category: "comida", merchant: "Rappi" },
  { id: "d3", amountCop: 95_000, date: "2026-07-07", category: "transporte", merchant: "Uber" },
  { id: "d4", amountCop: 42_000, date: "2026-07-08", category: "suscripciones", merchant: "Netflix" },
  { id: "d5", amountCop: 38_000, date: "2026-07-09", category: "suscripciones", merchant: "Spotify" },
  { id: "d6", amountCop: 70_000, date: "2026-07-10", category: "servicios", merchant: "Claro" },
  { id: "d7", amountCop: 220_000, date: "2026-07-12", category: "compras", merchant: "Falabella" },
  { id: "d8", amountCop: 60_000, date: "2026-07-15", category: "comida", merchant: "Crepes" },
];
