import { geminiProvider } from "./providers/gemini.ts";
import { claudeProvider } from "./providers/claude.ts";
import { ollamaProvider } from "./providers/ollama.ts";
import type { AIProvider } from "./types.ts";

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
