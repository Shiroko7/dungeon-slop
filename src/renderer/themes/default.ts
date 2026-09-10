import type { ThemePalette } from "./theme-engine.ts";

// Light sketch: warm aged paper, lighter parchment floors, warm near-black ink.
export const defaultTheme: ThemePalette = {
  background: "#e6dcc6",
  paper: "#e6dcc6",
  parchment: "#f7f1e3",
  floor: "#f7f1e3",
  corridor: "#f7f1e3",
  wall: "#e6dcc6",
  ink: "#3a3128",
  door: "#8b7355",
  secretDoor: "#6a5a7a",
  stairs: "#7a7a5a",
  trap: "#9c4a3c",
  treasure: "#8a6d2f",
  grid: "#3a3128",
  roomHighlight: "rgba(180, 140, 50, 0.20)",
  roomHover: "rgba(58, 49, 40, 0.07)",
  text: "#3a3128",
};
