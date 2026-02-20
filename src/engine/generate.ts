import type { DungeonConfig } from "../ai/schema.ts";
import { CellType } from "./types.ts";
import type { Dungeon, Room, Cell } from "./types.ts";
import { SeededRandom } from "../lib/random.ts";
import { createGrid, getCell, setCellType, forEachCell, getNeighbors } from "./grid.ts";
import { generateBSP } from "./bsp.ts";
import { delaunayTriangulation, minimumSpanningTree, selectCorridorEdges } from "./graph.ts";
import { carveCorridors, thinCorridors } from "./corridors.ts";
import { placeFeatures, collapseDeadEnds, generateDeadEnds } from "./features.ts";
import { carveShape } from "./shapes.ts";
import { generateCellular } from "./cellular.ts";

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
      const hasFloorOrCorridor = neighbors.some(
        (n) =>
          n.cell.type === CellType.Floor ||
          n.cell.type === CellType.Corridor ||
          n.cell.type === CellType.Door ||
          n.cell.type === CellType.SecretDoor ||
          n.cell.type === CellType.StairsUp ||
          n.cell.type === CellType.StairsDown,
      );
      if (hasFloorOrCorridor) {
        setCellType(grid, x, y, CellType.Wall);
      }
    }
  });
}

/**
 * BFS connectivity check: returns connected room-index group + one singleton per isolated room.
 *
 * Robust design:
 * - Finds the start cell by scanning for any traversable cell (not just room centers), so
 *   complex room shapes whose center cell is a wall are handled correctly.
 * - Checks ALL floor cells against their roomId (not just bounding-box cells), so Voronoi-
 *   assigned organic rooms that extend outside their bounding box are recognised.
 * - Returns [connectedGroup, [isolatedRoom1], [isolatedRoom2], ...] so the caller can
 *   force-connect the isolated rooms to the main body.
 */
function findConnectedComponents(grid: Cell[][], rooms: Room[]): number[][] {
  const width = grid[0]?.length ?? 0;
  const height = grid.length;

  function isTraversable(cell: Cell): boolean {
    return (
      cell.type === CellType.Floor ||
      cell.type === CellType.Corridor ||
      cell.type === CellType.Door ||
      cell.type === CellType.SecretDoor ||
      cell.type === CellType.StairsUp ||
      cell.type === CellType.StairsDown
    );
  }

  // Find any traversable starting cell, preferring room centers
  let startX = -1;
  let startY = -1;
  outer: for (const room of rooms) {
    const c = getCell(grid, room.centerX, room.centerY);
    if (c && isTraversable(c)) {
      startX = room.centerX;
      startY = room.centerY;
      break;
    }
    // Center is a wall — scan the room's bounding box for any traversable floor cell
    for (let y = room.y; y < room.y + room.height && startX < 0; y++) {
      for (let x = room.x; x < room.x + room.width && startX < 0; x++) {
        const cell = getCell(grid, x, y);
        if (cell?.roomId === room.id && isTraversable(cell)) {
          startX = x;
          startY = y;
          break outer;
        }
      }
    }
  }
  if (startX < 0) return [rooms.map((_, i) => i)];

  // Single global BFS from that seed cell
  const visited = new Set<string>([`${startX},${startY}`]);
  const queue: Array<{ x: number; y: number }> = [{ x: startX, y: startY }];
  while (queue.length > 0) {
    const { x, y } = queue.shift()!;
    const neighbors = getNeighbors(grid, x, y);
    for (const n of neighbors) {
      const key = `${n.x},${n.y}`;
      if (!visited.has(key) && isTraversable(n.cell)) {
        visited.add(key);
        queue.push({ x: n.x, y: n.y });
      }
    }
  }

  // Build roomId → index map
  const roomIdToIndex = new Map(rooms.map((r, ri) => [r.id, ri]));

  // Mark each room as connected if ANY of its floor cells were reached
  const roomConnected = new Array<boolean>(rooms.length).fill(false);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = getCell(grid, x, y);
      if (!cell || cell.roomId === null) continue;
      const ri = roomIdToIndex.get(cell.roomId);
      if (ri !== undefined && visited.has(`${x},${y}`)) {
        roomConnected[ri] = true;
      }
    }
  }

  const connected: number[] = [];
  const isolated: number[][] = [];
  for (let ri = 0; ri < rooms.length; ri++) {
    if (roomConnected[ri]) connected.push(ri);
    else isolated.push([ri]);
  }
  return [connected, ...isolated];
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

  if (rooms.length < 2) {
    return {
      grid,
      width,
      height,
      rooms,
      corridors: [],
      features: [],
      config,
      seed,
    };
  }

  const points = rooms.map((r) => ({ x: r.centerX, y: r.centerY }));
  const triangulationEdges = delaunayTriangulation(points);
  const mstEdges = minimumSpanningTree(triangulationEdges, rooms.length);
  const complexity = config.corridor_complexity;
  const selectedEdges = selectCorridorEdges(triangulationEdges, mstEdges, complexity, rng);

  let corridors = carveCorridors(grid, rooms, selectedEdges, config, rng);

  // Verify connectivity — force-connect any isolated components
  const components = findConnectedComponents(grid, rooms);
  if (components.length > 1) {
    // Connect each component to the first component via the closest room pair
    const mainComponent = components[0]!;
    for (let ci = 1; ci < components.length; ci++) {
      const otherComponent = components[ci]!;

      // Find closest room pair between main and this component
      let bestDist = Infinity;
      let bestA = -1;
      let bestB = -1;
      for (const ai of mainComponent) {
        const roomA = rooms[ai]!;
        for (const bi of otherComponent) {
          const roomB = rooms[bi]!;
          const dx = roomA.centerX - roomB.centerX;
          const dy = roomA.centerY - roomB.centerY;
          const dist = dx * dx + dy * dy;
          if (dist < bestDist) {
            bestDist = dist;
            bestA = ai;
            bestB = bi;
          }
        }
      }

      if (bestA >= 0 && bestB >= 0) {
        const forceEdges = [{ a: bestA, b: bestB, weight: Math.sqrt(bestDist) }];
        const forcedCorridors = carveCorridors(grid, rooms, forceEdges, config, rng, corridors.length);
        corridors = corridors.concat(forcedCorridors);
        // Merge the other component into main for subsequent iterations
        mainComponent.push(...otherComponent);
      }
    }
  }

  // Thin corridor clusters (remove 2x2 blocks) then collapse dead ends
  thinCorridors(grid);
  collapseDeadEnds(grid, config, rng);

  // Second connectivity pass — post-processing may have removed force-connected corridors,
  // re-isolating rooms. Re-run the same force-connect logic on the post-processed grid.
  const components2 = findConnectedComponents(grid, rooms);
  if (components2.length > 1) {
    const mainComponent2 = components2[0]!;
    for (let ci = 1; ci < components2.length; ci++) {
      const otherComponent = components2[ci]!;
      let bestDist = Infinity;
      let bestA = -1;
      let bestB = -1;
      for (const ai of mainComponent2) {
        const roomA = rooms[ai]!;
        for (const bi of otherComponent) {
          const roomB = rooms[bi]!;
          const dx = roomA.centerX - roomB.centerX;
          const dy = roomA.centerY - roomB.centerY;
          const dist = dx * dx + dy * dy;
          if (dist < bestDist) {
            bestDist = dist;
            bestA = ai;
            bestB = bi;
          }
        }
      }
      if (bestA >= 0 && bestB >= 0) {
        const forceEdges = [{ a: bestA, b: bestB, weight: Math.sqrt(bestDist) }];
        const forcedCorridors = carveCorridors(grid, rooms, forceEdges, config, rng, corridors.length);
        corridors = corridors.concat(forcedCorridors);
        mainComponent2.push(...otherComponent);
      }
    }
  }

  // Generate intentional dead ends after post-processing and connectivity passes
  const deadEnds = generateDeadEnds(grid, rooms, corridors, config, rng, corridors.length);
  corridors = corridors.concat(deadEnds);

  const features = placeFeatures(grid, rooms, corridors, config, rng);

  buildWalls(grid);

  return {
    grid,
    width,
    height,
    rooms,
    corridors,
    features,
    config,
    seed,
  };
}
