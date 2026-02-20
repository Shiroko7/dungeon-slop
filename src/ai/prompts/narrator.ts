import type { AIMessage } from "../types.ts";
import type { DungeonConfig } from "../schema.ts";
import type { Room, Corridor } from "../../engine/types.ts";

const CELL_SIZE_FT = 5;
const DOOR_FEATURE_TYPES = new Set(["door", "locked_door", "secret_door", "portcullis", "archway", "trapped_door"]);
const DOOR_LABELS: Record<string, string> = {
  door: "Door",
  locked_door: "Locked Door",
  secret_door: "Secret Door",
  portcullis: "Portcullis",
  archway: "Archway",
  trapped_door: "Trapped Door",
};

function getDirection(
  from: { centerX: number; centerY: number },
  to: { centerX: number; centerY: number },
): string {
  const dx = to.centerX - from.centerX;
  const dy = to.centerY - from.centerY;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "East" : "West";
  return dy >= 0 ? "South" : "North";
}

interface NarratorEntry {
  toRoom: number;
  direction: string;
}

interface NarratorRoomInput {
  id: number;
  widthFt: number;
  heightFt: number;
  entries: NarratorEntry[];
  doorFeatures: string[];
  features: string[];
}

export interface NarratorRoomOutput {
  name: string;
  entries?: Array<{ direction: string; doorType: string; leadsTo: string; trap?: string }>;
  features?: string;
  monsters?: string[];
  treasure?: string[];
  hiddenTreasure?: string;
  traps?: string[];
  tricks?: string[];
  notes?: string;
  empty?: boolean;
}

export const NARRATOR_SYSTEM_PROMPT = `You are the Dungeon Narrator. Generate structured, gameable room descriptions in classic tabletop RPG style (5e compatible).

You receive a JSON object with:
- "rooms": array of room objects, each with:
  - "id": room number
  - "widthFt" / "heightFt": room dimensions in feet
  - "entries": array of { "toRoom": N, "direction": "North|South|East|West" } — passages out of this room
  - "doorFeatures": string[] — door types available to assign to entries (e.g., ["Locked Door", "Secret Door"]). Distribute these across entries; unassigned entries default to "Open Passage"
  - "features": string[] — other room features ("trap", "treasure", "stairs_up", "stairs_down")
- "config": dungeon configuration (motif, theme_description, etc.)

Respond with a JSON array, one object per room in the same order. Each object must have:
- "name": short evocative room name (2-5 words), matching the motif
- "entries": array, one per input entry, each with:
  - "direction": same as input
  - "doorType": assign from doorFeatures or use "Open Passage" / "Archway" for unassigned
  - "leadsTo": "Room N" (use toRoom id)
  - "trap"?: brief description if this entry has a trap on it
- "features": 2-3 sentences of atmospheric description — sensory details (sight, sound, smell), texture, mood. Match the dungeon motif. Scale to room size: small rooms get terse descriptions.
- "monsters": string[] — monsters that could inhabit this room. Include CR, source book abbreviation+page, and XP (e.g., "2 Goblins (CR 1/4, MM p.166, 50 XP each)"). Empty array if none.
- "treasure": string[] — visible treasure. Be specific: coins, items, gems (e.g., "45 sp in a cracked clay pot"). Empty array if none.
- "hiddenTreasure"?: string — concealed treasure and how to find it (e.g., "Loose flagstone (DC 14 Perception): 120 gp and a vial of antitoxin"). Omit if none.
- "traps"?: string[] — room traps with trigger, save, and damage (e.g., "Needle trap on chest lid: DC 13 Perception to spot, DC 12 Dex save or 1 piercing + DC 11 Con save vs. poison (2d6 poison)"). Omit if none.
- "tricks"?: string[] — tricks, puzzles, or strange effects (e.g., "A bronze mirror reflects a different room — the image shows Room 3 as it appeared 100 years ago"). Omit if none.
- "notes"?: string — GM-only notes (plot hooks, secrets, connections). Omit if not needed.
- "empty"?: boolean — true only if room has no monsters, treasure, or interesting features

Style:
- Match the motif: Infernal = heat, brimstone, demonic; Aquatic = damp, tidal, bioluminescent; Undead = cold, deathly silence; etc.
- Be specific: "A cracked obsidian altar stained with old blood" beats "An altar in the center"
- Use real 5e monsters where appropriate
- Rooms with "stairs_up"/"stairs_down" features should mention them explicitly

Respond with pure JSON only. No markdown code fences, no extra text.`;

export const DUNGEON_NARRATOR_SYSTEM_PROMPT = `You are the Dungeon Narrator. Generate the General section for a tabletop dungeon in classic RPG style (5e compatible).

You receive a JSON object with:
- "rooms": array of { id, widthFt, heightFt, features[] }
- "corridors": array of { id, roomA, roomB } — corridor connections
- "config": dungeon configuration (motif, theme_description, layout_style, etc.)

Respond with a single JSON object:
- "history": 2-3 sentences of dungeon backstory — who built it, for what purpose, what happened to it
- "size": brief size descriptor (e.g., "Medium dungeon, 9 rooms, approximately 120 × 80 ft.")
- "walls": wall material and condition (e.g., "Rough-hewn limestone, damp and mossy with pale fungi")
- "floor": floor description (e.g., "Worn flagstone, cracked and uneven from centuries of settling")
- "temperature": ambient temperature (e.g., "Cold, approximately 45°F" or "Sweltering heat, 95°F+")
- "illumination": ambient light (e.g., "Pitch black beyond torchlight" or "Dim greenish glow from phosphorescent lichen")
- "corridorFeatures": array (up to 6 items) of corridor encounter points. Format: { "label": "a", "corridorId": N, "description": "Type: Details." }
  - Label sequentially: a, b, c, d, e, f
  - Use actual corridorId values from input
  - Types: "Trap", "Trick", "Feature", "Monster", "Hazard"
  - Example description: "Trap: A pressure plate in the floor. DC 13 Perception to notice; DC 12 Dex save or a stone block drops from the ceiling (2d6 bludgeoning)."
  - Another: "Feature: The passage widens briefly around a crumbling shrine. Offerings of corroded coins litter the floor."
- "wanderingMonsters": string[] — 3-5 wandering encounter entries (e.g., "1d4 Goblins (CR 1/4, MM p.166)", "1 Gelatinous Cube (CR 2, MM p.242)")

Match all descriptions to the dungeon motif and config. Respond with pure JSON only. No markdown code fences, no extra text.`;

export function buildNarratorMessages(
  targetRooms: Room[],
  allRooms: Room[],
  corridors: Corridor[],
  config: DungeonConfig,
): AIMessage[] {
  const roomMap = new Map(allRooms.map((r) => [r.id, r]));

  const roomInputs: NarratorRoomInput[] = targetRooms.map((room) => {
    const entries: NarratorEntry[] = room.connections
      .map((connId) => {
        const connRoom = roomMap.get(connId);
        if (!connRoom) return null;
        return { toRoom: connId, direction: getDirection(room, connRoom) };
      })
      .filter((e): e is NarratorEntry => e !== null);

    const doorFeatures = room.features
      .filter((f) => DOOR_FEATURE_TYPES.has(f.type))
      .map((f) => DOOR_LABELS[f.type] ?? f.type);

    const otherFeatures = room.features
      .filter((f) => !DOOR_FEATURE_TYPES.has(f.type))
      .map((f) => f.type);

    return {
      id: room.id,
      widthFt: room.width * CELL_SIZE_FT,
      heightFt: room.height * CELL_SIZE_FT,
      entries,
      doorFeatures,
      features: otherFeatures,
    };
  });

  return [
    { role: "system", content: NARRATOR_SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify({ rooms: roomInputs, config }) },
  ];
}

export function buildDungeonNarratorMessages(
  rooms: Room[],
  corridors: Corridor[],
  config: DungeonConfig,
): AIMessage[] {
  const roomSummaries = rooms.map((r) => ({
    id: r.id,
    widthFt: r.width * CELL_SIZE_FT,
    heightFt: r.height * CELL_SIZE_FT,
    features: r.features.map((f) => f.type),
  }));

  const corridorSummaries = corridors.map((c) => ({
    id: c.id,
    roomA: c.roomA,
    roomB: c.roomB,
  }));

  return [
    { role: "system", content: DUNGEON_NARRATOR_SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify({ rooms: roomSummaries, corridors: corridorSummaries, config }) },
  ];
}
