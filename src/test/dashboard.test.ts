import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { AgentBudget } from "@agentbudget/agentbudget";

import { handleDashboardRequest } from "../lib/dashboard.js";
import { MemoryTimelineStore } from "../lib/timeline.js";
import { TrackedBudgetSession } from "../lib/tracked-session.js";

test("dashboard routes expose session summary and aggregated timeline", async () => {
  const store = new MemoryTimelineStore();
  const tracked = await TrackedBudgetSession.start(new AgentBudget("$5.00"), store, {
    id: "sess_dash",
  });
  await tracked.wrapUsage("gpt-5.4-mini", 100, 50);
  await tracked.track(null, 0.25, "scraper");

  const server = createServer(async (request, response) => {
    if (await handleDashboardRequest(request, response, store)) {
      return;
    }
    response.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://${address.address}:${address.port}`;

  try {
    const summary = (await fetch(
      `${baseUrl}/api/dashboard/session?sessionId=${encodeURIComponent(tracked.id)}`
    ).then((response) => response.json())) as {
      session_id: string;
      total_spent: number;
      messages_count: number;
      total_tokens: number;
      average_cost_per_message: number;
      average_tokens_per_message: number;
      dominant_model: string | null;
      highest_single_event_cost: number;
      projected_session_spend: number | null;
      risk_label: string;
      recent_events: Array<{ event_type_label: string }>;
    };
    assert.equal(summary.session_id, tracked.id);
    assert.equal(summary.messages_count, 1);
    assert.equal(summary.total_tokens, 150);
    assert.ok(summary.average_cost_per_message > 0);
    assert.equal(summary.average_tokens_per_message, 150);
    assert.equal(summary.dominant_model, "gpt-5.4-mini");
    assert.equal(summary.highest_single_event_cost, 0.25);
    assert.ok(summary.projected_session_spend !== null);
    assert.ok(["SAFE", "WATCH", "DANGER"].includes(summary.risk_label));
    assert.equal(summary.recent_events.length, 2);
    assert.deepEqual(
      summary.recent_events.map((event) => event.event_type_label).sort(),
      ["assistant response", "tool call"]
    );
    assert.ok(summary.total_spent > 0.25);

    const timeline = (await fetch(
      `${baseUrl}/api/dashboard/timeline?sessionId=${encodeURIComponent(tracked.id)}&period=last_hour`
    ).then((response) => response.json())) as {
      budget: number;
      spend_points: Array<{ value: number }>;
      token_points: Array<{ value: number }>;
      burn_rate_points: Array<{ value: number }>;
      burn_window_seconds: number;
      events: Array<{ event_type_label: string; model_label: string }>;
    };
    assert.equal(timeline.budget, 5);
    assert.ok(timeline.spend_points.length >= 2);
    assert.ok(timeline.token_points.length >= 2);
    assert.ok(timeline.burn_rate_points.length >= 2);
    assert.ok(timeline.burn_window_seconds >= 60);
    assert.equal(timeline.events.length, 2);
    assert.equal(timeline.events[0]?.model_label, "gpt-5.4-mini");
    const lastPoint = timeline.spend_points.at(-1);
    assert.ok(lastPoint);
    assert.ok(lastPoint.value > 0.25);
  } finally {
    await tracked.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});
