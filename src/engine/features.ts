import type { DungeonConfig } from "../ai/schema.ts";
import { CellType, FeatureType } from "./types.ts";
import type { Cell, Room, Corridor, Feature } from "./types.ts";
import type { SeededRandom } from "../lib/random.ts";
import { getCell, getNeighbors, setCellType, isInBounds, isInterior } from "./grid.ts";

function getDensityCount(density: string, baseCount: number): number {
  switch (density) {
    case "None":
      return 0;
    case "Low":
      return Math.max(1, Math.floor(baseCount * 0.25));
    case "Medium":
      return Math.max(1, Math.floor(baseCount * 0.5));
    case "High":
      return Math.max(1, Math.floor(baseCount * 0.75));
    default:
      return Math.max(1, Math.floor(baseCount * 0.5));
  }
}

// ============================================================
// Sill-based door placement
// ============================================================

interface Sill {
  x: number;
  y: number;
  roomId: number;
}

/** Compute door sills: wall cells on the perimeter of a room that border non-room space. */
function computeRoomSills(grid: Cell[][], room: Room): Sill[] {
  const sills: Sill[] = [];
  const width = grid[0]?.length ?? 0;
  const height = grid.length;

  // Scan the 1-cell ring around the room bounding box
  for (let y = room.y - 1; y <= room.y + room.height; y++) {
    for (let x = room.x - 1; x <= room.x + room.width; x++) {
      // Only look at cells just outside the room
      const isInRoom = x >= room.x && x < room.x + room.width &&
                       y >= room.y && y < room.y + room.height;
      if (isInRoom) continue;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;

      const cell = getCell(grid, x, y);
      if (cell === undefined) continue;
      // Sill must not be room floor; Corridor cells (the carved entry points) are valid sills
      if (cell.type === CellType.Floor) continue;

      // Must be cardinally adjacent to a room floor cell
      const neighbors = getNeighbors(grid, x, y);
      const touchesRoom = neighbors.some(
        (n) => n.cell.type === CellType.Floor && n.cell.roomId === room.id,
      );
      if (!touchesRoom) continue;

      sills.push({ x, y, roomId: room.id });
    }
  }

  return sills;
}

// Returns null for "Open" (no door feature placed at this sill).
function resolveDoorType(doorTypes: string[], rng: SeededRandom): FeatureType | null {
  const pick = doorTypes[rng.nextInt(0, doorTypes.length - 1)]!;
  switch (pick) {
    case "Open":      return null;
    case "Archway":   return FeatureType.Archway;
    case "Portcullis": return FeatureType.Portcullis;
    case "Locked":    return FeatureType.LockedDoor;
    case "Secure":    return FeatureType.LockedDoor;
    case "Trapped":   return FeatureType.TrappedDoor;
    case "Secret":    return FeatureType.SecretDoor;
    default:          return FeatureType.Door; // "Standard"
  }
}

function placeDoors(
  grid: Cell[][],
  rooms: Room[],
  config: DungeonConfig,
  rng: SeededRandom,
  featureId: { value: number },
): Feature[] {
  const features: Feature[] = [];

  if (config.door_types.every((t) => t === "Open")) return features;

  // Compute sills for all rooms
  const allSills: Sill[] = [];
  for (const room of rooms) {
    allSills.push(...computeRoomSills(grid, room));
  }

  // Activate sills that now have a Corridor cell adjacent (on the non-room side)
  const placed = new Set<string>();

  for (const sill of allSills) {
    const key = `${sill.x},${sill.y}`;
    if (placed.has(key)) continue;

    const cell = getCell(grid, sill.x, sill.y);
    if (cell === undefined) continue;

    // The sill cell itself must be a corridor (carved through the room wall)
    const isCorridor = cell.type === CellType.Corridor;
    const neighbors = getNeighbors(grid, sill.x, sill.y);
    const adjacentRoom = neighbors.some(
      (n) => n.cell.type === CellType.Floor && n.cell.roomId !== null,
    );
    // Mirror the invalidDoors invariant exactly: door needs a neighbor with corridorId set
    const hasCorridorNeighbor = neighbors.some((n) => n.cell.corridorId !== null);

    // Place door at the corridor entry cell that bridges room and corridor path
    if (isCorridor && adjacentRoom && hasCorridorNeighbor) {
      placed.add(key);

      const doorType = resolveDoorType(config.door_types, rng);
      if (doorType === null) continue; // "Open" — leave as plain corridor

      const feature: Feature = {
        id: featureId.value++,
        type: doorType,
        x: sill.x,
        y: sill.y,
      };
      features.push(feature);
      cell.featureId = feature.id;
      cell.type = CellType.Door;
    }
  }

  return features;
}

function placeSecretDoors(
  grid: Cell[][],
  rng: SeededRandom,
  featureId: { value: number },
): Feature[] {
  const features: Feature[] = [];
  const width = grid[0]?.length ?? 0;
  const height = grid.length;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const cell = getCell(grid, x, y);
      if (cell === undefined || cell.type !== CellType.Wall) continue;
      if (cell.featureId !== null) continue;

      const left = getCell(grid, x - 1, y);
      const right = getCell(grid, x + 1, y);
      const up = getCell(grid, x, y - 1);
      const down = getCell(grid, x, y + 1);

      // Require at least one side to be room floor (not corridor-to-corridor)
      const horizontalPassage =
        left !== undefined &&
        right !== undefined &&
        (left.type === CellType.Floor || left.type === CellType.Corridor) &&
        (right.type === CellType.Floor || right.type === CellType.Corridor) &&
        (left.roomId !== null || right.roomId !== null);

      const verticalPassage =
        up !== undefined &&
        down !== undefined &&
        (up.type === CellType.Floor || up.type === CellType.Corridor) &&
        (down.type === CellType.Floor || down.type === CellType.Corridor) &&
        (up.roomId !== null || down.roomId !== null);

      if ((horizontalPassage || verticalPassage) && rng.chance(0.15)) {
        const feature: Feature = {
          id: featureId.value++,
          type: FeatureType.SecretDoor,
          x,
          y,
        };
        features.push(feature);
        cell.featureId = feature.id;
        cell.type = CellType.SecretDoor;
        // Inherit tracking: prefer corridorId from adjacent corridor, else roomId from adjacent room
        const corridorN = [left, right, up, down].find(
          (n) => n !== undefined && n.type === CellType.Corridor,
        );
        if (corridorN?.corridorId != null) {
          cell.corridorId = corridorN.corridorId;
        } else {
          const roomN = [left, right, up, down].find(
            (n) => n !== undefined && n.type === CellType.Floor && n.roomId !== null,
          );
          if (roomN?.roomId != null) cell.roomId = roomN.roomId;
        }
      }
    }
  }

  return features;
}

function placeTraps(
  grid: Cell[][],
  corridors: Corridor[],
  config: DungeonConfig,
  rng: SeededRandom,
  featureId: { value: number },
): Feature[] {
  const features: Feature[] = [];
  const density = config.trap_density;
  const seen = new Set<string>();
  const candidatePositions: Array<{ x: number; y: number; priority: number }> = [];

  for (const corridor of corridors) {
    for (const pos of corridor.path) {
      const key = `${pos.x},${pos.y}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const cell = getCell(grid, pos.x, pos.y);
      if (cell === undefined || cell.type !== CellType.Corridor) continue;
      if (cell.featureId !== null) continue;

      const neighbors = getNeighbors(grid, pos.x, pos.y);
      const corridorNeighborCount = neighbors.filter(
        (n) => n.cell.type === CellType.Corridor,
      ).length;

      let priority = 1;
      if (corridorNeighborCount >= 3) {
        priority = 3;
      } else if (corridorNeighborCount === 1) {
        priority = 2;
      }

      candidatePositions.push({ x: pos.x, y: pos.y, priority });
    }
  }

  candidatePositions.sort((a, b) => b.priority - a.priority);
  const count = getDensityCount(density, candidatePositions.length);

  for (let i = 0; i < count && i < candidatePositions.length; i++) {
    const pos = candidatePositions[i]!;
    if (!rng.chance(0.6)) continue;

    const cell = getCell(grid, pos.x, pos.y);
    if (cell === undefined || cell.featureId !== null) continue;

    const feature: Feature = {
      id: featureId.value++,
      type: FeatureType.Trap,
      x: pos.x,
      y: pos.y,
    };
    features.push(feature);
    cell.featureId = feature.id;
  }

  return features;
}

function placeTreasure(
  grid: Cell[][],
  rooms: Room[],
  config: DungeonConfig,
  rng: SeededRandom,
  featureId: { value: number },
): Feature[] {
  const features: Feature[] = [];
  const density = config.treasure_density;

  const deadEndRooms = rooms.filter((r) => r.connections.length <= 1);
  const otherRooms = rooms.filter((r) => r.connections.length > 1);
  const sortedRooms = [...deadEndRooms, ...otherRooms];

  const count = getDensityCount(density, rooms.length);

  for (let i = 0; i < count && i < sortedRooms.length; i++) {
    const room = sortedRooms[i]!;
    if (room.width < 3 || room.height < 3) continue;

    const tx = rng.nextInt(room.x + 1, room.x + room.width - 2);
    const ty = rng.nextInt(room.y + 1, room.y + room.height - 2);

    const cell = getCell(grid, tx, ty);
    if (cell === undefined || cell.featureId !== null) continue;
    if (cell.type !== CellType.Floor) continue;

    const feature: Feature = {
      id: featureId.value++,
      type: FeatureType.Treasure,
      x: tx,
      y: ty,
    };
    features.push(feature);
    cell.featureId = feature.id;
    room.features.push(feature);
  }

  return features;
}

function getStairsCount(stairsConfig: string): number {
  switch (stairsConfig) {
    case "None":
      return 0;
    case "Few":
      return 2;
    case "Many":
      return 4;
    default:
      return 2;
  }
}

function placeStairs(
  grid: Cell[][],
  rooms: Room[],
  config: DungeonConfig,
  rng: SeededRandom,
  featureId: { value: number },
): Feature[] {
  const features: Feature[] = [];
  const width = grid[0]?.length ?? 0;
  const height = grid.length;

  const totalStairs = getStairsCount(config.stairs);
  if (totalStairs === 0 || rooms.length === 0) return features;

  const sortedByEdge = [...rooms].sort((a, b) => {
    const aEdgeDist = Math.min(a.centerX, a.centerY, width - a.centerX, height - a.centerY);
    const bEdgeDist = Math.min(b.centerX, b.centerY, width - b.centerX, height - b.centerY);
    return aEdgeDist - bEdgeDist;
  });

  const upCount = Math.ceil(totalStairs / 2);
  const downCount = totalStairs - upCount;
  let placed = 0;

  for (let i = 0; i < upCount && placed < sortedByEdge.length; placed++) {
    const room = sortedByEdge[placed]!;
    if (room.width < 3 || room.height < 3) continue;

    const sx = rng.nextInt(room.x + 1, room.x + room.width - 2);
    const sy = rng.nextInt(room.y + 1, room.y + room.height - 2);
    const cell = getCell(grid, sx, sy);
    if (cell !== undefined && cell.featureId === null && cell.type === CellType.Floor) {
      cell.type = CellType.StairsUp;
      const feature: Feature = {
        id: featureId.value++,
        type: FeatureType.StairsUp,
        x: sx,
        y: sy,
      };
      features.push(feature);
      cell.featureId = feature.id;
      room.features.push(feature);
      i++;
    }
  }

  for (let i = 0; i < downCount && placed < sortedByEdge.length; placed++) {
    const room = sortedByEdge[placed]!;
    if (room.width < 3 || room.height < 3) continue;

    const sx = rng.nextInt(room.x + 1, room.x + room.width - 2);
    const sy = rng.nextInt(room.y + 1, room.y + room.height - 2);
    const cell = getCell(grid, sx, sy);
    if (cell !== undefined && cell.featureId === null && cell.type === CellType.Floor) {
      cell.type = CellType.StairsDown;
      const feature: Feature = {
        id: featureId.value++,
        type: FeatureType.StairsDown,
        x: sx,
        y: sy,
      };
      features.push(feature);
      cell.featureId = feature.id;
      room.features.push(feature);
      i++;
    }
  }

  return features;
}

// ============================================================
// Dead-end helpers
// ============================================================

/**
 * Compute the path for an intentional dead-end corridor without modifying the grid.
 * All shaping parameters are derived from the dungeon config in the caller.
 *
 * minLen / maxLen:    target path length range (grid-scale derived)
 * minTurnCells:       minimum straight cells before a turn is considered (grid-scale derived)
 * turnProb:           per-eligible-step turn probability (corridor_complexity derived)
 * allowedRoomId:      room this dead end may be adjacent to (room stubs; null for branches)
 * parentCorrX/Y:      junction cell whose adjacency is exempted (path branches)
 */
function carveDeadEndPath(
  grid: Cell[][],
  startX: number,
  startY: number,
  dx: number,
  dy: number,
  allowedRoomId: number | null,
  parentCorrX: number | null,
  parentCorrY: number | null,
  rng: SeededRandom,
  minLen: number,
  maxLen: number,
  minTurnCells: number,
  turnProb: number,
): Array<{ x: number; y: number }> {
  const targetLength = rng.nextInt(minLen, maxLen);
  // Each dead end gets its own turn patience: anywhere from minTurnCells to 2× that,
  // so some paths are very straight and some are snaky within the same dungeon.
  const minBeforeTurn = rng.nextInt(minTurnCells, minTurnCells * 2);
  const path: Array<{ x: number; y: number }> = [];
  const myKeys = new Set<string>();
  let cx = startX, cy = startY;
  let stepsInDir = 0;

  while (path.length < targetLength) {
    if (!isInterior(grid, cx, cy)) break;
    const cell = getCell(grid, cx, cy);
    if (!cell) break;
    if (cell.type === CellType.Floor || cell.type === CellType.Corridor) break;

    // Adjacency check — must not touch third-party rooms or foreign corridors
    let blocked = false;
    for (const [adx, ady] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      const ax = cx + adx, ay = cy + ady;
      if (myKeys.has(`${ax},${ay}`)) continue; // own path — OK
      if (ax === parentCorrX && ay === parentCorrY) continue; // junction — OK
      const adj = getCell(grid, ax, ay);
      if (!adj) continue;
      if (adj.type === CellType.Floor && adj.roomId !== null && adj.roomId !== allowedRoomId) {
        blocked = true;
        break;
      }
      if (adj.type === CellType.Corridor) {
        blocked = true;
        break;
      }
    }
    if (blocked) break;

    path.push({ x: cx, y: cy });
    myKeys.add(`${cx},${cy}`);
    stepsInDir++;

    // After enough straight cells, consider a 90° turn
    if (stepsInDir >= minBeforeTurn && rng.chance(turnProb)) {
      const left:  [number, number] = [-dy,  dx];
      const right: [number, number] = [ dy, -dx];
      const candidates = rng.chance(0.5) ? [left, right] : [right, left];

      for (const [ndx, ndy] of candidates) {
        const nx = cx + ndx, ny = cy + ndy;
        if (!isInterior(grid, nx, ny)) continue;
        const nc = getCell(grid, nx, ny);
        if (!nc || nc.type === CellType.Floor || nc.type === CellType.Corridor) continue;

        let turnBlocked = false;
        for (const [adx, ady] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
          const ax = nx + adx, ay = ny + ady;
          if (myKeys.has(`${ax},${ay}`)) continue;
          const adj = getCell(grid, ax, ay);
          if (!adj) continue;
          if (adj.type === CellType.Floor && adj.roomId !== null && adj.roomId !== allowedRoomId) {
            turnBlocked = true; break;
          }
          if (adj.type === CellType.Corridor) { turnBlocked = true; break; }
        }
        if (!turnBlocked) {
          dx = ndx; dy = ndy; stepsInDir = 0;
          break;
        }
      }
    }

    cx += dx;
    cy += dy;
  }

  return path;
}

// ============================================================
// Dead-end collapse (None only — Few/Many generate intentionally)
// ============================================================

export function collapseDeadEnds(
  grid: Cell[][],
  config: DungeonConfig,
  rng: SeededRandom,
): void {
  // Few/Many: intentional dead ends are generated separately by generateDeadEnds.
  // Here we only remove accidental corridor stubs for dead_ends=None.
  if (config.dead_ends !== "None") return;

  // Suppress unused-variable warning in strict environments
  void rng;

  const width = grid[0]?.length ?? 0;
  const height = grid.length;
  let changed = true;

  while (changed) {
    changed = false;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const cell = getCell(grid, x, y);
        if (cell === undefined || cell.type !== CellType.Corridor) continue;
        if (cell.featureId !== null) continue;

        const neighbors = getNeighbors(grid, x, y);
        const traversableCount = neighbors.filter(
          (n) =>
            n.cell.type === CellType.Corridor ||
            n.cell.type === CellType.Floor ||
            n.cell.type === CellType.Door,
        ).length;

        if (traversableCount <= 1) {
          cell.type = CellType.Wall;
          cell.corridorId = null;
          changed = true;
        }
      }
    }
  }
}

// ============================================================
// Dead-end generation (Few / Many)
// ============================================================

/**
 * Actively generate intentional dead-end corridor segments after the main
 * corridor network is fully built and post-processed.
 *
 * Two types are generated:
 *   Type 1 — Room stubs  (roomA=room.id, roomB=-1): exits a room, leads nowhere.
 *   Type 2 — Path branches (roomA=-1,    roomB=-1): branches off an existing corridor.
 *
 * Returns the new Corridor objects; caller must concat them to the corridors array.
 */
export function generateDeadEnds(
  grid: Cell[][],
  rooms: Room[],
  corridors: Corridor[],
  config: DungeonConfig,
  rng: SeededRandom,
  startId: number,
): Corridor[] {
  if (config.dead_ends === "None") return [];

  const roomsN   = rooms.length;
  const gridW    = config.grid_width;
  const gridH    = config.grid_height;
  // Shorter axis: the dimension that constrains most paths
  const gridScale = Math.min(gridW, gridH);
  // Grid area per room — captures spaciousness independently of raw room count.
  // sqrt keeps units in "cells" rather than "cells²" so it scales linearly with grid side.
  const spaciousness = Math.sqrt((gridW * gridH) / Math.max(1, roomsN));

  // ── Path length ────────────────────────────────────────────────────────────
  // Dead ends should reach proportionally into the dungeon, not be a fixed stub.
  // Min: 5 % of the shorter axis (always at least 3 for a real dead end feel)
  // Max: 25 % of the shorter axis
  //   30×30 → [3, 7]    50×50 → [3, 12]    100×100 → [5, 25]    500×500 → [25,125]
  const minPathLen  = Math.max(3, Math.floor(gridScale * 0.05));
  const maxPathLen  = Math.max(minPathLen + 3, Math.floor(gridScale * 0.25));

  // ── Turn parameters ────────────────────────────────────────────────────────
  // Minimum straight run before a turn: scales with grid so small grids don't
  // produce absurdly zig-zagging 3-cell paths.
  //   30×30 → 2   50×50 → 3   100×100 → 5   200×200 → 10   500×500 → 25
  const minTurnCells = Math.max(2, Math.floor(gridScale * 0.05));

  // Turn probability per eligible step: derived from corridor_complexity.
  // Straight dungeons (complexity≈0) → infrequent turns (≈10 %)
  // Labyrinthine dungeons (complexity≈1) → frequent turns (≈45 %)
  const turnProb = 0.10 + config.corridor_complexity * 0.35;

  // ── Room-stub vs path-branch bias ─────────────────────────────────────────
  // More complex corridors produce more corridor cells, making branches more viable.
  // complexity=0 → 25 % branch chance    complexity=1 → 65 % branch chance
  const branchChance = 0.25 + config.corridor_complexity * 0.40;

  // ── Dead-end counts ────────────────────────────────────────────────────────
  // Base unit = spaciousness (cells per room, sqrt-normalised).
  // Few: a light sprinkling — [1, spaciousness/5] dead ends
  // Many: a heavy dose   — [spaciousness/5, spaciousness/2] dead ends
  // Ranges share a boundary so Many ≥ Few is guaranteed.
  //   10 rooms / 50×50  → spaciousness≈15.8 → Few [1,3],   Many [3,8]
  //   10 rooms / 100×100→ spaciousness≈31.6 → Few [1,6],   Many [6,16]
  //   10 rooms / 500×500→ spaciousness≈158  → Few [1,31],  Many [31,79]
  //   30 rooms / 50×50  → spaciousness≈9.1  → Few [1,2],   Many [2,5]
  //   30 rooms / 100×100→ spaciousness≈18.3 → Few [1,4],   Many [4,9]
  const fewMax  = Math.max(2, Math.floor(spaciousness / 5));
  const manyMax = Math.max(fewMax + 1, Math.floor(spaciousness / 2));
  const targetCount =
    config.dead_ends === "Few"
      ? rng.nextInt(2, fewMax)
      : rng.nextInt(fewMax, manyMax);

  // Attempt budget: more targets on larger grids need more tries since dense spots
  // get exhausted. Scale with both target count and the grid-to-room spaciousness.
  const maxAttempts = Math.ceil(targetCount * Math.max(8, spaciousness / 2));

  const result: Corridor[] = [];

  // Collect live corridor cells (stale/reverted path cells are excluded)
  const liveCorrCells: Array<{ x: number; y: number }> = [];
  for (const c of corridors) {
    for (const p of c.path) {
      const cell = getCell(grid, p.x, p.y);
      if (cell?.type === CellType.Corridor) {
        liveCorrCells.push({ x: p.x, y: p.y });
      }
    }
  }

  const dirs = [
    { dx: 1, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: 0, dy: -1 },
  ] as const;

  let attempts = 0;

  while (result.length < targetCount && attempts < maxAttempts) {
    attempts++;
    const deadEndId = startId + result.length;

    // Stub bias: prefer branches when complexity is high (more corridor cells available).
    // Fallback to stubs when there are no live corridor cells to branch from.
    const useRoomStub =
      rooms.length > 0 && (liveCorrCells.length === 0 || !rng.chance(branchChance));

    if (useRoomStub) {
      // ── Type 1: Room stub ────────────────────────────────────────────────────
      const room = rooms[rng.nextInt(0, rooms.length - 1)]!;
      const dir = dirs[rng.nextInt(0, 3)]!;

      // Walk from the room center outward until we exit the room's floor cells.
      // Watchdog: room diagonal + grid border margin, both derived from room dims.
      let cx = room.centerX, cy = room.centerY;
      let prevInRoom = false;
      let watchdog = 0;
      const maxWalk = Math.max(room.width, room.height) + Math.ceil(gridScale * 0.04);
      while (watchdog++ < maxWalk) {
        const c = getCell(grid, cx, cy);
        if (!c || c.type !== CellType.Floor || c.roomId !== room.id) break;
        prevInRoom = true;
        cx += dir.dx;
        cy += dir.dy;
      }

      if (!prevInRoom) continue;
      if (!isInterior(grid, cx, cy)) continue;
      const startCell = getCell(grid, cx, cy);
      if (!startCell) continue;
      if (startCell.type === CellType.Floor || startCell.type === CellType.Corridor) continue;

      const path = carveDeadEndPath(
        grid, cx, cy, dir.dx, dir.dy, room.id, null, null, rng,
        minPathLen, maxPathLen, minTurnCells, turnProb,
      );
      if (path.length < minPathLen) continue;

      for (const p of path) {
        setCellType(grid, p.x, p.y, CellType.Corridor);
        const cell = getCell(grid, p.x, p.y);
        if (cell) cell.corridorId = deadEndId;
      }
      result.push({ id: deadEndId, roomA: room.id, roomB: -1, path, width: 1 });
    } else if (liveCorrCells.length > 0) {
      // ── Type 2: Path branch ──────────────────────────────────────────────────
      const src = liveCorrCells[rng.nextInt(0, liveCorrCells.length - 1)]!;
      const shuffledDirs = rng.shuffle(dirs);
      let path: Array<{ x: number; y: number }> = [];

      for (const dir of shuffledDirs) {
        const bx = src.x + dir.dx, by = src.y + dir.dy;
        if (!isInterior(grid, bx, by)) continue;
        const bCell = getCell(grid, bx, by);
        if (!bCell || bCell.type === CellType.Floor || bCell.type === CellType.Corridor) continue;

        const candidate = carveDeadEndPath(
          grid, bx, by, dir.dx, dir.dy, null, src.x, src.y, rng,
          minPathLen, maxPathLen, minTurnCells, turnProb,
        );
        if (candidate.length >= minPathLen) {
          path = candidate;
          break;
        }
      }

      if (path.length < 2) continue;

      for (const p of path) {
        setCellType(grid, p.x, p.y, CellType.Corridor);
        const cell = getCell(grid, p.x, p.y);
        if (cell) cell.corridorId = deadEndId;
      }
      result.push({ id: deadEndId, roomA: -1, roomB: -1, path, width: 1 });
    }
  }

  return result;
}

// ============================================================
// Main entry point
// ============================================================

export function placeFeatures(
  grid: Cell[][],
  rooms: Room[],
  corridors: Corridor[],
  config: DungeonConfig,
  rng: SeededRandom,
): Feature[] {
  const featureId = { value: 0 };

  const allFeatures: Feature[] = [];

  const doorFeatures = placeDoors(grid, rooms, config, rng, featureId);
  allFeatures.push(...doorFeatures);

  const secretDoorFeatures = placeSecretDoors(grid, rng, featureId);
  allFeatures.push(...secretDoorFeatures);

  const trapFeatures = placeTraps(grid, corridors, config, rng, featureId);
  allFeatures.push(...trapFeatures);

  const treasureFeatures = placeTreasure(grid, rooms, config, rng, featureId);
  allFeatures.push(...treasureFeatures);

  const stairsFeatures = placeStairs(grid, rooms, config, rng, featureId);
  allFeatures.push(...stairsFeatures);

  return allFeatures;
}
