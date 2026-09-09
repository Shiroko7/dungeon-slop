import { getProvider, getApiKey, resolveModel } from "../ai/provider-registry.ts";
import { DungeonConfigSchema } from "../ai/schema.ts";
import { buildArchitectMessages } from "../ai/prompts/architect.ts";
import type { AIMessage, ThinkingLevel } from "../ai/types.ts";
import { recordUsage } from "../db/usage.ts";

interface GenerateConfigBody {
  prompt: string;
  temperature?: number;
  provider?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  includeThoughts?: boolean;
  campaignId?: number;
  dungeonId?: number;
  chatId?: number;
  conversationHistory?: AIMessage[];
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function handleGenerateConfig(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON body" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const { prompt, temperature, provider, model, thinkingLevel, includeThoughts, campaignId, dungeonId, chatId, conversationHistory } = body as GenerateConfigBody;

  if (typeof prompt !== "string") {
    return new Response(
      JSON.stringify({ error: "Missing required field: prompt" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const providerName = provider ?? "gemini";
  const aiProvider = getProvider(providerName);
  const modelName = resolveModel(providerName, model);
  const apiKey = getApiKey(providerName);
  const messages = buildArchitectMessages(prompt, conversationHistory);

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let fullText = "";

      try {
        const generator = aiProvider.streamComplete(apiKey, {
          messages,
          temperature: temperature ?? 0.7,
          responseFormat: "json",
          model: modelName,
          thinkingLevel,
          includeThoughts,
        });

        let result;
        while (true) {
          const next = await generator.next();
          if (next.done) {
            result = next.value;
            break;
          }
          const token = next.value;
          fullText += token;
          controller.enqueue(encoder.encode(sseEvent("token", { text: token })));
        }

        recordUsage({
          operation: "config",
          provider: providerName,
          model: result?.model ?? modelName,
          inputTokens: result?.usage.inputTokens ?? 0,
          outputTokens: result?.usage.outputTokens ?? 0,
          thinkingTokens: result?.usage.thinkingTokens ?? 0,
          reasoning: result?.thoughts ?? null,
          campaignId,
          dungeonId,
          chatId,
        });

        let parsed: unknown;
        try {
          parsed = JSON.parse(fullText);
        } catch {
          controller.enqueue(
            encoder.encode(sseEvent("error", { error: "Failed to parse AI response as JSON" })),
          );
          controller.close();
          return;
        }

        const obj = parsed as Record<string, unknown>;

        if ("config" in obj && obj.config !== undefined) {
          const validation = DungeonConfigSchema.safeParse(obj.config);
          if (validation.success) {
            controller.enqueue(
              encoder.encode(
                sseEvent("complete", {
                  type: "config",
                  config: validation.data,
                  usage: result?.usage,
                  model: result?.model ?? modelName,
                }),
              ),
            );
          } else {
            const errors = validation.error.issues.map(
              (i) => `${i.path.join(".")}: ${i.message}`,
            );
            controller.enqueue(
              encoder.encode(
                sseEvent("complete", {
                  type: "config",
                  config: obj.config,
                  validationErrors: errors,
                  usage: result?.usage,
                  model: result?.model ?? modelName,
                }),
              ),
            );
          }
        } else if ("clarification" in obj) {
          controller.enqueue(
            encoder.encode(
              sseEvent("complete", {
                type: "clarification",
                clarification: obj.clarification,
                usage: result?.usage,
                model: result?.model ?? modelName,
              }),
            ),
          );
        } else {
          controller.enqueue(
            encoder.encode(
              sseEvent("complete", {
                type: "unknown",
                data: obj,
                usage: result?.usage,
                model: result?.model ?? modelName,
              }),
            ),
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Stream failed";
        controller.enqueue(encoder.encode(sseEvent("error", { error: message })));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
