import { create } from "zustand";
import { api } from "./api.ts";
import type { Campaign, ChatSummary, DungeonSummary } from "../campaign/types.ts";

/**
 * The campaign list and whichever campaign is open.
 *
 * Nothing here is persisted. The database is the source of truth now, and a
 * cached copy in localStorage would be one more thing that can disagree with it
 * after a delete in another tab.
 */
interface CampaignState {
  campaigns: Campaign[];
  isLoading: boolean;
  error: string | null;

  /** The campaign the current route is inside, loaded in full. */
  active: Campaign | null;
  dungeons: DungeonSummary[];
  chats: ChatSummary[];
  isLoadingContents: boolean;

  fetchCampaigns: () => Promise<void>;
  openCampaign: (id: number) => Promise<Campaign | null>;
  refreshContents: (id: number) => Promise<void>;
  createCampaign: (name: string, blurb?: string) => Promise<Campaign | null>;
  deleteDungeon: (id: number) => Promise<boolean>;
  deleteChat: (id: number) => Promise<boolean>;
  renameCampaign: (id: number, name: string) => Promise<void>;
  deleteCampaign: (id: number) => Promise<void>;
  clearActive: () => void;
  setError: (error: string | null) => void;
}

function message(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export const useCampaignStore = create<CampaignState>()((set, get) => ({
  campaigns: [],
  isLoading: false,
  error: null,

  active: null,
  dungeons: [],
  chats: [],
  isLoadingContents: false,

  setError: (error) => set({ error }),

  clearActive: () => set({ active: null, dungeons: [], chats: [] }),

  fetchCampaigns: async () => {
    set({ isLoading: true });
    try {
      set({ campaigns: await api.campaigns.list(), error: null });
    } catch (err) {
      set({ error: message(err, "Could not load campaigns") });
    } finally {
      set({ isLoading: false });
    }
  },

  /**
   * Loads the campaign and its contents together. The rail and the context list
   * both need the contents, so fetching them separately would mean two loading
   * states for one navigation.
   */
  openCampaign: async (id) => {
    if (get().active?.id !== id) set({ active: null, dungeons: [], chats: [] });
    set({ isLoadingContents: true });
    try {
      const [campaign, dungeons, chats] = await Promise.all([
        api.campaigns.get(id),
        api.dungeons.list(id),
        api.chats.list(id),
      ]);
      set({ active: campaign, dungeons, chats, error: null });
      return campaign;
    } catch (err) {
      set({ error: message(err, "Could not open that campaign"), active: null });
      return null;
    } finally {
      set({ isLoadingContents: false });
    }
  },

  /** Re-read the lists without the full-page loading state — used after a write. */
  refreshContents: async (id) => {
    try {
      const [campaign, dungeons, chats] = await Promise.all([
        api.campaigns.get(id),
        api.dungeons.list(id),
        api.chats.list(id),
      ]);
      set({ active: campaign, dungeons, chats });
    } catch (err) {
      set({ error: message(err, "Could not refresh the campaign") });
    }
  },

  createCampaign: async (name, blurb) => {
    try {
      const campaign = await api.campaigns.create({ name, blurb });
      set((state) => ({ campaigns: [campaign, ...state.campaigns], error: null }));
      return campaign;
    } catch (err) {
      set({ error: message(err, "Could not create that campaign") });
      return null;
    }
  },

  /**
   * Deleting a dungeon takes its room notes and its Architect log with it —
   * the cascade is in the schema, so this only has to refresh what is on screen.
   */
  deleteDungeon: async (id) => {
    const campaignId = get().active?.id ?? null;
    try {
      await api.dungeons.remove(id);
      set((state) => ({ dungeons: state.dungeons.filter((d) => d.id !== id), error: null }));
      if (campaignId !== null) void get().refreshContents(campaignId);
      return true;
    } catch (err) {
      set({ error: message(err, "Could not delete that dungeon") });
      return false;
    }
  },

  deleteChat: async (id) => {
    const campaignId = get().active?.id ?? null;
    try {
      await api.chats.remove(id);
      set((state) => ({ chats: state.chats.filter((c) => c.id !== id), error: null }));
      if (campaignId !== null) void get().refreshContents(campaignId);
      return true;
    } catch (err) {
      set({ error: message(err, "Could not delete that thread") });
      return false;
    }
  },

  renameCampaign: async (id, name) => {
    try {
      const campaign = await api.campaigns.update(id, { name });
      set((state) => ({
        campaigns: state.campaigns.map((c) => (c.id === id ? campaign : c)),
        active: state.active?.id === id ? campaign : state.active,
        error: null,
      }));
    } catch (err) {
      set({ error: message(err, "Could not rename that campaign") });
    }
  },

  deleteCampaign: async (id) => {
    try {
      await api.campaigns.remove(id);
      set((state) => ({
        campaigns: state.campaigns.filter((c) => c.id !== id),
        ...(state.active?.id === id ? { active: null, dungeons: [], chats: [] } : {}),
        error: null,
      }));
    } catch (err) {
      set({ error: message(err, "Could not delete that campaign") });
    }
  },
}));
