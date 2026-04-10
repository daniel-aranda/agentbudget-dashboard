import { AgentBudget } from "@agentbudget/agentbudget";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { handleDashboardRequest } from "../lib/dashboard.js";
import { PROVIDER_MODEL_CATALOG, type ProviderModelCatalogEntry } from "../lib/models.js";
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

interface DemoProviderRuntimeConfig {
  availableProviders: DemoProvider[];
  defaultProvider: DemoProvider;
  providerMode: "readonly" | "select";
  providerKeys: Partial<Record<DemoProvider, string>>;
}

const PROVIDER_LABELS: Record<DemoProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
};

const providerRuntime = loadProviderRuntimeConfig();
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
    const providers = Object.fromEntries(
      providerRuntime.availableProviders.map((provider) => [provider, PROVIDER_MODEL_CATALOG[provider]])
    ) as Partial<Record<DemoProvider, ProviderModelCatalogEntry>>;

    writeJson(response, 200, {
      store: storeLabel(store),
      available_providers: providerRuntime.availableProviders,
      provider_mode: providerRuntime.providerMode,
      default_provider: providerRuntime.defaultProvider,
      defaults: Object.fromEntries(
        providerRuntime.availableProviders.map((provider) => [
          provider,
          PROVIDER_MODEL_CATALOG[provider].defaultModel,
        ])
      ),
      providers,
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/sessions") {
    const body = await readJsonBody(request);
    const provider = parseConfiguredProvider(body.provider);
    const apiKey = getConfiguredProviderKey(provider);
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

    let reply;
    try {
      reply = await sendChatCompletion({
        provider: runtimeSession.provider,
        apiKey: runtimeSession.apiKey,
        model: runtimeSession.model,
        messages: runtimeSession.messages,
      });
    } catch (error) {
      runtimeSession.messages.pop();
      writeJson(response, 502, {
        error: formatProviderError(runtimeSession.provider, error),
      });
      return;
    }

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
    provider_label: PROVIDER_LABELS[runtimeSession.provider],
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

function parseConfiguredProvider(value: unknown): DemoProvider {
  if (value === "openai" || value === "anthropic") {
    const provider = value as DemoProvider;
    if (providerRuntime.availableProviders.includes(provider)) {
      return provider;
    }
    throw new Error("No Provider Key Available.");
  }
  if (providerRuntime.providerMode === "readonly") {
    return providerRuntime.defaultProvider;
  }
  throw new Error("provider must be one of the configured providers");
}

function normalizeModel(provider: DemoProvider, value: unknown): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return PROVIDER_MODEL_CATALOG[provider].defaultModel;
}

function getConfiguredProviderKey(provider: DemoProvider): string {
  const key = providerRuntime.providerKeys[provider]?.trim();
  if (!key) {
    throw new Error("No Provider Key Available.");
  }
  return key;
}

function formatProviderError(provider: DemoProvider, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (!providerRuntime.providerKeys[provider]?.trim()) {
    return "No Provider Key Available.";
  }

  if (
    provider === "openai" &&
    /incorrect api key|invalid api key|authentication|unauthorized|401/i.test(message)
  ) {
    return "Key for OpenAI does not work.";
  }

  if (
    provider === "anthropic" &&
    /invalid x-api-key|authentication|unauthorized|401|api key/i.test(message)
  ) {
    return "Key for Anthropic does not work.";
  }

  return message;
}

function loadProviderRuntimeConfig(): DemoProviderRuntimeConfig {
  const providerKeys: Partial<Record<DemoProvider, string>> = {};
  const openAIKey = process.env["AGENTBUDGET_OPENAI_KEY"]?.trim();
  const anthropicKey = process.env["AGENTBUDGET_ANTHROPHIC_KEY"]?.trim();

  if (openAIKey) {
    providerKeys.openai = openAIKey;
  }
  if (anthropicKey) {
    providerKeys.anthropic = anthropicKey;
  }

  const availableProviders = (["openai", "anthropic"] as const).filter(
    (provider) => providerKeys[provider]
  );

  if (!availableProviders.length) {
    throw new Error(
      "No Provider Key Available. Set AGENTBUDGET_OPENAI_KEY or AGENTBUDGET_ANTHROPHIC_KEY before starting the demo server."
    );
  }

  return {
    availableProviders: [...availableProviders],
    defaultProvider: availableProviders[0] as DemoProvider,
    providerMode: availableProviders.length === 1 ? "readonly" : "select",
    providerKeys,
  };
}

function renderChatPage(storeMode: string): string {
  const providerCatalog = JSON.stringify(
    Object.fromEntries(
      providerRuntime.availableProviders.map((provider) => [provider, PROVIDER_MODEL_CATALOG[provider]])
    )
  );
  const demoConfig = JSON.stringify({
    availableProviders: providerRuntime.availableProviders,
    providerMode: providerRuntime.providerMode,
    defaultProvider: providerRuntime.defaultProvider,
    providerLabels: Object.fromEntries(
      providerRuntime.availableProviders.map((provider) => [provider, PROVIDER_LABELS[provider]])
    ),
  });
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
    [hidden] { display: none !important; }
    .shell { max-width: 1320px; margin: 0 auto; padding: 24px; }
    .nav { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 0 18px; border-bottom: 1px solid var(--border); }
    .brand { font-size: 28px; font-weight: 800; letter-spacing: -0.04em; }
    .brand span { color: var(--accent-bright); }
    .badge { display: inline-flex; align-items: center; gap: 8px; padding: 6px 10px; border: 1px solid rgba(139, 92, 246, 0.24); background: rgba(139, 92, 246, 0.1); color: var(--accent-bright); font: 500 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .pulse { width: 8px; height: 8px; border-radius: 999px; background: var(--accent); box-shadow: 0 0 0 0 rgba(139, 92, 246, 0.55); animation: pulse 1.8s ease-in-out infinite; }
    .hero { padding: 18px 0 12px; }
    .hero-copy { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, 520px); gap: 28px; align-items: end; }
    .eyebrow { display: inline-flex; align-items: center; gap: 10px; padding: 7px 12px; border: 1px solid rgba(139, 92, 246, 0.2); background: rgba(139, 92, 246, 0.06); color: var(--muted); font: 500 12px ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; letter-spacing: 0.12em; }
    h1 { margin: 12px 0 8px; font-size: clamp(34px, 5vw, 64px); line-height: 0.9; letter-spacing: -0.06em; max-width: 860px; }
    .gradient { background: linear-gradient(90deg, var(--accent-blue) 0%, var(--accent) 42%, var(--accent-pink) 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
    .subtle { color: var(--muted); max-width: 980px; margin: 0; font-size: 17px; line-height: 1.55; }
    .layout { display: grid; grid-template-columns: 320px minmax(0, 1fr); gap: 24px; align-items: start; }
    .panel { border: 1px solid var(--border); background: linear-gradient(180deg, rgba(17,17,20,0.94), rgba(13,13,17,0.92)); padding: 18px; }
    .panel-contrast { border-color: rgba(167, 139, 250, 0.38); background: linear-gradient(180deg, rgba(24,20,34,0.98), rgba(15,13,22,0.96)); box-shadow: inset 0 0 0 1px rgba(167, 139, 250, 0.08); }
    .panel h2 { margin: 0 0 16px; font-size: 20px; letter-spacing: -0.04em; }
    .stack { display: grid; gap: 12px; }
    label { display: grid; gap: 6px; color: var(--muted); font-size: 13px; }
    .budget-field input { max-width: 180px; }
    input, select, textarea, button { font: inherit; }
    input, select, textarea { width: 100%; border: 1px solid var(--border-bright); background: #0d0d11; color: var(--text); padding: 11px 12px; }
    input[readonly], select:disabled, textarea:disabled { color: #d9d9e2; background: rgba(255,255,255,0.03); cursor: default; }
    textarea { min-height: 90px; resize: vertical; }
    button { border: 1px solid rgba(139, 92, 246, 0.35); background: linear-gradient(135deg, rgba(139,92,246,0.18), rgba(167,139,250,0.18)); color: var(--text); padding: 11px 14px; cursor: pointer; }
    button[disabled] { opacity: 0.5; cursor: not-allowed; }
    .button-row { display: flex; gap: 10px; flex-wrap: wrap; }
    .cta-button { background: linear-gradient(135deg, rgba(6,182,212,0.26), rgba(139,92,246,0.28)); border-color: rgba(6, 182, 212, 0.42); color: var(--text); font-weight: 600; }
    .cta-button span { margin-left: 6px; color: var(--accent-blue); font-size: 15px; }
    .session-panel { position: sticky; top: 24px; display: grid; gap: 18px; }
    .session-panel h2 { margin-bottom: 2px; }
    .session-divider { height: 1px; background: linear-gradient(90deg, rgba(167,139,250,0.24), rgba(167,139,250,0)); }
    .stats { display: grid; gap: 12px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .stat { border: 1px solid var(--border); background: rgba(9, 9, 11, 0.62); padding: 14px; }
    .stat .label { color: var(--muted-soft); font: 500 11px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.12em; text-transform: uppercase; }
    .stat .value { margin-top: 10px; font-size: 26px; font-weight: 700; letter-spacing: -0.05em; }
    .status { min-height: 20px; color: var(--muted); font-size: 13px; }
    .status.error { color: var(--danger); }
    .chat-shell { display: grid; gap: 16px; min-width: 0; align-content: start; }
    .transcript-panel { border: 1px solid var(--border); background: rgba(9, 9, 11, 0.72); padding: 16px; }
    .messages { height: min(62vh, 760px); overflow: auto; display: grid; gap: 14px; padding-right: 6px; }
    .message { padding: 14px 16px; border: 1px solid var(--border); background: rgba(17, 17, 20, 0.88); }
    .message.user { border-color: rgba(139, 92, 246, 0.48); background: linear-gradient(180deg, rgba(32,20,48,0.92), rgba(18,14,28,0.88)); }
    .message.assistant { border-color: rgba(6, 182, 212, 0.22); background: linear-gradient(180deg, rgba(14,20,24,0.96), rgba(12,14,18,0.92)); }
    .message-header { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 10px; color: var(--muted); font: 500 12px ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: lowercase; }
    .message-content { white-space: pre-wrap; line-height: 1.65; }
    .helper { color: var(--muted); font-size: 13px; line-height: 1.6; }
    @keyframes pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(139, 92, 246, 0.55); } 50% { box-shadow: 0 0 0 6px rgba(139, 92, 246, 0); } }
    @media (max-width: 980px) { .hero-copy, .layout { grid-template-columns: 1fr; } .session-panel { position: static; } .stats { grid-template-columns: 1fr 1fr; } .messages { height: min(56vh, 680px); } }
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
      <div class="hero-copy">
        <div>
          <div class="eyebrow">real app demo · openai + anthropic</div>
          <h1><span class="gradient">CHAT WITH LIVE COST VISIBILITY</span></h1>
          <p class="subtle">Use the provider key already configured on the server, choose a model and budget, then open the live dashboard in a new tab once the session is ready.</p>
        </div>
      </div>
    </section>
    <section class="layout">
      <aside class="panel session-panel">
        <h2 id="sessionTitle">Session</h2>
        <div class="session-divider"></div>
        <div class="stack">
          <label id="providerSelectWrap">Provider
            <select id="provider"></select>
          </label>
          <label id="providerReadonlyWrap" hidden>Provider
            <input id="providerReadonly" readonly />
          </label>
          <label>Model
            <select id="model"></select>
          </label>
          <label class="budget-field">Budget
            <input id="budget" value="$5.00" />
          </label>
          <div class="button-row">
            <button id="createSession">Create session</button>
            <button id="openDashboard" class="cta-button" hidden>Open dashboard <span aria-hidden="true">↗</span></button>
          </div>
          <div id="sessionStatus" class="status"></div>
        </div>
        <div class="session-divider" id="chatComposerDivider" hidden></div>
        <div class="stack" id="chatComposer" hidden>
          <h2 style="margin: 0;">Chat</h2>
          <label>Message
            <textarea id="prompt" placeholder="Ask the model something..."></textarea>
          </label>
          <div class="button-row">
            <button id="sendMessage" disabled>Send message</button>
          </div>
        </div>
      </aside>
      <main class="chat-shell">
        <section id="howItWorks" class="panel panel-contrast">
          <h2>How It Works</h2>
          <div class="helper">
            <p>1. Create a chat session with one configured provider, a model, and a budget.</p>
            <p>2. Each completion goes through AgentBudget for cost tracking.</p>
            <p>3. Click Open dashboard ↗ to open the live dashboard for this exact session in a new tab.</p>
            <p>4. Provider keys stay on the server. They are never exposed in the browser UI.</p>
          </div>
        </section>
        <section id="sessionOverview" class="chat-shell" hidden>
          <div class="stats">
            <div class="stat"><div class="label">session id</div><div class="value" id="sessionId">--</div></div>
            <div class="stat"><div class="label">provider</div><div class="value" id="sessionProvider">--</div></div>
            <div class="stat"><div class="label">spent</div><div class="value" id="spent">$0.000000</div></div>
            <div class="stat"><div class="label">remaining</div><div class="value" id="remaining">$0.000000</div></div>
          </div>
          <div class="transcript-panel">
            <div class="messages" id="messages"></div>
          </div>
        </section>
      </main>
    </section>
  </div>
  <script>
    const state = { sessionId: null, dashboardUrl: null, model: null, provider: null, isSending: false };
    const providerCatalog = ${providerCatalog};
    const demoConfig = ${demoConfig};
    const providerSelectWrapEl = document.getElementById("providerSelectWrap");
    const providerReadonlyWrapEl = document.getElementById("providerReadonlyWrap");
    const providerEl = document.getElementById("provider");
    const providerReadonlyEl = document.getElementById("providerReadonly");
    const modelEl = document.getElementById("model");
    const budgetEl = document.getElementById("budget");
    const promptEl = document.getElementById("prompt");
    const createEl = document.getElementById("createSession");
    const dashboardEl = document.getElementById("openDashboard");
    const sendEl = document.getElementById("sendMessage");
    const sessionTitleEl = document.getElementById("sessionTitle");
    const statusEl = document.getElementById("sessionStatus");
    const howItWorksEl = document.getElementById("howItWorks");
    const sessionOverviewEl = document.getElementById("sessionOverview");
    const chatComposerDividerEl = document.getElementById("chatComposerDivider");
    const chatComposerEl = document.getElementById("chatComposer");
    const messagesEl = document.getElementById("messages");
    const sessionIdEl = document.getElementById("sessionId");
    const sessionProviderEl = document.getElementById("sessionProvider");
    const spentEl = document.getElementById("spent");
    const remainingEl = document.getElementById("remaining");
    const defaultSendLabel = sendEl.textContent || "Send message";

    createEl.addEventListener("click", createSession);
    dashboardEl.addEventListener("click", () => { if (state.dashboardUrl) window.open(state.dashboardUrl, "_blank", "noopener"); });
    sendEl.addEventListener("click", sendMessage);
    promptEl.addEventListener("input", syncComposerState);

    configureProviderUi();
    applySessionMode(false);

    async function createSession() {
      if (!state.provider) {
        setStatus("No Provider Key Available.", true);
        return;
      }
      try {
        setStatus("Creating tracked session...");
        const response = await fetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: state.provider,
            model: modelEl.value,
            budget: budgetEl.value
          })
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Could not create session");
        hydrateSession(payload);
        setStatus("Session ready. Click Open dashboard ↗ to open it in a new tab.");
      } catch (error) {
        setStatus(error.message || String(error), true);
      }
    }

    async function sendMessage() {
      if (!state.sessionId || state.isSending) return;
      const submittedContent = promptEl.value.trim();
      if (!submittedContent) return;
      try {
        state.isSending = true;
        syncComposerState();
        setStatus("Calling provider... frontier models can take a bit.");
        const response = await fetch("/api/sessions/" + encodeURIComponent(state.sessionId) + "/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: submittedContent })
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Message failed");
        hydrateSession(payload.session);
        promptEl.value = "";
        setStatus("Message completed.");
      } catch (error) {
        setStatus(error.message || String(error), true);
      } finally {
        state.isSending = false;
        syncComposerState();
      }
    }

    function hydrateSession(session) {
      state.sessionId = session.session_id;
      state.dashboardUrl = session.dashboard_url;
      state.model = session.model;
      state.provider = session.provider;
      applySessionMode(true);
      if (demoConfig.providerMode === "select") {
        providerEl.value = session.provider;
      } else {
        providerReadonlyEl.value = session.provider_label || demoConfig.providerLabels[session.provider];
      }
      syncModelOptions(session.provider, session.model);
      budgetEl.value = session.budget;
      sessionIdEl.textContent = session.session_id;
      sessionProviderEl.textContent =
        (session.provider_label || demoConfig.providerLabels[session.provider]) + " · " + session.model;
      spentEl.textContent = "$" + Number(session.spent || 0).toFixed(6);
      remainingEl.textContent = "$" + Number(session.remaining || 0).toFixed(6);
      renderMessages(session.messages || []);
    }

    function renderMessages(messages) {
      messagesEl.innerHTML = "";
      if (!messages.length) {
        const empty = document.createElement("div");
        empty.className = "helper";
        empty.textContent = "No messages yet. Send your first prompt, then click Open dashboard ↗ to watch spend live.";
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

    function applySessionMode(hasSession) {
      createEl.hidden = hasSession;
      dashboardEl.hidden = !hasSession;
      dashboardEl.disabled = !hasSession;
      sessionTitleEl.textContent = "Session";
      budgetEl.readOnly = hasSession;
      modelEl.disabled = hasSession;
      if (demoConfig.providerMode === "select") {
        providerEl.disabled = hasSession;
      }
      howItWorksEl.hidden = hasSession;
      sessionOverviewEl.hidden = !hasSession;
      chatComposerDividerEl.hidden = !hasSession;
      chatComposerEl.hidden = !hasSession;
      syncComposerState();
      if (!hasSession) {
        renderMessages([]);
      }
    }

    function syncComposerState() {
      const hasSession = Boolean(state.sessionId);
      const hasPrompt = Boolean(promptEl.value.trim());
      promptEl.disabled = !hasSession || state.isSending;
      promptEl.placeholder = state.isSending ? "Waiting for the provider response..." : "Ask the model something...";
      sendEl.disabled = !hasSession || state.isSending || !hasPrompt;
      sendEl.textContent = state.isSending ? "Waiting for response..." : defaultSendLabel;
    }

    function configureProviderUi() {
      const availableProviders = demoConfig.availableProviders || [];
      if (!availableProviders.length) {
        setStatus("No Provider Key Available.", true);
        createEl.disabled = true;
        promptEl.disabled = true;
        return;
      }

      state.provider = demoConfig.defaultProvider;
      if (demoConfig.providerMode === "readonly") {
        providerSelectWrapEl.hidden = true;
        providerReadonlyWrapEl.hidden = false;
        providerReadonlyEl.value = demoConfig.providerLabels[state.provider];
      } else {
        providerSelectWrapEl.hidden = false;
        providerReadonlyWrapEl.hidden = true;
        providerEl.innerHTML = "";
        for (const provider of availableProviders) {
          const option = document.createElement("option");
          option.value = provider;
          option.textContent = demoConfig.providerLabels[provider];
          providerEl.appendChild(option);
        }
        providerEl.value = state.provider;
        providerEl.addEventListener("change", () => {
          state.provider = providerEl.value;
          syncModelOptions(state.provider, providerCatalog[state.provider].defaultModel);
        });
      }

      syncModelOptions(state.provider, providerCatalog[state.provider].defaultModel);
    }

    function syncModelOptions(provider, selectedModel) {
      const catalog = providerCatalog[provider];
      if (!catalog) return;
      const options = [...catalog.models];
      if (selectedModel && !options.some((option) => option.value === selectedModel)) {
        options.unshift({ value: selectedModel, label: selectedModel + " (resolved)" });
      }

      modelEl.innerHTML = "";
      for (const option of options) {
        const element = document.createElement("option");
        element.value = option.value;
        element.textContent = option.label;
        modelEl.appendChild(element);
      }

      modelEl.value = selectedModel || catalog.defaultModel;
    }
  </script>
</body>
</html>`;
}
