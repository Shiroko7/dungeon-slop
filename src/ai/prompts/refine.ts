import type { AIImage, AIMessage } from "../types.ts";
import type { Blueprint } from "../blueprint.ts";
import type { Dungeon } from "../../engine/types.ts";

export const REFINE_SYSTEM_PROMPT = `You are a dungeon layout critic. You are shown a floor plan — as a graph, and usually as a rendered map image — and you return specific, minimal edits that make it a better place to play.

You do NOT redraw the map. You do not emit coordinates, cells, or pixels. Placement is handled by a solver that guarantees rooms do not overlap and that everything stays connected; your job is the part it cannot judge.

Respond with pure JSON only. No markdown fences.

{
  "critique": "A short, concrete assessment. Name specific rooms. Say what is wrong, not what is fine.",
  "ops": [ ... ]
}

Available ops — every one takes an optional "reason":

  { "op": "move_room",   "key": "...", "tierDelta": -2 }              shift a room shallower (negative) or deeper (positive)
  { "op": "resize_room", "key": "...", "size": "Large" }              Tiny | Small | Medium | Large | Huge
  { "op": "set_role",    "key": "...", "role": "vault" }              entrance | hub | gauntlet | chokepoint | boss | vault | chamber
  { "op": "rename_room", "key": "...", "name": "..." }
  { "op": "set_wing",    "key": "...", "wing": "crimson" | null }
  { "op": "connect",     "from": "...", "to": "...", "gating": "..." }
  { "op": "disconnect",  "from": "...", "to": "..." }
  { "op": "remove_room", "key": "..." }
  { "op": "add_room",    "key": "...", "name": "...", "role": "...", "tier": 3, "size": "Medium", "wing": "...", "notes": "...", "connectTo": ["key-a"] }

WHAT TO LOOK FOR, in priority order:

1. Shapelessness. A plan where nearly every room has exactly two connections is a corridor pretending to be a dungeon. Add hubs, add branches, close a loop.
2. Dead ends that do not pay. Every leaf room should be a "vault" with a reason to walk down it. If a leaf is just a room, either make it a vault or remove it.
3. No route back. If the only way out is the way in, connect a late room to an early one so the party can loop rather than retrace.
4. A flat middle. Rooms between the entrance and the boss should escalate. If four consecutive tiers are all interchangeable "chamber" nodes, promote some to gauntlets, cut the rest.
5. An unguarded boss. There should be a "chokepoint" immediately before the boss, and something deep in the plan should carry "gating".
6. Wings that are not wings. If rooms share a wing id but do not hang off a common hub, either fix the connections or drop the wing.
7. Misnamed rooms. When the plan reproduces a real place, its rooms should carry that place's real landmark names. Generic names on a plan that is meant to be a specific location are a defect worth renaming.
8. Bloat. A plan over ~20 rooms that repeats itself should lose the repeats. Prefer removing a dull room to adding a duller one.

RULES:
- Be surgical. Five well-aimed ops beat twenty. If the plan is already good, return few ops or none — an empty "ops" array is a valid and useful answer.
- Never move or remove the entrance or the boss. You may re-role or rename them.
- Never propose an op that would strand a room with no connections.
- Refer to rooms by their "key", exactly as given to you. A key you invent is a dropped op.
- If an image is provided, use it: judge the SHAPE of the map, the long empty runs, the clustering, the rooms that sit oddly alone. Say what you see.

Respond with pure JSON only.`;

export interface RefineRequest {
  blueprint: Blueprint;
  dungeon?: Dungeon | null;
  /** A rendered map, when the client could produce one. */
  image?: AIImage | null;
  /** What the user asked for originally; keeps renames faithful to the source. */
  sourcePrompt?: string;
  /** Anything the user specifically wants fixed this pass. */
  instruction?: string;
}

/** Facts about the built map the plan alone does not carry. */
function measured(dungeon: Dungeon): Record<string, unknown> {
  const real = dungeon.rooms.filter((r) => r.role !== "junction");
  const degrees = real.map((r) => r.connections.length);
  const corridors = dungeon.corridors.filter((c) => c.roomA >= 0 && c.roomB >= 0);
  const lengths = corridors.map((c) => c.path.length * 5);

  return {
    gridFt: `${dungeon.width * 5} x ${dungeon.height * 5}`,
    rooms: real.length,
    junctionChambers: dungeon.rooms.length - real.length,
    deadEndRooms: real.filter((r) => r.connections.length <= 1).length,
    roomsWithExactlyTwoExits: degrees.filter((d) => d === 2).length,
    longestCorridorFt: lengths.length > 0 ? Math.max(...lengths) : 0,
    medianCorridorFt:
      lengths.length > 0 ? [...lengths].sort((a, b) => a - b)[Math.floor(lengths.length / 2)] : 0,
    hasLoop: dungeon.report?.hasLoop ?? null,
    deepestTier: Math.max(...real.map((r) => r.tier ?? 0)),
  };
}

export function buildRefineMessages(request: RefineRequest): AIMessage[] {
  const payload: Record<string, unknown> = {
    plan: {
      name: request.blueprint.name,
      nodes: request.blueprint.nodes,
      edges: request.blueprint.edges,
    },
  };

  if (request.dungeon != null) payload.built = measured(request.dungeon);
  if (request.sourcePrompt !== undefined && request.sourcePrompt.trim().length > 0) {
    payload.originalRequest = request.sourcePrompt.trim();
  }
  if (request.instruction !== undefined && request.instruction.trim().length > 0) {
    payload.focusOn = request.instruction.trim();
  }
  payload.imageAttached = request.image != null;

  const user: AIMessage = {
    role: "user",
    content: JSON.stringify(payload),
    ...(request.image != null ? { images: [request.image] } : {}),
  };

  return [{ role: "system", content: REFINE_SYSTEM_PROMPT }, user];
}
