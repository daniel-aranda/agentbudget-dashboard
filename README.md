# AgentBudget Dashboard

Open-source dashboard, timeline store, and demo app for watching [AgentBudget](https://github.com/AgentBudget/agentbudget) spend move in real time.

This repo is intentionally separate from `agentbudget` itself:

- `agentbudget` stays a library
- this repo owns the dashboard, timeline persistence, and example app
- Redis is supported here without forcing infra into the core SDK

## What You Get

- `TrackedBudgetSession` wrapper on top of `@agentbudget/agentbudget`
- `MemoryTimelineStore` for zero-infra local runs
- `RedisTimelineStore` for shared or multi-process timelines
- built-in dashboard page with `llm/by_model` and `tools/by_tool`
- demo chat app that asks for your OpenAI or Anthropic API key and lets you watch spend in another tab

<img width="1106" height="1458" alt="image" src="https://github.com/user-attachments/assets/6c83050b-f893-426b-b355-6002bd2e8063" />

## Quick Start

### 1. Install

```bash
npm install
```

### 2. Run with zero infra

This uses the in-memory timeline store:

```bash
npm run dev
```

Open:

- Chat app: [http://127.0.0.1:3000](http://127.0.0.1:3000)
- Dashboard: created per session from the chat UI

### 3. Run with Redis

Start Redis:

```bash
docker compose up redis
```

Then run the app against Redis:

```bash
TIMELINE_STORE=redis npm run dev
```

You can also point to a custom Redis URL:

```bash
AGENTBUDGET_DASHBOARD_REDIS_URL=redis://127.0.0.1:6379/0 TIMELINE_STORE=redis npm run dev
```

## Demo Flow

1. Pick `OpenAI` or `Anthropic`
2. Paste an API key
3. Choose a model and budget
4. Create a session
5. Open the dashboard in a second tab
6. Send chat messages and watch spend update live

API keys are only kept in the Node process memory for the demo session. They are not written into the timeline store.

## Scripts

```bash
npm run dev
npm run start
npm run typecheck
npm test
```

## Library Example

```ts
import { AgentBudget } from "@agentbudget/agentbudget";
import { MemoryTimelineStore, TrackedBudgetSession } from "agentbudget-dashboard";

const tracked = await TrackedBudgetSession.start(
  new AgentBudget("$5.00"),
  new MemoryTimelineStore()
);

await tracked.wrapUsage("gpt-4o", 100, 50);
console.log(tracked.report());
await tracked.close();
```
