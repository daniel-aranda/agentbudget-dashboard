import { registerModel } from "@agentbudget/agentbudget";

export type SupportedProvider = "openai" | "anthropic";

export interface ProviderModelOption {
  value: string;
  label: string;
}

export interface ProviderModelCatalogEntry {
  defaultModel: string;
  models: ProviderModelOption[];
}

export const PROVIDER_MODEL_CATALOG: Record<SupportedProvider, ProviderModelCatalogEntry> = {
  openai: {
    defaultModel: "gpt-5.4-mini",
    models: [
      { value: "gpt-5.4-mini", label: "GPT-5.4 mini · recommended" },
      { value: "gpt-5.4", label: "GPT-5.4 · frontier" },
      { value: "gpt-5.4-nano", label: "GPT-5.4 nano · cheapest" },
      { value: "gpt-5.3-chat-latest", label: "GPT-5.3 chat latest" },
      { value: "gpt-4.1", label: "GPT-4.1 · fallback" },
    ],
  },
  anthropic: {
    defaultModel: "claude-sonnet-4-0",
    models: [
      { value: "claude-sonnet-4-0", label: "Claude Sonnet 4" },
      { value: "claude-opus-4-1", label: "Claude Opus 4.1" },
      { value: "claude-opus-4-0", label: "Claude Opus 4" },
      { value: "claude-3-7-sonnet-latest", label: "Claude Sonnet 3.7" },
      { value: "claude-3-5-haiku-latest", label: "Claude Haiku 3.5" },
    ],
  },
};

const MODEL_PRICING: Array<[model: string, inputPerMillion: number, outputPerMillion: number]> = [
  ["gpt-5.4", 2.5, 15],
  ["gpt-5.4-mini", 0.75, 4.5],
  ["gpt-5.4-nano", 0.2, 1.25],
  ["gpt-5.3-chat-latest", 1.75, 14],
  ["gpt-5-chat-latest", 1.25, 10],
  ["gpt-5", 1.25, 10],
  ["gpt-5-mini", 0.25, 2],
  ["claude-sonnet-4-0", 3, 15],
  ["claude-opus-4-1", 15, 75],
  ["claude-opus-4-0", 15, 75],
  ["claude-3-7-sonnet-latest", 3, 15],
  ["claude-3-5-haiku-latest", 0.8, 4],
];

let registered = false;

export function registerSupportedModelPricing(): void {
  if (registered) return;
  registered = true;

  for (const [model, inputPerMillion, outputPerMillion] of MODEL_PRICING) {
    registerModel(model, inputPerMillion, outputPerMillion);
  }
}
