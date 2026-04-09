import { Socket } from "node:net";
import { URL } from "node:url";

export interface SessionMetadata {
  session_id: string;
  budget: number;
  started_at: number;
  updated_at: number;
  status: "running" | "closed";
  total_spent: number;
  remaining: number;
  event_count: number;
  terminated_by?: string | null;
  duration_seconds?: number | null;
}

export interface TimelineEvent {
  session_id: string;
  timestamp: number;
  timestamp_ms: number;
  budget: number;
  cost: number;
  event_type: "llm" | "tool";
  event_count: number;
  category_key: string;
  category_total: number;
  total_spent: number;
  remaining: number;
  model?: string;
  tool_name?: string;
  input_tokens?: number;
  output_tokens?: number;
  metadata?: Record<string, unknown>;
}

export interface TimelinePoint {
  timestamp_ms: number;
  value: number;
}

export interface TimelineCard {
  key: string;
  points: TimelinePoint[];
  last_value: number;
}

export interface TimelinePayload {
  session: SessionMetadata;
  period_seconds: number;
  generated_at_ms: number;
  llm: TimelineCard[];
  tools: TimelineCard[];
}

export interface TimelineStore {
  registerSession(sessionId: string, budget: number, startedAt: number): Promise<void>;
  appendEvent(sessionId: string, payload: TimelineEvent): Promise<void>;
  closeSession(sessionId: string, payload: Partial<SessionMetadata>): Promise<void>;
  getSession(sessionId: string): Promise<SessionMetadata | null>;
  getEvents(
    sessionId: string,
    startTimestampMs: number,
    endTimestampMs?: number
  ): Promise<TimelineEvent[]>;
}

export class MemoryTimelineStore implements TimelineStore {
  private readonly sessions = new Map<string, SessionMetadata>();
  private readonly events = new Map<string, TimelineEvent[]>();

  async registerSession(sessionId: string, budget: number, startedAt: number): Promise<void> {
    this.sessions.set(sessionId, {
      session_id: sessionId,
      budget: round6(budget),
      started_at: startedAt,
      updated_at: startedAt,
      status: "running",
      total_spent: 0,
      remaining: round6(budget),
      event_count: 0,
    });
    this.events.set(sessionId, []);
  }

  async appendEvent(sessionId: string, payload: TimelineEvent): Promise<void> {
    const events = this.events.get(sessionId) ?? [];
    events.push(payload);
    this.events.set(sessionId, events);

    const current = this.sessions.get(sessionId);
    if (current) {
      this.sessions.set(sessionId, {
        ...current,
        updated_at: payload.timestamp,
        total_spent: payload.total_spent,
        remaining: payload.remaining,
        event_count: payload.event_count,
        budget: payload.budget,
      });
    }
  }

  async closeSession(sessionId: string, payload: Partial<SessionMetadata>): Promise<void> {
    const current = this.sessions.get(sessionId);
    if (!current) return;
    this.sessions.set(sessionId, {
      ...current,
      ...payload,
      status: "closed",
      updated_at: payload.updated_at ?? Date.now() / 1000,
    });
  }

  async getSession(sessionId: string): Promise<SessionMetadata | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async getEvents(
    sessionId: string,
    startTimestampMs: number,
    endTimestampMs?: number
  ): Promise<TimelineEvent[]> {
    return (this.events.get(sessionId) ?? []).filter((event) => {
      if (event.timestamp_ms < startTimestampMs) return false;
      if (endTimestampMs !== undefined && event.timestamp_ms > endTimestampMs) return false;
      return true;
    });
  }
}

type RespValue = string | number | null | RespValue[];

interface ParsedResp {
  value: RespValue;
  offset: number;
}

export class RedisTimelineStore implements TimelineStore {
  private readonly host: string;
  private readonly port: number;
  private readonly password: string | undefined;
  private readonly db: number;
  private readonly namespace: string;

  constructor(opts: { redisUrl?: string; namespace?: string } = {}) {
    const url = new URL(defaultRedisUrl(opts.redisUrl));
    if (url.protocol !== "redis:") {
      throw new Error("RedisTimelineStore only supports redis:// URLs without TLS");
    }
    this.host = url.hostname || "127.0.0.1";
    this.port = Number(url.port || 6379);
    this.password = url.password || undefined;
    const dbPart = url.pathname.replace("/", "");
    this.db = dbPart ? Number(dbPart) : 0;
    if (Number.isNaN(this.db)) {
      throw new Error(`Invalid Redis database index in URL: ${url.pathname}`);
    }
    this.namespace = opts.namespace ?? "agentbudget-dashboard";
  }

  async registerSession(sessionId: string, budget: number, startedAt: number): Promise<void> {
    const payload: SessionMetadata = {
      session_id: sessionId,
      budget: round6(budget),
      started_at: startedAt,
      updated_at: startedAt,
      status: "running",
      total_spent: 0,
      remaining: round6(budget),
      event_count: 0,
    };
    await this.setJson(this.sessionKey(sessionId), payload);
  }

  async appendEvent(sessionId: string, payload: TimelineEvent): Promise<void> {
    await this.execute(["ZADD", this.timelineKey(sessionId), String(payload.timestamp_ms), JSON.stringify(payload)]);
    const current = await this.getSession(sessionId);
    await this.setJson(this.sessionKey(sessionId), {
      session_id: sessionId,
      budget: payload.budget,
      started_at: current?.started_at ?? payload.timestamp,
      updated_at: payload.timestamp,
      status: "running",
      total_spent: payload.total_spent,
      remaining: payload.remaining,
      event_count: payload.event_count,
    } satisfies SessionMetadata);
  }

  async closeSession(sessionId: string, payload: Partial<SessionMetadata>): Promise<void> {
    const current =
      (await this.getSession(sessionId)) ??
      ({
        session_id: sessionId,
        budget: 0,
        started_at: Date.now() / 1000,
        updated_at: Date.now() / 1000,
        status: "running",
        total_spent: 0,
        remaining: 0,
        event_count: 0,
      } satisfies SessionMetadata);

    await this.setJson(this.sessionKey(sessionId), {
      ...current,
      ...payload,
      session_id: sessionId,
      status: "closed",
      updated_at: Date.now() / 1000,
    } satisfies SessionMetadata);
  }

  async getSession(sessionId: string): Promise<SessionMetadata | null> {
    const value = await this.execute(["GET", this.sessionKey(sessionId)]);
    if (value === null) return null;
    if (typeof value !== "string") {
      throw new Error(`Unexpected Redis response for session metadata: ${String(value)}`);
    }
    return JSON.parse(value) as SessionMetadata;
  }

  async getEvents(
    sessionId: string,
    startTimestampMs: number,
    endTimestampMs?: number
  ): Promise<TimelineEvent[]> {
    const value = await this.execute([
      "ZRANGEBYSCORE",
      this.timelineKey(sessionId),
      String(startTimestampMs),
      endTimestampMs === undefined ? "+inf" : String(endTimestampMs),
    ]);
    if (value === null) return [];
    if (!Array.isArray(value)) {
      throw new Error(`Unexpected Redis response for timeline query: ${String(value)}`);
    }
    return value.map((entry) => JSON.parse(String(entry)) as TimelineEvent);
  }

  private async setJson(key: string, payload: SessionMetadata): Promise<void> {
    await this.execute(["SET", key, JSON.stringify(payload)]);
  }

  private sessionKey(sessionId: string): string {
    return `${this.namespace}:session:${sessionId}`;
  }

  private timelineKey(sessionId: string): string {
    return `${this.namespace}:timeline:${sessionId}`;
  }

  private async execute(parts: string[]): Promise<RespValue> {
    const commands: string[][] = [];
    if (this.password) commands.push(["AUTH", this.password]);
    if (this.db > 0) commands.push(["SELECT", String(this.db)]);
    commands.push(parts);

    return new Promise<RespValue>((resolve, reject) => {
      const socket = new Socket();
      let buffer = Buffer.alloc(0);
      const responses: RespValue[] = [];

      socket.setTimeout(1000);
      socket.once("error", (error) => {
        reject(
          new Error(
            `Could not connect to Redis timeline store at redis://${this.host}:${this.port}/${this.db}: ${error.message}`
          )
        );
      });
      socket.once("timeout", () => {
        socket.destroy();
        reject(
          new Error(
            `Timed out connecting to Redis timeline store at redis://${this.host}:${this.port}/${this.db}`
          )
        );
      });
      socket.on("data", (chunk) => {
        try {
          buffer = Buffer.concat([buffer, chunk]);
          while (responses.length < commands.length) {
            const parsed = parseResp(buffer);
            if (!parsed) break;
            responses.push(parsed.value);
            buffer = buffer.subarray(parsed.offset);
          }
          if (responses.length === commands.length) {
            socket.end();
            resolve(responses[responses.length - 1] ?? null);
          }
        } catch (error) {
          socket.destroy();
          reject(error as Error);
        }
      });
      socket.connect(this.port, this.host, () => {
        socket.write(commands.map((command) => encodeCommand(command)).join(""));
      });
    });
  }
}

function defaultRedisUrl(redisUrl?: string): string {
  return (
    redisUrl ??
    process.env["AGENTBUDGET_DASHBOARD_REDIS_URL"] ??
    process.env["AGENTBUDGET_REDIS_URL"] ??
    "redis://127.0.0.1:6379/0"
  );
}

function encodeCommand(parts: string[]): string {
  let out = `*${parts.length}\r\n`;
  for (const part of parts) {
    out += `$${Buffer.byteLength(part)}\r\n${part}\r\n`;
  }
  return out;
}

function parseResp(buffer: Buffer): ParsedResp | null {
  if (!buffer.length) return null;
  const prefix = String.fromCharCode(buffer[0] ?? 0);

  if (prefix === "+" || prefix === "-" || prefix === ":") {
    const lineEnd = buffer.indexOf("\r\n");
    if (lineEnd === -1) return null;
    const body = buffer.subarray(1, lineEnd).toString("utf8");
    if (prefix === "-") throw new Error(body);
    if (prefix === ":") return { value: Number(body), offset: lineEnd + 2 };
    return { value: body, offset: lineEnd + 2 };
  }

  if (prefix === "$") {
    const lineEnd = buffer.indexOf("\r\n");
    if (lineEnd === -1) return null;
    const size = Number(buffer.subarray(1, lineEnd).toString("utf8"));
    if (size === -1) return { value: null, offset: lineEnd + 2 };
    const end = lineEnd + 2 + size + 2;
    if (buffer.length < end) return null;
    return {
      value: buffer.subarray(lineEnd + 2, lineEnd + 2 + size).toString("utf8"),
      offset: end,
    };
  }

  if (prefix === "*") {
    const lineEnd = buffer.indexOf("\r\n");
    if (lineEnd === -1) return null;
    const size = Number(buffer.subarray(1, lineEnd).toString("utf8"));
    if (size === -1) return { value: null, offset: lineEnd + 2 };
    let offset = lineEnd + 2;
    const values: RespValue[] = [];
    for (let index = 0; index < size; index += 1) {
      const parsed = parseResp(buffer.subarray(offset));
      if (!parsed) return null;
      values.push(parsed.value);
      offset += parsed.offset;
    }
    return { value: values, offset };
  }

  throw new Error(`Unsupported Redis RESP type: ${prefix}`);
}

export function aggregateTimeline(
  session: SessionMetadata,
  events: TimelineEvent[],
  periodSeconds: number,
  nowMs: number = Date.now()
): TimelinePayload {
  const windowStart = nowMs - periodSeconds * 1000;
  const llm = new Map<string, TimelinePoint[]>();
  const tools = new Map<string, TimelinePoint[]>();

  for (const event of events) {
    const target = event.event_type === "llm" ? llm : tools;
    const key = event.category_key || "unlabeled";
    const points = target.get(key) ?? [];
    if (!points.length) {
      points.push({
        timestamp_ms: windowStart,
        value: Math.max(round6(event.category_total - event.cost), 0),
      });
    }
    points.push({
      timestamp_ms: event.timestamp_ms,
      value: round6(event.category_total),
    });
    target.set(key, points);
  }

  return {
    session,
    period_seconds: periodSeconds,
    generated_at_ms: nowMs,
    llm: serializeCards(llm),
    tools: serializeCards(tools),
  };
}

function serializeCards(map: Map<string, TimelinePoint[]>): TimelineCard[] {
  return [...map.entries()]
    .map(([key, points]) => ({
      key,
      points,
      last_value: round6(points[points.length - 1]?.value ?? 0),
    }))
    .sort((left, right) => right.last_value - left.last_value);
}

export function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
