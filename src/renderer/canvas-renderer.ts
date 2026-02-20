import type { Dungeon } from "../engine/types.ts";
import { CellType } from "../engine/types.ts";
import type { ThemePalette } from "./themes/theme-engine.ts";

export interface RenderOptions {
  cellSize: number;
  showGrid: boolean;
  theme: ThemePalette;
  selectedRoomId: number | null;
  hoveredRoomId: number | null;
}

export function renderDungeon(
  ctx: CanvasRenderingContext2D,
  dungeon: Dungeon,
  options: RenderOptions
): void {
  const { cellSize, showGrid, theme, selectedRoomId, hoveredRoomId } = options;
  const { width, height, grid } = dungeon;

  // 1. Clear canvas with background color
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, width * cellSize, height * cellSize);

  // 2-3. Draw cells: floor, corridor, wall
  for (let y = 0; y < height; y++) {
    const row = grid[y];
    if (!row) continue;
    for (let x = 0; x < width; x++) {
      const cell = row[x];
      if (!cell) continue;

      const px = x * cellSize;
      const py = y * cellSize;

      switch (cell.type) {
        case CellType.Floor:
          ctx.fillStyle = theme.floor;
          ctx.fillRect(px, py, cellSize, cellSize);
          break;
        case CellType.Corridor:
          ctx.fillStyle = theme.corridor;
          ctx.fillRect(px, py, cellSize, cellSize);
          break;
        case CellType.Wall:
          ctx.fillStyle = theme.wall;
          ctx.fillRect(px, py, cellSize, cellSize);
          break;
        case CellType.Door:
          ctx.fillStyle = theme.door;
          ctx.fillRect(px, py, cellSize, cellSize);
          break;
        case CellType.SecretDoor:
          ctx.fillStyle = theme.secretDoor;
          ctx.fillRect(px, py, cellSize, cellSize);
          break;
        case CellType.StairsUp:
        case CellType.StairsDown:
          ctx.fillStyle = theme.stairs;
          ctx.fillRect(px, py, cellSize, cellSize);
          break;
        case CellType.Empty:
          // Empty cells keep the background color
          break;
      }
    }
  }

  // 4. Draw grid lines
  if (showGrid) {
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (let x = 0; x <= width; x++) {
      const px = x * cellSize;
      ctx.moveTo(px, 0);
      ctx.lineTo(px, height * cellSize);
    }
    for (let y = 0; y <= height; y++) {
      const py = y * cellSize;
      ctx.moveTo(0, py);
      ctx.lineTo(width * cellSize, py);
    }
    ctx.stroke();
  }

  // 5. Highlight selected room cells
  if (selectedRoomId !== null) {
    drawRoomOverlay(ctx, dungeon, selectedRoomId, cellSize, theme.roomHighlight);
  }

  // 6. Highlight hovered room cells
  if (hoveredRoomId !== null && hoveredRoomId !== selectedRoomId) {
    drawRoomOverlay(ctx, dungeon, hoveredRoomId, cellSize, theme.roomHover);
  }

  // 7. Draw room ID numbers at room centers
  ctx.fillStyle = theme.text;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const fontSize = Math.max(8, Math.min(cellSize * 0.6, 14));
  ctx.font = `${fontSize}px sans-serif`;

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
  ctx.fillStyle = color;
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

export function getCellAtPixel(
  px: number,
  py: number,
  cellSize: number,
  panX: number,
  panY: number,
  zoom: number
): { x: number; y: number } {
  const x = Math.floor((px - panX) / (cellSize * zoom));
  const y = Math.floor((py - panY) / (cellSize * zoom));
  return { x, y };
}

export function getRoomAtCell(
  dungeon: Dungeon,
  x: number,
  y: number
): number | null {
  if (x < 0 || y < 0 || x >= dungeon.width || y >= dungeon.height) {
    return null;
  }
  const row = dungeon.grid[y];
  if (!row) return null;
  const cell = row[x];
  if (!cell) return null;
  return cell.roomId;
}
