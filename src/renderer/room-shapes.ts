import type { Room } from "../engine/types.ts";
import { CellType } from "../engine/types.ts";
import type { Cell } from "../engine/types.ts";

export interface Point {
  x: number;
  y: number;
}

export interface RoomGeometry {
  type: "ellipse" | "polygon" | "path" | "rect";
  centerX: number;
  centerY: number;
  // For ellipse
  radiusX?: number;
  radiusY?: number;
  // For polygon
  vertices?: Point[];
  // For path (cross shape)
  path?: Path2D;
  // Bounding box
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export function getRoomGeometry(room: Room, cellSize: number): RoomGeometry {
  const boundsX = room.x * cellSize;
  const boundsY = room.y * cellSize;
  const boundsWidth = room.width * cellSize;
  const boundsHeight = room.height * cellSize;
  const centerX = boundsX + boundsWidth / 2;
  const centerY = boundsY + boundsHeight / 2;

  const bounds = {
    x: boundsX,
    y: boundsY,
    width: boundsWidth,
    height: boundsHeight,
  };

  switch (room.shape) {
    case "Circular": {
      const r = Math.min(boundsWidth, boundsHeight) / 2;
      return {
        type: "ellipse",
        centerX,
        centerY,
        radiusX: r,
        radiusY: r,
        bounds,
      };
    }

    case "Diamond": {
      const r = Math.min(boundsWidth, boundsHeight) / 2;
      return {
        type: "polygon",
        centerX,
        centerY,
        vertices: [
          { x: centerX, y: centerY - r }, // top
          { x: centerX + r, y: centerY }, // right
          { x: centerX, y: centerY + r }, // bottom
          { x: centerX - r, y: centerY }, // left
        ],
        bounds,
      };
    }

    case "Hexagonal": {
      // Pointy-top hexagon: natural ratio width = √3 * r, height = 2 * r
      const r = Math.min(boundsWidth / Math.sqrt(3), boundsHeight / 2);
      const hw = (r * Math.sqrt(3)) / 2;
      return {
        type: "polygon",
        centerX,
        centerY,
        vertices: [
          { x: centerX, y: centerY - r },          // top
          { x: centerX + hw, y: centerY - r / 2 }, // top-right
          { x: centerX + hw, y: centerY + r / 2 }, // bottom-right
          { x: centerX, y: centerY + r },           // bottom
          { x: centerX - hw, y: centerY + r / 2 }, // bottom-left
          { x: centerX - hw, y: centerY - r / 2 }, // top-left
        ],
        bounds,
      };
    }

    case "Pentagonal": {
      // Pentagon with pointy top: natural ratio width ≈ 1.902r, height ≈ 1.809r
      const r = Math.min(boundsWidth / 1.902, boundsHeight / 1.809);
      const angleOffset = -Math.PI / 2; // Start at top
      const vertices: Point[] = [];
      for (let i = 0; i < 5; i++) {
        const angle = angleOffset + (i * 2 * Math.PI) / 5;
        vertices.push({
          x: centerX + r * Math.cos(angle),
          y: centerY + r * Math.sin(angle),
        });
      }
      return {
        type: "polygon",
        centerX,
        centerY,
        vertices,
        bounds,
      };
    }

    case "Cross": {
      // Cross is union of horizontal and vertical bars — equal thickness for symmetry
      const path = new Path2D();
      const barThickness = Math.max(2, Math.floor(Math.min(room.width, room.height) / 3)) * cellSize;
      const hBarHeight = barThickness;
      const vBarWidth = barThickness;
      const hBarY = centerY - hBarHeight / 2;
      const vBarX = centerX - vBarWidth / 2;

      // Horizontal bar
      path.rect(boundsX, hBarY, boundsWidth, hBarHeight);
      // Vertical bar
      path.rect(vBarX, boundsY, vBarWidth, boundsHeight);

      return {
        type: "path",
        centerX,
        centerY,
        path,
        bounds,
      };
    }

    case "Square":
    case "Rectangular":
    default:
      return {
        type: "rect",
        centerX,
        centerY,
        bounds,
      };
  }
}

export function createRoomPath(geometry: RoomGeometry): Path2D {
  const path = new Path2D();

  switch (geometry.type) {
    case "ellipse":
      if (geometry.radiusX && geometry.radiusY) {
        path.ellipse(
          geometry.centerX,
          geometry.centerY,
          geometry.radiusX,
          geometry.radiusY,
          0,
          0,
          2 * Math.PI
        );
      }
      break;

    case "polygon":
      if (geometry.vertices && geometry.vertices.length > 0) {
        path.moveTo(geometry.vertices[0]!.x, geometry.vertices[0]!.y);
        for (let i = 1; i < geometry.vertices.length; i++) {
          path.lineTo(geometry.vertices[i]!.x, geometry.vertices[i]!.y);
        }
        path.closePath();
      }
      break;

    case "path":
      if (geometry.path) {
        return geometry.path;
      }
      break;

    case "rect":
      path.rect(
        geometry.bounds.x,
        geometry.bounds.y,
        geometry.bounds.width,
        geometry.bounds.height
      );
      break;
  }

  return path;
}

export function isShapedRoom(shape: string): boolean {
  return ["Circular", "Diamond", "Hexagonal", "Pentagonal"].includes(shape);
}

export interface CorridorEntry {
  midX: number; // pixel X of the shared edge midpoint
  midY: number; // pixel Y
}

const WALKABLE_TYPES = new Set([
  CellType.Floor,
  CellType.Corridor,
  CellType.Door,
  CellType.SecretDoor,
  CellType.StairsUp,
  CellType.StairsDown,
]);

export function findCorridorEntries(
  room: Room,
  grid: Cell[][],
  cellSize: number
): CorridorEntry[] {
  const entries: CorridorEntry[] = [];

  for (let y = room.y; y < room.y + room.height; y++) {
    for (let x = room.x; x < room.x + room.width; x++) {
      const cell = grid[y]?.[x];
      if (!cell || cell.roomId !== room.id) continue;

      const neighbors: Array<[number, number, "n" | "s" | "e" | "w"]> = [
        [x, y - 1, "n"],
        [x, y + 1, "s"],
        [x + 1, y, "e"],
        [x - 1, y, "w"],
      ];
      for (const [nx, ny, dir] of neighbors) {
        const nb = grid[ny]?.[nx];
        if (!nb || !WALKABLE_TYPES.has(nb.type) || nb.roomId === room.id) continue;
        // This edge is a corridor/door entry — record its pixel midpoint
        const px = x * cellSize;
        const py = y * cellSize;
        switch (dir) {
          case "n":
            entries.push({ midX: px + cellSize / 2, midY: py });
            break;
          case "s":
            entries.push({ midX: px + cellSize / 2, midY: py + cellSize });
            break;
          case "e":
            entries.push({ midX: px + cellSize, midY: py + cellSize / 2 });
            break;
          case "w":
            entries.push({ midX: px, midY: py + cellSize / 2 });
            break;
        }
      }
    }
  }

  // Deduplicate (two cells sharing the same corridor may record the same midpoint)
  const seen = new Set<string>();
  return entries.filter((e) => {
    const key = `${e.midX},${e.midY}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function crossOutlineVertices(
  room: Room,
  cellSize: number
): Array<{ x: number; y: number }> {
  const boundsX = room.x * cellSize;
  const boundsY = room.y * cellSize;
  const boundsWidth = room.width * cellSize;
  const boundsHeight = room.height * cellSize;
  const centerX = boundsX + boundsWidth / 2;
  const centerY = boundsY + boundsHeight / 2;

  const barThickness = Math.max(2, Math.floor(Math.min(room.width, room.height) / 3)) * cellSize;
  const hH = barThickness;
  const vW = barThickness;
  const hY = centerY - hH / 2;
  const vX = centerX - vW / 2;
  const bR = boundsX + boundsWidth;
  const bB = boundsY + boundsHeight;

  return [
    { x: vX, y: boundsY }, // 0 top-left of v-bar
    { x: vX + vW, y: boundsY }, // 1 top-right of v-bar
    { x: vX + vW, y: hY }, // 2 inner corner TR
    { x: bR, y: hY }, // 3 h-bar top-right
    { x: bR, y: hY + hH }, // 4 h-bar bottom-right
    { x: vX + vW, y: hY + hH }, // 5 inner corner BR
    { x: vX + vW, y: bB }, // 6 bottom-right of v-bar
    { x: vX, y: bB }, // 7 bottom-left of v-bar
    { x: vX, y: hY + hH }, // 8 inner corner BL
    { x: boundsX, y: hY + hH }, // 9 h-bar bottom-left
    { x: boundsX, y: hY }, // 10 h-bar top-left
    { x: vX, y: hY }, // 11 inner corner TL
  ];
}
