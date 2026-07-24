# Verdict — Asesor Financiero con Humanos en el Loop

> Documento de concepto para el hackathon de YC SS (iniciado 2026-07-24).
> Estado: **concepto cerrado, sin código nuevo todavía.**
> Nombre de trabajo: *Verdict* (puede cambiar — el producto pivotó desde un "motor de consenso" genérico a este asesor financiero).

---

## 1. Qué es (en una frase)

**Un asesor financiero personal que vive dentro de iMessage, cuyos consejos son revisados y mejorados por humanos reales — sin que esos humanos puedan ver quién eres ni una sola transacción cruda.**

Le escribes como a un amigo que sabe de plata. El agente entiende tus finanzas, mueve dinero por ti cuando se lo pides, y periódicamente hace que **revisores humanos reales** miren un **resumen anonimizado** de cómo vas y te devuelvan consejo con criterio humano. Ese mismo juicio humano, además, hace al agente más inteligente con el tiempo.

---

## 2. Por qué (el problema)

- Los asesores financieros son caros y no están en tu bolsillo a las 11pm cuando dudas si hacer una compra.
- Un LLM solo **suena** confiado pero no tiene criterio real ni responsabilidad sobre tu plata.
- La gente ya vive en su app de mensajes; no quiere instalar ni aprender otra herramienta.

**La apuesta:** un agente de IA que sabe **cuándo NO confiar en sí mismo** y escala a humanos reales, entregando consejo con criterio humano por el canal donde ya estás — y volviéndose mejor cada vez.

---

## 3. Los tres sponsors — y por qué ninguno es decorativo

| Sponsor | Rol en el producto | Por qué es indispensable |
|---|---|---|
| **Linq** ($1.5k) | **La interfaz.** Hablas con tu asesor por iMessage. | El dinero y el consejo suceden donde ya vives. Sin app que instalar. |
| **Dynamic** ($1k) | **El músculo + la fuente de verdad.** Wallet embebida no-custodial; los pagos pasan por ahí → quedan trazados on-chain. Ese ledger es lo que el agente lee para razonar. Uso creativo: **agent wallet** que retiene fondos y firma sola. | Sin Dynamic no hay movimiento de dinero real ni trazabilidad verificable. |
| **Terac** ($1.5k) | **El juicio humano.** Revisores reales miran un resumen anonimizado de tus finanzas y dan feedback. | Un LLM categoriza; un humano *aconseja con criterio*. Ese es el diferencial y la tesis literal de Terac: "humanos reales mejoraron el resultado, medible." |

**Consenso técnico (core "no hardcodeado"):** cuando varios revisores opinan, agregamos con **Dawid–Skene EM** — aprende qué revisores son confiables en vez de hacer voto por mayoría ingenuo. Este es el corazón "técnicamente impresionante" para el track general.

---

## 4. El loop completo

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                        │
│   TÚ  ──texto en iMessage──►  AGENTE (Linq)                            │
│                                    │                                   │
│                                    ▼                                   │
│                       ¿Acción de dinero?                               │
│                        │                    │                          │
│                   sí, clara            ambigua / riesgosa              │
│                        │                    │                          │
│                        ▼                    ▼                          │
│              Dynamic agent wallet     GUARDRAIL: escala a             │
│              ejecuta (USDC en          consenso humano (Terac)         │
│              Base Sepolia)                  │                          │
│                        │                    ▼                          │
│                        │            Revisores ven RESUMEN              │
│                        │            ANONIMIZADO, no crudo              │
│                        │                    │                          │
│                        ▼                    ▼                          │
│              Pago trazado          Dawid–Skene agrega juicios          │
│              on-chain (ledger)      → decisión / consejo               │
│                        │                    │                          │
│                        └────────┬───────────┘                         │
│                                 ▼                                      │
│                    Consejo llega a TI por iMessage                     │
│                                 +                                      │
│                    La corrección humana entrena al agente             │
│                    (mejor la próxima vez)                             │
│                                                                        │
└──────────────────────────────────────────────────────────────────────┘
```

**"Ambos" (decisión tomada):** el esfuerzo humano rinde doble — (a) te aconseja hoy **y** (b) mejora al agente para mañana.

---

## 5. Alcance del agente (decidido)

**Asistente financiero + guardrails.** El agente puede:

- **Pagos** en stablecoins (enviar / recibir / dividir).
- **Consultar portfolio** (balances, en qué gastas).
- **Swaps / trading** (cambiar una moneda por otra).
- **Consejo financiero** sobre tus hábitos.
- **Generar dashboards visuales** bajo demanda (ver §6).

**El twist que lo hace seguro e impresionante:** cuando una acción es **ambigua o riesgosa** (monto alto, destinatario dudoso, swap volátil), el agente **NO ejecuta solo** — escala a consenso humano vía Terac. Es "guardrails de agente vía consenso humano": una IA que maneja dinero real pero pide permiso a humanos cuando duda.

### 5.1 Dashboards visuales bajo demanda

Le pides por iMessage — *"genérame un dashboard de mis gastos de este mes"*, *"muéstrame en qué se me va la plata"* — y el agente:

1. Computa la distribución desde el **ledger** (los pagos trazados on-chain vía Dynamic) + categorización.
2. Genera una **página web visual** (gráficos de distribución de gastos por categoría, tendencia mensual, top comercios, cashflow).
3. Te manda el **link por iMessage** (Linq soporta partes de mensaje tipo `link`).

**Por qué fuera de iMessage:** iMessage es texto — no renderiza charts ricos. La página web te da la **vista visual de cómo se mueve tu dinero** que no cabe en un chat, mientras la conversación sigue viviendo en iMessage.

**Privacidad — distinción clave:** este dashboard es **para ti** (tu propia data, la ves tú) → puede mostrar **detalle completo**. Es **distinto** del resumen anonimizado que va a los revisores de Terac (§6), que sí se despoja de PID. No confundir los dos flujos:

| Flujo | Quién lo ve | Nivel de detalle |
|---|---|---|
| **Dashboard personal** | Solo tú | Completo (es tu data) |
| **Resumen para revisores** | Humanos de Terac | Anonimizado, sin PII, agregado |

**Stack (decidido):** **página autocontenida servida por el propio Fastify** — HTML + SVG/Canvas inline, datos inyectados server-side, entregada por un **link tokenizado con expiración**. No se usa un servicio externo de charts ni artifacts públicos. Los gráficos siguen el método dataviz (forma primero, color por su trabajo con paleta validada por script, barras horizontales rankeadas para distribución — no pie, un solo eje Y, hover por defecto, a11y con vista de tabla y modo claro/oscuro elegido a propósito).

**Set de charts (detalle completo, contrato de datos y taxonomía en [`specs/dashboard-visualization.spec.md`](specs/dashboard-visualization.spec.md)):**
- **Fila KPI (stat tiles, no charts):** gastado este mes + Δ%, neto ingreso−gasto (polaridad con icono+label), # transacciones, suscripciones activas.
- **Panel 1 — "¿En qué se me va la plata?":** barras horizontales rankeadas por categoría (máx ~8 + "Otros"), color categórico de orden fijo.
- **Panel 2 — "¿Cómo cambia mes a mes?":** línea ingreso vs. gasto, un solo eje, crosshair+tooltip.
- **Panel 3 — "Top comercios":** barras horizontales top 7 + "Otros".
- **Panel 4 (opcional) — "Ritmo del mes":** heatmap de calendario, secuencial un solo hue.

**Nota de privacidad:** el link debe protegerse (token/expiración) para que solo tú accedas — no una URL pública adivinable con tus finanzas.

### 5.2 Modo voz (decidido: IN)

Le puedes **hablar por nota de voz** — natural para finanzas ("oye, ¿puedo gastar 200 en esto?"). Capacidad técnica confirmada en §14.2.

- **Entrada de voz = IN.** Flujo: nota de voz → webhook `message.received` con parte `media` → descargar del CDN → **transcribir** (Whisper / gpt-4o-transcribe) → entra al **mismo pipeline de texto** (parser §5.3).
- **Respuesta en voz nativa (`voicememo`) = stretch** — primero que funcione el texto.
- **Idioma:** español (CO) como default de transcripción.
- **Fallback:** si la transcripción falla o queda de baja confianza → el agente responde *"no te entendí bien, ¿me lo escribes?"* en vez de adivinar.
- **Eco de confirmación:** en acciones de dinero, el agente **devuelve el texto transcrito** para confirmar antes de ejecutar (*"entendí: enviar $200 a Ana — ¿confirmas? 👍"*). Nunca mueve plata solo porque "creyó" entender un audio.

### 5.3 El parser de intención (detallado)

Es el cerebro que convierte un mensaje (texto **o** audio transcrito) en una **acción estructurada**. Vive en `src/agent/parser.ts`.

**Enfoque (no-hardcodeado):** LLM con **structured output / tool-calling** validado por un **schema Zod** — no regex frágil. El LLM clasifica intención + extrae *slots* (entidades) → objeto validado. Esto es parte del core "técnicamente impresionante" y auditable.

> **Separación de responsabilidades (fuente de verdad: [`specs/intent-parser.spec.md`](specs/intent-parser.spec.md) BR-P4):** el parser **extrae y clasifica intención + emite señales de riesgo CRUDAS** (`risk_signals`); **no decide** `auto`/`escalate`. Esa clasificación es del **guardrail** ([`specs/guardrail-escalation.spec.md`](specs/guardrail-escalation.spec.md), BR-G*). Este documento se alinea con esa división; el spec manda.

**Forma de salida:**
```ts
{
  intent: "pay" | "split" | "balance" | "spending_insight" | "dashboard"
        | "advice" | "swap" | "confirm" | "cancel" | "smalltalk" | "unknown",
  confidence: number,            // 0..1
  slots: { /* por intent, ver abajo */ },
  missing_slots: string[],       // dispara repregunta en vez de adivinar
  risk_signals: RiskSignals,     // CRUDAS (amountBucket, novelCounterparty, volatileSwap, modelConfidence);
                                 // el guardrail (§5) las clasifica auto/escalate — el parser NO pre-clasifica
  raw_text: string
}
```

**Slots por intención:**

| Intent | Slots | Señales de riesgo que suele emitir (las clasifica el guardrail) |
|---|---|---|
| `pay` | `amount`, `currency`, `recipient`, `memo?` | `amountBucket`, `novelCounterparty` |
| `split` | `total`, `participants[]`, `recipient?` | `amountBucket`, `novelCounterparty` |
| `balance` / `portfolio` | `scope?` | ninguna (consulta) |
| `spending_insight` | `period`, `category?` | ninguna (consulta) |
| `dashboard` | `period` | ninguna (consulta, §5.1) |
| `advice` | pregunta libre | `modelConfidence` (alto impacto → el guardrail escala) |
| `swap` | `from_asset`, `to_asset`, `amount` | `volatileSwap`, `amountBucket` |
| `confirm` / `cancel` | resuelve acción pendiente (o vía tapback) | — |

> `optout` / `optin` se manejan **antes** del parser (compliance, §14.4). `unknown`/`smalltalk` = fallback conversacional.

**Reglas del parser:**
1. **Slot-filling / clarificación:** si `missing_slots` no está vacío → el agente **repregunta** por iMessage (*"¿a quién le envío los $200?"*), no adivina. Multi-turno con estado por chat.
2. **Desambiguación de destinatario:** mapear `"Ana"` → contacto/allowlist; ambiguo o desconocido → repreguntar y/o marcar `novelCounterparty=true` (subir la **señal**, no clasificar el riesgo).
3. **El parser señaliza, el guardrail rutea (§5):** el parser emite las `risk_signals` crudas; el **guardrail** decide `auto` vs. `escalate` (consultas → auto directo; pago claro bajo umbral a destinatario conocido → confirmar y ejecutar; pago alto / destinatario nuevo / swap / consejo de alto impacto → escala a consenso humano vía Terac). El parser nunca toma esa decisión.
4. **Confirmación siempre para dinero:** aunque `confidence` sea alta, toda acción de dinero pide confirmación explícita (tapback 👍 o link tokenizado) antes de firmar la tx con Dynamic.
5. **Idempotencia:** cada acción de pago genera un `action_id`; usar `idempotency_key` de Linq + el de la tx para evitar doble ejecución si el usuario manda dos veces.
6. **Estado conversacional:** por chat, guardar `pending_action` para resolver `confirm`/`cancel` y el slot-filling multi-turno.

**Casos que deben pasar (tests / few-shot):**
- *"mándale 50 lucas a mi hermano"* → `pay {amount: 50000, currency: COP?, recipient: "hermano"}` — normalizar coloquial CO ("lucas"); `recipient` ambiguo → repreguntar.
- *"¿en qué se me fue la plata este mes?"* → `spending_insight {period: this_month}` (low).
- *"cámbiame 100 USDC a ETH"* → `swap {from: USDC, to: ETH, amount: 100}` (high).
- *"¿debería cancelar Netflix?"* → `advice` → escala a humano.
- *"sí, dale"* (tras propuesta de pago) → `confirm` sobre `pending_action`.

---

## 6. Resúmenes anonimizados — BIEN hechos (la pieza crítica)

**Regla de oro:** el revisor de Terac debe poder aconsejarte **sin poder identificarte ni ver una sola transacción cruda.** Un buen resumen describe un *patrón* que podría ser de miles de personas, no una huella única.

| El revisor **NUNCA** ve | El revisor **SÍ** ve |
|---|---|
| Nombre, teléfono, email, cédula, número de cuenta | Reparto por categoría en **%** ("42% comida, 18% transporte") |
| Transacciones individuales (comercio + monto + fecha) | Tendencias vs. mes previo ("suscripciones +20%") |
| Nombres de contrapartes ("pago a Juan Pérez") | Flags de comportamiento ("3 suscripciones sin uso en 60 días") |
| Saldo exacto | Montos **normalizados al ingreso** o en **rangos gruesos** |
| Detalle de categorías sensibles (salud, legal, religión, política) | Esas categorías **agrupadas o excluidas** |
| Cualquier ID que enlace una revisión con otra | Un **pseudónimo rotativo** por revisión |

**Pipeline de anonimización (validado, como hace FinancialOS):**

1. **Computar** el resumen desde el ledger (Dynamic) + categorización.
2. **Anonimizar:** quitar PII → agrupar montos en buckets → mapear comercios a categorías → coarsen categorías sensibles.
3. **Leak-check:** antes de que salga nada, escaneo (regex + LLM) que busca nombres/números/IDs. Si detecta algo, **bloquea el envío**.
4. **Consentimiento con preview:** ves *exactamente* lo que verá el revisor y puedes tachar antes de aprobar.
5. **Enviar** a los revisores de Terac.

---

## 7. Cómo mejora el agente (loop de aprendizaje)

1. El agente **redacta** un borrador de consejo.
2. Lo **escala a revisores** de Terac.
3. Ellos **aprueban / editan / califican** el borrador.
4. **Dawid–Skene** agrega los juicios (y aprende qué revisores son confiables).
5. El consejo corregido **te llega a ti** *y* se guarda como **ejemplo de entrenamiento**.

**Métrica estrella para el jurado:** *% de borradores del agente aprobados sin edición, antes vs. después.*

---

## 8. Testnet (decidido)

**Base Sepolia (testnet).** Los pagos se mueven **de verdad** sobre la cadena → trazabilidad on-chain real y verificable en el block explorer, pero con **dinero de juguete → cero riesgo**.

- **USDC de prueba:** faucet de Circle.
- **Gas (ETH de prueba):** faucet de Base Sepolia.
- **Swaps:** Base Sepolia casi no tiene liquidez, así que la ejecución de swaps se **simula con precio de mercado real**; los **pagos sí son transacciones reales** on-chain.

> Honesto en el video: "pagos on-chain reales; swaps con precio de mercado real, ejecución simulada por liquidez de testnet."

---

## 9. Stack y activos reutilizables

**Stack previsto:** TypeScript/Node. Servidor Fastify (webhooks de Linq) + cliente Linq (ya escrito) + cliente Terac (pendiente) + cliente Dynamic (pendiente) + agregador Dawid–Skene (ya escrito, con tests) + stage de anonimización (pendiente).

**Activo clave reutilizable — `FinancialOS Alpha`:**
`C:\Users\mateo\OneDrive\Desktop\fintech\financial-os-alpha` (~45k LOC). Proyecto maduro que ya reconstruye finanzas colombianas desde Gmail y **ya tiene la disciplina de privacidad/redacción** (cifrado Fernet, telemetría redactada, cero datos crudos en logs) que necesita el paso de anonimización. Es el "motor de datos financieros" sobre el que este agente podría apoyarse. *(Nota: sus docs están desactualizados; el código está más avanzado de lo que dicen.)*

---

## 10. Estado de las conexiones

| Servicio | Estado |
|---|---|
| **Linq** | Cliente REST **solo-envío** ⚠️ (`src/clients/linq.ts`) · credenciales en `.env` ✅ · sin probar en vivo · **faltan todas las capas de compliance/deliverability** (opt-out, health/reputation gating, contact card, cadencia) — ver §13 |
| **Terac** | MCP agregado ✅ · **falta OAuth** (`/mcp`) 🔑 · cliente REST pendiente |
| **Dynamic** | Docs MCP conectado ✅ (carga tras reiniciar sesión) · credenciales en `.env` ✅ (`DYNAMIC_API_TOKEN`, `DYNAMIC_ENVIRONMENT_ID`, `Organization_ID`) · cliente pendiente |
| **Dawid–Skene** | Implementado ✅ con tests |

---

## 11. Pendientes antes de construir

- [ ] Reiniciar la sesión para cargar el **MCP de docs de Dynamic** (para escribir el cliente con endpoints reales).
- [ ] Autenticar el **Terac MCP** con `/mcp` en sesión interactiva.
- [ ] Habilitar **Base Sepolia** en el dashboard de Dynamic + fondear con faucets.
- [x] **Modelo de pago de Terac — confirmado:** Terac maneja sourcing, screening, verificación y **payouts a sus revisores de forma nativa**. Nosotros **NO** pagamos a los revisores. Distinción clave: los pagos USDC vía Dynamic (§8) son los del **usuario** (su dinero, sus transacciones) — flujo totalmente aparte de la compensación a revisores.
- [ ] 🔴 **Compliance de opt-out (Linq) — BLOQUEANTE antes de cualquier envío real:** implementar handler `message.received` con match exacto case-sensitive de STOP/UNSUBSCRIBE/OPTOUT/CANCEL/END/QUIT + intención, y suppression persistente (Linq **no** suprime por ti). Detalle completo en §13.

## 12. Orden de construcción propuesto (cuando demos luz verde)

1. **Stage de anonimización** + tests (la pieza más delicada; no necesita API en vivo).
2. **Scaffolding:** `config.ts` con vars de Dynamic + `.env.example`.
3. **Cliente Dynamic** (agent wallet + pagos USDC en Base Sepolia) — tras cargar docs MCP.
4. **Cliente Terac** (reclutar revisores + recibir juicios).
5. **Agente:** parser de intención (schema Zod + tests, **detalle en §5.3**) + router de riesgo → punto de escalado a consenso.
6. **Servidor Fastify:** webhooks de Linq ↔ agente. **Incluye la capa de compliance de Linq de §13/§14** (verificación HMAC, opt-out en `message.received`, health/reputation gating pre-envío vía `canSend()`, `phone_number.status_updated`) **y la transcripción de voz** (§5.2/§14.2: descargar media del CDN → Whisper → pipeline de texto) — no es opcional si vamos a mandar iMessage a humanos reales.
7. **Dashboards visuales:** generador de página web de distribución de gastos + link protegido enviado por iMessage.
8. **Loop de mejora:** guardar juicios humanos como señal de entrenamiento.

---

## 13. Linq — auditoría de best practices & compliance

> Auditoría **read-only** contra los docs oficiales de Linq (2026-07-24). El cliente actual `src/clients/linq.ts` es **solo-envío**; **no existe** handler de webhooks, onboarding, ni capa de salud/reputación (confirmado: `find src` + grep de `message.received|opt-out|health_status|available_number|contact_card|phone_numbers|reputation` → cero coincidencias). Casi todo sale "gap" porque esas capas **nunca se construyeron**, no porque una integración terminada falle. Esto define qué hay que construir en el paso 6 de §12.

**Docs de referencia (fetch verificado):** Best Practices · Chat Health · Phone Reputation · Sending Messages · Webhooks (events + subscriptions) · refs `/v3` de `messages`, `available_number`, `contact_card`, `phone_numbers`, `chats/{id}/share_contact_card`.

### 13.1 Checklist de gaps a cubrir

| Check (best practice de Linq) | Estado hoy | Dónde | Fix a implementar |
|---|---|---|---|
| Escanear `message.received` por keywords de opt-out (STOP, UNSUBSCRIBE, OPTOUT, CANCEL, END, QUIT — **exacto, case-sensitive**) + intención → frenar outbound | ❌ gap | no hay handler; `src/domain/vote.ts` parsea replies pero nada consume webhooks | handler webhook: leer `data.parts[].value`, match keywords + intención, persistir opt-out, bloquear sends |
| Tratar chat `health_status: OPTED_OUT` como terminal hasta `OPTIN` | ❌ gap | `health_status` nunca se lee | gate pre-envío; `OPTED_OUT` = nunca enviar; limpiar solo con `OPTIN` |
| Enviar con `POST /v3/messages` usando `to` y **SIN** `from` (Linq elige línea, balancea, failover) | ❌ divergente | `src/clients/linq.ts:22` fija `from`; `:45-49` usa `POST /chats` con `from` | migrar primer envío a `POST /v3/messages` solo con `to`; leer `from_selection.reason` |
| NO llamar `available_number` por-mensaje / NO fijar `from` | ⚠️ parcial | no llama `available_number` por-mensaje ✅ pero **fija `from`** ❌ (`linq.ts:22,46`) | quitar `from` |
| `GET /v3/available_number` al onboardear usuario NUEVO (mejor línea + `vcf_url`) | ❌ gap | sin uso | llamar en signup; casi n/a en Shared Line (1 número), pero `vcf_url` aplica |
| Crear contact card (`POST /v3/contact_card`, cambios con `PATCH`) | ❌ gap | sin código | crear en setup inicial |
| Compartir card vía `POST /v3/chats/{id}/share_contact_card`, inbound-first, solo tras ≥1 outbound, re-share ~1×/día | ❌ gap | sin lógica | compartir solo tras outbound previo |
| Chequear `health_status` + `reputation` (`GET /v3/phone_numbers`) antes de enviar; frenar/pausar en AT_RISK/CRITICAL | ❌ gap | sin llamada ni gating | `HEALTHY`→enviar, `AT_RISK`→bajar ritmo, `CRITICAL`→pausar |
| Manejar webhook `phone_number.status_updated` | ❌ gap | no hay handler | suscribir + reaccionar a `new_reputation` |
| Onboardear en líneas HEALTHY; NO migrar fuera de AT_RISK | ✅ n/a | no existe lógica de migración | respetar si se añade multi-línea |
| Outbound para replies (3+ temprano, ratio ~1:2 in:out); frenar/parar a no-respondedores | ❌ gap | cliente fire-and-forget | tracking de replies + backoff |
| <~7,000 msgs/día/línea; repartir en líneas/tiempo | ❌ gap | sin contador/rate-limit | contador diario por línea (riesgo bajo hoy por cap de 20 contactos del free tier) |
| Base URL `/api/partner/v3` correcta | ✅ pass | `src/config.ts:27` | — |

### 13.2 Prioridad (mayor riesgo compliance/deliverability primero)

1. **🔴 Opt-out** — hoy **no se procesa ningún inbound**, un "STOP" se ignora → riesgo legal. Bloqueante antes de enviar de verdad.
2. **🔴 Gate `OPTED_OUT`/`CRITICAL`** — nunca enviar a chats opted-out o críticos.
3. **🟠 `POST /v3/messages` sin `from`** — failover + resolución correcta de chat.
4. **🟠 Reputación + `phone_number.status_updated`** — frenar/pausar según estado.
5. **🟡 Contact card + inbound-first.**
6. **🟡 Cadencia (1:2, 3+ replies, backoff) + volumen (<7k/día/línea).**

### 13.3 Nota de scope

En el concepto vivo (§1), **Linq es la interfaz central** — hablas con el asesor por iMessage. Por lo tanto estas capas de compliance/deliverability **están en scope, no son stretch**: sí vamos a enviar iMessage a un humano real (tú, en el demo), así que el gate de opt-out + salud es obligatorio antes del primer envío en vivo. El diseño end-to-end que las implementa está en §14.

---

## 14. Linq end-to-end — capacidades, límites y diseño

> Verificado contra docs oficiales (2026-07-24). Define **hasta dónde podemos usar Linq** y cómo lo implementamos respetando §13.

### 14.1 Hasta dónde llega Linq (lo que SÍ y lo que NO)

**SÍ podemos:**

| Capacidad | Detalle / límite |
|---|---|
| **Texto** | parte `text`, hasta 10,000 chars por parte |
| **Media** (imagen, video, audio, docs) | imágenes JPEG/PNG/GIF/HEIC…, video MP4/MOV, docs PDF/CSV/Office/ZIP, VCF/ICS. **URL ≤10MB, pre-upload ≤100MB** |
| **Audio nativo (nota de voz)** | `POST /v3/chats/{chatId}/voicememo` → burbuja de voz con playback inline. Formatos M4A/AAC/MP3/WAV/AIFF/CAF/AMR |
| **Recibir media/audio del usuario** | llega en `message.received` como parte `media` con `url` (cdn.linqapp.com) |
| **Link con preview** | parte `link` → nuestra página tokenizada (dashboards §5.1, confirmaciones) |
| **Tapbacks / reactions** | 👍👎❤️… como canal de confirmación/voto ligero |
| **Typing indicator** | estado "pensando / consultando humanos" |
| **Effects** | confetti, fireworks, slam, gentle, invisible_ink (iMessage) |
| **Grupos** | hasta **31** handles (iMessage/RCS) |
| **Webhooks** | `message.received/sent/delivered/read/failed`, `reaction.added/removed`, `phone_number.status_updated`. Firmados con HMAC `X-Linq-Signature` |

**NO podemos (límites duros):**

| Límite | Consecuencia para el plan |
|---|---|
| 🚫 **`imessage_app` (card interactiva mutante) exige una extensión de iMessage NATIVA registrada en Apple + instalada por el destinatario.** No hay card genérica ni HTML en burbuja; por API solo mandas un **preview estático** (captions + imagen). iMessage-only (falla `4005` en no-iMessage; `2018` si pides SMS/RCS con app part) | **Descartada para el hackathon.** El "primitivo estrella" se reemplaza por link tokenizado + tapbacks (§14.3) |
| Sin transcripción de audio | La hacemos nosotros (Whisper / gpt-4o-transcribe) |
| **Rate:** 30 msgs / 60s por par; **≤7,000/día/línea** | Guard de volumen/burst en outbound (§14.4) |
| **Free Shared Line:** inbound-first, **máx 20 contactos**, 1 número | OK para demo (tú eres el usuario). Load-balancing multi-línea = n/a hoy |
| Opt-out NO lo suprime Linq | Responsabilidad nuestra, bloqueante (§13) |

### 14.2 Audios — respuesta directa a "¿puedo enviarle audios?"

**Sí, en las dos direcciones:**

- **Tú → agente (nota de voz):** ✅ mandas un audio por iMessage → llega en `message.received` como parte `media` con `url`. **Linq no transcribe**, así que bajamos el archivo del CDN y lo transcribimos server-side (Whisper). Habilita un modo **voice-first**: le hablas a tu asesor en vez de escribir — natural para finanzas ("oye, ¿puedo gastar 200 en esto?").
- **Agente → tú (voz nativa):** ✅ vía `POST /v3/chats/{chatId}/voicememo` (TTS → m4a → burbuja de voz con playback).

**Decisión propuesta:** **audio entrante = IN** (alto valor, costo bajo: 1 transcripción). **Respuesta en voz = stretch** (después de que el texto funcione).

### 14.3 La "card" sin `imessage_app` (el pivote)

Como la card nativa está descartada, "messaging primitives as UI" se logra con lo que sí existe:

- **Link tokenizado** → página servida por Fastify (confirmar/rechazar pago, aprobar consejo, dashboards §5.1). Es rica, mutable y segura — reemplaza a la card mutante.
- **Tapbacks** = confirmación binaria (👍 confirmar pago / 👎 cancelar) sobre el `message_id` de la acción pendiente.
- **Typing indicator** = loading mientras el agente razona o consulta humanos.
- **Effect confetti** al confirmarse un pago.

### 14.4 Ciclo de vida end-to-end (best practices incrustadas)

**INBOUND** (`POST /webhooks/linq`):
1. **Verificar HMAC `X-Linq-Signature`** (timestamp reciente = anti-replay). Si no valida → 401.
2. Enrutar por tipo de evento.
3. `message.received`:
   a. **Opt-out scan** (keywords exactas case-sensitive + intención). Match → marcar recipiente *suppressed*, parar todo outbound, mandar 1 confirmación. **Terminal.**
   b. `OPTIN` → limpiar suppression.
   c. Si parte `media`/audio → descargar del CDN → **transcribir** → texto.
   d. Registrar inbound (para ratio in:out).
   e. Pasar texto al **agente** (parser de intención, §5).
4. `reaction.*`: interpretar tapback como confirmar/cancelar la acción pendiente en ese `message_id`.
5. `phone_number.status_updated`: actualizar reputación de la línea → ajustar el gate.

**OUTBOUND** — todo envío pasa por un guard central `canSend()`:
1. ¿recipiente *suppressed* (opt-out)? → **no enviar**.
2. ¿chat `health_status` `OPTED_OUT`/`CRITICAL`? → no enviar (OPTED_OUT terminal; CRITICAL pausar).
3. ¿línea `reputation` `AT_RISK`? → bajar ritmo.
4. ¿volumen día <7k y burst <30/60s por par? → si no, diferir/encolar.
5. Enviar con **`POST /v3/messages` con `to`, SIN `from`** → guardar `from_selection.reason` + `message_id`.
6. Contabilizar outbound (ratio + volumen).

**Onboarding (usuario nuevo):** `GET /v3/available_number` → mostrar número + `vcf_url` en el signup; **inbound-first** (esperar a que escriba primero); crear contact card 1× (`POST /v3/contact_card`) y compartir vía `share_contact_card` **solo tras ≥1 outbound**, re-share ~1×/día.

**Cadencia:** objetivo 3+ replies temprano, ratio ~1:2 in:out; backoff y stop si no responde.

### 14.5 Superficie mínima a construir (detalla el paso 6 de §12)

- `verifyLinqSignature()` (HMAC) + `POST /webhooks/linq` router.
- `optout.ts` — scan + store de suppression (🔴 primero).
- `sendGuard.ts` — `canSend()` (opt-out + health + reputation + volumen/burst).
- Refactor `linq.ts` → primer envío por `POST /v3/messages` sin `from`; leer `from_selection.reason`.
- `voice.ts` — descargar media + transcribir (para audio IN).
- `phoneNumbers.ts` — GET reputation + cache + handler `status_updated`.
- `contactCard.ts` — crear + share con regla inbound-first.
- Contadores de volumen/cadencia.

---

## 15. Entregables del hackathon

- Repo público en GitHub.
- Video demo de 2 min en YouTube.
- Link de despliegue en vivo.
- Todo construido durante el hackathon.