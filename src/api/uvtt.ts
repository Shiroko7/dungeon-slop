/**
 * Maps for virtual tabletops, as Universal VTT geometry (no image).
 *
 *   POST /api/uvtt                    generate a fresh map: { config?: Partial<DungeonConfig>, seed? }
 *   GET  /api/dungeons/:id/uvtt       a saved map, edits included
 *
 * The response is a `.uvtt` document whose `image` is "": a table that wants
 * art draws its own from the floor mask, or the user exports the full file
 * (image included) from the editor.
 */
import { z } from "zod";
import { DEFAULT_CONFIG, DungeonConfigSchema } from "../ai/schema.ts";
import { generateDungeon } from "../engine/generate.ts";
import { getDungeon } from "../campaign/dungeons.ts";
import { appDb } from "../db/context.ts";
import { dungeonToUVTT } from "../export/uvtt.ts";
import { badRequest, json, notFound, readJson, serverError } from "./http.ts";

const GenerateBody = z.object({
  config: DungeonConfigSchema.partial().optional(),
  seed: z.number().int().min(0).max(2147483647).optional(),
});

/** Keeps a generated map within what a tabletop can render and send to every player. */
const MAX_SIDE = 160;

export async function handleGenerateUVTT(req: Request): Promise<Response> {
  const parsed = GenerateBody.safeParse((await readJson(req)) ?? {});
  if (!parsed.success) return badRequest(parsed.error.message);
  const { config: overrides = {}, seed } = parsed.data;
  const config = DungeonConfigSchema.safeParse({ ...DEFAULT_CONFIG, grid_width: 60, grid_height: 60, ...overrides, ...(seed !== undefined ? { seed } : {}) });
  if (!config.success) return badRequest(config.error.message);
  if (config.data.grid_width > MAX_SIDE || config.data.grid_height > MAX_SIDE) {
    return badRequest(`Maps for the table are at most ${MAX_SIDE} squares a side`);
  }
  try {
    return json({ uvtt: dungeonToUVTT(generateDungeon(config.data)) });
  } catch (err) {
    return serverError(err);
  }
}

export function handleDungeonUVTT(id: number): Response {
  const record = getDungeon(appDb(), id);
  if (record === null) return notFound(`No dungeon ${id}`);
  if (record.geometry === null) return notFound(`Dungeon ${id} has no map yet`);
  return json({ name: record.name, uvtt: dungeonToUVTT(record.geometry) });
}
