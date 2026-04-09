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

interface OpenAIResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
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
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify({
      model: input.model,
      messages: input.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    }),
  });

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
    model: openAIResponse.model ?? input.model,
    inputTokens: openAIResponse.usage?.prompt_tokens ?? 0,
    outputTokens: openAIResponse.usage?.completion_tokens ?? 0,
  };
}

async function sendAnthropicChat(input: {
  apiKey: string;
  model: string;
  messages: DemoMessage[];
}): Promise<ProviderReply> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
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
  });

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
    model: anthropicResponse.model ?? input.model,
    inputTokens: anthropicResponse.usage?.input_tokens ?? 0,
    outputTokens: anthropicResponse.usage?.output_tokens ?? 0,
  };
}
