import { useEffect, useRef } from "react";
import { useUIStore } from "../../store/ui-store.ts";
import { ExportPanel } from "./ExportPanel.tsx";

export function ExportPopover() {
  const isOpen = useUIStore((s) => s.isExportOpen);
  const setIsOpen = useUIStore((s) => s.setIsExportOpen);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [isOpen, setIsOpen]);

  if (!isOpen) return null;

  return (
    <div className="settings-popover export-popover" ref={ref}>
      <div className="settings-popover-header">
        <h3 className="settings-popover-title">Export</h3>
        <button className="settings-popover-close" onClick={() => setIsOpen(false)}>
          &times;
        </button>
      </div>
      <ExportPanel />
    </div>
  );
}
