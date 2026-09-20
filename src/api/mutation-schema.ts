import { z } from "zod";
import { DungeonConfigSchema } from "../ai/schema.ts";
import { BlueprintSchema } from "../ai/blueprint.ts";

const id = z.number().int().nonnegative();
const point = z.object({ x: z.number(), y: z.number() });
const feature = point
  .extend({
    id,
    type: z.enum([
      "door",
      "secret_door",
      "locked_door",
      "portcullis",
      "archway",
      "trapped_door",
      "trap",
      "treasure",
      "stairs_up",
      "stairs_down",
    ]),
  })
  .passthrough();
export const RoomDescriptionSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    features: z.string().optional(),
    entries: z
      .array(
        z.object({
          direction: z.string(),
          doorType: z.string(),
          leadsTo: z.string(),
          trap: z.string().optional(),
        }),
      )
      .optional(),
    monsters: z.array(z.string()).optional(),
    treasure: z.array(z.string()).optional(),
    hiddenTreasure: z.string().optional(),
    traps: z.array(z.string()).optional(),
    tricks: z.array(z.string()).optional(),
    notes: z.string().optional(),
    empty: z.boolean().optional(),
  })
  .strict();
export const RoomSchema = point
  .extend({
    id,
    width: z.number().positive(),
    height: z.number().positive(),
    centerX: z.number(),
    centerY: z.number(),
    shape: z.string(),
    connections: z.array(id),
    features: z.array(feature),
  })
  .passthrough();
export const GeometrySchema = z
  .object({
    width: z.number().int().positive().max(1000),
    height: z.number().int().positive().max(1000),
    grid: z.array(
      z.array(
        z.object({
          type: z.number().int().min(0).max(7),
          roomId: id.nullable(),
          corridorId: id.nullable(),
          featureId: id.nullable(),
        }),
      ),
    ),
    rooms: z.array(RoomSchema),
    corridors: z.array(
      z
        .object({
          id,
          roomA: id,
          roomB: id,
          path: z.array(point),
          width: z.number().positive(),
        })
        .passthrough(),
    ),
    features: z.array(feature),
    config: DungeonConfigSchema,
    seed: z.number().int(),
  })
  .passthrough()
  .refine(
    (d) =>
      d.grid.length === d.height &&
      d.grid.every((row) => row.length === d.width),
    "Grid dimensions do not match",
  )
  .refine(
    (d) => new Set(d.rooms.map((r) => r.id)).size === d.rooms.length,
    "Duplicate room IDs",
  );
export const OverviewSchema = z
  .object({
    history: z.string(),
    size: z.string().optional(),
    walls: z.string().optional(),
    floor: z.string().optional(),
    temperature: z.string().optional(),
    illumination: z.string().optional(),
    corridorFeatures: z.array(
      z.object({ label: z.string(), corridorId: id, description: z.string() }),
    ),
    wanderingMonsters: z.array(z.string()),
  })
  .strict();
export const DungeonPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(300).optional(),
    seed: z.number().int().nullable().optional(),
    config: DungeonConfigSchema.nullable().optional(),
    geometry: GeometrySchema.nullable().optional(),
    overview: OverviewSchema.nullable().optional(),
    blueprint: BlueprintSchema.nullable().optional(),
    roomNotes: z
      .array(z.tuple([id, RoomDescriptionSchema.nullable()]))
      .optional(),
  })
  .strict();
export const MutationSchema = z
  .object({
    expectedRevision: id,
    operationId: z.string().uuid(),
    patch: DungeonPatchSchema.refine(
      (patch) => Object.keys(patch).length > 0,
      "An empty save is not a mutation",
    ),
  })
  .strict();
