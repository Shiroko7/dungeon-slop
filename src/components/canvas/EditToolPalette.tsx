import { useUIStore } from "../../store/ui-store.ts";
import type { EditTool } from "../../engine/edit-engine.ts";

interface ToolDef {
  tool: EditTool;
  label: string;
  title: string;
}

const NAV_TOOLS: ToolDef[] = [
  { tool: "select", label: "Select", title: "Pan and zoom — or hold Space" },
];

const PAINT_TOOLS: ToolDef[] = [
  { tool: "floor",       label: "Floor",     title: "Paint floor cells" },
  { tool: "corridor",    label: "Corridor",  title: "Paint corridor" },
  { tool: "wall",        label: "Wall",      title: "Paint wall cells" },
  { tool: "erase",       label: "Erase",     title: "Erase cells" },
  { tool: "door",        label: "Door",      title: "Place door" },
  { tool: "stairs_up",   label: "Stair Up",  title: "Place stairs up" },
  { tool: "stairs_down", label: "Stair Dn",  title: "Place stairs down" },
];

function ToolButton({ def, active, onClick }: { def: ToolDef; active: boolean; onClick: () => void }) {
  return (
    <button
      className={`edit-tool-btn${active ? " edit-tool-btn--active" : ""}`}
      title={def.title}
      onClick={onClick}
    >
      {def.label}
    </button>
  );
}

export function EditToolPalette() {
  const activeTool  = useUIStore((s) => s.activeTool);
  const setActiveTool = useUIStore((s) => s.setActiveTool);

  return (
    <div className="edit-tool-palette" onMouseDown={(e) => e.stopPropagation()}>
      {NAV_TOOLS.map((def) => (
        <ToolButton key={def.tool} def={def} active={activeTool === def.tool} onClick={() => setActiveTool(def.tool)} />
      ))}
      <div className="edit-tool-divider" />
      {PAINT_TOOLS.map((def) => (
        <ToolButton key={def.tool} def={def} active={activeTool === def.tool} onClick={() => setActiveTool(def.tool)} />
      ))}
      <div className="edit-tool-divider" />
      <div className="edit-tool-hint">Hold Space to pan</div>
    </div>
  );
}
