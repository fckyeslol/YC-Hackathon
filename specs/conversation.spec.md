# Spec — Capa conversacional (charla + Q&A factual de datos propios)

> Estado: 🟢 **Implementado y verificado** (aprobado 2026-07-24) · ADR: (por crear, ADR-007) · Rúbrica QA: [`qa/rubrics/conversation.md`](../qa/rubrics/conversation.md)
>
> Deriva de [`PLAN.md §5`](../PLAN.md) (alcance del agente) y respeta el límite fijado por el humano
> el 2026-07-24: **"solo charla + datos"** — el agente conversa y responde datos factuales de tus
> costos, pero **todo consejo sigue escalando a humanos** (guardrail intacto, [`guardrail-escalation.spec.md`](guardrail-escalation.spec.md)).

## 1. Problema

Hoy [`orchestrator.ts`](../src/agent/orchestrator.ts) trata `smalltalk` y `unknown` con la **misma**
respuesta genérica ("No te entendí del todo…"), y las consultas de datos (`balance`/`spending_insight`/
`dashboard`) devuelven texto estructurado vía `ledger.answerQuery()`. El usuario quiere que el agente
(a) **converse** de forma natural y (b) responda **preguntas sobre sus costos** en lenguaje natural.

## 2. Alcance

**IN:**
- Respuesta conversacional real para `smalltalk` (saludo, charla, "¿qué podés hacer?").
- Respuestas en **lenguaje natural** a preguntas **factuales** sobre los datos del usuario
  (cuánto gastó, en qué categorías, tendencias, saldo), fundamentadas en su resumen financiero.

**OUT (sin cambios respecto a hoy):**
- **Consejo** (`advice`): sigue yendo al guardrail → **escala a consenso humano** (BR-G3). El agente
  **no aconseja solo**.
- **Acciones de dinero** (`pay`/`split`/`swap`): sin cambios (confirmación explícita + wallet, BR-P5).
- `unknown`: sigue con el mensaje "no te entendí".

## 3. Distinción de privacidad (crítica)

Estas respuestas van **del agente al propio usuario** sobre **su propia data** → pueden mostrar
**detalle completo** (igual que el dashboard personal, [`PLAN.md §5.1`](../PLAN.md)). Es un flujo
**distinto** del resumen anonimizado que va a revisores de Terac ([`anonymization.spec.md`](anonymization.spec.md)):
la capa conversacional **nunca** usa el path de anonimización ni envía nada a un tercero.

## 4. Contrato

Se agrega una capacidad de conversación al "brain" (Claude vía Runware, [ADR-006](../entregables/ADR-006-adapters-llm-stt.md)),
inyectada como puerto — testeable con fakes, fail-closed sin key:

```ts
/** Read-only conversational port. NUNCA emite acciones de dinero ni consejo. */
export interface ConversationPort {
  /** Charla natural (smalltalk): saludo, capacidades. Sin consejo financiero. */
  chat(userText: string): Promise<string>;
  /** Respuesta en lenguaje natural a una pregunta factual, fundada en el resumen propio. */
  answerFromData(userText: string, summary: Summary): Promise<string>;
}
```

- `smalltalk` → `chat()`.
- `balance`/`spending_insight`/`dashboard` → `answerFromData()` usando `ledger.buildSummary()`
  (data propia, detalle completo). Reemplaza/embellece a `answerQuery()` sin cambiar que es read-only.
- El composition root inyecta el adapter real cuando existe `RUNWARE_API_KEY`; sin key → stub fail-closed.

## 5. Reglas de negocio

- **BR-CV1** — `smalltalk` produce una respuesta conversacional generada por LLM: cálida, español (CO),
  breve (≤ ~320 chars). Puede saludar y **explicar qué sabe hacer** (mover plata, mostrar gastos,
  dar consejo con humanos). **Nunca** da consejo financiero ni promete mover dinero.
- **BR-CV2** — Preguntas factuales de datos se responden en lenguaje natural **fundadas únicamente en el
  `Summary` del propio usuario**. Prohibido inventar cifras que no estén en el resumen (anti-alucinación).
- **BR-CV3** — La capa conversacional es **read-only**: no emite `Action` de dinero, no confirma pagos,
  no dispara escalación. Si el texto es realmente consejo o dinero, **no lo maneja acá** — el parser lo
  clasifica como `advice`/`pay`/… y sigue su ruta normal (guardrail / confirmación). BR-G3 intacto.
- **BR-CV4** — **Fail-closed suave:** sin LLM disponible, `smalltalk` cae a una bienvenida canned amable
  (NO "no te entendí"); las consultas de datos caen al `answerQuery()` estructurado actual. Nunca rompe.
- **BR-CV5** — `unknown` conserva "No te entendí del todo… ¿me lo explicás de otra forma?" (distinto de
  `smalltalk`).
- **BR-CV6** — Sin PII de terceros: solo se refleja la data del propio usuario hacia el propio usuario;
  nada cruza a un humano externo por esta capa (eso es exclusivo del flujo Terac con `ConsentToken`).
- **BR-CV7** — Toda respuesta saliente sigue pasando por `guardedSend`/`canSend()` como hoy
  ([`linq-messaging.spec.md`](linq-messaging.spec.md)); esta capa solo cambia el **texto**, no el gate.

## 6. Criterios de aceptación (Given/When/Then)

- **AC1** — *Given* el brain configurado, *When* el usuario manda "hola", *Then* `smalltalk` →
  `chat()` devuelve un saludo natural que menciona al menos una capacidad, y **no** contiene consejo
  ni el string "no te entendí".
- **AC2** — *Given* un `Summary` con `comida=42%`, *When* el usuario pregunta "¿en qué se me va la plata?",
  *Then* la respuesta en lenguaje natural menciona "comida" con su proporción, tomada del summary.
- **AC3** — *Given* un `Summary` sin dato de "salud", *When* el usuario pregunta por ese dato, *Then* la
  respuesta dice que no lo tiene (no inventa un número) — BR-CV2.
- **AC4** — *Given* el usuario escribe "¿debería cancelar Netflix?", *When* se procesa, *Then* se clasifica
  `advice` y **escala a humanos** (no lo responde la capa conversacional) — BR-CV3 / BR-G3.
- **AC5** — *Given* `RUNWARE_API_KEY` ausente, *When* llega "hola", *Then* responde la bienvenida canned
  amable (no "no te entendí"), sin lanzar excepción — BR-CV4.
- **AC6** — *Given* el usuario pide un pago ("mándale 10 a Ana"), *When* se procesa, *Then* sigue el flujo
  de confirmación de dinero intacto; la capa conversacional no interviene — BR-CV3 / BR-P5.

## 7. Supuestos y ⚠️ a verificar

- ⚠️ **Fuente de datos:** hoy el `Summary` categorizado sale del `SEED_PROFILE` de demo
  ([`dynamicPorts.ts`](../src/clients/dynamicPorts.ts)); solo el `exactBalance` es real on-chain. Las
  respuestas conversacionales de costos serán fieles al summary, pero ese summary es semilla hasta que
  exista una fuente real de transacciones categorizadas.
- El límite del LLM conversacional (no dar consejo) se refuerza por **prompt** + por **enrutamiento**
  (advice nunca llega a `chat()`); no es una garantía dura como el guardrail de dinero.
