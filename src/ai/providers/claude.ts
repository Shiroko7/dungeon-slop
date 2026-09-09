import type { AIProvider, AIModelInfo, AICompletionOptions, AICompletionResult, AIMessage } from "../types.ts";

const BASE_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";

const MODELS: AIModelInfo[] = [
  { id: MODEL, label: "Claude Haiku 4.5", thinkingLevels: [] },
];

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string;
}

interface AnthropicResponse {
  content: Array<{ type: string; text?: string }>;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
}

interface AnthropicStreamEvent {
  type: string;
  delta?: { type?: string; text?: string; stop_reason?: string };
  message?: AnthropicResponse;
  content_block?: { type: string; text?: string };
  usage?: { output_tokens?: number };
  index?: number;
}

function convertMessages(messages: AIMessage[]): { system: string | undefined; messages: AnthropicMessage[] } {
  let system: string | undefined;
  const converted: AnthropicMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      system = msg.content;
    } else {
      converted.push({ role: msg.role, content: msg.content });
    }
  }

  return { system, messages: converted };
}

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  };
}

export const claudeProvider: AIProvider = {
  name: "claude",
  models: MODELS,
  defaultModel: MODEL,

  async complete(apiKey: string, options: AICompletionOptions): Promise<AICompletionResult> {
    const { system, messages } = convertMessages(options.messages);

    const body: Record<string, unknown> = {
      model: options.model ?? MODEL,
      max_tokens: options.maxTokens ?? 4096,
      messages,
    };
    if (system) body.system = system;
    if (options.temperature !== undefined) body.temperature = options.temperature;

    const response = await fetch(BASE_URL, {
      method: "POST",
      headers: buildHeaders(apiKey),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Claude API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as AnthropicResponse;
    const content = data.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");

    return {
      content,
      usage: {
        inputTokens: data.usage.input_tokens,
        outputTokens: data.usage.output_tokens,
      },
      model: data.model,
    };
  },

  async *streamComplete(apiKey: string, options: AICompletionOptions): AsyncGenerator<string, AICompletionResult> {
    const { system, messages } = convertMessages(options.messages);

    const body: Record<string, unknown> = {
      model: options.model ?? MODEL,
      max_tokens: options.maxTokens ?? 4096,
      messages,
      stream: true,
    };
    if (system) body.system = system;
    if (options.temperature !== undefined) body.temperature = options.temperature;

    const response = await fetch(BASE_URL, {
      method: "POST",
      headers: buildHeaders(apiKey),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Claude API error (${response.status}): ${errorText}`);
    }

    if (!response.body) {
      throw new Error("Claude API returned no response body for stream");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let fullContent = "";
    let modelName = options.model ?? MODEL;
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
          if (!line.startsWith("data: ")) continue;

          const jsonStr = line.slice(6).trim();
          if (!jsonStr || jsonStr === "[DONE]") continue;

          let event: AnthropicStreamEvent;
          try {
            event = JSON.parse(jsonStr) as AnthropicStreamEvent;
          } catch {
            continue;
          }

          if (event.type === "message_start" && event.message) {
            modelName = event.message.model;
            inputTokens = event.message.usage.input_tokens;
          } else if (event.type === "content_block_delta" && event.delta?.text) {
            fullContent += event.delta.text;
            yield event.delta.text;
          } else if (event.type === "message_delta" && event.usage?.output_tokens) {
            outputTokens = event.usage.output_tokens;
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
