import { useCallback } from "react";
import { useDungeonStore } from "../../store/dungeon-store.ts";
import { Button } from "../shared/Button.tsx";
import { exportPNG } from "../../export/png-export.ts";
import { exportPDF } from "../../export/pdf-export.ts";
import { exportVTT } from "../../export/vtt-export.ts";
import {
  exportDescriptionsText,
  exportDescriptionsJSON,
  exportDescriptionsMarkdown,
  exportDescriptionsPDF,
} from "../../export/descriptions-export.ts";

export function ExportPanel() {
  const dungeon = useDungeonStore((s) => s.dungeon);
  const roomDescriptions = useDungeonStore((s) => s.roomDescriptions);
  const dungeonDescription = useDungeonStore((s) => s.dungeonDescription);
  const hasDungeon = dungeon !== null;

  const hasDescriptions = hasDungeon && (
    dungeonDescription !== null ||
    dungeon.rooms.some((r) => roomDescriptions.get(r.id) !== undefined || r.description !== undefined)
  );

  const handleExportPNG = useCallback(() => {
    if (!dungeon) return;
    exportPNG(dungeon);
  }, [dungeon]);

  const handleExportPDF = useCallback(() => {
    if (!dungeon) return;
    exportPDF(dungeon);
  }, [dungeon]);

  const handleExportVTT = useCallback(() => {
    if (!dungeon) return;
    exportVTT(dungeon);
  }, [dungeon]);

  const handleDescText = useCallback(() => {
    if (!dungeon) return;
    exportDescriptionsText(dungeon, roomDescriptions, dungeonDescription);
  }, [dungeon, roomDescriptions, dungeonDescription]);

  const handleDescJSON = useCallback(() => {
    if (!dungeon) return;
    exportDescriptionsJSON(dungeon, roomDescriptions, dungeonDescription);
  }, [dungeon, roomDescriptions, dungeonDescription]);

  const handleDescMarkdown = useCallback(() => {
    if (!dungeon) return;
    exportDescriptionsMarkdown(dungeon, roomDescriptions, dungeonDescription);
  }, [dungeon, roomDescriptions, dungeonDescription]);

  const handleDescPDF = useCallback(() => {
    if (!dungeon) return;
    exportDescriptionsPDF(dungeon, roomDescriptions, dungeonDescription);
  }, [dungeon, roomDescriptions, dungeonDescription]);

  return (
    <div className="export-panel">
      <h3 className="export-panel-heading">Map Export</h3>
      {!hasDungeon && (
        <p className="export-panel-empty">Generate a dungeon first to export.</p>
      )}
      <div className="export-options">
        <div className="export-option">
          <p className="export-option-description">High-resolution image of the dungeon map.</p>
          <Button variant="secondary" size="sm" onClick={handleExportPNG} disabled={!hasDungeon}>
            Export PNG
          </Button>
        </div>
        <div className="export-option">
          <p className="export-option-description">Map + room key in a print-ready PDF.</p>
          <Button variant="secondary" size="sm" onClick={handleExportPDF} disabled={!hasDungeon}>
            Export PDF
          </Button>
        </div>
        <div className="export-option">
          <p className="export-option-description">Virtual tabletop format (Roll20, Foundry VTT…).</p>
          <Button variant="secondary" size="sm" onClick={handleExportVTT} disabled={!hasDungeon}>
            Export VTT
          </Button>
        </div>
      </div>

      <h3 className="export-panel-heading export-panel-heading--section">Room Descriptions</h3>
      {!hasDescriptions && (
        <p className="export-panel-empty">Describe rooms first to export descriptions.</p>
      )}
      <div className="export-options">
        <div className="export-option">
          <p className="export-option-description">Plain text, one room per section.</p>
          <Button variant="secondary" size="sm" onClick={handleDescText} disabled={!hasDescriptions}>
            Export Text
          </Button>
        </div>
        <div className="export-option">
          <p className="export-option-description">Structured JSON for use in other tools.</p>
          <Button variant="secondary" size="sm" onClick={handleDescJSON} disabled={!hasDescriptions}>
            Export JSON
          </Button>
        </div>
        <div className="export-option">
          <p className="export-option-description">Markdown with headings, bold labels, dividers.</p>
          <Button variant="secondary" size="sm" onClick={handleDescMarkdown} disabled={!hasDescriptions}>
            Export Markdown
          </Button>
        </div>
        <div className="export-option">
          <p className="export-option-description">Formatted PDF, ready to hand to players.</p>
          <Button variant="secondary" size="sm" onClick={handleDescPDF} disabled={!hasDescriptions}>
            Export PDF
          </Button>
        </div>
      </div>
    </div>
  );
}
