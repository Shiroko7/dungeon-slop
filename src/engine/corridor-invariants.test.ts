import { describe, test, expect } from "bun:test";
import { generateDungeon } from "./generate.ts";
import { DEFAULT_CONFIG, type DungeonConfig } from "../ai/schema.ts";
import type { Dungeon } from "./types.ts";

function cfg(o: Partial<DungeonConfig> = {}): DungeonConfig {
  return { ...DEFAULT_CONFIG, ...o };
}

/**
 * A corridor connects rooms; it is never part of one.
 *
 * No exemption for its own endpoints. A corridor runs from one room's boundary
 * to another's and meets each only at a door, so no cell it owns may belong to
 * any room at all.
 */
function roomCellsInCorridors(d: Dungeon) {
  const bad: string[] = [];
  for (const c of d.corridors) {
    for (const p of c.path) {
      const cell = d.grid[p.y]?.[p.x];
      if (cell === undefined || cell.roomId === null) continue;
      bad.push(`corridor ${c.id} (${c.roomA}->${c.roomB}) cell(${p.x},${p.y}) is room ${cell.roomId}`);
    }
  }
  return bad;
}

/** A path with a hole in it is a route through whatever fills the hole. */
function discontinuities(d: Dungeon) {
  const bad: string[] = [];
  for (const c of d.corridors) {
    for (let i = 1; i < c.path.length; i++) {
      const a = c.path[i - 1]!;
      const b = c.path[i]!;
      if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) > 1) {
        bad.push(`corridor ${c.id} (${c.roomA}->${c.roomB}) jumps (${a.x},${a.y})->(${b.x},${b.y})`);
      }
    }
  }
  return bad;
}

const CASES: Array<[string, Partial<DungeonConfig>]> = [
  ["default", {}],
  ["winding", { corridors: "Winding" }],
  ["labyrinth", { corridors: "Labyrinth" }],
  ["organic", { layout_style: "organic" }],
  ["dense small", { room_density: "Dense", room_size: "Small", grid_width: 60, grid_height: 60 }],
  ["sparse huge", { room_density: "Sparse", room_size: "Huge", grid_width: 160, grid_height: 160 }],
  ["four-way", { symmetry: "Four-Way" }],
  ["many dead ends", { dead_ends: "Many" }],
  ["no dead ends", { dead_ends: "None" }],
  ["complex", { corridor_complexity: 0.9 }],
];

describe("a corridor never occupies a room cell", () => {
  for (const [label, overrides] of CASES) {
    test(label, () => {
      for (const seed of [1, 2, 3, 7, 42]) {
        const d = generateDungeon(cfg({ ...overrides, seed }));
        const bad = roomCellsInCorridors(d);
        expect(`${label} seed=${seed}: ${bad.slice(0, 3).join("; ")}`).toBe(`${label} seed=${seed}: `);
      }
    });
  }
});

describe("a corridor path is contiguous", () => {
  for (const [label, overrides] of CASES) {
    test(label, () => {
      for (const seed of [1, 2, 3, 7, 42]) {
        const d = generateDungeon(cfg({ ...overrides, seed }));
        const bad = discontinuities(d);
        expect(`${label} seed=${seed}: ${bad.slice(0, 3).join("; ")}`).toBe(`${label} seed=${seed}: `);
      }
    });
  }
});
