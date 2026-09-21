import { z } from "zod";
import { BlueprintRoleEnum, type Blueprint, type BlueprintNode } from "../ai/blueprint.ts";
import type { Dungeon } from "./types.ts";

/**
 * Edits a critic may make to a floor plan.
 *
 * Every op rewrites the BLUEPRINT, never the carved grid. That is the whole
 * safety argument: re-solving a plan runs the same placement and carving passes
 * that already guarantee non-overlap, connectivity and corridor budget, so a
 * bad suggestion produces a worse dungeon rather than a broken one. Patching
 * cells directly would put a language model's arithmetic in charge of grid
 * invariants, which is precisely the thing it is worst at.
 */

export const RefineOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("move_room"),
    key: z.string(),
    /** Tiers to shift by. Negative is shallower (closer to the entrance). */
    tierDelta: z.number().int().min(-10).max(10),
    reason: z.string().max(300).optional(),
  }),
  z.object({
    op: z.literal("resize_room"),
    key: z.string(),
    size: z.enum(["Tiny", "Small", "Medium", "Large", "Huge"]),
    reason: z.string().max(300).optional(),
  }),
  z.object({
    op: z.literal("set_role"),
    key: z.string(),
    role: BlueprintRoleEnum,
    reason: z.string().max(300).optional(),
  }),
  z.object({
    op: z.literal("rename_room"),
    key: z.string(),
    name: z.string().min(1).max(80),
    reason: z.string().max(300).optional(),
  }),
  z.object({
    op: z.literal("set_wing"),
    key: z.string(),
    wing: z.string().max(60).nullable(),
    reason: z.string().max(300).optional(),
  }),
  z.object({
    op: z.literal("connect"),
    from: z.string(),
    to: z.string(),
    gating: z.string().max(200).optional(),
    reason: z.string().max(300).optional(),
  }),
  z.object({
    op: z.literal("disconnect"),
    from: z.string(),
    to: z.string(),
    reason: z.string().max(300).optional(),
  }),
  z.object({
    op: z.literal("remove_room"),
    key: z.string(),
    reason: z.string().max(300).optional(),
  }),
  z.object({
    op: z.literal("add_room"),
    key: z.string().min(1).max(60),
    name: z.string().min(1).max(80),
    role: BlueprintRoleEnum,
    tier: z.number().int().min(0).max(40),
    size: z.enum(["Tiny", "Small", "Medium", "Large", "Huge"]).default("Medium"),
    wing: z.string().max(60).optional(),
    notes: z.string().max(400).optional(),
    connectTo: z.array(z.string()).min(1),
    reason: z.string().max(300).optional(),
  }),
]);

export const RefineResponseSchema = z.object({
  /** What the critic thinks is wrong, in its own words. */
  critique: z.string().max(4000).optional(),
  ops: z.array(RefineOpSchema).max(40),
});

export type RefineOp = z.infer<typeof RefineOpSchema>;
export type RefineResponse = z.infer<typeof RefineResponseSchema>;

export interface AppliedOp {
  op: RefineOp;
  applied: boolean;
  /** Why it was refused, when it was. */
  note?: string;
}

/** Human-readable one-liner for the review list. */
export function describeOp(op: RefineOp): string {
  switch (op.op) {
    case "move_room":
      return `Move "${op.key}" ${op.tierDelta > 0 ? "deeper" : "shallower"} by ${Math.abs(op.tierDelta)} tier(s)`;
    case "resize_room":
      return `Resize "${op.key}" to ${op.size}`;
    case "set_role":
      return `Make "${op.key}" a ${op.role}`;
    case "rename_room":
      return `Rename "${op.key}" to "${op.name}"`;
    case "set_wing":
      return op.wing === null ? `Remove "${op.key}" from its wing` : `Move "${op.key}" into wing "${op.wing}"`;
    case "connect":
      return `Connect "${op.from}" to "${op.to}"${op.gating !== undefined ? ` (gated: ${op.gating})` : ""}`;
    case "disconnect":
      return `Disconnect "${op.from}" from "${op.to}"`;
    case "remove_room":
      return `Remove "${op.key}"`;
    case "add_room":
      return `Add "${op.name}" (${op.role}, tier ${op.tier})`;
  }
}

function cloneBlueprint(blueprint: Blueprint): Blueprint {
  return {
    name: blueprint.name,
    nodes: blueprint.nodes.map((n) => ({ ...n })),
    edges: blueprint.edges.map((e) => ({ ...e })),
    grounding: blueprint.grounding,
  };
}

/**
 * Apply a critic's ops to a plan.
 *
 * Refusals are individual: one impossible op does not discard the other nine.
 * The caller gets a per-op record so the user can see what actually happened
 * rather than trusting that the suggestion list was the change list.
 */
export function applyRefineOps(
  blueprint: Blueprint,
  ops: RefineOp[],
): { blueprint: Blueprint; results: AppliedOp[] } {
  const next = cloneBlueprint(blueprint);
  const results: AppliedOp[] = [];

  const find = (key: string): BlueprintNode | undefined => next.nodes.find((n) => n.key === key);
  const edgeIndex = (a: string, b: string) =>
    next.edges.findIndex(
      (e) => (e.from === a && e.to === b) || (e.from === b && e.to === a),
    );
  const lockedEdge = (a: string, b: string): boolean => {
    const index = edgeIndex(a, b);
    return index >= 0 && next.edges[index]?.locked === true;
  };

  for (const op of ops) {
    const refuse = (note: string) => results.push({ op, applied: false, note });
    const accept = () => results.push({ op, applied: true });

    switch (op.op) {
      case "move_room": {
        const node = find(op.key);
        if (node === undefined) { refuse("No such room"); break; }
        if (node.locked) { refuse("Room is locked by the user"); break; }
        if (node.role === "entrance") { refuse("The entrance is always tier 0"); break; }
        node.tier = Math.max(1, node.tier + op.tierDelta);
        accept();
        break;
      }
      case "resize_room": {
        const node = find(op.key);
        if (node === undefined) { refuse("No such room"); break; }
        if (node.locked) { refuse("Room is locked by the user"); break; }
        node.size = op.size;
        accept();
        break;
      }
      case "set_role": {
        const node = find(op.key);
        if (node === undefined) { refuse("No such room"); break; }
        if (node.locked) { refuse("Room is locked by the user"); break; }
        // Entrance and boss are unique, so taking the role means giving up the
        // old holder's - otherwise normalize would silently demote one of them.
        if (op.role === "entrance" || op.role === "boss") {
          if (next.nodes.some((other) => other.key !== node.key && other.role === op.role && other.locked)) {
            refuse(`The existing ${op.role} is locked by the user`);
            break;
          }
          for (const other of next.nodes) {
            if (other.key !== node.key && other.role === op.role) other.role = "chamber";
          }
        }
        node.role = op.role;
        accept();
        break;
      }
      case "rename_room": {
        const node = find(op.key);
        if (node === undefined) { refuse("No such room"); break; }
        if (node.locked) { refuse("Room is locked by the user"); break; }
        node.name = op.name;
        accept();
        break;
      }
      case "set_wing": {
        const node = find(op.key);
        if (node === undefined) { refuse("No such room"); break; }
        if (node.locked) { refuse("Room is locked by the user"); break; }
        if (op.wing === null) delete node.wing;
        else node.wing = op.wing;
        accept();
        break;
      }
      case "connect": {
        if (find(op.from) === undefined || find(op.to) === undefined) { refuse("Unknown room"); break; }
        if (op.from === op.to) { refuse("A room cannot join itself"); break; }
        if (edgeIndex(op.from, op.to) !== -1) { refuse("Already connected"); break; }
        next.edges.push({ from: op.from, to: op.to, ...(op.gating !== undefined ? { gating: op.gating } : {}) });
        accept();
        break;
      }
      case "disconnect": {
        const index = edgeIndex(op.from, op.to);
        if (index === -1) { refuse("Not connected"); break; }
        if (lockedEdge(op.from, op.to)) { refuse("Connection is locked by the user"); break; }
        // Refuse anything that would strand a room. Connectivity is the one
        // property a re-solve cannot repair for us.
        const trial = next.edges.filter((_, i) => i !== index);
        if (!allReachable(next.nodes, trial)) { refuse("Would strand part of the map"); break; }
        next.edges.splice(index, 1);
        accept();
        break;
      }
      case "remove_room": {
        const node = find(op.key);
        if (node === undefined) { refuse("No such room"); break; }
        if (node.locked) { refuse("Room is locked by the user"); break; }
        if (node.role === "entrance" || node.role === "boss") {
          refuse(`Refusing to remove the ${node.role}`);
          break;
        }
        if (next.nodes.length <= 3) { refuse("Too few rooms left to remove another"); break; }
        const keptNodes = next.nodes.filter((n) => n.key !== op.key);
        const keptEdges = next.edges.filter((e) => e.from !== op.key && e.to !== op.key);
        if (next.edges.some((e) => (e.from === op.key || e.to === op.key) && e.locked)) {
          refuse("A connection for this room is locked by the user");
          break;
        }
        if (!allReachable(keptNodes, keptEdges)) { refuse("Would strand part of the map"); break; }
        next.nodes = keptNodes;
        next.edges = keptEdges;
        accept();
        break;
      }
      case "add_room": {
        if (find(op.key) !== undefined) { refuse("A room with that key already exists"); break; }
        const anchors = op.connectTo.filter((k) => find(k) !== undefined);
        if (anchors.length === 0) { refuse("Nothing to connect it to"); break; }
        next.nodes.push({
          key: op.key,
          name: op.name,
          role: op.role === "entrance" ? "chamber" : op.role,
          tier: op.tier,
          size: op.size,
          ...(op.wing !== undefined ? { wing: op.wing } : {}),
          ...(op.notes !== undefined ? { notes: op.notes } : {}),
        });
        for (const anchor of anchors) next.edges.push({ from: anchor, to: op.key });
        accept();
        break;
      }
    }
  }

  return { blueprint: next, results };
}

function allReachable(
  nodes: Array<{ key: string }>,
  edges: Array<{ from: string; to: string }>,
): boolean {
  if (nodes.length === 0) return true;
  const adjacency = new Map<string, string[]>(nodes.map((n) => [n.key, []]));
  for (const edge of edges) {
    adjacency.get(edge.from)?.push(edge.to);
    adjacency.get(edge.to)?.push(edge.from);
  }
  const seen = new Set<string>([nodes[0]!.key]);
  const queue = [nodes[0]!.key];
  while (queue.length > 0) {
    for (const next of adjacency.get(queue.shift()!) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen.size === nodes.length;
}

/**
 * Recover a floor plan from a map that never had one.
 *
 * Procedurally generated dungeons already carry roles and tiers from the
 * layout-rules pass, so the plan is sitting there implicitly - this just makes
 * it explicit. Without it, refine would only work on blueprint-built maps, and
 * the maps most in need of criticism are exactly the ones built without a plan.
 */
export function blueprintFromDungeon(dungeon: Dungeon): Blueprint {
  const usable = dungeon.rooms.filter((r) => r.role !== "junction");
  const keyOf = (id: number) => {
    const room = dungeon.rooms.find((r) => r.id === id);
    return room?.plan?.key ?? `room-${id}`;
  };

  const sizeFor = (cells: number): BlueprintNode["size"] => {
    if (cells <= 5) return "Tiny";
    if (cells <= 7) return "Small";
    if (cells <= 10) return "Medium";
    if (cells <= 15) return "Large";
    return "Huge";
  };

  const nodes: BlueprintNode[] = usable.map((room) => ({
    key: keyOf(room.id),
    name: room.plan?.name ?? room.description?.name ?? `Room ${room.id}`,
    role: (room.role ?? "chamber") as BlueprintNode["role"],
    tier: room.tier ?? 0,
    size: sizeFor(Math.max(room.width, room.height)),
    ...(room.plan?.wing !== undefined ? { wing: room.plan.wing } : {}),
    ...(room.plan?.notes !== undefined ? { notes: room.plan.notes } : {}),
  }));

  const keys = new Set(nodes.map((n) => n.key));
  const seen = new Set<string>();
  const edges: Blueprint["edges"] = [];

  // Junction chambers are engine scenery, not plan nodes, so a path that runs
  // A -> junction -> B has to be rewritten as the single edge A -> B it stands
  // for, or the recovered plan would look disconnected.
  const throughJunction = (roomId: number): number[] => {
    const room = dungeon.rooms.find((r) => r.id === roomId);
    if (room === undefined || room.role !== "junction") return [roomId];
    return room.connections.flatMap((next) => {
      const target = dungeon.rooms.find((r) => r.id === next);
      return target?.role === "junction" ? [] : [next];
    });
  };

  for (const room of usable) {
    for (const connection of room.connections) {
      for (const target of throughJunction(connection)) {
        if (target === room.id) continue;
        const a = keyOf(room.id);
        const b = keyOf(target);
        if (!keys.has(a) || !keys.has(b)) continue;
        const id = [a, b].sort().join("|");
        if (seen.has(id)) continue;
        seen.add(id);
        edges.push({ from: a, to: b });
      }
    }
  }

  return { name: undefined, nodes, edges };
}
