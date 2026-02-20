import { useDungeonStore } from "../../store/dungeon-store.ts";
import { useUIStore } from "../../store/ui-store.ts";
import { CellType, FeatureType } from "../../engine/types.ts";
import type { Cell, Feature, Corridor } from "../../engine/types.ts";

const CELL_SIZE = 16;

// Door types are rendered as cartographic symbols on the canvas; excluded from SVG emoji overlay.
const DOOR_FEATURE_TYPES = new Set<FeatureType>([
  FeatureType.Door,
  FeatureType.LockedDoor,
  FeatureType.SecretDoor,
  FeatureType.Portcullis,
  FeatureType.Archway,
  FeatureType.TrappedDoor,
]);

const FEATURE_ICONS: Record<FeatureType, string> = {
  [FeatureType.Door]: "",
  [FeatureType.SecretDoor]: "",
  [FeatureType.LockedDoor]: "",
  [FeatureType.Portcullis]: "",
  [FeatureType.Archway]: "",
  [FeatureType.TrappedDoor]: "",
  [FeatureType.Trap]: "\u26A0",
  [FeatureType.Treasure]: "\uD83D\uDCB0",
  [FeatureType.StairsUp]: "\u2B06",
  [FeatureType.StairsDown]: "\u2B07",
};

// A, B, C … Z, AA, AB … for corridor labels
function corridorLabel(id: number): string {
  let label = "";
  let n = id;
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

const WALKABLE_FOR_LABEL = new Set([
  CellType.Corridor,
  CellType.Door,
  CellType.SecretDoor,
  CellType.StairsUp,
  CellType.StairsDown,
]);

function CorridorLabel({ corridor, grid, cellSize }: { corridor: Corridor; grid: Cell[][]; cellSize: number }) {
  const { path } = corridor;
  // Only use cells that are currently rendered as corridor (not Floor, not stale Wall/Empty).
  // Post-processing (thinCorridors / collapseDeadEnds) can revert some path cells to walls;
  // using them for midpoint calculation would place the label in empty grey space.
  const corridorOnly = path.filter(pos => {
    const cell = grid[pos.y]?.[pos.x];
    return cell != null && WALKABLE_FOR_LABEL.has(cell.type);
  });
  // Fall back to the full path if every cell was reverted (corridor fully collapsed).
  const labelPath = corridorOnly.length > 0 ? corridorOnly : path;
  if (labelPath.length === 0) return null;
  const mid = labelPath[Math.floor(labelPath.length / 2)]!;
  const cx = mid.x * cellSize + cellSize / 2;
  const cy = mid.y * cellSize + cellSize / 2;
  const r = cellSize * 0.44;
  const fontSize = cellSize * 0.52;
  const label = corridorLabel(corridor.id);

  return (
    <g className="corridor-label">
      <circle cx={cx} cy={cy} r={r} className="corridor-label-bg" />
      <text
        x={cx}
        y={cy}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={fontSize}
        className="corridor-label-text"
      >
        {label}
      </text>
    </g>
  );
}

function FeatureIcon({ feature, cellSize }: { feature: Feature; cellSize: number }) {
  const icon = FEATURE_ICONS[feature.type];
  const x = feature.x * cellSize + cellSize / 2;
  const y = feature.y * cellSize + cellSize / 2;
  const fontSize = cellSize * 0.7;

  return (
    <text
      x={x}
      y={y}
      textAnchor="middle"
      dominantBaseline="central"
      fontSize={fontSize}
      className={`feature-icon feature-icon--${feature.type}`}
    >
      {icon}
    </text>
  );
}

export function SvgOverlay() {
  const dungeon = useDungeonStore((s) => s.dungeon);
  const panX = useUIStore((s) => s.panX);
  const panY = useUIStore((s) => s.panY);
  const zoom = useUIStore((s) => s.zoom);

  if (!dungeon) return null;

  return (
    <svg
      className="svg-overlay"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
      }}
    >
      <g transform={`translate(${panX}, ${panY}) scale(${zoom})`}>
        {dungeon.corridors.map((corridor) => (
          <CorridorLabel key={corridor.id} corridor={corridor} grid={dungeon.grid} cellSize={CELL_SIZE} />
        ))}
        {dungeon.features
          .filter((f) => !DOOR_FEATURE_TYPES.has(f.type))
          .map((feature) => (
            <FeatureIcon key={feature.id} feature={feature} cellSize={CELL_SIZE} />
          ))}
      </g>
    </svg>
  );
}
