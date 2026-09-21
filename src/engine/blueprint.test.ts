import { describe, test, expect } from "bun:test";
import { generateFromBlueprint, generateDungeon } from "./generate.ts";
import { normalizeBlueprint, type Blueprint } from "../ai/blueprint.ts";
import { applyRefineOps, blueprintFromDungeon, type RefineOp } from "./refine-ops.ts";
import { MAX_CORRIDOR_CELLS } from "./layout-rules.ts";
import { DEFAULT_CONFIG } from "../ai/schema.ts";

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

  test("constraint report distinguishes delivered graph from advisory requirements", () => {
    expect(dungeon.report?.constraints?.requestedConnections).toBeGreaterThan(0);
    expect(dungeon.report?.constraints?.deliveredConnections).toBe(
      dungeon.report?.constraints?.requestedConnections,
    );
    expect(dungeon.report?.constraints?.unmetConnections).toHaveLength(0);
    expect(dungeon.report?.constraints?.reachableRooms).toBe(plan().nodes.length);
    expect(dungeon.report?.constraints?.unreachableRooms).toHaveLength(0);
    expect(dungeon.report?.constraints?.unmetRequirements.some((item) => item.includes("Forge key"))).toBe(true);
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
