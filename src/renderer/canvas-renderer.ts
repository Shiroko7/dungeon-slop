import rough from "roughjs";
import type { RoughCanvas } from "roughjs/bin/canvas";
import type { Dungeon, Cell } from "../engine/types.ts";
import { CellType, FeatureType, isCaveShape } from "../engine/types.ts";
import type { ThemePalette } from "./themes/theme-engine.ts";
import { getRoomGeometry, createRoomPath } from "./room-shapes.ts";
import { drawDoorSymbols } from "./door-symbols.ts";
import {
  drawSketchWalls,
  drawTrapGlyph,
  drawTreasureGlyph,
  extendsIntoRoom,
  roughSeed,
} from "./sketch.ts";

export interface RenderOptions {
  cellSize: number;
  showGrid: boolean;
  theme: ThemePalette;
  selectedRoomId: number | null;
  hoveredRoomId: number | null;
  hiddenFeatureTypes?: ReadonlySet<FeatureType>;
}

/** Options for the static (non-interactive) layer stack. */
export interface StaticLayerOptions {
  cellSize: number;
  theme: ThemePalette;
  showGrid: boolean;
  hiddenFeatureTypes?: ReadonlySet<FeatureType>;
  includeRoomLabels?: boolean;
}

const WALKABLE = new Set([CellType.Floor, CellType.Corridor, CellType.Door, CellType.SecretDoor, CellType.StairsUp, CellType.StairsDown]);

// ─── Stroke-then-Fill floor rendering ────────────────────────────────────────
//
// All rooms (except Cave) are rendered as smooth geometric Path2D shapes.
// Cave room cells and all corridor/walkable cells are rendered as individual
// cellSize×cellSize rectangles.  A corridor rect that arrives head-on at a
// geometric room is over-extended by one cellSize toward it so the two always
// meet across the smooth shape boundary.
//
// Render passes:
//   Pass 1 — thick stroke  (2× wall thickness): draws wall outline everywhere
//   Pass 2 — parchment fill: erases the inner half of every stroke, leaving
//             only the outer perimeter visible as the wall, and seamlessly
//             covers any corridor over-extensions or shape overlaps inside rooms
//   Pass 3 — optional grid dots, clipped to the floor area

// Final wall half-thickness as fraction of cellSize.
// The stroke is drawn at 2× this width; the fill erases the inner half.
const WALL_THICKNESS_FRACTION = 0.12;

const floorPathCache = new WeakMap<Dungeon, Map<number, Path2D>>();

function getCachedFloorPath(dungeon: Dungeon, cellSize: number): Path2D {
  let bySize = floorPathCache.get(dungeon);
  if (!bySize) {
    bySize = new Map();
    floorPathCache.set(dungeon, bySize);
  }
  const cached = bySize.get(cellSize);
  if (cached) return cached;
  const path = buildFloorPath(dungeon, cellSize);
  bySize.set(cellSize, path);
  return path;
}

function buildFloorPath(dungeon: Dungeon, cellSize: number): Path2D {
  const { grid, width, height, rooms } = dungeon;
  const path = new Path2D();

  // All non-Cave rooms get a smooth geometric path (rect, ellipse, or polygon).
  const geometricRoomIds = new Set<number>();
  for (const room of rooms) {
    if (room.footprint !== undefined) {
      geometricRoomIds.add(room.id);
      for (const point of room.footprint) {
        path.rect(point.x * cellSize, point.y * cellSize, cellSize, cellSize);
      }
      continue;
    }
    if (isCaveShape(room.shape)) continue;
    geometricRoomIds.add(room.id);
    path.addPath(createRoomPath(getRoomGeometry(room, cellSize)));
  }

  // Every walkable cell not covered by a geometric room is added as a
  // cellSize×cellSize rect.  Where a passage arrives head-on at a geometric
  // room, extend the rect by one extra cellSize in that direction so it
  // penetrates the smooth room boundary (the fill in Pass 2 erases the part
  // that lands inside the room).  A corridor that merely runs alongside a room
  // must not extend — see extendsIntoRoom.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = grid[y]?.[x];
      if (!cell || !WALKABLE.has(cell.type)) continue;
      if (cell.roomId !== null && geometricRoomIds.has(cell.roomId)) continue;

      const px = x * cellSize;
      const py = y * cellSize;
      let minX = px, minY = py, maxX = px + cellSize, maxY = py + cellSize;

      const nRid = grid[y - 1]?.[x]?.roomId ?? null;
      const sRid = grid[y + 1]?.[x]?.roomId ?? null;
      const wRid = grid[y]?.[x - 1]?.roomId ?? null;
      const eRid = grid[y]?.[x + 1]?.roomId ?? null;
      if (nRid !== null && geometricRoomIds.has(nRid) && extendsIntoRoom(grid, x, y, 0, -1, nRid)) minY -= cellSize;
      if (sRid !== null && geometricRoomIds.has(sRid) && extendsIntoRoom(grid, x, y, 0, 1, sRid)) maxY += cellSize;
      if (wRid !== null && geometricRoomIds.has(wRid) && extendsIntoRoom(grid, x, y, -1, 0, wRid)) minX -= cellSize;
      if (eRid !== null && geometricRoomIds.has(eRid) && extendsIntoRoom(grid, x, y, 1, 0, eRid)) maxX += cellSize;

      path.rect(minX, minY, maxX - minX, maxY - minY);
    }
  }

  return path;
}

/**
 * Render every static (non-interactive) layer of the dungeon in world px:
 * background, floor + walls, grid dots, door symbols, stairs, trap/treasure
 * glyphs, and room labels. This is the single choke point shared by the live
 * offscreen buffer and PNG/PDF/VTT exports — style changes here propagate
 * everywhere.
 */
export function renderStaticLayers(
  ctx: CanvasRenderingContext2D,
  dungeon: Dungeon,
  opts: StaticLayerOptions,
): void {
  const {
    cellSize, theme, showGrid, hiddenFeatureTypes,
    includeRoomLabels = true,
  } = opts;

  const floorPath = getCachedFloorPath(dungeon, cellSize);

  // 1. Paper background
  ctx.fillStyle = theme.paper;
  ctx.fillRect(0, 0, dungeon.width * cellSize, dungeon.height * cellSize);

  // 3. Walls: a heavy ink band, the parchment floor over it, the shaded inner face
  drawSketchWalls(ctx, dungeon, cellSize, theme, floorPath);

  // 7. Grid dots, clipped to the floor
  if (showGrid) {
    ctx.save();
    ctx.clip(floorPath, "nonzero");
    drawGridDots(ctx, dungeon.width, dungeon.height, cellSize, theme);
    ctx.restore();
  }

  // 9. Stairs + feature glyphs, door symbols
  const rc = rough.canvas(ctx.canvas as HTMLCanvasElement);
  drawSpecialCells(rc, ctx, dungeon, cellSize, theme, hiddenFeatureTypes);
  drawDoorSymbols(ctx, dungeon, cellSize, theme.ink, hiddenFeatureTypes);

  // 10. Room labels
  if (includeRoomLabels) {
    drawRoomLabels(ctx, dungeon, cellSize, theme);
  }
}

export function renderDungeon(
  ctx: CanvasRenderingContext2D,
  dungeon: Dungeon,
  options: RenderOptions
): void {
  const { cellSize, showGrid, theme, selectedRoomId, hoveredRoomId, hiddenFeatureTypes } = options;

  renderStaticLayers(ctx, dungeon, { cellSize, theme, showGrid, hiddenFeatureTypes });

  if (selectedRoomId !== null) {
    drawRoomOverlay(ctx, dungeon, selectedRoomId, cellSize, theme.roomHighlight);
  }

  if (hoveredRoomId !== null && hoveredRoomId !== selectedRoomId) {
    drawRoomOverlay(ctx, dungeon, hoveredRoomId, cellSize, theme.roomHover);
  }
}

export function drawSpecialCells(
  rc: RoughCanvas,
  ctx: CanvasRenderingContext2D,
  dungeon: Dungeon,
  cellSize: number,
  theme: ThemePalette,
  hidden: ReadonlySet<FeatureType> = new Set()
): void {
  const { width, height, grid } = dungeon;

  // Doors/secret doors are rendered as cartographic symbols by drawDoorSymbols;
  // only stairs remain cell-driven here.
  for (let y = 0; y < height; y++) {
    const row = grid[y];
    if (!row) continue;
    for (let x = 0; x < width; x++) {
      const cell = row[x];
      if (!cell) continue;

      const px = x * cellSize;
      const py = y * cellSize;

      switch (cell.type) {
        case CellType.StairsUp:
          if (!hidden.has(FeatureType.StairsUp)) drawStairs(rc, px, py, cellSize, theme, true, roughSeed(dungeon.seed, x, y));
          break;
        case CellType.StairsDown:
          if (!hidden.has(FeatureType.StairsDown)) drawStairs(rc, px, py, cellSize, theme, false, roughSeed(dungeon.seed, x, y));
          break;
      }
    }
  }

  // Trap and Treasure sit on Floor cells — hand-drawn seeded glyphs
  for (const feature of dungeon.features) {
    if (feature.type === FeatureType.Trap && !hidden.has(FeatureType.Trap)) {
      drawTrapGlyph(rc, ctx, feature.x, feature.y, cellSize, theme, dungeon.seed);
    } else if (feature.type === FeatureType.Treasure && !hidden.has(FeatureType.Treasure)) {
      drawTreasureGlyph(rc, ctx, feature.x, feature.y, cellSize, theme, dungeon.seed);
    }
  }
}

function drawStairs(
  rc: RoughCanvas,
  px: number,
  py: number,
  cellSize: number,
  theme: ThemePalette,
  isUp: boolean,
  seed: number,
): void {
  const steps = 4;
  const stepHeight = cellSize / steps;
  const margin = cellSize * 0.15;

  for (let i = 0; i < steps; i++) {
    const stepY = isUp
      ? py + margin + i * stepHeight
      : py + cellSize - margin - (i + 1) * stepHeight;
    const stepWidth = cellSize - margin * 2;
    const stepH = stepHeight * 0.6;

    if (stepWidth > 0 && stepH > 0) {
      rc.rectangle(px + margin, stepY, stepWidth, stepH, {
        stroke: theme.ink,
        strokeWidth: Math.max(1, cellSize * 0.05),
        roughness: 0.5,
        fill: "none",
        seed: seed + i,
      });
    }
  }
}

// Grid dots path cache — keyed by "width:height:cellSize".
// The path is position-independent so it can be reused across buffer rebuilds for
// the same dungeon dimensions.  A single Path2D with moveTo+arc per intersection
// gives one ctx.fill() call (one GPU pass) instead of ~10K individual fill() calls.
const gridDotsPathCache = new Map<string, Path2D>();

function getGridDotsPath(width: number, height: number, cellSize: number): Path2D {
  const key = `${width}:${height}:${cellSize}`;
  const cached = gridDotsPathCache.get(key);
  if (cached) return cached;

  // Dot radius scales with cellSize so all export scales read the same
  const r = Math.max(0.75, cellSize * 0.05);
  const path = new Path2D();
  for (let x = 0; x <= width; x++) {
    for (let y = 0; y <= height; y++) {
      const px = x * cellSize;
      const py = y * cellSize;
      // moveTo start of arc to avoid implicit lineTo connectors between dots.
      path.moveTo(px + r, py);
      path.arc(px, py, r, 0, Math.PI * 2);
    }
  }
  gridDotsPathCache.set(key, path);
  return path;
}

function drawGridDots(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  cellSize: number,
  theme: ThemePalette
): void {
  const path = getGridDotsPath(width, height, cellSize);
  ctx.fillStyle = theme.grid;
  ctx.globalAlpha = 0.2;
  ctx.fill(path);
  ctx.globalAlpha = 1;
}

function drawRoomLabels(
  ctx: CanvasRenderingContext2D,
  dungeon: Dungeon,
  cellSize: number,
  theme: ThemePalette
): void {
  ctx.fillStyle = theme.text;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // Hand-lettered map labels; size scales with cellSize for export parity
  const fontSize = Math.max(9, cellSize * 0.72);
  ctx.font = `${fontSize}px 'Patrick Hand', 'Segoe Print', cursive`;

  for (const room of dungeon.rooms) {
    const cx = (room.centerX + 0.5) * cellSize;
    const cy = (room.centerY + 0.5) * cellSize;
    ctx.fillText(String(room.id), cx, cy);
  }
}

function drawRoomOverlay(
  ctx: CanvasRenderingContext2D,
  dungeon: Dungeon,
  roomId: number,
  cellSize: number,
  color: string
): void {
  const room = dungeon.rooms.find((r) => r.id === roomId);
  if (!room) return;

  ctx.fillStyle = color;

  if (room.footprint !== undefined) {
    for (const point of room.footprint) {
      ctx.fillRect(point.x * cellSize, point.y * cellSize, cellSize, cellSize);
    }
  } else if (!isCaveShape(room.shape)) {
    // All non-Cave rooms have a smooth geometric path (rect, ellipse, polygon, cross)
    ctx.fill(createRoomPath(getRoomGeometry(room, cellSize)));
  } else {
    // Cave rooms: cell-by-cell (irregular organic shape)
    const { width, height, grid } = dungeon;
    for (let y = 0; y < height; y++) {
      const row = grid[y];
      if (!row) continue;
      for (let x = 0; x < width; x++) {
        const cell = row[x];
        if (!cell) continue;
        if (cell.roomId === roomId) {
          ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
        }
      }
    }
  }
}

// ─── OffscreenCanvas buffer ───────────────────────────────────────────────────

/**
 * Pre-render the full static layer stack onto an OffscreenCanvas (floor, walls,
 * grid, door symbols, stairs, glyphs, labels — everything but interactive
 * overlays). Callers blit it with drawImage() during pan/zoom for near-zero cost.
 *
 * `scale` multiplies the buffer's pixel resolution (e.g. devicePixelRatio ×
 * zoom bucket) while all drawing stays in world CSS-px coordinates; blit with
 * 9-arg drawImage back to `width*cellSize × height*cellSize` world units.
 */
export function buildDungeonBuffer(
  dungeon: Dungeon,
  opts: StaticLayerOptions,
  scale = 1,
): OffscreenCanvas {
  const { cellSize } = opts;
  const buf = new OffscreenCanvas(
    Math.ceil(dungeon.width * cellSize * scale),
    Math.ceil(dungeon.height * cellSize * scale),
  );
  const ctx = buf.getContext("2d") as unknown as CanvasRenderingContext2D;
  ctx.scale(scale, scale);
  renderStaticLayers(ctx, dungeon, opts);
  return buf;
}
