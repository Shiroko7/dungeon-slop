import { describe, expect, test } from "bun:test";
import { generateDungeon } from "../engine/generate.ts";
import { DEFAULT_CONFIG, type DungeonConfig } from "../ai/schema.ts";
import { FeatureType, type Dungeon } from "../engine/types.ts";
import { dungeonToUVTT, isSolid, type UVTTMap, type UVTTPoint } from "./uvtt.ts";

// Invariants, not snapshots: every one must hold for every generated map, so a
// table that trusts the walls never lets a token see or walk through stone.

const CONFIGS: Array<Partial<DungeonConfig>> = [
  { seed: 1 },
  { seed: 2, corridors: "Winding", door_types: ["Standard", "Secret", "Locked"] },
  { seed: 3, layout_style: "organic" },
  { seed: 4, corridors: "Labyrinth", dead_ends: "Many", door_types: ["Portcullis", "Trapped", "Archway"] },
  { seed: 5, room_size: "Large", grid_width: 60, grid_height: 40 },
  { seed: 6, room_shapes: ["Circular", "Cave", "Cross"], door_types: ["Open"] },
];

const maps: Array<[string, Dungeon, UVTTMap]> = CONFIGS.map((over) => {
  const d = generateDungeon({ ...DEFAULT_CONFIG, grid_width: 50, grid_height: 50, ...over });
  return [`seed ${over.seed}`, d, dungeonToUVTT(d)];
});

const solidAt = (d: Dungeon, x: number, y: number) => isSolid(d.grid[y]?.[x]?.type ?? 0);

/** Unit edges covered by the wall segments, as "x,y,h" (h: horizontal edge on row y) or "x,y,v". */
function wallEdges(uvtt: UVTTMap): Set<string> {
  const edges = new Set<string>();
  for (const [a, b] of uvtt.line_of_sight as [UVTTPoint, UVTTPoint][]) {
    if (a.y === b.y) for (let x = Math.min(a.x, b.x); x < Math.max(a.x, b.x); x++) edges.add(`${x},${a.y},h`);
    else for (let y = Math.min(a.y, b.y); y < Math.max(a.y, b.y); y++) edges.add(`${a.x},${y},v`);
  }
  return edges;
}

describe("Universal VTT export: invariants", () => {
  for (const [label, d, uvtt] of maps) {
    test(`${label}: walls are axis-aligned, on the grid and inside the map`, () => {
      for (const seg of uvtt.line_of_sight) {
        expect(seg).toHaveLength(2);
        const [a, b] = seg as [UVTTPoint, UVTTPoint];
        expect(a.x === b.x || a.y === b.y).toBe(true);
        for (const p of [a, b]) {
          expect(Number.isInteger(p.x) && Number.isInteger(p.y)).toBe(true);
          expect(p.x >= 0 && p.x <= d.width && p.y >= 0 && p.y <= d.height).toBe(true);
        }
      }
    });

    test(`${label}: a wall stands on every edge between floor and stone, and nowhere else`, () => {
      const edges = wallEdges(uvtt);
      const expected = new Set<string>();
      for (let y = 0; y <= d.height; y++) for (let x = 0; x < d.width; x++) {
        if (solidAt(d, x, y - 1) !== solidAt(d, x, y)) expected.add(`${x},${y},h`);
      }
      for (let x = 0; x <= d.width; x++) for (let y = 0; y < d.height; y++) {
        if (solidAt(d, x - 1, y) !== solidAt(d, x, y)) expected.add(`${x},${y},v`);
      }
      expect([...edges].filter((e) => !expected.has(e))).toEqual([]);
      expect([...expected].filter((e) => !edges.has(e))).toEqual([]);
    });

    // Only for ordinary doorways: open on two opposite sides, stone on the
    // other two. The generator also makes junction doors (a corridor hugging a
    // room's edge turns each cell beside the room into a door), whose cells are
    // open on three sides; no single line closes those wall to wall.
    test(`${label}: every ordinary door closes its doorway from wall to wall`, () => {
      const edges = wallEdges(uvtt);
      const onWall = (p: UVTTPoint) =>
        Number.isInteger(p.y) ? edges.has(`${Math.floor(p.x)},${p.y},h`) : edges.has(`${p.x},${Math.floor(p.y)},v`);
      let checked = 0;
      for (const portal of uvtt.portals) {
        expect(portal.closed).toBe(true);
        const [a, b] = portal.bounds;
        const cells = new Set<string>();
        // The cells the door line passes through.
        for (let t = 0.25; t < 1; t += 0.5) {
          cells.add(`${Math.floor(a.x + (b.x - a.x) * t)},${Math.floor(a.y + (b.y - a.y) * t)}`);
        }
        const ordinary = [...cells].every((key) => {
          const [x, y] = key.split(",").map(Number) as [number, number];
          const ew = !solidAt(d, x - 1, y) && !solidAt(d, x + 1, y);
          const sidesNS = solidAt(d, x, y - 1) && solidAt(d, x, y + 1);
          const ns = !solidAt(d, x, y - 1) && !solidAt(d, x, y + 1);
          const sidesEW = solidAt(d, x - 1, y) && solidAt(d, x + 1, y);
          return (ew && sidesNS) || (ns && sidesEW);
        });
        if (cells.size !== 1 || !ordinary) continue;
        checked++;
        expect(onWall(a) && onWall(b)).toBe(true);
      }
      if (uvtt.portals.length > 0) expect(checked).toBeGreaterThan(0);
    });

    test(`${label}: one portal per door, none for archways`, () => {
      const doors = d.features.filter((f) =>
        [FeatureType.Door, FeatureType.LockedDoor, FeatureType.SecretDoor, FeatureType.TrappedDoor, FeatureType.Portcullis].includes(f.type));
      expect(uvtt.portals).toHaveLength(doors.length);
    });

    test(`${label}: floor mask and room labels match the grid`, () => {
      expect(uvtt.x_slop.floor).toHaveLength(d.height);
      for (const [y, row] of uvtt.x_slop.floor.entries()) {
        expect(row).toHaveLength(d.width);
        for (let x = 0; x < d.width; x++) expect(row[x] === "#").toBe(solidAt(d, x, y));
      }
      expect(uvtt.x_slop.rooms.map((r) => r.id).sort((a, b) => a - b)).toEqual(d.rooms.map((r) => r.id).sort((a, b) => a - b));
      expect(uvtt.resolution.map_size).toEqual({ x: d.width, y: d.height });
      expect(uvtt.image).toBe("");
    });
  }
});
