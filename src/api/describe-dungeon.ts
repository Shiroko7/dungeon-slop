import { operationStream } from "./stream.ts";
import {
  getProvider,
  getApiKey,
  resolveModel,
} from "../ai/provider-registry.ts";
import type { ThinkingLevel } from "../ai/types.ts";
import { recordUsage } from "../db/usage.ts";
import { buildDungeonNarratorMessages } from "../ai/prompts/narrator.ts";
import type { Room, Corridor, DungeonDescription } from "../engine/types.ts";
import type { AIMessage } from "../ai/types.ts";
import type { DungeonConfig } from "../ai/schema.ts";

interface DescribeDungeonBody {
  rooms: Room[];
  corridors: Corridor[];
  config: DungeonConfig;
  temperature?: number;
  provider?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  includeThoughts?: boolean;
  sourcePrompt?: string;
  conversationHistory?: AIMessage[];
  campaignId?: number;
  dungeonId?: number;
  chatId?: number;
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function handleDescribeDungeon(req: Request): Promise<Response> {
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
    rooms,
    corridors,
    config,
    temperature,
    provider,
    model,
    thinkingLevel,
    includeThoughts,
    campaignId,
    dungeonId,
    chatId,
    sourcePrompt,
    conversationHistory,
  } = body as DescribeDungeonBody;

  if (!Array.isArray(rooms) || !Array.isArray(corridors) || !config) {
    return new Response(
      JSON.stringify({
        error: "Missing required fields: rooms, corridors, config",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const providerName = provider ?? "gemini";
  const aiProvider = getProvider(providerName);
  const modelName = resolveModel(providerName, model);
  const apiKey = getApiKey(providerName);
  const messages = buildDungeonNarratorMessages(rooms, corridors, config, {
    prompt: sourcePrompt,
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
        const token = next.value;
        fullText += token;
        controller.enqueue(encoder.encode(sseEvent("token", { text: token })));
      }

      recordUsage({
        operation: "overview",
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

      const description = parsed as DungeonDescription;
      if (!description.corridorFeatures) description.corridorFeatures = [];
      if (!description.wanderingMonsters) description.wanderingMonsters = [];

      controller.enqueue(
        encoder.encode(
          sseEvent("complete", {
            description,
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
