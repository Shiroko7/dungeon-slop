import { defaultTheme } from "./default.ts";
import { infernalTheme } from "./infernal.ts";
import { aquaticTheme } from "./aquatic.ts";

export interface ThemePalette {
  background: string;
  floor: string;
  wall: string;
  corridor: string;
  door: string;
  secretDoor: string;
  stairs: string;
  trap: string;
  treasure: string;
  grid: string;
  roomHighlight: string;
  roomHover: string;
  text: string;
}

const themeMap: Record<string, ThemePalette> = {
  Default: defaultTheme,
  Infernal: infernalTheme,
  Aquatic: aquaticTheme,
};

export function getTheme(motif: string): ThemePalette {
  return themeMap[motif] ?? defaultTheme;
}
