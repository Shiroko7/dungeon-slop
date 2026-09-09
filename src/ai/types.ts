/** An inline image, as raw base64 with no data: prefix. */
export interface AIImage {
  mimeType: string;
  data: string;
}

export interface AIMessage {
  role: "system" | "user" | "assistant";
  content: string;
  /**
   * Images to send alongside the text. Only meaningful on user turns, and only
   * providers that advertise `supportsImages` will send them - the rest drop
   * them silently rather than failing a request over an unsupported part.
   */
  images?: AIImage[];
}

/**
 * Gemini's reasoning knob (generationConfig.thinkingConfig.thinkingLevel).
 * Support is per-model — see AIModelInfo.thinkingLevels. "minimal" in
 * particular is rejected by the larger models.
 */
export type ThinkingLevel = "minimal" | "low" | "medium" | "high";

export interface AIModelInfo {
  id: string;
  label: string;
  /** Levels this model accepts. Empty = model has no thinking control. */
  thinkingLevels: ThinkingLevel[];
}

export interface AICompletionOptions {
  messages: AIMessage[];
  /** Defaults to the provider's defaultModel when omitted. */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: "json" | "text";
  thinkingLevel?: ThinkingLevel;
  /** Ask for the reasoning summary. Thought text never lands in `content`. */
  includeThoughts?: boolean;
}

export interface AICompletionResult {
  content: string;
  usage: { inputTokens: number; outputTokens: number; thinkingTokens?: number };
  model: string;
  /** Reasoning summary, only when includeThoughts was set. */
  thoughts?: string;
}

export interface AIProvider {
  name: string;
  models: AIModelInfo[];
  /** Whether this provider accepts AIMessage.images. */
  supportsImages?: boolean;
  defaultModel: string;
  complete(apiKey: string, options: AICompletionOptions): Promise<AICompletionResult>;
  streamComplete(apiKey: string, options: AICompletionOptions): AsyncGenerator<string, AICompletionResult>;
}
