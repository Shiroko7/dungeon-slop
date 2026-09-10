import { roomName } from "../../engine/room-name.ts";
import { useEffect, useState } from "react";
import { useDungeonStore } from "../../store/dungeon-store.ts";
import { useChatStore } from "../../store/chat-store.ts";
import { useUIStore } from "../../store/ui-store.ts";
import { useCampaignStore } from "../../store/campaign-store.ts";
import { ChatThread } from "../shared/ChatThread.tsx";
import { ConfigReadout } from "../input/ConfigReadout.tsx";
import { useArchitect } from "../views/useArchitect.ts";
import { linkProps, navigate, paths } from "../../router/router.ts";
import { countLine, useConfirm } from "../shared/ConfirmDialog.tsx";

type Tab = "rooms" | "architect";

function RoomsTab({ campaignId, dungeonId }: { campaignId: number; dungeonId: number }) {
  const dungeon = useDungeonStore((s) => s.dungeon);
  const roomDescriptions = useDungeonStore((s) => s.roomDescriptions);
  const selectedRoomId = useUIStore((s) => s.selectedRoomId);
  const setSelectedRoomId = useUIStore((s) => s.setSelectedRoomId);

  if (dungeon === null) {
    return <p className="ctx-empty">No map yet. Describe one in the Architect tab.</p>;
  }

  return (
    <div className="room-strip">
      {dungeon.rooms.map((room) => {
        const desc = roomDescriptions.get(room.id) ?? room.description;
        const name = roomName(room, desc);
        return (
          <a
            key={room.id}
            className={`room-strip-item${room.id === selectedRoomId ? " is-active" : ""}${
              desc ? " is-written" : ""
            }`}
            href={paths.room(campaignId, dungeonId, room.id)}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
              e.preventDefault();
              setSelectedRoomId(room.id);
              navigate(paths.room(campaignId, dungeonId, room.id));
            }}
          >
            <span className="room-strip-n">{room.id}</span>
            <span className="room-strip-name" title={name}>
              {name}
            </span>
            {desc && <span className="room-strip-mark">✓</span>}
          </a>
        );
      })}
    </div>
  );
}

function ArchitectTab({ campaignId, dungeonId }: { campaignId: number; dungeonId: number }) {
  const chat = useChatStore((s) => s.chat);
  const truncateFrom = useChatStore((s) => s.truncateFrom);
  const isGeneratingConfig = useDungeonStore((s) => s.isGeneratingConfig);
  const configRawText = useDungeonStore((s) => s.configRawText);
  const config = useDungeonStore((s) => s.config);
  const clarification = useDungeonStore((s) => s.clarificationQuestion);
  const refreshContents = useCampaignStore((s) => s.refreshContents);

  const [configOpen, setConfigOpen] = useState(false);
  const ask = useArchitect();

  const isArchitectThread = chat !== null && chat.dungeonId === dungeonId;

  return (
    <ChatThread
      messages={isArchitectThread ? chat.messages : []}
      isBusy={isGeneratingConfig}
      streamingText={configRawText}
      emptyTitle="Describe your dungeon"
      emptyHint="A flooded crypt under a salt marsh, twelve rooms, one secret vault."
      placeholder={clarification !== null ? "Type your reply…" : "Describe your dungeon… (Ctrl+Enter)"}
      onSend={(text) => void ask(text).then(() => refreshContents(campaignId))}
      onEdit={(index) => void truncateFrom(index)}
      disabled={!isArchitectThread}
      footer={
        config !== null && !isGeneratingConfig ? (
          <div className="chat-config-card">
            <button className="chat-config-card-header" onClick={() => setConfigOpen((v) => !v)}>
              <span>⚙ Config</span>
              <span>{configOpen ? "▲" : "▼"}</span>
            </button>
            {configOpen && <ConfigReadout />}
          </div>
        ) : null
      }
      hint={
        clarification !== null && !isGeneratingConfig ? (
          <div className="chat-clarification-hint">Reply below to answer ↓</div>
        ) : null
      }
    />
  );
}

/**
 * The middle column inside a dungeon.
 *
 * Rooms and the Architect are both dungeon-scoped and compete for the same
 * attention, so they are tabs rather than two stacked panels — which is what
 * the old sidebar did, and why nothing in it was ever fully visible.
 */
export function DungeonContext({ campaignId, dungeonId }: { campaignId: number; dungeonId: number }) {
  const name = useDungeonStore((s) => s.name);
  const dungeon = useDungeonStore((s) => s.dungeon);
  const describedCount = useDungeonStore((s) => s.roomDescriptions.size);
  const rename = useDungeonStore((s) => s.rename);
  const openArchitect = useChatStore((s) => s.openArchitect);
  const refreshContents = useCampaignStore((s) => s.refreshContents);
  const deleteDungeon = useCampaignStore((s) => s.deleteDungeon);
  const campaignName = useCampaignStore((s) => s.active?.name ?? "Campaign");

  const [tab, setTab] = useState<Tab>("rooms");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const { ask, dialog } = useConfirm();

  useEffect(() => {
    void openArchitect(dungeonId);
  }, [dungeonId, openArchitect]);

  // A map with no geometry has nothing to list, so open on the tab that can
  // actually produce one.
  useEffect(() => {
    setTab(dungeon === null ? "architect" : "rooms");
  }, [dungeon === null]);

  const commit = (): void => {
    const trimmed = draft.trim();
    setEditing(false);
    if (trimmed !== "" && trimmed !== name) {
      void rename(trimmed).then(() => refreshContents(campaignId));
    }
  };

  const remove = async (): Promise<void> => {
    const confirmed = await ask({
      title: `Delete "${name === "" ? "this map" : name}"?`,
      body: "The map and everything written on it goes.",
      consequences: [
        countLine(dungeon?.rooms.length ?? 0, "room"),
        countLine(describedCount, "written room description"),
        "its Architect build log",
      ].filter((line): line is string => line !== null),
    });
    if (!confirmed) return;
    if (await deleteDungeon(dungeonId)) navigate(paths.campaign(campaignId));
  };

  return (
    <aside className="ctx-panel ctx-panel--dungeon">
      <header className="ctx-head">
        <a
          className="ctx-back"
          {...linkProps(paths.campaign(campaignId))}
          title={`Back to ${campaignName}`}
        >
          ← {campaignName}
        </a>
        <button
          className="ctx-head-remove"
          title="Delete this dungeon"
          aria-label="Delete this dungeon"
          onClick={() => void remove()}
        >
          &times;
        </button>
      </header>

      <div className="ctx-dungeon-name">
        {editing ? (
          <input
            className="ctx-name-input"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : (
          <button
            className="ctx-name-button"
            title="Click to rename"
            onClick={() => {
              setDraft(name);
              setEditing(true);
            }}
          >
            {name === "" ? "Untitled map" : name}
          </button>
        )}
      </div>

      <div className="ctx-tabs" role="tablist">
        <button
          className={`ctx-tab${tab === "rooms" ? " is-active" : ""}`}
          role="tab"
          aria-selected={tab === "rooms"}
          onClick={() => setTab("rooms")}
        >
          Rooms
          {dungeon !== null && <span className="ctx-tab-count">{dungeon.rooms.length}</span>}
        </button>
        <button
          className={`ctx-tab${tab === "architect" ? " is-active" : ""}`}
          role="tab"
          aria-selected={tab === "architect"}
          onClick={() => setTab("architect")}
        >
          Architect
        </button>
      </div>

      <div className="ctx-tab-body">
        {tab === "rooms" ? (
          <>
            <RoomsTab campaignId={campaignId} dungeonId={dungeonId} />
            {dungeon !== null && (
              <div className="ctx-tab-footer">
                {describedCount} of {dungeon.rooms.length} written
              </div>
            )}
          </>
        ) : (
          <ArchitectTab campaignId={campaignId} dungeonId={dungeonId} />
        )}
      </div>
      {dialog}
    </aside>
  );
}
