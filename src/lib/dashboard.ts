import type { IncomingMessage, ServerResponse } from "node:http";

import { aggregateTimeline, type TimelineStore } from "./timeline.js";

const PERIOD_ALIASES: Record<string, number> = {
  "3600": 3600,
  "10800": 10800,
  "21600": 21600,
  "43200": 43200,
  "86400": 86400,
  "172800": 172800,
  last_hour: 3600,
  last_3_hours: 10800,
  last_6_hours: 21600,
  last_12_hours: 43200,
  last_24_hours: 86400,
  last_2_days: 172800,
  "1h": 3600,
  "3h": 10800,
  "6h": 21600,
  "12h": 43200,
  "24h": 86400,
  "2d": 172800,
};

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
    writeJson(response, 200, session);
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
    writeJson(response, 200, aggregateTimeline(session, events, period, nowMs));
    return true;
  }

  return false;
}

function resolvePeriod(rawPeriod: string | null): number | null {
  const value = rawPeriod?.trim().toLowerCase() ?? "3600";
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

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AgentBudget Dashboard</title>
  <style>
    :root { --bg: #09090b; --border: #1c1c22; --border-bright: #2a2a32; --text: #fafafa; --muted: #a1a1aa; --muted-soft: #71717a; --accent: #8b5cf6; --accent-bright: #a78bfa; --accent-pink: #ec4899; --accent-blue: #06b6d4; --warn: #f59e0b; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; color: var(--text); background: radial-gradient(circle at top left, rgba(139, 92, 246, 0.18), transparent 32%), radial-gradient(circle at top right, rgba(6, 182, 212, 0.12), transparent 26%), linear-gradient(180deg, #0b0b0f 0%, #07070a 100%); font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body::after { content: ""; position: fixed; inset: 0; pointer-events: none; opacity: 0.04; background-image: radial-gradient(rgba(255,255,255,0.5) 0.6px, transparent 0.6px); background-size: 8px 8px; }
    .shell { max-width: 1280px; margin: 0 auto; padding: 24px; }
    .nav { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 0 18px; border-bottom: 1px solid var(--border); }
    .brand { font-size: 28px; font-weight: 800; letter-spacing: -0.04em; }
    .brand span { color: var(--accent-bright); }
    .version { display: inline-flex; align-items: center; gap: 8px; padding: 6px 10px; border: 1px solid rgba(139, 92, 246, 0.24); background: rgba(139, 92, 246, 0.1); color: var(--accent-bright); font: 500 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .pulse { width: 8px; height: 8px; border-radius: 999px; background: var(--accent); box-shadow: 0 0 0 0 rgba(139, 92, 246, 0.55); animation: pulse 1.8s ease-in-out infinite; }
    .hero { display: grid; grid-template-columns: 1.4fr 1fr; gap: 24px; padding: 34px 0 26px; border-bottom: 1px solid var(--border); }
    .eyebrow { display: inline-flex; align-items: center; gap: 10px; padding: 7px 12px; border: 1px solid rgba(139, 92, 246, 0.2); background: rgba(139, 92, 246, 0.06); color: var(--muted); font: 500 12px ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; letter-spacing: 0.12em; }
    h1 { margin: 18px 0 14px; font-size: clamp(42px, 7vw, 74px); line-height: 0.96; letter-spacing: -0.06em; }
    .gradient { background: linear-gradient(90deg, var(--accent-blue) 0%, var(--accent) 42%, var(--accent-pink) 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
    .subtle { color: var(--muted); max-width: 720px; margin: 0; font-size: 17px; line-height: 1.7; }
    .summary { display: grid; gap: 12px; grid-template-columns: repeat(2, minmax(0, 1fr)); align-content: start; }
    .card { border: 1px solid var(--border); background: linear-gradient(180deg, rgba(17,17,20,0.94), rgba(13,13,17,0.92)); padding: 18px; }
    .label { color: var(--muted-soft); font: 500 11px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.12em; text-transform: uppercase; }
    .value { margin-top: 12px; font-size: 34px; font-weight: 700; letter-spacing: -0.05em; }
    .meta { margin-top: 8px; color: var(--muted); font-size: 13px; }
    .filters { display: flex; flex-wrap: wrap; gap: 10px; margin: 26px 0 22px; }
    .filter { border: 1px solid var(--border-bright); background: transparent; color: var(--muted); padding: 10px 14px; font: 500 12px ui-monospace, SFMono-Regular, Menlo, monospace; cursor: pointer; }
    .filter.active { background: linear-gradient(135deg, rgba(139,92,246,0.18), rgba(167,139,250,0.18)); color: var(--text); border-color: rgba(167, 139, 250, 0.42); }
    .sections { display: grid; gap: 24px; }
    .section { border: 1px solid var(--border); background: rgba(9, 9, 11, 0.76); }
    .section-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 20px 20px 0; }
    .section-title { margin: 0; font-size: 28px; letter-spacing: -0.04em; }
    .section-copy { margin: 6px 0 0; color: var(--muted); font-size: 14px; }
    .grid { display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); padding: 20px; }
    .chart-card { border: 1px solid var(--border); background: rgba(17, 17, 20, 0.78); padding: 16px; min-height: 280px; }
    .chart-top { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 14px; }
    .chart-name { font-size: 18px; font-weight: 700; letter-spacing: -0.03em; }
    .chart-spend { color: var(--accent-bright); font: 600 14px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .chart-meta { display: flex; justify-content: space-between; color: var(--muted-soft); font: 500 11px ui-monospace, SFMono-Regular, Menlo, monospace; margin-top: 8px; }
    .legend { display: inline-flex; align-items: center; gap: 16px; color: var(--muted); font: 500 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .legend-item { display: inline-flex; align-items: center; gap: 6px; }
    .swatch { width: 14px; height: 2px; display: inline-block; }
    svg { width: 100%; height: 180px; display: block; overflow: visible; }
    .empty { color: var(--muted); padding: 16px 20px 20px; }
    .error { color: #fca5a5; margin-top: 12px; font-size: 14px; }
    @keyframes pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(139, 92, 246, 0.55); } 50% { box-shadow: 0 0 0 6px rgba(139, 92, 246, 0); } }
    @media (max-width: 920px) { .hero { grid-template-columns: 1fr; } .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (max-width: 640px) { .shell { padding: 16px; } .summary { grid-template-columns: 1fr; } .section-header { display: block; } }
  </style>
</head>
<body>
  <div class="shell">
    <div class="nav"><div class="brand">Agent<span>Budget</span></div><div class="version"><span class="pulse"></span> live dashboard</div></div>
    <section class="hero">
      <div>
        <div class="eyebrow" id="eyebrow">timeline dashboard</div>
        <h1><span class="gradient">REAL-TIME</span><br /><span class="gradient">SPEND PROGRESS</span><br /><span style="color: var(--muted);">FOR THIS SESSION</span></h1>
        <p class="subtle">Budget consumption streamed from the tracked session timeline. Filter the time horizon and compare cumulative spend against the hard budget limit in real time.</p>
        <p class="error" id="error" hidden></p>
      </div>
      <div class="summary">
        <div class="card"><div class="label">total spent</div><div class="value" id="total-spent">$0.000000</div><div class="meta" id="session-status">waiting for tracked data</div></div>
        <div class="card"><div class="label">remaining</div><div class="value" id="remaining">$0.000000</div><div class="meta" id="budget-limit">budget limit $0.000000</div></div>
        <div class="card"><div class="label">events</div><div class="value" id="event-count">0</div><div class="meta">append-only timeline records</div></div>
        <div class="card"><div class="label">updated</div><div class="value" id="updated-at">--</div><div class="meta">auto refresh every 2 seconds</div></div>
      </div>
    </section>
    <div class="filters" id="filters"></div>
    <div class="legend"><span class="legend-item"><span class="swatch" style="background: var(--accent-bright);"></span> spend</span><span class="legend-item"><span class="swatch" style="background: var(--warn);"></span> budget limit</span></div>
    <div class="sections">
      <section class="section"><div class="section-header"><div><h2 class="section-title">llm</h2><p class="section-copy">by model</p></div></div><div class="grid" id="llm-grid"></div><div class="empty" id="llm-empty" hidden>No LLM activity in the selected period.</div></section>
      <section class="section"><div class="section-header"><div><h2 class="section-title">tools</h2><p class="section-copy">by tool</p></div></div><div class="grid" id="tools-grid"></div><div class="empty" id="tools-empty" hidden>No tool activity in the selected period.</div></section>
    </div>
  </div>
  <script>
    const PERIODS = [{ value: 3600, label: "Last hour" }, { value: 10800, label: "Last 3 hours" }, { value: 21600, label: "Last 6 hours" }, { value: 43200, label: "Last 12 hours" }, { value: 86400, label: "Last 24 hours" }, { value: 172800, label: "Last 2 days" }];
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("sessionId");
    let activePeriod = 3600;
    let refreshHandle = null;
    function money(value) { return "$" + Number(value || 0).toFixed(6); }
    function timeLabel(value) { if (!value) return "--"; return new Date(value * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
    function relativeDuration(seconds) { if (!seconds) return "--"; if (seconds < 60) return seconds.toFixed(1) + "s"; if (seconds < 3600) return (seconds / 60).toFixed(1) + "m"; return (seconds / 3600).toFixed(1) + "h"; }
    function showError(message) { const el = document.getElementById("error"); el.hidden = false; el.textContent = message; }
    function buildFilters() { const root = document.getElementById("filters"); root.innerHTML = ""; for (const option of PERIODS) { const button = document.createElement("button"); button.className = "filter" + (option.value === activePeriod ? " active" : ""); button.textContent = option.label; button.onclick = () => { activePeriod = option.value; buildFilters(); refresh(); }; root.appendChild(button); } }
    function escapeHtml(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }
    function renderChart(points, budget, periodSeconds) { const width = 640; const height = 180; const padding = 14; const safePoints = points && points.length ? points : [{ timestamp_ms: Date.now() - periodSeconds * 1000, value: 0 }, { timestamp_ms: Date.now(), value: 0 }]; const minX = safePoints[0].timestamp_ms; const maxX = Math.max(safePoints[safePoints.length - 1].timestamp_ms, minX + 1); const maxY = Math.max(budget, ...safePoints.map((point) => point.value), 0.000001); const rangeX = maxX - minX; const x = (value) => padding + ((value - minX) / rangeX) * (width - padding * 2); const y = (value) => height - padding - (value / maxY) * (height - padding * 2); const spendPath = safePoints.map((point, index) => (index === 0 ? "M" : "L") + " " + x(point.timestamp_ms).toFixed(2) + " " + y(point.value).toFixed(2)).join(" "); const budgetY = y(budget).toFixed(2); const grid = [0.25, 0.5, 0.75, 1].map((ratio) => { const yy = y(maxY * ratio).toFixed(2); return '<line x1="' + padding + '" y1="' + yy + '" x2="' + (width - padding) + '" y2="' + yy + '" stroke="rgba(255,255,255,0.07)" stroke-width="1" />'; }).join(""); const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("viewBox", "0 0 " + width + " " + height); svg.innerHTML = '<defs><linearGradient id="spend-gradient" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#06b6d4"></stop><stop offset="55%" stop-color="#8b5cf6"></stop><stop offset="100%" stop-color="#ec4899"></stop></linearGradient></defs>' + grid + '<line x1="' + padding + '" y1="' + budgetY + '" x2="' + (width - padding) + '" y2="' + budgetY + '" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="6 6" />' + '<path d="' + spendPath + '" fill="none" stroke="url(#spend-gradient)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />'; return svg; }
    function chartCard(item, budget, periodSeconds) { const card = document.createElement("div"); card.className = "chart-card"; const top = document.createElement("div"); top.className = "chart-top"; top.innerHTML = '<div class="chart-name">' + escapeHtml(item.key) + '</div><div class="chart-spend">' + money(item.last_value) + '</div>'; card.appendChild(top); card.appendChild(renderChart(item.points, budget, periodSeconds)); const meta = document.createElement("div"); meta.className = "chart-meta"; const first = item.points[0] || { timestamp_ms: 0 }; const last = item.points[item.points.length - 1] || { timestamp_ms: 0 }; meta.innerHTML = '<span>' + new Date(first.timestamp_ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + '</span><span>' + new Date(last.timestamp_ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + '</span>'; card.appendChild(meta); return card; }
    function updateSummary(session) { document.getElementById("eyebrow").textContent = "session " + session.session_id; document.getElementById("total-spent").textContent = money(session.total_spent); document.getElementById("remaining").textContent = money(session.remaining); document.getElementById("event-count").textContent = String(session.event_count || 0); document.getElementById("updated-at").textContent = timeLabel(session.updated_at); document.getElementById("budget-limit").textContent = "budget limit " + money(session.budget || 0); document.getElementById("session-status").textContent = session.status === "closed" ? "session closed · " + relativeDuration(session.duration_seconds) : "tracking live from timeline store"; }
    function updateSection(id, items, budget, periodSeconds) { const grid = document.getElementById(id + "-grid"); const empty = document.getElementById(id + "-empty"); grid.innerHTML = ""; if (!items.length) { empty.hidden = false; return; } empty.hidden = true; for (const item of items) { grid.appendChild(chartCard(item, budget, periodSeconds)); } }
    async function refresh() { if (!sessionId) { showError("Missing sessionId in the URL."); return; } const timelineResp = await fetch("/api/dashboard/timeline?sessionId=" + encodeURIComponent(sessionId) + "&period=" + activePeriod, { cache: "no-store" }); const sessionResp = await fetch("/api/dashboard/session?sessionId=" + encodeURIComponent(sessionId), { cache: "no-store" }); if (!timelineResp.ok || !sessionResp.ok) { showError("Could not load session data."); return; } const timeline = await timelineResp.json(); const session = await sessionResp.json(); updateSummary(session); updateSection("llm", timeline.llm || [], session.budget || 0, activePeriod); updateSection("tools", timeline.tools || [], session.budget || 0, activePeriod); }
    buildFilters(); refresh(); refreshHandle = window.setInterval(refresh, 2000); window.addEventListener("beforeunload", () => { if (refreshHandle !== null) window.clearInterval(refreshHandle); });
  </script>
</body>
</html>`;
