# Spec: Dashboard Visual de Gastos (bajo demanda)

- **Estado:** 🟡 Aprobado por Mateo — 2026-07-24 (código pendiente)
- **ADR:** — (sin ADR dedicado; hereda la frontera de privacidad de [ADR-003](../entregables/ADR-003-anonimizacion.md))
- **Depende de:** tipos de **ledger** (aún no definidos — ver §6, ítem de drift) · [`anonymization.spec.md`](anonymization.spec.md) (contraparte de privacidad)
- **Producto:** [`PLAN.md §5.1`](../PLAN.md)

> El usuario pide por iMessage *"muéstrame en qué se me va la plata"* y recibe un **link
> a una página visual** servida por el propio Fastify. Es la vista de *cómo se mueve su
> dinero* que no cabe en un chat de texto. **Es su propia data → detalle completo**, a
> diferencia del resumen anonimizado que va a revisores (esa es la distinción crítica).

---

## 1. Contrato de I/O

```
Petición (texto en iMessage)  ──► parseIntent() ──► Action { type: "dashboard", params: { range } }
Action                        ──► buildDashboard(userId, range) ──► DashboardData
DashboardData                 ──► renderPage() ──► HTML autocontenido (SVG/Canvas inline)
HTML                          ──► publishTokenizedLink() ──► URL con token + expiración
URL                           ──► Linq (MessagePart tipo "link") ──► iMessage del usuario
```

### 1.1 Entrada — transacciones del ledger

El dashboard **lee, no calcula transacciones**. Consume la fuente de verdad on-chain
(pagos trazados vía Dynamic) ya normalizada a esta forma:

```ts
type Direction = "expense" | "income" | "transfer";

interface LedgerTx {
  readonly id: string;
  readonly at: string;          // ISO 8601
  readonly amountUsdc: number;  // monto en USDC (positivo); el signo lo da `direction`
  readonly direction: Direction;
  readonly category: Category;  // ver §5 taxonomía
  readonly merchant?: string;   // comercio/contraparte legible
  readonly account?: string;
  readonly txHash?: string;     // enlace al explorer (trazabilidad)
}
```

### 1.2 Salida — payload que consume cada chart

Un solo objeto pre-computado server-side; la página no hace lógica financiera, solo pinta.

```ts
type Range = "mes" | "3meses" | "12meses";

interface DashboardData {
  readonly range: Range;
  readonly generatedAt: string;         // ISO
  readonly currency: "USDC";
  readonly kpis: Kpis;
  readonly spendByCategory: CategorySlice[];  // Panel 1
  readonly monthlyTrend: TrendPoint[];        // Panel 2
  readonly topMerchants: MerchantSlice[];     // Panel 3
  readonly dailyRhythm?: DayCell[];           // Panel 4 (opcional)
}

interface Kpis {
  readonly spent: number;                // gasto del período
  readonly spentDeltaPct: number | null; // vs período anterior; null si no hay base
  readonly net: number;                  // ingreso − gasto (con signo)
  readonly txCount: number;
  readonly activeSubscriptions: { readonly count: number; readonly monthlyUsdc: number };
}

interface CategorySlice {
  readonly category: Category;
  readonly amount: number;
  readonly pct: number;                  // 0..100, sobre el gasto total del período
}

interface TrendPoint {
  readonly period: string;               // "2026-05" | ISO de semana según range
  readonly expense: number;
  readonly income: number;
}

interface MerchantSlice {
  readonly merchant: string;             // "Otros" agrupa la cola
  readonly amount: number;
}

interface DayCell {
  readonly date: string;                 // "2026-05-14"
  readonly amount: number;               // gasto del día
}
```

---

## 2. Reglas de negocio

| id | Regla |
|---|---|
| **BR-D1** | El dashboard es **personal**: lo ve solo el dueño de la data → muestra **detalle completo** (comercios, montos exactos). NO se anonimiza. Es el flujo *opuesto* a [`anonymization.spec.md`](anonymization.spec.md); no confundirlos ni reusar código de anonimización aquí. |
| **BR-D2** | El link es **tokenizado y expira** (token no adivinable + TTL). Sin token válido → 404/expirado. Nunca una URL pública con finanzas. |
| **BR-D3** | Los `transfer` **se excluyen** del gasto (KPI `spent`, `spendByCategory`, `topMerchants`) para no inflar. Sí pueden contarse aparte. |
| **BR-D4** | Distribución de gasto = **barras horizontales rankeadas**, nunca pie/dona (comparar longitudes > ángulos). |
| **BR-D5** | Máximo **8 categorías** visibles; la cola se pliega en **"Otros"**. Jamás un 9° color generado. |
| **BR-D6** | Color **categórico de orden fijo**: cada categoría tiene su hue estable; un filtro que cambie el conteo **no repinta** las supervivientes. Paleta **validada por script** (CVD ΔE ≥ 8) antes de shippear. |
| **BR-D7** | **Un solo eje Y** en la tendencia. Ingreso y gasto comparten escala (USDC); prohibido doble eje. |
| **BR-D8** | Todo chart lleva **hover** (crosshair+tooltip en línea, tooltip por marca en barras) y existe **vista de tabla** (identidad nunca solo por color). |
| **BR-D9** | Modo claro/oscuro **elegido a propósito** (no flip automático); no default a dark. |
| **BR-D10** | La página es **autocontenida** (HTML+SVG/Canvas inline, datos inyectados). Sin CDNs de charts ni servicios externos. |
| **BR-D11** | Cada monto/tx es **trazable** al explorer vía `txHash` cuando exista (coherente con la tesis de trazabilidad de Dynamic). |

---

## 3. Set visual y marcas (detalle A)

Orden de lectura: general → específico. Desktop: fila KPI full-width + grid 2-col debajo.

### Fila 0 — KPIs (stat tiles, *no* charts)
Trabajo = magnitud + su cambio → tiles, no serie.
- **Gastado (período)** `$` + Δ% con **icono ↑/↓ + etiqueta** (no color solo).
- **Neto** `$` con signo; polaridad superávit/déficit con **icono + label** (status reservado).
- **Transacciones** conteo (+ sparkline opcional).
- **Suscripciones activas** conteo + `$/mes`.

### Panel 1 — "¿En qué se me va la plata?"
- Forma: **barras horizontales rankeadas** (mayor arriba). Ver BR-D4/D5/D6.
- Encoding: longitud = monto; etiqueta directa del valor y `%` al final.
- Marca: barra fina, extremo redondeado 4px anclado al baseline, gap 2px.

### Panel 2 — "¿Cómo cambia mes a mes?"
- Forma: **línea** ingreso vs. gasto (2 series). Un solo eje (BR-D7).
- Leyenda presente + etiqueta directa en la última punta de cada línea.
- Interacción: crosshair + tooltip.

### Panel 3 — "Top comercios"
- Forma: **barras horizontales top 7 + "Otros"**. Mismo tratamiento de marca que Panel 1.
- Color: puede ser secuencial (un hue, intensidad por monto) — aquí es ranking de lo mismo, no identidades.

### Panel 4 — "Ritmo del mes" (opcional)
- Forma: **heatmap de calendario** (día × intensidad). Secuencial, **un solo hue** light→dark.
- Nice-to-have; dejar al final.

---

## 4. Criterios de aceptación

```gherkin
# language: es
Característica: Dashboard visual de gastos

  Escenario: BR-D3 — las transferencias no inflan el gasto
    Dado un ledger con un gasto de 100 y una transferencia de 500
    Cuando construyo el dashboard
    Entonces el KPI "spent" es 100
    Y la transferencia no aparece en spendByCategory ni en topMerchants

  Escenario: BR-D5 — más de 8 categorías se pliegan en "Otros"
    Dado un ledger con gasto en 11 categorías distintas
    Cuando construyo spendByCategory
    Entonces hay a lo sumo 9 slices (8 categorías + "Otros")
    Y "Otros" agrega el monto de la cola

  Escenario: BR-D6 — el color sigue a la categoría, no al rank
    Dado un dashboard con "Comida" y "Transporte" visibles
    Cuando filtro y "Transporte" desaparece
    Entonces "Comida" conserva su mismo color

  Escenario: BR-D2 — link sin token válido no expone data
    Dada una URL de dashboard con token inválido o expirado
    Cuando se solicita la página
    Entonces responde 404/expirado
    Y no se filtra ningún dato financiero

  Escenario: BR-D1 — el dashboard personal NO se anonimiza
    Dado un dashboard para el dueño de la data
    Entonces muestra comercios y montos exactos
    Y no invoca el pipeline de anonimización
```

---

## 5. Taxonomía de categorías (detalle B)

Orden fijo (define el orden de color categórico, BR-D6). Máx 8 visibles + "Otros" (BR-D5).

```ts
type Category =
  | "comida"          // restaurantes, domicilios, cafés
  | "mercado"         // supermercado, víveres
  | "transporte"      // gasolina, apps de movilidad, transporte público
  | "servicios"       // facturas: luz, agua, internet, celular
  | "suscripciones"   // streaming, SaaS, membresías recurrentes
  | "compras"         // retail, ropa, electrónica
  | "salud"           // farmacia, citas, seguros de salud  [categoría sensible]
  | "entretenimiento" // ocio, eventos, salidas
  | "hogar"           // arriendo, mantenimiento
  | "educacion"       // cursos, matrículas
  | "ingresos"        // entradas (no es gasto)
  | "transferencias"  // movimientos entre cuentas propias (excluido del gasto, BR-D3)
  | "otros";          // cajón de sastre + cola plegada
```

Notas:
- **`salud`** es categoría sensible: en el **dashboard personal** se muestra normal (es tu data);
  en el **resumen para revisores** se agrupa/excluye — esa lógica vive en `anonymization.spec.md`, **no aquí**.
- La asignación de categoría a cada tx es responsabilidad del **categorizador del ledger**
  (upstream), no del dashboard. El dashboard confía en `tx.category`.

---

## 6. Fuera de alcance

- **Presupuestos, metas, forecasting.** El dashboard describe el pasado/presente, no proyecta.
- **Tiempo real / streaming.** Se genera bajo demanda (snapshot al momento del pedido).
- **Edición de transacciones** desde el dashboard. Es de solo lectura.
- **Definición de los tipos de ledger.** ⚠️ *Drift abierto:* `src/store/types.ts` aún tiene
  vocabulario viejo (`Poll`/`Panelist`/`Vote`). `LedgerTx`/`Category` de este spec necesitan
  materializarse en el modelo de dominio del producto pivotado. Rastrear en el fix de product drift.
