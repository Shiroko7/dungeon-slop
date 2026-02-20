import { create } from "zustand";
import { persist } from "zustand/middleware";

export type EditTool =
  | "select" | "room" | "paint" | "erase"
  | "door" | "locked_door" | "secret_door" | "portcullis" | "archway" | "trapped_door"
  | "trap" | "treasure" | "stairs_up" | "stairs_down";

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

  // Edit mode
  editMode: boolean;
  activeTool: EditTool;
  paintRoomId: number | null;   // explicitly locked room (null = auto-infer)
  paintRoomLocked: boolean;     // whether paintRoomId was manually locked

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
  setEditMode: (v: boolean) => void;
  setActiveTool: (tool: EditTool) => void;
  lockPaintRoom: (id: number) => void;
  unlockPaintRoom: () => void;
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
};

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      ...transientDefaults,
      isSidebarOpen: true,
      darkMode: false,
      promptText: "",
      editMode: false,
      activeTool: "select" as EditTool,
      paintRoomId: null as number | null,
      paintRoomLocked: false,

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
      setEditMode: (v) => set({ editMode: v, activeTool: "select", paintRoomId: null, paintRoomLocked: false }),
      setActiveTool: (tool) => set({ activeTool: tool }),
      lockPaintRoom: (id) => set({ paintRoomId: id, paintRoomLocked: true }),
      unlockPaintRoom: () => set({ paintRoomId: null, paintRoomLocked: false }),
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
