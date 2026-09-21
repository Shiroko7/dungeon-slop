import { operationStream } from "./stream.ts";
import {
  getProvider,
  getApiKey,
  resolveModel,
} from "../ai/provider-registry.ts";
import type { ThinkingLevel } from "../ai/types.ts";
import { recordUsage } from "../db/usage.ts";
import { buildNarratorMessages } from "../ai/prompts/narrator.ts";
import type { Room, Corridor } from "../engine/types.ts";
import type { DungeonConfig } from "../ai/schema.ts";
import type { RoomDescription } from "../engine/types.ts";
import type { AIMessage } from "../ai/types.ts";
import { NarratorRoomResultSchema } from "./mutation-schema.ts";
import { appDb } from "../db/context.ts";
import { notesEmbedder } from "../notes/context.ts";
import { GroundingSelectionSchema, retrieveGrounding } from "../ai/grounding.ts";
import type { GroundingSelection } from "../ai/grounding-types.ts";

interface DescribeRoomsBody {
  rooms: Room[];
  /** Every room on the map. Needed so a batched slice can still resolve the
   *  "leadsTo" of a passage pointing at a room outside the batch. */
  allRooms?: Room[];
  corridors?: Corridor[];
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
  grounding?: GroundingSelection;
}

interface DescribeRoomBody {
  room: Room;
  allRooms?: Room[];
  corridors?: Corridor[];
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
  grounding?: GroundingSelection;
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function handleDescribeRooms(req: Request): Promise<Response> {
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
    allRooms,
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
    grounding,
  } = body as DescribeRoomsBody;

  if (!Array.isArray(rooms) || !config) {
    return new Response(
      JSON.stringify({ error: "Missing required fields: rooms, config" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const parsedGrounding = grounding === undefined
    ? undefined
    : GroundingSelectionSchema.safeParse(grounding);
  if (parsedGrounding !== undefined && !parsedGrounding.success) {
    return new Response(JSON.stringify({ error: "Invalid note source selection" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  const providerName = provider ?? "gemini";
  const aiProvider = getProvider(providerName);
  const modelName = resolveModel(providerName, model);
  const apiKey = getApiKey(providerName);
  const stream = operationStream(req, async (controller, signal) => {
    const encoder = new TextEncoder();
    let fullText = "";

    try {
      const grounded = campaignId == null
        ? undefined
        : await retrieveGrounding(
          appDb(), campaignId, parsedGrounding?.data,
          sourcePrompt ?? conversationHistory?.filter((message) => message.role === "user").map((message) => message.content).join("\n\n") ?? "",
          notesEmbedder, signal,
        );
      if (grounded !== undefined)
        controller.enqueue(encoder.encode(sseEvent("grounding", grounded.provenance)));
      const messages = buildNarratorMessages(
        rooms,
        allRooms ?? rooms,
        corridors ?? [],
        config,
        { prompt: sourcePrompt, history: conversationHistory, campaignEvidence: grounded?.promptText },
      );
      const generator = aiProvider.streamComplete(apiKey, {
        signal,
        messages,
        temperature: temperature ?? 0.8,
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
        operation: "rooms",
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

      const obj = parsed as Record<string, unknown>;
      const candidates = (obj.rooms ?? obj.descriptions ?? parsed) as unknown;
      const requested = new Set(rooms.map((room) => room.id));
      const seen = new Set<number>();
      const descriptions: Array<{ roomId: number; description: RoomDescription }> = [];
      const invalidRoomIds: number[] = [];
      if (Array.isArray(candidates)) {
        for (const candidate of candidates) {
          const value = candidate as Record<string, unknown>;
          const roomId = value?.roomId;
          const nested = value?.description;
          const descriptionValue =
            nested && typeof nested === "object"
              ? nested
              : (() => {
                  if (!value || typeof value !== "object") return null;
                  const copy = { ...value };
                  delete copy.roomId;
                  return copy;
                })();
          const valid = NarratorRoomResultSchema.safeParse({
            roomId,
            description: descriptionValue,
          });
          if (!valid.success || !requested.has(Number(roomId)) || seen.has(Number(roomId))) {
            if (Number.isInteger(roomId)) invalidRoomIds.push(Number(roomId));
            continue;
          }
          seen.add(Number(roomId));
          descriptions.push({
            roomId: valid.data.roomId,
            description: grounded === undefined
              ? valid.data.description
              : { ...valid.data.description, grounding: grounded.provenance },
          });
        }
      }
      const missingRoomIds = [...requested].filter((id) => !seen.has(id));

      controller.enqueue(
        encoder.encode(
          sseEvent("complete", {
            descriptions,
          missingRoomIds,
          invalidRoomIds,
          grounding: grounded?.provenance,
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

export async function handleDescribeRoom(
  req: Request,
  roomId: string,
): Promise<Response> {
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
    room,
    allRooms,
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
    grounding,
  } = body as DescribeRoomBody;

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

  const parsedGrounding = grounding === undefined
    ? undefined
    : GroundingSelectionSchema.safeParse(grounding);
  if (parsedGrounding !== undefined && !parsedGrounding.success) {
    return new Response(JSON.stringify({ error: "Invalid note source selection" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  const providerName = provider ?? "gemini";
  const aiProvider = getProvider(providerName);
  const modelName = resolveModel(providerName, model);
  const apiKey = getApiKey(providerName);
  const stream = operationStream(req, async (controller, signal) => {
    const encoder = new TextEncoder();
    let fullText = "";

    try {
      const grounded = campaignId == null
        ? undefined
        : await retrieveGrounding(
          appDb(), campaignId, parsedGrounding?.data,
          sourcePrompt ?? conversationHistory?.filter((message) => message.role === "user").map((message) => message.content).join("\n\n") ?? "",
          notesEmbedder, signal,
        );
      if (grounded !== undefined)
        controller.enqueue(encoder.encode(sseEvent("grounding", grounded.provenance)));
      const messages = buildNarratorMessages(
        [room],
        allRooms ?? [room],
        corridors ?? [],
        config,
        { prompt: sourcePrompt, history: conversationHistory, campaignEvidence: grounded?.promptText },
      );
      const generator = aiProvider.streamComplete(apiKey, {
        signal,
        messages,
        temperature: temperature ?? 0.8,
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
        operation: "room",
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

      const obj = parsed as Record<string, unknown>;
      const candidates = (obj.rooms ?? obj.descriptions ?? [parsed]) as unknown;
      const candidate = Array.isArray(candidates) ? candidates[0] : candidates;
      const value = (candidate ?? {}) as Record<string, unknown>;
      const nested = value.description;
      const descriptionValue =
        nested && typeof nested === "object"
          ? nested
          : (() => {
              const copy = { ...value };
              delete copy.roomId;
              return copy;
            })();
      const valid = NarratorRoomResultSchema.safeParse({
        roomId: value.roomId,
        description: descriptionValue,
      });

      controller.enqueue(
        encoder.encode(
          sseEvent("complete", {
            description:
              valid.success && valid.data.roomId === Number(roomId)
                ? {
                    roomId: valid.data.roomId,
                    description: grounded === undefined
                      ? valid.data.description
                      : { ...valid.data.description, grounding: grounded.provenance },
                  }
                : null,
            grounding: grounded?.provenance,
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
