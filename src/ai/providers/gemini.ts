import type { AIProvider, AICompletionOptions, AICompletionResult, AIMessage } from "../types.ts";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

interface GeminiContent {
  role: "user" | "model";
  parts: Array<{ text: string }>;
}

interface GeminiResponse {
  candidates: Array<{
    content: { parts: Array<{ text?: string }> };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
  modelVersion?: string;
}

function convertMessages(messages: AIMessage[]): { systemInstruction: { parts: Array<{ text: string }> } | undefined; contents: GeminiContent[] } {
  let systemInstruction: { parts: Array<{ text: string }> } | undefined;
  const contents: GeminiContent[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemInstruction = { parts: [{ text: msg.content }] };
    } else {
      contents.push({
        role: msg.role === "assistant" ? "model" : "user",
        parts: [{ text: msg.content }],
      });
    }
  }

  return { systemInstruction, contents };
}

export const geminiProvider: AIProvider = {
  name: "gemini",
  models: ["gemini-2.0-flash"],
  defaultModel: "gemini-2.0-flash",

  async complete(apiKey: string, options: AICompletionOptions): Promise<AICompletionResult> {
    const model = this.defaultModel;
    const url = `${BASE_URL}/models/${model}:generateContent?key=${apiKey}`;

    const { systemInstruction, contents } = convertMessages(options.messages);

    const generationConfig: Record<string, unknown> = {};
    if (options.temperature !== undefined) {
      generationConfig.temperature = options.temperature;
    }
    if (options.maxTokens !== undefined) {
      generationConfig.maxOutputTokens = options.maxTokens;
    }
    if (options.responseFormat === "json") {
      generationConfig.responseMimeType = "application/json";
    }

    const body: Record<string, unknown> = {
      contents,
      generationConfig,
    };

    if (systemInstruction) {
      body.systemInstruction = systemInstruction;
    }

    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as GeminiResponse;

    const content = data.candidates[0]?.content.parts
      .map((part) => part.text ?? "")
      .join("") ?? "";

    return {
      content,
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      },
      model: data.modelVersion ?? model,
    };
  },

  async *streamComplete(apiKey: string, options: AICompletionOptions): AsyncGenerator<string, AICompletionResult> {
    const model = this.defaultModel;
    const url = `${BASE_URL}/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

    const { systemInstruction, contents } = convertMessages(options.messages);

    const generationConfig: Record<string, unknown> = {};
    if (options.temperature !== undefined) {
      generationConfig.temperature = options.temperature;
    }
    if (options.maxTokens !== undefined) {
      generationConfig.maxOutputTokens = options.maxTokens;
    }
    if (options.responseFormat === "json") {
      generationConfig.responseMimeType = "application/json";
    }

    const body: Record<string, unknown> = {
      contents,
      generationConfig,
    };

    if (systemInstruction) {
      body.systemInstruction = systemInstruction;
    }

    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API error (${response.status}): ${errorText}`);
    }

    if (!response.body) {
      throw new Error("Gemini API returned no response body for stream");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let fullContent = "";
    let modelVersion = model;
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
          if (!jsonStr) continue;

          let chunk: GeminiResponse;
          try {
            chunk = JSON.parse(jsonStr) as GeminiResponse;
          } catch {
            continue;
          }

          if (chunk.modelVersion) {
            modelVersion = chunk.modelVersion;
          }

          if (chunk.usageMetadata) {
            if (chunk.usageMetadata.promptTokenCount) {
              inputTokens = chunk.usageMetadata.promptTokenCount;
            }
            if (chunk.usageMetadata.candidatesTokenCount) {
              outputTokens = chunk.usageMetadata.candidatesTokenCount;
            }
          }

          const parts = chunk.candidates?.[0]?.content?.parts;
          if (parts) {
            for (const part of parts) {
              if (part.text) {
                fullContent += part.text;
                yield part.text;
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return {
      content: fullContent,
      usage: { inputTokens, outputTokens },
      model: modelVersion,
    };
  },
};
