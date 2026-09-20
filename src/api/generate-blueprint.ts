import { operationStream } from "./stream.ts";
import {
  getProvider,
  getApiKey,
  resolveModel,
} from "../ai/provider-registry.ts";
import { BlueprintSchema, normalizeBlueprint } from "../ai/blueprint.ts";
import { buildBlueprintMessages } from "../ai/prompts/blueprint.ts";
import type { DungeonConfig } from "../ai/schema.ts";
import type { AIMessage, ThinkingLevel } from "../ai/types.ts";
import { recordUsage } from "../db/usage.ts";

interface GenerateBlueprintBody {
  prompt: string;
  config?: DungeonConfig | null;
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

/**
 * Ask the model for a floor plan.
 *
 * The response is validated and then REPAIRED rather than rejected on anything
 * short of unusable: a plan that names one room twice is still a good plan, and
 * bouncing it costs a paid call to get back something with a different flaw.
 */
export async function handleGenerateBlueprint(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const {
    prompt,
    config,
    temperature,
    provider,
    model,
    thinkingLevel,
    includeThoughts,
    campaignId,
    dungeonId,
    chatId,
    conversationHistory,
  } = body as GenerateBlueprintBody;

  if (typeof prompt !== "string") {
    return new Response(
      JSON.stringify({ error: "Missing required field: prompt" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  const providerName = provider ?? "gemini";
  const aiProvider = getProvider(providerName);
  const modelName = resolveModel(providerName, model);
  const apiKey = getApiKey(providerName);
  const messages = buildBlueprintMessages({
    prompt,
    config: config ?? null,
    history: conversationHistory,
  });

  const stream = operationStream(req, async (controller, signal) => {
    const encoder = new TextEncoder();
    let fullText = "";

    try {
      const generator = aiProvider.streamComplete(apiKey, {
        signal,
        messages,
        temperature: temperature ?? 0.7,
        responseFormat: "json",
        model: modelName,
        thinkingLevel,
        includeThoughts,
      });

      let result;
      while (true) {
        signal.throwIfAborted();
        const next = await generator.next();
        if (next.done) {
          result = next.value;
          break;
        }
        fullText += next.value;
        controller.enqueue(
          encoder.encode(sseEvent("token", { text: next.value })),
        );
      }

      recordUsage({
        operation: "blueprint",
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
          encoder.encode(
            sseEvent("error", { error: "Failed to parse AI response as JSON" }),
          ),
        );
        controller.close();
        return;
      }

      const validation = BlueprintSchema.safeParse(parsed);
      if (!validation.success) {
        const errors = validation.error.issues.map(
          (i) => `${i.path.join(".")}: ${i.message}`,
        );
        controller.enqueue(
          encoder.encode(
            sseEvent("error", {
              error: `Blueprint failed validation: ${errors.join("; ")}`,
            }),
          ),
        );
        controller.close();
        return;
      }

      const { blueprint, problems } = normalizeBlueprint(validation.data);

      controller.enqueue(
        encoder.encode(
          sseEvent("complete", {
            blueprint,
            problems,
            usage: result?.usage,
            model: result?.model ?? modelName,
          }),
        ),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Stream failed";
      controller.enqueue(encoder.encode(sseEvent("error", { error: message })));
    } finally {
      controller.close();
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
