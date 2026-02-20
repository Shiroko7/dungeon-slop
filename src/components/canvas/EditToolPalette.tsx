import { useUIStore } from "../../store/ui-store.ts";
import type { EditTool } from "../../store/ui-store.ts";

interface ToolEntry {
  tool: EditTool;
  icon: string;
  label: string;
}

const TOOL_GROUPS: Array<ToolEntry[] | "divider"> = [
  [{ tool: "select", icon: "↖", label: "Select" }],
  "divider",
  [
    { tool: "room",  icon: "□", label: "Room" },
    { tool: "paint", icon: "∙", label: "Paint" },
  ],
  "divider",
  [
    { tool: "archway",     icon: "⌂",            label: "Archway" },
    { tool: "portcullis",  icon: "⌇",            label: "Portcullis" },
    { tool: "door",        icon: "\uD83D\uDEAA", label: "Door" },
    { tool: "locked_door", icon: "\uD83D\uDD12", label: "Locked" },
    { tool: "trapped_door",icon: "\u26A0",       label: "Trapped" },
    { tool: "secret_door", icon: "\uD83D\uDD0D", label: "Secret" },
    { tool: "trap",        icon: "\u26A0\uFE0F",  label: "Trap" },
    { tool: "treasure",    icon: "\uD83D\uDCB0", label: "Treasure" },
    { tool: "stairs_up",   icon: "\u2B06\uFE0F",  label: "Stairs Up" },
    { tool: "stairs_down", icon: "\u2B07\uFE0F",  label: "Stairs Dn" },
  ],
  "divider",
  [{ tool: "erase", icon: "✕", label: "Erase" }],
];

export function EditToolPalette() {
  const activeTool = useUIStore((s) => s.activeTool);
  const setActiveTool = useUIStore((s) => s.setActiveTool);
  const paintRoomId = useUIStore((s) => s.paintRoomId);
  const paintRoomLocked = useUIStore((s) => s.paintRoomLocked);
  const unlockPaintRoom = useUIStore((s) => s.unlockPaintRoom);

  return (
    <div className="edit-tool-palette">
      {TOOL_GROUPS.map((group, gi) => {
        if (group === "divider") {
          return <div key={`div-${gi}`} className="edit-tool-divider" />;
        }
        return group.map((entry) => (
          <button
            key={entry.tool}
            className={`edit-tool-btn${activeTool === entry.tool ? " edit-tool-btn--active" : ""}`}
            onClick={() => setActiveTool(entry.tool)}
            title={entry.label}
          >
            <span>{entry.icon}</span>
            <span>{entry.label}</span>
          </button>
        ));
      })}

      {activeTool === "paint" && (
        <>
          <div className="edit-tool-divider" />
          {paintRoomLocked && paintRoomId !== null ? (
            <div className="edit-tool-status edit-tool-status--locked">
              <span className="edit-tool-status-label">Room {paintRoomId}</span>
              <button
                className="edit-tool-unlock-btn"
                onClick={unlockPaintRoom}
                title="Unlock — auto-infer room from stroke"
              >
                ×
              </button>
            </div>
          ) : (
            <div className="edit-tool-status edit-tool-status--auto">
              <span className="edit-tool-status-label">Auto</span>
            </div>
          )}
          <div className="edit-tool-hint">
            {paintRoomLocked ? "Locked to room" : "Click room to lock"}
          </div>
        </>
      )}
    </div>
  );
}
