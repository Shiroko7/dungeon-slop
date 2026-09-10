import { describe, test, expect } from "bun:test";
import { generateDungeon } from "./generate.ts";
import { planRoomBudget, mirrorFactor } from "./bsp.ts";
import { MAX_CORRIDOR_CELLS } from "./layout-rules.ts";
import { DEFAULT_CONFIG, type DungeonConfig } from "../ai/schema.ts";

function cfg(overrides: Partial<DungeonConfig> = {}): DungeonConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

/** Rooms the user asked for, excluding chambers the budget pass inserted. */
function realRooms(d: ReturnType<typeof generateDungeon>) {
  return d.rooms.filter((r) => r.role !== "junction");
}

describe("room size is independent of grid size", () => {
  test("the same room_size yields the same room dimensions on any grid", () => {
    const small = generateDungeon(cfg({ grid_width: 60, grid_height: 60, room_size: "Huge", seed: 7 }));
    const large = generateDungeon(cfg({ grid_width: 300, grid_height: 300, room_size: "Huge", seed: 7 }));

    const widest = (d: ReturnType<typeof generateDungeon>) =>
      Math.max(...realRooms(d).map((r) => Math.max(r.width, r.height)));

    // Huge tops out at 20 cells (100 ft) regardless of how big the map is. This
    // used to scale with the grid, so a 300-wide map produced 120-cell rooms.
    expect(widest(small)).toBeLessThanOrEqual(20);
    expect(widest(large)).toBeLessThanOrEqual(20);
  });

  test("a bigger grid produces more rooms, not bigger ones", () => {
    const small = generateDungeon(cfg({ grid_width: 60, grid_height: 60, seed: 3 }));
    const large = generateDungeon(cfg({ grid_width: 180, grid_height: 180, seed: 3 }));
    expect(realRooms(large).length).toBeGreaterThan(realRooms(small).length);
  });
});

describe("density delivers what it promises", () => {
  test("room count reaches the request when the grid has capacity", () => {
    for (const seed of [1, 2, 3, 11, 42]) {
      const config = cfg({ grid_width: 140, grid_height: 140, room_size: "Small", seed });
      const budget = planRoomBudget(config, 140, 140);
      const d = generateDungeon(config);

      expect(budget.capacity).toBeGreaterThanOrEqual(budget.requested);
      // Within one room of target: the BSP's final leaf can be unusable.
      expect(realRooms(d).length).toBeGreaterThanOrEqual(budget.target - 1);
    }
  });

  test("a shortfall is reported rather than silently swallowed", () => {
    // 40 Huge rooms will not fit on a 60x60 grid; the point is that the report
    // says so instead of quietly returning a near-empty map.
    const config = cfg({
      grid_width: 60,
      grid_height: 60,
      room_size: "Huge",
      room_density: "Exact",
      room_count: 40,
    });
    const d = generateDungeon(config);
    expect(d.report).toBeDefined();
    expect(d.report!.capacityRooms).toBeLessThan(d.report!.requestedRooms);
    expect(d.report!.deliveredRooms).toBeLessThanOrEqual(d.report!.capacityRooms);
  });
});

describe("symmetry does not multiply the requested room count", () => {
  for (const symmetry of ["None", "Horizontal", "Vertical", "Radial", "Four-Way"] as const) {
    test(`${symmetry} respects room_count`, () => {
      const config = cfg({
        symmetry,
        room_density: "Exact",
        room_count: 12,
        room_size: "Small",
        grid_width: 140,
        grid_height: 140,
        seed: 5,
      });
      const count = realRooms(generateDungeon(config)).length;
      // Mirroring can only produce whole multiples, so allow the rounding the
      // mirror factor forces - but never the old 2x/4x overshoot.
      expect(count).toBeLessThanOrEqual(12 + mirrorFactor(symmetry));
    });
  }
});

describe("corridor_complexity scales with room count, not room pairs", () => {
  test("doubling the rooms does not quadruple the corridors", () => {
    const measure = (roomCount: number) => {
      const d = generateDungeon(
        cfg({
          room_density: "Exact",
          room_count: roomCount,
          room_size: "Small",
          corridor_complexity: 0.4,
          grid_width: 160,
          grid_height: 160,
          seed: 9,
        }),
      );
      const rooms = realRooms(d).length;
      return d.corridors.length / Math.max(1, rooms);
    };

    // Corridors per room should stay roughly flat. Under the old per-pair
    // probability this ratio grew without bound as rooms increased.
    const few = measure(8);
    const many = measure(40);
    expect(many).toBeLessThan(few * 2);
  });
});

describe("corridor budget", () => {
  test("long corridors are broken by junction chambers", () => {
    const config = cfg({
      grid_width: 180,
      grid_height: 180,
      room_size: "Huge",
      room_density: "Sparse",
      seed: 4,
    });
    const d = generateDungeon(config);

    expect(d.report!.junctionsAdded).toBeGreaterThan(0);

    // Every corridor joining two real rooms should be inside budget. Entry
    // corridors and dead-end stubs (roomB === -1) have nothing to rejoin, so
    // they are exempt by design.
    const overBudget = d.corridors.filter(
      (c) => c.roomA >= 0 && c.roomB >= 0 && c.path.length > MAX_CORRIDOR_CELLS * 1.5,
    );
    expect(overBudget.length).toBe(0);
  });

  test("junction chambers are reachable, not sealed in rock", () => {
    // A chamber placed on a stretch that collapseDeadEnds already walled off
    // would be carved into solid rock with nothing joining it.
    for (const seed of [14009, 98999, 42, 7]) {
      const d = generateDungeon(
        cfg({ layout_style: "organic", corridors: "Winding", dead_ends: "None", seed }),
      );
      for (const room of d.rooms) {
        if (room.role !== "junction") continue;
        const touching = d.corridors.filter((c) => c.roomA === room.id || c.roomB === room.id);
        expect(touching.length).toBeGreaterThanOrEqual(2);
      }
    }
  });
});

describe("layout semantics", () => {
  test("every room gets a role and a depth", () => {
    const d = generateDungeon(cfg({ seed: 21 }));
    for (const room of d.rooms) {
      expect(room.role).toBeDefined();
      expect(room.tier).not.toBeUndefined();
    }
  });

  test("there is exactly one entrance and one boss, and the boss is deepest", () => {
    const d = generateDungeon(cfg({ seed: 21 }));
    const entrances = d.rooms.filter((r) => r.role === "entrance");
    const bosses = d.rooms.filter((r) => r.role === "boss");

    expect(entrances.length).toBe(1);
    expect(bosses.length).toBe(1);
    expect(entrances[0]!.tier).toBe(0);

    const deepest = Math.max(...d.rooms.map((r) => r.tier ?? 0));
    expect(bosses[0]!.tier).toBe(deepest);
  });

  test("the critical path runs unbroken from entrance to boss", () => {
    const d = generateDungeon(cfg({ seed: 21 }));
    const critical = d.rooms.filter((r) => r.onCriticalPath === true);
    const tiers = critical.map((r) => r.tier ?? -1).sort((a, b) => a - b);

    // One room per depth, from 0 up to the boss, with no gaps.
    expect(tiers[0]).toBe(0);
    tiers.forEach((tier, i) => expect(tier).toBe(i));
  });

  test("the map contains a loop rather than being a pure tree", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const d = generateDungeon(cfg({ corridor_complexity: 0, seed }));
      expect(d.report!.hasLoop).toBe(true);
    }
  });
});
