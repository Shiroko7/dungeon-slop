import { useCallback, useState } from "react";
import { useCampaignStore } from "../../store/campaign-store.ts";
import { api } from "../../store/api.ts";
import {
  captureNavigation,
  linkProps,
  navigate,
  paths,
} from "../../router/router.ts";
import { LoadingSpinner } from "../shared/LoadingSpinner.tsx";
import { countLine, useConfirm } from "../shared/ConfirmDialog.tsx";

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function present(lines: Array<string | null>): string[] {
  return lines.filter((line): line is string => line !== null);
}

export function CampaignHome({ campaignId }: { campaignId: number }) {
  const active = useCampaignStore((s) => s.active);
  const dungeons = useCampaignStore((s) => s.dungeons);
  const chats = useCampaignStore((s) => s.chats);
  const isLoading = useCampaignStore((s) => s.isLoadingContents);
  const refreshContents = useCampaignStore((s) => s.refreshContents);
  const renameCampaign = useCampaignStore((s) => s.renameCampaign);
  const deleteCampaign = useCampaignStore((s) => s.deleteCampaign);
  const deleteDungeon = useCampaignStore((s) => s.deleteDungeon);
  const deleteChat = useCampaignStore((s) => s.deleteChat);

  const { ask, dialog } = useConfirm();
  const [busy, setBusy] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");

  const described = dungeons.reduce((sum, d) => sum + d.describedCount, 0);

  const newDungeon = useCallback(async () => {
    if (busy) return;
    const stillHere = captureNavigation();
    setBusy(true);
    try {
      const dungeon = await api.dungeons.create(campaignId, {
        name: "Untitled map",
      });
      await refreshContents(campaignId);
      if (stillHere()) navigate(paths.dungeon(campaignId, dungeon.id));
    } catch (err) {
      if (stillHere())
        useCampaignStore
          .getState()
          .setError(err instanceof Error ? err.message : "Could not create");
    } finally {
      setBusy(false);
    }
  }, [campaignId, busy, refreshContents]);

  const newChat = useCallback(async () => {
    if (busy) return;
    const stillHere = captureNavigation();
    setBusy(true);
    try {
      const chat = await api.chats.create(campaignId);
      await refreshContents(campaignId);
      if (stillHere()) navigate(paths.chat(campaignId, chat.id));
    } catch (err) {
      if (stillHere())
        useCampaignStore
          .getState()
          .setError(err instanceof Error ? err.message : "Could not create");
    } finally {
      setBusy(false);
    }
  }, [campaignId, busy, refreshContents]);

  const removeDungeon = useCallback(
    async (id: number, name: string, rooms: number, written: number) => {
      const confirmed = await ask({
        title: `Delete "${name}"?`,
        body: "The map and everything written on it goes.",
        consequences: present([
          countLine(rooms, "room"),
          countLine(written, "written room description"),
          "its Architect build log",
        ]),
      });
      if (confirmed) await deleteDungeon(id);
    },
    [ask, deleteDungeon],
  );

  const removeChat = useCallback(
    async (id: number, title: string, messages: number) => {
      const confirmed = await ask({
        title: `Delete "${title === "" ? "Untitled thread" : title}"?`,
        body: "Only the transcript is lost — your notes are untouched.",
        consequences: present([countLine(messages, "message")]),
      });
      if (confirmed) await deleteChat(id);
    },
    [ask, deleteChat],
  );

  /**
   * The whole-campaign delete. It states real counts, because this is the one
   * action in the app that can destroy an evening of work in a single click,
   * and a prompt that only asks "are you sure?" teaches people to click through.
   */
  const removeCampaign = useCallback(async () => {
    if (active === null) return;
    const confirmed = await ask({
      title: `Delete "${active.name}"?`,
      body: "Everything inside the campaign goes with it.",
      consequences: present([
        countLine(active.noteCount, "indexed note"),
        countLine(dungeons.length, "dungeon"),
        countLine(chats.length, "chat thread"),
        countLine(described, "written room description"),
      ]),
      confirmLabel: "Delete campaign",
    });
    if (!confirmed) return;
    await deleteCampaign(active.id);
    navigate(paths.picker());
  }, [ask, active, dungeons.length, chats.length, described, deleteCampaign]);

  const commitName = useCallback(() => {
    const trimmed = nameDraft.trim();
    setEditingName(false);
    if (trimmed !== "" && trimmed !== active?.name)
      void renameCampaign(campaignId, trimmed);
  }, [nameDraft, active?.name, campaignId, renameCampaign]);

  if (active === null) {
    return (
      <div className="home home--loading">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="home">
      <header className="home-head">
        {editingName ? (
          <input
            className="home-title-input"
            value={nameDraft}
            autoFocus
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitName();
              if (e.key === "Escape") setEditingName(false);
            }}
          />
        ) : (
          <h1
            className="home-title"
            title="Click to rename"
            onClick={() => {
              setNameDraft(active.name);
              setEditingName(true);
            }}
          >
            {active.name}
          </h1>
        )}

        {active.blurb !== "" && <p className="home-blurb">{active.blurb}</p>}

        <div className="home-stats">
          <a className="home-stat" {...linkProps(paths.notes(campaignId))}>
            <span className="home-stat-n">{active.noteCount}</span>
            <span className="home-stat-l">notes</span>
          </a>
          <div className="home-stat">
            <span className="home-stat-n">{dungeons.length}</span>
            <span className="home-stat-l">dungeons</span>
          </div>
          <div className="home-stat">
            <span className="home-stat-n">{chats.length}</span>
            <span className="home-stat-l">chats</span>
          </div>
          <div className="home-stat">
            <span className="home-stat-n">{described}</span>
            <span className="home-stat-l">rooms written</span>
          </div>
        </div>
      </header>

      <section className="home-section">
        <div className="home-section-head">
          <h2 className="home-section-title">Dungeons</h2>
          {isLoading && <LoadingSpinner size={12} />}
        </div>

        <div className="home-cards">
          {dungeons.map((d) => (
            <div key={d.id} className="home-card-wrap">
              <a
                className="home-card"
                {...linkProps(paths.dungeon(campaignId, d.id))}
              >
                <span className="home-card-name">{d.name}</span>
                <span className="home-card-meta">
                  {d.hasGeometry ? `${d.roomCount} rooms` : "no map yet"}
                  {d.describedCount > 0 && ` · ${d.describedCount} written`}
                </span>
                {d.parentId !== null && (
                  <span className="home-card-tag">fork</span>
                )}
                <span className="home-card-time">
                  {relativeTime(d.updatedAt)}
                </span>
              </a>
              <button
                className="home-card-remove"
                title={`Delete ${d.name}`}
                aria-label={`Delete ${d.name}`}
                onClick={() =>
                  void removeDungeon(
                    d.id,
                    d.name,
                    d.roomCount,
                    d.describedCount,
                  )
                }
              >
                &times;
              </button>
            </div>
          ))}

          <button
            className="home-card home-card--new"
            onClick={() => void newDungeon()}
            disabled={busy}
          >
            <span className="home-new-plus">+</span>
            <span className="home-new-label">New dungeon</span>
          </button>
        </div>
      </section>

      <section className="home-section">
        <div className="home-section-head">
          <h2 className="home-section-title">Chats</h2>
        </div>

        {chats.length === 0 ? (
          <p className="home-empty">
            No threads yet. A chat asks questions of this campaign's notes.
          </p>
        ) : (
          <ul className="home-list">
            {chats.map((c) => (
              <li key={c.id} className="home-list-row">
                <a
                  className="home-list-item"
                  {...linkProps(paths.chat(campaignId, c.id))}
                >
                  <span className="home-list-name">
                    {c.title === "" ? "Untitled thread" : c.title}
                  </span>
                  <span className="home-list-meta">
                    {c.messageCount} messages · {relativeTime(c.updatedAt)}
                  </span>
                </a>
                <button
                  className="home-list-remove"
                  title="Delete thread"
                  aria-label="Delete thread"
                  onClick={() => void removeChat(c.id, c.title, c.messageCount)}
                >
                  &times;
                </button>
              </li>
            ))}
          </ul>
        )}

        <button
          className="home-inline-action"
          onClick={() => void newChat()}
          disabled={busy}
        >
          + New chat
        </button>
      </section>

      <section className="home-danger">
        <h2 className="home-section-title">Danger zone</h2>
        <p className="home-danger-body">
          Deleting this campaign removes its notes, dungeons and chats together.
          Nothing is kept, and there is no undo.
        </p>
        <button
          className="home-danger-action"
          onClick={() => void removeCampaign()}
        >
          Delete campaign
        </button>
      </section>

      {dialog}
    </div>
  );
}
