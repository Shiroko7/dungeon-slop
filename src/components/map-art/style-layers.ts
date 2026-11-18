/**
 * The layers of a map's art (DungeonStyle) as a flat list the UI can show and
 * edit one at a time: the background, the floor, and each room override.
 */
import type { Dungeon, DungeonStyle, TextureRef } from "../../engine/types.ts";
import { roomName } from "../../engine/room-name.ts";

export type LayerKey = "floor" | "background" | `room:${string}`;

export interface Layer {
  key: LayerKey;
  label: string;
  hint: string;
  ref: TextureRef | undefined;
}

export function getLayer(style: DungeonStyle, key: LayerKey): TextureRef | undefined {
  if (key === "floor") return style.floor;
  if (key === "background") return style.background;
  return style.rooms?.[key.slice(5)]?.floor;
}

/** A copy of the style with one layer replaced (or removed when `ref` is undefined). */
export function withLayer(style: DungeonStyle, key: LayerKey, ref: TextureRef | undefined): DungeonStyle {
  const next: DungeonStyle = { ...style, rooms: { ...style.rooms } };
  if (key === "floor") next.floor = ref;
  else if (key === "background") next.background = ref;
  else if (ref) next.rooms![key.slice(5)] = { floor: ref };
  else delete next.rooms![key.slice(5)];
  if (!next.floor) delete next.floor;
  if (!next.background) delete next.background;
  if (Object.keys(next.rooms!).length === 0) delete next.rooms;
  return next;
}

export function applyStyle(d: Dungeon, style: DungeonStyle): Dungeon {
  const next: Dungeon = { ...d, style };
  if (!style.floor && !style.background && !style.rooms && !style.objects?.length) delete next.style;
  return next;
}

/** Background and floor always; rooms only once they have their own texture. */
export function listLayers(d: Dungeon): Layer[] {
  const style = d.style ?? {};
  const rooms = Object.keys(style.rooms ?? {})
    .sort((a, b) => Number(a) - Number(b))
    .map((id): Layer => {
      const room = d.rooms.find((r) => String(r.id) === id);
      return {
        key: `room:${id}`,
        label: room ? roomName(room, room.description) : `Room ${id}`,
        hint: `Room ${id}`,
        ref: style.rooms?.[id]?.floor,
      };
    });
  return [
    ...rooms,
    { key: "floor", label: "Floor", hint: "Rooms and corridors", ref: style.floor },
    { key: "background", label: "Background", hint: "Around and between rooms", ref: style.background },
  ];
}
