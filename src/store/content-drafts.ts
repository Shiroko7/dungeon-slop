import type { DungeonDescription, RoomDescription } from "../engine/types.ts";

export interface RoomDraftFields {
  name: string;
  features: string;
  monsters: string;
  treasure: string;
  hiddenTreasure: string;
  traps: string;
  tricks: string;
  notes: string;
}

function key(dungeonId: number, roomId: number): string {
  return `dungeon-slop:room-draft:${dungeonId}:${roomId}`;
}

function overviewKey(dungeonId: number): string {
  return `dungeon-slop:overview-draft:${dungeonId}`;
}

export type OverviewDraftFields = DungeonDescription;

export function getOverviewDraft(dungeonId: number | null): OverviewDraftFields | null {
  if (dungeonId === null || typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(overviewKey(dungeonId));
    return raw === null ? null : (JSON.parse(raw) as OverviewDraftFields);
  } catch {
    return null;
  }
}

export function saveOverviewDraft(dungeonId: number | null, draft: OverviewDraftFields): void {
  if (dungeonId === null || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(overviewKey(dungeonId), JSON.stringify(draft));
  } catch {
    // Best effort only.
  }
}

export function clearOverviewDraft(dungeonId: number | null): void {
  if (dungeonId === null || typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(overviewKey(dungeonId));
  } catch {
    // Best effort only.
  }
}

export function getRoomDraft(
  dungeonId: number | null,
  roomId: number,
): RoomDraftFields | null {
  if (dungeonId === null || typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(key(dungeonId, roomId));
    return raw === null ? null : (JSON.parse(raw) as RoomDraftFields);
  } catch {
    return null;
  }
}

export function saveRoomDraft(
  dungeonId: number | null,
  roomId: number,
  draft: RoomDraftFields,
): void {
  if (dungeonId === null || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key(dungeonId, roomId), JSON.stringify(draft));
  } catch {
    // Storage can be unavailable in private mode; the in-memory form remains usable.
  }
}

export function clearRoomDraft(dungeonId: number | null, roomId: number): void {
  if (dungeonId === null || typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(key(dungeonId, roomId));
  } catch {
    // Best effort only.
  }
}

export function descriptionToDraft(desc: RoomDescription | undefined): RoomDraftFields {
  return {
    name: desc?.name ?? "",
    features: desc?.features ?? desc?.description ?? "",
    monsters: desc?.monsters?.join("\n") ?? "",
    treasure: desc?.treasure?.join("\n") ?? "",
    hiddenTreasure: desc?.hiddenTreasure ?? "",
    traps: desc?.traps?.join("\n") ?? "",
    tricks: desc?.tricks?.join("\n") ?? "",
    notes: desc?.notes ?? "",
  };
}
