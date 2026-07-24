import type { Category, CategorySlice, DashboardData, MerchantSlice, Range, TrendPoint } from "./types.js";
import { colorFor } from "./palette.js";

/**
 * Renders DashboardData into a self-contained HTML page (spec BR-D10: HTML + inline
 * SVG, no CDNs, data injected server-side). This is the PERSONAL view — full detail,
 * NOT anonymized (BR-D1). Deliberate dark theme (BR-D9, chosen not defaulted).
 *
 * Charts: ranked horizontal bars for categories & merchants (BR-D4), a single-axis
 * income-vs-expense line (BR-D7), and a full table view for a11y (BR-D8). Hover is
 * native via SVG <title> / element title attributes.
 *
 * The `Category` enum stays in its domain (Spanish, per spec §5 taxonomy); only the
 * presentation labels below are English, so the UI translates without touching the
 * domain model or the spec.
 */

const CATEGORY_LABEL: Record<Category, string> = {
  comida: "Food",
  mercado: "Groceries",
  transporte: "Transport",
  servicios: "Utilities",
  suscripciones: "Subscriptions",
  compras: "Shopping",
  salud: "Health",
  entretenimiento: "Entertainment",
  hogar: "Housing",
  educacion: "Education",
  ingresos: "Income",
  transferencias: "Transfers",
  otros: "Other",
};

const RANGE_LABEL: Record<Range, string> = { mes: "month", "3meses": "3 months", "12meses": "12 months" };

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
const usd = (n: number): string => `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

function bars(rows: { label: string; amount: number; color: string; pct?: number }[]): string {
  const max = Math.max(1, ...rows.map((r) => r.amount));
  return rows
    .map((r) => {
      const w = Math.max(2, Math.round((r.amount / max) * 100));
      const pct = r.pct !== undefined ? `<span class="pct">${r.pct}%</span>` : "";
      return `<div class="bar-row" title="${esc(r.label)}: ${usd(r.amount)}">
  <span class="bar-label">${esc(r.label)}</span>
  <span class="bar-track"><span class="bar-fill" style="width:${w}%;background:${r.color}"></span></span>
  <span class="bar-val">${usd(r.amount)} ${pct}</span>
</div>`;
    })
    .join("");
}

function trendSvg(points: readonly TrendPoint[]): string {
  if (points.length === 0) return `<p class="muted">No trend data yet.</p>`;
  const W = 640, H = 200, PAD = 32;
  const max = Math.max(1, ...points.flatMap((p) => [p.expense, p.income]));
  const x = (i: number): number => PAD + (i * (W - 2 * PAD)) / Math.max(1, points.length - 1);
  const y = (v: number): number => H - PAD - (v / max) * (H - 2 * PAD);
  const line = (key: "expense" | "income", color: string): string => {
    const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(" ");
    const dots = points
      .map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p[key]).toFixed(1)}" r="3.5" fill="${color}"><title>${esc(p.period)} · ${key === "expense" ? "spending" : "income"} ${usd(p[key])}</title></circle>`)
      .join("");
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.5"/>${dots}`;
  };
  const labels = points
    .map((p, i) => `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" class="axis">${esc(p.period.slice(5))}</text>`)
    .join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Income vs. spending by month" class="trend">
  ${line("income", "#06d6a0")}
  ${line("expense", "#ff6b6b")}
  ${labels}
</svg>
<div class="legend"><span><i style="background:#06d6a0"></i>Income</span><span><i style="background:#ff6b6b"></i>Spending</span></div>`;
}

function kpiTiles(d: DashboardData): string {
  const k = d.kpis;
  const delta =
    k.spentDeltaPct === null
      ? ""
      : `<span class="delta ${k.spentDeltaPct > 0 ? "up" : "down"}">${k.spentDeltaPct > 0 ? "▲" : "▼"} ${Math.abs(k.spentDeltaPct)}% vs. prior period</span>`;
  const netLabel = k.net >= 0 ? "Surplus" : "Deficit";
  return `<div class="kpis">
  <div class="tile"><span class="tile-k">Spent (${esc(RANGE_LABEL[d.range])})</span><span class="tile-v">${usd(k.spent)}</span>${delta}</div>
  <div class="tile"><span class="tile-k">Net</span><span class="tile-v ${k.net >= 0 ? "pos" : "neg"}">${usd(k.net)}</span><span class="tile-sub">${netLabel}</span></div>
  <div class="tile"><span class="tile-k">Transactions</span><span class="tile-v">${k.txCount}</span></div>
  <div class="tile"><span class="tile-k">Subscriptions</span><span class="tile-v">${k.activeSubscriptions.count}</span><span class="tile-sub">${usd(k.activeSubscriptions.monthlyUsdc)}/mo</span></div>
</div>`;
}

function tableView(d: DashboardData): string {
  const cat = d.spendByCategory.map((c) => `<tr><td>${esc(CATEGORY_LABEL[c.category])}</td><td>${usd(c.amount)}</td><td>${c.pct}%</td></tr>`).join("");
  const mer = d.topMerchants.map((m) => `<tr><td>${esc(m.merchant)}</td><td>${usd(m.amount)}</td></tr>`).join("");
  return `<details class="table-view"><summary>View as table (accessible)</summary>
  <h3>Categories</h3><table><thead><tr><th>Category</th><th>Amount</th><th>%</th></tr></thead><tbody>${cat}</tbody></table>
  <h3>Merchants</h3><table><thead><tr><th>Merchant</th><th>Amount</th></tr></thead><tbody>${mer}</tbody></table>
</details>`;
}

const CSS = `
:root{--bg:#0e0f13;--surface:#171a21;--surface2:#1e222c;--text:#e8eaed;--muted:#9aa0aa;--accent:#d4af37;--line:#2a2f3a}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:24px}
.wrap{max-width:920px;margin:0 auto}
h1{font-size:1.5rem;margin:0 0 2px;letter-spacing:-.02em}
.sub{color:var(--muted);margin:0 0 24px;font-size:.9rem}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:24px}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:2px}
.tile-k{color:var(--muted);font-size:.78rem;text-transform:uppercase;letter-spacing:.05em}
.tile-v{font-size:1.6rem;font-weight:600;font-variant-numeric:tabular-nums}
.tile-v.pos{color:#06d6a0}.tile-v.neg{color:#ff6b6b}
.tile-sub{color:var(--muted);font-size:.8rem}
.delta{font-size:.78rem}.delta.up{color:#ff6b6b}.delta.down{color:#06d6a0}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin-bottom:16px}
.panel h2{font-size:1rem;margin:0 0 14px;font-weight:600}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:720px){.grid2{grid-template-columns:1fr}}
.bar-row{display:grid;grid-template-columns:120px 1fr auto;align-items:center;gap:10px;margin:7px 0;font-size:.86rem}
.bar-label{color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar-track{background:var(--surface2);border-radius:6px;height:14px;overflow:hidden}
.bar-fill{display:block;height:100%;border-radius:6px}
.bar-val{color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
.bar-val .pct{color:var(--text);font-weight:600}
.trend{width:100%;height:auto}
.axis{fill:var(--muted);font-size:11px}
.legend{display:flex;gap:16px;color:var(--muted);font-size:.8rem;margin-top:6px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:middle}
.muted{color:var(--muted)}
.table-view{margin-top:16px;color:var(--muted)}
.table-view summary{cursor:pointer}
table{border-collapse:collapse;width:100%;margin:8px 0 16px;font-size:.85rem}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line)}
.foot{color:var(--muted);font-size:.75rem;margin-top:20px}
`;

export function renderDashboard(d: DashboardData): string {
  const catRows = d.spendByCategory.map((c: CategorySlice) => ({ label: CATEGORY_LABEL[c.category], amount: c.amount, color: colorFor(c.category), pct: c.pct }));
  const merRows = d.topMerchants.map((m: MerchantSlice) => ({ label: m.merchant, amount: m.amount, color: "var(--accent)" }));

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Your finances · Verdict</title><style>${CSS}</style></head>
<body><div class="wrap">
<h1>Where your money goes</h1>
<p class="sub">Personal view — full detail, just for you. Generated ${esc(d.generatedAt.slice(0, 16).replace("T", " "))} · ${esc(d.currency)}</p>
${kpiTiles(d)}
<div class="panel"><h2>Where does my money go?</h2>${bars(catRows)}</div>
<div class="grid2">
  <div class="panel"><h2>How it changes month to month</h2>${trendSvg(d.monthlyTrend)}</div>
  <div class="panel"><h2>Top merchants</h2>${bars(merRows)}</div>
</div>
${tableView(d)}
<p class="foot">Payments are real transactions on Base Sepolia (testnet), traceable on-chain. Sample spending profile for the demo.</p>
</div></body></html>`;
}
