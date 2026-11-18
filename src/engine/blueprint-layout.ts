import type { Blueprint, BlueprintNode } from "../ai/blueprint.ts";
import type { DungeonConfig, RoomShape } from "../ai/schema.ts";
import type { Room, RoomPlan } from "./types.ts";
import { SECTOR_SHAPE } from "./types.ts";
import { carveSector, sectorAnchorCell, sectorBounds, type SectorGeometry } from "./sector.ts";
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

function roomSize(node: BlueprintNode, rng: SeededRandom, scale: number): { width: number; height: number } {
  const range = ROOM_SIZE_CELLS[node.size] ?? ROOM_SIZE_CELLS["Medium"]!;
  // Roles carry weight: a boss room should read as the biggest thing on the
  // map, a hub has to hold the traffic of everything hanging off it, and a
  // chokepoint should feel tight by comparison.
  const bias =
    node.role === "boss" ? 1.25 : node.role === "hub" ? 1.15 : node.role === "chokepoint" ? 0.8 : 1;
  const base = rng.nextInt(range.min, range.max);
  const scaled = Math.max(3, Math.round(base * bias * scale));
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
    const mid = ((range.min + range.max) / 2) * (blueprint.scale ?? 1);
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
      const size = roomSize(node, rng, blueprint.scale ?? 1);
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
  if (blueprint.layout === "radial") return layoutRadial(blueprint);
  const { width, height } = gridForBlueprint(blueprint, config);
  const placed = seedPositions(blueprint, width, height, rng);

  const edges = resolveEdges(blueprint, placed.map((p) => p.node));

  relax(placed, edges, width, height);
  separateIntegers(placed, width, height);
  const planFor = planBuilder(blueprint);

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
      plan: planFor(p.node),
    };
  });

  return { rooms, edges, width, height };
}

/** Blueprint edges as pairs of indexes into `nodes`. */
function resolveEdges(blueprint: Blueprint, nodes: BlueprintNode[]): Array<[number, number]> {
  const indexByKey = new Map(nodes.map((n, i) => [n.key, i]));
  const edges: Array<[number, number]> = [];
  for (const edge of blueprint.edges) {
    const a = indexByKey.get(edge.from);
    const b = indexByKey.get(edge.to);
    if (a === undefined || b === undefined || a === b) continue;
    edges.push([a, b]);
  }
  return edges;
}

/** What each room carries forward from the plan for the narrator and the editor. */
function planBuilder(blueprint: Blueprint): (node: BlueprintNode) => RoomPlan {
  const gatingByKey = new Map<string, string[]>();
  const doorByKey = new Map<string, string[]>();
  for (const edge of blueprint.edges) {
    if (edge.gating !== undefined && edge.gating.trim().length > 0) {
      for (const key of [edge.from, edge.to]) {
        const list = gatingByKey.get(key);
        if (list === undefined) gatingByKey.set(key, [edge.gating]);
        else list.push(edge.gating);
      }
    }
    if (edge.door !== undefined && edge.door.trim() !== "") {
      for (const key of [edge.from, edge.to]) {
        const list = doorByKey.get(key);
        if (list === undefined) doorByKey.set(key, [edge.door]);
        else if (!list.includes(edge.door)) list.push(edge.door);
      }
    }
  }

  return (node) => ({
    key: node.key,
    name: node.name,
    locked: node.locked,
    wing: node.wing,
    notes: node.notes,
    gating: gatingByKey.get(node.key),
    doorPreferences: doorByKey.get(node.key),
    ...(node.ring !== undefined ? { ring: node.ring } : {}),
    ...(node.sector !== undefined ? { sector: node.sector } : {}),
  });
}

// ─── Radial layout ────────────────────────────────────────────────────────────
//
// One round room at the centre, every other room a slice of a ring around it.
// Nothing here is solved or relaxed: the plan says which ring and which slot,
// and the geometry follows from that exactly, so the map is the diagram.
//
// The centre sits on a cell CENTRE and every gap is 1.25 cells. Between them
// those two numbers guarantee what the doors need: neighbouring rooms never
// share an edge (a gap over one cell), yet almost everywhere along a shared wall
// there is a single cell with one room on each side of it (a gap under 1.41,
// the most that two steps across a cell can span on a diagonal).

/** Default rock between a ring and whatever lies inside it, and between two slices. */
const DEFAULT_GAP = 1.25;
/** Clear space outside the outermost ring, for corridors that go round. */
const RADIAL_MARGIN = 6;
/** Narrowest a slice may be along its inner wall, in cells. */
const MIN_SLICE_WIDTH = 4;

function midSize(size: string): number {
  const range = ROOM_SIZE_CELLS[size] ?? ROOM_SIZE_CELLS["Medium"]!;
  return (range.min + range.max) / 2;
}

function layoutRadial(blueprint: Blueprint): BlueprintLayout {
  const nodes = blueprint.nodes;
  // A plan may widen the gaps into channels; past 1.41 no single cell spans
  // them, and the corridor carver routes a short passage across instead.
  const RING_GAP = blueprint.gap ?? DEFAULT_GAP;
  const SLICE_GAP = blueprint.gap ?? DEFAULT_GAP;
  const centre = nodes.find((n) => n.ring === 0) ?? nodes[0]!;
  const ringNumbers = [...new Set(nodes.filter((n) => n !== centre).map((n) => n.ring ?? 1))].sort(
    (a, b) => a - b,
  );
  const rings = ringNumbers.map((ring) =>
    nodes
      .map((node, index) => ({ node, index }))
      .filter(({ node }) => node !== centre && (node.ring ?? 1) === ring)
      // Explicit slots first, in slot order; anything unnumbered keeps plan order.
      .sort(
        (a, b) =>
          (a.node.sector ?? Number.MAX_SAFE_INTEGER) - (b.node.sector ?? Number.MAX_SAFE_INTEGER) ||
          a.index - b.index,
      )
      .map(({ node }) => node),
  );

  // An odd diameter puts the centre of the room on the centre of a cell.
  const scale = blueprint.scale ?? 1;
  let diameter = Math.max(7, 2 * Math.round((midSize(centre.size) * scale) / 2) + 1);
  const firstRing = rings[0]?.length ?? 0;
  while (firstRing > 0 && (2 * Math.PI * (diameter / 2 + RING_GAP)) / firstRing - SLICE_GAP < MIN_SLICE_WIDTH) {
    diameter += 2;
  }
  const hubRadius = diameter / 2;

  const bands: Array<{ inner: number; outer: number }> = [];
  let edge = hubRadius;
  for (const members of rings) {
    const depth = Math.max(4, Math.round(Math.max(...members.map((n) => midSize(n.size))) * 0.7 * scale));
    const inner = edge + RING_GAP;
    bands.push({ inner, outer: inner + depth });
    edge = inner + depth;
  }

  const side = Math.max(20, Math.ceil(2 * edge) + 2 * RADIAL_MARGIN);
  const cx = Math.floor(side / 2) + 0.5;
  const cy = cx;
  const planFor = planBuilder(blueprint);

  const ordered: BlueprintNode[] = [centre, ...rings.flat()];
  const rooms: Room[] = [];

  const hubX = cx - hubRadius;
  const hubY = cy - hubRadius;
  rooms.push({
    id: 0,
    x: hubX,
    y: hubY,
    width: diameter,
    height: diameter,
    centerX: hubX + Math.floor(diameter / 2),
    centerY: hubY + Math.floor(diameter / 2),
    shape: "Circular",
    connections: [],
    features: [],
    role: centre.role,
    tier: centre.tier,
    plan: planFor(centre),
  });

  rings.forEach((members, ringIndex) => {
    const band = bands[ringIndex]!;
    // A lone slice takes half a turn: the walls of anything wider stop
    // bounding a wedge.
    const span = members.length === 1 ? Math.PI : (2 * Math.PI) / members.length;
    members.forEach((node, slot) => {
      const startAngle = -Math.PI / 2 + slot * span;
      const sector: SectorGeometry = {
        cx,
        cy,
        innerRadius: band.inner,
        outerRadius: band.outer,
        startAngle,
        endAngle: startAngle + span,
        inset: SLICE_GAP / 2,
      };
      const bounds = sectorBounds(sector);
      const anchor = sectorAnchorCell(sector, carveSector(sector));
      rooms.push({
        id: rooms.length,
        ...bounds,
        centerX: anchor.x,
        centerY: anchor.y,
        shape: SECTOR_SHAPE,
        sector,
        connections: [],
        features: [],
        role: node.role,
        tier: node.tier,
        plan: planFor(node),
      });
    });
  });

  return { rooms, edges: resolveEdges(blueprint, ordered), width: side, height: side };
}
