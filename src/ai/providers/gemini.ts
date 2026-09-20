import type {
  AIProvider,
  AIModelInfo,
  AICompletionOptions,
  AICompletionResult,
  AIMessage,
  ThinkingLevel,
} from "../types.ts";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

const ALL: ThinkingLevel[] = ["minimal", "low", "medium", "high"];
const NO_MINIMAL: ThinkingLevel[] = ["low", "medium", "high"];

/**
 * Verified against ListModels plus a live probe per model. Everything from the
 * 2.x line (2.0-flash, 2.5-flash, 2.5-pro) still appears in ListModels but
 * 404s on generateContent - "no longer available to new users" - so it is
 * deliberately absent here.
 *
 * "minimal" is rejected by the larger models; the split below is measured,
 * not guessed.
 */
const MODELS: AIModelInfo[] = [
  {
    id: "gemini-3.8-flash",
    label: "3.8 Flash (newest)",
    thinkingLevels: NO_MINIMAL,
  },
  { id: "gemini-3.7-flash", label: "3.7 Flash", thinkingLevels: NO_MINIMAL },
  { id: "gemini-3.6-flash", label: "3.6 Flash", thinkingLevels: ALL },
  { id: "gemini-3.5-flash", label: "3.5 Flash", thinkingLevels: ALL },
  {
    id: "gemini-3.5-flash-lite",
    label: "3.5 Flash Lite (cheap)",
    thinkingLevels: ALL,
  },
  { id: "gemini-3.1-flash-lite", label: "3.1 Flash Lite", thinkingLevels: ALL },
  {
    id: "gemini-3.1-pro-preview",
    label: "3.1 Pro (preview)",
    thinkingLevels: NO_MINIMAL,
  },
  {
    id: "gemini-3-flash-preview",
    label: "3.0 Flash (preview)",
    thinkingLevels: ALL,
  },
  {
    id: "gemini-flash-latest",
    label: "Flash (rolling alias)",
    thinkingLevels: NO_MINIMAL,
  },
  {
    id: "gemini-flash-lite-latest",
    label: "Flash Lite (rolling)",
    thinkingLevels: ALL,
  },
  {
    id: "gemini-pro-latest",
    label: "Pro (rolling alias)",
    thinkingLevels: NO_MINIMAL,
  },
];

const DEFAULT_MODEL = "gemini-3.8-flash";

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiPart {
  text?: string;
  /** Base64 image data, sent as its own part alongside the text. */
  inlineData?: { mimeType: string; data: string };
  /** Present and true on reasoning-summary parts. */
  thought?: boolean;
  thoughtSignature?: string;
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
  modelVersion?: string;
}

function convertMessages(messages: AIMessage[]): {
  systemInstruction: { parts: Array<{ text: string }> } | undefined;
  contents: GeminiContent[];
} {
  let systemInstruction: { parts: Array<{ text: string }> } | undefined;
  const contents: GeminiContent[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemInstruction = { parts: [{ text: msg.content }] };
    } else {
      // Images first: Gemini attends to a prompt that names what it is looking
      // at more reliably when the image precedes the question about it.
      const parts: GeminiPart[] = [];
      for (const image of msg.images ?? []) {
        parts.push({
          inlineData: { mimeType: image.mimeType, data: image.data },
        });
      }
      parts.push({ text: msg.content });
      contents.push({
        role: msg.role === "assistant" ? "model" : "user",
        parts,
      });
    }
  }

  return { systemInstruction, contents };
}

/**
 * Sending a level the model does not accept is a hard 400, so an unsupported
 * level is dropped rather than propagated. Unknown models (not in MODELS) get
 * the level passed through, which lets you try a new id without a code change.
 */
function resolveThinkingLevel(
  model: string,
  requested: ThinkingLevel | undefined,
): ThinkingLevel | undefined {
  if (requested === undefined) return undefined;
  const info = MODELS.find((m) => m.id === model);
  if (!info) return requested;
  return info.thinkingLevels.includes(requested) ? requested : undefined;
}

function buildRequest(options: AICompletionOptions): {
  model: string;
  body: Record<string, unknown>;
} {
  const model = options.model ?? DEFAULT_MODEL;
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

  const level = resolveThinkingLevel(model, options.thinkingLevel);
  if (level !== undefined || options.includeThoughts === true) {
    const thinkingConfig: Record<string, unknown> = {};
    if (level !== undefined) thinkingConfig.thinkingLevel = level;
    if (options.includeThoughts === true) thinkingConfig.includeThoughts = true;
    generationConfig.thinkingConfig = thinkingConfig;
  }

  const body: Record<string, unknown> = { contents, generationConfig };
  if (systemInstruction) body.systemInstruction = systemInstruction;

  return { model, body };
}

async function postOrThrow(
  url: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.any([
      AbortSignal.timeout(300_000),
      ...(signal ? [signal] : []),
    ]),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${errorText}`);
  }
  return response;
}

export const geminiProvider: AIProvider = {
  name: "gemini",
  supportsImages: true,
  models: MODELS,
  defaultModel: DEFAULT_MODEL,

  async complete(
    apiKey: string,
    options: AICompletionOptions,
  ): Promise<AICompletionResult> {
    const { model, body } = buildRequest(options);
    const url = `${BASE_URL}/models/${model}:generateContent?key=${apiKey}`;

    const response = await postOrThrow(url, body, options.signal);
    const data = (await response.json()) as GeminiResponse;

    const parts = data.candidates?.[0]?.content?.parts ?? [];
    // Reasoning parts are interleaved with answer parts and must never be
    // concatenated into content - in JSON mode that alone breaks the parse.
    const content = parts
      .filter((p) => p.thought !== true)
      .map((p) => p.text ?? "")
      .join("");
    const thoughts = parts
      .filter((p) => p.thought === true)
      .map((p) => p.text ?? "")
      .join("");

    return {
      content,
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
        thinkingTokens: data.usageMetadata?.thoughtsTokenCount ?? 0,
      },
      model: data.modelVersion ?? model,
      thoughts: thoughts.length > 0 ? thoughts : undefined,
    };
  },

  async *streamComplete(
    apiKey: string,
    options: AICompletionOptions,
  ): AsyncGenerator<string, AICompletionResult> {
    const { model, body } = buildRequest(options);
    const url = `${BASE_URL}/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

    const response = await postOrThrow(url, body, options.signal);
    if (!response.body) {
      throw new Error("Gemini API returned no response body for stream");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let fullContent = "";
    let thoughts = "";
    let modelVersion = model;
    let inputTokens = 0;
    let outputTokens = 0;
    let thinkingTokens = 0;
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

          if (chunk.modelVersion) modelVersion = chunk.modelVersion;

          if (chunk.usageMetadata) {
            if (chunk.usageMetadata.promptTokenCount) {
              inputTokens = chunk.usageMetadata.promptTokenCount;
            }
            if (chunk.usageMetadata.candidatesTokenCount) {
              outputTokens = chunk.usageMetadata.candidatesTokenCount;
            }
            if (chunk.usageMetadata.thoughtsTokenCount) {
              thinkingTokens = chunk.usageMetadata.thoughtsTokenCount;
            }
          }

          const parts = chunk.candidates?.[0]?.content?.parts;
          if (!parts) continue;

          for (const part of parts) {
            if (!part.text) continue;
            // Thought parts are collected but never yielded - callers feed the
            // token stream straight into JSON.parse.
            if (part.thought === true) {
              thoughts += part.text;
              continue;
            }
            fullContent += part.text;
            yield part.text;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return {
      content: fullContent,
      usage: { inputTokens, outputTokens, thinkingTokens },
      model: modelVersion,
      thoughts: thoughts.length > 0 ? thoughts : undefined,
    };
  },
};
