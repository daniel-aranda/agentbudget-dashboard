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
    ).then((response) => response.json())) as { session_id: string; total_spent: number };
    assert.equal(summary.session_id, tracked.id);
    assert.equal(summary.total_spent, 0.25);

    const timeline = (await fetch(
      `${baseUrl}/api/dashboard/timeline?sessionId=${encodeURIComponent(tracked.id)}&period=last_hour`
    ).then((response) => response.json())) as { tools: Array<{ key: string }> };
    assert.equal(timeline.tools.length, 1);
    assert.equal(timeline.tools[0]?.key, "scraper");
  } finally {
    await tracked.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});
