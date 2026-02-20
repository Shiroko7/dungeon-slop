import { getProvider, getApiKey } from "../ai/provider-registry.ts";
import { buildDungeonNarratorMessages } from "../ai/prompts/narrator.ts";
import type { Room, Corridor, DungeonDescription } from "../engine/types.ts";
import type { DungeonConfig } from "../ai/schema.ts";

interface DescribeDungeonBody {
  rooms: Room[];
  corridors: Corridor[];
  config: DungeonConfig;
  temperature?: number;
  provider?: string;
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function handleDescribeDungeon(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON body" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const { rooms, corridors, config, temperature, provider } = body as DescribeDungeonBody;

  if (!Array.isArray(rooms) || !Array.isArray(corridors) || !config) {
    return new Response(
      JSON.stringify({ error: "Missing required fields: rooms, corridors, config" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const providerName = provider ?? "gemini";
  const aiProvider = getProvider(providerName);
  const apiKey = getApiKey(providerName);
  const messages = buildDungeonNarratorMessages(rooms, corridors, config);

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let fullText = "";

      try {
        const generator = aiProvider.streamComplete(apiKey, {
          messages,
          temperature: temperature ?? 0.7,
          responseFormat: "json",
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

        const description = parsed as DungeonDescription;
        if (!description.corridorFeatures) description.corridorFeatures = [];
        if (!description.wanderingMonsters) description.wanderingMonsters = [];

        controller.enqueue(
          encoder.encode(
            sseEvent("complete", {
              description,
              usage: result?.usage,
              model: aiProvider.defaultModel,
            }),
          ),
        );
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
