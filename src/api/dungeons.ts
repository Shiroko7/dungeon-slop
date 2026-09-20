import { commitDungeon, MutationError } from "../campaign/mutations.ts";
import { DungeonPatchSchema, MutationSchema } from "./mutation-schema.ts";
import { appDb } from "../db/context.ts";
import { campaignExists } from "../campaign/campaigns.ts";
import {
  createDungeon,
  deleteDungeon,
  forkDungeon,
  getForkByOperation,
  getDungeon,
  listDungeons,
} from "../campaign/dungeons.ts";
import { architectChat } from "../campaign/chats.ts";
import type { DungeonInput } from "../campaign/types.ts";
import { badRequest, json, notFound, readJson, serverError } from "./http.ts";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getDungeonRevision, listDungeonRevisions } from "../campaign/revisions.ts";

export function handleListDungeons(campaignId: number): Response {
  if (!campaignExists(appDb(), campaignId))
    return notFound(`No campaign ${campaignId}`);
  return json({ dungeons: listDungeons(appDb(), campaignId) });
}

export function handleGetDungeon(id: number): Response {
  const dungeon = getDungeon(appDb(), id);
  return dungeon === null ? notFound(`No dungeon ${id}`) : json({ dungeon });
}

export async function handleCreateDungeon(
  req: Request,
  campaignId: number,
): Promise<Response> {
  const db = appDb();
  if (!campaignExists(db, campaignId))
    return notFound(`No campaign ${campaignId}`);

  const parsed = DungeonPatchSchema.omit({ roomNotes: true }).safeParse(
    await readJson(req),
  );
  if (!parsed.success) return badRequest(parsed.error.message);
  const body = parsed.data as Partial<DungeonInput>;
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
export async function handleUpdateDungeon(
  req: Request,
  id: number,
): Promise<Response> {
  if (!getDungeon(appDb(), id)) return notFound(`No dungeon ${id}`);
  const parsed = MutationSchema.safeParse(await readJson(req));
  if (!parsed.success) return badRequest(parsed.error.message);
  return saveMutation(
    id,
    parsed.data as import("../campaign/types.ts").DungeonMutation,
  );
}

function saveMutation(
  id: number,
  mutation: import("../campaign/types.ts").DungeonMutation,
): Response {
  try {
    const revision = commitDungeon(appDb(), id, mutation);
    return json({ revision, dungeon: getDungeon(appDb(), id) });
  } catch (err) {
    if (err instanceof MutationError)
      return json(
        { error: err.message, code: err.code, revision: err.revision },
        err.status,
      );
    return serverError(err);
  }
}

export function handleDeleteDungeon(id: number): Response {
  return deleteDungeon(appDb(), id)
    ? json({ deleted: id })
    : notFound(`No dungeon ${id}`);
}

/**
 * A reroll: insert a sibling rather than overwrite.
 *
 * New geometry means new room ids, so writing over the original would silently
 * discard every room description already authored against it.
 */
export async function handleForkDungeon(
  req: Request,
  id: number,
): Promise<Response> {
  const raw = await readJson<Record<string, unknown>>(req);
  if (!raw) return badRequest("Expected a JSON object");
  const parent = getDungeon(appDb(), id);
  if (!parent) return notFound(`No dungeon ${id}`);
  const rawOperationId = raw.operationId;
  if (rawOperationId !== undefined && typeof rawOperationId !== "string")
    return badRequest("operationId must be a UUID");
  if (
    typeof rawOperationId === "string" &&
    !z.string().uuid().safeParse(rawOperationId).success
  )
    return badRequest("operationId must be a UUID");
  const { expectedRevision, operationId: _, ...input } = raw;
  if (
    typeof expectedRevision !== "number" ||
    !Number.isInteger(expectedRevision) ||
    expectedRevision < 0
  )
    return badRequest("expectedRevision must be a non-negative integer");
  const parsed = DungeonPatchSchema.omit({
    roomNotes: true,
    overview: true,
  }).safeParse(input);
  if (!parsed.success) return badRequest(parsed.error.message);
  const body = parsed.data as Partial<DungeonInput>;
  const operationId =
    typeof rawOperationId === "string" ? rawOperationId : randomUUID();
  if (typeof rawOperationId === "string") {
    const existing = getForkByOperation(appDb(), id, rawOperationId);
    if (existing) {
      const same =
        existing.seed === (body.seed ?? null) &&
        JSON.stringify(existing.config) === JSON.stringify(body.config ?? null) &&
        JSON.stringify(existing.geometry) === JSON.stringify(body.geometry ?? null) &&
        JSON.stringify(existing.blueprint) === JSON.stringify(body.blueprint ?? null) &&
        (body.name === undefined || existing.name === body.name);
      if (!same)
        return json(
          { error: "A fork operation ID was reused with different content.", code: "operation_reused" },
          409,
        );
      return json({ dungeon: existing });
    }
  }
  if (raw.expectedRevision !== parent.revision)
    return json(
      {
        error: "The original changed. Reload before generating a version.",
        code: "revision_conflict",
        revision: parent.revision,
      },
      409,
    );
  try {
    const fork = forkDungeon(appDb(), id, {
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      seed: body.seed ?? null,
      config: (body.config ?? null) as never,
      geometry: (body.geometry ?? null) as never,
      blueprint: (body.blueprint ?? null) as never,
      operationId,
    });
    return fork === null
      ? notFound(`No dungeon ${id}`)
      : json({ dungeon: fork }, 201);
  } catch (err) {
    return serverError(err);
  }
}

export function handleListDungeonRevisions(
  id: number,
  query: URLSearchParams = new URLSearchParams(),
): Response {
  if (!getDungeon(appDb(), id)) return notFound(`No dungeon ${id}`);
  const kind = query.get("kind");
  const roomRaw = query.get("roomIndex");
  const roomIndex = roomRaw === null ? undefined : Number(roomRaw);
  if (kind !== null && kind !== "overview" && kind !== "room")
    return badRequest("kind must be overview or room");
  if (roomIndex !== undefined && !Number.isInteger(roomIndex))
    return badRequest("roomIndex must be an integer");
  return json({
    revisions: listDungeonRevisions(appDb(), id, {
      kind: kind as "overview" | "room" | undefined,
      roomIndex,
    }),
  });
}

export async function handleRestoreDungeonRevision(
  req: Request,
  dungeonId: number,
  revisionId: number,
): Promise<Response> {
  const current = getDungeon(appDb(), dungeonId);
  if (!current) return notFound(`No dungeon ${dungeonId}`);
  const body = await readJson<Record<string, unknown>>(req);
  const revision = getDungeonRevision(appDb(), dungeonId, revisionId);
  if (!revision) return notFound(`No revision ${revisionId}`);
  if (revision.kind === "room" && revision.roomIndex === null)
    return badRequest("Room revision is missing its room index");
  const parsed = MutationSchema.safeParse({
    expectedRevision: body?.expectedRevision,
    operationId: body?.operationId,
    patch:
      revision.kind === "overview"
        ? { overview: revision.content }
        : { roomNotes: [[revision.roomIndex, revision.content]] },
  });
  if (!parsed.success) return badRequest(parsed.error.message);
  return saveMutation(
    dungeonId,
    parsed.data as import("../campaign/types.ts").DungeonMutation,
  );
}

export async function handlePutRoomNote(
  req: Request,
  dungeonId: number,
  roomIndex: number,
): Promise<Response> {
  if (!getDungeon(appDb(), dungeonId))
    return notFound(`No dungeon ${dungeonId}`);
  const body = await readJson<Record<string, unknown>>(req);
  const parsed = MutationSchema.safeParse({
    expectedRevision: body?.expectedRevision,
    operationId: body?.operationId,
    patch: { roomNotes: [[roomIndex, body?.description]] },
  });
  if (!parsed.success) return badRequest(parsed.error.message);
  return saveMutation(
    dungeonId,
    parsed.data as import("../campaign/types.ts").DungeonMutation,
  );
}

export async function handleDeleteRoomNote(
  req: Request,
  dungeonId: number,
  roomIndex: number,
): Promise<Response> {
  if (!getDungeon(appDb(), dungeonId))
    return notFound(`No dungeon ${dungeonId}`);
  const body = await readJson<Record<string, unknown>>(req);
  const parsed = MutationSchema.safeParse({
    expectedRevision: body?.expectedRevision,
    operationId: body?.operationId,
    patch: { roomNotes: [[roomIndex, null]] },
  });
  if (!parsed.success) return badRequest(parsed.error.message);
  return saveMutation(
    dungeonId,
    parsed.data as import("../campaign/types.ts").DungeonMutation,
  );
}

/** The dungeon's single build log, created on first request. */
export function handleArchitectChat(dungeonId: number): Response {
  const db = appDb();
  if (getDungeon(db, dungeonId) === null)
    return notFound(`No dungeon ${dungeonId}`);
  try {
    return json({ chat: architectChat(db, dungeonId) });
  } catch (err) {
    return serverError(err);
  }
}
