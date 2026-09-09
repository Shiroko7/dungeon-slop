import type { AIProvider, AIModelInfo, AICompletionOptions, AICompletionResult, AIMessage } from "../types.ts";

const BASE_URL = "http://localhost:11434";
const DEFAULT_MODEL = "qwen3:8b";

const MODELS: AIModelInfo[] = [
  { id: DEFAULT_MODEL, label: "qwen3:8b (local)", thinkingLevels: [] },
];

interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OllamaResponse {
  model: string;
  message: { role: string; content: string };
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

function convertMessages(messages: AIMessage[]): OllamaMessage[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

export const ollamaProvider: AIProvider = {
  name: "ollama",
  models: MODELS,
  defaultModel: DEFAULT_MODEL,

  async complete(_apiKey: string, options: AICompletionOptions): Promise<AICompletionResult> {
    const body: Record<string, unknown> = {
      model: options.model ?? DEFAULT_MODEL,
      messages: convertMessages(options.messages),
      stream: false,
      think: false,
    };
    if (options.temperature !== undefined) {
      body.options = { temperature: options.temperature };
    }
    if (options.responseFormat === "json") {
      body.format = "json";
    }

    const response = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as OllamaResponse;

    return {
      content: data.message.content,
      usage: {
        inputTokens: data.prompt_eval_count ?? 0,
        outputTokens: data.eval_count ?? 0,
      },
      model: data.model,
    };
  },

  async *streamComplete(_apiKey: string, options: AICompletionOptions): AsyncGenerator<string, AICompletionResult> {
    const body: Record<string, unknown> = {
      model: options.model ?? DEFAULT_MODEL,
      messages: convertMessages(options.messages),
      stream: true,
      think: false,
    };
    if (options.temperature !== undefined) {
      body.options = { temperature: options.temperature };
    }
    if (options.responseFormat === "json") {
      body.format = "json";
    }

    const response = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama API error (${response.status}): ${errorText}`);
    }

    if (!response.body) {
      throw new Error("Ollama API returned no response body for stream");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let fullContent = "";
    let modelName = DEFAULT_MODEL;
    let inputTokens = 0;
    let outputTokens = 0;
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let chunk: OllamaResponse;
          try {
            chunk = JSON.parse(trimmed) as OllamaResponse;
          } catch {
            continue;
          }

          modelName = chunk.model;

          if (chunk.message.content) {
            fullContent += chunk.message.content;
            yield chunk.message.content;
          }

          if (chunk.done) {
            inputTokens = chunk.prompt_eval_count ?? 0;
            outputTokens = chunk.eval_count ?? 0;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return {
      content: fullContent,
      usage: { inputTokens, outputTokens },
      model: modelName,
    };
  },
};
