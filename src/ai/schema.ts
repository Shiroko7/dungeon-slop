import { z } from "zod";

export const RoomShapeEnum = z.enum([
  "Rectangular",
  "Square",
  "Circular",
  "Hexagonal",
  "Pentagonal",
  "Cave",
  "Cross",
  "Diamond",
]);

export const DoorTypeEnum = z.enum([
  "Open",
  "Archway",
  "Portcullis",
  "Standard",
  "Locked",
  "Secure",
  "Trapped",
  "Secret",
]);

export type DoorType = z.infer<typeof DoorTypeEnum>;

export type RoomShape = z.infer<typeof RoomShapeEnum>;

export const DungeonConfigSchema = z.object({
  layout_style: z.enum(["constructed", "organic"]),
  motif: z.enum(["Default", "Infernal", "Aquatic", "Natural", "Arcane", "Undead", "Mechanical", "Frozen"]),
  room_layout: z.enum(["Sparse", "Moderate", "Dense"]),
  room_size: z.enum(["Tiny", "Small", "Medium", "Large", "Huge"]),
  room_count: z.number().int().min(3).max(50),
  corridors: z.enum(["Straight", "Winding", "Labyrinth"]),
  corridor_complexity: z.number().min(0).max(1),
  dead_ends: z.enum(["None", "Few", "Many"]),
  door_types: z.array(DoorTypeEnum).min(1).default(["Standard"]),
  trap_density: z.enum(["None", "Low", "Medium", "High"]),
  treasure_density: z.enum(["None", "Low", "Medium", "High"]),
  stairs: z.enum(["None", "Few", "Many"]),
  grid_type: z.enum(["Square"]),
  grid_width: z.number().int().min(20).max(1000),
  grid_height: z.number().int().min(20).max(1000),
  room_shapes: z.array(RoomShapeEnum).min(1).default(["Rectangular", "Circular", "Diamond", "Cross"]),
  theme_description: z.string(),
  seed: z.number().int().optional(),
});

export type DungeonConfig = z.infer<typeof DungeonConfigSchema>;

export const DEFAULT_CONFIG: DungeonConfig = {
  layout_style: "constructed",
  motif: "Default",
  room_layout: "Moderate",
  room_size: "Medium",
  room_count: 10,
  corridors: "Straight",
  corridor_complexity: 0.3,
  dead_ends: "Few",
  door_types: ["Standard"],
  trap_density: "Low",
  treasure_density: "Low",
  stairs: "Few",
  grid_type: "Square",
  grid_width: 100,
  grid_height: 100,
  room_shapes: ["Rectangular", "Circular", "Diamond", "Cross"],
  theme_description: "A standard stone dungeon",
};
