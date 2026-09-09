import { appDb } from "../db/context.ts";
import { campaignExists } from "../campaign/campaigns.ts";
import {
  createDungeon,
  deleteDungeon,
  deleteRoomNote,
  forkDungeon,
  getDungeon,
  listDungeons,
  updateDungeon,
  upsertRoomNote,
} from "../campaign/dungeons.ts";
import { architectChat } from "../campaign/chats.ts";
import type { DungeonInput, DungeonPatch } from "../campaign/types.ts";
import type { RoomDescription } from "../engine/types.ts";
import { badRequest, json, notFound, readJson, serverError } from "./http.ts";

export function handleListDungeons(campaignId: number): Response {
  if (!campaignExists(appDb(), campaignId)) return notFound(`No campaign ${campaignId}`);
  return json({ dungeons: listDungeons(appDb(), campaignId) });
}

export function handleGetDungeon(id: number): Response {
  const dungeon = getDungeon(appDb(), id);
  return dungeon === null ? notFound(`No dungeon ${id}`) : json({ dungeon });
}

export async function handleCreateDungeon(req: Request, campaignId: number): Promise<Response> {
  const db = appDb();
  if (!campaignExists(db, campaignId)) return notFound(`No campaign ${campaignId}`);

  const body = (await readJson<Partial<DungeonInput>>(req)) ?? {};
  try {
    return json(
      {
        dungeon: createDungeon(db, campaignId, {
          name: typeof body.name === "string" ? body.name : "Untitled map",
          seed: body.seed ?? null,
          config: body.config ?? null,
          geometry: body.geometry ?? null,
          overview: body.overview ?? null,
          blueprint: body.blueprint ?? null,
        }),
      },
      201,
    );
  } catch (err) {
    return serverError(err);
  }
}

/**
 * The autosave target. Every key is optional and every absent key is left
 * untouched, so the client can send only what changed — usually just the
 * geometry after an edit.
 */
export async function handleUpdateDungeon(req: Request, id: number): Promise<Response> {
  const body = await readJson<DungeonPatch>(req);
  if (body === null) return badRequest("Expected a JSON body");

  const patch: DungeonPatch = {};
  if ("name" in body) patch.name = body.name;
  if ("seed" in body) patch.seed = body.seed;
  if ("config" in body) patch.config = body.config;
  if ("geometry" in body) patch.geometry = body.geometry;
  if ("overview" in body) patch.overview = body.overview;
  if ("blueprint" in body) patch.blueprint = body.blueprint;

  try {
    const dungeon = updateDungeon(appDb(), id, patch);
    return dungeon === null ? notFound(`No dungeon ${id}`) : json({ dungeon });
  } catch (err) {
    return serverError(err);
  }
}

export function handleDeleteDungeon(id: number): Response {
  return deleteDungeon(appDb(), id) ? json({ deleted: id }) : notFound(`No dungeon ${id}`);
}

/**
 * A reroll: insert a sibling rather than overwrite.
 *
 * New geometry means new room ids, so writing over the original would silently
 * discard every room description already authored against it.
 */
export async function handleForkDungeon(req: Request, id: number): Promise<Response> {
  const body =
    (await readJson<{
      name?: string;
      seed?: number | null;
      config?: unknown;
      geometry?: unknown;
      blueprint?: unknown;
    }>(req)) ?? {};
  try {
    const fork = forkDungeon(appDb(), id, {
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      seed: body.seed ?? null,
      config: (body.config ?? null) as never,
      geometry: (body.geometry ?? null) as never,
      blueprint: (body.blueprint ?? null) as never,
    });
    return fork === null ? notFound(`No dungeon ${id}`) : json({ dungeon: fork }, 201);
  } catch (err) {
    return serverError(err);
  }
}

export async function handlePutRoomNote(
  req: Request,
  dungeonId: number,
  roomIndex: number,
): Promise<Response> {
  const db = appDb();
  if (getDungeon(db, dungeonId) === null) return notFound(`No dungeon ${dungeonId}`);

  const body = await readJson<{ description?: RoomDescription }>(req);
  if (body?.description == null || typeof body.description !== "object") {
    return badRequest("Expected a JSON body with a description");
  }

  try {
    upsertRoomNote(db, dungeonId, roomIndex, body.description);
    return json({ dungeonId, roomIndex });
  } catch (err) {
    return serverError(err);
  }
}

export function handleDeleteRoomNote(dungeonId: number, roomIndex: number): Response {
  deleteRoomNote(appDb(), dungeonId, roomIndex);
  return json({ dungeonId, roomIndex, deleted: true });
}

/** The dungeon's single build log, created on first request. */
export function handleArchitectChat(dungeonId: number): Response {
  const db = appDb();
  if (getDungeon(db, dungeonId) === null) return notFound(`No dungeon ${dungeonId}`);
  try {
    return json({ chat: architectChat(db, dungeonId) });
  } catch (err) {
    return serverError(err);
  }
}
