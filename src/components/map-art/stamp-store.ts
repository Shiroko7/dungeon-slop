/**
 * Stamp tool state: which asset is loaded on the stamp, the settings the next
 * placement gets, and which placed object is selected.
 */
import { create } from "zustand";

export interface StampSettings {
  size: number;
  rotation: number;
  randomRotation: boolean;
  opacity: number;
  shadow: boolean;
  flipX: boolean;
}

interface StampState extends StampSettings {
  asset: string | null;
  selectedObjectId: string | null;
  /** Cursor position in cells while the stamp tool is over the map (drives the ghost). */
  hover: { x: number; y: number } | null;
  setAsset: (asset: string | null) => void;
  setSettings: (patch: Partial<StampSettings>) => void;
  select: (id: string | null) => void;
  setHover: (hover: { x: number; y: number } | null) => void;
}

export const useStampStore = create<StampState>((set) => ({
  asset: null,
  size: 2,
  rotation: 0,
  randomRotation: false,
  opacity: 1,
  shadow: true,
  flipX: false,
  selectedObjectId: null,
  hover: null,
  setAsset: (asset) => set({ asset }),
  setSettings: (patch) => set(patch),
  select: (selectedObjectId) => set({ selectedObjectId }),
  setHover: (hover) => set({ hover }),
}));

export function newObjectId(): string {
  return `obj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
