import { describe, test, expect } from "bun:test";
import { generateDungeon } from "../engine/generate.ts";
import { CellType, isCaveShape, type Dungeon } from "../engine/types.ts";
import { DEFAULT_CONFIG } from "../ai/schema.ts";
import { getSketchOutlines, WALKABLE, extendsIntoRoom } from "./sketch.ts";
import { pointInRoomShape, getRoomGeometry } from "./room-shapes.ts";

/**
 * What the map draws has to agree with what the grid says is there.
 *
 * These are the checks the renderer never had. Nothing here inspects pixels:
 * every property is a statement about the geometry the drawing passes are
 * handed, which is where all three of the defects these cover actually lived.
 */

const SHAPE_SETS = [
  ["Rectangular"],
  ["Circular"],
  ["Hexagonal"],
  ["Pentagonal"],
  ["Diamond"],
  ["Cross"],
  ["Square"],
  ["Circular", "Hexagonal", "Pentagonal", "Diamond", "Cross", "Cave"],
] as const;

function cfg(over: Record<string, unknown> = {}) {
  return { ...DEFAULT_CONFIG, grid_width: 60, grid_height: 60, seed: 7, ...over };
}

/** Every dungeon in the sweep, labelled. */
function sweep(): Array<[string, Dungeon]> {
  const out: Array<[string, Dungeon]> = [];
  for (const shapes of SHAPE_SETS) {
    for (const style of ["constructed", "organic"] as const) {
      for (const seed of [7, 91, 2024]) {
        const label = `${shapes.join("+")} ${style} #${seed}`;
        out.push([label, generateDungeon(cfg({ room_shapes: [...shapes], layout_style: style, seed }))]);
      }
    }
  }
  return out;
}

const DUNGEONS = sweep();

describe("every room outline is a closed ring", () => {
  // buildJitteredPath only closes a polyline whose ends meet. A room handed over
  // as a bare list of corners loses its final edge — the wall simply is not
  // drawn — and nothing downstream complains, because the path is still valid.
  for (const [label, dungeon] of DUNGEONS) {
    test(label, () => {
      const { bandLoops } = getSketchOutlines(dungeon);
      expect(bandLoops.length).toBeGreaterThan(0);
      for (const loop of bandLoops) {
        expect(loop.length).toBeGreaterThan(2);
        const first = loop[0]!;
        const last = loop[loop.length - 1]!;
        expect(Math.hypot(first.x - last.x, first.y - last.y)).toBeLessThan(1e-9);
      }
    });
  }
});

describe("a room's drawn shape stays inside the space reserved for it", () => {
  // The layout hands each room a rectangle and packs the rest of the map around
  // it. A shape seated by its centroid rather than its extents — a pentagon,
  // whose centroid is not the middle of its own box — hangs its apex over the
  // edge, onto whatever the layout put next door.
  for (const [label, dungeon] of DUNGEONS) {
    test(label, () => {
      const escaped: string[] = [];
      for (const room of dungeon.rooms) {
        if (isCaveShape(room.shape)) continue;
        const geo = getRoomGeometry(room, 1);
        const corners: Array<[number, number]> = [];
        if (geo.type === "ellipse") {
          corners.push(
            [geo.centerX - (geo.radiusX ?? 0), geo.centerY - (geo.radiusY ?? 0)],
            [geo.centerX + (geo.radiusX ?? 0), geo.centerY + (geo.radiusY ?? 0)],
          );
        } else if (geo.type === "polygon") {
          for (const v of geo.vertices ?? []) corners.push([v.x, v.y]);
        } else if (geo.type === "path") {
          for (const r of geo.rects ?? []) corners.push([r.x, r.y], [r.x + r.width, r.y + r.height]);
        } else {
          corners.push(
            [geo.bounds.x, geo.bounds.y],
            [geo.bounds.x + geo.bounds.width, geo.bounds.y + geo.bounds.height],
          );
        }
        const slack = 1e-6;
        for (const [px, py] of corners) {
          if (px < room.x - slack || px > room.x + room.width + slack ||
              py < room.y - slack || py > room.y + room.height + slack) {
            escaped.push(`room ${room.id} (${room.shape}) reaches ${px.toFixed(2)},${py.toFixed(2)} outside ${room.x},${room.y} ${room.width}x${room.height}`);
          }
        }
      }
      expect(escaped.slice(0, 4)).toEqual([]);
    });
  }
});

describe("no walkable cell sits outside the floor the map draws", () => {
  // Shape carving used to keep any cell the shape so much as clipped, which put
  // floor a token can stand on where the map shows solid rock, and handed
  // corridors an attachment cell outside the room's own wall.
  for (const [label, dungeon] of DUNGEONS) {
    test(label, () => {
      const byId = new Map(dungeon.rooms.map((r) => [r.id, r]));
      const stray: string[] = [];
      for (let y = 0; y < dungeon.height; y++) {
        for (let x = 0; x < dungeon.width; x++) {
          const cell = dungeon.grid[y]?.[x];
          if (cell === undefined || !WALKABLE.has(cell.type)) continue;
          if (cell.roomId === null) continue;
          const room = byId.get(cell.roomId);
          if (room === undefined || isCaveShape(room.shape)) continue;
          if (!pointInRoomShape(room, x + 0.5, y + 0.5, 1)) stray.push(`${x},${y} in room ${room.id} (${room.shape})`);
        }
      }
      expect(stray.slice(0, 8)).toEqual([]);
    });
  }
});

/**
 * Is floor painted at this point? Mirrors buildFloorPath: smooth shapes for
 * geometric rooms, whole cells for everything else, plus the one-cell reach of
 * a passage arriving head-on.
 */
function drawnFloorAt(dungeon: Dungeon, px: number, py: number): boolean {
  for (const room of dungeon.rooms) {
    if (isCaveShape(room.shape)) continue;
    if (px < room.x || px > room.x + room.width || py < room.y || py > room.y + room.height) continue;
    if (pointInRoomShape(room, px, py, 1)) return true;
  }
  const cx = Math.floor(px);
  const cy = Math.floor(py);
  const cell = dungeon.grid[cy]?.[cx];
  if (cell === undefined || !WALKABLE.has(cell.type)) return false;
  const room = cell.roomId === null ? undefined : dungeon.rooms.find((r) => r.id === cell.roomId);
  if (room === undefined || isCaveShape(room.shape)) return true;
  for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
    if (extendsIntoRoom(dungeon.grid, cx - dx, cy - dy, dx, dy, room.id)) return true;
  }
  return false;
}

describe("every edge of the floor outline has floor on exactly one side", () => {
  // The shaded inner face is stroked along this outline and clipped to the
  // floor. An edge with floor on both sides would lay a grey line across a
  // doorway; one with floor on neither would be a face facing nothing.
  for (const [label, dungeon] of DUNGEONS) {
    test(label, () => {
      const { floorOutline } = getSketchOutlines(dungeon);
      expect(floorOutline.length).toBeGreaterThan(0);
      const bad: string[] = [];
      for (const ring of floorOutline) {
        for (let i = 0; i + 1 < ring.length; i++) {
          const a = ring[i]!;
          const b = ring[i + 1]!;
          const len = Math.hypot(b.x - a.x, b.y - a.y);
          if (len < 0.05) continue;
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          const nx = -(b.y - a.y) / len;
          const ny = (b.x - a.x) / len;
          const left = drawnFloorAt(dungeon, mx + nx * 0.03, my + ny * 0.03);
          const right = drawnFloorAt(dungeon, mx - nx * 0.03, my - ny * 0.03);
          if (left === right) bad.push(`${mx.toFixed(2)},${my.toFixed(2)} floor on ${left ? "both" : "neither"} side`);
        }
      }
      expect(bad.slice(0, 6)).toEqual([]);
    });
  }
});

describe("every wall of the drawn floor lies on the outline", () => {
  // The other half: nowhere may the floor meet rock without the outline being
  // there, or the face would be missing along that stretch of wall.
  for (const [label, dungeon] of DUNGEONS) {
    test(label, () => {
      const { floorOutline, bandLoops } = getSketchOutlines(dungeon);
      const buckets = new Map<string, Array<[number, number, number, number]>>();
      for (const ring of floorOutline) {
        for (let i = 0; i + 1 < ring.length; i++) {
          const a = ring[i]!;
          const b = ring[i + 1]!;
          for (let y = Math.floor(Math.min(a.y, b.y)); y <= Math.floor(Math.max(a.y, b.y)); y++) {
            for (let x = Math.floor(Math.min(a.x, b.x)); x <= Math.floor(Math.max(a.x, b.x)); x++) {
              const k = `${x},${y}`;
              const seg: [number, number, number, number] = [a.x, a.y, b.x, b.y];
              const list = buckets.get(k);
              if (list === undefined) buckets.set(k, [seg]);
              else list.push(seg);
            }
          }
        }
      }
      const distToOutline = (px: number, py: number): number => {
        let best = Infinity;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            for (const [ax, ay, bx, by] of buckets.get(`${Math.floor(px) + dx},${Math.floor(py) + dy}`) ?? []) {
              const vx = bx - ax;
              const vy = by - ay;
              const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy || 1)));
              best = Math.min(best, Math.hypot(ax + vx * t - px, ay + vy * t - py));
            }
          }
        }
        return best;
      };
      // Every room outline and cell-region loop, sampled; wherever floor meets
      // not-floor across it, the outline has to be right there.
      const missing: string[] = [];
      for (const loop of bandLoops) {
        for (let i = 0; i + 1 < loop.length; i++) {
          const a = loop[i]!;
          const b = loop[i + 1]!;
          const len = Math.hypot(b.x - a.x, b.y - a.y);
          if (len < 1e-6) continue;
          const nx = -(b.y - a.y) / len;
          const ny = (b.x - a.x) / len;
          const steps = Math.max(1, Math.ceil(len / 0.2));
          for (let k = 0; k < steps; k++) {
            const t = (k + 0.5) / steps;
            const px = a.x + (b.x - a.x) * t;
            const py = a.y + (b.y - a.y) * t;
            const inside = drawnFloorAt(dungeon, px - nx * 0.03, py - ny * 0.03);
            const outside = drawnFloorAt(dungeon, px + nx * 0.03, py + ny * 0.03);
            if (inside === outside) continue;
            const d = distToOutline(px, py);
            if (d > 0.02) missing.push(`${px.toFixed(2)},${py.toFixed(2)} is ${d.toFixed(3)} from the outline`);
          }
        }
      }
      expect(missing.slice(0, 6)).toEqual([]);
    });
  }
});

describe("a corridor running alongside a room does not extend into it", () => {
  // The one-cell extension exists so a passage meets a smooth room shape. Used
  // on a corridor that merely runs past, it lays a strip of floor over that
  // room's wall, and the fill pass erases the wall along the whole contact.
  for (const [label, dungeon] of DUNGEONS) {
    test(label, () => {
      const { grid } = dungeon;
      const offenders: string[] = [];
      for (let y = 0; y < dungeon.height; y++) {
        for (let x = 0; x < dungeon.width; x++) {
          const cell = grid[y]?.[x];
          if (cell === undefined || cell.type !== CellType.Corridor) continue;
          for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
            const n = grid[y + dy]?.[x + dx];
            if (n === undefined || n.roomId === null) continue;
            // Approaching head-on is fine; the illegal case is a corridor whose
            // own run is parallel to the wall it is being pushed through.
            if (!extendsIntoRoom(grid, x, y, dx, dy, n.roomId)) continue;
            const behind = grid[y - dy]?.[x - dx];
            if (behind === undefined || !WALKABLE.has(behind.type)) {
              offenders.push(`${x},${y} -> room ${n.roomId}`);
            }
          }
        }
      }
      expect(offenders.slice(0, 8)).toEqual([]);
    });
  }
});
