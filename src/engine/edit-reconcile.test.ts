import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../ai/schema.ts";
import { GeometrySchema } from "../api/mutation-schema.ts";
import { CellType, FeatureType, type Cell, type Dungeon } from "./types.ts";
import { reconcileDungeon } from "./edit-reconcile.ts";
import { EditEngine } from "./edit-engine.ts";

function makeDungeon(): Dungeon {
  const width = 9;
  const height = 5;
  const grid: Cell[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => ({
      type: CellType.Empty,
      roomId: null,
      corridorId: null,
      featureId: null,
    })),
  );

  const set = (x: number, y: number, cell: Partial<Cell>) => {
    grid[y]![x] = { ...grid[y]![x]!, ...cell };
  };
  for (const point of [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 3 }]) {
    set(point.x, point.y, { type: CellType.Floor, roomId: 7 });
  }
  for (const x of [6, 7]) set(x, 1, { type: CellType.Floor, roomId: 9 });
  for (const x of [3, 4, 5]) set(x, 1, { type: CellType.Corridor, corridorId: 3 });

  set(1, 1, { featureId: 2 });
  return {
    width,
    height,
    seed: 1,
    config: { ...DEFAULT_CONFIG, grid_width: width, grid_height: height, room_count: 2 },
    grid,
    rooms: [
      {
        id: 7,
        x: 1,
        y: 1,
        width: 2,
        height: 3,
        centerX: 1,
        centerY: 2,
        shape: "Square",
        connections: [9],
        features: [],
        role: "boss",
        tier: 2,
        plan: { key: "boss", name: "Boss" },
      },
      {
        id: 9,
        x: 6,
        y: 1,
        width: 2,
        height: 1,
        centerX: 6,
        centerY: 1,
        shape: "Square",
        connections: [7],
        features: [],
      },
    ],
    corridors: [{ id: 3, roomA: 7, roomB: 9, path: [{ x: 3, y: 1 }, { x: 4, y: 1 }, { x: 5, y: 1 }], width: 1 }],
    features: [
      { id: 1, type: FeatureType.Trap, x: 1, y: 1 },
      { id: 2, type: FeatureType.Trap, x: 1, y: 1 },
    ],
    report: {
      requestedRooms: 2,
      deliveredRooms: 2,
      capacityRooms: 2,
      junctionsAdded: 0,
      longestCorridorCells: 3,
      hasLoop: false,
    },
  };
}

describe("manual edit reconciliation", () => {
  test("splits room footprints while retaining authored identity only on the anchored component", () => {
    const result = reconcileDungeon(makeDungeon(), { affectedRoomIds: new Set([7]) });
    const original = result.rooms.find((room) => room.id === 7)!;
    const split = result.rooms.find((room) => room.id !== 7 && room.footprint?.some((p) => p.y === 3));

    expect(original.footprint).toEqual([{ x: 1, y: 1 }, { x: 2, y: 1 }]);
    expect(split).toBeDefined();
    expect(split!.role).toBeUndefined();
    expect(split!.plan).toBeUndefined();
    expect(result.grid[3]![1]!.roomId).toBe(split!.id);
    expect(result.editStatus?.narrativeStale).toBe(true);
  });

  test("deduplicates features and derives corridor endpoints and symmetric connections", () => {
    const result = reconcileDungeon(makeDungeon(), { affectedRoomIds: new Set([7, 9]) });

    expect(result.features).toHaveLength(1);
    expect(result.grid[1]![1]!.featureId).toBe(result.features[0]!.id);
    expect(result.corridors[0]!.roomA).toBe(7);
    expect(result.corridors[0]!.roomB).toBe(9);
    expect(result.rooms.find((room) => room.id === 7)!.connections).toEqual([9]);
    expect(result.rooms.find((room) => room.id === 9)!.connections).toEqual([7]);
  });

  test("splits a disconnected corridor and reports rooms no longer reachable", () => {
    const dungeon = makeDungeon();
    dungeon.grid[1]![4] = { type: CellType.Empty, roomId: null, corridorId: null, featureId: null };
    const result = reconcileDungeon(dungeon);

    expect(result.corridors).toHaveLength(2);
    expect(result.corridors.every((corridor) => corridor.path.length > 0)).toBe(true);
    expect(result.editStatus?.disconnectedRoomIds).toContain(9);
    expect(result.rooms.every((room) => room.connections.length === 0)).toBe(true);
  });
});

test("edit strokes interpolate pointer samples into a continuous path", () => {
  const engine = new EditEngine();
  engine.startStroke(1, 1, "floor");
  engine.extendStroke(4, 3);

  expect(engine.activeStroke[0]).toEqual({ x: 1, y: 1 });
  expect(engine.activeStroke.at(-1)).toEqual({ x: 4, y: 3 });
  for (let i = 1; i < engine.activeStroke.length; i++) {
    const previous = engine.activeStroke[i - 1]!;
    const current = engine.activeStroke[i]!;
    expect(Math.max(Math.abs(current.x - previous.x), Math.abs(current.y - previous.y))).toBeLessThanOrEqual(1);
  }
});

test("manual dead-end corridor endpoints are valid persisted geometry", () => {
  const dungeon = makeDungeon();
  dungeon.config = { ...dungeon.config, grid_width: 20, grid_height: 20 };
  dungeon.corridors[0]!.roomB = -1;
  expect(() => GeometrySchema.parse(dungeon)).not.toThrow();
});
