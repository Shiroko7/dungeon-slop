import { WorkspaceSaves } from "../shared/WorkspaceSaves.tsx";
import { useNotesStore } from "../../store/notes-store.ts";
import { useEffect } from "react";
import { useCampaignStore } from "../../store/campaign-store.ts";
import { useDungeonStore } from "../../store/dungeon-store.ts";
import { useChatStore } from "../../store/chat-store.ts";
import { useUIStore } from "../../store/ui-store.ts";
import { campaignOf, linkProps, paths, useRoute } from "../../router/router.ts";
import { Rail } from "./Rail.tsx";
import { CampaignContext } from "./CampaignContext.tsx";
import { DungeonContext } from "./DungeonContext.tsx";
import { CampaignPicker } from "../views/CampaignPicker.tsx";
import { CampaignHome } from "../views/CampaignHome.tsx";
import { NotesView } from "../views/NotesView.tsx";
import { NoteReaderView } from "../views/NoteReaderView.tsx";
import { useNoteSearchStore } from "../../store/note-search-store.ts";
import { UsageView } from "../views/UsageView.tsx";
import { ChatView } from "../views/ChatView.tsx";
import { DungeonView } from "../views/DungeonView.tsx";
import { SettingsPopover } from "../panels/SettingsPopover.tsx";
import { ExportPopover } from "../panels/ExportPopover.tsx";

function NotFound({ path }: { path: string }) {
  return (
    <div className="view-blank">
      <h1 className="view-blank-title">Nothing at that address</h1>
      <p className="view-blank-body">
        <code>{path}</code> doesn't match anything in the app.
      </p>
      <a className="view-blank-link" {...linkProps(paths.picker())}>
        Back to campaigns
      </a>
    </div>
  );
}

/**
 * The three-zone shell: a constant rail, a context column that changes meaning
 * with the section, and the workspace. The route decides all three, so there is
 * exactly one place that knows what the app is currently showing.
 */
export function AppShell() {
  const route = useRoute();
  const openCampaign = useCampaignStore((s) => s.openCampaign);
  const campaignError = useCampaignStore((s) => s.error);
  const active = useCampaignStore((s) => s.active);
  const campaignLoading = useCampaignStore((s) => s.isLoadingContents);
  const closeDungeon = useDungeonStore((s) => s.closeDungeon);
  const loadedDungeonId = useDungeonStore((s) => s.dungeonId);
  const loadedDungeonCampaign = useDungeonStore((s) => s.campaignId);
  const closeChat = useChatStore((s) => s.close);
  const isSidebarOpen = useUIStore((s) => s.isSidebarOpen);

  const campaignId = campaignOf(route);

  // Loading the campaign is the shell's job, not each view's: the rail and the
  // context column both need it before the workspace has rendered anything.
  useEffect(() => {
    if (campaignId !== null) void openCampaign(campaignId);
    else useCampaignStore.getState().clearActive();
  }, [campaignId, openCampaign]);

  useEffect(() => {
    if (route.view !== "notes") useNotesStore.getState().close();
  }, [route.view]);

  useEffect(() => {
    if (route.view === "notes" || route.view === "note") useNoteSearchStore.getState().open(route.campaignId);
    else useNoteSearchStore.getState().close();
  }, [route.view, campaignId]);

  // Leaving a dungeon flushes its pending autosave and drops the working copy,
  // so the next one cannot inherit stale geometry.
  useEffect(() => {
    if (route.view !== "dungeon") closeDungeon();
  }, [route.view, closeDungeon]);

  useEffect(() => {
    if (route.view !== "chat" && route.view !== "dungeon") closeChat();
  }, [route.view, closeChat]);

  if (route.view === "picker")
    return (
      <>
        <WorkspaceSaves />
        <CampaignPicker />
      </>
    );
  if (route.view === "unknown") return <NotFound path={route.path} />;

  const context =
    route.view === "dungeon" ? (
      loadedDungeonId === route.dungeonId &&
      loadedDungeonCampaign === route.campaignId ? (
        <DungeonContext
          key={route.dungeonId}
          campaignId={route.campaignId}
          dungeonId={route.dungeonId}
        />
      ) : null
    ) : (
      <CampaignContext route={route} />
    );

  let workspace: React.ReactNode;
  switch (route.view) {
    case "campaign":
      workspace = <CampaignHome campaignId={route.campaignId} />;
      break;
    case "notes":
      workspace = <NotesView key={route.campaignId} campaignId={route.campaignId} />;
      break;
    case "note":
      workspace = <NoteReaderView key={`${route.campaignId}:${route.documentId}:${route.revision}:${route.chunkId}`}
        campaignId={route.campaignId} documentId={route.documentId} revision={route.revision} chunkId={route.chunkId} />;
      break;
    case "usage":
      workspace = <UsageView campaignId={route.campaignId} />;
      break;
    case "chat":
      workspace = (
        <ChatView campaignId={route.campaignId} chatId={route.chatId} />
      );
      break;
    case "dungeon":
      workspace = (
        <DungeonView
          key={route.dungeonId}
          campaignId={route.campaignId}
          dungeonId={route.dungeonId}
          roomId={route.roomId}
        />
      );
      break;
  }

  return (
    <div className="app-shell">
      <Rail route={route} />
      {isSidebarOpen && context}
      <main className="workspace">
        <WorkspaceSaves />
        {!campaignLoading && !active && campaignError ? (
          <div className="error-banner" role="alert">
            {campaignError}{" "}
            <button onClick={() => void openCampaign(campaignId!)}>
              Retry
            </button>
            <a {...linkProps(paths.picker())}>Back to campaigns</a>
          </div>
        ) : (
          workspace
        )}
      </main>
      <SettingsPopover />
      <ExportPopover />
    </div>
  );
}
