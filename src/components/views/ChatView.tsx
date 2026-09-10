import { useCallback, useEffect, useState } from "react";
import { useChatStore } from "../../store/chat-store.ts";
import { useCampaignStore } from "../../store/campaign-store.ts";
import { ChatThread } from "../shared/ChatThread.tsx";
import { LoadingSpinner } from "../shared/LoadingSpinner.tsx";

/**
 * A Loremaster thread: questions asked of the campaign's notes.
 *
 * The thread itself is real — messages persist against the campaign and survive
 * a reload. What is not wired yet is the answering: that needs hybrid retrieval
 * over the note index and a tool-running agent above it. Rather than fake a
 * reply, the view says so plainly and keeps the questions.
 */
export function ChatView({ campaignId, chatId }: { campaignId: number; chatId: number }) {
  const chat = useChatStore((s) => s.chat);
  const isLoading = useChatStore((s) => s.isLoading);
  const error = useChatStore((s) => s.error);
  const openChat = useChatStore((s) => s.openChat);
  const send = useChatStore((s) => s.send);
  const truncateFrom = useChatStore((s) => s.truncateFrom);
  const setError = useChatStore((s) => s.setError);

  const noteCount = useCampaignStore((s) => s.active?.noteCount ?? 0);
  const refreshContents = useCampaignStore((s) => s.refreshContents);
  const [noticeDismissed, setNoticeDismissed] = useState(false);

  useEffect(() => {
    void openChat(chatId);
  }, [chatId, openChat]);

  const handleSend = useCallback(
    async (text: string) => {
      await send(text);
      // The first message names the thread, so the context list needs re-reading.
      await refreshContents(campaignId);
    },
    [send, refreshContents, campaignId],
  );

  if (isLoading && chat === null) {
    return (
      <div className="chat-view chat-view--loading">
        <LoadingSpinner />
      </div>
    );
  }

  if (chat === null) {
    return (
      <div className="chat-view chat-view--loading">
        <p className="view-error">{error ?? "That thread could not be opened."}</p>
      </div>
    );
  }

  return (
    <div className="chat-view">
      <header className="view-head">
        <h1 className="view-title">{chat.title === "" ? "New thread" : chat.title}</h1>
        <span className="view-sub">
          {noteCount === 0
            ? "This campaign has no notes indexed yet"
            : `Asking across ${noteCount} indexed ${noteCount === 1 ? "note" : "notes"}`}
        </span>
      </header>

      {error !== null && (
        <div className="view-banner is-error">
          <span>{error}</span>
          <button onClick={() => setError(null)}>&times;</button>
        </div>
      )}

      {!noticeDismissed && (
        <div className="view-banner">
          <span>
            Questions are saved to this thread, but the Loremaster does not answer yet — retrieval
            over the note index is the next step.
          </span>
          <button onClick={() => setNoticeDismissed(true)}>&times;</button>
        </div>
      )}

      <ChatThread
        messages={chat.messages}
        isBusy={false}
        emptyTitle="Ask this campaign something"
        emptyHint={
          noteCount === 0
            ? "Upload notes first — answers are sourced from them."
            : "Who runs the inn at Vess? What did the Compact demand?"
        }
        placeholder="Ask about your notes… (Ctrl+Enter to send)"
        onSend={(text) => void handleSend(text)}
        onEdit={(index) => void truncateFrom(index)}
      />
    </div>
  );
}
