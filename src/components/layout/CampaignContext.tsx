import { useCallback, useState } from "react";
import { useCampaignStore } from "../../store/campaign-store.ts";
import { api } from "../../store/api.ts";
import { linkProps, navigate, paths, type Route } from "../../router/router.ts";
import { LoadingSpinner } from "../shared/LoadingSpinner.tsx";
import { countLine, useConfirm } from "../shared/ConfirmDialog.tsx";

function Group({
  title,
  count,
  open,
  onToggle,
  action,
  children,
}: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  action?: { label: string; onClick: () => void };
  children: React.ReactNode;
}) {
  return (
    <section className="ctx-group">
      <div className="ctx-group-head">
        <button className="ctx-group-toggle" onClick={onToggle} aria-expanded={open}>
          <span className="ctx-group-chevron">{open ? "▾" : "▸"}</span>
          <span className="ctx-group-title">{title}</span>
          <span className="ctx-group-count">{count}</span>
        </button>
        {action !== undefined && (
          <button className="ctx-group-action" onClick={action.onClick} title={action.label}>
            +
          </button>
        )}
      </div>
      {open && <div className="ctx-group-body">{children}</div>}
    </section>
  );
}

/**
 * The middle column while a campaign is open: everything the campaign owns, at
 * one level of nesting. Dungeons and chats are siblings here because they are
 * siblings in the model — neither contains the other.
 */
export function CampaignContext({ route }: { route: Route }) {
  const active = useCampaignStore((s) => s.active);
  const dungeons = useCampaignStore((s) => s.dungeons);
  const chats = useCampaignStore((s) => s.chats);
  const isLoading = useCampaignStore((s) => s.isLoadingContents);
  const refreshContents = useCampaignStore((s) => s.refreshContents);
  const deleteDungeon = useCampaignStore((s) => s.deleteDungeon);
  const deleteChat = useCampaignStore((s) => s.deleteChat);

  const [openDungeons, setOpenDungeons] = useState(true);
  const [openChats, setOpenChats] = useState(true);
  const [busy, setBusy] = useState(false);
  const { ask, dialog } = useConfirm();

  const campaignId = active?.id ?? null;
  const openDungeonId = route.view === "dungeon" ? route.dungeonId : null;
  const openChatId = route.view === "chat" ? route.chatId : null;

  const newDungeon = useCallback(async () => {
    if (campaignId === null || busy) return;
    setBusy(true);
    try {
      const dungeon = await api.dungeons.create(campaignId, { name: "Untitled map" });
      await refreshContents(campaignId);
      navigate(paths.dungeon(campaignId, dungeon.id));
    } finally {
      setBusy(false);
    }
  }, [campaignId, busy, refreshContents]);

  const newChat = useCallback(async () => {
    if (campaignId === null || busy) return;
    setBusy(true);
    try {
      const chat = await api.chats.create(campaignId);
      await refreshContents(campaignId);
      navigate(paths.chat(campaignId, chat.id));
    } finally {
      setBusy(false);
    }
  }, [campaignId, busy, refreshContents]);

  /** Deleting what is currently open would strand the route, so step back first. */
  const removeDungeon = useCallback(
    async (id: number, name: string, rooms: number, written: number) => {
      const confirmed = await ask({
        title: `Delete "${name}"?`,
        body: "The map and everything written on it goes.",
        consequences: [
          countLine(rooms, "room"),
          countLine(written, "written room description"),
          "its Architect build log",
        ].filter((line): line is string => line !== null),
      });
      if (!confirmed) return;
      const ok = await deleteDungeon(id);
      if (ok && campaignId !== null && id === openDungeonId) {
        navigate(paths.campaign(campaignId));
      }
    },
    [ask, deleteDungeon, campaignId, openDungeonId],
  );

  const removeChat = useCallback(
    async (id: number, title: string, messages: number) => {
      const confirmed = await ask({
        title: `Delete "${title === "" ? "Untitled thread" : title}"?`,
        body: "Only the transcript is lost — your notes are untouched.",
        consequences: [countLine(messages, "message")].filter(
          (line): line is string => line !== null,
        ),
      });
      if (!confirmed) return;
      const ok = await deleteChat(id);
      if (ok && campaignId !== null && id === openChatId) {
        navigate(paths.campaign(campaignId));
      }
    },
    [ask, deleteChat, campaignId, openChatId],
  );

  if (campaignId === null) return null;

  return (
    <aside className="ctx-panel">
      <header className="ctx-head">
        <a className="ctx-campaign-name" {...linkProps(paths.campaign(campaignId))}>
          {active?.name}
        </a>
        {isLoading && <LoadingSpinner size={12} />}
      </header>

      <div className="ctx-scroll">
        <Group
          title="Dungeons"
          count={dungeons.length}
          open={openDungeons}
          onToggle={() => setOpenDungeons((v) => !v)}
          action={{ label: "New dungeon", onClick: () => void newDungeon() }}
        >
          {dungeons.length === 0 ? (
            <p className="ctx-empty">No maps yet.</p>
          ) : (
            dungeons.map((d) => (
              <div key={d.id} className="ctx-row">
                <a
                  className={`ctx-item${d.id === openDungeonId ? " is-active" : ""}`}
                  {...linkProps(paths.dungeon(campaignId, d.id))}
                >
                  <span className="ctx-item-name" title={d.name}>
                    {d.parentId !== null && (
                      <span className="ctx-fork-mark" title="Forked from a reroll">
                        ⑂
                      </span>
                    )}
                    {d.name}
                  </span>
                  <span className="ctx-item-meta">
                    {d.hasGeometry ? `${d.roomCount} rooms` : "empty"}
                    {d.describedCount > 0 && ` · ${d.describedCount} written`}
                  </span>
                </a>
                <button
                  className="ctx-row-remove"
                  title={`Delete ${d.name}`}
                  aria-label={`Delete ${d.name}`}
                  onClick={() => void removeDungeon(d.id, d.name, d.roomCount, d.describedCount)}
                >
                  &times;
                </button>
              </div>
            ))
          )}
        </Group>

        <Group
          title="Chats"
          count={chats.length}
          open={openChats}
          onToggle={() => setOpenChats((v) => !v)}
          action={{ label: "New chat", onClick: () => void newChat() }}
        >
          {chats.length === 0 ? (
            <p className="ctx-empty">No threads yet.</p>
          ) : (
            chats.map((c) => (
              <div key={c.id} className="ctx-row">
                <a
                  className={`ctx-item${c.id === openChatId ? " is-active" : ""}`}
                  {...linkProps(paths.chat(campaignId, c.id))}
                >
                  <span className="ctx-item-name" title={c.title}>
                    {c.title === "" ? "Untitled thread" : c.title}
                  </span>
                  <span className="ctx-item-meta">{c.messageCount} messages</span>
                </a>
                <button
                  className="ctx-row-remove"
                  title="Delete thread"
                  aria-label="Delete thread"
                  onClick={() => void removeChat(c.id, c.title, c.messageCount)}
                >
                  &times;
                </button>
              </div>
            ))
          )}
        </Group>

        <a
          className={`ctx-notes-link${route.view === "notes" ? " is-active" : ""}`}
          {...linkProps(paths.notes(campaignId))}
        >
          <span className="ctx-group-title">Notes</span>
          <span className="ctx-group-count">{active?.noteCount ?? 0}</span>
        </a>
      </div>
      {dialog}
    </aside>
  );
}
