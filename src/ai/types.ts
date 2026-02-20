export interface AIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AICompletionOptions {
  messages: AIMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: "json" | "text";
}

export interface AICompletionResult {
  content: string;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
}

export interface AIProvider {
  name: string;
  models: string[];
  defaultModel: string;
  complete(apiKey: string, options: AICompletionOptions): Promise<AICompletionResult>;
  streamComplete(apiKey: string, options: AICompletionOptions): AsyncGenerator<string, AICompletionResult>;
}
