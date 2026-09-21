import { useCallback, useEffect, useRef, useState } from "react";
import { useNotesStore } from "../../store/notes-store.ts";
import { useCampaignStore } from "../../store/campaign-store.ts";
import { SUPPORTED_EXTENSIONS } from "../../notes/shared.ts";
import { LoadingSpinner } from "../shared/LoadingSpinner.tsx";
import { countLine, useConfirm } from "../shared/ConfirmDialog.tsx";
import { NoteSearch } from "./NoteSearch.tsx";
import { linkProps, paths } from "../../router/router.ts";

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
  const providers = useNotesStore((s) => s.providers);
  const providerError = useNotesStore((s) => s.providerError);
  const fetchProviders = useNotesStore((s) => s.fetchProviders);
  const retryDocuments = useNotesStore((s) => s.retryDocuments);
  const cancelUpload = useNotesStore((s) => s.cancelUpload);

  const refreshContents = useCampaignStore((s) => s.refreshContents);
  const campaignName = useCampaignStore((s) => s.active?.name ?? "");
  const { ask, dialog } = useConfirm();

  useEffect(() => {
    void fetchDocuments(campaignId);
    void fetchProviders();
    return () => useNotesStore.getState().close();
  }, [campaignId, fetchDocuments, fetchProviders]);

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
  const retryable = documents.filter((doc) => doc.retrySourceAvailable &&
    (doc.indexStatus !== "indexed" || doc.summaryStatus !== "ready"));
  const uploadDisabled = isUploading || providers === null;

  return (
    <div className="notes-view">
      <header className="notes-view-head">
        <h1 className="notes-view-title">Notes</h1>
        <p className="notes-view-sub">
          Everything uploaded here belongs to <strong>{campaignName}</strong>.
          Search and inspect its source passages below. Loremaster answers are coming in M2.2.
        </p>
      </header>

      <NoteSearch campaignId={campaignId} documents={documents} providers={providers} />

      <div className="notes-providers" aria-live="polite">
        {providers ? (
          <>
            <p>Embeddings: <strong>{providers.embeddings.provider} / {providers.embeddings.model}</strong>
              {!providers.embeddings.configured && " — credentials missing"}</p>
            <p>Summaries: <strong>{providers.summaries.provider} / {providers.summaries.model}</strong>
              {!providers.summaries.configured && " — credentials missing"}</p>
            <p>Notes are sent to these providers. The dungeon generation provider, including Ollama, does not change this.</p>
            <p>Retry resumes missing work. Reindex rebuilds the selected note and may incur provider charges again.</p>
          </>
        ) : <p>{providerError ?? "Loading notes providers…"}</p>}
        {providerError && <button onClick={() => void fetchProviders()}>Retry provider details</button>}
      </div>

      <div
        className={`notes-drop${dragging ? " is-dragging" : ""}${isUploading ? " is-busy" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { if (uploadDisabled) { e.preventDefault(); setDragging(false); } else onDrop(e); }}
        onClick={() => !uploadDisabled && inputRef.current?.click()}
        role="button"
        aria-disabled={uploadDisabled}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (!uploadDisabled) inputRef.current?.click();
          }
        }}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          disabled={uploadDisabled}
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
            <span className="notes-drop-hint">Processing notes…</span>
          </>
        ) : (
          <>
            <span className="notes-drop-title">Drop notes here</span>
            <span className="notes-drop-hint">.md or .txt — or click to browse</span>
          </>
        )}
      </div>

      <div className="notes-actions">
        <span>Up to 20 files · 5 MiB each · 20 MiB total</span>
        {isUploading ? <button onClick={cancelUpload}>Cancel processing</button> : (
          <>
            <button onClick={() => void fetchDocuments(campaignId)}>Refresh status</button>
            {retryable.length > 0 && <button disabled={uploadDisabled} onClick={() => void retryDocuments(campaignId, retryable.map((doc) => doc.id))}>
              Retry pending / failed{retryable.length > 20 ? " (next 20)" : ""}
            </button>}
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
                {entry.status === "unchanged" && "unchanged"}
                {entry.status === "partial" && "searchable · summary pending"}
                {entry.status === "failed" && "failed"}
                {entry.status === "cancelled" && "cancelled"}
              </span>
              {entry.error && <p className="notes-file-error">{entry.error}</p>}
            </li>
          ))}
        </ul>
      )}

      {error !== null && (
        <div className="notes-error" role="alert">
          <span>{error}</span>
          <button aria-label="Dismiss notes error" onClick={() => setError(null)}>&times;</button>
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
                  <a className="notes-item-name" title={doc.filename}
                    {...linkProps(paths.note(campaignId, doc.id, doc.activeRevision || doc.latestRevision))}>
                    {doc.filename}
                  </a>
                  <button
                    className="notes-item-remove"
                    title="Remove from the index"
                    aria-label={`Remove ${doc.filename}`}
                    onClick={() => void removeNote(doc.id, doc.filename, doc.chunkCount)}
                  >
                    &times;
                  </button>
                </div>
                <p className="notes-item-state">
                  {doc.activeIndexStatus === "indexed" ? `Search index: revision ${doc.activeRevision}`
                    : doc.activeRevision > 0 ? "Legacy search data incomplete — reupload to repair" : "Not indexed yet"}
                  {doc.latestRevision !== doc.activeRevision && ` · replacement ${doc.indexStatus}`}
                  {doc.activeRevision > 0 && ` · summary ${doc.summaryStatus === "source-required" ? "needs original source" : doc.summaryStatus}`}
                </p>
                {(doc.indexError || doc.summaryError) && <p className="notes-file-error">{doc.indexError ?? doc.summaryError}</p>}
                {!doc.retrySourceAvailable && <p className="notes-item-state">
                  Original source unavailable. Reupload to reindex or create a missing summary. Existing search data is retained.
                </p>}
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
                <div className="notes-actions">
                  {doc.retrySourceAvailable && (doc.indexStatus !== "indexed" || doc.summaryStatus !== "ready") && (
                    <button disabled={uploadDisabled} onClick={() => void retryDocuments(campaignId, [doc.id])}>
                      {doc.indexStatus === "indexed" ? "Retry summary" : "Retry indexing"}
                    </button>
                  )}
                  {doc.retrySourceAvailable && <button disabled={uploadDisabled} onClick={() => void retryDocuments(campaignId, [doc.id], true)}>
                    Reindex this note
                  </button>}
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
