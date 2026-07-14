import { useCallback, useState } from "react";
import { useDungeonStore } from "../../store/dungeon-store.ts";
import { useUIStore } from "../../store/ui-store.ts";
import { Button } from "../shared/Button.tsx";

const ZOOM_BTN_FACTOR = 1.2;

export function Toolbar() {
  const config = useDungeonStore((s) => s.config);
  const dungeon = useDungeonStore((s) => s.dungeon);
  const isGeneratingDungeon = useDungeonStore((s) => s.isGeneratingDungeon);
  const generateDungeonFromConfig = useDungeonStore((s) => s.generateDungeonFromConfig);
  const rerollDungeon = useDungeonStore((s) => s.rerollDungeon);
  const undoEdit = useDungeonStore((s) => s.undoEdit);
  const redoEdit = useDungeonStore((s) => s.redoEdit);
  const canUndo = useDungeonStore((s) => s._undoStack.length > 0);
  const canRedo = useDungeonStore((s) => s._redoStack.length > 0);

  const zoom = useUIStore((s) => s.zoom);
  const zoomAtAnchor = useUIStore((s) => s.zoomAtAnchor);
  const canvasW = useUIStore((s) => s.canvasW);
  const canvasH = useUIStore((s) => s.canvasH);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const resetView = useUIStore((s) => s.resetView);
  const darkMode = useUIStore((s) => s.darkMode);
  const toggleDarkMode = useUIStore((s) => s.toggleDarkMode);
  const toggleSettings = useUIStore((s) => s.toggleSettings);
  const toggleExport = useUIStore((s) => s.toggleExport);
  const editMode = useUIStore((s) => s.editMode);
  const toggleEditMode = useUIStore((s) => s.toggleEditMode);
  const [seedInput, setSeedInput] = useState("");

  const handleGenerateDungeon = useCallback(() => {
    if (!config || isGeneratingDungeon) return;
    generateDungeonFromConfig();
  }, [config, isGeneratingDungeon, generateDungeonFromConfig]);

  const handleReroll = useCallback(() => {
    if (!config || isGeneratingDungeon) return;
    rerollDungeon();
  }, [config, isGeneratingDungeon, rerollDungeon]);

  const handleSeedSubmit = useCallback(() => {
    if (!config || isGeneratingDungeon) return;
    const trimmed = seedInput.trim();
    if (!trimmed) {
      rerollDungeon();
      return;
    }
    const parsed = parseInt(trimmed, 10);
    if (!Number.isNaN(parsed)) {
      rerollDungeon(parsed);
    }
  }, [config, isGeneratingDungeon, seedInput, rerollDungeon]);

  // Toolbar zoom anchors at the viewport center
  const handleZoomIn = useCallback(() => {
    zoomAtAnchor(canvasW / 2, canvasH / 2, ZOOM_BTN_FACTOR);
  }, [zoomAtAnchor, canvasW, canvasH]);

  const handleZoomOut = useCallback(() => {
    zoomAtAnchor(canvasW / 2, canvasH / 2, 1 / ZOOM_BTN_FACTOR);
  }, [zoomAtAnchor, canvasW, canvasH]);

  return (
    <div className="toolbar">
      <div className="toolbar-left">
        <Button variant="icon" size="sm" onClick={toggleSidebar} aria-label="Toggle sidebar">
          &#9776;
        </Button>

        <span className="toolbar-divider" />

        <Button
          variant="primary"
          size="sm"
          onClick={handleGenerateDungeon}
          disabled={!config || isGeneratingDungeon}
        >
          {isGeneratingDungeon ? "Generating..." : "Generate"}
        </Button>

        {config && (
          <div className="seed-control">
            <label className="seed-control-label" htmlFor="seed-input">Seed</label>
            <input
              id="seed-input"
              type="text"
              className="seed-control-input"
              value={seedInput}
              onChange={(e) => setSeedInput(e.target.value)}
              placeholder={dungeon ? String(dungeon.seed) : "Random"}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSeedSubmit();
              }}
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={handleReroll}
              disabled={isGeneratingDungeon}
              title="Generate with a new random seed"
            >
              Reroll
            </Button>
          </div>
        )}
      </div>

      <div className="toolbar-center">
        <Button
          variant="primary"
          size="sm"
          onClick={toggleEditMode}
          disabled={!dungeon}
          title={editMode ? "Exit edit mode" : "Enter edit mode"}
          aria-label={editMode ? "Exit edit mode" : "Enter edit mode"}
          aria-pressed={editMode}
        >
          {editMode ? "Done" : "Edit"}
        </Button>

        <span className="toolbar-divider" />

        <Button
          variant="icon"
          size="sm"
          onClick={undoEdit}
          disabled={!canUndo}
          aria-label="Undo"
          title="Undo (Ctrl+Z)"
        >
          &#8630;
        </Button>
        <Button
          variant="icon"
          size="sm"
          onClick={redoEdit}
          disabled={!canRedo}
          aria-label="Redo"
          title="Redo (Ctrl+Y)"
        >
          &#8631;
        </Button>

        <span className="toolbar-divider" />

        <Button variant="icon" size="sm" onClick={handleZoomOut} aria-label="Zoom out">
          &minus;
        </Button>
        <span className="toolbar-zoom-label">{Math.round(zoom * 100)}%</span>
        <Button variant="icon" size="sm" onClick={handleZoomIn} aria-label="Zoom in">
          +
        </Button>
        <Button variant="icon" size="sm" onClick={resetView} aria-label="Reset view">
          &#8634;
        </Button>
      </div>

      <div className="toolbar-right">
        <Button
          variant="icon"
          size="sm"
          onClick={toggleExport}
          aria-label="Export"
          title="Export map and descriptions"
        >
          &#8595;
        </Button>
        <Button
          variant="icon"
          size="sm"
          onClick={toggleSettings}
          aria-label="Settings"
          title="AI Settings"
        >
          &#9881;
        </Button>
        <Button
          variant="icon"
          size="sm"
          onClick={toggleDarkMode}
          aria-label="Toggle dark mode"
          title={darkMode ? "Switch to light mode" : "Switch to dark mode"}
        >
          {darkMode ? "\u2600" : "\u263E"}
        </Button>
      </div>
    </div>
  );
}
