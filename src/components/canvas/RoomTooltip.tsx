import { roomName } from "../../engine/room-name.ts";
import { useDungeonStore } from "../../store/dungeon-store.ts";

interface RoomTooltipProps {
  roomId: number;
  position: { x: number; y: number };
}

const TOOLTIP_OFFSET = 12;

export function RoomTooltip({ roomId, position }: RoomTooltipProps) {
  const dungeon = useDungeonStore((s) => s.dungeon);
  const roomDescriptions = useDungeonStore((s) => s.roomDescriptions);

  if (!dungeon) return null;

  const room = dungeon.rooms.find((r) => r.id === roomId);
  if (!room) return null;

  const description = roomDescriptions.get(roomId) ?? room.description;
  const name = roomName(room, description);
  const brief = description?.description;

  return (
    <div
      className="room-tooltip"
      style={{
        position: "fixed",
        left: position.x + TOOLTIP_OFFSET,
        top: position.y + TOOLTIP_OFFSET,
        pointerEvents: "none",
      }}
    >
      <div className="room-tooltip-name">{name}</div>
      {brief && <div className="room-tooltip-description">{brief}</div>}
    </div>
  );
}
