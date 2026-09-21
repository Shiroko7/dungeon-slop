import type { DungeonConfig } from "../ai/schema.ts";
import { CellType } from "./types.ts";
import type { Dungeon, Room, Cell } from "./types.ts";
import { SeededRandom } from "../lib/random.ts";
import { createGrid, getCell, setCellType, forEachCell, getNeighbors } from "./grid.ts";
import { generateBSP } from "./bsp.ts";
import { placeFeatures, generateDeadEnds } from "./features.ts";
import { carveShape } from "./shapes.ts";
import { generateCellular } from "./cellular.ts";
import { carveCorridors, carveEntryCorridors } from "./corridors.ts";
import { planRoomBudget } from "./bsp.ts";
import { assignRoles, enforceCorridorBudget, hasLoop } from "./layout-rules.ts";
import { layoutBlueprint } from "./blueprint-layout.ts";
import type { Blueprint } from "../ai/blueprint.ts";

function blueprintConstraints(blueprint: Blueprint, rooms: Room[]) {
  const byKey = new Map(rooms.map((room) => [room.plan?.key, room]));
  const unmetConnections: Array<{ from: string; to: string }> = [];
  let deliveredConnections = 0;
  const builtPath = (fromId: number, toId: number): boolean => {
    const seen = new Set<number>([fromId]);
    const queue = [fromId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const next of rooms.find((room) => room.id === id)?.connections ?? []) {
        if (next === toId) return true;
        if (seen.has(next)) continue;
        const target = rooms.find((room) => room.id === next);
        // A long planned edge may be split by engine junction chambers. Do not
        // cross another planned room, or an unrelated route could satisfy it.
        if (target?.plan?.key !== undefined) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    return false;
  };
  for (const edge of blueprint.edges) {
    const from = byKey.get(edge.from);
    const to = byKey.get(edge.to);
    if (from !== undefined && to !== undefined && builtPath(from.id, to.id)) {
      deliveredConnections++;
    } else {
      unmetConnections.push({ from: edge.from, to: edge.to });
    }
  }
  const planRooms = rooms.filter((room) => room.plan?.key !== undefined);
  const reached = new Set<number>();
  const queue = planRooms.filter((room) => room.role === "entrance").map((room) => room.id);
  for (const id of queue) reached.add(id);
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const next of rooms.find((room) => room.id === id)?.connections ?? []) {
      const target = rooms.find((room) => room.id === next);
      if (target === undefined || reached.has(next)) continue;
      reached.add(next);
      queue.push(next);
    }
  }
  const unreachableRooms = planRooms
    .filter((room) => !reached.has(room.id))
    .map((room) => room.plan!.key);
  const unmetRequirements: string[] = [];
  for (const edge of blueprint.edges) {
    if (edge.gating?.trim()) unmetRequirements.push(`Gate "${edge.gating}" is advisory; no lock mechanic is enforced by geometry.`);
    if (edge.door?.trim()) unmetRequirements.push(`Door preference "${edge.door}" is advisory; the renderer does not bind a door type to a specific edge.`);
  }
  return {
    requestedConnections: blueprint.edges.length,
    deliveredConnections,
    unmetConnections,
    reachableRooms: planRooms.filter((room) => reached.has(room.id)).length,
    unreachableRooms,
    requestedEntrances: blueprint.nodes.filter((node) => node.role === "entrance").length,
    deliveredEntrances: rooms.filter((room) => room.role === "entrance").length,
    unmetRequirements,
  };
}

function carveRoomsIntoGrid(grid: Cell[][], rooms: Room[], rng: SeededRandom): void {
  for (const room of rooms) {
    const cells = carveShape(room.shape, room.x, room.y, room.width, room.height, rng);
    for (const key of cells) {
      const [xs, ys] = key.split(",");
      const x = Number(xs);
      const y = Number(ys);
      const cell = getCell(grid, x, y);
      if (cell !== undefined) {
        setCellType(grid, x, y, CellType.Floor);
        cell.roomId = room.id;
      }
    }
  }
}

function buildWalls(grid: Cell[][]): void {
  forEachCell(grid, (x, y, cell) => {
    if (cell.type === CellType.Empty) {
      const neighbors = getNeighbors(grid, x, y);
      const hasFloor = neighbors.some(
        (n) =>
          n.cell.type === CellType.Floor ||
          n.cell.type === CellType.Door ||
          n.cell.type === CellType.SecretDoor ||
          n.cell.type === CellType.StairsUp ||
          n.cell.type === CellType.StairsDown,
      );
      if (hasFloor) {
        setCellType(grid, x, y, CellType.Wall);
      }
    }
  });
}

export function generateDungeon(config: DungeonConfig): Dungeon {
  const seed = config.seed ?? Math.floor(Math.random() * 2147483647);
  const rng = new SeededRandom(seed);

  const width = config.grid_width;
  const height = config.grid_height;
  let grid = createGrid(width, height);
  let rooms: Room[];

  if (config.layout_style === "organic") {
    const result = generateCellular(width, height, config, rng);
    rooms = result.rooms;
    grid = result.caveGrid;
  } else {
    rooms = generateBSP(width, height, config, rng);
    carveRoomsIntoGrid(grid, rooms, rng);
  }

  buildWalls(grid);

  const corridors = carveCorridors(grid, rooms, config, rng);

  buildWalls(grid);

  const deadEnds = generateDeadEnds(grid, rooms, corridors, config, rng, corridors.length);
  const entryCorridors = carveEntryCorridors(grid, rooms, config, rng, corridors.length + deadEnds.length);
  let allCorridors = [...corridors, ...deadEnds, ...entryCorridors];

  // Design rules, applied to finished geometry. Order matters: the budget pass
  // adds rooms, so roles have to be assigned after it or the junctions it
  // creates are invisible to the critical-path walk.
  const budgeted = enforceCorridorBudget(grid, rooms, allCorridors, rng);
  rooms = budgeted.rooms;
  allCorridors = budgeted.corridors;

  buildWalls(grid);

  const features = placeFeatures(grid, rooms, allCorridors, config, rng);

  buildWalls(grid);

  const dungeon: Dungeon = {
    grid,
    width,
    height,
    rooms,
    corridors: allCorridors,
    features,
    config,
    seed,
  };

  assignRoles(dungeon);

  const budget = planRoomBudget(config, width, height);
  dungeon.report = {
    requestedRooms: budget.requested,
    // Junctions are scenery the budget pass inserted, not rooms anyone asked
    // for. Counting them here would make every shortfall look like a surplus.
    deliveredRooms: rooms.filter((r) => r.role !== "junction").length,
    capacityRooms: budget.capacity,
    junctionsAdded: budgeted.junctionsAdded,
    longestCorridorCells: allCorridors.reduce((m, c) => Math.max(m, c.path.length), 0),
    hasLoop: hasLoop(rooms),
  };

  return dungeon;
}

/**
 * Build a dungeon from a floor plan rather than from density knobs.
 *
 * Everything after placement is the same pipeline the procedural path uses -
 * walls, features, dead ends, the corridor budget - because those passes were
 * never the problem. What changes is where the rooms are and why: the graph is
 * the model's, so the entrance really is the entrance and the three wings really
 * do hang off one landing.
 *
 * Roles come from the plan and are NOT recomputed. Depth measured on the built
 * graph would quietly disagree with the plan the moment a loop makes a back way
 * in, and at that point the names and the geometry describe different dungeons.
 */
export function generateFromBlueprint(blueprint: Blueprint, config: DungeonConfig): Dungeon {
  const seed = config.seed ?? Math.floor(Math.random() * 2147483647);
  const rng = new SeededRandom(seed);

  const layout = layoutBlueprint(blueprint, config, rng);
  const { width, height } = layout;
  let rooms = layout.rooms;

  const grid = createGrid(width, height);
  carveRoomsIntoGrid(grid, rooms, rng);
  buildWalls(grid);

  const corridors = carveCorridors(grid, rooms, config, rng, layout.edges);
  buildWalls(grid);

  const deadEnds = generateDeadEnds(grid, rooms, corridors, config, rng, corridors.length);
  const entryCorridors = carveEntryCorridors(
    grid,
    rooms,
    config,
    rng,
    corridors.length + deadEnds.length,
  );
  let allCorridors = [...corridors, ...deadEnds, ...entryCorridors];

  const budgeted = enforceCorridorBudget(grid, rooms, allCorridors, rng);
  rooms = budgeted.rooms;
  allCorridors = budgeted.corridors;

  buildWalls(grid);
  const features = placeFeatures(grid, rooms, allCorridors, config, rng);
  buildWalls(grid);

  const dungeon: Dungeon = {
    grid,
    width,
    height,
    rooms,
    corridors: allCorridors,
    features,
    config: { ...config, grid_width: width, grid_height: height },
    seed,
  };

  // Junctions arrive without a tier because the plan never mentioned them.
  // Filling it in from their neighbours keeps depth continuous for the narrator.
  for (const room of rooms) {
    if (room.role !== "junction" || room.tier != null) continue;
    const tiers = room.connections
      .map((id) => rooms.find((r) => r.id === id)?.tier)
      .filter((t): t is number => t != null);
    room.tier = tiers.length > 0 ? Math.min(...tiers) : null;
  }

  // The mandatory route is what the plan said it was, by role.
  for (const room of rooms) {
    room.onCriticalPath =
      room.role === "entrance" ||
      room.role === "boss" ||
      room.role === "gauntlet" ||
      room.role === "chokepoint";
  }

  dungeon.report = {
    requestedRooms: blueprint.nodes.length,
    deliveredRooms: rooms.filter((r) => r.role !== "junction").length,
    capacityRooms: blueprint.nodes.length,
    junctionsAdded: budgeted.junctionsAdded,
    longestCorridorCells: allCorridors.reduce((m, c) => Math.max(m, c.path.length), 0),
    hasLoop: hasLoop(rooms),
    constraints: blueprintConstraints(blueprint, rooms),
  };

  return dungeon;
}
