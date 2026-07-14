import { create } from "zustand";
import { persist } from "zustand/middleware";
import { FeatureType } from "../engine/types.ts";
import type { EditTool } from "../engine/edit-engine.ts";

interface UIState {
  // Pan/zoom
  panX: number;
  panY: number;
  zoom: number;

  // Selection
  selectedRoomId: number | null;
  hoveredRoomId: number | null;
  hoveredCorridorId: number | null;

  // Layout
  isSidebarOpen: boolean;
  isSettingsOpen: boolean;
  isExportOpen: boolean;

  // Theme
  darkMode: boolean;

  // Prompt
  promptText: string;

  // Legend visibility
  hiddenFeatureTypes: FeatureType[];

  // Edit mode
  editMode: boolean;
  activeTool: EditTool;
  editLockedRoomId: number | null;

  // Debug / inspect
  roomIdInspectMode: boolean;

  // Actions
  setPan: (x: number, y: number) => void;
  setZoom: (zoom: number) => void;
  setSelectedRoomId: (id: number | null) => void;
  setHoveredRoomId: (id: number | null) => void;
  setHoveredCorridorId: (id: number | null) => void;
  setPromptText: (text: string) => void;
  toggleSidebar: () => void;
  toggleDarkMode: () => void;
  toggleSettings: () => void;
  setIsSettingsOpen: (v: boolean) => void;
  toggleExport: () => void;
  setIsExportOpen: (v: boolean) => void;
  resetView: () => void;
  toggleFeatureType: (type: FeatureType) => void;
  toggleEditMode: () => void;
  setActiveTool: (tool: EditTool) => void;
  setEditLockedRoomId: (id: number | null) => void;
  toggleRoomIdInspectMode: () => void;
}

const transientDefaults = {
  panX: 0,
  panY: 0,
  zoom: 1,
  selectedRoomId: null as number | null,
  hoveredRoomId: null as number | null,
  hoveredCorridorId: null as number | null,
  isSettingsOpen: false,
  isExportOpen: false,
  editMode: false,
  activeTool: "floor" as EditTool,
  editLockedRoomId: null as number | null,
  roomIdInspectMode: false,
};

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      ...transientDefaults,
      isSidebarOpen: true,
      darkMode: false,
      promptText: "",
      hiddenFeatureTypes: [] as FeatureType[],

      setPan: (x, y) => set({ panX: x, panY: y }),
      setZoom: (zoom) => set({ zoom }),
      setSelectedRoomId: (id) => set({ selectedRoomId: id }),
      setHoveredRoomId: (id) => set({ hoveredRoomId: id }),
      setHoveredCorridorId: (id) => set({ hoveredCorridorId: id }),
      setPromptText: (text) => set({ promptText: text }),
      toggleSidebar: () => set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),
      toggleDarkMode: () => set((state) => ({ darkMode: !state.darkMode })),
      toggleSettings: () => set((state) => ({ isSettingsOpen: !state.isSettingsOpen })),
      setIsSettingsOpen: (v) => set({ isSettingsOpen: v }),
      toggleExport: () => set((state) => ({ isExportOpen: !state.isExportOpen })),
      setIsExportOpen: (v) => set({ isExportOpen: v }),
      resetView: () => set({ ...transientDefaults }),
      toggleFeatureType: (type) => set((state) => ({
        hiddenFeatureTypes: state.hiddenFeatureTypes.includes(type)
          ? state.hiddenFeatureTypes.filter((t) => t !== type)
          : [...state.hiddenFeatureTypes, type],
      })),
      toggleEditMode: () => set((state) => ({ editMode: !state.editMode, editLockedRoomId: null })),
      setActiveTool: (tool) => set({ activeTool: tool }),
      setEditLockedRoomId: (id) => set({ editLockedRoomId: id }),
      toggleRoomIdInspectMode: () => set((state) => ({ roomIdInspectMode: !state.roomIdInspectMode })),
    }),
    {
      name: "dungeon-slop-ui",
      partialize: (state) => ({
        darkMode: state.darkMode,
        isSidebarOpen: state.isSidebarOpen,
        promptText: state.promptText,
      }),
    },
  ),
);
