import type { IncomingMessage, ServerResponse } from "node:http";

import type { SessionMetadata, TimelineEvent, TimelinePoint, TimelineStore } from "./timeline.js";

const PERIOD_ALIASES: Record<string, number> = {
  "60": 60,
  "180": 180,
  "300": 300,
  "600": 600,
  "1800": 1800,
  "3600": 3600,
  "21600": 21600,
  last_minute: 60,
  last_3_minutes: 180,
  last_5_minutes: 300,
  last_10_minutes: 600,
  last_30_minutes: 1800,
  last_hour: 3600,
  last_6_hours: 21600,
  "1m": 60,
  "3m": 180,
  "5m": 300,
  "10m": 600,
  "30m": 1800,
  "1h": 3600,
  "6h": 21600,
};

const FIVE_MINUTES_MS = 5 * 60 * 1000;

interface DashboardRecentEvent {
  timestamp_ms: number;
  event_type_label: string;
  model_label: string;
  tokens: number;
  cost_delta: number;
}

interface DashboardSessionPayload extends SessionMetadata {
  session_percent: number;
  burn_rate_per_min: number;
  previous_burn_rate_per_min: number;
  projected_exhaustion_minutes: number | null;
  previous_projected_exhaustion_minutes: number | null;
  messages_count: number;
  total_tokens: number;
  last_5m_cost: number;
  previous_5m_cost: number;
  last_5m_messages: number;
  previous_5m_messages: number;
  last_5m_tokens: number;
  previous_5m_tokens: number;
  recent_events: DashboardRecentEvent[];
}

interface DashboardTimelinePayload {
  session_id: string;
  budget: number;
  period_seconds: number;
  window_start_ms: number;
  generated_at_ms: number;
  spend_points: TimelinePoint[];
}

export async function handleDashboardRequest(
  request: IncomingMessage,
  response: ServerResponse,
  store: TimelineStore
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (url.pathname === "/dashboard") {
    writeHtml(response, DASHBOARD_HTML);
    return true;
  }

  if (url.pathname === "/api/dashboard/session") {
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      writeJson(response, 400, { error: "Missing sessionId query param" });
      return true;
    }

    const session = await store.getSession(sessionId);
    if (!session) {
      writeJson(response, 404, { error: "Tracked session not found" });
      return true;
    }

    const nowMs = Number(url.searchParams.get("now_ms") ?? Date.now());
    const events = await store.getEvents(sessionId, 0, nowMs);
    writeJson(response, 200, buildDashboardSessionPayload(session, events, nowMs));
    return true;
  }

  if (url.pathname === "/api/dashboard/timeline") {
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      writeJson(response, 400, { error: "Missing sessionId query param" });
      return true;
    }

    const period = resolvePeriod(url.searchParams.get("period"));
    if (!period) {
      writeJson(response, 400, { error: "Unsupported period" });
      return true;
    }

    const session = await store.getSession(sessionId);
    if (!session) {
      writeJson(response, 404, { error: "Tracked session not found" });
      return true;
    }

    const nowMs = Number(url.searchParams.get("now_ms") ?? Date.now());
    const events = await store.getEvents(sessionId, nowMs - period * 1000, nowMs);
    writeJson(response, 200, buildDashboardTimelinePayload(session, events, period, nowMs));
    return true;
  }

  return false;
}

function resolvePeriod(rawPeriod: string | null): number | null {
  const value = rawPeriod?.trim().toLowerCase() ?? "600";
  return PERIOD_ALIASES[value] ?? null;
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

function buildDashboardSessionPayload(
  session: SessionMetadata,
  events: TimelineEvent[],
  nowMs: number
): DashboardSessionPayload {
  const recent = filterEvents(events, nowMs - FIVE_MINUTES_MS, nowMs);
  const previous = filterEvents(events, nowMs - FIVE_MINUTES_MS * 2, nowMs - FIVE_MINUTES_MS);
  const llmEvents = events.filter((event) => event.event_type === "llm");
  const recentLLM = recent.filter((event) => event.event_type === "llm");
  const previousLLM = previous.filter((event) => event.event_type === "llm");
  const burnRatePerMin = round6(sumCost(recent) / 5);
  const previousBurnRatePerMin = round6(sumCost(previous) / 5);
  const previousRemaining = round6(session.remaining + sumCost(recent));

  return {
    ...session,
    session_percent: session.budget > 0 ? round4((session.total_spent / session.budget) * 100) : 0,
    burn_rate_per_min: burnRatePerMin,
    previous_burn_rate_per_min: previousBurnRatePerMin,
    projected_exhaustion_minutes:
      burnRatePerMin > 0 ? round2(session.remaining / burnRatePerMin) : null,
    previous_projected_exhaustion_minutes:
      previousBurnRatePerMin > 0 ? round2(previousRemaining / previousBurnRatePerMin) : null,
    messages_count: llmEvents.length,
    total_tokens: sumTokens(llmEvents),
    last_5m_cost: round6(sumCost(recent)),
    previous_5m_cost: round6(sumCost(previous)),
    last_5m_messages: recentLLM.length,
    previous_5m_messages: previousLLM.length,
    last_5m_tokens: sumTokens(recentLLM),
    previous_5m_tokens: sumTokens(previousLLM),
    recent_events: [...events]
      .sort((left, right) => right.timestamp_ms - left.timestamp_ms)
      .slice(0, 12)
      .map(mapRecentEvent),
  };
}

function buildDashboardTimelinePayload(
  session: SessionMetadata,
  events: TimelineEvent[],
  periodSeconds: number,
  nowMs: number
): DashboardTimelinePayload {
  const windowStart = nowMs - periodSeconds * 1000;
  const spendPoints: TimelinePoint[] = [];

  if (!events.length) {
    spendPoints.push(
      { timestamp_ms: windowStart, value: round6(session.total_spent) },
      { timestamp_ms: nowMs, value: round6(session.total_spent) }
    );
  } else {
    const baseline = Math.max(round6((events[0]?.total_spent ?? 0) - (events[0]?.cost ?? 0)), 0);
    spendPoints.push({ timestamp_ms: windowStart, value: baseline });
    for (const event of events) {
      spendPoints.push({
        timestamp_ms: event.timestamp_ms,
        value: round6(event.total_spent),
      });
    }
    const lastValue = round6(events[events.length - 1]?.total_spent ?? baseline);
    if ((events[events.length - 1]?.timestamp_ms ?? 0) < nowMs) {
      spendPoints.push({ timestamp_ms: nowMs, value: lastValue });
    }
  }

  return {
    session_id: session.session_id,
    budget: round6(session.budget),
    period_seconds: periodSeconds,
    window_start_ms: windowStart,
    generated_at_ms: nowMs,
    spend_points: spendPoints,
  };
}

function filterEvents(events: TimelineEvent[], startMs: number, endMs: number): TimelineEvent[] {
  return events.filter((event) => event.timestamp_ms >= startMs && event.timestamp_ms <= endMs);
}

function sumCost(events: TimelineEvent[]): number {
  return events.reduce((total, event) => total + (event.cost || 0), 0);
}

function sumTokens(events: TimelineEvent[]): number {
  return events.reduce(
    (total, event) => total + (event.input_tokens || 0) + (event.output_tokens || 0),
    0
  );
}

function mapRecentEvent(event: TimelineEvent): DashboardRecentEvent {
  return {
    timestamp_ms: event.timestamp_ms,
    event_type_label: event.event_type === "llm" ? "assistant response" : "tool event",
    model_label: event.model ?? event.tool_name ?? event.category_key ?? "unlabeled",
    tokens: (event.input_tokens || 0) + (event.output_tokens || 0),
    cost_delta: round6(event.cost),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AgentBudget Dashboard</title>
  <style>
    :root {
      --bg: #09090b;
      --surface: rgba(12, 12, 17, 0.82);
      --surface-strong: rgba(18, 18, 24, 0.92);
      --surface-glass: rgba(20, 20, 27, 0.72);
      --border: rgba(255, 255, 255, 0.08);
      --border-bright: rgba(167, 139, 250, 0.28);
      --text: #fafafa;
      --muted: #a1a1aa;
      --muted-soft: #71717a;
      --accent: #8b5cf6;
      --accent-bright: #a78bfa;
      --accent-pink: #ec4899;
      --accent-blue: #06b6d4;
      --safe: #22c55e;
      --warn: #f59e0b;
      --danger: #fb7185;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--text);
      background:
        radial-gradient(circle at top left, rgba(139, 92, 246, 0.18), transparent 30%),
        radial-gradient(circle at top right, rgba(6, 182, 212, 0.13), transparent 24%),
        linear-gradient(180deg, #0a0a0e 0%, #06060a 100%);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    body::after {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      opacity: 0.04;
      background-image: radial-gradient(rgba(255,255,255,0.5) 0.6px, transparent 0.6px);
      background-size: 8px 8px;
    }
    [hidden] { display: none !important; }
    .shell { max-width: 1380px; margin: 0 auto; padding: 24px; }
    .nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 14px 0 18px;
      border-bottom: 1px solid var(--border);
    }
    .brand { font-size: 28px; font-weight: 800; letter-spacing: -0.04em; }
    .brand span { color: var(--accent-bright); }
    .live-badge {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      border: 1px solid rgba(167, 139, 250, 0.28);
      background: linear-gradient(135deg, rgba(12,18,28,0.92), rgba(28,16,38,0.92));
      color: var(--accent-bright);
      font: 600 12px ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      box-shadow: 0 0 0 1px rgba(167, 139, 250, 0.04), 0 12px 30px rgba(0,0,0,0.3);
    }
    .live-dot {
      width: 9px;
      height: 9px;
      border-radius: 999px;
      background: var(--accent-pink);
      box-shadow: 0 0 0 0 rgba(236, 72, 153, 0.6);
      animation: pulse 1.8s ease-in-out infinite;
    }
    .hero {
      display: grid;
      grid-template-columns: minmax(0, 1.1fr) minmax(360px, 540px);
      gap: 28px;
      align-items: end;
      padding: 26px 0 20px;
    }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      border: 1px solid rgba(167, 139, 250, 0.18);
      background: rgba(139, 92, 246, 0.06);
      color: var(--muted);
      font: 500 12px ui-monospace, SFMono-Regular, Menlo, monospace;
      text-transform: uppercase;
      letter-spacing: 0.12em;
    }
    h1 {
      margin: 16px 0 10px;
      font-size: clamp(40px, 6vw, 78px);
      line-height: 0.92;
      letter-spacing: -0.06em;
      max-width: 780px;
    }
    .gradient {
      background: linear-gradient(90deg, var(--accent-blue) 0%, var(--accent) 45%, var(--accent-pink) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .hero-copy {
      margin: 0;
      max-width: 760px;
      color: var(--muted);
      font-size: 17px;
      line-height: 1.65;
    }
    .hero-narrative {
      margin-top: 14px;
      color: #ddd6fe;
      font-size: 15px;
      font-weight: 600;
      letter-spacing: -0.02em;
    }
    .glass-card {
      position: relative;
      overflow: hidden;
      border: 1px solid var(--border);
      background: linear-gradient(180deg, rgba(18,18,24,0.94), rgba(10,10,14,0.92));
      backdrop-filter: blur(18px);
      box-shadow: 0 20px 48px rgba(0,0,0,0.32), inset 0 1px 0 rgba(255,255,255,0.03);
    }
    .glass-card::before {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: linear-gradient(135deg, rgba(255,255,255,0.04), transparent 40%, transparent);
    }
    .overview-grid {
      display: grid;
      grid-template-columns: minmax(360px, 1.05fr) minmax(0, 1.45fr);
      gap: 22px;
      align-items: stretch;
    }
    .health-card {
      padding: 22px;
      display: grid;
      gap: 18px;
      min-height: 280px;
    }
    .card-title {
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -0.04em;
    }
    .card-subtle {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.55;
    }
    .health-top {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 16px;
    }
    .health-value {
      font-size: clamp(28px, 3vw, 42px);
      font-weight: 800;
      letter-spacing: -0.05em;
    }
    .health-meta {
      margin-top: 6px;
      color: var(--muted);
      font-size: 14px;
    }
    .health-track {
      position: relative;
      height: 14px;
      border-radius: 999px;
      overflow: hidden;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.06);
    }
    .health-zones {
      position: absolute;
      inset: 0;
      background:
        linear-gradient(90deg, rgba(34,197,94,0.4) 0%, rgba(34,197,94,0.24) 68%, rgba(245,158,11,0.26) 84%, rgba(251,113,133,0.34) 100%);
    }
    .health-progress {
      position: absolute;
      inset: 2px auto 2px 2px;
      width: 0%;
      border-radius: 999px;
      background: linear-gradient(90deg, var(--accent-blue) 0%, var(--accent) 48%, var(--accent-pink) 100%);
      box-shadow: 0 0 18px rgba(167,139,250,0.4);
      transition: width 360ms ease;
    }
    .health-markers {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      color: var(--muted-soft);
      font: 500 11px ui-monospace, SFMono-Regular, Menlo, monospace;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .health-insights {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .health-pill {
      border: 1px solid rgba(255,255,255,0.06);
      background: rgba(255,255,255,0.03);
      padding: 14px;
    }
    .pill-label {
      color: var(--muted-soft);
      font: 500 11px ui-monospace, SFMono-Regular, Menlo, monospace;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .pill-value {
      margin-top: 8px;
      font-size: 24px;
      font-weight: 700;
      letter-spacing: -0.04em;
    }
    .health-footer {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      color: var(--muted);
      font-size: 13px;
    }
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 14px;
    }
    .metric-card {
      padding: 18px;
      min-height: 146px;
      display: grid;
      gap: 14px;
    }
    .metric-top {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 12px;
    }
    .metric-label {
      color: var(--muted-soft);
      font: 600 11px ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .metric-trend {
      min-width: 26px;
      height: 26px;
      display: inline-grid;
      place-items: center;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.07);
      background: rgba(255,255,255,0.03);
      color: var(--muted);
      font-size: 13px;
    }
    .metric-value {
      font-size: clamp(28px, 2.9vw, 40px);
      line-height: 0.96;
      font-weight: 800;
      letter-spacing: -0.05em;
    }
    .metric-meta {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
    }
    .trend-up .metric-trend,
    .metric-meta.trend-up { color: #f9a8d4; border-color: rgba(236,72,153,0.24); background: rgba(236,72,153,0.08); }
    .trend-down .metric-trend,
    .metric-meta.trend-down { color: #67e8f9; border-color: rgba(6,182,212,0.24); background: rgba(6,182,212,0.08); }
    .trend-flat .metric-trend,
    .metric-meta.trend-flat { color: var(--muted); }
    .filters {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin: 22px 0 18px;
    }
    .filter {
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.02);
      color: var(--muted);
      padding: 10px 14px;
      font: 600 12px ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: 0.04em;
      cursor: pointer;
      transition: transform 160ms ease, border-color 160ms ease, background 160ms ease;
    }
    .filter:hover { transform: translateY(-1px); border-color: rgba(167, 139, 250, 0.24); }
    .filter.active {
      color: var(--text);
      border-color: rgba(167, 139, 250, 0.42);
      background: linear-gradient(135deg, rgba(139,92,246,0.2), rgba(167,139,250,0.14));
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.03);
    }
    .panel {
      padding: 20px;
    }
    .panel-header {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 18px;
    }
    .panel-title {
      margin: 0;
      font-size: 24px;
      letter-spacing: -0.04em;
    }
    .panel-copy {
      margin-top: 6px;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.55;
    }
    .legend {
      display: inline-flex;
      align-items: center;
      gap: 14px;
      color: var(--muted);
      font: 500 12px ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .legend-item { display: inline-flex; align-items: center; gap: 6px; }
    .swatch { width: 14px; height: 3px; display: inline-block; border-radius: 999px; }
    .chart-stage {
      position: relative;
      border: 1px solid rgba(255,255,255,0.05);
      background: linear-gradient(180deg, rgba(10,10,14,0.78), rgba(8,8,12,0.96));
      min-height: 360px;
      overflow: hidden;
    }
    .chart-stage svg {
      width: 100%;
      height: 360px;
      display: block;
      overflow: visible;
    }
    .chart-tooltip {
      position: absolute;
      z-index: 2;
      min-width: 148px;
      padding: 10px 12px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(8,8,12,0.94);
      color: var(--text);
      box-shadow: 0 18px 36px rgba(0,0,0,0.42);
      pointer-events: none;
      transform: translate(-50%, calc(-100% - 14px));
    }
    .tooltip-time {
      color: var(--muted);
      font: 500 11px ui-monospace, SFMono-Regular, Menlo, monospace;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .tooltip-value {
      margin-top: 6px;
      font-size: 18px;
      font-weight: 700;
      letter-spacing: -0.03em;
    }
    .events-table {
      display: grid;
      gap: 10px;
    }
    .event-head,
    .event-row {
      display: grid;
      grid-template-columns: 120px minmax(150px, 1.1fr) minmax(180px, 1fr) 120px 120px;
      gap: 12px;
      align-items: center;
    }
    .event-head {
      padding: 0 12px 8px;
      color: var(--muted-soft);
      font: 600 11px ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .event-row {
      padding: 14px 12px;
      border: 1px solid rgba(255,255,255,0.05);
      background: linear-gradient(180deg, rgba(16,16,22,0.8), rgba(10,10,14,0.82));
      color: var(--text);
    }
    .event-row:hover {
      border-color: rgba(167, 139, 250, 0.18);
      background: linear-gradient(180deg, rgba(22,18,30,0.88), rgba(10,10,14,0.9));
    }
    .event-type { font-weight: 600; }
    .event-model { color: #ddd6fe; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .event-muted { color: var(--muted); }
    .event-cost { text-align: right; color: #f9a8d4; font-weight: 700; }
    .empty {
      color: var(--muted);
      padding: 22px 4px 4px;
      font-size: 14px;
    }
    .error {
      margin-top: 12px;
      color: #fca5a5;
      font-size: 14px;
    }
    @keyframes pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(236, 72, 153, 0.55); }
      50% { box-shadow: 0 0 0 8px rgba(236, 72, 153, 0); }
    }
    @media (max-width: 1120px) {
      .hero,
      .overview-grid { grid-template-columns: 1fr; }
      .kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 820px) {
      .shell { padding: 18px; }
      .kpi-grid,
      .health-insights { grid-template-columns: 1fr; }
      .event-head { display: none; }
      .event-row {
        grid-template-columns: 1fr;
        gap: 6px;
      }
      .event-cost { text-align: left; }
      .chart-stage { min-height: 320px; }
      .chart-stage svg { height: 320px; }
    }
    @media (max-width: 640px) {
      .shell { padding: 16px; }
      .hero { padding: 20px 0 14px; }
      .filters { gap: 8px; }
      .filter { width: calc(50% - 4px); }
      .health-card,
      .metric-card,
      .panel { padding: 16px; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="nav">
      <div class="brand">Agent<span>Budget</span></div>
      <div class="live-badge"><span class="live-dot"></span> live dashboard</div>
    </div>

    <section class="hero">
      <div>
        <div class="eyebrow" id="eyebrow">session timeline</div>
        <h1><span class="gradient">BUDGET HEALTH</span><br /><span class="gradient">WITH LIVE</span><br /><span style="color: var(--muted);">SPEND CLARITY</span></h1>
        <p class="hero-copy">Track burn rate, understand why spend moved, and see how quickly the current session is approaching its budget limit.</p>
        <div class="hero-narrative" id="heroNarrative">Session is currently at 0.00% of budget.</div>
        <p class="error" id="error" hidden></p>
      </div>

      <section class="glass-card health-card">
        <div class="health-top">
          <div>
            <div class="card-title">Budget health</div>
            <div class="card-subtle" id="healthStatus">Waiting for tracked data.</div>
          </div>
          <div class="live-badge" style="padding: 6px 10px;"><span class="live-dot"></span> live</div>
        </div>
        <div>
          <div class="health-value" id="healthValue">$0.000000 / $0.000000</div>
          <div class="health-meta" id="healthMeta">Projected remaining budget updates every 2 seconds.</div>
        </div>
        <div class="health-track">
          <div class="health-zones"></div>
          <div class="health-progress" id="healthProgress"></div>
        </div>
        <div class="health-markers">
          <span>safe</span>
          <span>watch</span>
          <span>danger</span>
        </div>
        <div class="health-insights">
          <div class="health-pill">
            <div class="pill-label">Burn rate</div>
            <div class="pill-value" id="healthBurnRate">$0.000000 / min</div>
          </div>
          <div class="health-pill">
            <div class="pill-label">Budget exhausted in</div>
            <div class="pill-value" id="healthExhaustion">No active burn</div>
          </div>
        </div>
        <div class="health-footer">
          <span id="healthFooterLeft">0 tracked events</span>
          <span id="healthFooterRight">Updated --</span>
        </div>
      </section>
    </section>

    <section class="overview-grid">
      <section class="glass-card panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">Spend progression</h2>
            <div class="panel-copy">Cost movement over the selected horizon, with projected trend and budget risk zone.</div>
          </div>
          <div class="legend">
            <span class="legend-item"><span class="swatch" style="background: linear-gradient(90deg, #06b6d4, #ec4899);"></span> spend</span>
            <span class="legend-item"><span class="swatch" style="background: rgba(167,139,250,0.9);"></span> projected</span>
            <span class="legend-item"><span class="swatch" style="background: rgba(245,158,11,0.95);"></span> budget zone</span>
          </div>
        </div>
        <div class="filters" id="filters"></div>
        <div class="chart-stage" id="chartStage">
          <div class="chart-tooltip" id="chartTooltip" hidden>
            <div class="tooltip-time" id="tooltipTime">--</div>
            <div class="tooltip-value" id="tooltipValue">$0.000000</div>
          </div>
          <div id="chartMount"></div>
        </div>
      </section>

      <section class="kpi-grid" id="kpiGrid">
        <article class="glass-card metric-card" id="metric-spent">
          <div class="metric-top"><div class="metric-label">Total spent</div><div class="metric-trend" id="metric-spent-arrow">→</div></div>
          <div class="metric-value" id="metric-spent-value">$0.000000</div>
          <div class="metric-meta" id="metric-spent-meta">No change in last 5 min</div>
        </article>
        <article class="glass-card metric-card" id="metric-remaining">
          <div class="metric-top"><div class="metric-label">Remaining budget</div><div class="metric-trend" id="metric-remaining-arrow">→</div></div>
          <div class="metric-value" id="metric-remaining-value">$0.000000</div>
          <div class="metric-meta" id="metric-remaining-meta">No change in last 5 min</div>
        </article>
        <article class="glass-card metric-card" id="metric-burn">
          <div class="metric-top"><div class="metric-label">Burn rate</div><div class="metric-trend" id="metric-burn-arrow">→</div></div>
          <div class="metric-value" id="metric-burn-value">$0.000000 / min</div>
          <div class="metric-meta" id="metric-burn-meta">No active burn</div>
        </article>
        <article class="glass-card metric-card" id="metric-exhaustion">
          <div class="metric-top"><div class="metric-label">Budget exhausted in</div><div class="metric-trend" id="metric-exhaustion-arrow">→</div></div>
          <div class="metric-value" id="metric-exhaustion-value">No active burn</div>
          <div class="metric-meta" id="metric-exhaustion-meta">Waiting for burn rate signal</div>
        </article>
        <article class="glass-card metric-card" id="metric-messages">
          <div class="metric-top"><div class="metric-label">Messages count</div><div class="metric-trend" id="metric-messages-arrow">→</div></div>
          <div class="metric-value" id="metric-messages-value">0</div>
          <div class="metric-meta" id="metric-messages-meta">No new messages in last 5 min</div>
        </article>
        <article class="glass-card metric-card" id="metric-tokens">
          <div class="metric-top"><div class="metric-label">Total tokens</div><div class="metric-trend" id="metric-tokens-arrow">→</div></div>
          <div class="metric-value" id="metric-tokens-value">0</div>
          <div class="metric-meta" id="metric-tokens-meta">No new tokens in last 5 min</div>
        </article>
      </section>
    </section>

    <section class="glass-card panel" style="margin-top: 22px;">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">Recent spend events</h2>
          <div class="panel-copy">A quick narrative of why spend moved in this session.</div>
        </div>
      </div>
      <div class="event-head">
        <div>Time</div>
        <div>Event type</div>
        <div>Model</div>
        <div>Tokens</div>
        <div style="text-align: right;">Cost delta</div>
      </div>
      <div class="events-table" id="eventsTable"></div>
      <div class="empty" id="eventsEmpty" hidden>No spend events yet for this session.</div>
    </section>
  </div>

  <script>
    const PERIODS = [
      { value: 60, label: 'Last minute' },
      { value: 180, label: 'Last 3 minutes' },
      { value: 300, label: 'Last 5 minutes' },
      { value: 600, label: 'Last 10 minutes' },
      { value: 1800, label: 'Last 30 minutes' },
      { value: 3600, label: 'Last hour' },
      { value: 21600, label: 'Last 6 hours' }
    ];
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('sessionId');
    let activePeriod = 600;
    let refreshHandle = null;
    let currentSession = null;
    let currentTimeline = null;

    function money(value) {
      return '$' + Number(value || 0).toFixed(6);
    }

    function formatInteger(value) {
      return Number(value || 0).toLocaleString();
    }

    function timeLabel(seconds) {
      if (!seconds) return '--';
      return new Date(seconds * 1000).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    }

    function timestampLabel(timestampMs) {
      return new Date(timestampMs).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
      });
    }

    function formatDurationMinutes(minutes) {
      if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return 'No active burn';
      if (minutes < 1) return '<1m';
      if (minutes < 60) return '~' + Math.round(minutes) + 'm';
      const hours = Math.floor(minutes / 60);
      const remainder = Math.round(minutes % 60);
      if (hours < 24) return '~' + hours + 'h ' + remainder + 'm';
      const days = Math.floor(hours / 24);
      const dayHours = hours % 24;
      return '~' + days + 'd ' + dayHours + 'h';
    }

    function showError(message) {
      const el = document.getElementById('error');
      el.hidden = false;
      el.textContent = message;
    }

    function clearError() {
      const el = document.getElementById('error');
      el.hidden = true;
      el.textContent = '';
    }

    function escapeHtml(value) {
      return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    function buildFilters() {
      const root = document.getElementById('filters');
      root.innerHTML = '';
      for (const option of PERIODS) {
        const button = document.createElement('button');
        button.className = 'filter' + (option.value === activePeriod ? ' active' : '');
        button.textContent = option.label;
        button.onclick = () => {
          activePeriod = option.value;
          buildFilters();
          refresh();
        };
        root.appendChild(button);
      }
    }

    function applyTrend(cardId, arrowId, metaId, direction, message) {
      const card = document.getElementById(cardId);
      const arrow = document.getElementById(arrowId);
      const meta = document.getElementById(metaId);
      card.classList.remove('trend-up', 'trend-down', 'trend-flat');
      meta.classList.remove('trend-up', 'trend-down', 'trend-flat');
      const className = 'trend-' + direction;
      card.classList.add(className);
      meta.classList.add(className);
      arrow.textContent = direction === 'up' ? '↑' : direction === 'down' ? '↓' : '→';
      meta.textContent = message;
    }

    function compareDirection(current, previous) {
      const epsilon = 0.000001;
      if (current > previous + epsilon) return 'up';
      if (current < previous - epsilon) return 'down';
      return 'flat';
    }

    function compareMinutes(current, previous) {
      if (current === null && previous === null) return 'flat';
      if (current === null && previous !== null) return 'down';
      if (current !== null && previous === null) return 'up';
      if (current < previous) return 'up';
      if (current > previous) return 'down';
      return 'flat';
    }

    function setMetricValue(id, value) {
      document.getElementById(id).textContent = value;
    }

    function updateOverview(session) {
      currentSession = session;

      document.getElementById('eyebrow').textContent = 'session ' + session.session_id;
      document.getElementById('heroNarrative').textContent =
        'Session is currently at ' + Number(session.session_percent || 0).toFixed(2) + '% of budget.';

      document.getElementById('healthValue').textContent =
        money(session.total_spent) + ' / ' + money(session.budget);
      document.getElementById('healthMeta').textContent =
        money(session.remaining) + ' remaining before the hard budget limit.';
      document.getElementById('healthStatus').textContent =
        session.status === 'closed'
          ? 'Session closed. Final spend locked.'
          : 'Live refresh every 2 seconds. Burn rate is based on the last 5 minutes.';
      document.getElementById('healthBurnRate').textContent =
        money(session.burn_rate_per_min) + ' / min';
      document.getElementById('healthExhaustion').textContent =
        formatDurationMinutes(session.projected_exhaustion_minutes);
      document.getElementById('healthFooterLeft').textContent =
        formatInteger(session.event_count || 0) + ' tracked events';
      document.getElementById('healthFooterRight').textContent =
        'Updated ' + timeLabel(session.updated_at);
      document.getElementById('healthProgress').style.width =
        Math.max(0, Math.min(Number(session.session_percent || 0), 100)).toFixed(2) + '%';

      setMetricValue('metric-spent-value', money(session.total_spent));
      applyTrend(
        'metric-spent',
        'metric-spent-arrow',
        'metric-spent-meta',
        compareDirection(session.last_5m_cost, session.previous_5m_cost),
        '+' + money(session.last_5m_cost).replace('$', '') + ' in last 5 min'
      );

      setMetricValue('metric-remaining-value', money(session.remaining));
      applyTrend(
        'metric-remaining',
        'metric-remaining-arrow',
        'metric-remaining-meta',
        compareDirection(session.last_5m_cost, session.previous_5m_cost),
        '-' + money(session.last_5m_cost).replace('$', '') + ' in last 5 min'
      );

      setMetricValue('metric-burn-value', money(session.burn_rate_per_min) + ' / min');
      applyTrend(
        'metric-burn',
        'metric-burn-arrow',
        'metric-burn-meta',
        compareDirection(session.burn_rate_per_min, session.previous_burn_rate_per_min),
        money(Math.abs((session.burn_rate_per_min || 0) - (session.previous_burn_rate_per_min || 0))) +
          ' vs prev 5 min'
      );

      setMetricValue(
        'metric-exhaustion-value',
        formatDurationMinutes(session.projected_exhaustion_minutes)
      );
      const exhaustionDirection = compareMinutes(
        session.projected_exhaustion_minutes,
        session.previous_projected_exhaustion_minutes
      );
      let exhaustionMeta = 'Waiting for burn rate signal';
      if (
        session.projected_exhaustion_minutes !== null &&
        session.previous_projected_exhaustion_minutes !== null
      ) {
        const diff = Math.abs(
          session.projected_exhaustion_minutes - session.previous_projected_exhaustion_minutes
        );
        exhaustionMeta =
          formatDurationMinutes(diff) +
          (session.projected_exhaustion_minutes < session.previous_projected_exhaustion_minutes
            ? ' sooner vs prev 5 min'
            : ' later vs prev 5 min');
      } else if (session.projected_exhaustion_minutes !== null) {
        exhaustionMeta = 'Projection now available from recent burn';
      }
      applyTrend(
        'metric-exhaustion',
        'metric-exhaustion-arrow',
        'metric-exhaustion-meta',
        exhaustionDirection,
        exhaustionMeta
      );

      setMetricValue('metric-messages-value', formatInteger(session.messages_count));
      applyTrend(
        'metric-messages',
        'metric-messages-arrow',
        'metric-messages-meta',
        compareDirection(session.last_5m_messages, session.previous_5m_messages),
        '+' + formatInteger(session.last_5m_messages) + ' in last 5 min'
      );

      setMetricValue('metric-tokens-value', formatInteger(session.total_tokens));
      applyTrend(
        'metric-tokens',
        'metric-tokens-arrow',
        'metric-tokens-meta',
        compareDirection(session.last_5m_tokens, session.previous_5m_tokens),
        '+' + formatInteger(session.last_5m_tokens) + ' in last 5 min'
      );

      renderRecentEvents(session.recent_events || []);
    }

    function renderRecentEvents(events) {
      const root = document.getElementById('eventsTable');
      const empty = document.getElementById('eventsEmpty');
      root.innerHTML = '';
      if (!events.length) {
        empty.hidden = false;
        return;
      }
      empty.hidden = true;
      for (const event of events) {
        const row = document.createElement('div');
        row.className = 'event-row';
        row.innerHTML =
          '<div class="event-muted">' + escapeHtml(timestampLabel(event.timestamp_ms)) + '</div>' +
          '<div class="event-type">' + escapeHtml(event.event_type_label) + '</div>' +
          '<div class="event-model">' + escapeHtml(event.model_label) + '</div>' +
          '<div class="event-muted">' + escapeHtml(formatInteger(event.tokens)) + ' tokens</div>' +
          '<div class="event-cost">+' + escapeHtml(money(event.cost_delta).replace('$', '$')) + '</div>';
        root.appendChild(row);
      }
    }

    function buildProjectionPoints(session, timeline) {
      if (!session || !timeline || !session.burn_rate_per_min || session.burn_rate_per_min <= 0 || session.remaining <= 0) {
        return [];
      }
      const nowMs = Number(timeline.generated_at_ms || Date.now());
      const currentSpend = Number(session.total_spent || 0);
      const maxProjectionMs = nowMs + Math.max(timeline.period_seconds * 1000 * 0.55, 5 * 60 * 1000);
      const exhaustionAtMs = nowMs + (session.remaining / session.burn_rate_per_min) * 60 * 1000;
      const projectionEndMs = Math.min(exhaustionAtMs, maxProjectionMs);
      const projectedValue =
        currentSpend + session.burn_rate_per_min * ((projectionEndMs - nowMs) / (60 * 1000));
      return [
        { timestamp_ms: nowMs, value: currentSpend },
        { timestamp_ms: projectionEndMs, value: Math.min(projectedValue, session.budget) }
      ];
    }

    function smoothPath(points, xScale, yScale) {
      if (!points.length) return '';
      const coords = points.map(function(point) {
        return { x: xScale(point.timestamp_ms), y: yScale(point.value) };
      });
      let path = 'M ' + coords[0].x.toFixed(2) + ' ' + coords[0].y.toFixed(2);
      for (let index = 0; index < coords.length - 1; index += 1) {
        const current = coords[index];
        const next = coords[index + 1];
        const midX = (current.x + next.x) / 2;
        path +=
          ' C ' + midX.toFixed(2) + ' ' + current.y.toFixed(2) +
          ', ' + midX.toFixed(2) + ' ' + next.y.toFixed(2) +
          ', ' + next.x.toFixed(2) + ' ' + next.y.toFixed(2);
      }
      return path;
    }

    function areaPath(points, xScale, yScale, baselineY) {
      if (!points.length) return '';
      const line = smoothPath(points, xScale, yScale);
      const lastX = xScale(points[points.length - 1].timestamp_ms).toFixed(2);
      const firstX = xScale(points[0].timestamp_ms).toFixed(2);
      return line + ' L ' + lastX + ' ' + baselineY.toFixed(2) + ' L ' + firstX + ' ' + baselineY.toFixed(2) + ' Z';
    }

    function renderMainChart(session, timeline) {
      currentTimeline = timeline;
      const mount = document.getElementById('chartMount');
      const tooltip = document.getElementById('chartTooltip');
      const tooltipTime = document.getElementById('tooltipTime');
      const tooltipValue = document.getElementById('tooltipValue');
      mount.innerHTML = '';

      const actualPoints = timeline && timeline.spend_points && timeline.spend_points.length
        ? timeline.spend_points
        : [
            { timestamp_ms: Date.now() - activePeriod * 1000, value: Number(session.total_spent || 0) },
            { timestamp_ms: Date.now(), value: Number(session.total_spent || 0) }
          ];
      const projectionPoints = buildProjectionPoints(session, timeline);

      const width = 940;
      const height = 360;
      const padding = { top: 18, right: 18, bottom: 28, left: 18 };
      const minX = Number(timeline.window_start_ms || actualPoints[0].timestamp_ms);
      const maxX = Math.max(
        Number(timeline.generated_at_ms || Date.now()),
        actualPoints[actualPoints.length - 1].timestamp_ms,
        projectionPoints[projectionPoints.length - 1] ? projectionPoints[projectionPoints.length - 1].timestamp_ms : 0,
        minX + 1
      );
      const maxY = Math.max(
        Number(session.budget || 0),
        ...actualPoints.map(function(point) { return Number(point.value || 0); }),
        ...projectionPoints.map(function(point) { return Number(point.value || 0); }),
        0.000001
      ) * 1.05;
      const rangeX = maxX - minX;

      function xScale(value) {
        return padding.left + ((value - minX) / rangeX) * (width - padding.left - padding.right);
      }

      function yScale(value) {
        return height - padding.bottom - (value / maxY) * (height - padding.top - padding.bottom);
      }

      const actualPath = smoothPath(actualPoints, xScale, yScale);
      const area = areaPath(actualPoints, xScale, yScale, height - padding.bottom);
      const projectionPath = projectionPoints.length > 1 ? smoothPath(projectionPoints, xScale, yScale) : '';
      const alertStartValue = Number(session.budget || 0) * 0.85;
      const alertTop = yScale(Number(session.budget || 0));
      const alertBottom = yScale(alertStartValue);
      const grid = [0.2, 0.4, 0.6, 0.8, 1].map(function(ratio) {
        const y = yScale(maxY * ratio).toFixed(2);
        return '<line x1="' + padding.left + '" y1="' + y + '" x2="' + (width - padding.right) + '" y2="' + y + '" stroke="rgba(255,255,255,0.07)" stroke-width="1" />';
      }).join('');

      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
      svg.innerHTML =
        '<defs>' +
          '<linearGradient id="chart-line-gradient" x1="0%" y1="0%" x2="100%" y2="0%">' +
            '<stop offset="0%" stop-color="#06b6d4"></stop>' +
            '<stop offset="50%" stop-color="#8b5cf6"></stop>' +
            '<stop offset="100%" stop-color="#ec4899"></stop>' +
          '</linearGradient>' +
          '<linearGradient id="chart-area-gradient" x1="0%" y1="0%" x2="0%" y2="100%">' +
            '<stop offset="0%" stop-color="rgba(167,139,250,0.34)"></stop>' +
            '<stop offset="100%" stop-color="rgba(167,139,250,0)"></stop>' +
          '</linearGradient>' +
          '<linearGradient id="budget-zone-gradient" x1="0%" y1="0%" x2="0%" y2="100%">' +
            '<stop offset="0%" stop-color="rgba(251,113,133,0.2)"></stop>' +
            '<stop offset="100%" stop-color="rgba(245,158,11,0.05)"></stop>' +
          '</linearGradient>' +
          '<filter id="line-glow" x="-30%" y="-30%" width="160%" height="160%">' +
            '<feGaussianBlur stdDeviation="6" result="blur"></feGaussianBlur>' +
            '<feMerge><feMergeNode in="blur"></feMergeNode><feMergeNode in="SourceGraphic"></feMergeNode></feMerge>' +
          '</filter>' +
        '</defs>' +
        '<rect x="' + padding.left + '" y="' + alertTop.toFixed(2) + '" width="' + (width - padding.left - padding.right) + '" height="' + Math.max(alertBottom - alertTop, 0).toFixed(2) + '" fill="url(#budget-zone-gradient)" />' +
        grid +
        '<path d="' + area + '" fill="url(#chart-area-gradient)"></path>' +
        '<line x1="' + padding.left + '" y1="' + yScale(Number(session.budget || 0)).toFixed(2) + '" x2="' + (width - padding.right) + '" y2="' + yScale(Number(session.budget || 0)).toFixed(2) + '" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="8 8" />' +
        (projectionPath
          ? '<path d="' + projectionPath + '" fill="none" stroke="rgba(167,139,250,0.9)" stroke-width="2.2" stroke-linecap="round" stroke-dasharray="7 7" />'
          : '') +
        '<path d="' + actualPath + '" fill="none" stroke="url(#chart-line-gradient)" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" filter="url(#line-glow)" />' +
        '<g id="hoverLayer"></g>';
      mount.appendChild(svg);

      const hoverLayer = svg.querySelector('#hoverLayer');

      function hideTooltip() {
        tooltip.hidden = true;
        hoverLayer.innerHTML = '';
      }

      function handleMove(event) {
        const bounds = svg.getBoundingClientRect();
        const ratio = width / bounds.width;
        const localX = (event.clientX - bounds.left) * ratio;
        let nearest = actualPoints[0];
        let nearestDistance = Math.abs(xScale(actualPoints[0].timestamp_ms) - localX);

        for (const point of actualPoints) {
          const distance = Math.abs(xScale(point.timestamp_ms) - localX);
          if (distance < nearestDistance) {
            nearest = point;
            nearestDistance = distance;
          }
        }

        const cx = xScale(nearest.timestamp_ms);
        const cy = yScale(nearest.value);
        hoverLayer.innerHTML =
          '<line x1="' + cx.toFixed(2) + '" y1="' + padding.top + '" x2="' + cx.toFixed(2) + '" y2="' + (height - padding.bottom) + '" stroke="rgba(255,255,255,0.16)" stroke-width="1" stroke-dasharray="4 6" />' +
          '<circle cx="' + cx.toFixed(2) + '" cy="' + cy.toFixed(2) + '" r="5" fill="#0a0a0e" stroke="#fafafa" stroke-width="2" />' +
          '<circle cx="' + cx.toFixed(2) + '" cy="' + cy.toFixed(2) + '" r="8" fill="rgba(167,139,250,0.18)" />';

        tooltip.hidden = false;
        tooltip.style.left = ((cx / width) * 100).toFixed(2) + '%';
        tooltip.style.top = ((cy / height) * 100).toFixed(2) + '%';
        tooltipTime.textContent = new Date(nearest.timestamp_ms).toLocaleString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          month: 'short',
          day: 'numeric'
        });
        tooltipValue.textContent = money(nearest.value);
      }

      svg.addEventListener('mousemove', handleMove);
      svg.addEventListener('mouseleave', hideTooltip);
    }

    async function refresh() {
      if (!sessionId) {
        showError('Missing sessionId in the URL.');
        return;
      }

      try {
        const [sessionResp, timelineResp] = await Promise.all([
          fetch('/api/dashboard/session?sessionId=' + encodeURIComponent(sessionId), { cache: 'no-store' }),
          fetch('/api/dashboard/timeline?sessionId=' + encodeURIComponent(sessionId) + '&period=' + activePeriod, { cache: 'no-store' })
        ]);

        if (!sessionResp.ok || !timelineResp.ok) {
          throw new Error('Could not load session data.');
        }

        const session = await sessionResp.json();
        const timeline = await timelineResp.json();
        clearError();
        updateOverview(session);
        renderMainChart(session, timeline);
      } catch (error) {
        showError(error instanceof Error ? error.message : String(error));
      }
    }

    buildFilters();
    refresh();
    refreshHandle = window.setInterval(refresh, 2000);
    window.addEventListener('beforeunload', function() {
      if (refreshHandle !== null) {
        window.clearInterval(refreshHandle);
      }
    });
  </script>
</body>
</html>`;
