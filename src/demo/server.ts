import { AgentBudget } from "@agentbudget/agentbudget";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { handleDashboardRequest } from "../lib/dashboard.js";
import { MemoryTimelineStore, RedisTimelineStore, type TimelineStore } from "../lib/timeline.js";
import { TrackedBudgetSession } from "../lib/tracked-session.js";
import { sendChatCompletion, type DemoMessage, type DemoProvider } from "./providers.js";

interface DemoRuntimeSession {
  provider: DemoProvider;
  apiKey: string;
  model: string;
  budget: string;
  tracked: TrackedBudgetSession;
  messages: DemoMessage[];
  createdAt: number;
}

const store = createStore();
const sessions = new Map<string, DemoRuntimeSession>();

const host = process.env["HOST"] ?? "127.0.0.1";
const port = Number(process.env["PORT"] ?? "3000");

const server = createServer(async (request, response) => {
  try {
    if (await handleDashboardRequest(request, response, store)) {
      return;
    }
    await handleDemoRequest(request, response);
  } catch (error) {
    writeJson(response, 500, { error: (error as Error).message });
  }
});

server.listen(port, host, () => {
  console.log(
    `agentbudget-dashboard demo running at http://${host}:${port} using ${storeLabel(store)} store`
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

async function shutdown(signal: string): Promise<void> {
  console.log(`shutting down on ${signal}`);
  for (const session of sessions.values()) {
    await session.tracked.close();
  }
  server.close(() => process.exit(0));
}

async function handleDemoRequest(
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (request.method === "GET" && url.pathname === "/") {
    writeHtml(response, renderChatPage(storeLabel(store)));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/config") {
    writeJson(response, 200, {
      store: storeLabel(store),
      defaults: {
        openai: "gpt-4o-mini",
        anthropic: "claude-3-5-haiku-20241022",
      },
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/sessions") {
    const body = await readJsonBody(request);
    const provider = parseProvider(body.provider);
    const apiKey = requireString(body.apiKey, "apiKey");
    const budget = requireString(body.budget, "budget");
    const model = normalizeModel(provider, body.model);

    const budgetTracker = new AgentBudget(budget);
    const tracked = await TrackedBudgetSession.start(budgetTracker, store);
    const runtimeSession: DemoRuntimeSession = {
      provider,
      apiKey,
      budget,
      model,
      tracked,
      messages: [
        {
          role: "system",
          content:
            "You are a concise assistant in a cost-tracked demo. Answer clearly and keep responses short unless the user asks for detail.",
        },
      ],
      createdAt: Date.now(),
    };
    sessions.set(tracked.id, runtimeSession);

    writeJson(response, 201, serializeSession(tracked.id, runtimeSession));
    return;
  }

  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (request.method === "GET" && sessionMatch) {
    const sessionId = decodeURIComponent(sessionMatch[1] ?? "");
    const runtimeSession = sessions.get(sessionId);
    if (!runtimeSession) {
      writeJson(response, 404, { error: "Unknown session" });
      return;
    }
    writeJson(response, 200, serializeSession(sessionId, runtimeSession));
    return;
  }

  const messageMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (request.method === "POST" && messageMatch) {
    const sessionId = decodeURIComponent(messageMatch[1] ?? "");
    const runtimeSession = sessions.get(sessionId);
    if (!runtimeSession) {
      writeJson(response, 404, { error: "Unknown session" });
      return;
    }

    const body = await readJsonBody(request);
    const content = requireString(body.content, "content");
    runtimeSession.messages.push({ role: "user", content });

    const reply = await sendChatCompletion({
      provider: runtimeSession.provider,
      apiKey: runtimeSession.apiKey,
      model: runtimeSession.model,
      messages: runtimeSession.messages,
    });

    await runtimeSession.tracked.wrapUsage(reply.model, reply.inputTokens, reply.outputTokens);
    runtimeSession.messages.push({ role: "assistant", content: reply.text });
    runtimeSession.model = reply.model;

    writeJson(response, 200, {
      reply: reply.text,
      usage: {
        model: reply.model,
        input_tokens: reply.inputTokens,
        output_tokens: reply.outputTokens,
      },
      session: serializeSession(sessionId, runtimeSession),
    });
    return;
  }

  writeJson(response, 404, { error: "Unknown route" });
}

function serializeSession(sessionId: string, runtimeSession: DemoRuntimeSession) {
  const report = runtimeSession.tracked.report();
  return {
    session_id: sessionId,
    provider: runtimeSession.provider,
    model: runtimeSession.model,
    budget: runtimeSession.budget,
    dashboard_url: `/dashboard?sessionId=${encodeURIComponent(sessionId)}`,
    created_at: runtimeSession.createdAt,
    spent: runtimeSession.tracked.spent,
    remaining: runtimeSession.tracked.remaining,
    report,
    messages: runtimeSession.messages.filter((message) => message.role !== "system"),
  };
}

function createStore(): TimelineStore {
  const mode =
    process.env["TIMELINE_STORE"] ??
    (process.env["AGENTBUDGET_DASHBOARD_REDIS_URL"] || process.env["AGENTBUDGET_REDIS_URL"]
      ? "redis"
      : "memory");

  if (mode === "redis") {
    const redisOptions: { redisUrl?: string; namespace?: string } = {
      namespace: process.env["TIMELINE_NAMESPACE"] ?? "agentbudget-dashboard",
    };
    const redisUrl =
      process.env["AGENTBUDGET_DASHBOARD_REDIS_URL"] ?? process.env["AGENTBUDGET_REDIS_URL"];
    if (redisUrl) {
      redisOptions.redisUrl = redisUrl;
    }
    return new RedisTimelineStore(redisOptions);
  }

  return new MemoryTimelineStore();
}

function storeLabel(currentStore: TimelineStore): string {
  return currentStore instanceof RedisTimelineStore ? "redis" : "memory";
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function writeHtml(response: ServerResponse, body: string): void {
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(body);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

function requireString(value: unknown, key: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing or invalid ${key}`);
  }
  return value.trim();
}

function parseProvider(value: unknown): DemoProvider {
  if (value === "openai" || value === "anthropic") {
    return value;
  }
  throw new Error("provider must be 'openai' or 'anthropic'");
}

function normalizeModel(provider: DemoProvider, value: unknown): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return provider === "openai" ? "gpt-4o-mini" : "claude-3-5-haiku-20241022";
}

function renderChatPage(storeMode: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AgentBudget Dashboard Demo</title>
  <style>
    :root { --bg: #09090b; --border: #1c1c22; --border-bright: #2a2a32; --surface: #111114; --text: #fafafa; --muted: #a1a1aa; --muted-soft: #71717a; --accent: #8b5cf6; --accent-bright: #a78bfa; --accent-pink: #ec4899; --accent-blue: #06b6d4; --ok: #22c55e; --danger: #f87171; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; color: var(--text); background: radial-gradient(circle at top left, rgba(139, 92, 246, 0.18), transparent 32%), radial-gradient(circle at top right, rgba(6, 182, 212, 0.12), transparent 26%), linear-gradient(180deg, #0b0b0f 0%, #07070a 100%); font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body::after { content: ""; position: fixed; inset: 0; pointer-events: none; opacity: 0.04; background-image: radial-gradient(rgba(255,255,255,0.5) 0.6px, transparent 0.6px); background-size: 8px 8px; }
    .shell { max-width: 1320px; margin: 0 auto; padding: 24px; }
    .nav { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 0 18px; border-bottom: 1px solid var(--border); }
    .brand { font-size: 28px; font-weight: 800; letter-spacing: -0.04em; }
    .brand span { color: var(--accent-bright); }
    .badge { display: inline-flex; align-items: center; gap: 8px; padding: 6px 10px; border: 1px solid rgba(139, 92, 246, 0.24); background: rgba(139, 92, 246, 0.1); color: var(--accent-bright); font: 500 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .pulse { width: 8px; height: 8px; border-radius: 999px; background: var(--accent); box-shadow: 0 0 0 0 rgba(139, 92, 246, 0.55); animation: pulse 1.8s ease-in-out infinite; }
    .hero { display: grid; grid-template-columns: 1.2fr 0.8fr; gap: 24px; padding: 36px 0 28px; }
    .eyebrow { display: inline-flex; align-items: center; gap: 10px; padding: 7px 12px; border: 1px solid rgba(139, 92, 246, 0.2); background: rgba(139, 92, 246, 0.06); color: var(--muted); font: 500 12px ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; letter-spacing: 0.12em; }
    h1 { margin: 18px 0 14px; font-size: clamp(40px, 6vw, 72px); line-height: 0.96; letter-spacing: -0.06em; }
    .gradient { background: linear-gradient(90deg, var(--accent-blue) 0%, var(--accent) 42%, var(--accent-pink) 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
    .subtle { color: var(--muted); max-width: 700px; margin: 0; font-size: 17px; line-height: 1.7; }
    .layout { display: grid; grid-template-columns: 360px 1fr; gap: 24px; }
    .panel { border: 1px solid var(--border); background: linear-gradient(180deg, rgba(17,17,20,0.94), rgba(13,13,17,0.92)); padding: 18px; }
    .panel h2 { margin: 0 0 16px; font-size: 20px; letter-spacing: -0.04em; }
    .stack { display: grid; gap: 12px; }
    label { display: grid; gap: 6px; color: var(--muted); font-size: 13px; }
    input, select, textarea, button { font: inherit; }
    input, select, textarea { width: 100%; border: 1px solid var(--border-bright); background: #0d0d11; color: var(--text); padding: 11px 12px; }
    textarea { min-height: 90px; resize: vertical; }
    button { border: 1px solid rgba(139, 92, 246, 0.35); background: linear-gradient(135deg, rgba(139,92,246,0.18), rgba(167,139,250,0.18)); color: var(--text); padding: 11px 14px; cursor: pointer; }
    button[disabled] { opacity: 0.5; cursor: not-allowed; }
    .button-row { display: flex; gap: 10px; flex-wrap: wrap; }
    .secondary { background: transparent; border-color: var(--border-bright); color: var(--muted); }
    .stats { display: grid; gap: 12px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .stat { border: 1px solid var(--border); background: rgba(9, 9, 11, 0.62); padding: 14px; }
    .stat .label { color: var(--muted-soft); font: 500 11px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.12em; text-transform: uppercase; }
    .stat .value { margin-top: 10px; font-size: 26px; font-weight: 700; letter-spacing: -0.05em; }
    .status { min-height: 20px; color: var(--muted); font-size: 13px; }
    .status.error { color: var(--danger); }
    .chat-shell { display: grid; gap: 16px; }
    .messages { min-height: 420px; max-height: 620px; overflow: auto; border: 1px solid var(--border); background: rgba(9, 9, 11, 0.72); padding: 16px; display: grid; gap: 12px; }
    .message { padding: 14px; border: 1px solid var(--border); background: rgba(17, 17, 20, 0.88); }
    .message.user { border-color: rgba(139, 92, 246, 0.35); }
    .message-header { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 8px; color: var(--muted); font: 500 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .message-content { white-space: pre-wrap; line-height: 1.65; }
    .helper { color: var(--muted); font-size: 13px; line-height: 1.6; }
    @keyframes pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(139, 92, 246, 0.55); } 50% { box-shadow: 0 0 0 6px rgba(139, 92, 246, 0); } }
    @media (max-width: 980px) { .hero, .layout { grid-template-columns: 1fr; } .stats { grid-template-columns: 1fr 1fr; } }
    @media (max-width: 640px) { .shell { padding: 16px; } .stats { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="shell">
    <div class="nav">
      <div class="brand">Agent<span>Budget</span> Dashboard</div>
      <div class="badge"><span class="pulse"></span>${storeMode} timeline store</div>
    </div>
    <section class="hero">
      <div>
        <div class="eyebrow">real app demo · openai + anthropic</div>
        <h1><span class="gradient">CHAT WITH</span><br /><span class="gradient">LIVE COST</span><br /><span style="color: var(--muted)">VISIBILITY</span></h1>
        <p class="subtle">Paste an API key, choose a provider, start a tracked AgentBudget session, and open the dashboard in another tab to watch spend move in real time.</p>
      </div>
      <div class="panel">
        <h2>How It Works</h2>
        <div class="helper">
          <p>1. Create a chat session with a provider, model, and budget.</p>
          <p>2. Each completion goes through AgentBudget for cost tracking.</p>
          <p>3. The dashboard reads the same timeline store and plots spend by model and tool.</p>
          <p>4. API keys stay only in this process memory. They are never written into the timeline store.</p>
        </div>
      </div>
    </section>
    <section class="layout">
      <aside class="panel">
        <h2>Session Setup</h2>
        <div class="stack">
          <label>Provider
            <select id="provider">
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </label>
          <label>Model
            <input id="model" value="gpt-4o-mini" />
          </label>
          <label>Budget
            <input id="budget" value="$5.00" />
          </label>
          <label>API key
            <input id="apiKey" type="password" placeholder="sk-... / sk-ant-..." />
          </label>
          <div class="button-row">
            <button id="createSession">Create session</button>
            <button id="openDashboard" class="secondary" disabled>Open dashboard</button>
          </div>
          <div id="sessionStatus" class="status"></div>
        </div>
      </aside>
      <main class="chat-shell">
        <div class="stats">
          <div class="stat"><div class="label">session id</div><div class="value" id="sessionId">--</div></div>
          <div class="stat"><div class="label">provider</div><div class="value" id="sessionProvider">--</div></div>
          <div class="stat"><div class="label">spent</div><div class="value" id="spent">$0.000000</div></div>
          <div class="stat"><div class="label">remaining</div><div class="value" id="remaining">$0.000000</div></div>
        </div>
        <div class="messages" id="messages"></div>
        <div class="panel">
          <h2>Chat</h2>
          <div class="stack">
            <label>Message
              <textarea id="prompt" placeholder="Ask the model something..."></textarea>
            </label>
            <div class="button-row">
              <button id="sendMessage" disabled>Send message</button>
              <button id="refreshState" class="secondary" disabled>Refresh state</button>
            </div>
            <div class="helper">Open the dashboard after creating a session. Leave it in a second tab and watch spend update while you chat here.</div>
          </div>
        </div>
      </main>
    </section>
  </div>
  <script>
    const state = { sessionId: null, dashboardUrl: null, model: null, provider: null };
    const providerDefaults = { openai: "gpt-4o-mini", anthropic: "claude-3-5-haiku-20241022" };
    const providerEl = document.getElementById("provider");
    const modelEl = document.getElementById("model");
    const budgetEl = document.getElementById("budget");
    const apiKeyEl = document.getElementById("apiKey");
    const promptEl = document.getElementById("prompt");
    const createEl = document.getElementById("createSession");
    const dashboardEl = document.getElementById("openDashboard");
    const sendEl = document.getElementById("sendMessage");
    const refreshEl = document.getElementById("refreshState");
    const statusEl = document.getElementById("sessionStatus");
    const messagesEl = document.getElementById("messages");
    const sessionIdEl = document.getElementById("sessionId");
    const sessionProviderEl = document.getElementById("sessionProvider");
    const spentEl = document.getElementById("spent");
    const remainingEl = document.getElementById("remaining");

    providerEl.addEventListener("change", () => { modelEl.value = providerDefaults[providerEl.value]; });
    createEl.addEventListener("click", createSession);
    dashboardEl.addEventListener("click", () => { if (state.dashboardUrl) window.open(state.dashboardUrl, "_blank", "noopener"); });
    sendEl.addEventListener("click", sendMessage);
    refreshEl.addEventListener("click", refreshState);

    renderMessages([]);

    async function createSession() {
      try {
        setStatus("Creating tracked session...");
        const response = await fetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: providerEl.value,
            model: modelEl.value,
            budget: budgetEl.value,
            apiKey: apiKeyEl.value
          })
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Could not create session");
        hydrateSession(payload);
        sendEl.disabled = false;
        refreshEl.disabled = false;
        dashboardEl.disabled = false;
        setStatus("Session ready. Open the dashboard in another tab.");
      } catch (error) {
        setStatus(error.message || String(error), true);
      }
    }

    async function sendMessage() {
      if (!state.sessionId) return;
      try {
        sendEl.disabled = true;
        setStatus("Calling provider...");
        const response = await fetch("/api/sessions/" + encodeURIComponent(state.sessionId) + "/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: promptEl.value })
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Message failed");
        hydrateSession(payload.session);
        promptEl.value = "";
        setStatus("Message completed.");
      } catch (error) {
        setStatus(error.message || String(error), true);
      } finally {
        sendEl.disabled = false;
      }
    }

    async function refreshState() {
      if (!state.sessionId) return;
      try {
        const response = await fetch("/api/sessions/" + encodeURIComponent(state.sessionId), { cache: "no-store" });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Refresh failed");
        hydrateSession(payload);
        setStatus("Session refreshed.");
      } catch (error) {
        setStatus(error.message || String(error), true);
      }
    }

    function hydrateSession(session) {
      state.sessionId = session.session_id;
      state.dashboardUrl = session.dashboard_url;
      state.model = session.model;
      state.provider = session.provider;
      sessionIdEl.textContent = session.session_id;
      sessionProviderEl.textContent = session.provider + " · " + session.model;
      spentEl.textContent = "$" + Number(session.spent || 0).toFixed(6);
      remainingEl.textContent = "$" + Number(session.remaining || 0).toFixed(6);
      renderMessages(session.messages || []);
    }

    function renderMessages(messages) {
      messagesEl.innerHTML = "";
      if (!messages.length) {
        const empty = document.createElement("div");
        empty.className = "helper";
        empty.textContent = "No messages yet. Create a session, send a prompt, then open the dashboard tab.";
        messagesEl.appendChild(empty);
        return;
      }
      for (const message of messages) {
        const card = document.createElement("div");
        card.className = "message " + message.role;
        card.innerHTML = '<div class="message-header"><span>' + message.role + '</span></div><div class="message-content"></div>';
        card.querySelector(".message-content").textContent = message.content;
        messagesEl.appendChild(card);
      }
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function setStatus(message, isError = false) {
      statusEl.textContent = message;
      statusEl.className = "status" + (isError ? " error" : "");
    }
  </script>
</body>
</html>`;
}
