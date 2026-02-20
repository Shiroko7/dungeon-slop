import { useDungeonStore } from "../../store/dungeon-store.ts";

interface CorridorTooltipProps {
  corridorId: number;
  position: { x: number; y: number };
}

const TOOLTIP_OFFSET = 12;

function corridorLabel(id: number): string {
  let label = "";
  let n = id;
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

export function CorridorTooltip({ corridorId, position }: CorridorTooltipProps) {
  const dungeon = useDungeonStore((s) => s.dungeon);
  if (!dungeon) return null;

  const corridor = dungeon.corridors.find((c) => c.id === corridorId);
  if (!corridor) return null;

  const label = corridorLabel(corridorId);
  const isDeadEnd = corridor.roomB === -1;
  const isRoomStub = isDeadEnd && corridor.roomA !== -1;

  const name = isDeadEnd ? `Dead End ${label}` : `Path ${label}`;
  const description = isDeadEnd
    ? isRoomStub
      ? `Room ${corridor.roomA} → Dead end`
      : `Path ${label} → Dead end`
    : `Room ${corridor.roomA} → Room ${corridor.roomB}`;

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
      <div className="room-tooltip-description">{description}</div>
    </div>
  );
}
