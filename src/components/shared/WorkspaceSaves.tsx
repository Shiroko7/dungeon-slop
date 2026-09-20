import { useEffect, useState, useSyncExternalStore } from "react";
import { dungeonSaves } from "../../store/dungeon-saves.ts";
import {
  dungeonOperations,
  useDungeonStore,
} from "../../store/dungeon-store.ts";
import { api } from "../../store/api.ts";
import { type PendingSave } from "../../store/save-coordinator.ts";
import type { DungeonRecord } from "../../campaign/types.ts";
import { linkProps, paths } from "../../router/router.ts";
import "./workspace-saves.css";

function download(entry: PendingSave) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(entry, null, 2)], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `dungeon-${entry.dungeonId}-unsaved.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const labels = {
  saved: "Saved",
  unsaved: "Unsaved",
  saving: "Saving…",
  failed: "Save failed",
  conflict: "Save conflict",
  recovery: "Recovery pending",
};
export function WorkspaceSaves() {
  useSyncExternalStore(dungeonSaves.subscribe, dungeonSaves.snapshot);
  const [, storageChanged] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [server, setServer] = useState<DungeonRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useDungeonStore((s) => s.dungeonId);
  const generating = useDungeonStore(
    (s) =>
      s.isGeneratingConfig ||
      s.isGeneratingBlueprint ||
      s.isGeneratingDungeon ||
      s.isDescribingRooms ||
      s.isDescribingDungeon ||
      s.isRefining,
  );
  useEffect(() => {
    const listener = () => storageChanged((v) => v + 1);
    window.addEventListener("storage", listener);
    return () => window.removeEventListener("storage", listener);
  }, []);
  const entries = dungeonSaves.pendingEntries().filter((entry) => {
    const state = dungeonSaves.state(entry.dungeonId);
    return (
      entry.dungeonId !== id ||
      !state.durable ||
      state.status === "failed" ||
      state.status === "conflict"
    );
  });
  const recoveries = dungeonSaves.recoveries();
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Recovery failed");
    } finally {
      setBusy(false);
    }
  };
  const reopen = async (ownerId: number) => {
    if (useDungeonStore.getState().dungeonId !== ownerId) return;
    useDungeonStore.getState().closeDungeon();
    await useDungeonStore.getState().loadDungeon(ownerId);
  };
  return (
    <section className="workspace-saves" aria-label="Save and recovery status">
      <div role="status" aria-live="polite">
        {id !== null && <span>{labels[dungeonSaves.state(id).status]}</span>}
        {generating && (
          <button
            onClick={() => dungeonOperations.cancel()}
            title="Stops further work; provider work already performed may still be charged."
          >
            Cancel generation
          </button>
        )}
      </div>
      {entries.map((entry) => {
        const state = dungeonSaves.state(entry.dungeonId);
        return (
          <div key={entry.key} className="save-recovery">
            <a {...linkProps(paths.dungeon(entry.campaignId, entry.dungeonId))}>
              {entry.name || "Untitled map"}
            </a>
            {" — "}
            {labels[state.status]}
            {state.error && <p role="alert">{state.error}</p>}
            <small>
              {state.durable
                ? "Pending edits retained in this browser."
                : "Not retained locally. Keep this tab open until Saved, or export a copy."}
            </small>
            <button onClick={() => download(entry)}>Export local copy</button>
            {state.status === "failed" || state.status === "unsaved" ? (
              <button
                disabled={busy}
                onClick={() =>
                  void run(() => dungeonSaves.flush(entry.dungeonId))
                }
              >
                Retry save
              </button>
            ) : null}
            {state.status === "conflict" && (
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () =>
                    setServer(await api.dungeons.get(entry.dungeonId)),
                  )
                }
              >
                Review server version
              </button>
            )}
            {state.status === "conflict" && (
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    if (
                      !window.confirm(
                        "Permanently discard this pending copy? Export it first if the dungeon was deleted.",
                      )
                    )
                      return;
                    await dungeonSaves.discard(entry);
                    await reopen(entry.dungeonId);
                  })
                }
              >
                Discard pending copy
              </button>
            )}
          </div>
        );
      })}
      {recoveries.length > 0 && (
        <details>
          <summary>
            {recoveries.length} pending recovery{" "}
            {recoveries.length === 1 ? "copy" : "copies"} (possibly from another
            open tab)
          </summary>
          {recoveries.map((entry) => (
            <div key={entry.key} className="save-recovery">
              <span>
                {entry.name || `Dungeon ${entry.dungeonId}`}, based on revision{" "}
                {entry.revision}
              </span>
              <button onClick={() => download(entry)}>Export local copy</button>
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await dungeonSaves.recover(entry);
                    await reopen(entry.dungeonId);
                  })
                }
              >
                Recover and retry safely
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    if (
                      window.confirm("Permanently discard this recovery copy?")
                    )
                      await dungeonSaves.discard(entry);
                  })
                }
              >
                Discard recovery copy
              </button>
            </div>
          ))}
        </details>
      )}
      {error && <p role="alert">{error}</p>}
      {server && (
        <div
          className="save-recovery"
          role="region"
          aria-label="Resolve save conflict"
        >
          <h3>
            Server version: {server.name} · revision {server.revision}
          </h3>
          <p>
            Keep local edits replaces the corresponding server fields. Export
            the local copy before discarding it.
          </p>
          <details>
            <summary>Inspect server content</summary>
            <pre>{JSON.stringify(server, null, 2)}</pre>
          </details>
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                if (
                  !window.confirm(
                    "Discard this tab's pending edits and load the server version?",
                  )
                )
                  return;
                await dungeonSaves.reload(server.id);
                await reopen(server.id);
                setServer(null);
              })
            }
          >
            Discard local edits and reload
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                if (
                  !window.confirm(
                    "Replace the corresponding server fields with your local edits?",
                  )
                )
                  return;
                await dungeonSaves.keepLocal(server.id, server.revision);
                await reopen(server.id);
                setServer(null);
              })
            }
          >
            Keep local edits
          </button>
          <button onClick={() => setServer(null)}>Decide later</button>
        </div>
      )}
    </section>
  );
}
