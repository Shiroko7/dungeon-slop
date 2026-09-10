import type { Blueprint, BlueprintNode } from "../ai/blueprint.ts";
import type { DungeonConfig, RoomShape } from "../ai/schema.ts";
import type { Room } from "./types.ts";
import { ROOM_SIZE_CELLS } from "./bsp.ts";
import type { SeededRandom } from "../lib/random.ts";

/**
 * Turn a floor-plan graph into placed, non-overlapping rooms.
 *
 * The division of labour is the point: the model decided WHAT rooms exist and
 * how they connect, and everything here is the part it would have got wrong —
 * integer coordinates, non-overlap, staying in bounds, keeping connected rooms
 * near enough that the corridor between them is a doorway rather than a hike.
 *
 * Placement runs in three stages: seed from the plan's own structure (tier sets
 * depth, wing sets which way it branches), relax with a spring model so joined
 * rooms pull together and everything else pushes apart, then snap to the grid
 * and separate whatever still overlaps.
 */

/** Clear space to leave between two rooms - enough for a corridor and its walls. */
const ROOM_GAP = 4;
/** Distance at which an edge stops pulling: adjacent rooms plus a short corridor. */
const IDEAL_EDGE_GAP = 8;
const RELAX_ITERATIONS = 220;
const MARGIN = 3;

interface Placed {
  node: BlueprintNode;
  /** Centre, kept fractional through relaxation and rounded at the end. */
  cx: number;
  cy: number;
  width: number;
  height: number;
  /** Tier band centre; y is sprung back toward this so depth stays readable. */
  anchorY: number;
}

const SHAPE_MINIMUMS: Record<string, number> = {
  Circular: 7,
  Hexagonal: 7,
  Pentagonal: 7,
  Cross: 9,
  Diamond: 5,
  Cave: 5,
};

function pickShape(node: BlueprintNode, config: DungeonConfig, size: number, rng: SeededRandom): RoomShape {
  const requested = node.shape;
  if (requested !== undefined && size >= (SHAPE_MINIMUMS[requested] ?? 0)) return requested;

  const pool = (config.room_shapes ?? ["Rectangular"]).filter(
    (s) => size >= (SHAPE_MINIMUMS[s] ?? 0),
  );
  if (pool.length === 0) return "Rectangular";
  return pool[rng.nextInt(0, pool.length - 1)] ?? "Rectangular";
}

function roomSize(node: BlueprintNode, rng: SeededRandom): { width: number; height: number } {
  const range = ROOM_SIZE_CELLS[node.size] ?? ROOM_SIZE_CELLS["Medium"]!;
  // Roles carry weight: a boss room should read as the biggest thing on the
  // map, a hub has to hold the traffic of everything hanging off it, and a
  // chokepoint should feel tight by comparison.
  const bias =
    node.role === "boss" ? 1.25 : node.role === "hub" ? 1.15 : node.role === "chokepoint" ? 0.8 : 1;
  const base = rng.nextInt(range.min, range.max);
  const scaled = Math.max(3, Math.round(base * bias));
  const jitter = rng.nextInt(-1, 1);
  return { width: scaled, height: Math.max(3, scaled + jitter) };
}

/**
 * How big a grid this plan needs.
 *
 * Sized from the rooms themselves at a coverage that leaves room for corridors.
 * The config's grid is honoured when it is already big enough; when it is not,
 * cramming the plan in would defeat the whole exercise.
 */
export function gridForBlueprint(
  blueprint: Blueprint,
  config: DungeonConfig,
): { width: number; height: number } {
  let area = 0;
  for (const node of blueprint.nodes) {
    const range = ROOM_SIZE_CELLS[node.size] ?? ROOM_SIZE_CELLS["Medium"]!;
    const mid = (range.min + range.max) / 2;
    area += (mid + ROOM_GAP) ** 2;
  }
  const side = Math.ceil(Math.sqrt(area / 0.30));
  const tiers = Math.max(...blueprint.nodes.map((n) => n.tier)) + 1;

  return {
    width: Math.max(20, Math.min(1000, Math.max(config.grid_width, side))),
    // Depth needs room to read as depth, so guarantee a band per tier.
    height: Math.max(20, Math.min(1000, Math.max(config.grid_height, side, tiers * 14))),
  };
}

function seedPositions(
  blueprint: Blueprint,
  width: number,
  height: number,
  rng: SeededRandom,
): Placed[] {
  const maxTier = Math.max(...blueprint.nodes.map((n) => n.tier));
  const usableTop = MARGIN + 10;
  const usableBottom = height - MARGIN - 10;

  // Wings get their own horizontal sector so parallel branches read as parallel
  // rather than interleaving into one undifferentiated smear.
  const wings = [...new Set(blueprint.nodes.map((n) => n.wing).filter((w): w is string => w != null))];
  const wingCentre = new Map<string, number>();
  wings.forEach((wing, i) => {
    const span = width / (wings.length + 1);
    wingCentre.set(wing, span * (i + 1));
  });

  const byTier = new Map<number, BlueprintNode[]>();
  for (const node of blueprint.nodes) {
    const list = byTier.get(node.tier);
    if (list === undefined) byTier.set(node.tier, [node]);
    else list.push(node);
  }

  const placed: Placed[] = [];
  for (const [tier, nodes] of [...byTier.entries()].sort((a, b) => a[0] - b[0])) {
    // Entrance at the bottom, boss at the top: the map is walked upward.
    const t = maxTier === 0 ? 0 : tier / maxTier;
    const anchorY = usableBottom - t * (usableBottom - usableTop);

    nodes.forEach((node, i) => {
      const size = roomSize(node, rng);
      const centre =
        node.wing !== undefined && wingCentre.has(node.wing)
          ? wingCentre.get(node.wing)!
          : width / 2;
      const spread = width / (nodes.length + 1);
      const offset = nodes.length === 1 ? 0 : (i - (nodes.length - 1) / 2) * spread * 0.8;

      placed.push({
        node,
        cx: centre + offset + rng.nextFloat(-2, 2),
        cy: anchorY + rng.nextFloat(-2, 2),
        width: size.width,
        height: size.height,
        anchorY,
      });
    });
  }

  return placed;
}

/** Overlap along one axis, given both half-extents and the required gap. */
function overlapOn(delta: number, halfA: number, halfB: number, gap: number): number {
  return halfA + halfB + gap - Math.abs(delta);
}

function relax(placed: Placed[], edges: Array<[number, number]>, width: number, height: number): void {
  for (let iteration = 0; iteration < RELAX_ITERATIONS; iteration++) {
    // Cooling: big corrections early, fine adjustments late, so the layout
    // settles instead of oscillating between two equally bad arrangements.
    const cooling = 1 - iteration / RELAX_ITERATIONS;

    // Edges pull, but only past the point where a short corridor would do.
    for (const [a, b] of edges) {
      const pa = placed[a]!;
      const pb = placed[b]!;
      const dx = pb.cx - pa.cx;
      const dy = pb.cy - pa.cy;
      const dist = Math.hypot(dx, dy) || 0.001;
      const ideal =
        Math.max(pa.width, pa.height) / 2 + Math.max(pb.width, pb.height) / 2 + IDEAL_EDGE_GAP;
      if (dist <= ideal) continue;

      const pull = ((dist - ideal) / dist) * 0.12 * cooling;
      pa.cx += dx * pull;
      pa.cy += dy * pull;
      pb.cx -= dx * pull;
      pb.cy -= dy * pull;
    }

    // Everything pushes everything else out of its footprint.
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const pa = placed[i]!;
        const pb = placed[j]!;
        const dx = pb.cx - pa.cx;
        const dy = pb.cy - pa.cy;
        const ox = overlapOn(dx, pa.width / 2, pb.width / 2, ROOM_GAP);
        const oy = overlapOn(dy, pa.height / 2, pb.height / 2, ROOM_GAP);
        if (ox <= 0 || oy <= 0) continue;

        // Separate along the cheaper axis; shoving both ways spins the pair.
        if (ox < oy) {
          const push = (ox / 2) * 0.7 * (dx >= 0 ? 1 : -1);
          pa.cx -= push;
          pb.cx += push;
        } else {
          const push = (oy / 2) * 0.7 * (dy >= 0 ? 1 : -1);
          pa.cy -= push;
          pb.cy += push;
        }
      }
    }

    for (const p of placed) {
      // Spring back toward the tier band: without this, repulsion slowly erases
      // the depth ordering that made the plan legible in the first place.
      p.cy += (p.anchorY - p.cy) * 0.18 * cooling;
      p.cx = Math.min(width - MARGIN - p.width / 2, Math.max(MARGIN + p.width / 2, p.cx));
      p.cy = Math.min(height - MARGIN - p.height / 2, Math.max(MARGIN + p.height / 2, p.cy));
    }
  }
}

/**
 * Last-resort separation after rounding to integers.
 *
 * Relaxation works in floats and can leave two rooms a fraction apart that snap
 * into each other. Overlapping rooms are not a cosmetic problem - they corrupt
 * cell ownership - so this pass is unconditional and brute.
 */
function separateIntegers(placed: Placed[], width: number, height: number): void {
  for (let pass = 0; pass < 60; pass++) {
    let moved = false;
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const pa = placed[i]!;
        const pb = placed[j]!;
        const dx = pb.cx - pa.cx;
        const dy = pb.cy - pa.cy;
        const ox = overlapOn(dx, pa.width / 2, pb.width / 2, ROOM_GAP);
        const oy = overlapOn(dy, pa.height / 2, pb.height / 2, ROOM_GAP);
        if (ox <= 0 || oy <= 0) continue;

        moved = true;
        const step = Math.ceil(Math.min(ox, oy) / 2);
        if (ox < oy) {
          const dir = dx >= 0 ? 1 : -1;
          pa.cx -= step * dir;
          pb.cx += step * dir;
        } else {
          const dir = dy >= 0 ? 1 : -1;
          pa.cy -= step * dir;
          pb.cy += step * dir;
        }
      }
    }
    for (const p of placed) {
      p.cx = Math.min(width - MARGIN - p.width / 2, Math.max(MARGIN + p.width / 2, Math.round(p.cx)));
      p.cy = Math.min(height - MARGIN - p.height / 2, Math.max(MARGIN + p.height / 2, Math.round(p.cy)));
    }
    if (!moved) break;
  }
}

export interface BlueprintLayout {
  rooms: Room[];
  /** Blueprint edges resolved to room ids, for the corridor carver. */
  edges: Array<[number, number]>;
  width: number;
  height: number;
}

export function layoutBlueprint(
  blueprint: Blueprint,
  config: DungeonConfig,
  rng: SeededRandom,
): BlueprintLayout {
  const { width, height } = gridForBlueprint(blueprint, config);
  const placed = seedPositions(blueprint, width, height, rng);

  const indexByKey = new Map(placed.map((p, i) => [p.node.key, i]));
  const edges: Array<[number, number]> = [];
  for (const edge of blueprint.edges) {
    const a = indexByKey.get(edge.from);
    const b = indexByKey.get(edge.to);
    if (a === undefined || b === undefined || a === b) continue;
    edges.push([a, b]);
  }

  relax(placed, edges, width, height);
  separateIntegers(placed, width, height);

  const gatingByKey = new Map<string, string[]>();
  for (const edge of blueprint.edges) {
    if (edge.gating === undefined || edge.gating.trim().length === 0) continue;
    for (const key of [edge.from, edge.to]) {
      const list = gatingByKey.get(key);
      if (list === undefined) gatingByKey.set(key, [edge.gating]);
      else list.push(edge.gating);
    }
  }

  const rooms: Room[] = placed.map((p, id) => {
    const size = Math.min(p.width, p.height);
    const shape = pickShape(p.node, config, size, rng);
    // Cross and Square must be square for their carved geometry to match the
    // bounding box the rest of the engine reasons about.
    const squared = shape === "Cross" || shape === "Square";
    const w = squared ? size : p.width;
    const h = squared ? size : p.height;
    const x = Math.max(1, Math.round(p.cx - w / 2));
    const y = Math.max(1, Math.round(p.cy - h / 2));

    return {
      id,
      x: Math.min(x, width - w - 1),
      y: Math.min(y, height - h - 1),
      width: w,
      height: h,
      centerX: Math.min(x, width - w - 1) + Math.floor(w / 2),
      centerY: Math.min(y, height - h - 1) + Math.floor(h / 2),
      shape,
      connections: [],
      features: [],
      role: p.node.role,
      tier: p.node.tier,
      plan: {
        key: p.node.key,
        name: p.node.name,
        wing: p.node.wing,
        notes: p.node.notes,
        gating: gatingByKey.get(p.node.key),
      },
    };
  });

  return { rooms, edges, width, height };
}
