import { useCallback } from "react";
import { useDungeonStore } from "../../store/dungeon-store.ts";
import { Button } from "../shared/Button.tsx";
import { exportPNG } from "../../export/png-export.ts";
import { exportPDF } from "../../export/pdf-export.ts";
import { exportVTT } from "../../export/vtt-export.ts";

export function ExportActions() {
  const dungeon = useDungeonStore((s) => s.dungeon);

  const handlePNG = useCallback(() => {
    if (dungeon) exportPNG(dungeon);
  }, [dungeon]);

  const handlePDF = useCallback(() => {
    if (dungeon) exportPDF(dungeon);
  }, [dungeon]);

  const handleVTT = useCallback(() => {
    if (dungeon) exportVTT(dungeon);
  }, [dungeon]);

  if (!dungeon) return null;

  return (
    <div className="export-actions">
      <Button variant="secondary" size="sm" onClick={handlePNG}>PNG</Button>
      <Button variant="secondary" size="sm" onClick={handlePDF}>PDF</Button>
      <Button variant="secondary" size="sm" onClick={handleVTT}>VTT</Button>
    </div>
  );
}
