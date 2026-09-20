import { DEFAULT_CONFIG } from "./ai/schema.ts";
import type { Dungeon } from "./engine/types.ts";
import type { DungeonRecord } from "./campaign/types.ts";

export function geometry(roomIds = [0]): Dungeon {
  return {
    width: 20,
    height: 20,
    seed: 42,
    config: { ...DEFAULT_CONFIG, grid_width: 20, grid_height: 20 },
    grid: Array.from({ length: 20 }, () =>
      Array.from({ length: 20 }, () => ({
        type: 0,
        roomId: null,
        corridorId: null,
        featureId: null,
      })),
    ),
    rooms: roomIds.map((id) => ({
      id,
      x: 1,
      y: 1,
      width: 3,
      height: 3,
      centerX: 2,
      centerY: 2,
      shape: "Square",
      connections: [],
      features: [],
    })),
    corridors: [],
    features: [],
  };
}
export function dungeonRecord(id = 1): DungeonRecord {
  return {
    id,
    revision: 0,
    campaignId: 1,
    parentId: null,
    name: `Dungeon ${id}`,
    seed: 42,
    roomCount: 1,
    describedCount: 0,
    hasGeometry: true,
    createdAt: 0,
    updatedAt: 0,
    geometry: geometry(),
    config: DEFAULT_CONFIG,
    overview: null,
    blueprint: null,
    roomNotes: [],
  };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
