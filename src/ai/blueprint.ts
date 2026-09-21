import { z } from "zod";
import { RoomShapeEnum } from "./schema.ts";
import type { GroundingProvenance } from "./grounding-types.ts";

/**
 * A dungeon's floor plan as a graph, before any geometry exists.
 *
 * This is the half of dungeon design a solver cannot do and a language model
 * can. A BSP knows how to fit non-overlapping boxes into a rectangle; it has no
 * idea that the entrance hall comes before the gauntlet, that three wings branch
 * off one upper landing, or that the throne room is behind all of them. Asking
 * the model for CELLS would be asking it for the one thing it is bad at - metric
 * geometry with hard constraints. Asking it for the graph plays to the opposite
 * strength, and leaves placement to the solver that was always good at it.
 */

export const BlueprintRoleEnum = z.enum([
  "entrance",
  "hub",
  "gauntlet",
  "chokepoint",
  "boss",
  "vault",
  "chamber",
]);

export type BlueprintRole = z.infer<typeof BlueprintRoleEnum>;

export const BlueprintNodeSchema = z.object({
  /** Stable slug used by edges. Lowercase, hyphenated. */
  key: z.string().min(1).max(60),
  /** What the room is called on the map. */
  name: z.string().min(1).max(80),
  role: BlueprintRoleEnum,
  /** Rooms from the entrance. 0 is the way in; the boss holds the highest. */
  tier: z.number().int().min(0).max(40),
  /** Optional branch name, e.g. "plagueworks". Wings are placed apart. */
  wing: z.string().max(60).optional(),
  size: z.enum(["Tiny", "Small", "Medium", "Large", "Huge"]).default("Medium"),
  shape: RoomShapeEnum.optional(),
  /** What happens here - handed to the narrator so prose matches the plan. */
  notes: z.string().max(400).optional(),
  /** User-protected requirement; AI refinement must leave this node intact. */
  locked: z.boolean().optional(),
});

export const BlueprintEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  /** What bars the way, if anything: "needs the Frostwing key". */
  gating: z.string().max(200).optional(),
  /** Prefer this door type on the connection. */
  door: z.string().max(40).optional(),
  /** User-protected requirement; AI refinement must leave this edge intact. */
  locked: z.boolean().optional(),
});

export const GroundingCitationSchema = z.object({
  campaignId: z.number().int().positive(),
  documentId: z.number().int().positive(),
  revision: z.number().int().positive(),
  chunkId: z.number().int().positive(),
  filename: z.string().max(300),
  headingPath: z.string().max(500),
  snippet: z.string().max(1200),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().nonnegative(),
});

export const GroundingProvenanceSchema = z.object({
  query: z.string().max(1000),
  documentIds: z.array(z.number().int().positive()).max(50).nullable(),
  citations: z.array(GroundingCitationSchema).max(12),
  warnings: z.array(z.string().max(500)).max(12),
  status: z.enum(["ready", "empty-query", "empty-index", "no-sources", "unavailable", "no-matches"]),
  retrievedAt: z.number().int().nonnegative(),
});

export const BlueprintSchema = z.object({
  name: z.string().max(120).optional(),
  nodes: z.array(BlueprintNodeSchema).min(2).max(40),
  edges: z.array(BlueprintEdgeSchema),
  grounding: GroundingProvenanceSchema.optional(),
});

export type BlueprintNode = z.infer<typeof BlueprintNodeSchema>;
export type BlueprintEdge = z.infer<typeof BlueprintEdgeSchema>;
export type Blueprint = z.infer<typeof BlueprintSchema> & { grounding?: GroundingProvenance };

export interface BlueprintProblem {
  severity: "error" | "repaired";
  message: string;
}

/**
 * Make a model-authored blueprint safe to build.
 *
 * Everything here is a repair rather than a rejection. A blueprint that names a
 * node twice or points an edge at a room it forgot to declare is still 95% of a
 * good floor plan, and throwing it away costs a paid call to get back something
 * with a different flaw. Only an unusable plan - no nodes, nothing connected -
 * is worth refusing.
 */
export function normalizeBlueprint(input: Blueprint): {
  blueprint: Blueprint;
  problems: BlueprintProblem[];
} {
  const problems: BlueprintProblem[] = [];

  // Duplicate keys would make edges ambiguous; keep the first, rename the rest.
  const seen = new Set<string>();
  const nodes: BlueprintNode[] = [];
  for (const node of input.nodes) {
    let key = node.key;
    if (seen.has(key)) {
      let n = 2;
      while (seen.has(`${key}-${n}`)) n += 1;
      key = `${key}-${n}`;
      problems.push({ severity: "repaired", message: `Duplicate key "${node.key}" renamed to "${key}"` });
    }
    seen.add(key);
    nodes.push({ ...node, key });
  }

  const byKey = new Map(nodes.map((n) => [n.key, n]));

  // Edges into nothing are dropped rather than allowed to fabricate a room.
  const edgeSeen = new Set<string>();
  const edges: BlueprintEdge[] = [];
  for (const edge of input.edges) {
    if (!byKey.has(edge.from) || !byKey.has(edge.to)) {
      problems.push({ severity: "repaired", message: `Edge ${edge.from}->${edge.to} references an undeclared room; dropped` });
      continue;
    }
    if (edge.from === edge.to) continue;
    const id = [edge.from, edge.to].sort().join("|");
    if (edgeSeen.has(id)) continue;
    edgeSeen.add(id);
    edges.push(edge);
  }

  // Exactly one entrance, at tier 0.
  let entrances = nodes.filter((n) => n.role === "entrance");
  if (entrances.length === 0) {
    const shallowest = [...nodes].sort((a, b) => a.tier - b.tier)[0]!;
    shallowest.role = "entrance";
    problems.push({ severity: "repaired", message: `No entrance declared; "${shallowest.name}" promoted` });
    entrances = [shallowest];
  } else if (entrances.length > 1) {
    for (const extra of entrances.slice(1)) extra.role = "chamber";
    problems.push({ severity: "repaired", message: `${entrances.length} entrances declared; kept "${entrances[0]!.name}"` });
  }
  entrances[0]!.tier = 0;

  // Exactly one boss, and it must be the deepest room or the progression lies.
  const bosses = nodes.filter((n) => n.role === "boss");
  const deepest = nodes.reduce((a, b) => (b.tier > a.tier ? b : a), nodes[0]!);
  if (bosses.length === 0) {
    deepest.role = "boss";
    problems.push({ severity: "repaired", message: `No boss declared; deepest room "${deepest.name}" promoted` });
  } else {
    for (const extra of bosses.slice(1)) extra.role = "chamber";
    if (bosses.length > 1) {
      problems.push({ severity: "repaired", message: `${bosses.length} bosses declared; kept "${bosses[0]!.name}"` });
    }
    const boss = bosses[0]!;
    if (boss.tier < deepest.tier) {
      boss.tier = deepest.tier + 1;
      problems.push({ severity: "repaired", message: `Boss "${boss.name}" was not the deepest room; pushed to tier ${boss.tier}` });
    }
  }

  // Connectivity: anything the edges left stranded gets joined to the nearest
  // shallower room, which is where it plainly belongs.
  const adjacency = new Map<string, string[]>(nodes.map((n) => [n.key, []]));
  for (const edge of edges) {
    adjacency.get(edge.from)!.push(edge.to);
    adjacency.get(edge.to)!.push(edge.from);
  }

  const reached = new Set<string>();
  const queue = [entrances[0]!.key];
  reached.add(queue[0]!);
  while (queue.length > 0) {
    for (const next of adjacency.get(queue.shift()!) ?? []) {
      if (reached.has(next)) continue;
      reached.add(next);
      queue.push(next);
    }
  }

  for (const node of nodes) {
    if (reached.has(node.key)) continue;
    const anchor = nodes
      .filter((n) => reached.has(n.key))
      .sort((a, b) => Math.abs(a.tier - (node.tier - 1)) - Math.abs(b.tier - (node.tier - 1)))[0];
    if (anchor === undefined) continue;
    edges.push({ from: anchor.key, to: node.key });
    reached.add(node.key);
    problems.push({ severity: "repaired", message: `"${node.name}" was unreachable; joined to "${anchor.name}"` });
  }

  return { blueprint: { name: input.name, nodes, edges, grounding: input.grounding }, problems };
}
