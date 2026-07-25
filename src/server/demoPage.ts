import { randomUUID, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AgentOutcome } from "../agent/orchestrator.js";
import type { Action } from "../agent/types.js";
import type { AnonymizedSummary } from "../anonymization/types.js";
import { dawidSkene } from "../core/aggregation/dawidSkene.js";
import type { Vote } from "../core/types.js";

/**
 * Public "try it" playground (deliverable §15 — the live demo link).
 *
 * The real product lives in iMessage via Linq (phone + opt-in + a 20-contact free
 * line), which can't be a public link. So this serves an iMessage-style web chat
 * that feeds the SAME agent pipeline (`handleAgentMessage`), letting anyone try
 * parse → guardrail → confirm/escalate/dashboard with no phone and no opt-in.
 *
 * Safety for a public link (per product decision):
 *   - Payments are SIMULATED — no funds move, no shared wallet is touched.
 *   - Human review shows the REAL anonymized preview, then a SIMULATED consensus
 *     run through the real Dawid–Skene aggregator (real core, synthetic reviewer
 *     inputs). No live Terac reviewers are recruited on every stranger's click.
 */

/** One rendered chat bubble. `kind` drives styling on the client. */
export interface DemoBubble {
  readonly kind: "agent" | "system";
  readonly text: string;
}

export interface DemoReply {
  readonly bubbles: readonly DemoBubble[];
  /** iMessage-style effect to play (currently only "confetti"). */
  readonly effect?: "confetti";
}

export interface DemoDeps {
  /** The agent loop core — same one the Linq webhook uses. */
  handle: (text: string, fromVoice: boolean) => Promise<AgentOutcome>;
  /** Intent parse (for pending confirm/cancel + dashboard routing). */
  parse: (text: string) => Promise<Action>;
  /** Dashboard link text for a `dashboard` action (mints a real tokenized link). */
  dashboardAnswer: (action: Action) => Promise<string>;
}

interface Session {
  pendingAction?: Action | undefined;
  pendingConsent?: { anon: AnonymizedSummary; action: Action } | undefined;
  lastSeen: number;
}

const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 1000;
const MONEY_INTENTS = new Set(["pay", "split", "swap"]);

const YES = /^(s[ií]|yes|y|ok(ay)?|dale|claro|hazlo|do it|confirm|confirmar|👍|👌|✅)\b/i;
const NO = /^(no|nope|cancel|cancelar|stop|nah|👎|❌)\b/i;

/** In-memory per-browser state. Fine for a demo; evicted by TTL + hard cap. */
const sessions = new Map<string, Session>();

function getSession(id: string, now: number): Session {
  for (const [key, s] of sessions) {
    if (now - s.lastSeen > SESSION_TTL_MS) sessions.delete(key);
  }
  let s = sessions.get(id);
  if (!s) {
    if (sessions.size >= MAX_SESSIONS) {
      // Drop the oldest to stay bounded under a click storm.
      const oldest = [...sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
      if (oldest) sessions.delete(oldest[0]);
    }
    s = { lastSeen: now };
    sessions.set(id, s);
  }
  s.lastSeen = now;
  return s;
}

/** A believable Base Sepolia tx hash for the simulated payment (never broadcast). */
function fakeTxHash(): string {
  return `0x${randomBytes(32).toString("hex")}`;
}

/**
 * Simulated human consensus through the REAL Dawid–Skene estimator: three
 * reviewers, two labels (0 = approve the draft, 1 = revise). Two approve, one
 * dissents — the estimator learns reliability instead of counting naive votes.
 */
function simulateConsensus(): { approved: boolean; confidencePct: number } {
  const votes: Vote[] = [
    { taskId: "t", raterId: "r1", label: 0 },
    { taskId: "t", raterId: "r2", label: 0 },
    { taskId: "t", raterId: "r3", label: 1 },
  ];
  const result = dawidSkene(votes, { numLabels: 2 });
  const verdict = result.verdicts[0];
  const approved = (verdict?.label ?? 0) === 0;
  const confidencePct = Math.round((verdict?.confidence ?? 0.5) * 100);
  return { approved, confidencePct };
}

function moneyLabel(action: Action): string {
  const amount = action.params.amount ?? action.params.total;
  const recipient = action.params.recipient;
  if (action.intent === "swap") {
    return `swap ${String(amount ?? "")} ${String(action.params.fromAsset ?? "")} → ${String(action.params.toAsset ?? "")}`;
  }
  return `send ${amount ?? ""}${recipient ? ` to ${String(recipient)}` : ""}`;
}

/** Consent resolved on a staged escalation → run consensus, then act on it. */
function resolveConsent(staged: { anon: AnonymizedSummary; action: Action }): DemoReply {
  const { approved, confidencePct } = simulateConsensus();
  const bubbles: DemoBubble[] = [
    { kind: "system", text: "Shared with 3 anonymous reviewers…" },
    {
      kind: "agent",
      text: `Consensus is in. Dawid–Skene aggregation (it learns which reviewers are reliable, not a naive majority) → ${
        approved ? "APPROVE" : "REVISE"
      } at ${confidencePct}% confidence.`,
    },
  ];
  const { action } = staged;
  if (MONEY_INTENTS.has(action.intent)) {
    if (approved) {
      bubbles.push({
        kind: "agent",
        text: `The humans are comfortable, so I'll ${moneyLabel(action)} ✅\ntx: ${fakeTxHash()}\n(simulated on Base Sepolia — this sandbox moves no real money)`,
      });
      return { bubbles, effect: "confetti" };
    }
    bubbles.push({
      kind: "agent",
      text: `They'd hold off on this one, so I didn't ${moneyLabel(action)}. Want to adjust the amount or recipient?`,
    });
    return { bubbles };
  }
  // advice escalation → the corrected human take comes back to the user.
  bubbles.push({
    kind: "agent",
    text: approved
      ? "Their read: it's a reasonable call. One nudge — you have 2 subscriptions unused in 60 days that are worth trimming first."
      : "Their read: hold off. The reviewers flagged this needs a closer look before you act.",
  });
  return { bubbles };
}

/** Core turn handler. Pure over its deps + session, so it's unit-testable. */
export async function handleDemoTurn(text: string, session: Session, deps: DemoDeps): Promise<DemoReply> {
  const trimmed = text.trim();
  if (!trimmed) return { bubbles: [{ kind: "agent", text: "Say something and I'll help 🙂" }] };

  // 1) A staged escalation is waiting for the user's yes/no (their consent).
  if (session.pendingConsent) {
    if (YES.test(trimmed)) {
      const staged = session.pendingConsent;
      session.pendingConsent = undefined;
      return resolveConsent(staged);
    }
    if (NO.test(trimmed)) {
      session.pendingConsent = undefined;
      return { bubbles: [{ kind: "agent", text: "Got it — I won't share anything. Nothing left the device." }] };
    }
    return { bubbles: [{ kind: "agent", text: "Just reply 👍 to share the anonymized summary, or 👎 to keep it private." }] };
  }

  // 2) A payment is staged awaiting confirmation (the auto-money path, BR-P5).
  if (session.pendingAction) {
    const probe = await deps.parse(trimmed);
    if (probe.intent === "confirm" || YES.test(trimmed)) {
      const action = session.pendingAction;
      session.pendingAction = undefined;
      return {
        bubbles: [
          {
            kind: "agent",
            text: `Done, ${moneyLabel(action)} ✅\ntx: ${fakeTxHash()}\n(simulated on Base Sepolia — this sandbox moves no real money)`,
          },
        ],
        effect: "confetti",
      };
    }
    if (probe.intent === "cancel" || NO.test(trimmed)) {
      session.pendingAction = undefined;
      return { bubbles: [{ kind: "agent", text: "Cancelled. Nothing moved." }] };
    }
    // Not a resolution → fall through and treat as a fresh message.
    session.pendingAction = undefined;
  }

  // 3) Fresh message. Probe the intent so we can route the dashboard link.
  const action = await deps.parse(trimmed);
  if (action.intent === "dashboard") {
    return { bubbles: [{ kind: "agent", text: await deps.dashboardAnswer(action) }] };
  }

  const outcome = await deps.handle(trimmed, false);
  switch (outcome.kind) {
    case "reply":
    case "answer":
    case "reprompt":
    case "blocked":
      return { bubbles: [{ kind: "agent", text: outcome.text }] };
    case "confirm_required":
      session.pendingAction = outcome.action;
      return { bubbles: [{ kind: "agent", text: outcome.text }] };
    case "escalated":
      session.pendingConsent = { anon: outcome.anon, action };
      return {
        bubbles: [
          { kind: "system", text: "This one's above my pay grade — escalating to human reviewers 🧑‍⚖️" },
          { kind: "agent", text: outcome.previewText },
          { kind: "system", text: "🔒 That's the whole picture a reviewer gets — no name, no raw transactions, nothing that points back to you." },
        ],
      };
  }
}

export function registerDemoRoutes(app: FastifyInstance, deps: DemoDeps): void {
  app.get("/demo", async (_req, reply) => {
    reply.type("text/html").send(DEMO_HTML);
  });

  app.post<{ Body: { sessionId?: string; text?: string } }>("/demo/message", async (request, reply) => {
    const body = request.body ?? {};
    const sessionId = typeof body.sessionId === "string" && body.sessionId.length > 0 ? body.sessionId : randomUUID();
    const text = typeof body.text === "string" ? body.text : "";
    if (text.length > 500) return reply.code(400).send({ error: "message too long" });

    const session = getSession(sessionId, Date.now());
    try {
      const result = await handleDemoTurn(text, session, deps);
      return reply.code(200).send({ sessionId, ...result });
    } catch (err) {
      console.error("[demo] turn failed:", err instanceof Error ? err.message : err);
      return reply.code(200).send({
        sessionId,
        bubbles: [{ kind: "agent", text: "Something glitched on my end 🙈 mind trying that again?" }],
      });
    }
  });
}

// --- The page (self-contained: no external CSS/JS/fonts, iMessage look) --------

const DEMO_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Verdict — try it</title>
<style>
  :root {
    --bg: #0b0b0f; --panel: #101014; --header: rgba(20,20,26,.82);
    --in-bubble: #26262c; --in-text: #f2f2f7; --out-bubble: #0a84ff; --out-text: #fff;
    --sys-text: #8e8e93; --muted: #9a9aa2; --field: #1c1c22; --field-border: #2c2c34;
    --chip-bg: #17171d; --chip-border: #2a2a33; --accent: #0a84ff;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #d9dbe1; --panel: #fff; --header: rgba(248,248,250,.86);
      --in-bubble: #e9e9eb; --in-text: #000; --out-bubble: #0a84ff; --out-text: #fff;
      --sys-text: #8a8a8e; --muted: #6a6a70; --field: #fff; --field-border: #d7d7dd;
      --chip-bg: #fff; --chip-border: #d7d7dd; --accent: #0a84ff;
    }
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--bg);
    font: 16px/1.4 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
    color: var(--in-text);
    display: flex; align-items: center; justify-content: center; padding: 16px;
  }
  .phone {
    width: 100%; max-width: 420px; height: min(860px, 94vh);
    background: var(--panel); border-radius: 30px; overflow: hidden;
    display: flex; flex-direction: column;
    box-shadow: 0 30px 80px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.04);
  }
  .header {
    position: relative; z-index: 2; backdrop-filter: saturate(1.6) blur(18px);
    background: var(--header); padding: 14px 16px 12px;
    border-bottom: 1px solid rgba(128,128,128,.16);
    display: flex; flex-direction: column; align-items: center; gap: 6px; text-align: center;
  }
  .avatar {
    width: 46px; height: 46px; border-radius: 50%;
    background: linear-gradient(160deg, #0a84ff, #5e5ce6);
    display: grid; place-items: center; color: #fff; font-weight: 700; font-size: 20px;
    box-shadow: 0 4px 14px rgba(10,132,255,.35);
  }
  .name { font-weight: 600; font-size: 15px; }
  .sub { font-size: 11.5px; color: var(--muted); }
  .banner {
    font-size: 11px; color: var(--muted); background: rgba(10,132,255,.08);
    border-bottom: 1px solid rgba(128,128,128,.14); padding: 7px 14px; text-align: center;
  }
  .banner b { color: var(--in-text); font-weight: 600; }
  .thread { flex: 1; overflow-y: auto; padding: 16px 12px 8px; display: flex; flex-direction: column; gap: 3px; }
  .row { display: flex; margin-top: 8px; }
  .row.out { justify-content: flex-end; }
  .row.in { justify-content: flex-start; }
  .bubble {
    max-width: 78%; padding: 9px 13px; border-radius: 19px; font-size: 15px;
    white-space: pre-wrap; word-wrap: break-word; position: relative;
    animation: pop .18s ease-out;
  }
  @keyframes pop { from { transform: scale(.94); opacity: 0; } to { transform: scale(1); opacity: 1; } }
  .in .bubble { background: var(--in-bubble); color: var(--in-text); border-bottom-left-radius: 6px; }
  .out .bubble { background: var(--out-bubble); color: var(--out-text); border-bottom-right-radius: 6px; }
  .bubble a { color: inherit; text-decoration: underline; font-weight: 600; }
  .out .bubble a { color: #fff; }
  .sys { text-align: center; color: var(--sys-text); font-size: 12px; margin: 10px auto 2px; max-width: 88%; }
  .typing { display: inline-flex; gap: 4px; padding: 12px 14px; }
  .typing span {
    width: 8px; height: 8px; border-radius: 50%; background: var(--muted); opacity: .5;
    animation: blink 1.2s infinite both;
  }
  .typing span:nth-child(2) { animation-delay: .2s; }
  .typing span:nth-child(3) { animation-delay: .4s; }
  @keyframes blink { 0%, 60%, 100% { opacity: .3; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-3px); } }
  .chips { display: flex; gap: 8px; overflow-x: auto; padding: 8px 12px; scrollbar-width: none; }
  .chips::-webkit-scrollbar { display: none; }
  .chip {
    flex: 0 0 auto; font-size: 13px; color: var(--accent); background: var(--chip-bg);
    border: 1px solid var(--chip-border); border-radius: 16px; padding: 7px 12px; cursor: pointer;
    white-space: nowrap; transition: transform .1s ease, background .1s ease;
  }
  .chip:active { transform: scale(.95); }
  .composer {
    display: flex; align-items: center; gap: 8px; padding: 10px 12px calc(10px + env(safe-area-inset-bottom));
    border-top: 1px solid rgba(128,128,128,.16);
  }
  .composer input {
    flex: 1; border: 1px solid var(--field-border); background: var(--field); color: var(--in-text);
    border-radius: 20px; padding: 10px 14px; font-size: 15px; outline: none;
  }
  .send {
    width: 34px; height: 34px; border: none; border-radius: 50%; background: var(--accent);
    color: #fff; font-size: 17px; cursor: pointer; display: grid; place-items: center; flex: 0 0 auto;
  }
  .send:disabled { opacity: .4; cursor: default; }
  .confetti { position: fixed; inset: 0; pointer-events: none; overflow: hidden; z-index: 9; }
  .confetti i {
    position: absolute; top: -12px; width: 9px; height: 9px; opacity: .9;
    animation: fall linear forwards;
  }
  @keyframes fall { to { transform: translateY(105vh) rotate(720deg); opacity: 0; } }
</style>
</head>
<body>
  <div class="phone">
    <div class="header">
      <div class="avatar">V</div>
      <div class="name">Verdict</div>
      <div class="sub">Financial advisor · reviewed by real humans</div>
    </div>
    <div class="banner"><b>Sandbox.</b> Real agent, real anonymization + Dawid–Skene. Payments simulated on Base Sepolia — no real money, no phone needed.</div>
    <div class="thread" id="thread"></div>
    <div class="chips" id="chips"></div>
    <form class="composer" id="composer" autocomplete="off">
      <input id="input" placeholder="Message Verdict…" maxlength="500" />
      <button class="send" id="send" type="submit" aria-label="Send">↑</button>
    </form>
  </div>
<script>
  const sessionId = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random();
  const thread = document.getElementById("thread");
  const input = document.getElementById("input");
  const form = document.getElementById("composer");
  const chipsEl = document.getElementById("chips");
  const CHIPS = [
    "Show my spending dashboard",
    "Should I cancel Netflix?",
    "Send $200 to Ana",
    "Swap 100 USDC to ETH",
    "Where did my money go this month?",
  ];
  const urlRe = /(https?:\\/\\/[^\\s]+)/g;

  function scroll() { thread.scrollTop = thread.scrollHeight; }

  function addBubble(kind, text) {
    if (kind === "system") {
      const s = document.createElement("div");
      s.className = "sys";
      s.textContent = text;
      thread.appendChild(s);
      scroll();
      return;
    }
    const row = document.createElement("div");
    row.className = "row " + (kind === "out" ? "out" : "in");
    const b = document.createElement("div");
    b.className = "bubble";
    // Linkify safely: split on URLs, build text/anchor nodes (no innerHTML).
    const parts = text.split(urlRe);
    parts.forEach((p) => {
      if (urlRe.test(p)) {
        const a = document.createElement("a");
        a.href = p; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = "Open link ↗";
        b.appendChild(a);
      } else if (p) {
        b.appendChild(document.createTextNode(p));
      }
      urlRe.lastIndex = 0;
    });
    row.appendChild(b);
    thread.appendChild(row);
    scroll();
  }

  function showTyping() {
    const row = document.createElement("div");
    row.className = "row in"; row.id = "typing-row";
    const b = document.createElement("div");
    b.className = "bubble typing";
    b.innerHTML = "<span></span><span></span><span></span>";
    row.appendChild(b);
    thread.appendChild(row);
    scroll();
  }
  function hideTyping() { const r = document.getElementById("typing-row"); if (r) r.remove(); }

  function confetti() {
    const wrap = document.createElement("div"); wrap.className = "confetti";
    const colors = ["#0a84ff", "#5e5ce6", "#ff375f", "#30d158", "#ffd60a"];
    for (let i = 0; i < 80; i++) {
      const c = document.createElement("i");
      c.style.left = Math.random() * 100 + "vw";
      c.style.background = colors[i % colors.length];
      c.style.animationDuration = (1.6 + Math.random() * 1.4) + "s";
      c.style.animationDelay = (Math.random() * 0.3) + "s";
      wrap.appendChild(c);
    }
    document.body.appendChild(wrap);
    setTimeout(() => wrap.remove(), 3200);
  }

  async function send(text) {
    addBubble("out", text);
    input.value = "";
    showTyping();
    let data;
    try {
      const res = await fetch("/demo/message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, text }),
      });
      data = await res.json();
    } catch (e) {
      data = { bubbles: [{ kind: "agent", text: "I couldn't reach the server 🙈 try again?" }] };
    }
    // Stagger the reply bubbles so it feels like a real conversation.
    const bubbles = (data && data.bubbles) || [];
    for (let i = 0; i < bubbles.length; i++) {
      await new Promise((r) => setTimeout(r, i === 0 ? 500 : 650));
      if (i === 0) hideTyping();
      addBubble(bubbles[i].kind === "system" ? "system" : "in", bubbles[i].text);
    }
    hideTyping();
    if (data && data.effect === "confetti") confetti();
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const t = input.value.trim();
    if (t) send(t);
  });
  CHIPS.forEach((c) => {
    const el = document.createElement("button");
    el.type = "button"; el.className = "chip"; el.textContent = c;
    el.addEventListener("click", () => send(c));
    chipsEl.appendChild(el);
  });

  // Opening greeting.
  setTimeout(() => addBubble("in", "Hey! 👋 I'm Verdict — your financial advisor that lives in iMessage. I can move your money, show where it's going, and get you advice checked by real humans. Try a suggestion below 👇"), 400);
</script>
</body>
</html>`;
