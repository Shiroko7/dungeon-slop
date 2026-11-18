import { useEffect, type ReactNode } from "react";
import { useUIStore, type ArtTool } from "../../store/ui-store.ts";
import { useStampStore } from "./stamp-store.ts";
import "./map-art.css";

const TOOLS: { tool: ArtTool; key: string; label: string; icon: ReactNode }[] = [
  {
    tool: "select",
    key: "v",
    label: "Select & pan",
    icon: <path d="M5 3l12 9-5.5 1.2L15 20l-2.6 1.1-3.4-6.7L5 18z" />,
  },
  {
    tool: "textures",
    key: "t",
    label: "Textures: floor, background, rooms",
    icon: (
      <>
        <rect x="3" y="3" width="8" height="8" rx="1" />
        <rect x="13" y="3" width="8" height="8" rx="1" opacity="0.55" />
        <rect x="3" y="13" width="8" height="8" rx="1" opacity="0.55" />
        <rect x="13" y="13" width="8" height="8" rx="1" />
      </>
    ),
  },
  {
    tool: "stamp",
    key: "s",
    label: "Stamp: place objects",
    icon: <path d="M9 3h6v5l3 4v2H6v-2l3-4zM5 16h14v2H5zM4 20h16v1.5H4z" />,
  },
];

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

/** The vertical tool rail on the left of the map (V / T / S). */
export function ToolRail() {
  const artTool = useUIStore((s) => s.artTool);
  const setArtTool = useUIStore((s) => s.setArtTool);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      const hit = TOOLS.find((t) => t.key === e.key.toLowerCase());
      if (hit) {
        setArtTool(hit.tool);
        if (hit.tool !== "stamp") useStampStore.getState().select(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setArtTool]);

  return (
    <nav className="tool-rail" aria-label="Map tools">
      {TOOLS.map((t) => (
        <button
          key={t.tool}
          className={`tool-rail-btn${artTool === t.tool ? " is-on" : ""}`}
          aria-pressed={artTool === t.tool}
          aria-label={t.label}
          title={`${t.label} (${t.key.toUpperCase()})`}
          onClick={() => {
            const next = artTool === t.tool && t.tool !== "select" ? "select" : t.tool;
            if (next !== "stamp") useStampStore.getState().select(null);
            setArtTool(next);
          }}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">{t.icon}</svg>
        </button>
      ))}
    </nav>
  );
}
