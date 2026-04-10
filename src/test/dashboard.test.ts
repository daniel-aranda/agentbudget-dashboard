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
      recent_events: Array<{ event_type_label: string }>;
    };
    assert.equal(summary.session_id, tracked.id);
    assert.equal(summary.messages_count, 1);
    assert.equal(summary.total_tokens, 150);
    assert.equal(summary.recent_events.length, 2);
    assert.deepEqual(
      summary.recent_events.map((event) => event.event_type_label).sort(),
      ["assistant response", "tool event"]
    );
    assert.ok(summary.total_spent > 0.25);

    const timeline = (await fetch(
      `${baseUrl}/api/dashboard/timeline?sessionId=${encodeURIComponent(tracked.id)}&period=last_hour`
    ).then((response) => response.json())) as {
      budget: number;
      spend_points: Array<{ value: number }>;
    };
    assert.equal(timeline.budget, 5);
    assert.ok(timeline.spend_points.length >= 2);
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
