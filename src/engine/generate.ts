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
  const allCorridors = [...corridors, ...deadEnds, ...entryCorridors];

  const features = placeFeatures(grid, rooms, allCorridors, config, rng);

  buildWalls(grid);

  return {
    grid,
    width,
    height,
    rooms,
    corridors: allCorridors,
    features,
    config,
    seed,
  };
}
