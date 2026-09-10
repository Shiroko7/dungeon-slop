import type { Room, RoomDescription } from "./types.ts";

/**
 * What to call a room on screen.
 *
 * Three sources, most authoritative first: what the narrator wrote, what the
 * floor plan intended, and finally the room's number. The middle one matters —
 * a planned map knows a room is "Sindragosa's Lair" the moment it is laid out,
 * long before anyone pays to describe it, and showing "Room 13" until then
 * throws that away.
 */
export function roomName(room: Room, description?: RoomDescription | null): string {
  const written = description?.name?.trim();
  if (written !== undefined && written.length > 0) return written;

  const planned = room.plan?.name.trim();
  if (planned !== undefined && planned.length > 0) return planned;

  // Junctions are engine scenery with no plan entry. Sitting in a list of named
  // rooms as "Room 19" they read as rooms someone forgot to name, rather than
  // as the antechambers the corridor budget inserted.
  if (room.role === "junction") return `Junction ${room.id}`;

  return `Room ${room.id}`;
}
