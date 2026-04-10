# AgentBudget Dashboard

**The eyes of AgentBudget.**
Real-time budget intelligence, spend observability, and session risk visibility for AI agent workflows.

AgentBudget enforces hard spending limits.
This dashboard helps teams **see where spend moved, why it moved, and what happens next**.

It transforms raw budget enforcement into **live operational visibility**.

---

## Why this exists

AI agents do not just need hard limits.

Teams need to understand:

* what is driving spend
* which model or tool is causing cost spikes
* how fast the session is burning
* whether budget exhaustion is approaching
* what changed in the last few minutes

AgentBudget already solves **budget enforcement**.

This project extends that into **budget intelligence and real-time observability**.

Think of it as the **mission control layer for AgentBudget sessions**.

---

## Core idea

This dashboard is built as a companion product for the AgentBudget SDK.

While the SDK answers:

> **Should this session continue?**

This dashboard answers:

> **Why is spend moving and what is causing the risk?**

That visibility layer is critical for:

* product teams
* infra teams
* AI platform teams
* founders running AI-heavy workflows
* enterprise observability use cases

---

## What you can see

🔍 View full dashboard preview:  
[Open full-size image](https://github.com/user-attachments/assets/d88b3288-d7f5-444c-a769-854d9d1c643e)

### Live budget health

Track session health in real time with:

* total spent
* remaining budget
* burn rate
* risk status
* projected exhaustion

Status states include:

* **SAFE**
* **WATCH**
* **DANGER**

---

### Spend progression

Visualize how session cost evolves over time.

Includes:

* actual spend
* projected spend
* budget zone
* burn velocity
* trend windows

Time windows:

* last minute
* last 3 minutes
* last 5 minutes
* last 10 minutes
* last 30 minutes
* last hour
* last 6 hours

---

### Cost drivers

Understand what is moving spend.

Examples:

* most expensive model
* most expensive tool
* largest single event
* top cost contributors
* recent acceleration

This turns spend tracking into **causal analysis**.

---

### Session timeline

A narrative timeline of spend events.

Each event can show:

* timestamp
* event type
* model
* tokens
* cost delta

This makes it easy to answer:

> **What happened right before cost increased?**

---

## Architecture

This project intentionally lives outside the core AgentBudget SDK.

The goal is to keep:

* **core enforcement lightweight**
* **observability extensible**
* **storage pluggable**

This allows the dashboard to evolve independently.

### Components

* **TrackedBudgetSession**
* **timeline store**
* **dashboard UI**
* **demo application**
* **memory / Redis persistence**

---

## Supported stores

### In-memory

Perfect for local development and demos.

### Redis

Recommended for production and multi-session persistence.

This enables:

* session recovery
* shared team visibility
* live dashboards across instances
* historical analysis

---

## Product vision

AgentBudget protects budgets.

This dashboard helps teams operate them.

The long-term vision is to evolve this into a full **AI spend observability layer**.

Potential capabilities:

* projected budget exhaustion ETA
* anomaly detection
* model cost comparison
* per-tool cost attribution
* org-level dashboards
* team-based spend views
* alerts and notifications
* session replay
* spend anomaly timeline

---

## Why this matters

AI agent costs can escalate quickly.

A loop, oversized responses, or excessive tool usage can burn through budget unexpectedly.

Hard limits stop the damage.

Visibility helps prevent it.

This project is built around the belief that teams need both:

* **enforcement**
* **observability**

Together, they create operational confidence for AI systems in production.

---

## Positioning

A simple way to think about this project:

> **AgentBudget enforces the limit.
> This dashboard gives teams the eyes to understand it.**

---

## Demo

Live dashboard example includes:

* session spend
* risk projection
* cost timeline
* event breakdown
* model attribution

---

## Contributing

Ideas and feedback are welcome.

Particularly interested in:

* observability workflows
* AI infra tooling
* enterprise budget governance
* cost anomaly detection
* agent platform integrations

---

Built with the vision of becoming the **official observability companion for AgentBudget**.
