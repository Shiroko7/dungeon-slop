import type { Blueprint } from "../ai/blueprint.ts";
import { CellType, FeatureType } from "./types.ts";
import type { Corridor, Dungeon, Feature } from "./types.ts";
import { doorFeatureFor } from "./features.ts";
import { getCell, getNeighbors } from "./grid.ts";

const DOOR_CELLS = new Set<CellType>([CellType.Door, CellType.SecretDoor]);

/**
 * Put the door the plan asked for on the connection it asked for it on.
 *
 * Random door placement knows nothing about the plan, so "the Cradle is sealed"
 * used to survive only as a sentence handed to the narrator while the map drew
 * whatever door the dice chose. Here an edge's `door` sets the door type, and an
 * edge with `gating` but no `door` gets a locked door. The door goes at the end
 * of the passage that opens into the edge's `to` room, the side the gate keeps.
 *
 * Returns the requirements it could not meet, worded for the layout report.
 */
export function applyEdgeDoors(dungeon: Dungeon, blueprint: Blueprint): string[] {
  const unmet: string[] = [];
  const byKey = new Map(dungeon.rooms.map((room) => [room.plan?.key, room]));
  let nextId = dungeon.features.reduce((max, f) => Math.max(max, f.id), -1) + 1;

  for (const edge of blueprint.edges) {
    const gating = edge.gating?.trim() ?? "";
    const door = edge.door?.trim() ?? "";
    if (gating === "" && door === "") continue;
    const label = `${edge.from} -> ${edge.to}`;

    let wanted: FeatureType | null;
    if (door !== "") {
      const known = doorFeatureFor(door);
      if (known === undefined) {
        wanted = gating !== "" ? FeatureType.LockedDoor : FeatureType.Door;
        unmet.push(`Door "${door}" on ${label} is not a known door type; drew a ${gating !== "" ? "locked" : "standard"} door.`);
      } else {
        wanted = known;
      }
    } else {
      wanted = FeatureType.LockedDoor;
    }

    const from = byKey.get(edge.from);
    const to = byKey.get(edge.to);
    if (from === undefined || to === undefined) continue;
    // The corridor into `to` from `from` itself, or from a junction room the
    // budget pass inserted on that edge.
    const approaches = approachIds(dungeon, from.id, to.id);
    const corridor =
      dungeon.corridors.find((c) => isBetween(c, from.id, to.id)) ??
      dungeon.corridors.find((c) => approaches.some((id) => isBetween(c, id, to.id)));
    // The cell of the passage that opens into the `to` room. A door already
    // standing there is preferred, so the door is replaced rather than doubled.
    const candidates = (corridor?.path ?? []).filter(({ x, y }) =>
      getNeighbors(dungeon.grid, x, y).some((n) => n.cell.type === CellType.Floor && n.cell.roomId === to.id),
    );
    const at =
      candidates.find(({ x, y }) => DOOR_CELLS.has(getCell(dungeon.grid, x, y)?.type ?? CellType.Empty)) ??
      candidates[0];
    if (at === undefined) {
      unmet.push(`No direct passage was built for ${label}, so its ${gating !== "" ? `gate "${gating}"` : `door "${door}"`} has nowhere to go.`);
      continue;
    }

    // A wide doorway: every passage cell beside `at` that also opens into `to`.
    const group = [at];
    for (let grew = true; grew; ) {
      grew = false;
      for (const c of candidates) {
        if (group.includes(c)) continue;
        if (group.some((g) => Math.abs(g.x - c.x) + Math.abs(g.y - c.y) === 1)) {
          group.push(c);
          grew = true;
        }
      }
    }
    const cells = group.map(({ x, y }) => getCell(dungeon.grid, x, y)!);
    const stale = new Set(cells.map((c) => c.featureId).filter((id): id is number => id !== null));
    if (stale.size > 0) dungeon.features = dungeon.features.filter((f) => !stale.has(f.id));
    for (const c of cells) c.featureId = null;
    if (wanted === null) {
      for (const c of cells) c.type = CellType.Corridor;
      continue;
    }

    const feature: Feature = {
      id: nextId++,
      type: wanted,
      x: at.x,
      y: at.y,
      metadata: { edge: label, ...(gating !== "" ? { gating } : {}) },
    };
    dungeon.features.push(feature);
    for (const c of cells) {
      c.featureId = feature.id;
      c.type = wanted === FeatureType.SecretDoor ? CellType.SecretDoor : CellType.Door;
    }
  }

  return unmet;
}

function isBetween(c: Corridor, a: number, b: number): boolean {
  return (c.roomA === a && c.roomB === b) || (c.roomA === b && c.roomB === a);
}

/** Junction rooms next to `to` that lead back to `from` through junctions only. */
function approachIds(dungeon: Dungeon, fromId: number, toId: number): number[] {
  const byId = new Map(dungeon.rooms.map((r) => [r.id, r]));
  const result: number[] = [];
  for (const id of byId.get(toId)?.connections ?? []) {
    if (byId.get(id)?.role !== "junction") continue;
    const seen = new Set([id, toId]);
    const queue = [id];
    while (queue.length > 0) {
      const room = byId.get(queue.shift()!);
      if (room?.connections.includes(fromId)) {
        result.push(id);
        break;
      }
      for (const next of room?.connections ?? []) {
        if (seen.has(next) || byId.get(next)?.role !== "junction") continue;
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return result;
}
