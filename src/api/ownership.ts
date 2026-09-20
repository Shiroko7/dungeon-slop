import { z } from "zod";
import { appDb } from "../db/context.ts";
import { campaignExists } from "../campaign/campaigns.ts";
import { getDungeon } from "../campaign/dungeons.ts";
import { getChat } from "../campaign/chats.ts";
import { DungeonConfigSchema } from "../ai/schema.ts";
import { BlueprintSchema } from "../ai/blueprint.ts";
import { RoomSchema } from "./mutation-schema.ts";
import { badRequest, json, notFound } from "./http.ts";

const owner = z.number().int().positive().nullable().optional();
const contextSchema = z
  .object({
    campaignId: owner,
    dungeonId: owner,
    chatId: owner,
    expectedRevision: z.number().int().nonnegative().optional(),
    operationId: z.string().uuid().optional(),
    provider: z.enum(["gemini", "claude", "ollama"]).optional(),
    model: z.string().optional(),
    temperature: z.number().min(0).max(2).optional(),
    thinkingLevel: z.enum(["minimal", "low", "medium", "high"]).optional(),
    includeThoughts: z.boolean().optional(),
    conversationHistory: z
      .array(
        z.object({
          role: z.enum(["user", "assistant", "system"]),
          content: z.string(),
        }),
      )
      .optional(),
  })
  .passthrough();
export function validateAIRequest(
  body: Record<string, unknown>,
): Response | null {
  const parsed = contextSchema.safeParse(body);
  if (!parsed.success) return badRequest(parsed.error.message);
  for (const [key, schema] of [
    ["config", DungeonConfigSchema],
    ["blueprint", BlueprintSchema],
  ] as const) {
    if (body[key] != null && !schema.safeParse(body[key]).success)
      return badRequest(`Invalid ${key}`);
  }
  for (const key of ["rooms", "allRooms", "room"] as const) {
    if (
      body[key] !== undefined &&
      !(key === "room" ? RoomSchema : z.array(RoomSchema)).safeParse(body[key])
        .success
    )
      return badRequest(`Invalid ${key}`);
  }
  const { campaignId, dungeonId, chatId, expectedRevision } = parsed.data;
  if (campaignId == null && dungeonId == null && chatId == null) return null; // explicit stateless API use
  if (campaignId == null)
    return badRequest("An owned operation needs its campaignId");
  const db = appDb();
  if (!campaignExists(db, campaignId))
    return notFound("The campaign no longer exists");
  if (dungeonId != null) {
    const dungeon = getDungeon(db, dungeonId);
    if (!dungeon) return notFound("The dungeon no longer exists");
    if (dungeon.campaignId !== campaignId)
      return badRequest("Dungeon does not belong to this campaign");
    if (expectedRevision === undefined)
      return badRequest("An owned operation needs expectedRevision");
    if (dungeon.revision !== expectedRevision)
      return json(
        {
          error: "The dungeon changed. Reload before generating.",
          code: "revision_conflict",
          revision: dungeon.revision,
        },
        409,
      );
    const rooms = [
      ...(Array.isArray(body.rooms) ? body.rooms : []),
      ...(Array.isArray(body.allRooms) ? body.allRooms : []),
      ...(body.room ? [body.room] : []),
    ] as Array<{ id: number }>;
    if (
      rooms.some(
        (room) =>
          !dungeon.geometry?.rooms.some((saved) => saved.id === room.id),
      )
    )
      return badRequest("A requested room does not belong to this dungeon");
  }
  if (chatId != null) {
    const chat = getChat(db, chatId);
    if (!chat) return notFound("The chat no longer exists");
    if (
      chat.campaignId !== campaignId ||
      chat.dungeonId !== (dungeonId ?? null)
    )
      return badRequest("Chat does not belong to this operation's owner");
  }
  return null;
}
