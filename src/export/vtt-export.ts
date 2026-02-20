import type { Dungeon, Feature } from "../engine/types.ts";
import { CellType, FeatureType } from "../engine/types.ts";
import { renderDungeon } from "../renderer/canvas-renderer.ts";
import { getTheme } from "../renderer/themes/theme-engine.ts";

interface DD2VTTPoint {
  x: number;
  y: number;
}

interface DD2VTTPortal {
  position: DD2VTTPoint;
  bounds: DD2VTTPoint[];
  rotation: number;
  closed: boolean;
  freestanding: boolean;
}

interface DD2VTT {
  format: number;
  resolution: {
    map_origin: DD2VTTPoint;
    map_size: DD2VTTPoint;
    pixels_per_grid: number;
  };
  line_of_sight: DD2VTTPoint[][];
  portals: DD2VTTPortal[];
  image: string;
}

interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export function exportVTT(dungeon: Dungeon): void {
  const pxPerGrid = 140;

  // Render map image
  const canvas = document.createElement("canvas");
  canvas.width = dungeon.width * pxPerGrid;
  canvas.height = dungeon.height * pxPerGrid;
  const ctx = canvas.getContext("2d")!;
  renderDungeon(ctx, dungeon, {
    cellSize: pxPerGrid,
    showGrid: false,
    theme: getTheme(dungeon.config.motif),
    selectedRoomId: null,
    hoveredRoomId: null,
  });

  // Extract wall segments for line of sight
  const losSegments = extractWallSegments(dungeon);

  // Extract doors as portals
  const portals = extractPortals(dungeon);

  const dataUrl = canvas.toDataURL("image/png");
  const base64 = dataUrl.split(",")[1] ?? "";

  const vtt: DD2VTT = {
    format: 0.3,
    resolution: {
      map_origin: { x: 0, y: 0 },
      map_size: { x: dungeon.width, y: dungeon.height },
      pixels_per_grid: pxPerGrid,
    },
    line_of_sight: losSegments,
    portals,
    image: base64,
  };

  // Download as .dd2vtt file
  const blob = new Blob([JSON.stringify(vtt)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `dungeon-${dungeon.seed}.dd2vtt`;
  a.click();
  URL.revokeObjectURL(url);
}

function isOpaque(cellType: CellType): boolean {
  return cellType === CellType.Wall || cellType === CellType.Empty;
}

function isPassable(cellType: CellType): boolean {
  return !isOpaque(cellType);
}

function getCellType(dungeon: Dungeon, x: number, y: number): CellType {
  if (x < 0 || y < 0 || x >= dungeon.width || y >= dungeon.height) {
    return CellType.Empty;
  }
  const row = dungeon.grid[y];
  if (!row) return CellType.Empty;
  const cell = row[x];
  if (!cell) return CellType.Empty;
  return cell.type;
}

/**
 * Extract wall edges as line segments in grid coordinates.
 * An edge exists between an opaque cell and a passable cell.
 * Colinear adjacent segments are merged.
 */
function extractWallSegments(dungeon: Dungeon): DD2VTTPoint[][] {
  const horizontalSegments: Segment[] = [];
  const verticalSegments: Segment[] = [];

  // Find horizontal edges (between rows y and y+1 means the edge at y)
  // Check every horizontal edge: for each cell, check the edge above (between y-1 and y)
  for (let y = 0; y <= dungeon.height; y++) {
    for (let x = 0; x < dungeon.width; x++) {
      const above = getCellType(dungeon, x, y - 1);
      const below = getCellType(dungeon, x, y);
      if (isOpaque(above) !== isOpaque(below)) {
        horizontalSegments.push({ x1: x, y1: y, x2: x + 1, y2: y });
      }
    }
  }

  // Find vertical edges (between columns x and x+1)
  for (let x = 0; x <= dungeon.width; x++) {
    for (let y = 0; y < dungeon.height; y++) {
      const left = getCellType(dungeon, x - 1, y);
      const right = getCellType(dungeon, x, y);
      if (isOpaque(left) !== isOpaque(right)) {
        verticalSegments.push({ x1: x, y1: y, x2: x, y2: y + 1 });
      }
    }
  }

  // Merge colinear horizontal segments
  const mergedHorizontal = mergeHorizontalSegments(horizontalSegments);

  // Merge colinear vertical segments
  const mergedVertical = mergeVerticalSegments(verticalSegments);

  // Convert to DD2VTT point pair format
  const result: DD2VTTPoint[][] = [];
  for (const seg of mergedHorizontal) {
    result.push([{ x: seg.x1, y: seg.y1 }, { x: seg.x2, y: seg.y2 }]);
  }
  for (const seg of mergedVertical) {
    result.push([{ x: seg.x1, y: seg.y1 }, { x: seg.x2, y: seg.y2 }]);
  }

  return result;
}

function mergeHorizontalSegments(segments: Segment[]): Segment[] {
  if (segments.length === 0) return [];

  // Group by y coordinate, then sort by x1
  const byRow = new Map<number, Segment[]>();
  for (const seg of segments) {
    const group = byRow.get(seg.y1);
    if (group) {
      group.push(seg);
    } else {
      byRow.set(seg.y1, [seg]);
    }
  }

  const merged: Segment[] = [];
  for (const [, group] of byRow) {
    group.sort((a, b) => a.x1 - b.x1);

    let current = { ...group[0]! };
    for (let i = 1; i < group.length; i++) {
      const next = group[i]!;
      if (next.x1 === current.x2) {
        // Extend current segment
        current.x2 = next.x2;
      } else {
        merged.push(current);
        current = { ...next };
      }
    }
    merged.push(current);
  }

  return merged;
}

function mergeVerticalSegments(segments: Segment[]): Segment[] {
  if (segments.length === 0) return [];

  // Group by x coordinate, then sort by y1
  const byCol = new Map<number, Segment[]>();
  for (const seg of segments) {
    const group = byCol.get(seg.x1);
    if (group) {
      group.push(seg);
    } else {
      byCol.set(seg.x1, [seg]);
    }
  }

  const merged: Segment[] = [];
  for (const [, group] of byCol) {
    group.sort((a, b) => a.y1 - b.y1);

    let current = { ...group[0]! };
    for (let i = 1; i < group.length; i++) {
      const next = group[i]!;
      if (next.y1 === current.y2) {
        // Extend current segment
        current.y2 = next.y2;
      } else {
        merged.push(current);
        current = { ...next };
      }
    }
    merged.push(current);
  }

  return merged;
}

/**
 * Extract door features as DD2VTT portals.
 */
function extractPortals(dungeon: Dungeon): DD2VTTPortal[] {
  const doorFeatures: Feature[] = dungeon.features.filter(
    (f) =>
      f.type === FeatureType.Door ||
      f.type === FeatureType.SecretDoor ||
      f.type === FeatureType.LockedDoor ||
      f.type === FeatureType.Portcullis ||
      f.type === FeatureType.Archway ||
      f.type === FeatureType.TrappedDoor
  );

  return doorFeatures.map((feature) => {
    const cx = feature.x + 0.5;
    const cy = feature.y + 0.5;

    // Determine door orientation by checking neighbors
    const leftType = getCellType(dungeon, feature.x - 1, feature.y);
    const rightType = getCellType(dungeon, feature.x + 1, feature.y);
    const isHorizontal = isPassable(leftType) && isPassable(rightType);

    // Rotation in degrees: 0 = vertical door, 90 = horizontal door
    const rotation = isHorizontal ? 90 : 0;

    // Bounds define the door opening area (a 1-grid-wide line)
    const bounds: DD2VTTPoint[] = isHorizontal
      ? [
          { x: feature.x, y: feature.y },
          { x: feature.x + 1, y: feature.y },
          { x: feature.x + 1, y: feature.y + 1 },
          { x: feature.x, y: feature.y + 1 },
        ]
      : [
          { x: feature.x, y: feature.y },
          { x: feature.x + 1, y: feature.y },
          { x: feature.x + 1, y: feature.y + 1 },
          { x: feature.x, y: feature.y + 1 },
        ];

    return {
      position: { x: cx, y: cy },
      bounds,
      rotation,
      closed: feature.type === FeatureType.LockedDoor,
      freestanding: false,
    };
  });
}
