import { geminiProvider } from "./providers/gemini.ts";
import { claudeProvider } from "./providers/claude.ts";
import { ollamaProvider } from "./providers/ollama.ts";
import type { AIProvider, AIModelInfo } from "./types.ts";

const providers: Record<string, AIProvider> = {
  gemini: geminiProvider,
  claude: claudeProvider,
  ollama: ollamaProvider,
};

export function getProvider(name: string): AIProvider {
  const provider = providers[name];
  if (!provider) throw new Error(`Unknown AI provider: ${name}`);
  return provider;
}

/** Model catalog for one provider, for the settings UI and validation. */
export function listModels(providerName: string): AIModelInfo[] {
  return getProvider(providerName).models;
}

/**
 * Falls back to the provider default when the id is unknown to us, so a stale
 * persisted model (a retired Gemini id, say) degrades instead of 404-ing.
 */
export function resolveModel(providerName: string, model: string | undefined): string {
  const provider = getProvider(providerName);
  if (model === undefined) return provider.defaultModel;
  return provider.models.some((m) => m.id === model) ? model : provider.defaultModel;
}

export function getApiKey(providerName: string): string {
  if (providerName === "ollama") return "";
  if (providerName === "claude") {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("ANTHROPIC_API_KEY environment variable is not set");
    return key;
  }
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY environment variable is not set");
  return key;
}
