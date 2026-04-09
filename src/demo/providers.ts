export type DemoProvider = "openai" | "anthropic";

export interface DemoMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ProviderReply {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

const PROVIDER_TIMEOUT_MS = Number(process.env["LLM_REQUEST_TIMEOUT_MS"] ?? "60000");
const OPENAI_MAX_COMPLETION_TOKENS = Number(
  process.env["OPENAI_MAX_COMPLETION_TOKENS"] ?? "1024"
);

interface OpenAIResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

interface OpenAIResponsesResponse {
  model?: string;
  output?: Array<{
    type?: string;
    status?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  output_text?: string | null;
  incomplete_details?: { reason?: string };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  error?: { message?: string };
}

interface AnthropicResponse {
  model?: string;
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

export async function sendChatCompletion(input: {
  provider: DemoProvider;
  apiKey: string;
  model: string;
  messages: DemoMessage[];
}): Promise<ProviderReply> {
  if (input.provider === "openai") {
    return sendOpenAIChat(input);
  }
  return sendAnthropicChat(input);
}

async function sendOpenAIChat(input: {
  apiKey: string;
  model: string;
  messages: DemoMessage[];
}): Promise<ProviderReply> {
  if (usesOpenAIResponsesApi(input.model)) {
    return sendOpenAIResponses(input);
  }

  const response = await fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.apiKey}`,
    },
    // Keep demo runs bounded so frontier models do not leave the UI hanging for minutes.
    body: JSON.stringify({
      model: input.model,
      max_completion_tokens: OPENAI_MAX_COMPLETION_TOKENS,
      messages: input.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    }),
  }, "OpenAI");

  const payload = (await response.json()) as
    | OpenAIResponse
    | { error?: { message?: string } };

  if (!response.ok) {
    throw new Error(payload.error?.message ?? "OpenAI request failed");
  }

  const openAIResponse = payload as OpenAIResponse;
  const text = openAIResponse.choices?.[0]?.message?.content?.trim();
  if (!text) {
    throw new Error("OpenAI response did not include assistant text");
  }

  return {
    text,
    model: input.model,
    inputTokens: openAIResponse.usage?.prompt_tokens ?? 0,
    outputTokens: openAIResponse.usage?.completion_tokens ?? 0,
  };
}

async function sendOpenAIResponses(input: {
  apiKey: string;
  model: string;
  messages: DemoMessage[];
}): Promise<ProviderReply> {
  const response = await fetchWithTimeout("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify({
      model: input.model,
      input: input.messages.map((message) => ({
        role: message.role === "system" ? "developer" : message.role,
        content: message.content,
      })),
      reasoning: { effort: "low" },
      text: { verbosity: "low" },
      max_output_tokens: OPENAI_MAX_COMPLETION_TOKENS,
    }),
  }, "OpenAI");

  const payload = (await response.json()) as
    | OpenAIResponsesResponse
    | { error?: { message?: string } };

  if (!response.ok) {
    throw new Error(payload.error?.message ?? "OpenAI request failed");
  }

  const openAIResponse = payload as OpenAIResponsesResponse;
  const text = extractOpenAIResponsesText(openAIResponse);
  if (!text) {
    const incompleteReason = openAIResponse.incomplete_details?.reason;
    if (incompleteReason) {
      throw new Error(`OpenAI response ended before visible text was available (${incompleteReason})`);
    }
    throw new Error("OpenAI response did not include assistant text");
  }

  return {
    text,
    model: input.model,
    inputTokens: openAIResponse.usage?.input_tokens ?? 0,
    outputTokens: openAIResponse.usage?.output_tokens ?? 0,
  };
}

async function sendAnthropicChat(input: {
  apiKey: string;
  model: string;
  messages: DemoMessage[];
}): Promise<ProviderReply> {
  const response = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": input.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: input.model,
      max_tokens: 1024,
      messages: input.messages
        .filter((message) => message.role !== "system")
        .map((message) => ({
          role: message.role,
          content: message.content,
        })),
      system: input.messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n\n"),
    }),
  }, "Anthropic");

  const payload = (await response.json()) as
    | AnthropicResponse
    | { error?: { message?: string } };

  if (!response.ok) {
    throw new Error(payload.error?.message ?? "Anthropic request failed");
  }

  const anthropicResponse = payload as AnthropicResponse;
  const text = anthropicResponse.content
    ?.filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n")
    .trim();

  if (!text) {
    throw new Error("Anthropic response did not include assistant text");
  }

  return {
    text,
    model: input.model,
    inputTokens: anthropicResponse.usage?.input_tokens ?? 0,
    outputTokens: anthropicResponse.usage?.output_tokens ?? 0,
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  providerLabel: string
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw new Error(
        `${providerLabel} request timed out after ${Math.round(PROVIDER_TIMEOUT_MS / 1000)}s`
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function usesOpenAIResponsesApi(model: string): boolean {
  return model.startsWith("gpt-5");
}

export function extractOpenAIResponsesText(payload: OpenAIResponsesResponse): string {
  const directText = payload.output_text?.trim();
  if (directText) return directText;

  const messageText = payload.output
    ?.filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === "output_text")
    .map((item) => item.text ?? "")
    .join("")
    .trim();

  return messageText ?? "";
}
