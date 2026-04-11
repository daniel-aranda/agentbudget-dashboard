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
  event_kind: "assistant" | "tool" | "user";
  event_type_label: string;
  model_label: string;
  tokens: number;
  cost_delta: number;
  spend_total: number;
}

interface DashboardSessionPayload extends SessionMetadata {
  session_percent: number;
  burn_rate_per_min: number;
  previous_burn_rate_per_min: number;
  burn_rate_delta_per_min: number;
  burn_rate_delta_percent: number | null;
  projected_exhaustion_minutes: number | null;
  previous_projected_exhaustion_minutes: number | null;
  projected_exhaustion_eta_ms: number | null;
  risk_level: "safe" | "watch" | "danger";
  risk_label: string;
  risk_copy: string;
  acceleration_level: "cooling" | "stable" | "accelerating";
  acceleration_copy: string;
  messages_count: number;
  total_tokens: number;
  average_cost_per_message: number;
  average_tokens_per_message: number;
  highest_single_event_cost: number;
  dominant_model: string | null;
  dominant_model_share_percent: number;
  projected_session_spend: number | null;
  projected_session_horizon_minutes: number;
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
  token_points: TimelinePoint[];
  burn_rate_points: TimelinePoint[];
  burn_window_seconds: number;
  events: DashboardRecentEvent[];
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
  const burnRateDeltaPerMin = round6(burnRatePerMin - previousBurnRatePerMin);
  const burnRateDeltaPercent =
    previousBurnRatePerMin > 0
      ? round2(((burnRatePerMin - previousBurnRatePerMin) / previousBurnRatePerMin) * 100)
      : burnRatePerMin > 0
        ? 100
        : null;
  const previousRemaining = round6(session.remaining + sumCost(recent));
  const projectedExhaustionMinutes =
    burnRatePerMin > 0 ? round2(session.remaining / burnRatePerMin) : null;
  const projectedExhaustionEtaMs =
    projectedExhaustionMinutes !== null ? nowMs + projectedExhaustionMinutes * 60 * 1000 : null;
  const { riskLevel, riskLabel, riskCopy } = describeRisk(
    session.budget,
    session.total_spent,
    projectedExhaustionMinutes,
    burnRateDeltaPercent
  );
  const { accelerationLevel, accelerationCopy } = describeAcceleration(
    burnRatePerMin,
    previousBurnRatePerMin,
    burnRateDeltaPercent
  );
  const { model, sharePercent } = dominantModel(llmEvents);
  const sessionElapsedMinutes = Math.max(round2((nowMs / 1000 - session.started_at) / 60), 0);
  const projectionHorizonMinutes = clamp(Math.max(sessionElapsedMinutes, 15), 15, 60);
  const projectedSessionSpend =
    session.status === "closed"
      ? round6(session.total_spent)
      : round6(
          Math.min(session.total_spent + burnRatePerMin * projectionHorizonMinutes, session.budget)
        );

  return {
    ...session,
    session_percent: session.budget > 0 ? round4((session.total_spent / session.budget) * 100) : 0,
    burn_rate_per_min: burnRatePerMin,
    previous_burn_rate_per_min: previousBurnRatePerMin,
    burn_rate_delta_per_min: burnRateDeltaPerMin,
    burn_rate_delta_percent: burnRateDeltaPercent,
    projected_exhaustion_minutes: projectedExhaustionMinutes,
    previous_projected_exhaustion_minutes:
      previousBurnRatePerMin > 0 ? round2(previousRemaining / previousBurnRatePerMin) : null,
    projected_exhaustion_eta_ms: projectedExhaustionEtaMs,
    risk_level: riskLevel,
    risk_label: riskLabel,
    risk_copy: riskCopy,
    acceleration_level: accelerationLevel,
    acceleration_copy: accelerationCopy,
    messages_count: llmEvents.length,
    total_tokens: sumTokens(llmEvents),
    average_cost_per_message:
      llmEvents.length > 0 ? round6(session.total_spent / llmEvents.length) : 0,
    average_tokens_per_message:
      llmEvents.length > 0 ? round2(sumTokens(llmEvents) / llmEvents.length) : 0,
    highest_single_event_cost: round6(highestEventCost(events)),
    dominant_model: model,
    dominant_model_share_percent: sharePercent,
    projected_session_spend: projectedSessionSpend,
    projected_session_horizon_minutes: projectionHorizonMinutes,
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
  const orderedEvents = sortEventsChronologically(events);
  const spendPoints = buildSpendPoints(session, orderedEvents, windowStart, nowMs);
  const tokenPoints = buildTokenPoints(orderedEvents, windowStart, nowMs);
  const { points: burnRatePoints, burnWindowSeconds } = buildBurnRatePoints(
    orderedEvents,
    windowStart,
    nowMs,
    periodSeconds
  );

  return {
    session_id: session.session_id,
    budget: round6(session.budget),
    period_seconds: periodSeconds,
    window_start_ms: windowStart,
    generated_at_ms: nowMs,
    spend_points: spendPoints,
    token_points: tokenPoints,
    burn_rate_points: burnRatePoints,
    burn_window_seconds: burnWindowSeconds,
    events: orderedEvents.map(mapRecentEvent),
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

function highestEventCost(events: TimelineEvent[]): number {
  return events.reduce((max, event) => Math.max(max, event.cost || 0), 0);
}

function sortEventsChronologically(events: TimelineEvent[]): TimelineEvent[] {
  return [...events].sort((left, right) => left.timestamp_ms - right.timestamp_ms);
}

function buildSpendPoints(
  session: SessionMetadata,
  events: TimelineEvent[],
  windowStart: number,
  nowMs: number
): TimelinePoint[] {
  const spendPoints: TimelinePoint[] = [];

  if (!events.length) {
    spendPoints.push(
      { timestamp_ms: windowStart, value: round6(session.total_spent) },
      { timestamp_ms: nowMs, value: round6(session.total_spent) }
    );
    return spendPoints;
  }

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
  return spendPoints;
}

function buildTokenPoints(events: TimelineEvent[], windowStart: number, nowMs: number): TimelinePoint[] {
  const tokenPoints: TimelinePoint[] = [{ timestamp_ms: windowStart, value: 0 }];
  let runningTokens = 0;

  for (const event of events) {
    runningTokens += eventTokens(event);
    tokenPoints.push({
      timestamp_ms: event.timestamp_ms,
      value: runningTokens,
    });
  }

  if ((events[events.length - 1]?.timestamp_ms ?? 0) < nowMs) {
    tokenPoints.push({ timestamp_ms: nowMs, value: runningTokens });
  }

  return tokenPoints;
}

function buildBurnRatePoints(
  events: TimelineEvent[],
  windowStart: number,
  nowMs: number,
  periodSeconds: number
): { points: TimelinePoint[]; burnWindowSeconds: number } {
  const burnWindowSeconds = clamp(Math.round(periodSeconds / 6), 60, 300);
  const burnWindowMs = burnWindowSeconds * 1000;
  const checkpoints = dedupePoints(
    [windowStart, ...events.map((event) => event.timestamp_ms), nowMs].map((timestampMs) => ({
      timestamp_ms: timestampMs,
      value: 0,
    }))
  ).map((point) => point.timestamp_ms);

  const points = checkpoints.map((timestampMs) => {
    const windowCost = sumCost(filterEvents(events, timestampMs - burnWindowMs, timestampMs));
    return {
      timestamp_ms: timestampMs,
      value: round6(windowCost / (burnWindowMs / 60_000)),
    };
  });

  return {
    points,
    burnWindowSeconds,
  };
}

function eventTokens(event: TimelineEvent): number {
  return (event.input_tokens || 0) + (event.output_tokens || 0);
}

function dedupePoints(points: TimelinePoint[]): TimelinePoint[] {
  const deduped: TimelinePoint[] = [];
  const seen = new Set<number>();
  for (const point of points) {
    if (seen.has(point.timestamp_ms)) continue;
    deduped.push(point);
    seen.add(point.timestamp_ms);
  }
  return deduped;
}

function dominantModel(events: TimelineEvent[]): { model: string | null; sharePercent: number } {
  const totals = new Map<string, number>();
  let grandTotal = 0;

  for (const event of events) {
    const key = event.model ?? event.category_key ?? "unlabeled";
    const next = (totals.get(key) ?? 0) + (event.cost || 0);
    totals.set(key, next);
    grandTotal += event.cost || 0;
  }

  let winner: string | null = null;
  let winnerCost = 0;
  for (const [model, cost] of totals.entries()) {
    if (cost > winnerCost) {
      winner = model;
      winnerCost = cost;
    }
  }

  return {
    model: winner,
    sharePercent: grandTotal > 0 ? round2((winnerCost / grandTotal) * 100) : 0,
  };
}

function describeRisk(
  budget: number,
  totalSpent: number,
  projectedExhaustionMinutes: number | null,
  burnRateDeltaPercent: number | null
): { riskLevel: "safe" | "watch" | "danger"; riskLabel: string; riskCopy: string } {
  const percentUsed = budget > 0 ? (totalSpent / budget) * 100 : 0;

  if (
    percentUsed >= 90 ||
    (projectedExhaustionMinutes !== null && projectedExhaustionMinutes <= 20)
  ) {
    return {
      riskLevel: "danger",
      riskLabel: "DANGER",
      riskCopy:
        "Danger means burn is already near the budget edge or projected exhaustion is close if this pattern holds.",
    };
  }

  if (
    percentUsed >= 70 ||
    (projectedExhaustionMinutes !== null && projectedExhaustionMinutes <= 60) ||
    (burnRateDeltaPercent !== null && burnRateDeltaPercent >= 35)
  ) {
    return {
      riskLevel: "watch",
      riskLabel: "WATCH",
      riskCopy:
        "Watch means spend is climbing fast enough to deserve attention, even if the limit is not immediately threatened.",
    };
  }

  return {
    riskLevel: "safe",
    riskLabel: "SAFE",
    riskCopy:
      "Safe means current burn is contained and the budget is not projected to run out soon.",
  };
}

function describeAcceleration(
  burnRatePerMin: number,
  previousBurnRatePerMin: number,
  burnRateDeltaPercent: number | null
): { accelerationLevel: "cooling" | "stable" | "accelerating"; accelerationCopy: string } {
  if (burnRatePerMin <= 0 && previousBurnRatePerMin <= 0) {
    return {
      accelerationLevel: "stable",
      accelerationCopy: "No billable burn detected in the last two windows.",
    };
  }

  if (burnRateDeltaPercent !== null && burnRateDeltaPercent >= 35) {
    return {
      accelerationLevel: "accelerating",
      accelerationCopy:
        "Spend is accelerating versus the prior 5-minute window. Watch the next replies closely.",
    };
  }

  if (burnRateDeltaPercent !== null && burnRateDeltaPercent <= -25) {
    return {
      accelerationLevel: "cooling",
      accelerationCopy: "Burn is cooling relative to the prior 5-minute window.",
    };
  }

  return {
    accelerationLevel: "stable",
    accelerationCopy: "Burn is broadly stable versus the prior 5-minute window.",
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function mapRecentEvent(event: TimelineEvent): DashboardRecentEvent {
  return {
    timestamp_ms: event.timestamp_ms,
    event_kind: event.event_type === "llm" ? "assistant" : "tool",
    event_type_label: event.event_type === "llm" ? "assistant response" : "tool call",
    model_label: event.model ?? event.tool_name ?? event.category_key ?? "unlabeled",
    tokens: eventTokens(event),
    cost_delta: round6(event.cost),
    spend_total: round6(event.total_spent),
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
    .brand {
      display: inline-flex;
      align-items: center;
      min-height: 72px;
      padding: 0 22px;
      border: 1px solid rgba(167, 139, 250, 0.16);
      background: linear-gradient(180deg, rgba(25,20,36,0.9), rgba(16,14,24,0.88));
      box-shadow: 0 20px 40px rgba(0,0,0,0.22);
      font-size: 28px;
      font-weight: 800;
      letter-spacing: -0.04em;
    }
    .brand span { color: var(--accent-bright); }
    .live-badge {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 7px 11px;
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
      grid-template-columns: minmax(0, 1.16fr) minmax(380px, 0.84fr);
      gap: 28px;
      align-items: start;
      padding: 26px 0 16px;
    }
    .hero-left {
      display: grid;
      gap: 14px;
      align-content: start;
      max-width: 820px;
    }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 7px 11px;
      border: 1px solid rgba(167, 139, 250, 0.18);
      background: rgba(139, 92, 246, 0.06);
      color: var(--muted);
      font: 500 12px ui-monospace, SFMono-Regular, Menlo, monospace;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      width: min(100%, 740px);
    }
    h1 {
      margin: 18px 0 8px;
      font-size: clamp(46px, 6vw, 84px);
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
      max-width: 620px;
      color: var(--muted);
      font-size: 15px;
      line-height: 1.55;
    }
    .hero-ops-band {
      display: grid;
      gap: 10px;
      max-width: 740px;
      padding: 14px 16px;
      border: 1px solid rgba(255,255,255,0.06);
      background: linear-gradient(180deg, rgba(18,18,24,0.82), rgba(12,12,18,0.74));
      backdrop-filter: blur(18px);
      box-shadow: 0 18px 36px rgba(0,0,0,0.24);
    }
    .hero-ops-top {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
    }
    .hero-ops-label {
      color: var(--muted-soft);
      font: 600 11px ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .hero-ops-value {
      font: 700 15px ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: -0.02em;
      color: var(--text);
    }
    .hero-ops-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
      color: var(--muted);
      font: 600 12px ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .hero-status-chip {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 72px;
      padding: 5px 10px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.08);
      font: 700 11px ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .hero-status-chip.safe {
      color: #86efac;
      border-color: rgba(34,197,94,0.24);
      background: rgba(34,197,94,0.08);
    }
    .hero-status-chip.watch {
      color: #fcd34d;
      border-color: rgba(245,158,11,0.24);
      background: rgba(245,158,11,0.08);
    }
    .hero-status-chip.danger {
      color: #fda4af;
      border-color: rgba(251,113,133,0.24);
      background: rgba(251,113,133,0.08);
    }
    .hero-status-chip.closed {
      color: #c4b5fd;
      border-color: rgba(167,139,250,0.24);
      background: rgba(139,92,246,0.08);
    }
    .hero-live-insight {
      display: grid;
      gap: 6px;
      max-width: 740px;
      padding: 13px 15px;
      border: 1px solid rgba(255,255,255,0.06);
      background: rgba(255,255,255,0.03);
    }
    .hero-live-kicker {
      color: var(--muted-soft);
      font: 600 11px ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .hero-live-title {
      font-size: 16px;
      font-weight: 700;
      letter-spacing: -0.03em;
    }
    .hero-live-copy {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
    }
    .hero-narrative {
      margin-top: 10px;
      color: #ddd6fe;
      font-size: 14px;
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
      gap: 20px;
      align-items: stretch;
    }
    .trajectory-layout {
      display: grid;
      grid-template-columns: minmax(320px, 0.78fr) minmax(0, 1.42fr);
      gap: 20px;
      align-items: stretch;
    }
    .trajectory-sidebar,
    .trajectory-chart-card {
      padding: 20px;
    }
    .trajectory-sidebar {
      display: grid;
      gap: 18px;
      align-content: start;
    }
    .trajectory-head {
      display: grid;
      gap: 14px;
    }
    .trajectory-head-top {
      display: flex;
      justify-content: space-between;
      align-items: start;
      gap: 16px;
    }
    .trajectory-sidebar .legend {
      justify-content: flex-start;
      gap: 12px 16px;
      flex-wrap: wrap;
    }
    .trajectory-controls {
      display: grid;
      gap: 14px;
    }
    .trajectory-sidebar .filters {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      margin: 0;
    }
    .trajectory-sidebar .filter {
      width: auto;
      min-height: 54px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 10px 12px;
    }
    .trajectory-sidebar .metric-switch {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
      justify-content: stretch;
    }
    .trajectory-sidebar .metric-filter {
      width: 100%;
      min-height: 44px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 10px 12px;
    }
    .trajectory-chart-card {
      display: grid;
      gap: 14px;
      align-content: start;
    }
    .health-card {
      padding: 20px;
      display: grid;
      gap: 14px;
      min-height: 248px;
    }
    .card-title {
      font-size: 18px;
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
    .health-state {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 88px;
      padding: 6px 12px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.08);
      font: 700 11px ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .health-state.safe {
      color: #86efac;
      border-color: rgba(34,197,94,0.24);
      background: rgba(34,197,94,0.08);
    }
    .health-state.watch {
      color: #fcd34d;
      border-color: rgba(245,158,11,0.24);
      background: rgba(245,158,11,0.08);
    }
    .health-state.danger {
      color: #fda4af;
      border-color: rgba(251,113,133,0.24);
      background: rgba(251,113,133,0.08);
    }
    .health-value {
      font-size: clamp(26px, 2.8vw, 38px);
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
    .pill-copy {
      margin-top: 6px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
    }
    .health-guidance {
      padding: 12px 14px;
      border: 1px solid rgba(255,255,255,0.06);
      background: rgba(255,255,255,0.03);
      color: var(--muted);
      font-size: 13px;
      line-height: 1.55;
    }
    .health-guidance strong { color: var(--text); }
    .health-alert {
      padding: 12px 14px;
      border: 1px solid rgba(255,255,255,0.06);
      background: rgba(255,255,255,0.03);
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
    }
    .health-alert.accelerating {
      color: #fcd34d;
      border-color: rgba(245,158,11,0.2);
      background: rgba(245,158,11,0.06);
    }
    .health-alert.cooling {
      color: #67e8f9;
      border-color: rgba(6,182,212,0.2);
      background: rgba(6,182,212,0.06);
    }
    .health-alert.stable {
      color: var(--muted);
    }
    .health-footer {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      color: var(--muted);
      font-size: 12px;
    }
    .module-warning {
      padding: 10px 12px;
      margin-bottom: 12px;
      border: 1px solid rgba(245, 158, 11, 0.24);
      background: rgba(245, 158, 11, 0.08);
      color: #fcd34d;
      font-size: 13px;
      line-height: 1.45;
    }
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 12px;
      align-content: start;
    }
    .metric-card {
      padding: 16px;
      min-height: 124px;
      display: grid;
      gap: 10px;
      align-content: start;
    }
    .metric-label {
      color: var(--muted-soft);
      font: 600 11px ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .metric-value {
      font-size: clamp(28px, 2.5vw, 36px);
      line-height: 0.96;
      font-weight: 800;
      letter-spacing: -0.05em;
    }
    .metric-value.compact {
      font-size: clamp(20px, 2vw, 28px);
      line-height: 1.05;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .metric-delta {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.45;
    }
    .delta-arrow {
      display: inline-grid;
      place-items: center;
      width: 18px;
      height: 18px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.06);
      background: rgba(255,255,255,0.03);
      font: 600 11px ui-monospace, SFMono-Regular, Menlo, monospace;
      flex: 0 0 auto;
    }
    .metric-card.trend-up .metric-delta { color: #f9a8d4; }
    .metric-card.trend-up .delta-arrow { color: #f9a8d4; border-color: rgba(236,72,153,0.24); background: rgba(236,72,153,0.08); }
    .metric-card.trend-down .metric-delta { color: #67e8f9; }
    .metric-card.trend-down .delta-arrow { color: #67e8f9; border-color: rgba(6,182,212,0.24); background: rgba(6,182,212,0.08); }
    .metric-card.trend-flat .metric-delta { color: var(--muted); }
    .filters {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin: 14px 0 16px;
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
    .metric-switch {
      display: inline-flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: flex-end;
    }
    .metric-filter {
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.02);
      color: var(--muted);
      padding: 8px 12px;
      font: 600 11px ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      cursor: pointer;
      transition: transform 160ms ease, border-color 160ms ease, background 160ms ease;
    }
    .metric-filter:hover {
      transform: translateY(-1px);
      border-color: rgba(167, 139, 250, 0.24);
    }
    .metric-filter.active {
      color: var(--text);
      border-color: rgba(6, 182, 212, 0.34);
      background: linear-gradient(135deg, rgba(6,182,212,0.18), rgba(139,92,246,0.12));
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.03);
    }
    .intelligence-panel {
      padding: 18px;
      display: grid;
      gap: 12px;
      min-height: 0;
    }
    .intelligence-header {
      display: grid;
      gap: 4px;
    }
    .intelligence-title {
      font-size: 17px;
      font-weight: 700;
      letter-spacing: -0.04em;
    }
    .intelligence-copy {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
    }
    .intelligence-list {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 10px;
    }
    .intelligence-item {
      border: 1px solid rgba(255,255,255,0.06);
      background: rgba(255,255,255,0.03);
      padding: 12px 13px;
      display: grid;
      gap: 6px;
    }
    .intelligence-item.watch {
      border-color: rgba(245,158,11,0.18);
      background: rgba(245,158,11,0.05);
    }
    .intelligence-item.notice {
      border-color: rgba(167,139,250,0.16);
      background: rgba(139,92,246,0.05);
    }
    .intelligence-item.accent {
      border-color: rgba(6,182,212,0.18);
      background: rgba(6,182,212,0.05);
    }
    .intelligence-kicker {
      color: var(--muted-soft);
      font: 600 11px ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .intelligence-headline {
      font-size: 14px;
      font-weight: 700;
      letter-spacing: -0.02em;
      line-height: 1.3;
    }
    .intelligence-detail {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.5;
    }
    .intelligence-empty {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.55;
      padding: 4px 2px 0;
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
      min-height: 520px;
      overflow: hidden;
    }
    .chart-stage svg {
      width: 100%;
      height: 520px;
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
    .tooltip-sub {
      margin-top: 6px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
    }
    .annotation-strip {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }
    .annotation-card {
      border: 1px solid rgba(255,255,255,0.06);
      background: rgba(255,255,255,0.03);
      padding: 12px 14px;
      min-height: 90px;
    }
    .annotation-card.notice {
      border-color: rgba(167, 139, 250, 0.16);
      background: rgba(139, 92, 246, 0.06);
    }
    .annotation-card.watch {
      border-color: rgba(245,158,11,0.18);
      background: rgba(245,158,11,0.06);
    }
    .annotation-card.accent {
      border-color: rgba(6,182,212,0.18);
      background: rgba(6,182,212,0.06);
    }
    .annotation-kicker {
      color: var(--muted-soft);
      font: 600 11px ui-monospace, SFMono-Regular, Menlo, monospace;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .annotation-title {
      margin-top: 8px;
      font-size: 16px;
      font-weight: 700;
      letter-spacing: -0.03em;
    }
    .annotation-copy {
      margin-top: 6px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
    }
    .drivers-grid {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 12px;
    }
    .driver-card {
      padding: 16px;
      border: 1px solid rgba(255,255,255,0.05);
      background: linear-gradient(180deg, rgba(16,16,22,0.8), rgba(10,10,14,0.82));
      min-height: 118px;
    }
    .driver-label {
      color: var(--muted-soft);
      font: 600 11px ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .driver-value {
      margin-top: 10px;
      font-size: 24px;
      line-height: 1.02;
      font-weight: 800;
      letter-spacing: -0.04em;
    }
    .driver-value.compact {
      font-size: 20px;
      line-height: 1.1;
      word-break: break-word;
    }
    .driver-meta {
      margin-top: 8px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
    }
    .events-table {
      display: grid;
      gap: 10px;
    }
    .event-head,
    .event-row {
      display: grid;
      grid-template-columns: 112px minmax(156px, 1.05fr) minmax(200px, 1fr) 112px 130px;
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
    .event-row.latest {
      border-color: rgba(167, 139, 250, 0.22);
      background: linear-gradient(180deg, rgba(26,18,36,0.82), rgba(10,10,14,0.88));
      box-shadow: inset 0 0 0 1px rgba(167, 139, 250, 0.06);
    }
    .event-row:hover {
      border-color: rgba(167, 139, 250, 0.18);
      background: linear-gradient(180deg, rgba(22,18,30,0.88), rgba(10,10,14,0.9));
    }
    .event-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: fit-content;
      padding: 4px 8px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.04);
      font: 600 11px ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .event-badge.assistant {
      color: #ddd6fe;
      border-color: rgba(167, 139, 250, 0.24);
      background: rgba(139, 92, 246, 0.12);
    }
    .event-badge.tool {
      color: #67e8f9;
      border-color: rgba(6, 182, 212, 0.24);
      background: rgba(6, 182, 212, 0.1);
    }
    .event-badge.user {
      color: #bfdbfe;
      border-color: rgba(96, 165, 250, 0.24);
      background: rgba(96, 165, 250, 0.1);
    }
    .event-model { color: #ddd6fe; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .event-muted { color: var(--muted); font-variant-numeric: tabular-nums; }
    .event-cost { text-align: right; color: #f9a8d4; font-weight: 800; font-variant-numeric: tabular-nums; }
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
      .trajectory-layout { grid-template-columns: 1fr; }
      .kpi-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .drivers-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .annotation-strip,
      .intelligence-list { grid-template-columns: 1fr; }
      .hero-left { max-width: none; }
      .trajectory-sidebar .filters { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 820px) {
      .shell { padding: 18px; }
      .kpi-grid,
      .health-insights,
      .drivers-grid { grid-template-columns: 1fr; }
      .trajectory-sidebar .metric-switch { grid-template-columns: 1fr; }
      .event-head { display: none; }
      .event-row {
        grid-template-columns: 1fr;
        gap: 6px;
      }
      .event-cost { text-align: left; }
      .chart-stage { min-height: 360px; }
      .chart-stage svg { height: 360px; }
    }
    @media (max-width: 640px) {
      .shell { padding: 16px; }
      .hero { padding: 14px 0 10px; }
      .filters { gap: 8px; }
      .trajectory-sidebar .filters { grid-template-columns: 1fr; }
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
        <div class="hero-left">
        <div class="eyebrow" id="eyebrow">the eyes of agentbudget</div>
        <div class="hero-ops-band">
          <div class="hero-ops-top">
            <span class="hero-ops-label">Session</span>
            <span class="hero-ops-value" id="heroSessionId">--</span>
          </div>
          <div class="hero-ops-row">
            <span class="hero-status-chip safe" id="heroStatusChip">SAFE</span>
            <span id="heroOpsMeta">0 events • no model • updated --</span>
          </div>
        </div>
        <div class="hero-live-insight">
          <div class="hero-live-kicker">Live insight</div>
          <div class="hero-live-title" id="heroLiveTitle">No active burn detected</div>
          <div class="hero-live-copy" id="heroLiveCopy">This session has not produced enough billable activity yet to show a strong operational signal.</div>
        </div>
        <h1><span class="gradient">BUDGET INTELLIGENCE</span><br /><span style="color: var(--text);">FOR EVERY AGENT SESSION</span></h1>
        <p class="hero-copy">Mission control for where spend moved, why it moved, and what happens next.</p>
        <div class="hero-narrative" id="heroNarrative">Real-time budget intelligence for every agent session.</div>
        <p class="error" id="error" hidden></p>
        </div>
      </div>

      <section class="glass-card health-card">
        <div class="health-top">
          <div>
            <div class="card-title">Budget health</div>
            <div class="card-subtle" id="healthStatus">The control layer for burn velocity, cost causality, and budget risk.</div>
          </div>
          <div class="health-state safe" id="healthState">SAFE</div>
        </div>
        <div class="module-warning" id="summaryWarning" hidden></div>
        <div>
          <div class="health-value" id="healthValue">$0.000000 / $0.000000</div>
          <div class="health-meta" id="healthMeta">Remaining budget and exhaustion risk update continuously.</div>
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
        <div class="health-guidance" id="healthGuidance"><strong>SAFE</strong> means burn is contained and the current session is not on a near-term path to exhaust its limit.</div>
        <div class="health-insights">
          <div class="health-pill">
            <div class="pill-label">Burn rate</div>
            <div class="pill-value" id="healthBurnRate">$0.000000 / min</div>
            <div class="pill-copy" id="healthBurnDelta">No previous burn window to compare yet.</div>
          </div>
          <div class="health-pill">
            <div class="pill-label">Budget exhausted in</div>
            <div class="pill-value" id="healthExhaustion">No active burn</div>
            <div class="pill-copy" id="healthExhaustionEta">ETA opens once current burn is measurable.</div>
          </div>
          <div class="health-pill">
            <div class="pill-label">Risk status</div>
            <div class="pill-value" id="healthRiskLabel">SAFE</div>
            <div class="pill-copy" id="healthRiskCopy">Current burn is controlled and not near the budget edge.</div>
          </div>
          <div class="health-pill">
            <div class="pill-label">Acceleration alert</div>
            <div class="pill-value" id="healthAccelerationTitle">Stable</div>
            <div class="pill-copy" id="healthAccelerationCopy">Burn is broadly stable versus the prior 5-minute window.</div>
          </div>
        </div>
        <div class="health-alert stable" id="healthAccelerationBanner">No billable burn acceleration is visible right now.</div>
        <div class="health-footer">
          <span id="healthFooterLeft">0 billable events observed</span>
          <span id="healthFooterCenter">Dominant cost center not available yet</span>
          <span id="healthFooterRight">Updated --</span>
        </div>
      </section>
    </section>

    <section class="overview-grid">
      <div class="trajectory-layout">
        <section class="glass-card trajectory-sidebar">
          <div class="trajectory-head">
            <div class="trajectory-head-top">
              <div>
                <h2 class="panel-title" id="chartPanelTitle">Spend trajectory</h2>
                <div class="panel-copy" id="chartPanelCopy">Trace where cumulative spend moved, what the current burn implies next, and when the limit comes into view.</div>
              </div>
              <div class="legend">
                <span class="legend-item"><span class="swatch" style="background: linear-gradient(90deg, #06b6d4, #ec4899);"></span><span id="legendPrimaryLabel">actual spend</span></span>
                <span class="legend-item"><span class="swatch" style="background: rgba(196,181,253,0.95);"></span><span id="legendSecondaryLabel">projected burn</span></span>
                <span class="legend-item"><span class="swatch" style="background: rgba(245,158,11,0.95);"></span><span id="legendTertiaryLabel">risk zone</span></span>
              </div>
            </div>
          </div>
          <div class="trajectory-controls">
            <div class="filters" id="filters"></div>
            <div class="metric-switch" id="metricFilters"></div>
          </div>
        </section>

        <section class="glass-card trajectory-chart-card">
          <div class="module-warning" id="chartWarning" hidden></div>
          <div class="chart-stage" id="chartStage">
            <div class="chart-tooltip" id="chartTooltip" hidden>
              <div class="tooltip-time" id="tooltipTime">--</div>
              <div class="tooltip-value" id="tooltipValue">$0.000000</div>
              <div class="tooltip-sub" id="tooltipSub">--</div>
            </div>
            <div id="chartMount"></div>
          </div>
        </section>
      </div>

      <section class="glass-card intelligence-panel">
        <div class="intelligence-header">
          <div class="intelligence-title">Budget intelligence</div>
          <div class="intelligence-copy">Actionable signals inferred from the live session timeline, only when the numbers support them.</div>
        </div>
        <div class="intelligence-list" id="intelligenceList"></div>
        <div class="intelligence-empty" id="intelligenceEmpty" hidden>No strong signals yet in this window. The session is observable, but not showing a clear budget pattern right now.</div>
      </section>

      <section class="kpi-grid" id="kpiGrid">
        <article class="glass-card metric-card" id="metric-spent">
          <div class="metric-label">Total spent</div>
          <div class="metric-value" id="metric-spent-value">$0.000000</div>
          <div class="metric-delta" id="metric-spent-delta">No change in last 5 min</div>
        </article>
        <article class="glass-card metric-card" id="metric-remaining">
          <div class="metric-label">Remaining budget</div>
          <div class="metric-value" id="metric-remaining-value">$0.000000</div>
          <div class="metric-delta" id="metric-remaining-delta">No change in last 5 min</div>
        </article>
        <article class="glass-card metric-card" id="metric-messages">
          <div class="metric-label">Message count</div>
          <div class="metric-value" id="metric-messages-value">0</div>
          <div class="metric-delta" id="metric-messages-delta">No new messages in last 5 min</div>
        </article>
        <article class="glass-card metric-card" id="metric-highest-event">
          <div class="metric-label">Highest single event</div>
          <div class="metric-value" id="metric-highest-event-value">$0.000000</div>
          <div class="metric-delta" id="metric-highest-event-delta">Largest one-step jump in spend so far.</div>
        </article>
        <article class="glass-card metric-card" id="metric-dominant-model">
          <div class="metric-label">Dominant model</div>
          <div class="metric-value compact" id="metric-dominant-model-value">No model yet</div>
          <div class="metric-delta" id="metric-dominant-model-delta">Leading model by cost share.</div>
        </article>
        <article class="glass-card metric-card" id="metric-tokens">
          <div class="metric-label">Total tokens</div>
          <div class="metric-value" id="metric-tokens-value">0</div>
          <div class="metric-delta" id="metric-tokens-delta">No new tokens in last 5 min</div>
        </article>
        <article class="glass-card metric-card" id="metric-avg-cost">
          <div class="metric-label">Avg cost / message</div>
          <div class="metric-value" id="metric-avg-cost-value">$0.000000</div>
          <div class="metric-delta" id="metric-avg-cost-delta">Blended across all billable session spend.</div>
        </article>
        <article class="glass-card metric-card" id="metric-avg-tokens">
          <div class="metric-label">Avg tokens / message</div>
          <div class="metric-value" id="metric-avg-tokens-value">0</div>
          <div class="metric-delta" id="metric-avg-tokens-delta">Across billable assistant responses.</div>
        </article>
        <article class="glass-card metric-card" id="metric-projected-spend">
          <div class="metric-label">Projected session spend</div>
          <div class="metric-value" id="metric-projected-spend-value">$0.000000</div>
          <div class="metric-delta" id="metric-projected-spend-delta">Projection updates from current burn.</div>
        </article>
      </section>
    </section>

    <section class="glass-card panel" style="margin-top: 22px;">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">Cost drivers</h2>
          <div class="panel-copy">The cost centers and events most responsible for the current spend curve in the selected window.</div>
        </div>
      </div>
      <div class="drivers-grid" id="driversGrid"></div>
      <div class="empty" id="driversEmpty" hidden>No billable spend in this window yet, so there are no drivers to attribute.</div>
    </section>

    <section class="glass-card panel" style="margin-top: 22px;">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">Event timeline</h2>
          <div class="panel-copy">The live event trail behind the spend curve, newest first, so causality stays visible.</div>
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
      <div class="empty" id="eventsEmpty" hidden>No billable spend events yet for this session.</div>
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
    const CHART_MODES = [
      { value: 'spend', label: 'Spend' },
      { value: 'tokens', label: 'Tokens' },
      { value: 'burn', label: 'Burn rate' }
    ];
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('sessionId');
    let activePeriod = 600;
    let activeChartMetric = 'spend';
    let refreshHandle = null;
    let currentSession = null;
    let currentTimeline = null;

    function money(value) {
      return '$' + Number(value || 0).toFixed(6);
    }

    function moneyCompact(value) {
      const numeric = Number(value || 0);
      if (numeric >= 1) return '$' + numeric.toFixed(2);
      if (numeric >= 0.01) return '$' + numeric.toFixed(3);
      return '$' + numeric.toFixed(4);
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

    function formatEta(timestampMs) {
      if (!timestampMs) return 'ETA opens once current burn is measurable.';
      return 'ETA ' + new Date(timestampMs).toLocaleString([], {
        hour: '2-digit',
        minute: '2-digit',
        month: 'short',
        day: 'numeric'
      }) + ' if burn holds.';
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

    function showModuleWarning(id, message) {
      const el = document.getElementById(id);
      el.hidden = false;
      el.textContent = message;
    }

    function clearModuleWarning(id) {
      const el = document.getElementById(id);
      el.hidden = true;
      el.textContent = '';
    }

    async function fetchJson(url, fallbackMessage) {
      const response = await fetch(url, { cache: 'no-store' });
      const payload = await response.json().catch(function() {
        return {};
      });
      if (!response.ok) {
        throw new Error(payload.error || fallbackMessage);
      }
      return payload;
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

    function buildMetricFilters() {
      const root = document.getElementById('metricFilters');
      root.innerHTML = '';
      for (const option of CHART_MODES) {
        const button = document.createElement('button');
        button.className = 'metric-filter' + (option.value === activeChartMetric ? ' active' : '');
        button.textContent = option.label;
        button.onclick = () => {
          activeChartMetric = option.value;
          buildMetricFilters();
          if (currentSession && currentTimeline) {
            renderMainChart(currentSession, currentTimeline);
          }
        };
        root.appendChild(button);
      }
    }

    function applyDelta(cardId, deltaId, direction, message) {
      const card = document.getElementById(cardId);
      const delta = document.getElementById(deltaId);
      card.classList.remove('trend-up', 'trend-down', 'trend-flat');
      const className = 'trend-' + direction;
      card.classList.add(className);
      delta.innerHTML =
        '<span class="delta-arrow">' +
        (direction === 'up' ? '↑' : direction === 'down' ? '↓' : '→') +
        '</span><span>' +
        escapeHtml(message) +
        '</span>';
    }

    function compareDirection(current, previous) {
      const epsilon = 0.000001;
      if (current > previous + epsilon) return 'up';
      if (current < previous - epsilon) return 'down';
      return 'flat';
    }

    function invertDirection(direction) {
      if (direction === 'up') return 'down';
      if (direction === 'down') return 'up';
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

    function shortNumber(value) {
      const numeric = Number(value || 0);
      if (numeric >= 1_000_000) return (numeric / 1_000_000).toFixed(1) + 'm';
      if (numeric >= 1_000) return (numeric / 1_000).toFixed(1) + 'k';
      return formatInteger(Math.round(numeric));
    }

    function formatMetricValue(mode, value) {
      if (mode === 'tokens') return shortNumber(value);
      if (mode === 'burn') return moneyCompact(value) + ' / min';
      return money(value);
    }

    function formatAxisValue(mode, value) {
      if (mode === 'tokens') return shortNumber(value);
      if (mode === 'burn') return moneyCompact(value) + '/m';
      return moneyCompact(value);
    }

    function getChartModeConfig() {
      if (activeChartMetric === 'tokens') {
        return {
          title: 'Token trajectory',
          copy: 'See where usage volume jumped and which paid events drove the biggest token load in this window.',
          primaryLabel: 'cumulative tokens',
          secondaryLabel: 'event markers',
          tertiaryLabel: 'spend spikes',
        };
      }

      if (activeChartMetric === 'burn') {
        return {
          title: 'Burn rate trajectory',
          copy: 'See when cost velocity accelerated, how hot the current pace is, and whether burn is settling or compounding.',
          primaryLabel: 'actual burn rate',
          secondaryLabel: 'projected burn',
          tertiaryLabel: 'acceleration markers',
        };
      }

      return {
        title: 'Spend trajectory',
        copy: 'Trace where cumulative spend moved, what the current burn implies next, and when the limit comes into view.',
        primaryLabel: 'actual spend',
        secondaryLabel: 'projected burn',
        tertiaryLabel: 'risk zone',
      };
    }

    function valueAtOrBefore(points, timestampMs) {
      let fallback = points[0] || { value: 0 };
      for (const point of points || []) {
        if (point.timestamp_ms > timestampMs) {
          break;
        }
        fallback = point;
      }
      return Number(fallback.value || 0);
    }

    function dominantEntry(totals, totalCost) {
      let key = null;
      let value = 0;
      for (const entry of totals.entries()) {
        if (entry[1] > value) {
          key = entry[0];
          value = entry[1];
        }
      }
      return {
        key,
        value,
        sharePercent: totalCost > 0 ? (value / totalCost) * 100 : 0
      };
    }

    function computeWindowAcceleration(events, periodSeconds, session) {
      const nowMs = Number(currentTimeline && currentTimeline.generated_at_ms ? currentTimeline.generated_at_ms : Date.now());
      const windowMs = Math.min(5 * 60 * 1000, Math.max(60 * 1000, Math.floor((periodSeconds * 1000) / 3)));
      const recent = (events || []).filter(function(event) {
        return event.timestamp_ms >= nowMs - windowMs && event.timestamp_ms <= nowMs;
      });
      const previous = (events || []).filter(function(event) {
        return event.timestamp_ms >= nowMs - windowMs * 2 && event.timestamp_ms < nowMs - windowMs;
      });
      const recentBurn = recent.reduce(function(total, event) {
        return total + Number(event.cost_delta || 0);
      }, 0) / (windowMs / 60000);
      const previousBurn = previous.reduce(function(total, event) {
        return total + Number(event.cost_delta || 0);
      }, 0) / (windowMs / 60000);

      if (recentBurn <= 0 && previousBurn <= 0) {
        return {
          level: session && session.acceleration_level ? session.acceleration_level : 'stable',
          deltaPercent: null,
          copy: 'No billable burn in the selected comparison windows.',
          windowMinutes: Math.round(windowMs / 60000)
        };
      }

      const deltaPercent =
        previousBurn > 0
          ? ((recentBurn - previousBurn) / previousBurn) * 100
          : recentBurn > 0
            ? 100
            : null;

      if (deltaPercent !== null && deltaPercent >= 35) {
        return {
          level: 'accelerating',
          deltaPercent,
          copy:
            'Burn is up ' +
            deltaPercent.toFixed(0) +
            '% versus the previous ' +
            Math.round(windowMs / 60000) +
            ' minute window.',
          windowMinutes: Math.round(windowMs / 60000)
        };
      }

      if (deltaPercent !== null && deltaPercent <= -25) {
        return {
          level: 'cooling',
          deltaPercent,
          copy:
            'Burn is down ' +
            Math.abs(deltaPercent).toFixed(0) +
            '% versus the previous ' +
            Math.round(windowMs / 60000) +
            ' minute window.',
          windowMinutes: Math.round(windowMs / 60000)
        };
      }

      return {
        level: 'stable',
        deltaPercent,
        copy: 'Burn is broadly stable across the last two comparison windows.',
        windowMinutes: Math.round(windowMs / 60000)
      };
    }

    function buildCostDrivers(events, periodSeconds, session) {
      const ordered = [...(events || [])].sort(function(left, right) {
        return left.timestamp_ms - right.timestamp_ms;
      });
      const totalCost = ordered.reduce(function(total, event) {
        return total + Number(event.cost_delta || 0);
      }, 0);
      const modelTotals = new Map();
      const toolTotals = new Map();
      const sortedByCost = [...ordered].sort(function(left, right) {
        return Number(right.cost_delta || 0) - Number(left.cost_delta || 0);
      });

      for (const event of ordered) {
        if (event.event_kind === 'assistant') {
          modelTotals.set(
            event.model_label,
            (modelTotals.get(event.model_label) || 0) + Number(event.cost_delta || 0)
          );
        }
        if (event.event_kind === 'tool') {
          toolTotals.set(
            event.model_label,
            (toolTotals.get(event.model_label) || 0) + Number(event.cost_delta || 0)
          );
        }
      }

      const topModel = dominantEntry(modelTotals, totalCost);
      const topTool = dominantEntry(toolTotals, totalCost);
      const highestEvent = sortedByCost[0] || null;
      const topThreeSharePercent =
        totalCost > 0
          ? (sortedByCost.slice(0, 3).reduce(function(total, event) {
              return total + Number(event.cost_delta || 0);
            }, 0) /
              totalCost) *
            100
          : 0;
      const acceleration = computeWindowAcceleration(ordered, periodSeconds, session);

      return {
        totalCost,
        topModel,
        topTool,
        highestEvent,
        topThreeSharePercent,
        acceleration
      };
    }

    function buildBudgetIntelligence(session, timeline, drivers) {
      const ordered = [...(timeline.events || [])].sort(function(left, right) {
        return left.timestamp_ms - right.timestamp_ms;
      });
      if (!ordered.length) {
        return [];
      }

      const totalCost = Math.max(drivers.totalCost, 0);
      const assistantEvents = ordered.filter(function(event) {
        return event.event_kind === 'assistant';
      });
      const toolEvents = ordered.filter(function(event) {
        return event.event_kind === 'tool';
      });
      const assistantCost = assistantEvents.reduce(function(total, event) {
        return total + Number(event.cost_delta || 0);
      }, 0);
      const toolCost = toolEvents.reduce(function(total, event) {
        return total + Number(event.cost_delta || 0);
      }, 0);
      const assistantShare = totalCost > 0 ? (assistantCost / totalCost) * 100 : 0;

      const midpointMs = Number(timeline.window_start_ms || ordered[0].timestamp_ms) +
        (Number(timeline.generated_at_ms || ordered[ordered.length - 1].timestamp_ms) - Number(timeline.window_start_ms || ordered[0].timestamp_ms)) / 2;
      const earlierEvents = ordered.filter(function(event) {
        return event.timestamp_ms < midpointMs;
      });
      const laterEvents = ordered.filter(function(event) {
        return event.timestamp_ms >= midpointMs;
      });

      const earlierToolCost = earlierEvents.reduce(function(total, event) {
        return total + (event.event_kind === 'tool' ? Number(event.cost_delta || 0) : 0);
      }, 0);
      const laterToolCost = laterEvents.reduce(function(total, event) {
        return total + (event.event_kind === 'tool' ? Number(event.cost_delta || 0) : 0);
      }, 0);
      const earlierTotalCost = earlierEvents.reduce(function(total, event) {
        return total + Number(event.cost_delta || 0);
      }, 0);
      const laterTotalCost = laterEvents.reduce(function(total, event) {
        return total + Number(event.cost_delta || 0);
      }, 0);
      const earlierToolShare = earlierTotalCost > 0 ? (earlierToolCost / earlierTotalCost) * 100 : 0;
      const laterToolShare = laterTotalCost > 0 ? (laterToolCost / laterTotalCost) * 100 : 0;

      const earlierAssistant = earlierEvents.filter(function(event) {
        return event.event_kind === 'assistant';
      });
      const laterAssistant = laterEvents.filter(function(event) {
        return event.event_kind === 'assistant';
      });
      const earlierAvgTokens = earlierAssistant.length
        ? earlierAssistant.reduce(function(total, event) {
            return total + Number(event.tokens || 0);
          }, 0) / earlierAssistant.length
        : null;
      const laterAvgTokens = laterAssistant.length
        ? laterAssistant.reduce(function(total, event) {
            return total + Number(event.tokens || 0);
          }, 0) / laterAssistant.length
        : null;

      const insights = [];

      if (session.burn_rate_delta_percent !== null && session.burn_rate_delta_percent >= 35) {
        insights.push({
          tone: 'watch',
          kicker: 'Burn rate',
          headline: 'This session is burning faster than its earlier pace',
          detail:
            'Burn rate is up ' +
            session.burn_rate_delta_percent.toFixed(0) +
            '% versus the prior 5-minute baseline.'
        });
      }

      if (assistantShare >= 70 && assistantCost > 0) {
        insights.push({
          tone: 'notice',
          kicker: 'Spend concentration',
          headline: 'Most spend is concentrated in assistant responses',
          detail:
            assistantShare.toFixed(0) +
            '% of selected-window cost is currently coming from assistant responses.'
        });
      }

      if (
        laterTotalCost > 0 &&
        laterToolCost > 0 &&
        earlierTotalCost > 0 &&
        laterToolShare >= 25 &&
        laterToolShare - earlierToolShare >= 15
      ) {
        insights.push({
          tone: 'accent',
          kicker: 'Tool share',
          headline: 'Tool usage is becoming a larger share of cost',
          detail:
            'Tool-attributed spend moved from ' +
            earlierToolShare.toFixed(0) +
            '% to ' +
            laterToolShare.toFixed(0) +
            '% across this window.'
        });
      }

      if (session.projected_exhaustion_minutes !== null && session.projected_exhaustion_minutes <= 60) {
        insights.push({
          tone: session.projected_exhaustion_minutes <= 20 ? 'watch' : 'notice',
          kicker: 'Budget risk',
          headline: 'Current pace suggests budget exhaustion soon',
          detail:
            'At the current burn, the remaining budget could run out in ' +
            formatDurationMinutes(session.projected_exhaustion_minutes) +
            '.'
        });
      }

      if (
        earlierAvgTokens !== null &&
        laterAvgTokens !== null &&
        laterAvgTokens >= earlierAvgTokens * 1.2 &&
        laterAvgTokens - earlierAvgTokens >= 20
      ) {
        insights.push({
          tone: 'notice',
          kicker: 'Response size',
          headline: 'Average response size is trending upward',
          detail:
            'Average assistant output in this window rose from ' +
            formatInteger(Math.round(earlierAvgTokens)) +
            ' to ' +
            formatInteger(Math.round(laterAvgTokens)) +
            ' total tokens.'
        });
      }

      if (
        insights.length < 3 &&
        drivers.topThreeSharePercent >= 60
      ) {
        insights.push({
          tone: 'accent',
          kicker: 'Concentration',
          headline: 'A small number of events is driving most of the curve',
          detail:
            drivers.topThreeSharePercent.toFixed(0) +
            '% of selected-window spend comes from the top 3 events.'
        });
      }

      return insights.slice(0, 3);
    }

    function renderBudgetIntelligence(insights) {
      const root = document.getElementById('intelligenceList');
      const empty = document.getElementById('intelligenceEmpty');
      if (!root || !empty) {
        return;
      }
      root.innerHTML = '';

      if (!insights.length) {
        empty.hidden = false;
        return;
      }

      empty.hidden = true;
      for (const insight of insights) {
        const item = document.createElement('article');
        item.className = 'intelligence-item ' + insight.tone;
        item.innerHTML =
          '<div class="intelligence-kicker">' + escapeHtml(insight.kicker) + '</div>' +
          '<div class="intelligence-headline">' + escapeHtml(insight.headline) + '</div>' +
          '<div class="intelligence-detail">' + escapeHtml(insight.detail) + '</div>';
        root.appendChild(item);
      }
    }

    function setHeroLiveInsight(insights, session, drivers) {
      const title = document.getElementById('heroLiveTitle');
      const copy = document.getElementById('heroLiveCopy');
      const primary = insights && insights.length ? insights[0] : null;

      if (primary) {
        title.textContent = primary.headline;
        copy.textContent = primary.detail;
        return;
      }

      if (!session || Number(session.burn_rate_per_min || 0) <= 0) {
        title.textContent = 'No active burn detected';
        copy.textContent = 'This window does not show measurable billable burn yet, so the session is observable but still quiet.';
        return;
      }

      if (drivers && drivers.acceleration.level === 'stable') {
        title.textContent = 'Spend stable in current window';
        copy.textContent = 'The latest comparison windows show broadly stable burn without a strong acceleration or concentration signal.';
        return;
      }

      title.textContent = 'Live budget intelligence updating';
      copy.textContent = 'New billable events will reshape this signal as the session evolves.';
    }

    function buildChartMarkers(events, drivers) {
      const ordered = [...(events || [])];
      if (!ordered.length) return [];

      const averageCost =
        drivers.totalCost > 0 ? drivers.totalCost / Math.max(ordered.length, 1) : 0;
      const markers = [];

      function pushMarker(event, label, detail) {
        if (!event) return;
        if (
          markers.some(function(marker) {
            return marker.timestamp_ms === event.timestamp_ms && marker.label === label;
          })
        ) {
          return;
        }
        markers.push({
          ...event,
          label,
          detail
        });
      }

      if (drivers.highestEvent) {
        pushMarker(
          drivers.highestEvent,
          drivers.highestEvent.cost_delta >= averageCost * 2 ? 'spike' : 'largest jump',
          eventNarrative(drivers.highestEvent) + ' added ' + money(drivers.highestEvent.cost_delta) + '.'
        );
      }

      const topToolEvent = [...ordered]
        .filter(function(event) {
          return event.event_kind === 'tool';
        })
        .sort(function(left, right) {
          return Number(right.cost_delta || 0) - Number(left.cost_delta || 0);
        })[0];
      if (topToolEvent) {
        pushMarker(
          topToolEvent,
          'tool cost',
          escapeHtml(topToolEvent.model_label) + ' added ' + money(topToolEvent.cost_delta) + '.'
        );
      }

      const latestMeaningful = [...ordered].reverse().find(function(event) {
        return Number(event.cost_delta || 0) >= averageCost || ordered.length === 1;
      });
      if (latestMeaningful) {
        pushMarker(
          latestMeaningful,
          'latest move',
          eventNarrative(latestMeaningful) + ' landed at ' + timestampLabel(latestMeaningful.timestamp_ms) + '.'
        );
      }

      return markers
        .slice(0, 3)
        .sort(function(left, right) {
          return left.timestamp_ms - right.timestamp_ms;
        });
    }

    function eventNarrative(event) {
      return event.event_kind === 'tool'
        ? 'Tool call'
        : 'Assistant response';
    }

    function buildChartAnnotations(session, timeline, drivers, markers) {
      const annotations = [];

      if (!timeline.events || !timeline.events.length) {
        return [
          {
            tone: 'notice',
            kicker: 'Quiet window',
            title: 'No billable activity in this range',
            copy: 'Shift the time horizon or wait for the next response to see spend movement.'
          }
        ];
      }

      if (drivers.highestEvent) {
        annotations.push({
          tone: 'accent',
          kicker: 'Largest jump',
          title: money(drivers.highestEvent.cost_delta) + ' from one event',
          copy:
            eventNarrative(drivers.highestEvent) +
            ' on ' +
            timestampLabel(drivers.highestEvent.timestamp_ms) +
            ' was the biggest single move.'
        });
      }

      if (drivers.topThreeSharePercent >= 55) {
        annotations.push({
          tone: 'watch',
          kicker: 'Spend concentration',
          title: drivers.topThreeSharePercent.toFixed(0) + '% came from the top 3 events',
          copy: 'A small cluster of expensive steps is driving most of the spend in this window.'
        });
      }

      if (drivers.acceleration.level === 'accelerating') {
        annotations.push({
          tone: 'watch',
          kicker: 'Acceleration',
          title: 'Burn is accelerating',
          copy: drivers.acceleration.copy
        });
      } else if (drivers.topTool.key && drivers.topTool.sharePercent >= 20) {
        annotations.push({
          tone: 'notice',
          kicker: 'Tool-driven',
          title: drivers.topTool.key + ' is materially moving spend',
          copy:
            money(drivers.topTool.value) +
            ' from tools in this window, or ' +
            drivers.topTool.sharePercent.toFixed(0) +
            '% of total spend.'
        });
      } else if (drivers.topModel.key) {
        annotations.push({
          tone: 'notice',
          kicker: 'Model dominance',
          title: drivers.topModel.key + ' leads spend',
          copy:
            drivers.topModel.sharePercent.toFixed(0) +
            '% of selected-window spend is currently attached to this model.'
        });
      }

      return annotations.slice(0, 3);
    }

    function renderAnnotations(annotations) {
      const root = document.getElementById('annotationStrip');
      if (!root) {
        return;
      }
      root.innerHTML = '';
      for (const annotation of annotations) {
        const card = document.createElement('div');
        card.className = 'annotation-card ' + annotation.tone;
        card.innerHTML =
          '<div class="annotation-kicker">' + escapeHtml(annotation.kicker) + '</div>' +
          '<div class="annotation-title">' + escapeHtml(annotation.title) + '</div>' +
          '<div class="annotation-copy">' + escapeHtml(annotation.copy) + '</div>';
        root.appendChild(card);
      }
    }

    function renderCostDrivers(timeline, session) {
      const root = document.getElementById('driversGrid');
      const empty = document.getElementById('driversEmpty');
      root.innerHTML = '';
      const drivers = buildCostDrivers(timeline.events || [], timeline.period_seconds || activePeriod, session);

      if (!timeline.events || !timeline.events.length) {
        empty.hidden = false;
        return;
      }

      empty.hidden = true;

      const cards = [
        {
          label: 'Top cost model',
          value: drivers.topModel.key || 'No model cost',
          compact: true,
          meta: drivers.topModel.key
            ? money(drivers.topModel.value) + ' · ' + drivers.topModel.sharePercent.toFixed(0) + '% of selected-window spend'
            : 'No model-attributed spend in this window.'
        },
        {
          label: 'Top cost tool',
          value: drivers.topTool.key || 'No tool cost',
          compact: true,
          meta: drivers.topTool.key
            ? money(drivers.topTool.value) + ' · ' + drivers.topTool.sharePercent.toFixed(0) + '% of selected-window spend'
            : 'No tool-attributed spend in this window.'
        },
        {
          label: 'Most expensive event',
          value: drivers.highestEvent ? money(drivers.highestEvent.cost_delta) : money(0),
          compact: false,
          meta: drivers.highestEvent
            ? eventNarrative(drivers.highestEvent) + ' · ' + timestampLabel(drivers.highestEvent.timestamp_ms)
            : 'No billable event available yet.'
        },
        {
          label: 'Top 3 concentration',
          value: drivers.topThreeSharePercent.toFixed(0) + '%',
          compact: false,
          meta: 'Share of selected-window spend driven by the three most expensive events.'
        },
        {
          label: 'Recent acceleration',
          value:
            drivers.acceleration.level === 'accelerating'
              ? 'Accelerating'
              : drivers.acceleration.level === 'cooling'
                ? 'Cooling'
                : 'Stable',
          compact: true,
          meta: drivers.acceleration.copy
        }
      ];

      for (const cardData of cards) {
        const card = document.createElement('article');
        card.className = 'driver-card';
        card.innerHTML =
          '<div class="driver-label">' + escapeHtml(cardData.label) + '</div>' +
          '<div class="driver-value' + (cardData.compact ? ' compact' : '') + '">' + escapeHtml(cardData.value) + '</div>' +
          '<div class="driver-meta">' + escapeHtml(cardData.meta) + '</div>';
        root.appendChild(card);
      }
    }

    function updateOverview(session) {
      currentSession = session;

      document.getElementById('eyebrow').textContent = 'the eyes of agentbudget · ' + session.session_id;
      document.getElementById('heroSessionId').textContent = session.session_id;
      document.getElementById('heroNarrative').textContent =
        'This session has consumed ' +
        Number(session.session_percent || 0).toFixed(2) +
        '% of budget, is currently ' +
        session.risk_label +
        ', and is being watched for burn acceleration.';
      const heroStatusChip = document.getElementById('heroStatusChip');
      heroStatusChip.textContent = session.status === 'closed' ? 'CLOSED' : session.risk_label;
      heroStatusChip.className =
        'hero-status-chip ' + (session.status === 'closed' ? 'closed' : session.risk_level);
      const currentModel =
        (session.recent_events && session.recent_events[0] && session.recent_events[0].model_label) ||
        session.dominant_model ||
        'no model yet';
      document.getElementById('heroOpsMeta').textContent =
        formatInteger(session.event_count || 0) +
        ' events • ' +
        currentModel +
        ' • updated ' +
        timeLabel(session.updated_at);

      document.getElementById('healthValue').textContent =
        money(session.total_spent) + ' / ' + money(session.budget);
      document.getElementById('healthMeta').textContent =
        money(session.remaining) + ' remains before the hard budget limit.';
      document.getElementById('healthStatus').textContent =
        session.status === 'closed'
          ? 'Session closed. Final spend is locked and no further burn is expected.'
          : 'Watch burn velocity, cost causality, and exhaustion risk from one control surface.';
      const healthState = document.getElementById('healthState');
      healthState.textContent = session.risk_label;
      healthState.className = 'health-state ' + session.risk_level;
      document.getElementById('healthGuidance').innerHTML =
        '<strong>' + escapeHtml(session.risk_label) + '</strong> means ' + escapeHtml(session.risk_copy);
      document.getElementById('healthBurnRate').textContent =
        money(session.burn_rate_per_min) + ' / min';
      document.getElementById('healthBurnDelta').textContent =
        session.burn_rate_delta_percent === null
          ? 'No previous burn window to compare yet.'
          : (session.burn_rate_delta_percent >= 0 ? '+' : '') +
            session.burn_rate_delta_percent.toFixed(0) +
            '% vs previous 5 minutes.';
      document.getElementById('healthExhaustion').textContent =
        formatDurationMinutes(session.projected_exhaustion_minutes);
      document.getElementById('healthExhaustionEta').textContent =
        formatEta(session.projected_exhaustion_eta_ms);
      document.getElementById('healthRiskLabel').textContent = session.risk_label;
      document.getElementById('healthRiskCopy').textContent = session.risk_copy;
      document.getElementById('healthAccelerationTitle').textContent =
        session.acceleration_level === 'accelerating'
          ? 'Accelerating'
          : session.acceleration_level === 'cooling'
            ? 'Cooling'
            : 'Stable';
      document.getElementById('healthAccelerationCopy').textContent = session.acceleration_copy;
      const accelerationBanner = document.getElementById('healthAccelerationBanner');
      accelerationBanner.className = 'health-alert ' + session.acceleration_level;
      accelerationBanner.textContent = session.acceleration_copy;
      document.getElementById('healthFooterLeft').textContent =
        formatInteger(session.event_count || 0) + ' billable events observed';
      document.getElementById('healthFooterCenter').textContent =
        session.dominant_model
          ? session.dominant_model + ' drives ' + Number(session.dominant_model_share_percent || 0).toFixed(0) + '% of model spend'
          : 'Dominant cost center not available yet';
      document.getElementById('healthFooterRight').textContent =
        'Updated ' + timeLabel(session.updated_at);
      document.getElementById('healthProgress').style.width =
        Math.max(0, Math.min(Number(session.session_percent || 0), 100)).toFixed(2) + '%';

      setMetricValue('metric-spent-value', money(session.total_spent));
      applyDelta(
        'metric-spent',
        'metric-spent-delta',
        compareDirection(session.last_5m_cost, session.previous_5m_cost),
        '+' + money(session.last_5m_cost).replace('$', '') + ' in last 5 min'
      );

      setMetricValue('metric-remaining-value', money(session.remaining));
      applyDelta(
        'metric-remaining',
        'metric-remaining-delta',
        invertDirection(compareDirection(session.last_5m_cost, session.previous_5m_cost)),
        '-' + money(session.last_5m_cost).replace('$', '') + ' in last 5 min'
      );

      setMetricValue('metric-messages-value', formatInteger(session.messages_count));
      applyDelta(
        'metric-messages',
        'metric-messages-delta',
        compareDirection(session.last_5m_messages, session.previous_5m_messages),
        '+' + formatInteger(session.last_5m_messages) + ' in last 5 min'
      );

      setMetricValue('metric-tokens-value', formatInteger(session.total_tokens));
      applyDelta(
        'metric-tokens',
        'metric-tokens-delta',
        compareDirection(session.last_5m_tokens, session.previous_5m_tokens),
        '+' + formatInteger(session.last_5m_tokens) + ' in last 5 min'
      );

      setMetricValue('metric-avg-cost-value', money(session.average_cost_per_message));
      document.getElementById('metric-avg-cost-delta').textContent =
        session.messages_count > 0
          ? 'Blended across ' + formatInteger(session.messages_count) + ' billable responses.'
          : 'No billable responses yet.';

      setMetricValue(
        'metric-avg-tokens-value',
        formatInteger(session.average_tokens_per_message)
      );
      document.getElementById('metric-avg-tokens-delta').textContent =
        session.messages_count > 0
          ? 'Average response size so far.'
          : 'No token baseline yet.';

      setMetricValue('metric-highest-event-value', money(session.highest_single_event_cost));
      document.getElementById('metric-highest-event-delta').textContent =
        session.highest_single_event_cost > 0
          ? 'Largest one-step jump observed in session spend.'
          : 'No billable events yet.';

      setMetricValue(
        'metric-dominant-model-value',
        session.dominant_model || 'No model yet'
      );
      document.getElementById('metric-dominant-model-delta').textContent =
        session.dominant_model
          ? Number(session.dominant_model_share_percent || 0).toFixed(0) +
            '% of model-attributed spend.'
          : 'Waiting for model-attributed spend.';

      setMetricValue(
        'metric-projected-spend-value',
        money(session.projected_session_spend || session.total_spent)
      );
      document.getElementById('metric-projected-spend-delta').textContent =
        session.projected_session_spend !== null
          ? 'If current burn holds for ~' +
            formatInteger(session.projected_session_horizon_minutes) +
            ' more min.'
          : 'Projection opens once burn is measurable.';
    }

    function renderRecentEvents(events) {
      const root = document.getElementById('eventsTable');
      const empty = document.getElementById('eventsEmpty');
      root.innerHTML = '';
      const ordered = [...(events || [])].sort(function(left, right) {
        return right.timestamp_ms - left.timestamp_ms;
      });
      if (!ordered.length) {
        empty.hidden = false;
        return;
      }
      empty.hidden = true;
      for (const [index, event] of ordered.entries()) {
        const row = document.createElement('div');
        row.className = 'event-row' + (index === 0 ? ' latest' : '');
        row.innerHTML =
          '<div class="event-muted">' + escapeHtml(timestampLabel(event.timestamp_ms)) + '</div>' +
          '<div><span class="event-badge ' + escapeHtml(event.event_kind) + '">' + escapeHtml(event.event_type_label) + '</span></div>' +
          '<div class="event-model">' + escapeHtml(event.model_label) + '</div>' +
          '<div class="event-muted">' + escapeHtml(formatInteger(event.tokens)) + ' tokens</div>' +
          '<div class="event-cost">+' + escapeHtml(money(event.cost_delta).replace('$', '$')) + '</div>';
        root.appendChild(row);
      }
    }

    function buildSpendProjectionPoints(session, timeline) {
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

    function buildBurnProjectionPoints(session, timeline) {
      if (!session || !timeline) {
        return [];
      }
      const nowMs = Number(timeline.generated_at_ms || Date.now());
      const currentBurn = Number(session.burn_rate_per_min || valueAtOrBefore(timeline.burn_rate_points || [], nowMs));
      if (currentBurn <= 0) {
        return [];
      }
      const projectionEndMs = nowMs + Math.max(timeline.period_seconds * 1000 * 0.35, 3 * 60 * 1000);
      return [
        { timestamp_ms: nowMs, value: currentBurn },
        { timestamp_ms: projectionEndMs, value: currentBurn }
      ];
    }

    function buildFallbackTimeline(session) {
      const nowMs = Date.now();
      const startMs = nowMs - activePeriod * 1000;
      const burnWindowSeconds = Math.min(300, Math.max(60, Math.round(activePeriod / 6)));
      return {
        session_id: session.session_id,
        budget: session.budget,
        period_seconds: activePeriod,
        window_start_ms: startMs,
        generated_at_ms: nowMs,
        spend_points: [
          { timestamp_ms: startMs, value: Number(session.total_spent || 0) },
          { timestamp_ms: nowMs, value: Number(session.total_spent || 0) }
        ],
        token_points: [
          { timestamp_ms: startMs, value: 0 },
          { timestamp_ms: nowMs, value: 0 }
        ],
        burn_rate_points: [
          { timestamp_ms: startMs, value: 0 },
          { timestamp_ms: nowMs, value: Number(session.burn_rate_per_min || 0) }
        ],
        burn_window_seconds: burnWindowSeconds,
        events: []
      };
    }

    function metricValueForEvent(event, timeline) {
      if (activeChartMetric === 'tokens') {
        return valueAtOrBefore(timeline.token_points || [], event.timestamp_ms);
      }
      if (activeChartMetric === 'burn') {
        return valueAtOrBefore(timeline.burn_rate_points || [], event.timestamp_ms);
      }
      return Number(event.spend_total || 0);
    }

    function nearestEventForTimestamp(events, timestampMs) {
      if (!events || !events.length) return null;
      let nearest = events[0];
      let nearestDistance = Math.abs(events[0].timestamp_ms - timestampMs);
      for (const event of events) {
        const distance = Math.abs(event.timestamp_ms - timestampMs);
        if (distance < nearestDistance) {
          nearest = event;
          nearestDistance = distance;
        }
      }
      return nearestDistance <= 90 * 1000 ? nearest : null;
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
      const tooltipSub = document.getElementById('tooltipSub');
      mount.innerHTML = '';

      const mode = getChartModeConfig();
      document.getElementById('chartPanelTitle').textContent = mode.title;
      document.getElementById('chartPanelCopy').textContent = mode.copy;
      document.getElementById('legendPrimaryLabel').textContent = mode.primaryLabel;
      document.getElementById('legendSecondaryLabel').textContent = mode.secondaryLabel;
      document.getElementById('legendTertiaryLabel').textContent = mode.tertiaryLabel;

      const drivers = buildCostDrivers(timeline.events || [], timeline.period_seconds || activePeriod, session);
      const insights = buildBudgetIntelligence(session, timeline, drivers);
      const markers = buildChartMarkers(timeline.events || [], drivers);
      renderBudgetIntelligence(insights);
      setHeroLiveInsight(insights, session, drivers);
      renderCostDrivers(timeline, session);
      renderRecentEvents(timeline.events || []);

      const actualPoints =
        activeChartMetric === 'tokens'
          ? (timeline && timeline.token_points && timeline.token_points.length
              ? timeline.token_points
              : buildFallbackTimeline(session).token_points)
          : activeChartMetric === 'burn'
            ? (timeline && timeline.burn_rate_points && timeline.burn_rate_points.length
                ? timeline.burn_rate_points
                : buildFallbackTimeline(session).burn_rate_points)
            : (timeline && timeline.spend_points && timeline.spend_points.length
                ? timeline.spend_points
                : buildFallbackTimeline(session).spend_points);
      const projectionPoints =
        activeChartMetric === 'burn'
          ? buildBurnProjectionPoints(session, timeline)
          : activeChartMetric === 'spend'
            ? buildSpendProjectionPoints(session, timeline)
            : [];

      const width = 940;
      const height = 452;
      const padding = { top: 20, right: 28, bottom: 44, left: 64 };
      const minX = Number(timeline.window_start_ms || actualPoints[0].timestamp_ms);
      const maxX = Math.max(
        Number(timeline.generated_at_ms || Date.now()),
        actualPoints[actualPoints.length - 1].timestamp_ms,
        projectionPoints[projectionPoints.length - 1] ? projectionPoints[projectionPoints.length - 1].timestamp_ms : 0,
        minX + 1
      );
      const maxY = Math.max(
        activeChartMetric === 'spend' ? Number(session.budget || 0) : 0,
        ...actualPoints.map(function(point) { return Number(point.value || 0); }),
        ...projectionPoints.map(function(point) { return Number(point.value || 0); }),
        activeChartMetric === 'tokens' ? 10 : 0.000001
      ) * (activeChartMetric === 'burn' ? 1.25 : 1.08);
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
      const yTicks = [0, 0.25, 0.5, 0.75, 1];
      const xTicks = [minX, minX + rangeX / 3, minX + (rangeX / 3) * 2, maxX];
      const grid = yTicks.map(function(ratio) {
        const y = yScale(maxY * ratio).toFixed(2);
        return '<line x1="' + padding.left + '" y1="' + y + '" x2="' + (width - padding.right) + '" y2="' + y + '" stroke="rgba(255,255,255,0.12)" stroke-width="1" />';
      }).join('');
      const yLabels = yTicks.map(function(ratio) {
        const value = maxY * ratio;
        const y = yScale(value).toFixed(2);
        return '<text x="' + (padding.left - 10) + '" y="' + (Number(y) + 4).toFixed(2) + '" fill="rgba(161,161,170,0.92)" font-size="11" text-anchor="end">' + formatAxisValue(activeChartMetric, value) + '</text>';
      }).join('');
      const xLabels = xTicks.map(function(value, index) {
        const x = xScale(value).toFixed(2);
        const anchor = index === 0 ? 'start' : index === xTicks.length - 1 ? 'end' : 'middle';
        return '<text x="' + x + '" y="' + (height - 12) + '" fill="rgba(161,161,170,0.88)" font-size="11" text-anchor="' + anchor + '">' + new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '</text>';
      }).join('');
      const markerStack = new Map();
      const markerLayer = markers.map(function(marker) {
        const cx = xScale(marker.timestamp_ms);
        const cy = yScale(metricValueForEvent(marker, timeline));
        const tone = marker.event_kind === 'tool' ? '#67e8f9' : '#ddd6fe';
        const stackKey = String(marker.timestamp_ms);
        const stackIndex = markerStack.get(stackKey) || 0;
        markerStack.set(stackKey, stackIndex + 1);
        const labelY = Math.max(cy - 16 - stackIndex * 12, padding.top + 12);
        return (
          '<line x1="' + cx.toFixed(2) + '" y1="' + cy.toFixed(2) + '" x2="' + cx.toFixed(2) + '" y2="' + (height - padding.bottom) + '" stroke="rgba(255,255,255,0.08)" stroke-dasharray="3 5" />' +
          '<circle cx="' + cx.toFixed(2) + '" cy="' + cy.toFixed(2) + '" r="5.5" fill="#09090b" stroke="' + tone + '" stroke-width="2" />' +
          '<circle cx="' + cx.toFixed(2) + '" cy="' + cy.toFixed(2) + '" r="10" fill="' + (marker.event_kind === 'tool' ? 'rgba(6,182,212,0.12)' : 'rgba(139,92,246,0.14)') + '" />' +
          '<text x="' + cx.toFixed(2) + '" y="' + labelY.toFixed(2) + '" fill="' + tone + '" font-size="11" font-family="SFMono-Regular, Menlo, monospace" text-anchor="middle">' + escapeHtml(marker.label) + '</text>'
        );
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
            '<stop offset="0%" stop-color="rgba(167,139,250,0.26)"></stop>' +
            '<stop offset="100%" stop-color="rgba(167,139,250,0)"></stop>' +
          '</linearGradient>' +
          '<linearGradient id="budget-zone-gradient" x1="0%" y1="0%" x2="0%" y2="100%">' +
            '<stop offset="0%" stop-color="rgba(251,113,133,0.28)"></stop>' +
            '<stop offset="100%" stop-color="rgba(245,158,11,0.08)"></stop>' +
          '</linearGradient>' +
          '<filter id="line-glow" x="-30%" y="-30%" width="160%" height="160%">' +
            '<feGaussianBlur stdDeviation="7" result="blur"></feGaussianBlur>' +
            '<feMerge><feMergeNode in="blur"></feMergeNode><feMergeNode in="SourceGraphic"></feMergeNode></feMerge>' +
          '</filter>' +
          '<filter id="projection-glow" x="-30%" y="-30%" width="160%" height="160%">' +
            '<feGaussianBlur stdDeviation="4" result="blur"></feGaussianBlur>' +
            '<feMerge><feMergeNode in="blur"></feMergeNode><feMergeNode in="SourceGraphic"></feMergeNode></feMerge>' +
          '</filter>' +
        '</defs>' +
        (activeChartMetric === 'spend'
          ? (
              '<rect x="' + padding.left + '" y="' + alertTop.toFixed(2) + '" width="' + (width - padding.left - padding.right) + '" height="' + Math.max(alertBottom - alertTop, 0).toFixed(2) + '" fill="url(#budget-zone-gradient)" />' +
              '<line x1="' + padding.left + '" y1="' + alertBottom.toFixed(2) + '" x2="' + (width - padding.right) + '" y2="' + alertBottom.toFixed(2) + '" stroke="rgba(245,158,11,0.55)" stroke-width="1.5" stroke-dasharray="7 8" />' +
              '<text x="' + (width - padding.right - 6) + '" y="' + (alertTop + 16).toFixed(2) + '" fill="rgba(253,186,116,0.92)" font-size="11" text-anchor="end">risk zone</text>'
            )
          : '') +
        grid +
        yLabels +
        xLabels +
        '<path d="' + area + '" fill="url(#chart-area-gradient)"></path>' +
        (activeChartMetric === 'spend'
          ? '<line x1="' + padding.left + '" y1="' + yScale(Number(session.budget || 0)).toFixed(2) + '" x2="' + (width - padding.right) + '" y2="' + yScale(Number(session.budget || 0)).toFixed(2) + '" stroke="#f59e0b" stroke-width="2.4" stroke-dasharray="8 8" opacity="0.98" />'
          : '') +
        (projectionPath
          ? '<path d="' + projectionPath + '" fill="none" stroke="rgba(244,114,182,0.92)" stroke-width="3.2" stroke-linecap="round" stroke-dasharray="10 7" filter="url(#projection-glow)" />'
          : '') +
        '<path d="' + actualPath + '" fill="none" stroke="url(#chart-line-gradient)" stroke-width="' + (activeChartMetric === 'burn' ? '3.6' : '4.4') + '" stroke-linecap="round" stroke-linejoin="round" filter="url(#line-glow)" />' +
        markerLayer +
        '<line x1="' + padding.left + '" y1="' + (height - padding.bottom) + '" x2="' + (width - padding.right) + '" y2="' + (height - padding.bottom) + '" stroke="rgba(255,255,255,0.12)" stroke-width="1" />' +
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
        const nearestEvent = nearestEventForTimestamp(timeline.events || [], nearest.timestamp_ms);
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
        tooltipValue.textContent = formatMetricValue(activeChartMetric, nearest.value);
        tooltipSub.textContent = nearestEvent
          ? eventNarrative(nearestEvent) +
            ' · ' +
            nearestEvent.model_label +
            ' · +' +
            money(nearestEvent.cost_delta) +
            ' · ' +
            formatInteger(nearestEvent.tokens) +
            ' tokens'
          : 'Selected ' + CHART_MODES.find(function(modeOption) { return modeOption.value === activeChartMetric; }).label.toLowerCase() + ' point';
      }

      svg.addEventListener('mousemove', handleMove);
      svg.addEventListener('mouseleave', hideTooltip);
    }

    async function refresh() {
      if (!sessionId) {
        showError('Missing sessionId in the URL.');
        return;
      }

      const [sessionResult, timelineResult] = await Promise.allSettled([
        fetchJson(
          '/api/dashboard/session?sessionId=' + encodeURIComponent(sessionId),
          'Could not load session summary.'
        ),
        fetchJson(
          '/api/dashboard/timeline?sessionId=' + encodeURIComponent(sessionId) + '&period=' + activePeriod,
          'Could not load spend progression.'
        )
      ]);

      let session = currentSession;
      if (sessionResult.status === 'fulfilled') {
        session = sessionResult.value;
        clearError();
        clearModuleWarning('summaryWarning');
        updateOverview(session);
      } else if (!currentSession) {
        showError(sessionResult.reason instanceof Error ? sessionResult.reason.message : String(sessionResult.reason));
        return;
      } else {
        clearError();
        showModuleWarning('summaryWarning', 'Summary refresh paused. Showing last known metrics.');
      }

      if (!session) {
        return;
      }

      let timeline = currentTimeline;
      if (timelineResult.status === 'fulfilled') {
        timeline = timelineResult.value;
        clearModuleWarning('chartWarning');
        renderMainChart(session, timeline);
      } else {
        showModuleWarning(
          'chartWarning',
          currentTimeline
            ? 'Spend progression refresh paused. Showing last known chart.'
            : 'Spend progression is temporarily unavailable.'
        );
        timeline = currentTimeline || buildFallbackTimeline(session);
        renderMainChart(session, timeline);
      }
    }

    buildFilters();
    buildMetricFilters();
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
