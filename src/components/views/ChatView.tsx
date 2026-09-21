import { useCallback, useEffect, useState } from "react";
import { useChatStore } from "../../store/chat-store.ts";
import { useCampaignStore } from "../../store/campaign-store.ts";
import { useAIStore } from "../../store/ai-store.ts";
import { ChatThread } from "../shared/ChatThread.tsx";
import { LoadingSpinner } from "../shared/LoadingSpinner.tsx";

/**
 * A Loremaster thread: questions asked of the campaign's notes.
 *
 * A Loremaster thread is campaign-scoped. The answer path is streamed and its
 * read-only research calls are persisted with the assistant message.
 */
export function ChatView({
  campaignId,
  chatId,
}: {
  campaignId: number;
  chatId: number;
}) {
  const chat = useChatStore((s) => s.chat);
  const isLoading = useChatStore((s) => s.isLoading);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const streamingText = useChatStore((s) => s.streamingText);
  const turnTools = useChatStore((s) => s.turnTools);
  const activeTool = useChatStore((s) => s.activeTool);
  const turnStatus = useChatStore((s) => s.turnStatus);
  const error = useChatStore((s) => s.error);
  const openChat = useChatStore((s) => s.openChat);
  const askLoremaster = useChatStore((s) => s.askLoremaster);
  const cancelAnswer = useChatStore((s) => s.cancelAnswer);
  const submitEdit = useChatStore((s) => s.submitEdit);
  const setError = useChatStore((s) => s.setError);

  const noteCount = useCampaignStore((s) => s.active?.noteCount ?? 0);
  const refreshContents = useCampaignStore((s) => s.refreshContents);
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  const provider = useAIStore((s) => s.provider);
  const model = useAIStore((s) => s.model);
  const temperature = useAIStore((s) => s.temperature);
  const thinkingLevel = useAIStore((s) => s.thinkingLevel);

  useEffect(() => {
    void openChat(chatId);
  }, [chatId, openChat]);

  const handleSend = useCallback(
    async (text: string) => {
      await askLoremaster(text, { provider, model, temperature, thinkingLevel });
      // The first message names the thread, so the context list needs re-reading.
      await refreshContents(campaignId);
    },
    [askLoremaster, refreshContents, campaignId, provider, model, temperature, thinkingLevel],
  );

  if (isLoading && chat === null) {
    return (
      <div className="chat-view chat-view--loading">
        <LoadingSpinner />
      </div>
    );
  }

  if (chat === null || chat.id !== chatId || chat.campaignId !== campaignId) {
    return (
      <div className="chat-view chat-view--loading">
        <p className="view-error">
          {error ?? "That thread could not be opened."}
        </p>
      </div>
    );
  }

  return (
    <div className="chat-view">
      <header className="view-head">
        <h1 className="view-title">
          {chat.title === "" ? "New thread" : chat.title}
        </h1>
        <span className="view-sub">
          {noteCount === 0
            ? "This campaign has no notes indexed yet"
            : `Asking across ${noteCount} indexed ${noteCount === 1 ? "note" : "notes"}`}
        </span>
        <span className="view-sub chat-provider-disclosure">
          Answering with {provider === "ollama" ? "Ollama (local)" : `${provider} · ${model ?? "default model"}`}
          {provider === "ollama" ? "" : " · provider usage may incur charges"}
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
            The Loremaster searches this campaign's notes with read-only tools.
            Answers distinguish documented facts from uncertainty; sources open at
            the exact revision used.
          </span>
          <button onClick={() => setNoticeDismissed(true)}>&times;</button>
        </div>
      )}

      <ChatThread
        messages={chat.messages}
        isBusy={isStreaming}
        streamingText={streamingText}
        activeTool={activeTool}
        turnTools={turnTools}
        turnStatus={turnStatus}
        emptyTitle="Ask this campaign something"
        emptyHint={
          noteCount === 0
            ? "Upload notes first — answers are sourced from them."
            : "Who runs the inn at Vess? What did the Compact demand?"
        }
        placeholder="Ask about your notes… (Ctrl+Enter to send)"
        onSend={(text) => void handleSend(text)}
        onEdit={submitEdit}
        onCancel={cancelAnswer}
      />
    </div>
  );
}
