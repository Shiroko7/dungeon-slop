import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../../campaign/types.ts";
import { LoadingSpinner } from "./LoadingSpinner.tsx";

interface ChatThreadProps {
  messages: ChatMessage[];
  /** True while a reply is in flight. */
  isBusy: boolean;
  /** Partial assistant text, shown in place of the reply until it lands. */
  streamingText?: string;
  emptyTitle: string;
  emptyHint: string;
  placeholder: string;
  onSend: (text: string) => void;
  /** Absent when a thread cannot be edited and resent. */
  onEdit?: (index: number, content: string) => void | Promise<boolean | void>;
  disabled?: boolean;
  /** Rendered under the last message — the Architect hangs its config card here. */
  footer?: React.ReactNode;
  /** Rendered under the composer, e.g. a hint that a reply is expected. */
  hint?: React.ReactNode;
}

/**
 * One thread component for both agents.
 *
 * The Loremaster and the Architect differ in what they are asked and what they
 * can do, not in how a conversation looks — so the difference lives in the
 * prompt and the tool set, and this stays presentational.
 */
export function ChatThread({
  messages,
  isBusy,
  streamingText = "",
  emptyTitle,
  emptyHint,
  placeholder,
  onSend,
  onEdit,
  disabled = false,
  footer,
  hint,
}: ChatThreadProps) {
  const [draft, setDraft] = useState("");
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, isBusy, streamingText]);

  const submit = (): void => {
    const trimmed = draft.trim();
    if (trimmed === "" || isBusy || disabled) return;
    if (editingIndex !== null && onEdit !== undefined) {
      setEditBusy(true);
      void Promise.resolve(onEdit(editingIndex, trimmed)).then((ok) => {
        setEditBusy(false);
        if (ok !== false) {
          setDraft("");
          setEditingIndex(null);
        }
      });
      return;
    }
    setDraft("");
    onSend(trimmed);
  };

  return (
    <div className="chat-area">
      <div className="chat-thread">
        {messages.length === 0 && !isBusy && (
          <div className="chat-empty-state">
            <p className="chat-empty-title">{emptyTitle}</p>
            <p className="chat-empty-hint">{emptyHint}</p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={msg.id} className={`chat-msg chat-msg--${msg.role}`}>
            <div className="chat-msg-bubble">{msg.content}</div>

            {msg.citations !== null && msg.citations.length > 0 && (
              <ul className="chat-citations">
                {msg.citations.map((c, n) => (
                  <li key={`${c.chunkId}-${n}`} className="chat-citation">
                    <span className="chat-citation-file">{c.filename}</span>
                    {c.headingPath !== "" && (
                      <span className="chat-citation-path">{c.headingPath}</span>
                    )}
                    <span className="chat-citation-snippet">{c.snippet}</span>
                  </li>
                ))}
              </ul>
            )}

            {msg.role === "user" && onEdit !== undefined && (
              <div className="chat-msg-actions">
                <button
                  className="chat-msg-edit-btn"
                  onClick={() => {
                    setDraft(msg.content);
                    setEditingIndex(i);
                  }}
                  disabled={isBusy || editBusy}
                  title="Edit and resend"
                >
                  Edit
                </button>
              </div>
            )}
          </div>
        ))}

        {isBusy && (
          <div className="chat-msg chat-msg--assistant">
            <div className="chat-msg-bubble chat-msg-bubble--loading">
              {streamingText !== "" ? (
                <pre className="chat-streaming-text">{streamingText}</pre>
              ) : (
                <span className="chat-typing">
                  <LoadingSpinner size={12} />
                  <span>Thinking…</span>
                </span>
              )}
            </div>
          </div>
        )}

        {footer}
        <div ref={bottomRef} />
      </div>

      <div className="chat-compose">
        {hint}
        {editingIndex !== null && (
          <div className="chat-editing-banner">
            Editing this message — the thread will change when you submit.
            <button type="button" onClick={() => { setEditingIndex(null); setDraft(""); }}>
              Cancel
            </button>
          </div>
        )}
        <div className="chat-compose-inner">
          <textarea
            className="chat-textarea"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit();
            }}
            placeholder={placeholder}
            rows={3}
            disabled={isBusy || disabled || editBusy}
          />
          <button
            className="chat-send-btn"
            onClick={submit}
            disabled={draft.trim() === "" || isBusy || disabled || editBusy}
            title="Send (Ctrl+Enter)"
          >
            {isBusy ? <LoadingSpinner size={14} /> : "↑"}
          </button>
        </div>
      </div>
    </div>
  );
}
