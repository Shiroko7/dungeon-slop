import { useEffect, useState } from "react";
import { api } from "../../store/api.ts";
import { linkProps, navigate, paths } from "../../router/router.ts";
import type { NoteReader } from "../../notes/retrieval-types.ts";

const PAGE_CHARS = 20_000;

export function NoteReaderContent({ note, chunkId }: { note: NoteReader; chunkId: number | null }) {
  const selected = note.chunks.find((chunk) => chunk.id === chunkId);
  const [requestedStart, setPageStart] = useState(Math.max(0, (selected?.startOffset ?? 0) - 400));
  const source = note.source?.replace(/\r\n/g, "\n");
  const pageStart = requestedStart > 0 && /[\uDC00-\uDFFF]/.test(source?.[requestedStart] ?? "") ? requestedStart - 1 : requestedStart;
  const requestedEnd = Math.min(source?.length ?? 0, pageStart + PAGE_CHARS);
  const pageEnd = /[\uD800-\uDBFF]/.test(source?.[requestedEnd - 1] ?? "") ? requestedEnd - 1 : requestedEnd;
  const markedStart = Math.min(pageEnd, Math.max(pageStart, selected?.startOffset ?? pageStart));
  const markedEnd = Math.max(markedStart, Math.min(pageEnd, selected?.endOffset ?? pageStart));
  return <article className="note-reader">
    <a {...linkProps(paths.notes(note.campaignId))}>← Back to notes and search</a>
    <header><h1>{note.filename}</h1>
      <p>Revision {note.revision} · {note.indexStatus} · {note.chunks.length} passages</p>
    </header>
    {note.notice && <p className="note-notice" role="status">{note.notice}</p>}
    {note.activeRevision > 0 && note.activeRevision !== note.revision &&
      <a {...linkProps(paths.note(note.campaignId, note.documentId, note.activeRevision))}>Open current indexed revision explicitly</a>}
    {note.chunks.length > 0 && <label className="note-reader-jump">Jump to heading / passage
      <select value={chunkId ?? ""} onChange={(event) => navigate(paths.note(note.campaignId, note.documentId, note.revision,
        event.target.value ? Number(event.target.value) : undefined))}>
        <option value="">Document start</option>
        {note.chunks.map((chunk) => <option value={chunk.id} key={chunk.id}>{chunk.ordinal + 1}. {chunk.headingPath || "Document"} · characters {chunk.startOffset}–{chunk.endOffset}</option>)}
      </select>
    </label>}
    {selected && <section className="note-citation" aria-label="Selected citation">
      <h2>{selected.headingPath || "Selected passage"}</h2>
      <p>Document {note.documentId} · revision {note.revision} · chunk {selected.id} · characters {selected.startOffset}–{selected.endOffset}</p>
      <a {...linkProps(paths.note(note.campaignId, note.documentId, note.revision, selected.id))}>Permanent address for this passage</a>
      <p className="note-search-help">If this revision is replaced or deleted, the link reports it as unavailable. It never silently points at new text.</p>
    </section>}
    {source !== undefined ? <>
      <p className="note-search-help">Source text · line endings normalized for passage offsets. Markdown and HTML are displayed as text, not executed.</p>
      <pre className="note-reader-text" tabIndex={0} aria-label="Source text">
        {source.slice(pageStart, markedStart)}
        {markedEnd > markedStart && <mark>{source.slice(markedStart, markedEnd)}</mark>}
        {source.slice(markedEnd, pageEnd)}
      </pre>
      <div className="notes-actions" aria-label="Source pagination">
        <button disabled={pageStart === 0} onClick={() => setPageStart(Math.max(0, pageStart - PAGE_CHARS))}>Previous page</button>
        <span>Characters {pageStart}–{pageEnd} of {source.length}</span>
        <button disabled={pageEnd === source.length} onClick={() => setPageStart(pageEnd)}>Next page</button>
      </div>
    </> : <section aria-label="Legacy stored chunks">
      {(selected ? [selected] : note.chunks.slice(0, 20)).map((chunk) => <section className="note-legacy-chunk" key={chunk.id}>
        <h2><a {...linkProps(paths.note(note.campaignId, note.documentId, note.revision, chunk.id))}>{chunk.ordinal + 1}. {chunk.headingPath || "Document"}</a></h2>
        <pre className="note-reader-text">{chunk.text}</pre>
      </section>)}
      {!selected && note.chunks.length > 20 && <p>Showing the first 20 stored chunks. Use the passage selector to open any other chunk.</p>}
    </section>}
  </article>;
}

export function NoteReaderView({ campaignId, documentId, revision, chunkId }: {
  campaignId: number; documentId: number; revision: number; chunkId: number | null;
}) {
  const [note, setNote] = useState<NoteReader | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, retry] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setNote(null); setError(null);
    void api.notes.read(campaignId, documentId, revision, chunkId ?? undefined,
      AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]))
      .then((value) => { if (!abort.signal.aborted) setNote(value); })
      .catch((reason: unknown) => { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not open source"); });
    return () => abort.abort();
  }, [campaignId, documentId, revision, chunkId, attempt]);
  if (note) return <NoteReaderContent key={`${campaignId}:${documentId}:${revision}:${chunkId}`} note={note} chunkId={chunkId} />;
  return <div className="note-reader">
    <a {...linkProps(paths.notes(campaignId))}>← Back to notes and search</a>
    {error ? <><p className="notes-error" role="alert">{error}</p><div className="notes-actions"><button onClick={() => retry(attempt + 1)}>Retry opening this revision</button></div></>
      : <p role="status">Opening source revision…</p>}
  </div>;
}
