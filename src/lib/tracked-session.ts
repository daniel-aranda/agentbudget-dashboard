import {
  AgentBudget,
  type AnthropicMessageLike,
  type BudgetSession,
  type OpenAICompletionLike,
  type Report,
  type SessionOptions,
} from "@agentbudget/agentbudget";

import { round6, type SessionMetadata, type TimelineEvent, type TimelineStore } from "./timeline.js";

type ProviderCategory = "llm" | "tool";

export class TrackedBudgetSession {
  private readonly categoryTotals = {
    llm: new Map<string, number>(),
    tool: new Map<string, number>(),
  };

  private closed = false;

  private constructor(
    private readonly session: BudgetSession,
    private readonly store: TimelineStore
  ) {}

  static async start(
    budget: AgentBudget,
    store: TimelineStore,
    opts?: SessionOptions
  ): Promise<TrackedBudgetSession> {
    const session = budget.newSession(opts);
    const tracked = new TrackedBudgetSession(session, store);
    const report = session.report();
    await store.registerSession(session.id, report.budget, Date.now() / 1000);
    return tracked;
  }

  get id(): string {
    return this.session.id;
  }

  get spent(): number {
    return this.session.spent;
  }

  get remaining(): number {
    return this.session.remaining;
  }

  report(): Report {
    return this.session.report();
  }

  rawSession(): BudgetSession {
    return this.session;
  }

  async wrapUsage(model: string, inputTokens: number, outputTokens: number): Promise<void> {
    try {
      this.session.wrapUsage(model, inputTokens, outputTokens);
      await this.recordLLM(model, inputTokens, outputTokens);
    } catch (error) {
      await this.syncSessionMetadata();
      throw error;
    }
  }

  async wrapOpenAI<T extends OpenAICompletionLike>(response: T): Promise<T> {
    try {
      const wrapped = this.session.wrapOpenAI(response);
      const usage = response.usage;
      if (usage) {
        await this.recordLLM(response.model, usage.prompt_tokens, usage.completion_tokens);
      }
      return wrapped;
    } catch (error) {
      await this.syncSessionMetadata();
      throw error;
    }
  }

  async wrapAnthropic<T extends AnthropicMessageLike>(response: T): Promise<T> {
    try {
      const wrapped = this.session.wrapAnthropic(response);
      await this.recordLLM(
        response.model,
        response.usage.input_tokens,
        response.usage.output_tokens
      );
      return wrapped;
    } catch (error) {
      await this.syncSessionMetadata();
      throw error;
    }
  }

  async track<T>(
    result: T,
    cost: number,
    toolName?: string,
    metadata?: Record<string, unknown>
  ): Promise<T> {
    try {
      const tracked = this.session.track(result, cost, toolName, metadata);
      await this.recordTool(cost, toolName, metadata);
      return tracked;
    } catch (error) {
      await this.syncSessionMetadata();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.session.close();
    await this.syncSessionMetadata();
    this.closed = true;
  }

  private async recordLLM(
    model: string,
    inputTokens: number,
    outputTokens: number
  ): Promise<void> {
    const report = this.session.report();
    const lastEvent = this.lastEventBase(report, "llm", model, {
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    });
    await this.store.appendEvent(this.id, lastEvent);
  }

  private async recordTool(
    cost: number,
    toolName?: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    const report = this.session.report();
    const lastEvent = this.lastEventBase(report, "tool", toolName ?? "unlabeled", {
      cost_override: cost,
      ...(toolName ? { tool_name: toolName } : {}),
      ...(metadata ? { metadata } : {}),
    });
    await this.store.appendEvent(this.id, lastEvent);
  }

  private lastEventBase(
    report: Report,
    type: ProviderCategory,
    categoryKey: string,
    extra: {
      model?: string;
      tool_name?: string;
      input_tokens?: number;
      output_tokens?: number;
      metadata?: Record<string, unknown>;
      cost_override?: number;
    }
  ): TimelineEvent {
    const cost =
      extra.cost_override ??
      this.calculateIncrement(report, type, categoryKey);
    const total = this.incrementCategory(type, categoryKey, cost);
    const timestampMs = Date.now();

    return {
      session_id: this.id,
      timestamp: timestampMs / 1000,
      timestamp_ms: timestampMs,
      budget: round6(report.budget),
      cost: round6(cost),
      event_type: type,
      event_count: report.event_count,
      category_key: categoryKey,
      category_total: round6(total),
      total_spent: round6(report.total_spent),
      remaining: round6(report.remaining),
      ...(extra.model ? { model: extra.model } : {}),
      ...(extra.tool_name ? { tool_name: extra.tool_name } : {}),
      ...(extra.input_tokens !== undefined ? { input_tokens: extra.input_tokens } : {}),
      ...(extra.output_tokens !== undefined ? { output_tokens: extra.output_tokens } : {}),
      ...(extra.metadata ? { metadata: extra.metadata } : {}),
    };
  }

  private incrementCategory(type: ProviderCategory, key: string, cost: number): number {
    const map = type === "llm" ? this.categoryTotals.llm : this.categoryTotals.tool;
    const next = round6((map.get(key) ?? 0) + cost);
    map.set(key, next);
    return next;
  }

  private calculateIncrement(
    report: Report,
    type: ProviderCategory,
    key: string
  ): number {
    const breakdown = report.breakdown as {
      llm?: { by_model?: Record<string, number> };
      tools?: { by_tool?: Record<string, number> };
    };

    if (type === "llm") {
      const current = breakdown.llm?.by_model?.[key] ?? 0;
      const previous = this.categoryTotals.llm.get(key) ?? 0;
      return round6(current - previous);
    }

    const current = breakdown.tools?.by_tool?.[key] ?? 0;
    const previous = this.categoryTotals.tool.get(key) ?? 0;
    return round6(current - previous);
  }

  private async syncSessionMetadata(): Promise<void> {
    const report = this.session.report();
    const payload: Partial<SessionMetadata> = {
      budget: round6(report.budget),
      total_spent: round6(report.total_spent),
      remaining: round6(report.remaining),
      event_count: report.event_count,
      terminated_by: report.terminated_by,
      duration_seconds: report.duration_seconds,
      updated_at: Date.now() / 1000,
      status: report.terminated_by ? "closed" : this.closed ? "closed" : "running",
    };
    await this.store.closeSession(this.id, payload);
  }
}
