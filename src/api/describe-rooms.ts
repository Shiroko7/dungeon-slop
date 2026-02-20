import { getProvider, getApiKey } from "../ai/provider-registry.ts";
import { buildNarratorMessages } from "../ai/prompts/narrator.ts";
import type { Room, Corridor } from "../engine/types.ts";
import type { DungeonConfig } from "../ai/schema.ts";
import type { RoomDescription } from "../engine/types.ts";

interface DescribeRoomsBody {
  rooms: Room[];
  corridors?: Corridor[];
  config: DungeonConfig;
  temperature?: number;
  provider?: string;
}

interface DescribeRoomBody {
  room: Room;
  allRooms?: Room[];
  corridors?: Corridor[];
  config: DungeonConfig;
  temperature?: number;
  provider?: string;
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function handleDescribeRooms(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON body" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const { rooms, corridors, config, temperature, provider } = body as DescribeRoomsBody;

  if (!Array.isArray(rooms) || !config) {
    return new Response(
      JSON.stringify({ error: "Missing required fields: rooms, config" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const providerName = provider ?? "gemini";
  const aiProvider = getProvider(providerName);
  const apiKey = getApiKey(providerName);
  const messages = buildNarratorMessages(rooms, rooms, corridors ?? [], config);

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let fullText = "";

      try {
        const generator = aiProvider.streamComplete(apiKey, {
          messages,
          temperature: temperature ?? 0.8,
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

        const obj = parsed as Record<string, unknown>;
        const descriptions = (obj.rooms ?? obj.descriptions ?? parsed) as RoomDescription[];

        controller.enqueue(
          encoder.encode(
            sseEvent("complete", {
              descriptions: Array.isArray(descriptions) ? descriptions : [],
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

export async function handleDescribeRoom(req: Request, roomId: string): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON body" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const { room, allRooms, corridors, config, temperature, provider } = body as DescribeRoomBody;

  if (!room || !config) {
    return new Response(
      JSON.stringify({ error: "Missing required fields: room, config" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  if (String(room.id) !== roomId) {
    return new Response(
      JSON.stringify({ error: "Room ID in body does not match URL parameter" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const providerName = provider ?? "gemini";
  const aiProvider = getProvider(providerName);
  const apiKey = getApiKey(providerName);
  const messages = buildNarratorMessages([room], allRooms ?? [room], corridors ?? [], config);

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let fullText = "";

      try {
        const generator = aiProvider.streamComplete(apiKey, {
          messages,
          temperature: temperature ?? 0.8,
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

        const obj = parsed as Record<string, unknown>;
        const descriptions = (obj.rooms ?? obj.descriptions ?? parsed) as RoomDescription[];
        const description = Array.isArray(descriptions) ? descriptions[0] : descriptions;

        controller.enqueue(
          encoder.encode(
            sseEvent("complete", {
              description: description ?? null,
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
