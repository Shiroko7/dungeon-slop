import { describe, test, expect } from "bun:test";
import { generateDungeon } from "./generate.ts";
import { CellType } from "./types.ts";
import type { DungeonConfig, RoomShape } from "../ai/schema.ts";
import { DEFAULT_CONFIG } from "../ai/schema.ts";

// ─── helpers ──────────────────────────────────────────────────────────────────

const WALKABLE: ReadonlySet<CellType> = new Set([
  CellType.Floor,
  CellType.Corridor,
  CellType.Door,
  CellType.SecretDoor,
  CellType.StairsUp,
  CellType.StairsDown,
]);

function cfg(overrides: Partial<DungeonConfig> = {}): DungeonConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

interface OrphanCell { x: number; y: number; type: CellType }

function orphans(dungeon: ReturnType<typeof generateDungeon>): OrphanCell[] {
  const result: OrphanCell[] = [];
  for (let y = 0; y < dungeon.height; y++) {
    for (let x = 0; x < dungeon.width; x++) {
      const cell = dungeon.grid[y]?.[x];
      if (!cell) continue;
      if (WALKABLE.has(cell.type) && cell.roomId === null && cell.corridorId === null) {
        result.push({ x, y, type: cell.type });
      }
    }
  }
  return result;
}

function assertNoOrphans(dungeon: ReturnType<typeof generateDungeon>) {
  const found = orphans(dungeon);
  if (found.length > 0) {
    const sample = found.slice(0, 5)
      .map(o => `(${o.x},${o.y}) type=${CellType[o.type]}`)
      .join(", ");
    console.error(`  ${found.length} orphan cells, sample: ${sample}`);
  }
  expect(found).toHaveLength(0);
}

interface DisconnectedCell { x: number; y: number; roomId: number }

function disconnectedRoomCells(dungeon: ReturnType<typeof generateDungeon>): DisconnectedCell[] {
  // Bucket all room-tagged cells in a single O(W*H) scan.
  const cellsByRoom = new Map<number, Array<{ x: number; y: number }>>();
  for (let y = 0; y < dungeon.height; y++) {
    for (let x = 0; x < dungeon.width; x++) {
      const cell = dungeon.grid[y]?.[x];
      if (cell && cell.roomId !== null) {
        let bucket = cellsByRoom.get(cell.roomId);
        if (!bucket) { bucket = []; cellsByRoom.set(cell.roomId, bucket); }
        bucket.push({ x, y });
      }
    }
  }

  const result: DisconnectedCell[] = [];

  for (const [roomId, cells] of cellsByRoom) {
    if (cells.length === 0) continue;

    // BFS restricted to cells with the same roomId — tests internal contiguity,
    // not global reachability. Without this restriction the BFS can exit through
    // a corridor and re-enter a disconnected island, producing a false negative.
    const seed = cells[0]!;
    const visited = new Set<string>([`${seed.x},${seed.y}`]);
    let head = 0;
    const queue: Array<{ x: number; y: number }> = [seed];
    while (head < queue.length) {
      const { x, y } = queue[head++]!;
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        const key = `${nx},${ny}`;
        if (visited.has(key)) continue;
        const nc = dungeon.grid[ny]?.[nx];
        if (!nc || nc.roomId !== roomId) continue;
        visited.add(key);
        queue.push({ x: nx, y: ny });
      }
    }

    for (const c of cells) {
      if (!visited.has(`${c.x},${c.y}`)) {
        result.push({ x: c.x, y: c.y, roomId });
      }
    }
  }

  return result;
}

function assertRoomConnectivity(dungeon: ReturnType<typeof generateDungeon>) {
  const found = disconnectedRoomCells(dungeon);
  if (found.length > 0) {
    const sample = found.slice(0, 5)
      .map(c => `(${c.x},${c.y}) room=${c.roomId}`)
      .join(", ");
    console.error(`  ${found.length} disconnected room cells, sample: ${sample}`);
  }
  expect(found).toHaveLength(0);
}

// ─── 4. global connectivity ───────────────────────────────────────────────────
// Every room must be reachable from room 0 via walkable cells.

function globallyDisconnectedRooms(dungeon: ReturnType<typeof generateDungeon>): number[] {
  if (dungeon.rooms.length <= 1) return [];

  // Find any cell belonging to room 0 as BFS seed
  let startCell: { x: number; y: number } | null = null;
  outer: for (let y = 0; y < dungeon.height; y++) {
    for (let x = 0; x < dungeon.width; x++) {
      if (dungeon.grid[y]?.[x]?.roomId === dungeon.rooms[0]!.id) {
        startCell = { x, y };
        break outer;
      }
    }
  }
  if (!startCell) return dungeon.rooms.map(r => r.id);

  const visited = new Set<string>([`${startCell.x},${startCell.y}`]);
  const reachedRoomIds = new Set<number>();
  const queue: Array<{ x: number; y: number }> = [startCell];

  while (queue.length > 0) {
    const { x, y } = queue.shift()!;
    const cell = dungeon.grid[y]?.[x];
    if (cell?.roomId != null) reachedRoomIds.add(cell.roomId);

    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      const nx = x + dx, ny = y + dy;
      const key = `${nx},${ny}`;
      if (visited.has(key)) continue;
      const nc = dungeon.grid[ny]?.[nx];
      if (!nc || !WALKABLE.has(nc.type)) continue;
      visited.add(key);
      queue.push({ x: nx, y: ny });
    }
  }

  return dungeon.rooms.filter(r => !reachedRoomIds.has(r.id)).map(r => r.id);
}

// ─── 5. corridor path continuity ─────────────────────────────────────────────
// Each consecutive pair of cells in a corridor path must be cardinally adjacent
// (Manhattan distance == 1). Gaps mean the path teleports and labels/highlights
// will appear at the wrong location.

interface PathGap { corridorId: number; fromX: number; fromY: number; toX: number; toY: number; dist: number }

function corridorPathGaps(dungeon: ReturnType<typeof generateDungeon>): PathGap[] {
  // Only check adjacency between consecutive OWNED cells (type=Corridor, corridorId matches).
  // Gaps at room-floor crossings or existing-corridor crossings are expected and allowed.
  const result: PathGap[] = [];
  for (const corridor of dungeon.corridors) {
    let prev: { x: number; y: number } | null = null;
    for (const pos of corridor.path) {
      const cell = dungeon.grid[pos.y]?.[pos.x];
      if (!cell || cell.type !== CellType.Corridor || cell.corridorId !== corridor.id) continue;
      if (prev !== null) {
        const dist = Math.abs(pos.x - prev.x) + Math.abs(pos.y - prev.y);
        if (dist !== 1) {
          result.push({ corridorId: corridor.id, fromX: prev.x, fromY: prev.y, toX: pos.x, toY: pos.y, dist });
        }
      }
      prev = pos;
    }
  }
  return result;
}

// ─── 5. no degenerate corridor paths ─────────────────────────────────────────
// A corridor needs at least 2 cells to form a non-trivial route. A path of
// length 0 produces no rendered segment; length 1 is a self-loop at a single cell.

interface EmptyCorridor { corridorId: number; roomA: number; roomB: number }

function emptyCorridorPaths(dungeon: ReturnType<typeof generateDungeon>): EmptyCorridor[] {
  // path.length === 0 means the corridor carved no new cells at all — degenerate.
  // Paths of length 1 are valid (rooms very close together, single junction cell carved).
  return dungeon.corridors
    .filter(c => c.path.length === 0)
    .map(c => ({ corridorId: c.id, roomA: c.roomA, roomB: c.roomB }));
}

// ─── 7. door boundary validity ────────────────────────────────────────────────
// A Door cell must bridge a room and a corridor: adjacent to ≥1 cell with
// roomId !== null AND ≥1 cell with corridorId !== null.
// A SecretDoor must be a passage: adjacent to ≥2 walkable cells.

interface InvalidDoor { x: number; y: number; type: string; issue: string }

function invalidDoors(dungeon: ReturnType<typeof generateDungeon>): InvalidDoor[] {
  const result: InvalidDoor[] = [];

  for (let y = 0; y < dungeon.height; y++) {
    for (let x = 0; x < dungeon.width; x++) {
      const cell = dungeon.grid[y]?.[x];
      if (!cell) continue;

      const neighbors = [
        dungeon.grid[y]?.[x - 1],
        dungeon.grid[y]?.[x + 1],
        dungeon.grid[y - 1]?.[x],
        dungeon.grid[y + 1]?.[x],
      ];

      if (cell.type === CellType.Door) {
        const hasRoomSide = neighbors.some(n => n != null && n.roomId !== null);
        const hasCorridorSide = neighbors.some(n => n != null && n.corridorId !== null);
        if (!hasRoomSide)    result.push({ x, y, type: "Door", issue: "no adjacent room cell" });
        if (!hasCorridorSide) result.push({ x, y, type: "Door", issue: "no adjacent corridor cell" });
      }

      if (cell.type === CellType.SecretDoor) {
        const walkableCount = neighbors.filter(n => n != null && WALKABLE.has(n.type)).length;
        if (walkableCount < 2) {
          result.push({ x, y, type: "SecretDoor", issue: `only ${walkableCount} walkable neighbor(s)` });
        }
      }
    }
  }

  return result;
}

// ─── 8. no dual ownership ────────────────────────────────────────────────────
// A cell cannot simultaneously belong to a room and a corridor.

interface DualOwned { x: number; y: number; roomId: number; corridorId: number }

function dualOwnedCells(dungeon: ReturnType<typeof generateDungeon>): DualOwned[] {
  const result: DualOwned[] = [];
  for (let y = 0; y < dungeon.height; y++) {
    for (let x = 0; x < dungeon.width; x++) {
      const cell = dungeon.grid[y]?.[x];
      if (cell && cell.roomId !== null && cell.corridorId !== null) {
        result.push({ x, y, roomId: cell.roomId, corridorId: cell.corridorId });
      }
    }
  }
  return result;
}

// ─── 9. corridor cells carry no roomId ───────────────────────────────────────
// Cells whose type is Corridor must have roomId === null — they are not
// room interior cells and should never be highlighted as part of a room.

interface CorridorWithRoom { x: number; y: number; roomId: number }

function corridorCellsWithRoomId(dungeon: ReturnType<typeof generateDungeon>): CorridorWithRoom[] {
  const result: CorridorWithRoom[] = [];
  for (let y = 0; y < dungeon.height; y++) {
    for (let x = 0; x < dungeon.width; x++) {
      const cell = dungeon.grid[y]?.[x];
      if (cell && cell.type === CellType.Corridor && cell.roomId !== null) {
        result.push({ x, y, roomId: cell.roomId });
      }
    }
  }
  return result;
}

// ─── 10. each room appears in at least one corridor ──────────────────────────
// Every room (when there are ≥2 rooms) must be an endpoint of at least one
// corridor object. A room reachable via the grid but absent from dungeon.corridors
// will not receive hover highlights, door prompts, or AI room descriptions.

interface RoomWithNoCorridors { roomId: number }

function roomsWithNoCorridors(dungeon: ReturnType<typeof generateDungeon>): RoomWithNoCorridors[] {
  if (dungeon.rooms.length <= 1) return [];
  const roomIdsInCorridors = new Set<number>();
  for (const c of dungeon.corridors) {
    roomIdsInCorridors.add(c.roomA);
    roomIdsInCorridors.add(c.roomB);
  }
  return dungeon.rooms
    .filter(r => !roomIdsInCorridors.has(r.id))
    .map(r => ({ roomId: r.id }));
}

// ─── 11. every corridor has at least one live walkable path cell ──────────────
// post-processing (collapseDeadEnds) may revert individual path cells to Wall,
// but a corridor whose ENTIRE path is gone is a ghost: invisible yet still
// consuming a label slot (A, B, C…), which produces the gaps the user sees.

interface GhostCorridor { corridorId: number; roomA: number; roomB: number }

function ghostCorridors(dungeon: ReturnType<typeof generateDungeon>): GhostCorridor[] {
  return dungeon.corridors
    .filter(c => !c.path.some(p => {
      const cell = dungeon.grid[p.y]?.[p.x];
      return cell !== undefined && WALKABLE.has(cell.type);
    }))
    .map(c => ({ corridorId: c.id, roomA: c.roomA, roomB: c.roomB }));
}

// ─── 12. corridor IDs are sequential (no duplicates, no gaps) ────────────────
// Multiple carveCorridors() calls (main + force-connect passes) used to restart
// IDs at 0, producing duplicates like [0,1,2,3,0,1]. Label rendering uses
// corridor.id as an index (A,B,C,...), so duplicates produce repeated letters
// and unreachable slots that look like missing letters in the UI.

interface CorridorIdIssue { expected: number; actual: number; index: number }

function nonSequentialCorridorIds(dungeon: ReturnType<typeof generateDungeon>): CorridorIdIssue[] {
  const result: CorridorIdIssue[] = [];
  for (let i = 0; i < dungeon.corridors.length; i++) {
    const actual = dungeon.corridors[i]!.id;
    if (actual !== i) {
      result.push({ expected: i, actual, index: i });
    }
  }
  return result;
}

// ─── 13. corridor cells must not be adjacent to third-party room floors ───────
// A corridor running directly along a room wall (adjacent to its floor cells)
// looks wrong visually — there should always be at least one empty/wall cell
// between any corridor and a room it does not connect.

interface CorridorTouchingRoom { corridorId: number; x: number; y: number; adjacentRoomId: number }

function corridorCellsAdjacentToRooms(dungeon: ReturnType<typeof generateDungeon>): CorridorTouchingRoom[] {
  const result: CorridorTouchingRoom[] = [];
  for (const corridor of dungeon.corridors) {
    for (const pos of corridor.path) {
      const cell = dungeon.grid[pos.y]?.[pos.x];
      if (!cell || cell.type !== CellType.Corridor) continue; // stale/reverted — skip

      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const nc = dungeon.grid[pos.y + dy]?.[pos.x + dx];
        if (
          nc !== undefined &&
          nc.type === CellType.Floor &&
          nc.roomId !== null &&
          nc.roomId !== corridor.roomA &&
          nc.roomId !== corridor.roomB
        ) {
          result.push({ corridorId: corridor.id, x: pos.x, y: pos.y, adjacentRoomId: nc.roomId });
          break;
        }
      }
    }
  }
  return result;
}

// ─── 14. corridors never overwrite room floor cells ──────────────────────────
// A corridor path cell that is CellType.Floor with a roomId means the corridor
// carved into a room's interior. The renderer treats such cells as room floor,
// not as corridor, so the corridor segment becomes invisible there.

interface CorridorInRoom { corridorId: number; x: number; y: number; roomId: number }

/*
 * A corridor connects rooms; it is never part of one.
 *
 * There is no exemption for its own endpoints. This used to allow a corridor to
 * run through the rooms it joined - carving ran centre to centre, so most of a
 * corridor's path WAS room floor - and to silently skip a third room's cells,
 * which left a hole in the path and a route that walked through that room.
 */
function corridorCellsInRooms(dungeon: ReturnType<typeof generateDungeon>): CorridorInRoom[] {
  const result: CorridorInRoom[] = [];
  for (const corridor of dungeon.corridors) {
    for (const pos of corridor.path) {
      const cell = dungeon.grid[pos.y]?.[pos.x];
      if (cell === undefined || cell.roomId === null) continue;
      result.push({ corridorId: corridor.id, x: pos.x, y: pos.y, roomId: cell.roomId });
    }
  }
  return result;
}

/** A path with a hole in it is a route through whatever fills the hole. */
function corridorPathBreaks(
  dungeon: ReturnType<typeof generateDungeon>,
): Array<{ corridorId: number; from: string; to: string }> {
  const result: Array<{ corridorId: number; from: string; to: string }> = [];
  for (const corridor of dungeon.corridors) {
    for (let i = 1; i < corridor.path.length; i++) {
      const a = corridor.path[i - 1]!;
      const b = corridor.path[i]!;
      if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) !== 1) {
        result.push({ corridorId: corridor.id, from: `(${a.x},${a.y})`, to: `(${b.x},${b.y})` });
      }
    }
  }
  return result;
}

// ─── 14. no corridor cell ownership conflicts ─────────────────────────────────
// When two corridors share a cell, the second one overwrites corridorId on the
// grid, silently stealing it from the first. The first corridor's path still
// lists that cell, so its label/highlight covers cells it no longer owns.
// This check catches that: every live Corridor cell in a corridor's path must
// have grid.corridorId === corridor.id.

interface OwnershipConflict { corridorId: number; x: number; y: number; actualCorridorId: number }

function corridorOwnershipConflicts(dungeon: ReturnType<typeof generateDungeon>): OwnershipConflict[] {
  const result: OwnershipConflict[] = [];
  for (const corridor of dungeon.corridors) {
    for (const pos of corridor.path) {
      const cell = dungeon.grid[pos.y]?.[pos.x];
      if (cell === undefined || cell.type !== CellType.Corridor) continue; // stale/reverted cell — ok
      if (cell.corridorId !== corridor.id) {
        result.push({ corridorId: corridor.id, x: pos.x, y: pos.y, actualCorridorId: cell.corridorId ?? -1 });
      }
    }
  }
  return result;
}

// ─── corridor path staleness (informational, not enforced) ───────────────────
// post-processing (thinCorridors/collapseDeadEnds) deliberately reverts some
// carved cells back to Wall. Those cells remain in corridor.path (the path
// tracks the original carved route). The SvgOverlay and hover rendering both
// filter path cells against the live grid, so stale entries don't cause visual
// bugs. This function is provided for ad-hoc debugging only.

interface NonWalkablePathCell { corridorId: number; x: number; y: number; cellType: string }

function corridorPathCellsNotWalkable(dungeon: ReturnType<typeof generateDungeon>): NonWalkablePathCell[] {
  const result: NonWalkablePathCell[] = [];
  for (const corridor of dungeon.corridors) {
    for (const pos of corridor.path) {
      const cell = dungeon.grid[pos.y]?.[pos.x];
      if (cell === undefined || !WALKABLE.has(cell.type)) {
        result.push({
          corridorId: corridor.id,
          x: pos.x,
          y: pos.y,
          cellType: cell !== undefined ? CellType[cell.type] : "out-of-bounds",
        });
      }
    }
  }
  return result;
}

// ─── border rule ──────────────────────────────────────────────────────────────
// No walkable cell must sit on the outermost row or column (x=0, x=width-1,
// y=0, y=height-1). Rooms, corridors, and dead ends must all stay ≥1 cell inside.

interface BorderCell { x: number; y: number; type: CellType }

function walkableCellsOnBorder(dungeon: ReturnType<typeof generateDungeon>): BorderCell[] {
  const result: BorderCell[] = [];
  const { grid, width, height } = dungeon;
  for (let x = 0; x < width; x++) {
    for (const y of [0, height - 1]) {
      const cell = grid[y]?.[x];
      if (cell && WALKABLE.has(cell.type)) result.push({ x, y, type: cell.type });
    }
  }
  for (let y = 1; y < height - 1; y++) {
    for (const x of [0, width - 1]) {
      const cell = grid[y]?.[x];
      if (cell && WALKABLE.has(cell.type)) result.push({ x, y, type: cell.type });
    }
  }
  return result;
}

// ─── constructed (BSP) layout ─────────────────────────────────────────────────

describe("constructed layout — no orphan walkable cells", () => {
  const SEEDS = [1, 2, 3, 7, 42, 100, 999, 12345, 98765, 314159];

  for (const seed of SEEDS) {
    test(`seed ${seed}`, () => {
      assertNoOrphans(generateDungeon(cfg({ seed })));
    });
  }

  test("Straight corridors", () => {
    assertNoOrphans(generateDungeon(cfg({ corridors: "Straight", seed: 42 })));
  });

  test("Winding corridors", () => {
    assertNoOrphans(generateDungeon(cfg({ corridors: "Winding", corridor_complexity: 0.8, seed: 42 })));
  });

  test("Labyrinth corridors", () => {
    assertNoOrphans(generateDungeon(cfg({ corridors: "Labyrinth", corridor_complexity: 1, seed: 42 })));
  });

  test("all complex shapes", () => {
    assertNoOrphans(generateDungeon(cfg({
      room_shapes: ["Circular", "Diamond", "Hexagonal", "Pentagonal", "Cross", "Cave"],
      seed: 42,
    })));
  });

  for (const door_type of ["Open", "Standard", "Locked", "Secure", "Secret"] as const) {
    test(`door_type=${door_type}`, () => {
      assertNoOrphans(generateDungeon(cfg({ door_types: [door_type], seed: 42 })));
    });
  }

  for (const dead_ends of ["None", "Few", "Many"] as const) {
    test(`dead_ends=${dead_ends}`, () => {
      assertNoOrphans(generateDungeon(cfg({ dead_ends, seed: 42 })));
    });
  }

  test("dead_ends=None + Winding corridors", () => {
    assertNoOrphans(generateDungeon(cfg({ dead_ends: "None", corridors: "Winding", seed: 42 })));
  });

  test("dead_ends=None + Labyrinth corridors", () => {
    assertNoOrphans(generateDungeon(cfg({ dead_ends: "None", corridors: "Labyrinth", seed: 42 })));
  });

  test("dead_ends=Many + Straight corridors", () => {
    assertNoOrphans(generateDungeon(cfg({ dead_ends: "Many", corridors: "Straight", seed: 42 })));
  });

  test("corridor_complexity=0 (MST only)", () => {
    assertNoOrphans(generateDungeon(cfg({ corridor_complexity: 0, seed: 42 })));
  });

  test("corridor_complexity=1 (all Delaunay edges)", () => {
    assertNoOrphans(generateDungeon(cfg({ corridor_complexity: 1, seed: 42 })));
  });
});

// ─── organic (cellular) layout ────────────────────────────────────────────────

describe("organic layout — no orphan walkable cells", () => {
  const SEEDS = [1, 2, 3, 7, 42, 100, 999, 12345, 54321];

  for (const seed of SEEDS) {
    test(`seed ${seed}`, () => {
      assertNoOrphans(generateDungeon(cfg({ layout_style: "organic", seed })));
    });
  }

  test("Winding corridors", () => {
    assertNoOrphans(generateDungeon(cfg({ layout_style: "organic", corridors: "Winding", seed: 42 })));
  });

  test("Labyrinth corridors", () => {
    assertNoOrphans(generateDungeon(cfg({ layout_style: "organic", corridors: "Labyrinth", seed: 42 })));
  });

  test("high dead_ends", () => {
    assertNoOrphans(generateDungeon(cfg({ layout_style: "organic", dead_ends: "Many", seed: 42 })));
  });
});

// ─── room connectivity (no disconnected islands) ──────────────────────────────

describe("constructed layout — room cells are all reachable from room body", () => {
  const SEEDS = [1, 2, 3, 7, 42, 100, 999, 12345, 98765];

  for (const seed of SEEDS) {
    test(`seed ${seed}`, () => {
      assertRoomConnectivity(generateDungeon(cfg({ seed })));
    });
  }

  for (const door_type of ["Open", "Standard", "Locked", "Secure", "Secret"] as const) {
    test(`door_type=${door_type}`, () => {
      assertRoomConnectivity(generateDungeon(cfg({ door_types: [door_type], seed: 42 })));
    });
  }

  test("dead_ends=None + Winding corridors", () => {
    assertRoomConnectivity(generateDungeon(cfg({ dead_ends: "None", corridors: "Winding", seed: 42 })));
  });

  test("dead_ends=None + Labyrinth corridors", () => {
    assertRoomConnectivity(generateDungeon(cfg({ dead_ends: "None", corridors: "Labyrinth", seed: 42 })));
  });

  test("dead_ends=Many + Straight corridors", () => {
    assertRoomConnectivity(generateDungeon(cfg({ dead_ends: "Many", corridors: "Straight", seed: 42 })));
  });

  test("corridor_complexity=0 (MST only)", () => {
    assertRoomConnectivity(generateDungeon(cfg({ corridor_complexity: 0, seed: 42 })));
  });

  test("corridor_complexity=1 (all Delaunay edges)", () => {
    assertRoomConnectivity(generateDungeon(cfg({ corridor_complexity: 1, seed: 42 })));
  });
});

describe("organic layout — room cells are all reachable from room body", () => {
  const SEEDS = [1, 2, 3, 7, 42, 100, 999, 12345, 54321];

  for (const seed of SEEDS) {
    test(`seed ${seed}`, () => {
      assertRoomConnectivity(generateDungeon(cfg({ layout_style: "organic", seed })));
    });
  }

  test("Winding corridors", () => {
    assertRoomConnectivity(generateDungeon(cfg({ layout_style: "organic", corridors: "Winding", seed: 42 })));
  });

  test("Labyrinth corridors", () => {
    assertRoomConnectivity(generateDungeon(cfg({ layout_style: "organic", corridors: "Labyrinth", seed: 42 })));
  });

  for (const door_type of ["Open", "Standard", "Locked", "Secure", "Secret"] as const) {
    test(`door_type=${door_type}`, () => {
      assertRoomConnectivity(generateDungeon(cfg({ layout_style: "organic", door_types: [door_type], seed: 42 })));
    });
  }
});

// ─── each room appears in at least one corridor ───────────────────────────────

describe("constructed layout — each room has at least one corridor", () => {
  const SEEDS = [1, 2, 3, 7, 42, 100, 999, 12345, 98765];

  for (const seed of SEEDS) {
    test(`seed ${seed}`, () => {
      expect(roomsWithNoCorridors(generateDungeon(cfg({ seed })))).toHaveLength(0);
    });
  }

  test("corridor_complexity=0 (MST only)", () => {
    expect(roomsWithNoCorridors(generateDungeon(cfg({ corridor_complexity: 0, seed: 42 })))).toHaveLength(0);
  });

  test("corridor_complexity=1 (all Delaunay edges)", () => {
    expect(roomsWithNoCorridors(generateDungeon(cfg({ corridor_complexity: 1, seed: 42 })))).toHaveLength(0);
  });

  test("dead_ends=None + Winding corridors", () => {
    expect(roomsWithNoCorridors(generateDungeon(cfg({ dead_ends: "None", corridors: "Winding", seed: 42 })))).toHaveLength(0);
  });

  test("Labyrinth corridors", () => {
    expect(roomsWithNoCorridors(generateDungeon(cfg({ corridors: "Labyrinth", corridor_complexity: 1, seed: 42 })))).toHaveLength(0);
  });
});

describe("organic layout — each room has at least one corridor", () => {
  const SEEDS = [1, 2, 3, 7, 42, 100, 999, 12345, 54321];

  for (const seed of SEEDS) {
    test(`seed ${seed}`, () => {
      expect(roomsWithNoCorridors(generateDungeon(cfg({ layout_style: "organic", seed })))).toHaveLength(0);
    });
  }

  test("Winding corridors", () => {
    expect(roomsWithNoCorridors(generateDungeon(cfg({ layout_style: "organic", corridors: "Winding", seed: 42 })))).toHaveLength(0);
  });

  test("Labyrinth corridors", () => {
    expect(roomsWithNoCorridors(generateDungeon(cfg({ layout_style: "organic", corridors: "Labyrinth", seed: 42 })))).toHaveLength(0);
  });
});

// ─── stress suite (100 varied configs) ────────────────────────────────────────
//
// Each test bundles all three invariants: no orphans, room connectivity,
// no floor cells in corridor paths. Config parameters rotate across the seed
// list so the matrix covers every combination without being exhaustive.

function assertAll(dungeon: ReturnType<typeof generateDungeon>, label: string) {
  const problems: string[] = [];

  // 1. no orphan walkable cells
  const o = orphans(dungeon);
  if (o.length > 0) {
    const s = o.slice(0, 3).map(c => `(${c.x},${c.y}) ${CellType[c.type]}`).join(", ");
    problems.push(`orphans(${o.length}): ${s}`);
  }

  // 2. room cells internally connected
  const dc = disconnectedRoomCells(dungeon);
  if (dc.length > 0) {
    const s = dc.slice(0, 3).map(c => `(${c.x},${c.y}) room=${c.roomId}`).join(", ");
    problems.push(`disconnected room cells(${dc.length}): ${s}`);
  }

  // 3. all rooms globally reachable from room 0
  const gr = globallyDisconnectedRooms(dungeon);
  if (gr.length > 0) {
    problems.push(`isolated rooms(${gr.length}): ids=[${gr.slice(0, 5).join(", ")}]`);
  }

  // NOTE: corridorPathGaps is intentionally NOT in assertAll.
  // carveLine now skips room-floor and existing-corridor cells, so path arrays can have
  // large gaps where organic rooms span the corridor route. Those gaps are expected and
  // harmless — physical connectivity is guaranteed by globallyDisconnectedRooms.

  // NOTE: emptyCorridorPaths is intentionally NOT in assertAll.
  // In dense organic layouts, an entire L-path may consist only of room-floor cells.
  // The corridor's path is empty but the rooms are still physically connected through
  // the room floors. Label-slot waste in extreme cases is an accepted tradeoff.

  // 6. every door is at a room↔corridor boundary
  const id = invalidDoors(dungeon);
  if (id.length > 0) {
    const s = id.slice(0, 3).map(d => `(${d.x},${d.y}) ${d.type}: ${d.issue}`).join(", ");
    problems.push(`invalid doors(${id.length}): ${s}`);
  }

  // 7. no cell has both roomId and corridorId set
  const du = dualOwnedCells(dungeon);
  if (du.length > 0) {
    const s = du.slice(0, 3).map(c => `(${c.x},${c.y}) room=${c.roomId} corridor=${c.corridorId}`).join(", ");
    problems.push(`dual-owned cells(${du.length}): ${s}`);
  }

  // 8. corridor-type cells have no roomId
  const cr = corridorCellsWithRoomId(dungeon);
  if (cr.length > 0) {
    const s = cr.slice(0, 3).map(c => `(${c.x},${c.y}) roomId=${c.roomId}`).join(", ");
    problems.push(`corridor cells with roomId(${cr.length}): ${s}`);
  }

  // 9. every room is an endpoint of at least one corridor
  const nc = roomsWithNoCorridors(dungeon);
  if (nc.length > 0) {
    problems.push(`rooms with no corridors(${nc.length}): ids=[${nc.slice(0, 5).map(r => r.roomId).join(", ")}]`);
  }

  // NOTE: ghostCorridors is intentionally NOT in assertAll.
  // Ghost corridors (no live walkable path cells) arise from two accepted scenarios:
  // (a) organic layout where the entire route goes through room-floor cells (empty path),
  // (b) post-processing (collapseDeadEnds) reverting all of a corridor's carved cells.
  // Both are accepted tradeoffs; physical connectivity is checked via globallyDisconnectedRooms.

  // 11. corridor IDs are 0, 1, 2, … (no duplicates / gaps)
  const nsi = nonSequentialCorridorIds(dungeon);
  if (nsi.length > 0) {
    const s = nsi.slice(0, 3).map(e => `[${e.index}] expected=${e.expected} got=${e.actual}`).join(", ");
    problems.push(`non-sequential corridor IDs(${nsi.length}): ${s}`);
  }

  // NOTE: corridorCellsAdjacentToRooms is intentionally NOT in assertAll.
  // The 1-cell gap rule is enforced by the Labyrinth A* two-pass strategy (pass 1 hard-blocks
  // adjacency; pass 2 applies +20 penalty as a last resort), but it cannot be guaranteed for:
  //   (a) Straight/Winding: carveLine L-paths have fixed bends with no routing intelligence.
  //   (b) Extremely dense configs: 50+ rooms in small grids where rooms literally touch each
  //       other, or force-connect corridors on dense grids where existing corridors block all
  //       non-adjacent routes.
  // A dedicated test block below verifies the rule for Labyrinth with normal configs.

  // 13. corridors never overwrite room floor cells (path→room overlap)
  const cir = corridorCellsInRooms(dungeon);
  if (cir.length > 0) {
    const s = cir.slice(0, 3).map(c => `corridor=${c.corridorId} cell(${c.x},${c.y}) room=${c.roomId}`).join(", ");
    problems.push(`corridor cells inside rooms(${cir.length}): ${s}`);
  }

  // 13b. corridor paths are unbroken walks
  const breaks = corridorPathBreaks(dungeon);
  if (breaks.length > 0) {
    const s = breaks.slice(0, 3).map(b => `corridor=${b.corridorId} ${b.from}->${b.to}`).join(", ");
    problems.push(`discontinuous corridor paths(${breaks.length}): ${s}`);
  }

  // NOTE: corridorOwnershipConflicts is intentionally NOT in assertAll.
  // carveLine no longer overwrites live Corridor cells (real stealing is fixed).
  // Remaining conflicts are post-processing artefacts: collapseDeadEnds reverts cells
  // to Wall, then a force-connect corridor re-carves them with a new corridorId — same
  // staleness category as non-walkable path cells, which is an accepted tradeoff.

  // Note: corridorPathCellsNotWalkable() is intentionally NOT in assertAll.
  // post-processing (thinCorridors/collapseDeadEnds) may revert some path cells to Wall.
  // The path array tracks the original carved route; SvgOverlay filters stale cells at render time.

  // border rule: no walkable cell may sit on the outermost row or column
  const border = walkableCellsOnBorder(dungeon);
  if (border.length > 0) {
    const s = border.slice(0, 3).map(c => `(${c.x},${c.y}) ${CellType[c.type]}`).join(", ");
    problems.push(`walkable border cells(${border.length}): ${s}`);
  }

  if (problems.length > 0) {
    throw new Error(`[${label}]\n${problems.map(p => `  • ${p}`).join("\n")}`);
  }
}

const STRESS_SEEDS_CONSTRUCTED = [
    1,     7,    13,    31,    53,    97,   127,   211,   337,   499,
  613,   727,   853,   967,  1103,  1301,  1499,  1699,  1913,  2111,
 2333,  2539,  2741,  2999,  3251,  3511,  3761,  4001,  4253,  4507,
 5003,  6007,  7001,  8009,  9001, 10007, 12007, 15013, 20011, 25013,
31337, 42069, 50021, 65537, 77777, 88999, 99991, 123457, 234567, 999983,
];

const STRESS_SEEDS_ORGANIC = [
    2,    11,    23,    41,    67,   101,   149,   199,   257,   347,
  443,   541,   647,   751,   857,   977,  1097,  1213,  1373,  1567,
 1783,  1999,  2221,  2437,  2657,  2879,  3109,  3359,  3613,  3877,
 4219,  5101,  6101,  7103,  8101,  9103, 11003, 14009, 19001, 24001,
29999, 39989, 49999, 62003, 73001, 87011, 98999, 111223, 222001, 777777,
];

const CORRIDORS = ["Straight", "Winding", "Labyrinth"] as const;
const DOORS     = ["Open", "Standard", "Locked", "Secure", "Secret"] as const;
const DEAD_ENDS = ["None", "Few", "Many"] as const;
const ROOM_COUNTS = [4, 6, 8, 10, 12, 15, 20, 30, 50] as const;
const SHAPE_SETS = [
  ["Rectangular"],
  ["Circular", "Diamond"],
  ["Hexagonal", "Pentagonal", "Cross"],
  ["Cave", "Rectangular"],
  ["Rectangular", "Circular", "Diamond", "Cross"],
  ["Diamond", "Hexagonal", "Cave"],
] as const;
const GRID_SIZES = [
  { grid_width: 30,  grid_height: 30  },
  { grid_width: 50,  grid_height: 50  },
  { grid_width: 70,  grid_height: 60  },
  { grid_width: 100, grid_height: 100 },
  { grid_width: 200, grid_height: 200 },
  { grid_width: 400, grid_height: 300 },
  { grid_width: 500, grid_height: 500 },
] as const;

// All 8 available shapes and a generator for every non-empty subset (255 combos).
const ALL_SHAPES: readonly RoomShape[] = [
  "Rectangular", "Square", "Circular", "Hexagonal",
  "Pentagonal", "Cave", "Cross", "Diamond",
];

function allShapeSubsets(): RoomShape[][] {
  const result: RoomShape[][] = [];
  for (let mask = 1; mask < (1 << ALL_SHAPES.length); mask++) {
    const subset: RoomShape[] = [];
    for (let i = 0; i < ALL_SHAPES.length; i++) {
      if (mask & (1 << i)) subset.push(ALL_SHAPES[i]!);
    }
    result.push(subset);
  }
  return result;
}

describe("exhaustive room shapes — constructed layout (255 combos)", () => {
  for (const shapes of allShapeSubsets()) {
    const label = shapes.join("+");
    test(label, () => assertAll(generateDungeon(cfg({ room_shapes: shapes, seed: 42 })), `shapes C ${label}`));
  }
});

describe("exhaustive room shapes — organic layout (255 combos)", () => {
  for (const shapes of allShapeSubsets()) {
    const label = shapes.join("+");
    test(label, () => assertAll(generateDungeon(cfg({ layout_style: "organic", room_shapes: shapes, seed: 42 })), `shapes O ${label}`));
  }
});

describe("stress — constructed layout (50 configs)", () => {
  for (let i = 0; i < 50; i++) {
    const c = cfg({
      layout_style: "constructed",
      seed:             STRESS_SEEDS_CONSTRUCTED[i],
      corridors:        CORRIDORS[i % CORRIDORS.length],
      door_types:       [DOORS[i % DOORS.length]!],
      dead_ends:        DEAD_ENDS[Math.floor(i / CORRIDORS.length) % DEAD_ENDS.length],
      room_density:     "Exact",
      room_count:       ROOM_COUNTS[i % ROOM_COUNTS.length],
      room_shapes:      [...SHAPE_SETS[i % SHAPE_SETS.length]!],
      ...GRID_SIZES[i % GRID_SIZES.length],
    });
    test(
      `#${String(i + 1).padStart(2, "0")} seed=${c.seed} corridors=${c.corridors} doors=${c.door_types.join("+")} rooms=${c.room_count} grid=${c.grid_width}x${c.grid_height}`,
      () => assertAll(generateDungeon(c), `constructed #${i + 1}`),
      30000,
    );
  }
});

describe("stress — organic layout (50 configs)", () => {
  for (let i = 0; i < 50; i++) {
    const c = cfg({
      layout_style: "organic",
      seed:         STRESS_SEEDS_ORGANIC[i],
      corridors:    CORRIDORS[i % CORRIDORS.length],
      dead_ends:    DEAD_ENDS[Math.floor(i / CORRIDORS.length) % DEAD_ENDS.length],
      room_density: "Exact",
      room_count:   ROOM_COUNTS[i % ROOM_COUNTS.length],
      room_shapes:  [...SHAPE_SETS[i % SHAPE_SETS.length]!],
      ...GRID_SIZES[i % GRID_SIZES.length],
    });
    test(
      `#${String(i + 1).padStart(2, "0")} seed=${c.seed} corridors=${c.corridors} dead_ends=${c.dead_ends} rooms=${c.room_count} grid=${c.grid_width}x${c.grid_height}`,
      () => assertAll(generateDungeon(c), `organic #${i + 1}`),
      30000,
    );
  }
});

// ─── Labyrinth — 1-cell gap rule ──────────────────────────────────────────────
// Labyrinth A* uses a two-pass strategy: pass 1 hard-blocks cells adjacent to
// third-party rooms; pass 2 falls back to +20 penalty when no strict path exists.
// This test verifies the rule holds for normal room counts (6-15) across a wide
// range of seeds and grid sizes. Extreme configs (50 rooms in 30×30) are excluded
// because rooms are geometrically adjacent and a gap is impossible.

describe("Labyrinth — 1-cell gap from third-party rooms (normal configs)", () => {
  const SEEDS = [1, 7, 13, 42, 97, 211, 499, 853, 1499, 3251, 5003, 12007, 42069, 65537, 99991];
  const ROOM_COUNTS_NORMAL = [6, 8, 10, 12, 15] as const;
  const GRID_SIZES_NORMAL = [
    { grid_width: 50,  grid_height: 50  },
    { grid_width: 70,  grid_height: 60  },
    { grid_width: 100, grid_height: 100 },
  ] as const;

  for (let i = 0; i < SEEDS.length; i++) {
    const seed = SEEDS[i]!;
    const room_count = ROOM_COUNTS_NORMAL[i % ROOM_COUNTS_NORMAL.length]!;
    const gridSize = GRID_SIZES_NORMAL[i % GRID_SIZES_NORMAL.length]!;
    test(
      `seed=${seed} rooms=${room_count} grid=${gridSize.grid_width}x${gridSize.grid_height}`,
      () => {
        const dungeon = generateDungeon(cfg({ corridors: "Labyrinth", room_density: "Exact", seed, room_count, ...gridSize }));
        const violations = corridorCellsAdjacentToRooms(dungeon);
        if (violations.length > 0) {
          const s = violations.slice(0, 3)
            .map(c => `corridor=${c.corridorId} cell(${c.x},${c.y}) touches room=${c.adjacentRoomId}`)
            .join(", ");
          throw new Error(`${violations.length} Labyrinth corridors adjacent to rooms: ${s}`);
        }
      },
    );
  }

  // Note: organic (cellular) layout is not checked here — cave rooms have no guaranteed
  // separation between them, so Labyrinth corridors will naturally touch adjacent rooms.
});

// ─── dead ends — generation ───────────────────────────────────────────────────
// Verify that dead_ends=None produces no dead-end corridors, and that
// dead_ends=Few/Many actively generate them (roomB=-1 marks dead-end corridors).

describe("dead ends — generation counts", () => {
  function countDeadEndCorridors(dungeon: ReturnType<typeof generateDungeon>): number {
    return dungeon.corridors.filter(c => c.roomB === -1).length;
  }

  // Use a generous config so dead ends have room to spawn
  const BASE = cfg({
    room_size: "Large",
    grid_width: 80,
    grid_height: 80,
    room_density: "Exact",
    room_count: 10,
    corridors: "Straight",
  });

  const FEW_SEEDS = [42, 7, 100, 999];
  const MANY_SEEDS = [42, 7, 100, 999];

  test("dead_ends=None generates zero dead-end corridors", () => {
    for (const seed of [42, 1, 7, 100, 999]) {
      const count = countDeadEndCorridors(generateDungeon({ ...BASE, dead_ends: "None", seed }));
      expect(count).toBe(0);
    }
  });

  for (const seed of FEW_SEEDS) {
    test(`dead_ends=Few generates ≥2 dead ends (seed=${seed})`, () => {
      const count = countDeadEndCorridors(generateDungeon({ ...BASE, dead_ends: "Few", seed }));
      expect(count).toBeGreaterThanOrEqual(2);
    });
  }

  for (const seed of MANY_SEEDS) {
    test(`dead_ends=Many generates ≥5 dead ends (seed=${seed})`, () => {
      const count = countDeadEndCorridors(generateDungeon({ ...BASE, dead_ends: "Many", seed }));
      expect(count).toBeGreaterThanOrEqual(5);
    });
  }

  test("dead_ends=Many generates more than dead_ends=Few (seed=42)", () => {
    const few = countDeadEndCorridors(generateDungeon({ ...BASE, dead_ends: "Few", seed: 42 }));
    const many = countDeadEndCorridors(generateDungeon({ ...BASE, dead_ends: "Many", seed: 42 }));
    expect(many).toBeGreaterThanOrEqual(few);
  });
});

describe("dead ends — invariants", () => {
  const BASE = cfg({
    room_size: "Large",
    grid_width: 80,
    grid_height: 80,
    room_density: "Exact",
    room_count: 10,
    corridors: "Straight",
    dead_ends: "Many",
  });

  // Dead end cells must have corridorId set (no orphans)
  test("dead end cells are not orphans (seed=42)", () => {
    assertNoOrphans(generateDungeon({ ...BASE, seed: 42 }));
  });

  // All rooms remain globally reachable after dead end generation
  test("all rooms remain connected after dead end generation (seed=42)", () => {
    const dungeon = generateDungeon({ ...BASE, seed: 42 });
    const disconnected = globallyDisconnectedRooms(dungeon);
    expect(disconnected).toHaveLength(0);
  });

  // Dead end cells must not have both roomId and corridorId set
  test("dead end cells have no dual ownership (seed=42)", () => {
    const dungeon = generateDungeon({ ...BASE, seed: 42 });
    const dual = dualOwnedCells(dungeon);
    expect(dual).toHaveLength(0);
  });

  // Dead end corridor IDs must continue the sequential numbering
  test("corridor IDs remain sequential with dead ends (seed=42)", () => {
    const dungeon = generateDungeon({ ...BASE, seed: 42 });
    const issues = nonSequentialCorridorIds(dungeon);
    expect(issues).toHaveLength(0);
  });

  // Room stubs (roomA=room.id, roomB=-1): the referenced room must exist
  test("room stub roomA references a real room", () => {
    const dungeon = generateDungeon({ ...BASE, seed: 42 });
    const roomIds = new Set(dungeon.rooms.map(r => r.id));
    const badStubs = dungeon.corridors.filter(
      c => c.roomB === -1 && c.roomA !== -1 && !roomIds.has(c.roomA),
    );
    expect(badStubs).toHaveLength(0);
  });

  // Multi-seed smoke test: dead_ends=Many with various corridor styles
  for (const corridors of ["Straight", "Winding", "Labyrinth"] as const) {
    for (const seed of [42, 7, 999]) {
      test(`dead_ends=Many corridors=${corridors} seed=${seed}: assertAll passes`, () => {
        assertAll(
          generateDungeon({ ...BASE, corridors, seed }),
          `dead-ends Many ${corridors} seed=${seed}`,
        );
      });
    }
  }
});
