import type { RoughCanvas } from "roughjs/bin/canvas";
import type { Cell, Dungeon, Room } from "../engine/types.ts";
import { CellType, isCaveShape } from "../engine/types.ts";
import type { ThemePalette } from "./themes/theme-engine.ts";
import { getRoomGeometry, crossOutlineVertices } from "./room-shapes.ts";
import PolyBool from "polybooljs";

// ─── Light-sketch wall rendering ─────────────────────────────────────────────
//
// All outline geometry is computed in GRID space (1 unit = 1 cell) and scaled
// by cellSize only at draw time. Jitter is hashed from grid coordinates, so
// the live canvas (16px), PDF (20px), PNG (30px) and VTT (140px) renders all
// produce the same wobble shapes at their respective scales.
//
// Walls (drawSketchWalls): a heavy jittered ink band leaning out from the
// outline, the exact floor filled over it, which cuts the band to the floor's
// own edge, then a shaded inner face stroked along that same edge.
//
// Everything is computed once per dungeon in grid space, so it lands the same
// at every render scale.

export interface Pt { x: number; y: number }

interface SketchOutlines {
  /** Closed loops for the ink band: smooth room outlines + extended cell-region loops. */
  bandLoops: Pt[][];
  /** The drawn floor's exact outline, outer edges and holes, as closed rings. */
  floorOutline: Pt[][];
}

export const WALKABLE = new Set([
  CellType.Floor, CellType.Corridor, CellType.Door,
  CellType.SecretDoor, CellType.StairsUp, CellType.StairsDown,
]);

/**
 * Should this walkable cell's floor rect be stretched one cell into the
 * geometric room beside it?
 *
 * The stretch exists so a corridor meets the smooth room shape, which is inset
 * from the cell grid it was carved on. Done for a corridor that merely runs
 * alongside a room, it lays a strip of floor over that room's wall and erases
 * it — so require a passage arriving head-on: the cell belongs to no room at
 * all, and the cell behind it, opposite the room, is the floor it came from.
 *
 * buildFloorPath and the ink band mask must agree on this exactly, or the band
 * is stroked somewhere the fill does not erase it.
 */
export function extendsIntoRoom(
  grid: Cell[][],
  x: number,
  y: number,
  dx: number,
  dy: number,
  roomId: number,
): boolean {
  const from = grid[y]?.[x];
  if (from === undefined || !WALKABLE.has(from.type) || from.roomId !== null) return false;
  const back = grid[y - dy]?.[x - dx];
  return back !== undefined && WALKABLE.has(back.type) && back.roomId !== roomId;
}

// ─── Deterministic hashing ────────────────────────────────────────────────────

/** Uniform [0,1) hash of (seed, a, b, c). Same recipe as shadowVertexDepth. */
export function hash01(seed: number, a: number, b: number, c = 0): number {
  let h = (seed ^ Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 1779033703) ^ Math.imul(c | 0, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 2246822519) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 1013904223) >>> 0;
  return h / 0x100000000;
}

/** roughjs needs a non-zero integer seed (0 = "random each draw"). */
export function roughSeed(seed: number, a: number, b: number): number {
  return (Math.imul((seed ^ Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663)) >>> 0, 2654435761) >>> 0) | 1;
}

// ─── Outline extraction (grid space, cached per dungeon) ────────────────────

const outlineCache = new WeakMap<Dungeon, SketchOutlines>();

export function getSketchOutlines(dungeon: Dungeon): SketchOutlines {
  const cached = outlineCache.get(dungeon);
  if (cached) return cached;
  const built = buildSketchOutlines(dungeon);
  outlineCache.set(dungeon, built);
  return built;
}

function buildSketchOutlines(dungeon: Dungeon): SketchOutlines {
  const { width, height, grid, rooms } = dungeon;

  const geometricRooms: Room[] = [];
  const geometricRoomIds = new Set<number>();
  for (const room of rooms) {
    if (isCaveShape(room.shape)) continue;
    geometricRoomIds.add(room.id);
    geometricRooms.push(room);
  }

  const idx = (x: number, y: number) => y * width + x;

  // Every cell the floor path paints as a whole rect: corridors, doors and cave
  // rooms, plus the room cell a passage arriving head-on reaches into. This
  // mirrors buildFloorPath exactly, so outlines built from it are the floor's own.
  const extMask = new Set<number>();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = grid[y]?.[x];
      if (!cell || !WALKABLE.has(cell.type)) continue;
      if (cell.roomId !== null && geometricRoomIds.has(cell.roomId)) continue;
      extMask.add(idx(x, y));
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
        const n = grid[y + dy]?.[x + dx];
        if (n && n.roomId !== null && geometricRoomIds.has(n.roomId) &&
            extendsIntoRoom(grid, x, y, dx, dy, n.roomId)) {
          extMask.add(idx(x + dx, y + dy));
        }
      }
    }
  }

  // Band loops: smooth room outlines + extended-mask region loops
  const bandLoops: Pt[][] = [];
  const roomOutlines = new Map<number, Pt[]>();
  for (const room of geometricRooms) {
    const outline = sampleRoomOutline(room);
    roomOutlines.set(room.id, outline);
    bandLoops.push(outline);
  }
  const cellLoops = maskLoops(extMask, width, () => true).map(simplifyCollinear);
  for (const loop of cellLoops) bandLoops.push(subdivide(loop, 0.6));

  // The drawn floor's own outline: every room shape and every whole-cell rect
  // unioned into one boundary, holes included. The shaded inner face is stroked
  // along it and clipped to the floor, so it can only ever lie along an edge the
  // floor really has.
  const ring = (loop: Pt[]): Array<[number, number]> => {
    const pts: Array<[number, number]> = loop.map((p) => [p.x, p.y]);
    const a = pts[0];
    const b = pts[pts.length - 1];
    if (a !== undefined && b !== undefined && pts.length > 1 && a[0] === b[0] && a[1] === b[1]) pts.pop();
    return pts;
  };
  const floorOutline: Pt[][] = PolyBool.union(
    { regions: cellLoops.map(ring), inverted: false },
    { regions: geometricRooms.map((room) => ring(roomOutlines.get(room.id)!)), inverted: false },
  ).regions.map((r) => closeRing(r.map(([x, y]) => ({ x, y }))));

  return { bandLoops, floorOutline };
}


/**
 * Repeat a ring's first point at the end — the form the rest of this module
 * treats as closed.
 *
 * buildJitteredPath decides a polyline is closed by checking whether its ends
 * meet, and subdivide leaves the final segment alone for the same reason. A
 * room outline handed over as a bare list of corners satisfies neither: its
 * last edge is never subdivided and never stroked, so the room renders with one
 * whole wall missing.
 */
function closeRing(pts: Pt[]): Pt[] {
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (first === undefined || last === undefined) return pts;
  if (Math.hypot(first.x - last.x, first.y - last.y) < 1e-9) return pts;
  return [...pts, { x: first.x, y: first.y }];
}

/** Sample a geometric room's outline in grid space (closed: last point = first). */
function sampleRoomOutline(room: Room): Pt[] {
  const geo = getRoomGeometry(room, 1);
  switch (geo.type) {
    case "ellipse": {
      const r = geo.radiusX ?? 1;
      const n = Math.max(24, Math.ceil(2 * Math.PI * r * 1.6));
      const pts: Pt[] = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * 2 * Math.PI;
        pts.push({
          x: geo.centerX + (geo.radiusX ?? r) * Math.cos(a),
          y: geo.centerY + (geo.radiusY ?? r) * Math.sin(a),
        });
      }
      return closeRing(pts);
    }
    case "polygon":
      return subdivide(closeRing(geo.vertices ?? []), 0.6);
    case "path":
      return subdivide(closeRing(crossOutlineVertices(room, 1)), 0.6);
    case "rect":
    default: {
      const { x, y, width: w, height: h } = geo.bounds;
      return subdivide(closeRing([
        { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
      ]), 0.6);
    }
  }
}

/** Trace all boundary loops of a cell mask (supports multiple regions + holes). */
function maskLoops(mask: Set<number>, width: number, _include: (i: number) => boolean): Pt[][] {
  const edges: Array<[Pt, Pt]> = [];
  for (const i of mask) {
    const x = i % width;
    const y = Math.floor(i / width);
    if (!mask.has(i + 1) || x === width - 1) edges.push([{ x: x + 1, y }, { x: x + 1, y: y + 1 }]);
    if (!mask.has(i - 1) || x === 0) edges.push([{ x, y: y + 1 }, { x, y }]);
    if (!mask.has(i - width)) edges.push([{ x, y }, { x: x + 1, y }]);
    if (!mask.has(i + width)) edges.push([{ x: x + 1, y: y + 1 }, { x, y: y + 1 }]);
  }
  return chainEdges(edges);
}

/**
 * Chain directed edges into polylines: cycles and open paths both supported.
 *
 * Where four edges meet — two mask cells touching only at a corner — taking the
 * first unused candidate can hop into the far cell's loop and leave the walk
 * unable to get home, yielding an open chain that the band pass then strokes
 * with one segment missing. Turning as far as possible toward the interior
 * (which every emitted edge keeps on its right) separates the two cells into
 * loops that each close.
 */
function chainEdges(edges: Array<[Pt, Pt]>): Pt[][] {
  const key = (p: Pt) => `${p.x},${p.y}`;
  const byStart = new Map<string, Array<[Pt, Pt]>>();
  for (const e of edges) {
    const k = key(e[0]);
    if (!byStart.has(k)) byStart.set(k, []);
    byStart.get(k)!.push(e);
  }
  const used = new Set<[Pt, Pt]>();
  const chains: Pt[][] = [];

  for (const e0 of edges) {
    if (used.has(e0)) continue;
    used.add(e0);
    const chain: Pt[] = [e0[0], e0[1]];
    let endKey = key(e0[1]);
    const startKey = key(e0[0]);
    let dx = e0[1].x - e0[0].x;
    let dy = e0[1].y - e0[0].y;
    while (endKey !== startKey) {
      const nexts = byStart.get(endKey);
      let next: [Pt, Pt] | undefined;
      let bestTurn = -Infinity;
      if (nexts) {
        for (const cand of nexts) {
          if (used.has(cand)) continue;
          const cx = cand[1].x - cand[0].x;
          const cy = cand[1].y - cand[0].y;
          const turn = Math.atan2(dx * cy - dy * cx, dx * cx + dy * cy);
          if (turn > bestTurn) { bestTurn = turn; next = cand; }
        }
      }
      if (!next) break;
      used.add(next);
      chain.push(next[1]);
      endKey = key(next[1]);
      dx = next[1].x - next[0].x;
      dy = next[1].y - next[0].y;
    }
    chains.push(chain);
  }
  return chains;
}

/** Merge consecutive collinear points (axis-aligned chains from cell edges). */
function simplifyCollinear(pts: Pt[]): Pt[] {
  if (pts.length < 3) return pts;
  const out: Pt[] = [pts[0]!];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1]!;
    const b = pts[i]!;
    const c = pts[i + 1]!;
    const abx = b.x - a.x, aby = b.y - a.y;
    const bcx = c.x - b.x, bcy = c.y - b.y;
    if (abx * bcy - aby * bcx !== 0) out.push(b);
  }
  out.push(pts[pts.length - 1]!);
  return out;
}

/** Insert points so no segment exceeds maxLen (grid units). */
function subdivide(pts: Pt[], maxLen: number): Pt[] {
  if (pts.length < 2) return pts;
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    out.push(a);
    if (i === pts.length - 1) break; // don't subdivide the closing segment twice
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.floor(len / maxLen);
    for (let k = 1; k <= n; k++) {
      const t = k / (n + 1);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

// ─── Jittered path construction ──────────────────────────────────────────────

/**
 * Build a Path2D from grid-space polylines, offsetting each point along its
 * local normal by a seeded hash — the hand-drawn wobble — plus an optional
 * constant outward bias. All outline loops here keep their interior on the
 * RIGHT of the travel direction, so outward = left of travel = (ty, -tx).
 * Closed loops close; open chains (doorway gaps) stay open.
 */
export function buildJitteredPath(
  polylines: Pt[][],
  seed: number,
  ampCells: number,
  cellSize: number,
  salt: number,
  outwardCells = 0,
): Path2D {
  const path = new Path2D();
  for (const pts of polylines) {
    if (pts.length < 2) continue;
    const first = pts[0]!;
    const last = pts[pts.length - 1]!;
    const isClosed = Math.hypot(first.x - last.x, first.y - last.y) < 1e-9;
    const n = isClosed ? pts.length - 1 : pts.length; // skip duplicate end point
    if (n < 2) continue;

    for (let i = 0; i < n; i++) {
      const p = pts[i]!;
      const prev = pts[(i - 1 + n) % n]!;
      const next = pts[(i + 1) % n]!;
      // Tangent of the chord around p; outward normal = left of travel
      let tx = next.x - prev.x, ty = next.y - prev.y;
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl; ty /= tl;
      const ox = ty, oy = -tx;
      // Open-chain endpoints stay anchored (no jitter) so gaps line up
      const anchored = !isClosed && (i === 0 || i === n - 1);
      const off = outwardCells + (anchored
        ? 0
        : (hash01(seed, Math.round(p.x * 1000), Math.round(p.y * 1000), salt) - 0.5) * 2 * ampCells);
      const x = (p.x + ox * off) * cellSize;
      const y = (p.y + oy * off) * cellSize;
      if (i === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    }
    if (isClosed) path.closePath();
  }
  return path;
}

// ─── Drawing passes ──────────────────────────────────────────────────────────

interface WallPaths { band: Path2D; outline: Path2D }
const jitteredBandCache = new WeakMap<Dungeon, Map<number, WallPaths>>();

function getJitteredPaths(dungeon: Dungeon, cellSize: number): WallPaths {
  let bySize = jitteredBandCache.get(dungeon);
  if (!bySize) { bySize = new Map(); jitteredBandCache.set(dungeon, bySize); }
  const hit = bySize.get(cellSize);
  if (hit) return hit;
  const o = getSketchOutlines(dungeon);
  const paths = {
    // Leaned outward by half the band less the jitter, so the band's inner edge
    // never leaves the floor. The floor fill then cuts every wall to the floor's
    // own edge, and the hand-drawn wobble lives on the outer edge only.
    band: buildJitteredPath(o.bandLoops, dungeon.seed, WALL_JITTER, cellSize, 1, WALL_INK * 0.5 - WALL_JITTER),
    // The floor's outline exactly: no jitter, no offset.
    outline: buildJitteredPath(o.floorOutline, dungeon.seed, 0, cellSize, 2),
  };
  bySize.set(cellSize, paths);
  return paths;
}

// ─── Wall weight (in cells) ─────────────────────────────────────────────────
/** Solid ink outside the floor boundary. */
const WALL_INK = 0.23;
/** How far the ink band wobbles either way. */
const WALL_JITTER = 0.035;
/** The masonry's inner face, shaded, inside the floor boundary. */
const WALL_FACE = 0.12;

/**
 * The wall: a heavy band of solid ink around the floor with a shaded inner face.
 *
 *   1. stroke the jittered outline wide; it leans outward, but never so far
 *      that its inner edge leaves the floor
 *   2. fill the exact floor over it, which cuts the ink to the floor's own edge
 *      and erases every seam and over-extension in one go
 *   3. stroke the floor's exact outline at twice the face's width, clipped to
 *      the floor: a band lying along exactly the edge step 2 just cut, round
 *      every corner and curve, and absent at doorways, which have no edge
 *
 * The ink and the face share one edge by construction, so they cannot drift
 * apart and leave floor showing between them.
 */
export function drawSketchWalls(
  ctx: CanvasRenderingContext2D,
  dungeon: Dungeon,
  cellSize: number,
  theme: ThemePalette,
  floorPath: Path2D,
): void {
  const { band, outline } = getJitteredPaths(dungeon, cellSize);

  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  ctx.strokeStyle = theme.ink;
  ctx.lineWidth = Math.max(1.5, cellSize * WALL_INK);
  ctx.stroke(band);

  ctx.fillStyle = theme.parchment;
  ctx.fill(floorPath, "nonzero");

  ctx.save();
  ctx.clip(floorPath, "nonzero");
  ctx.strokeStyle = mixHex(theme.parchment, theme.ink, 0.43);
  ctx.lineWidth = Math.max(2, cellSize * WALL_FACE * 2);
  ctx.stroke(outline);
  ctx.restore();

  ctx.restore();
}

/** Blend two "#rrggbb" colours; t = 0 is `a`, t = 1 is `b`. */
export function mixHex(a: string, b: string, t: number): string {
  const parse = (h: string): [number, number, number] => {
    const v = parseInt(h.slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  };
  if (!/^#[0-9a-fA-F]{6}$/.test(a) || !/^#[0-9a-fA-F]{6}$/.test(b)) return a;
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const c = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, "0");
  return `#${c(ar, br)}${c(ag, bg)}${c(ab, bb)}`;
}

// ─── Feature glyphs (hand-drawn, seeded) ─────────────────────────────────────

/** Trap: rough triangle with an exclamation tick. */
export function drawTrapGlyph(
  rc: RoughCanvas,
  ctx: CanvasRenderingContext2D,
  gx: number,
  gy: number,
  cellSize: number,
  theme: ThemePalette,
  seed: number,
): void {
  const cx = (gx + 0.5) * cellSize;
  const cy = (gy + 0.5) * cellSize;
  const r = cellSize * 0.28;
  const sw = Math.max(0.7, cellSize * 0.045);
  rc.polygon(
    [
      [cx, cy - r],
      [cx + r * 0.95, cy + r * 0.75],
      [cx - r * 0.95, cy + r * 0.75],
    ],
    { stroke: theme.trap, strokeWidth: sw, roughness: 0.9, fill: "none", seed: roughSeed(seed, gx, gy) },
  );
  ctx.save();
  ctx.strokeStyle = theme.trap;
  ctx.fillStyle = theme.trap;
  ctx.lineWidth = sw;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(cx, cy - r * 0.35);
  ctx.lineTo(cx, cy + r * 0.15);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy + r * 0.45, sw * 0.7, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Treasure: rough chest — box, lid line, latch dot. */
export function drawTreasureGlyph(
  rc: RoughCanvas,
  ctx: CanvasRenderingContext2D,
  gx: number,
  gy: number,
  cellSize: number,
  theme: ThemePalette,
  seed: number,
): void {
  const cx = (gx + 0.5) * cellSize;
  const cy = (gy + 0.5) * cellSize;
  const w = cellSize * 0.58;
  const h = cellSize * 0.42;
  const sw = Math.max(0.8, cellSize * 0.055);
  const s = roughSeed(seed, gx, gy);
  rc.rectangle(cx - w / 2, cy - h * 0.32, w, h * 0.82, {
    stroke: theme.treasure, strokeWidth: sw, roughness: 0.9, fill: "none", seed: s,
  });
  // Lid arc
  rc.arc(cx, cy - h * 0.32, w, h * 0.72, Math.PI, 2 * Math.PI, false, {
    stroke: theme.treasure, strokeWidth: sw, roughness: 0.8, seed: s,
  });
  ctx.save();
  ctx.fillStyle = theme.treasure;
  ctx.beginPath();
  ctx.arc(cx, cy - h * 0.02, sw * 0.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
