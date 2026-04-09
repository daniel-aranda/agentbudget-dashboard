import assert from "node:assert/strict";
import test from "node:test";

import { AgentBudget } from "@agentbudget/agentbudget";

import { MemoryTimelineStore } from "../lib/timeline.js";
import { TrackedBudgetSession } from "../lib/tracked-session.js";

test("TrackedBudgetSession writes tool and llm events into the timeline store", async () => {
  const store = new MemoryTimelineStore();
  const tracked = await TrackedBudgetSession.start(new AgentBudget("$5.00"), store, {
    id: "sess_test",
  });

  await tracked.track(null, 0.01, "serp_api");
  await tracked.wrapUsage("gpt-4o", 100, 50);
  await tracked.close();

  const session = await store.getSession("sess_test");
  const events = await store.getEvents("sess_test", 0);

  assert.ok(session);
  assert.equal(session.status, "closed");
  assert.equal(session.event_count, 2);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.tool_name, "serp_api");
  assert.equal(events[1]?.model, "gpt-4o");
});

test("TrackedBudgetSession prices modern aliased models", async () => {
  const store = new MemoryTimelineStore();
  const tracked = await TrackedBudgetSession.start(new AgentBudget("$5.00"), store, {
    id: "sess_modern_models",
  });

  await tracked.wrapUsage("gpt-5.4-mini", 1000, 200);
  await tracked.wrapUsage("claude-sonnet-4-0", 1000, 200);
  await tracked.close();

  const session = await store.getSession("sess_modern_models");
  const events = await store.getEvents("sess_modern_models", 0);

  assert.ok(session);
  assert.ok((session.total_spent ?? 0) > 0);
  assert.equal(events.length, 2);
  assert.ok((events[0]?.cost ?? 0) > 0);
  assert.ok((events[1]?.cost ?? 0) > 0);
});
