import { api } from "../store/api.ts";

/**
 * The one-shot move out of localStorage.
 *
 * Everything the app owned used to live in two browser keys. The database can't
 * read those, so the browser reads them once, posts them, and then clears them.
 * The server records that it has run, so a second tab or a second machine
 * pointed at the same database imports nothing and duplicates nothing.
 */

const DUNGEON_KEY = "dungeon-slop-dungeon";
const HISTORY_KEY = "dungeon-slop-history";

interface PersistedEnvelope {
  state?: Record<string, unknown>;
}

function readKey(key: string): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as PersistedEnvelope;
    return parsed.state ?? null;
  } catch {
    // A corrupt or blocked key is not worth failing a boot over; there is
    // simply nothing to import from it.
    return null;
  }
}

export interface ImportOutcome {
  imported: number;
  campaignId: number | null;
  dungeonId: number | null;
}

export async function runLegacyImport(): Promise<ImportOutcome | null> {
  let status: { done: boolean; campaigns: number };
  try {
    status = await api.legacy.status();
  } catch {
    return null;
  }
  if (status.done) {
    clearLegacyKeys();
    return null;
  }

  const dungeonState = readKey(DUNGEON_KEY);
  const historyState = readKey(HISTORY_KEY);

  const current =
    dungeonState === null
      ? null
      : {
          config: dungeonState["config"] ?? null,
          dungeon: dungeonState["dungeon"] ?? null,
          overview: dungeonState["dungeonDescription"] ?? null,
          roomDescriptions: dungeonState["roomDescriptions"] ?? [],
          conversationHistory: dungeonState["conversationHistory"] ?? [],
        };

  const history = Array.isArray(historyState?.["past"]) ? historyState["past"] : [];

  if (current?.dungeon == null && history.length === 0) {
    // Nothing to move. Still tell the server, so it stops asking.
    try {
      await api.legacy.run({ current: null, history: [] });
    } catch {
      return null;
    }
    clearLegacyKeys();
    return null;
  }

  try {
    const result = await api.legacy.run({ current, history });
    clearLegacyKeys();
    return {
      imported: result.imported,
      campaignId: result.campaignId ?? null,
      dungeonId: result.currentDungeonId ?? null,
    };
  } catch {
    // Leave the keys alone on failure — they are the only copy until the
    // import succeeds.
    return null;
  }
}

function clearLegacyKeys(): void {
  try {
    localStorage.removeItem(DUNGEON_KEY);
    localStorage.removeItem(HISTORY_KEY);
  } catch {
    /* blocked storage; nothing to clean */
  }
}
