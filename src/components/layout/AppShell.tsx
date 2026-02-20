import { useUIStore } from "../../store/ui-store.ts";
import { useDungeonStore } from "../../store/dungeon-store.ts";
import { Sidebar } from "./Sidebar.tsx";
import { Toolbar } from "./Toolbar.tsx";
import { DungeonCanvas } from "../canvas/DungeonCanvas.tsx";
import { ExportActions } from "../canvas/ExportActions.tsx";
import { DescribeActivityToast } from "../canvas/DescribeActivityToast.tsx";
import { MapLegend } from "../canvas/MapLegend.tsx";
import { SettingsPopover } from "../panels/SettingsPopover.tsx";
import { ExportPopover } from "../panels/ExportPopover.tsx";

export function AppShell() {
  const isSidebarOpen = useUIStore((s) => s.isSidebarOpen);
  const dungeon = useDungeonStore((s) => s.dungeon);
  const error = useDungeonStore((s) => s.error);
  const setError = useDungeonStore((s) => s.setError);

  return (
    <div className="app-shell">
      {isSidebarOpen && <Sidebar />}
      <div className="main-area">
        <Toolbar />
        {error && (
          <div className="error-banner">
            <span className="error-banner-text">{error}</span>
            <button className="error-banner-dismiss" onClick={() => setError(null)}>
              &times;
            </button>
          </div>
        )}
        <div className="canvas-container">
          <DungeonCanvas />
          {!dungeon && (
            <div className="canvas-empty-state">
              <div className="canvas-empty-title">No Map Yet</div>
              <div className="canvas-empty-subtitle">
                Describe your dungeon in the sidebar, then hit Generate
              </div>
            </div>
          )}
          <DescribeActivityToast />
          <MapLegend />
          <ExportActions />
        </div>
        <SettingsPopover />
        <ExportPopover />
      </div>
    </div>
  );
}
