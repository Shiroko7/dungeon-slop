import { useState, useEffect, useRef, useCallback } from "react";
import { useDungeonStore } from "../../store/dungeon-store.ts";
import { useHistoryStore } from "../../store/history-store.ts";
import type { HistoryEntry } from "../../store/history-store.ts";
import { useUIStore } from "../../store/ui-store.ts";
import { PromptInput } from "../input/PromptInput.tsx";
import { ConfigReadout } from "../input/ConfigReadout.tsx";
import { RoomPanel } from "../panels/RoomPanel.tsx";
import { DungeonPanel } from "../panels/DungeonPanel.tsx";
import { LoadingSpinner } from "../shared/LoadingSpinner.tsx";

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function SessionPanel({ entries, onRestore }: { entries: HistoryEntry[]; onRestore: (e: HistoryEntry) => void }) {
  const [open, setOpen] = useState(false);
  if (entries.length === 0) return null;
  const recent = [...entries].reverse().slice(0, 10);

  return (
    <div className="session-panel">
      <button className="session-panel-toggle" onClick={() => setOpen((v) => !v)}>
        <span>History</span>
        <span className="session-panel-chevron">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="session-list">
          {recent.map((entry, i) => (
            <button
              key={i}
              className="session-item"
              onClick={() => onRestore(entry)}
              title={entry.label}
            >
              <span className="session-item-label">{entry.label}</span>
              <span className="session-item-time">{relativeTime(entry.timestamp)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Sidebar() {
  const conversationHistory = useDungeonStore((s) => s.conversationHistory);
  const clearConversation = useDungeonStore((s) => s.clearConversation);
  const restoreSession = useDungeonStore((s) => s.restoreSession);
  const truncateConversationTo = useDungeonStore((s) => s.truncateConversationTo);
  const isGeneratingConfig = useDungeonStore((s) => s.isGeneratingConfig);
  const config = useDungeonStore((s) => s.config);
  const configRawText = useDungeonStore((s) => s.configRawText);
  const clarificationQuestion = useDungeonStore((s) => s.clarificationQuestion);

  const setPrompt = useUIStore((s) => s.setPromptText);

  const historyEntries = useHistoryStore((s) => s.past);

  const [configOpen, setConfigOpen] = useState(false);
  const [roomsOpen, setRoomsOpen] = useState(false);
  const [generalOpen, setGeneralOpen] = useState(false);

  const threadRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom whenever messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [conversationHistory.length, isGeneratingConfig]);

  const handleEditMessage = useCallback(
    (index: number) => {
      const msg = conversationHistory[index];
      if (!msg) return;
      setPrompt(msg.content);
      truncateConversationTo(index);
    },
    [conversationHistory, setPrompt, truncateConversationTo],
  );

  const handleNewChat = useCallback(() => {
    clearConversation();
  }, [clearConversation]);

  return (
    <aside className="sidebar">
      {/* ── Header ── */}
      <div className="sidebar-header">
        <span className="sidebar-title">Dungeon Slop</span>
        <button
          className="sidebar-new-chat-btn"
          onClick={handleNewChat}
          title="New chat"
          aria-label="New chat"
        >
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
            <path d="M7.5 1v13M1 7.5h13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
          </svg>
        </button>
      </div>

      {/* ── Session history ── */}
      <SessionPanel entries={historyEntries} onRestore={restoreSession} />

      {/* ── Chat area (takes all remaining height) ── */}
      <div className="chat-area">
        {/* Message thread */}
        <div className="chat-thread" ref={threadRef}>
          {conversationHistory.length === 0 && !isGeneratingConfig && (
            <div className="chat-empty-state">
              <p>Describe your dungeon to begin</p>
            </div>
          )}

          {conversationHistory.map((msg, i) => (
            <div
              key={i}
              className={`chat-msg chat-msg--${msg.role}`}
            >
              <div className="chat-msg-bubble">
                {msg.content}
              </div>
              {msg.role === "user" && (
                <div className="chat-msg-actions">
                  <button
                    className="chat-msg-edit-btn"
                    onClick={() => handleEditMessage(i)}
                    disabled={isGeneratingConfig}
                    title="Edit and resubmit"
                  >
                    Edit
                  </button>
                </div>
              )}
            </div>
          ))}

          {/* Streaming indicator */}
          {isGeneratingConfig && (
            <div className="chat-msg chat-msg--assistant">
              <div className="chat-msg-bubble chat-msg-bubble--loading">
                {configRawText ? (
                  <pre className="chat-streaming-text">{configRawText}</pre>
                ) : (
                  <span className="chat-typing">
                    <LoadingSpinner size={12} />
                    <span>Thinking…</span>
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Config card — shown after AI responds with a config */}
          {config && !isGeneratingConfig && conversationHistory.some((m) => m.role === "assistant") && (
            <div className="chat-config-card">
              <button
                className="chat-config-card-header"
                onClick={() => setConfigOpen((v) => !v)}
              >
                <span>⚙ Config</span>
                <span>{configOpen ? "▲" : "▼"}</span>
              </button>
              {configOpen && <ConfigReadout />}
            </div>
          )}

          {/* Clarification hint */}
          {clarificationQuestion && !isGeneratingConfig && (
            <div className="chat-clarification-hint">
              Type your reply in the box below ↓
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Compose input */}
        <div className="chat-compose">
          <PromptInput />
        </div>
      </div>

      {/* ── General dungeon panel ── */}
      <div className="sidebar-rooms">
        <button
          className="sidebar-rooms-toggle"
          onClick={() => setGeneralOpen((v) => !v)}
        >
          <span>General</span>
          <span>{generalOpen ? "▲" : "▼"}</span>
        </button>
        {generalOpen && (
          <div className="sidebar-rooms-body">
            <DungeonPanel />
          </div>
        )}
      </div>

      {/* ── Rooms panel ── */}
      <div className="sidebar-rooms">
        <button
          className="sidebar-rooms-toggle"
          onClick={() => setRoomsOpen((v) => !v)}
        >
          <span>Rooms</span>
          <span>{roomsOpen ? "▲" : "▼"}</span>
        </button>
        {roomsOpen && (
          <div className="sidebar-rooms-body">
            <RoomPanel />
          </div>
        )}
      </div>
    </aside>
  );
}
