import { useDungeonStore } from "../../store/dungeon-store.ts";
import { useUIStore } from "../../store/ui-store.ts";
import type { ReactNode } from "react";
import { FeatureType } from "../../engine/types.ts";

// SVG cartographic symbol for legend — matches drawDoorSymbol() in DungeonCanvas
// Rendered in NS orientation (stubs left/right, opening runs horizontally)
const CS = 24;
const SW = Math.round(CS * 0.27); // stub width  = 6
const SH = Math.round(CS * 0.5);  // stub height = 12
const OFF = Math.round((CS - SH) / 2); // centering offset = 6
const X1 = SW;          // inner edge of left stub  = 6
const X2 = CS - SW;     // inner edge of right stub = 18
const MIDY = CS / 2;    // vertical midpoint        = 12
const XS = CS * 0.14;   // X-mark half-size         ≈ 3.4
const CX = CS / 2;      // horizontal center        = 12

function DoorIcon({ type }: { type: FeatureType }) {
  return (
    <svg
      viewBox={`0 0 ${CS} ${CS}`}
      width="18"
      height="18"
      aria-hidden="true"
      style={{ display: "block", flexShrink: 0 }}
    >
      {/* Wall stubs — present on every door type */}
      <rect x={0}       y={OFF} width={SW} height={SH} fill="currentColor" />
      <rect x={CS - SW} y={OFF} width={SW} height={SH} fill="currentColor" />

      {/* Portcullis: 3 horizontal bars */}
      {type === FeatureType.Portcullis && [1, 2, 3].map((i) => (
        <line
          key={i}
          x1={X1} y1={OFF + (SH / 4) * i}
          x2={X2} y2={OFF + (SH / 4) * i}
          stroke="currentColor" strokeWidth="1"
        />
      ))}

      {/* Door / LockedDoor / TrappedDoor: solid centre line */}
      {(type === FeatureType.Door ||
        type === FeatureType.LockedDoor ||
        type === FeatureType.TrappedDoor) && (
        <line x1={X1} y1={MIDY} x2={X2} y2={MIDY} stroke="currentColor" strokeWidth="1.5" />
      )}

      {/* SecretDoor: dashed centre line */}
      {type === FeatureType.SecretDoor && (
        <line
          x1={X1} y1={MIDY} x2={X2} y2={MIDY}
          stroke="currentColor" strokeWidth="1" strokeDasharray="2 1.5"
        />
      )}

      {/* LockedDoor: filled circle */}
      {type === FeatureType.LockedDoor && (
        <circle cx={CX} cy={MIDY} r={Math.max(1.5, CS * 0.12)} fill="currentColor" />
      )}

      {/* TrappedDoor: X mark */}
      {type === FeatureType.TrappedDoor && (
        <>
          <line x1={CX - XS} y1={MIDY - XS} x2={CX + XS} y2={MIDY + XS} stroke="currentColor" strokeWidth="1" />
          <line x1={CX + XS} y1={MIDY - XS} x2={CX - XS} y2={MIDY + XS} stroke="currentColor" strokeWidth="1" />
        </>
      )}
    </svg>
  );
}

interface LegendEntry {
  type: FeatureType;
  label: string;
  icon: ReactNode;
}

const LEGEND_ENTRIES: LegendEntry[] = [
  { type: FeatureType.Archway,     label: "Archway",      icon: <DoorIcon type={FeatureType.Archway} /> },
  { type: FeatureType.Portcullis,  label: "Portcullis",   icon: <DoorIcon type={FeatureType.Portcullis} /> },
  { type: FeatureType.Door,        label: "Door",         icon: <DoorIcon type={FeatureType.Door} /> },
  { type: FeatureType.LockedDoor,  label: "Locked Door",  icon: <DoorIcon type={FeatureType.LockedDoor} /> },
  { type: FeatureType.TrappedDoor, label: "Trapped Door", icon: <DoorIcon type={FeatureType.TrappedDoor} /> },
  { type: FeatureType.SecretDoor,  label: "Secret Door",  icon: <DoorIcon type={FeatureType.SecretDoor} /> },
  { type: FeatureType.Trap,        label: "Trap",         icon: "\u26A0\uFE0F" },
  { type: FeatureType.Treasure,    label: "Treasure",     icon: "\uD83D\uDCB0" },
  { type: FeatureType.StairsUp,    label: "Stairs Up",    icon: "\u2B06\uFE0F" },
  { type: FeatureType.StairsDown,  label: "Stairs Down",  icon: "\u2B07\uFE0F" },
];

export function MapLegend() {
  const dungeon = useDungeonStore((s) => s.dungeon);
  const hiddenFeatureTypes = useUIStore((s) => s.hiddenFeatureTypes);
  const toggleFeatureType = useUIStore((s) => s.toggleFeatureType);

  if (!dungeon) return null;

  const presentTypes = new Set(dungeon.features.map((f) => f.type));
  const visibleEntries = LEGEND_ENTRIES.filter((e) => presentTypes.has(e.type));

  if (visibleEntries.length === 0) return null;

  return (
    <div className="map-legend">
      <div className="map-legend-title">Legend</div>
      <div className="map-legend-items">
        {visibleEntries.map((entry) => {
          const isHidden = hiddenFeatureTypes.includes(entry.type);
          return (
            <button
              key={entry.type}
              className={`map-legend-item${isHidden ? " map-legend-item--hidden" : ""}`}
              onClick={() => toggleFeatureType(entry.type)}
              title={isHidden ? `Show ${entry.label}` : `Hide ${entry.label}`}
            >
              <span className="map-legend-icon">{entry.icon}</span>
              <span className="map-legend-label">{entry.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
