import type { Category } from "./types.js";

/**
 * Fixed categorical palette (spec BR-D6): each category owns a STABLE hue, so a
 * filter that changes the visible set never repaints the survivors. Tuned to read
 * on the dark ground of the personal dashboard.
 *
 * ⚠️ VERIFICAR: the spec asks for a script-validated CVD palette (ΔE ≥ 8). These
 * values are hand-picked for distinctness on dark; run a CVD check before shipping
 * to production. Good enough for the demo.
 */
export const CATEGORY_COLOR: Record<Category, string> = {
  comida: "#f4a259",
  mercado: "#5aa9e6",
  transporte: "#57cc99",
  servicios: "#4d96ff",
  suscripciones: "#c77dff",
  compras: "#ff6b6b",
  salud: "#ffd166",
  entretenimiento: "#ff9ec7",
  hogar: "#80ed99",
  educacion: "#a0c4ff",
  ingresos: "#06d6a0",
  transferencias: "#8d99ae",
  otros: "#6c757d",
};

export function colorFor(category: Category): string {
  return CATEGORY_COLOR[category] ?? CATEGORY_COLOR.otros;
}
