import { useCallback, useEffect, useRef, useState } from "react";
import { useNotesStore } from "../../store/notes-store.ts";
import { useCampaignStore } from "../../store/campaign-store.ts";
import { SUPPORTED_EXTENSIONS } from "../../notes/shared.ts";
import { LoadingSpinner } from "../shared/LoadingSpinner.tsx";
import { countLine, useConfirm } from "../shared/ConfirmDialog.tsx";

const ACCEPT = SUPPORTED_EXTENSIONS.join(",");

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * The note library, at full width.
 *
 * It used to be a collapsible panel wedged into a 300px sidebar, which is the
 * wrong home for the thing every answer will be sourced from.
 */
export function NotesView({ campaignId }: { campaignId: number }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const documents = useNotesStore((s) => s.documents);
  const isLoading = useNotesStore((s) => s.isLoading);
  const isUploading = useNotesStore((s) => s.isUploading);
  const uploadLog = useNotesStore((s) => s.uploadLog);
  const summaryProgress = useNotesStore((s) => s.summaryProgress);
  const error = useNotesStore((s) => s.error);
  const fetchDocuments = useNotesStore((s) => s.fetchDocuments);
  const uploadFiles = useNotesStore((s) => s.uploadFiles);
  const removeDocument = useNotesStore((s) => s.removeDocument);
  const setError = useNotesStore((s) => s.setError);

  const refreshContents = useCampaignStore((s) => s.refreshContents);
  const campaignName = useCampaignStore((s) => s.active?.name ?? "");
  const { ask, dialog } = useConfirm();

  useEffect(() => {
    void fetchDocuments(campaignId);
  }, [campaignId, fetchDocuments]);

  const handleFiles = useCallback(
    (list: FileList | null) => {
      if (list === null || list.length === 0) return;
      void uploadFiles(campaignId, Array.from(list)).then(() => refreshContents(campaignId));
    },
    [campaignId, uploadFiles, refreshContents],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      handleFiles(e.dataTransfer.files);
    },
    [handleFiles],
  );

  /**
   * Removing a note drops its chunks and their embeddings too, so the campaign
   * stops being able to answer from it. Worth a prompt — this used to fire on
   * the first click with no way back.
   */
  const removeNote = useCallback(
    async (id: number, filename: string, chunks: number) => {
      const confirmed = await ask({
        title: `Remove "${filename}"?`,
        body: "It leaves the search index, so nothing can be answered from it any more.",
        consequences: [countLine(chunks, "indexed chunk")].filter(
          (line): line is string => line !== null,
        ),
        confirmLabel: "Remove",
      });
      if (!confirmed) return;
      await removeDocument(id);
      await refreshContents(campaignId);
    },
    [ask, removeDocument, refreshContents, campaignId],
  );

  const totalTokens = documents.reduce((sum, d) => sum + d.tokens, 0);
  const totalChunks = documents.reduce((sum, d) => sum + d.chunkCount, 0);
  const unsummarized = documents.filter((d) => d.summary === "").length;

  return (
    <div className="notes-view">
      <header className="notes-view-head">
        <h1 className="notes-view-title">Notes</h1>
        <p className="notes-view-sub">
          Everything uploaded here belongs to <strong>{campaignName}</strong> and is searched only
          when answering questions about it.
        </p>
      </header>

      <div
        className={`notes-drop${dragging ? " is-dragging" : ""}${isUploading ? " is-busy" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => !isUploading && inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
        }}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT}
          className="notes-file-input"
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
        {isUploading ? (
          <>
            <LoadingSpinner />
            <span className="notes-drop-hint">Indexing…</span>
          </>
        ) : (
          <>
            <span className="notes-drop-title">Drop notes here</span>
            <span className="notes-drop-hint">.md or .txt — or click to browse</span>
          </>
        )}
      </div>

      {summaryProgress !== null && (
        <div className="notes-progress">
          Summarizing {summaryProgress.completed} of {summaryProgress.total}
        </div>
      )}

      {uploadLog.length > 0 && (
        <ul className="notes-log">
          {uploadLog.map((entry, i) => (
            <li key={`${entry.filename}-${i}`} className={`notes-log-item is-${entry.status}`}>
              <span className="notes-log-name" title={entry.filename}>
                {entry.filename}
              </span>
              <span className="notes-log-status">
                {entry.status === "pending" && "…"}
                {entry.status === "indexed" && `${entry.chunks ?? 0} chunks`}
                {entry.status === "failed" && <span title={entry.error}>failed</span>}
              </span>
            </li>
          ))}
        </ul>
      )}

      {error !== null && (
        <div className="notes-error">
          <span>{error}</span>
          <button onClick={() => setError(null)}>&times;</button>
        </div>
      )}

      {documents.length > 0 && (
        <>
          <div className="notes-stats">
            {documents.length} docs · {totalChunks} chunks · {formatTokens(totalTokens)} tokens
            {unsummarized > 0 && ` · ${unsummarized} unsummarized`}
          </div>

          <ul className="notes-grid">
            {documents.map((doc) => (
              <li key={doc.id} className="notes-item">
                <div className="notes-item-head">
                  <span className="notes-item-name" title={doc.filename}>
                    {doc.filename}
                  </span>
                  <button
                    className="notes-item-remove"
                    title="Remove from the index"
                    onClick={() => void removeNote(doc.id, doc.filename, doc.chunkCount)}
                  >
                    &times;
                  </button>
                </div>
                {doc.summary !== "" && <div className="notes-item-summary">{doc.summary}</div>}
                {doc.entities.length > 0 && (
                  <div className="notes-item-entities">
                    {doc.entities.slice(0, 8).map((entity) => (
                      <span key={entity} className="notes-chip">
                        {entity}
                      </span>
                    ))}
                    {doc.entities.length > 8 && (
                      <span className="notes-chip is-more">+{doc.entities.length - 8}</span>
                    )}
                  </div>
                )}
                <div className="notes-item-meta">
                  {doc.chunkCount} chunks · {formatTokens(doc.tokens)} tokens
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {documents.length === 0 && !isUploading && !isLoading && (
        <div className="notes-empty">
          Nothing indexed for this campaign yet. Drop session logs, NPC lists or location notes above.
        </div>
      )}

      {dialog}
    </div>
  );
}
