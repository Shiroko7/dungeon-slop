import type { SeededRandom } from "../lib/random.ts";

/**
 * Each carve function returns a Set of "x,y" keys representing floor cells
 * within the given bounding rectangle.
 */

export function carveShape(
  shape: string,
  x: number,
  y: number,
  width: number,
  height: number,
  rng: SeededRandom,
): Set<string> {
  switch (shape) {
    case "Square":
      return carveSquare(x, y, width, height);
    case "Circular":
      return carveCircular(x, y, width, height);
    case "Hexagonal":
      return carveHexagonal(x, y, width, height);
    case "Pentagonal":
      return carvePentagonal(x, y, width, height);
    case "Cave":
      return carveCave(x, y, width, height, rng);
    case "Cross":
      return carveCross(x, y, width, height);
    case "Diamond":
      return carveDiamond(x, y, width, height);
    case "Rectangular":
    default:
      return carveRectangular(x, y, width, height);
  }
}

function carveRectangular(x: number, y: number, w: number, h: number): Set<string> {
  const cells = new Set<string>();
  for (let cy = y; cy < y + h; cy++) {
    for (let cx = x; cx < x + w; cx++) {
      cells.add(`${cx},${cy}`);
    }
  }
  return cells;
}

function carveSquare(x: number, y: number, w: number, h: number): Set<string> {
  const side = Math.min(w, h);
  const ox = x + Math.floor((w - side) / 2);
  const oy = y + Math.floor((h - side) / 2);
  return carveRectangular(ox, oy, side, side);
}

// ─── Inclusive intersection helpers ──────────────────────────────────────────
// For every cell we test 5 sample points (4 corners + center). If ANY falls
// inside the shape, the cell is carved. All shape formulas exactly mirror the
// renderer's geometry (room-shapes.ts) so grid ownership matches visual output.

// ── Circle (matches renderer: r = min(w, h) / 2) ─────────────────────────────

function pointInCircle(sx: number, sy: number, cx: number, cy: number, r: number): boolean {
  const dx = sx - cx, dy = sy - cy;
  return dx * dx + dy * dy <= r * r;
}

function cellIntersectsCircle(px: number, py: number, cx: number, cy: number, r: number): boolean {
  return (
    pointInCircle(px,       py,       cx, cy, r) ||
    pointInCircle(px + 1,   py,       cx, cy, r) ||
    pointInCircle(px,       py + 1,   cx, cy, r) ||
    pointInCircle(px + 1,   py + 1,   cx, cy, r) ||
    pointInCircle(px + 0.5, py + 0.5, cx, cy, r)
  );
}

// ── Diamond (matches renderer: r = min(w, h) / 2) ────────────────────────────

function pointInDiamond(sx: number, sy: number, cx: number, cy: number, r: number): boolean {
  return Math.abs(sx - cx) + Math.abs(sy - cy) <= r;
}

function cellIntersectsDiamond(px: number, py: number, cx: number, cy: number, r: number): boolean {
  return (
    pointInDiamond(px,       py,       cx, cy, r) ||
    pointInDiamond(px + 1,   py,       cx, cy, r) ||
    pointInDiamond(px,       py + 1,   cx, cy, r) ||
    pointInDiamond(px + 1,   py + 1,   cx, cy, r) ||
    pointInDiamond(px + 0.5, py + 0.5, cx, cy, r)
  );
}

// ── Convex polygon (hexagonal, pentagonal) ────────────────────────────────────
// Vertices must be in CLOCKWISE order in screen space (y increases downward).
// For each directed edge A→B, interior points satisfy:
//   (B.x - A.x) * (P.y - A.y) - (B.y - A.y) * (P.x - A.x) >= 0

type Pt = { x: number; y: number };

function pointInConvexPolygon(sx: number, sy: number, verts: Pt[]): boolean {
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i]!;
    const b = verts[(i + 1) % verts.length]!;
    if ((b.x - a.x) * (sy - a.y) - (b.y - a.y) * (sx - a.x) < 0) return false;
  }
  return true;
}

function cellIntersectsConvexPolygon(px: number, py: number, verts: Pt[]): boolean {
  return (
    pointInConvexPolygon(px,       py,       verts) ||
    pointInConvexPolygon(px + 1,   py,       verts) ||
    pointInConvexPolygon(px,       py + 1,   verts) ||
    pointInConvexPolygon(px + 1,   py + 1,   verts) ||
    pointInConvexPolygon(px + 0.5, py + 0.5, verts)
  );
}

function carveCircular(x: number, y: number, w: number, h: number): Set<string> {
  const cells = new Set<string>();
  const cx = x + w / 2;
  const cy = y + h / 2;
  const r  = Math.min(w, h) / 2; // matches renderer: r = min(boundsW, boundsH) / 2 / cellSize
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      if (cellIntersectsCircle(px, py, cx, cy, r)) {
        cells.add(`${px},${py}`);
      }
    }
  }
  if (cells.size < 4) return carveRectangular(x, y, w, h);
  return cells;
}

function carveHexagonal(x: number, y: number, w: number, h: number): Set<string> {
  const cells = new Set<string>();
  const cx = x + w / 2;
  const cy = y + h / 2;
  // Matches renderer: r = min(boundsW / sqrt(3), boundsH / 2) in grid units
  const r  = Math.min(w / Math.sqrt(3), h / 2);
  const hw = (r * Math.sqrt(3)) / 2;
  // Pointy-top hexagon vertices in CW order (screen coords, y-down)
  const verts: Pt[] = [
    { x: cx,      y: cy - r      },  // top
    { x: cx + hw, y: cy - r / 2  },  // top-right
    { x: cx + hw, y: cy + r / 2  },  // bottom-right
    { x: cx,      y: cy + r      },  // bottom
    { x: cx - hw, y: cy + r / 2  },  // bottom-left
    { x: cx - hw, y: cy - r / 2  },  // top-left
  ];
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      if (cellIntersectsConvexPolygon(px, py, verts)) {
        cells.add(`${px},${py}`);
      }
    }
  }
  if (cells.size < 4) return carveRectangular(x, y, w, h);
  return cells;
}

function carvePentagonal(x: number, y: number, w: number, h: number): Set<string> {
  const cells = new Set<string>();
  const cx = x + w / 2;
  const cy = y + h / 2;
  // Matches renderer: r = min(boundsW / 1.902, boundsH / 1.809) in grid units
  const r = Math.min(w / 1.902, h / 1.809);
  // Regular pentagon, pointed top; vertices in CW order (screen coords, y-down)
  const verts: Pt[] = [];
  for (let i = 0; i < 5; i++) {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
    verts.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
  }
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      if (cellIntersectsConvexPolygon(px, py, verts)) {
        cells.add(`${px},${py}`);
      }
    }
  }
  if (cells.size < 4) return carveRectangular(x, y, w, h);
  return cells;
}

function carveCave(x: number, y: number, w: number, h: number, rng: SeededRandom): Set<string> {
  // Mini cellular automata
  const map: boolean[][] = [];
  for (let cy = 0; cy < h; cy++) {
    map[cy] = [];
    for (let cx = 0; cx < w; cx++) {
      // Border cells are always walls, interior ~55% floor
      if (cx === 0 || cy === 0 || cx === w - 1 || cy === h - 1) {
        map[cy]![cx] = false;
      } else {
        map[cy]![cx] = rng.chance(0.55);
      }
    }
  }

  // Run 4 iterations of smoothing
  for (let iter = 0; iter < 4; iter++) {
    const next: boolean[][] = [];
    for (let cy = 0; cy < h; cy++) {
      next[cy] = [];
      for (let cx = 0; cx < w; cx++) {
        let walls = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const ny = cy + dy;
            const nx = cx + dx;
            if (ny < 0 || ny >= h || nx < 0 || nx >= w || !map[ny]?.[nx]) {
              walls++;
            }
          }
        }
        next[cy]![cx] = walls < 4;
      }
    }
    for (let cy = 0; cy < h; cy++) {
      for (let cx = 0; cx < w; cx++) {
        map[cy]![cx] = next[cy]![cx]!;
      }
    }
  }

  // Flood-fill from center to get connected region
  const cells = new Set<string>();
  const startX = Math.floor(w / 2);
  const startY = Math.floor(h / 2);
  // Ensure center is floor
  if (!map[startY]?.[startX]) {
    map[startY]![startX] = true;
  }

  const stack: Array<[number, number]> = [[startX, startY]];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const [cx, cy] = stack.pop()!;
    const key = `${cx},${cy}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
    if (!map[cy]?.[cx]) continue;
    cells.add(`${x + cx},${y + cy}`);
    stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
  }

  if (cells.size < 4) return carveRectangular(x, y, w, h);
  return cells;
}

function carveCross(x: number, y: number, w: number, h: number): Set<string> {
  const cells = new Set<string>();
  // Use min(w,h) for both bars so the cross is symmetric regardless of room aspect ratio
  const barThickness = Math.max(2, Math.floor(Math.min(w, h) / 3));
  // Horizontal strip (full width, equal-thickness bar centered vertically)
  const hStripH = barThickness;
  const hStripY = y + Math.floor((h - hStripH) / 2);
  // Vertical strip (equal-thickness bar centered horizontally, full height)
  const vStripW = barThickness;
  const vStripX = x + Math.floor((w - vStripW) / 2);

  for (let py = hStripY; py < hStripY + hStripH; py++) {
    for (let px = x; px < x + w; px++) {
      cells.add(`${px},${py}`);
    }
  }
  for (let py = y; py < y + h; py++) {
    for (let px = vStripX; px < vStripX + vStripW; px++) {
      cells.add(`${px},${py}`);
    }
  }
  return cells;
}

function carveDiamond(x: number, y: number, w: number, h: number): Set<string> {
  const cells = new Set<string>();
  const cx = x + w / 2;
  const cy = y + h / 2;
  const r  = Math.min(w, h) / 2; // matches renderer: r = min(boundsW, boundsH) / 2 / cellSize
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      if (cellIntersectsDiamond(px, py, cx, cy, r)) {
        cells.add(`${px},${py}`);
      }
    }
  }
  if (cells.size < 4) return carveRectangular(x, y, w, h);
  return cells;
}

export function erodeShape(
  cells: Set<string>,
  rate: number,
  passes: number,
  rng: SeededRandom,
): Set<string> {
  let current = new Set(cells);

  for (let pass = 0; pass < passes; pass++) {
    const next = new Set(current);
    for (const key of current) {
      const [xs, ys] = key.split(",");
      const x = Number(xs), y = Number(ys);
      let hasEmptyNeighbor = false;
      for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]] as const) {
        if (!current.has(`${x+dx},${y+dy}`)) { hasEmptyNeighbor = true; break; }
      }
      if (hasEmptyNeighbor && rng.chance(rate)) next.delete(key);
    }
    current = next;
  }

  if (current.size === 0) return cells; // safety: fully eroded → revert

  // Keep only the largest connected component via BFS
  const allComponents: Array<Set<string>> = [];
  const globalVisited = new Set<string>();
  for (const startKey of current) {
    if (globalVisited.has(startKey)) continue;
    const comp = new Set<string>([startKey]);
    const queue = [startKey];
    let head = 0;
    while (head < queue.length) {
      const k = queue[head++]!;
      const [xs, ys] = k.split(",");
      const x = Number(xs), y = Number(ys);
      for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]] as const) {
        const nk = `${x+dx},${y+dy}`;
        if (!comp.has(nk) && current.has(nk)) { comp.add(nk); queue.push(nk); }
      }
    }
    comp.forEach(k => globalVisited.add(k));
    allComponents.push(comp);
  }

  const best = allComponents.reduce((a, b) => (b.size > a.size ? b : a));
  return best.size >= 4 ? best : cells; // revert if result too small
}
