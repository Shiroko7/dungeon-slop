/**
 * Client view of the asset library: the list (fetched once, refreshable),
 * favourites (stored in the library as a tag) and recently used textures
 * (this browser only).
 */
import { create } from "zustand";

export interface AssetSummary {
  id: string;
  kind: string;
  subject: string;
  style: string;
  motif: string;
  width: number;
  height: number;
  tileable: boolean;
  alpha: boolean;
  tags: string[];
  status: string;
  favorite: boolean;
  createdAt: string;
}

const RECENTS_KEY = "dungeon-slop-recent-textures";
const RECENTS_MAX = 12;

function loadRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function thumbUrl(id: string, size = 192): string {
  return `/api/assets/${encodeURIComponent(id)}/thumb.png?size=${size}`;
}

/** The variant set an asset belongs to (itself first), or just itself. */
export function variantSetOf(assets: AssetSummary[], id: string): string[] {
  const tag = assets.find((a) => a.id === id)?.tags.find((t) => t.startsWith("variant-of-"));
  if (!tag) return [id];
  return [id, ...assets.filter((a) => a.id !== id && a.tags.includes(tag)).map((a) => a.id)];
}

/** Short human label: the asset's subject, cut at the first clause. */
export function assetTitle(a: Pick<AssetSummary, "subject">): string {
  const first = a.subject.split(/[:,.]/)[0]!.trim();
  const t = first.length > 0 ? first : a.subject;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

interface AssetState {
  assets: AssetSummary[];
  loaded: boolean;
  error: string | null;
  recents: string[];
  load: (force?: boolean) => Promise<void>;
  setFavorite: (id: string, favorite: boolean) => Promise<void>;
  touchRecent: (id: string) => void;
}

export const useAssetStore = create<AssetState>((set, get) => ({
  assets: [],
  loaded: false,
  error: null,
  recents: loadRecents(),
  load: async (force = false) => {
    if (get().loaded && !force) return;
    try {
      const r = await fetch("/api/assets");
      if (!r.ok) throw new Error(`asset list failed (${r.status})`);
      const j = (await r.json()) as { assets: AssetSummary[] };
      set({ assets: j.assets, loaded: true, error: null });
    } catch (e) {
      set({ error: (e as Error).message, loaded: true });
    }
  },
  setFavorite: async (id, favorite) => {
    set({ assets: get().assets.map((a) => (a.id === id ? { ...a, favorite } : a)) });
    const r = await fetch(`/api/assets/${encodeURIComponent(id)}/favorite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ favorite }),
    }).catch(() => null);
    if (!r?.ok) set({ assets: get().assets.map((a) => (a.id === id ? { ...a, favorite: !favorite } : a)) });
  },
  touchRecent: (id) => {
    const recents = [id, ...get().recents.filter((r) => r !== id)].slice(0, RECENTS_MAX);
    set({ recents });
    try {
      localStorage.setItem(RECENTS_KEY, JSON.stringify(recents));
    } catch {
      /* private mode: recents just don't persist */
    }
  },
}));
