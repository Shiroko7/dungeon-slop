import { useEffect } from "react";
import { useNoteSearchStore } from "../../store/note-search-store.ts";
import { linkProps, paths } from "../../router/router.ts";
import type { NoteDocument, NotesProviders } from "../../notes/types.ts";
import type { NoteSearchResult, SearchMode } from "../../notes/retrieval-types.ts";

export function SearchResults({ result }: { result: NoteSearchResult }) {
  const empty = {
    "empty-query": "Enter a name, topic, or phrase to search.",
    "empty-index": "No indexed passages in these sources. Upload notes or retry indexing first.",
    "no-sources": "No sources selected. Choose at least one document or All sources.",
    unavailable: "Semantic search is unavailable. Try Keyword mode or check the notes embedding configuration.",
    "no-matches": "No matching passages. Try different terms or broaden the selected sources.",
    ready: "",
  }[result.status];
  return <div className="note-search-results">
    <p role="status">{result.results.length ? `${result.results.length} passages · ${result.tokensUsed} / ${result.tokenBudget} estimated context tokens · ${result.usedMode}` : empty}</p>
    {result.warnings.map((warning) => <p className="note-notice" key={warning}>{warning}</p>)}
    {result.results.length > 0 && <p className="note-search-help">Ranked passages are not answers or proof. Compare sources, especially when their accounts conflict.</p>}
    <ol className="note-results-list">
      {result.results.map((passage) => {
        const cite = passage.citation;
        return <li key={`${cite.documentId}:${cite.revision}:${cite.chunkId}`}>
          <a {...linkProps(paths.note(cite.campaignId, cite.documentId, cite.revision, cite.chunkId))}>
            {cite.filename} · revision {cite.revision} · {cite.headingPath || "Document"}
          </a>
          <p className="note-passage">{passage.text}</p>
          <p className="note-search-help">Characters {cite.startOffset}–{cite.endOffset} · {passage.tokens} estimated tokens
            {passage.lexicalRank !== null && ` · keyword rank ${passage.lexicalRank}`}
            {passage.semanticRank !== null && ` · semantic rank ${passage.semanticRank}`}
            {passage.truncated && " · shortened to fit context budget"}</p>
        </li>;
      })}
    </ol>
    <details><summary>Retrieval diagnostics</summary><p className="note-search-help">
      {result.diagnostics.indexedChunks} scoped chunks · {result.diagnostics.lexicalCandidates} keyword candidates · {result.diagnostics.semanticCandidates} semantic candidates
      {result.diagnostics.embeddingModel && ` · model ${result.diagnostics.embeddingModel}`}
    </p></details>
  </div>;
}

export function NoteSearch({ campaignId, documents, providers }: { campaignId: number; documents: NoteDocument[]; providers: NotesProviders | null }) {
  const state = useNoteSearchStore();
  useEffect(() => {
    state.open(campaignId);
    return () => {
      const current = useNoteSearchStore.getState();
      if (current.campaignId === campaignId && current.busy) current.cancel();
    };
  }, [campaignId, state.open]);
  // Parent route may render once before its ownership effect. Never show the old campaign.
  if (state.campaignId !== campaignId) return null;
  const selected = state.input.documentIds;
  const networkMode = state.input.mode !== "lexical";
  return <section className="note-search" aria-labelledby="note-search-title">
    <h2 id="note-search-title">Search campaign notes</h2>
    <form onSubmit={(event) => { event.preventDefault(); void state.search(); }}>
      <label className="note-query">Find a passage
        <input type="search" value={state.input.query} maxLength={1000} placeholder="A name, place, or question…"
          onChange={(event) => state.change({ query: event.target.value })} />
      </label>
      <div className="note-search-controls">
        <label>Search mode<select value={state.input.mode} onChange={(event) => state.change({ mode: event.target.value as SearchMode })}>
          <option value="lexical">Keyword · local</option><option value="hybrid">Hybrid · keyword + semantic</option><option value="semantic">Semantic</option>
        </select></label>
        <label>Context budget<select value={state.input.tokenBudget} onChange={(event) => state.change({ tokenBudget: Number(event.target.value) })}>
          <option value={1000}>1,000 estimated tokens</option><option value={3000}>3,000 estimated tokens</option><option value={8000}>8,000 estimated tokens</option>
        </select></label>
        <label>Results<select value={state.input.limit} onChange={(event) => state.change({ limit: Number(event.target.value) })}>
          <option value={5}>5 passages</option><option value={10}>10 passages</option><option value={20}>20 passages</option>
        </select></label>
        <label className="note-checkbox"><input type="checkbox" checked={state.input.neighbors === 1}
          onChange={(event) => state.change({ neighbors: event.target.checked ? 1 : 0 })} />Include nearby context</label>
      </div>
      <details className="note-source-filter"><summary>Sources · {selected === undefined ? "all campaign notes" : `${selected.length} selected`}</summary>
        <div className="notes-actions"><button type="button" onClick={() => state.change({ documentIds: undefined })}>All sources</button>
          <button type="button" onClick={() => state.change({ documentIds: [] })}>Clear selection</button></div>
        <div className="note-source-options">{documents.map((doc) => <label key={doc.id} className="note-checkbox">
          <input type="checkbox" checked={selected === undefined || selected.includes(doc.id)} onChange={(event) => {
            const current = selected ?? documents.map((entry) => entry.id);
            state.change({ documentIds: event.target.checked ? [...current, doc.id] : current.filter((id) => id !== doc.id) });
          }} />{doc.filename}{doc.activeRevision === 0 ? " (not indexed)" : ""}
        </label>)}</div>
      </details>
      <p className="note-search-help">{networkMode
        ? `Your query will be sent to ${providers ? `${providers.embeddings.provider} / ${providers.embeddings.model}` : "the configured notes embedding provider"} and may incur charges. No answer is generated.`
        : "Keyword search stays on this machine and needs no provider key."}</p>
      <div className="notes-actions">
        <button type="submit" disabled={state.busy || (networkMode && providers === null)}>Search notes</button>
        {state.busy && <button type="button" onClick={state.cancel}>Cancel search</button>}
        {state.busy && <span role="status">Searching…</span>}
      </div>
    </form>
    {state.error && <p className="notes-error" role="alert">{state.error}</p>}
    {state.result && <SearchResults result={state.result} />}
  </section>;
}
