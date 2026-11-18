import { describe, test, expect } from "bun:test";
import { generateFromBlueprint, generateDungeon } from "./generate.ts";
import { normalizeBlueprint, type Blueprint } from "../ai/blueprint.ts";
import { applyRefineOps, blueprintFromDungeon, type RefineOp } from "./refine-ops.ts";
import { MAX_CORRIDOR_CELLS } from "./layout-rules.ts";
import { DEFAULT_CONFIG } from "../ai/schema.ts";
import { CellType, FeatureType } from "./types.ts";
import { moonCycle, ringOf } from "./radial-fixtures.ts";

/** A small plan with a hub, two wings, a gate and a loop. */
function plan(): Blueprint {
  return {
    name: "Test Hold",
    nodes: [
      { key: "gate", name: "Outer Gate", role: "entrance", tier: 0, size: "Medium" },
      { key: "hall", name: "Great Hall", role: "gauntlet", tier: 1, size: "Large" },
      { key: "landing", name: "The Landing", role: "hub", tier: 2, size: "Medium" },
      { key: "east-1", name: "East Cells", role: "gauntlet", tier: 3, wing: "east", size: "Small" },
      { key: "east-2", name: "East Shrine", role: "vault", tier: 4, wing: "east", size: "Small" },
      { key: "west-1", name: "West Forge", role: "gauntlet", tier: 3, wing: "west", size: "Medium" },
      { key: "warden", name: "Warden's Gate", role: "chokepoint", tier: 4, size: "Small" },
      { key: "throne", name: "The Throne", role: "boss", tier: 5, size: "Huge" },
    ],
    edges: [
      { from: "gate", to: "hall" },
      { from: "hall", to: "landing" },
      { from: "landing", to: "east-1" },
      { from: "east-1", to: "east-2" },
      { from: "landing", to: "west-1" },
      { from: "west-1", to: "warden", gating: "the Forge key" },
      { from: "warden", to: "throne" },
      { from: "east-1", to: "west-1" },
    ],
  };
}

const config = { ...DEFAULT_CONFIG, seed: 11 };

describe("blueprint normalization repairs rather than rejects", () => {
  test("a duplicate key is renamed, not dropped", () => {
    const input = plan();
    input.nodes.push({ ...input.nodes[1]!, name: "Second Hall" });
    const { blueprint, problems } = normalizeBlueprint(input);
    expect(blueprint.nodes.length).toBe(input.nodes.length);
    expect(new Set(blueprint.nodes.map((n) => n.key)).size).toBe(blueprint.nodes.length);
    expect(problems.some((p) => p.message.includes("Duplicate"))).toBe(true);
  });

  test("an edge to an undeclared room is dropped", () => {
    const input = plan();
    input.edges.push({ from: "gate", to: "nowhere" });
    const { blueprint, problems } = normalizeBlueprint(input);
    expect(blueprint.edges.some((e) => e.to === "nowhere")).toBe(false);
    expect(problems.some((p) => p.message.includes("undeclared"))).toBe(true);
  });

  test("a plan with no entrance gets one", () => {
    const input = plan();
    for (const node of input.nodes) if (node.role === "entrance") node.role = "chamber";
    const { blueprint } = normalizeBlueprint(input);
    const entrances = blueprint.nodes.filter((n) => n.role === "entrance");
    expect(entrances.length).toBe(1);
    expect(entrances[0]!.tier).toBe(0);
  });

  test("a boss shallower than the deepest room is pushed past it", () => {
    const input = plan();
    input.nodes.find((n) => n.key === "throne")!.tier = 1;
    const { blueprint } = normalizeBlueprint(input);
    const boss = blueprint.nodes.find((n) => n.role === "boss")!;
    const deepest = Math.max(...blueprint.nodes.map((n) => n.tier));
    expect(boss.tier).toBe(deepest);
  });

  test("an unreachable room is joined rather than abandoned", () => {
    const input = plan();
    input.edges = input.edges.filter((e) => e.to !== "east-1" && e.from !== "east-1");
    const { blueprint, problems } = normalizeBlueprint(input);
    expect(problems.some((p) => p.message.includes("unreachable"))).toBe(true);
    expect(blueprint.edges.some((e) => e.from === "east-1" || e.to === "east-1")).toBe(true);
  });
});

describe("a blueprint becomes the map it describes", () => {
  const dungeon = generateFromBlueprint(normalizeBlueprint(plan()).blueprint, config);
  const real = dungeon.rooms.filter((r) => r.role !== "junction");

  test("every planned room is built, and named", () => {
    expect(real.length).toBe(8);
    const names = real.map((r) => r.plan?.name);
    expect(names).toContain("The Throne");
    expect(names).toContain("West Forge");
  });

  test("rooms do not overlap", () => {
    for (let i = 0; i < real.length; i++) {
      for (let j = i + 1; j < real.length; j++) {
        const a = real[i]!;
        const b = real[j]!;
        const apart =
          a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
        expect(apart).toBe(true);
      }
    }
  });

  test("the entrance sits below the boss, so depth reads as depth", () => {
    const entrance = real.find((r) => r.role === "entrance")!;
    const boss = real.find((r) => r.role === "boss")!;
    expect(entrance.centerY).toBeGreaterThan(boss.centerY);
  });

  test("wings are placed apart from each other", () => {
    const east = real.filter((r) => r.plan?.wing === "east");
    const west = real.filter((r) => r.plan?.wing === "west");
    const mean = (rooms: typeof east) => rooms.reduce((s, r) => s + r.centerX, 0) / rooms.length;
    expect(Math.abs(mean(east) - mean(west))).toBeGreaterThan(8);
  });

  test("planned connections are the connections that got built", () => {
    const byKey = new Map(real.map((r) => [r.plan!.key, r]));
    const hub = byKey.get("landing")!;
    // Through junctions where the budget pass inserted them.
    const reached = new Set<string>();
    const walk = (id: number, depth: number) => {
      if (depth > 2) return;
      for (const next of dungeon.rooms.find((r) => r.id === id)?.connections ?? []) {
        const room = dungeon.rooms.find((r) => r.id === next);
        if (room === undefined) continue;
        if (room.role === "junction") walk(room.id, depth + 1);
        else if (room.plan !== undefined) reached.add(room.plan.key);
      }
    };
    walk(hub.id, 0);
    expect(reached.has("east-1")).toBe(true);
    expect(reached.has("west-1")).toBe(true);
  });

  test("gating from the plan reaches the room", () => {
    const warden = real.find((r) => r.plan?.key === "warden")!;
    expect(warden.plan?.gating).toContain("the Forge key");
  });

  test("constraint report distinguishes delivered graph from unmet requirements", () => {
    expect(dungeon.report?.constraints?.requestedConnections).toBeGreaterThan(0);
    expect(dungeon.report?.constraints?.deliveredConnections).toBe(
      dungeon.report?.constraints?.requestedConnections,
    );
    expect(dungeon.report?.constraints?.unmetConnections).toHaveLength(0);
    expect(dungeon.report?.constraints?.reachableRooms).toBe(plan().nodes.length);
    expect(dungeon.report?.constraints?.unreachableRooms).toHaveLength(0);
    expect(dungeon.report?.constraints?.unmetRequirements).toEqual([]);
  });

  test("a gated edge gets a locked door on the gated side", () => {
    const warden = real.find((r) => r.plan?.key === "warden")!;
    const gate = dungeon.features.find((f) => f.metadata?.gating === "the Forge key");
    expect(gate?.type).toBe(FeatureType.LockedDoor);
    const touchesWarden = ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const).some(
      ([dx, dy]) => dungeon.grid[gate!.y + dy]?.[gate!.x + dx]?.roomId === warden.id,
    );
    expect(touchesWarden).toBe(true);
    expect(dungeon.grid[gate!.y]![gate!.x]!.type).toBe(CellType.Door);
  });

  test("corridors stay inside budget", () => {
    const over = dungeon.corridors.filter(
      (c) => c.roomA >= 0 && c.roomB >= 0 && c.path.length > MAX_CORRIDOR_CELLS * 1.5,
    );
    expect(over.length).toBe(0);
  });

  test("the same plan and seed build the same map", () => {
    const again = generateFromBlueprint(normalizeBlueprint(plan()).blueprint, config);
    expect(again.rooms.map((r) => `${r.x},${r.y},${r.width}`)).toEqual(
      dungeon.rooms.map((r) => `${r.x},${r.y},${r.width}`),
    );
  });
});

describe("recovering a plan from a map built without one", () => {
  test("a procedural dungeon yields a connected plan", () => {
    const d = generateDungeon({ ...DEFAULT_CONFIG, seed: 5 });
    const recovered = blueprintFromDungeon(d);

    expect(recovered.nodes.length).toBe(d.rooms.filter((r) => r.role !== "junction").length);
    expect(recovered.nodes.some((n) => n.role === "entrance")).toBe(true);
    expect(recovered.nodes.some((n) => n.role === "boss")).toBe(true);

    // The recovered plan must survive normalization without being told anything
    // is unreachable — junction chambers have to be bridged, not dropped.
    const { problems } = normalizeBlueprint(recovered);
    expect(problems.filter((p) => p.message.includes("unreachable")).length).toBe(0);
  });
});

describe("refine ops", () => {
  const base = normalizeBlueprint(plan()).blueprint;

  test("a rename lands", () => {
    const ops: RefineOp[] = [{ op: "rename_room", key: "hall", name: "Hall of Ash" }];
    const { blueprint, results } = applyRefineOps(base, ops);
    expect(results[0]!.applied).toBe(true);
    expect(blueprint.nodes.find((n) => n.key === "hall")!.name).toBe("Hall of Ash");
  });

  test("an op naming a room that does not exist is refused, not fatal", () => {
    const ops: RefineOp[] = [
      { op: "rename_room", key: "ghost", name: "Nowhere" },
      { op: "resize_room", key: "throne", size: "Large" },
    ];
    const { blueprint, results } = applyRefineOps(base, ops);
    expect(results[0]!.applied).toBe(false);
    expect(results[1]!.applied).toBe(true);
    expect(blueprint.nodes.find((n) => n.key === "throne")!.size).toBe("Large");
  });

  test("a disconnect that would strand a room is refused", () => {
    const ops: RefineOp[] = [{ op: "disconnect", from: "east-1", to: "east-2" }];
    const { blueprint, results } = applyRefineOps(base, ops);
    expect(results[0]!.applied).toBe(false);
    expect(results[0]!.note).toContain("strand");
    expect(blueprint.edges.length).toBe(base.edges.length);
  });

  test("a disconnect that leaves everything reachable is allowed", () => {
    // east-1 <-> west-1 is the loop edge; cutting it strands nothing.
    const ops: RefineOp[] = [{ op: "disconnect", from: "east-1", to: "west-1" }];
    const { results } = applyRefineOps(base, ops);
    expect(results[0]!.applied).toBe(true);
  });

  test("locked rooms and connections survive refinement", () => {
    const locked = {
      ...base,
      nodes: base.nodes.map((node) => node.key === "hall" ? { ...node, locked: true } : node),
      edges: base.edges.map((edge) => edge.from === "east-1" && edge.to === "west-1" ? { ...edge, locked: true } : edge),
    };
    const { blueprint, results } = applyRefineOps(locked, [
      { op: "rename_room", key: "hall", name: "Changed" },
      { op: "disconnect", from: "east-1", to: "west-1" },
    ]);
    expect(results.every((result) => !result.applied)).toBe(true);
    expect(blueprint.nodes.find((node) => node.key === "hall")!.name).toBe("Great Hall");
    expect(blueprint.edges.some((edge) => edge.from === "east-1" && edge.to === "west-1")).toBe(true);
  });

  test("removing the entrance or the boss is refused", () => {
    const { results } = applyRefineOps(base, [
      { op: "remove_room", key: "gate" },
      { op: "remove_room", key: "throne" },
    ]);
    expect(results.every((r) => !r.applied)).toBe(true);
  });

  test("granting a unique role takes it from the previous holder", () => {
    const { blueprint } = applyRefineOps(base, [{ op: "set_role", key: "hall", role: "boss" }]);
    expect(blueprint.nodes.filter((n) => n.role === "boss").length).toBe(1);
    expect(blueprint.nodes.find((n) => n.key === "hall")!.role).toBe("boss");
  });

  test("an added room arrives connected", () => {
    const { blueprint, results } = applyRefineOps(base, [
      {
        op: "add_room",
        key: "cistern",
        name: "The Cistern",
        role: "vault",
        tier: 3,
        size: "Small",
        connectTo: ["landing"],
      },
    ]);
    expect(results[0]!.applied).toBe(true);
    expect(blueprint.edges.some((e) => e.from === "landing" && e.to === "cistern")).toBe(true);
  });

  test("a refined plan still builds", () => {
    const { blueprint } = applyRefineOps(base, [
      { op: "rename_room", key: "hall", name: "Hall of Ash" },
      { op: "add_room", key: "cistern", name: "The Cistern", role: "vault", tier: 3, size: "Small", connectTo: ["landing"] },
      { op: "disconnect", from: "east-1", to: "west-1" },
      { op: "set_role", key: "east-2", role: "vault" },
    ]);
    const built = generateFromBlueprint(normalizeBlueprint(blueprint).blueprint, config);
    expect(built.rooms.filter((r) => r.role !== "junction").length).toBe(9);
    expect(built.report!.deliveredRooms).toBe(9);
  });
});

describe("radial plans", () => {
  test("doorWidth widens each doorway in place: one door feature spanning the cells", () => {
    const narrow = generateFromBlueprint(normalizeBlueprint(moonCycle()).blueprint, { ...DEFAULT_CONFIG, seed: 1 });
    const wide = generateFromBlueprint(normalizeBlueprint({ ...moonCycle(), doorWidth: 2 }).blueprint, { ...DEFAULT_CONFIG, seed: 1 });
    expect(wide.report!.constraints!.deliveredConnections).toBe(wide.report!.constraints!.requestedConnections);
    expect(wide.rooms.map((r) => [r.x, r.y, r.width, r.height])).toEqual(narrow.rooms.map((r) => [r.x, r.y, r.width, r.height]));
    const cellsOf = (d: typeof wide, id: number) => d.grid.flat().filter((c) => c.featureId === id).length;
    const doors = (d: typeof wide) => d.features.filter((f) => f.type === FeatureType.Door || f.type === FeatureType.Portcullis);
    expect(doors(wide)).toHaveLength(doors(narrow).length);
    for (const f of doors(wide)) expect(cellsOf(wide, f.id)).toBe(2);
    for (const f of doors(narrow)) expect(cellsOf(narrow, f.id)).toBe(1);
  });

  test("a wider gap makes channels crossed by short corridors, every edge still joined", () => {
    for (const plan of [moonCycle(), ringOf(5)]) {
      const wide = generateFromBlueprint(normalizeBlueprint({ ...plan, gap: 2.5 }).blueprint, { ...DEFAULT_CONFIG, seed: 3 });
      const c = wide.report!.constraints!;
      expect(c.deliveredConnections).toBe(c.requestedConnections);
      const crossings = wide.corridors.filter((c) => c.path.length > 1);
      expect(crossings.length).toBeGreaterThan(0);
      // Neighbouring rooms no longer touch through a single cell.
      expect(wide.corridors.every((c) => c.path.length >= 2 || c.roomA < 0 || c.roomB < 0)).toBe(true);
    }
    expect(normalizeBlueprint({ ...moonCycle(), gap: 3 }).blueprint.gap).toBe(3);
  });

  test("normalization keeps the layout and gives every room a ring", () => {
    const input = moonCycle();
    for (const node of input.nodes) delete node.ring;
    const { blueprint, problems } = normalizeBlueprint(input);
    expect(blueprint.layout).toBe("radial");
    expect(blueprint.nodes.filter((n) => n.ring === 0).map((n) => n.key)).toEqual(["vigil"]);
    expect(blueprint.nodes.filter((n) => n.ring === 1)).toHaveLength(4);
    expect(problems.some((p) => p.message.includes("centre"))).toBe(true);
  });

  test("a second centre room and a lone outer slice are repaired", () => {
    const input = ringOf(4);
    input.nodes[1]!.ring = 0;
    input.nodes[2]!.ring = 3;
    const { blueprint } = normalizeBlueprint(input);
    expect(blueprint.nodes.filter((n) => n.ring === 0)).toHaveLength(1);
    expect(blueprint.nodes.every((n) => n.ring === 0 || n.ring === 1)).toBe(true);
  });

  const moon = generateFromBlueprint(normalizeBlueprint(moonCycle()).blueprint, { ...DEFAULT_CONFIG, seed: 1 });
  const byKey = (key: string) => moon.rooms.find((r) => r.plan?.key === key)!;

  test("the centre is round and the rest are slices, clockwise from twelve", () => {
    expect(byKey("vigil").shape).toBe("Circular");
    const slices = ["unveiling", "shards", "table", "cradle"].map(byKey);
    expect(slices.every((r) => r.shape === "Sector" && r.sector !== undefined)).toBe(true);
    const [ne, se, sw, nw] = slices;
    const c = byKey("vigil");
    expect(ne!.centerX > c.centerX && ne!.centerY < c.centerY).toBe(true);
    expect(se!.centerX > c.centerX && se!.centerY > c.centerY).toBe(true);
    expect(sw!.centerX < c.centerX && sw!.centerY > c.centerY).toBe(true);
    expect(nw!.centerX < c.centerX && nw!.centerY < c.centerY).toBe(true);
  });

  test("each planned edge is one door in a shared wall", () => {
    for (const edge of moonCycle().edges) {
      const a = byKey(edge.from);
      const b = byKey(edge.to);
      const corridor = moon.corridors.find(
        (c) => (c.roomA === a.id && c.roomB === b.id) || (c.roomA === b.id && c.roomB === a.id),
      );
      expect(corridor?.path).toHaveLength(1);
    }
    // The Cradle touches three rooms but the plan joins it only to the centre.
    expect(byKey("cradle").connections).toEqual([byKey("vigil").id]);
  });

  test("door types and gates land on the edges that asked for them", () => {
    const portcullis = moon.features.find((f) => f.metadata?.edge === "vigil -> unveiling");
    expect(portcullis?.type).toBe(FeatureType.Portcullis);
    const seal = moon.features.find((f) => f.metadata?.edge === "vigil -> cradle");
    expect(seal?.type).toBe(FeatureType.LockedDoor);
    expect(seal?.metadata?.gating).toBe("all four phases of the moon");
    expect(moon.report?.constraints?.unmetRequirements).toEqual([]);
  });

  test("an unknown door type is drawn as a door and reported", () => {
    const input = moonCycle();
    input.edges[1]!.door = "moonlight";
    const d = generateFromBlueprint(normalizeBlueprint(input).blueprint, { ...DEFAULT_CONFIG, seed: 1 });
    expect(d.report?.constraints?.unmetRequirements.some((m) => m.includes("moonlight"))).toBe(true);
    expect(d.features.find((f) => f.metadata?.edge === "unveiling -> shards")?.type).toBe(FeatureType.Door);
  });

  test("an Open door preference leaves a bare doorway", () => {
    const input = moonCycle();
    input.edges[1]!.door = "Open";
    const d = generateFromBlueprint(normalizeBlueprint(input).blueprint, { ...DEFAULT_CONFIG, seed: 1 });
    const a = d.rooms.find((r) => r.plan?.key === "unveiling")!;
    const b = d.rooms.find((r) => r.plan?.key === "shards")!;
    const corridor = d.corridors.find((c) => c.roomA === a.id && c.roomB === b.id)!;
    const cell = d.grid[corridor.path[0]!.y]![corridor.path[0]!.x]!;
    expect(cell.type).toBe(CellType.Corridor);
    expect(cell.featureId).toBeNull();
  });

  test("scale 2 builds the same plan twice as big across", () => {
    const big = generateFromBlueprint(normalizeBlueprint({ ...moonCycle(), scale: 2 }).blueprint, { ...DEFAULT_CONFIG, seed: 1 });
    const outer = (d: typeof moon) => d.rooms.find((r) => r.sector !== undefined)!.sector!.outerRadius;
    expect(outer(big) / outer(moon)).toBeGreaterThan(1.8);
    expect(outer(big) / outer(moon)).toBeLessThan(2.2);
    expect(big.report?.constraints?.unmetConnections).toEqual([]);
    expect(normalizeBlueprint({ ...moonCycle(), scale: 2 }).blueprint.scale).toBe(2);
  });

  test("the same plan and seed build the same map", () => {
    const again = generateFromBlueprint(normalizeBlueprint(moonCycle()).blueprint, { ...DEFAULT_CONFIG, seed: 1 });
    expect(JSON.stringify(again.grid)).toBe(JSON.stringify(moon.grid));
  });
});
