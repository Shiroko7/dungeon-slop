# Dungeon Slop — Product and Engineering Roadmap

Status: M1.1 implemented on its review branch, 2026-09-20; browser verification pending.
M1.2–M1.4 and later milestones remain planned. See [M1.1 review notes](docs/M1.1-REVIEW.md).

This is the authoritative roadmap following the project review. [TASKS.md](TASKS.md)
tracks execution; [README.md](README.md) describes what works today. The older
numbered phases are historical and do not determine the next implementation order.

## Product direction

Build a dependable local workspace in which a GM can turn campaign material into
a playable dungeon, revise it without losing authorship, and use it at the table.

The intended workflow is:

Campaign → brief or preset + optional sources → review plan → build map →
populate and edit rooms → export for the GM or players.

Preserve the existing strengths: campaign ownership, SQLite as the committed source
of truth, a deterministic procedural engine, invariant tests, the shared static
renderer, and AI plans expressed as structure rather than coordinates.

## Milestones and review budget

| Milestone | Outcome | Planned implementation PRs | Exit condition |
| --- | --- | --- | --- |
| M1 — Protect work | Requests, saves, edits, regeneration, and note uploads preserve the correct data | **4 firm review units** | The loss/corruption scenarios below are covered and pass |
| M2 — Complete the defining workflow | Notes actually inform answers, plans, and room descriptions | 3 proposed packages | A sourced dungeon can be created end to end with inspectable evidence |
| M3 — Make it comfortable at the table | Creation, navigation, export, and AI settings are understandable and dependable | 4 proposed packages | A GM can prepare and export a usable session without developer knowledge |
| M4 — Expand after measuring | Richer presentation, encounter preparation, connected levels, and targeted acceleration | 4 candidate packages | Each feature meets its own gameplay or measured performance gate |

Milestone 1 is intentionally four substantial, cohesive PRs. Each includes the
storage, API, UI, and tests needed for its behavior. Do not make a separate PR for
every bug, component, migration, or test. Later milestones have proposed groupings,
not a commitment to open fifteen PRs now.

Review and merge M1 PRs one at a time, numbered M1.1–M1.4 below. Avoid a stack that
requires reviewing several unmerged PRs to understand one behavior. Keep preparatory
refactors inside the PR that needs them. Split only if implementation reveals a
separate deliverable or migration that materially improves review and rollback;
do not split merely to hit a line-count target.

An independently useful urgent correction can be scheduled earlier without pulling
in its entire milestone. In particular, export disclosure and format defects do not
become acceptable merely because the full export package is listed under M3.

## M1 — Protect work

The review reproduced wrong-dungeon description writes, dropped failed autosaves,
stale features after erase, lost embeddings after a failed note replacement,
duplicate ingestion work, and refinement mutating the original plan before forking.
These are the first implementation targets.

### M1.1 — Reliable requests, saves, and local data ownership

**Proposed PR title:** `Protect workspace data across navigation, retries, and saves`

**Outcome:** a request can only affect the object and revision that initiated it;
an unsuccessful save remains recoverable and visibly unsaved.

**Why this is one PR:** navigation races, cancellation, autosave, and stale writes
share the same ownership and acknowledgement problem. Fixing only a completion
callback would leave the other paths able to overwrite the same data.

**Scope**

- Capture campaign, dungeon, chat, room, operation ID, and applicable revision when
  work starts. Separate the operation's target from whichever view is now open.
- Apply stale-response guards to dungeon/chat/campaign/note loading and refreshes,
  as well as config, blueprint, description, and refinement requests. A late load
  must not replace a newer selection or re-open a closed object.
- Give interactive AI operations cancellation and one lifecycle spanning all their
  stages. Default to cancelling view-owned generation when its owner is left.
  Already completed results may only persist to that owner under a revision check;
  never redirect them to the current store. Explain that cancellation cannot undo
  provider work already performed or guarantee zero charges.
- Introduce a save coordinator keyed by dungeon. Coalesce unsent changes, serialize
  mutations for that dungeon, and remove queued changes only after acknowledgement.
  Include room notes, overview, and rename writes in the same ordering model.
- Add optimistic concurrency checks so another tab, a later edit, or an older AI
  request cannot silently replace a newer committed revision. Return a structured
  conflict with a recoverable local copy and reload/retry choices.
- Retain a bounded durable outbox of unacknowledged edits for reload/crash recovery.
  It stores pending operations, not a second authoritative dungeon database. Replay
  only after checking owner existence and the committed revision; never recreate
  deleted objects or silently resolve a conflict by overwriting.
- Keep an immediate, explicit unsaved state until local recovery storage and the
  server write have acknowledged their respective work. Do not promise that a
  last-millisecond browser termination is impossible; warn while recovery is pending.
  Ordinary async `beforeunload` fetches and size-limited keepalive requests are not
  sufficient protection for large geometry payloads.
- Show `Unsaved`, `Saving…`, `Saved`, `Save failed — Retry`, and conflict/recovery
  states. Navigation can continue once pending changes are safely retained; a
  failure must remain discoverable when the user returns.
- Validate owner relationships and mutation envelopes at the API boundary, including
  room membership and mismatched campaign/dungeon/chat references. Surface useful
  structured errors instead of generic 500s or indefinitely loading views.
- Explicitly bind the local API to loopback by default. Validate browser mutation
  origins against the supported local frontend/API origins. Keep an intentional
  non-loopback configuration documented as a separate operating choice.

**Main areas:** `src/store/`, `src/components/views/useArchitect.ts`,
`src/components/layout/AppShell.tsx`, `src/api/`, `src/campaign/`, `src/db/`,
`src/server.ts`, save/error UI.

**Acceptance and reviewer demonstration**

1. Start a description in A, navigate to B, then release the delayed response:
   B's geometry, notes, chat, errors, and busy state stay untouched.
2. Resolve dungeon and campaign loads in reverse order: the latest requested route
   wins. Deleting an owner during an operation does not resurrect it.
3. Fail a save, keep editing, restore the connection, and retry: the latest changes
   are saved once in the correct order; an older response cannot revert them.
4. Reload with pending edits: a recovery state appears and safe replay works. A
   conflicting newer server revision requires explicit resolution.
5. Edit the same dungeon in two tabs: the second writer sees a conflict instead of
   silently overwriting. Independent dungeons save independently.
6. Cancel during config, blueprint, or narration: the UI settles, the server stops
   consuming the stream where supported, and no stale result is applied.
7. A missing campaign/dungeon shows a recoverable error. Malformed or misowned
   mutation requests fail cleanly. The default server listener is loopback-only.

**Boundary:** this PR adds revision checks, not the user-facing content history
from M1.2. It does not redesign the workspace or add hosted authentication.

### M1.2 — Preserve authorship through editing and regeneration

**Proposed PR title:** `Preserve authored content with safe drafts and recoverable revisions`

**Depends on:** M1.1's operation ownership and save acknowledgement contracts.

**Outcome:** editing, generating, rerolling, and accepting AI replacements have
predictable ownership and an accessible way back.

**Why this is one PR:** drafts, content history, AI output validation, and fork
adoption all decide when proposed content becomes the user's saved content.

**Scope**

- Key description drafts by dungeon and room. Switching rooms cannot carry a draft
  into another room's Save action. Retain unfinished drafts or offer an explicit
  discard decision when they cannot be retained. Expose save failures without closing
  the only copy of a draft.
- Restore native undo/redo in text inputs and editable content. Scope map shortcuts
  to the active map workspace and make the target of Undo clear.
- Add persisted revision checkpoints before replacing existing authored descriptions
  or an overview. Include minimal history/restore UI; restoring makes a new revision.
  Geometry-changing operations use dungeon versions/forks rather than copying full
  geometry into a checkpoint on every keystroke.
- Define the preservation rule: first generation fills an empty dungeon; subsequent
  Generate, Reroll, or accepted layout refinement creates a new version by default.
  Protection must cover manually drawn geometry and overview-only authorship, not
  depend on the presence of room descriptions.
- Keep the original blueprint, config, geometry, and authored content unchanged when
  creating a version. Persist enough provenance to trace its original brief and
  parent; create the new version and its build-log relationship coherently.
- On a successful fork, refresh the campaign and open the new version. Failed
  generation/forking leaves the original and pending proposal intact. Retry must
  not create duplicate versions after an ambiguous network acknowledgement.
- Separate a proposed config/blueprint from the config/blueprint of existing geometry.
  The UI must identify unapplied changes rather than present two mismatched models
  as one saved dungeon.
- Validate room and overview output with runtime schemas. Return stable room IDs,
  reject unknown/duplicate IDs and wrong field types, and report missing results.
  Do not zip unvalidated arrays onto rooms by position.
- Preserve successful results when one room fails. Offer retry for missing/invalid
  rooms and explicit accept/replace behavior for already authored content. Add a
  reachable `Describe missing rooms` action; replacing existing descriptions creates
  checkpoints. Single-room requests have busy/cancel/error states too.
- Edit a chat message as a draft first. Truncate or branch the transcript only when
  the replacement is submitted successfully, not on clicking Edit.
- Separate generation failure from successful in-place generation in action results.
  A failed build must not trigger narration of the previous map.

**Main areas:** `src/store/dungeon-store.ts`, `src/store/chat-store.ts`,
`src/campaign/dungeons.ts`, `src/campaign/chats.ts`, `src/db/`, narrator schemas and
handlers, `RoomPanel`, `DungeonPanel`, `LayoutPanel`, `Toolbar`, `ChatThread`.

**Acceptance and reviewer demonstration**

1. Edit room A, switch to B, and save: A's draft cannot overwrite B. Native text Undo
   does not undo a map stroke.
2. Regenerate a hand-edited description, accept it, reload, and restore the previous
   version. Repeat for an overview. A rejected result leaves current content intact.
3. Reroll a manually edited map with no room notes: the original remains accessible.
4. Accept a refinement on a described map: a new version opens; the parent's plan,
   geometry, and descriptions remain exactly as before. Failure remains retryable.
5. Feed shuffled, partial, duplicate-ID, and malformed narrator output: valid results
   attach by ID, invalid results cannot corrupt the saved model, and failures are
   visible. Retry does not rewrite rooms that already succeeded.
6. Click Edit on an old chat message and cancel: the transcript is unchanged.
7. Complete the same fork operation twice after a simulated lost acknowledgement:
   only one new version exists. A generation failure does not launch auto-narration.

**Boundary:** history here is for recovering authorship. Campaign trash, project
backup/import, a full version-comparison browser, field locks, and partial visual
refinement acceptance are later packages. Document retention limits and storage
costs before adding automatic pruning; never prune the current version.

### M1.3 — Keep manual map edits internally consistent

**Proposed PR title:** `Reconcile map geometry, features, and connectivity after edits`

**Depends on:** M1.1 for safe persistence and M1.2 for protecting content affected
by room deletion, splitting, or replacement.

**Outcome:** the grid, rendered map, room identities, feature lists, and connection
graph describe the same edited dungeon, including after undo and reload.

**Why this is one PR:** erasing features, carving footprints, and updating adjacency
must use one edit/reconciliation contract. Separate fixes would leave competing
representations with different notions of what a stroke changed.

**Scope**

- Define the canonical footprint of an edited room. Preserve smooth procedural
  shapes when untouched; once cell editing changes their footprint, rendering and
  hit-testing must respect the actual cells instead of repainting the old shape.
- Reconcile grid ownership, room/global feature lists, corridor paths and endpoints,
  bounds/centers, connections, walls, and derived layout reports after a stroke.
- Erasing or painting over a feature removes/replaces its associated records;
  repeatedly painting a door at the same cell does not accumulate duplicates.
- Interpolate between sampled pointer cells so a fast stroke cannot leave gaps.
  Commit one undoable operation per stroke and preserve immutable snapshots.
- Define room split/merge behavior explicitly. Keep the original ID on the surviving
  component containing its anchor (largest component if the anchor was removed),
  allocate IDs to other components, and never silently move/copy authored descriptions
  between them. Merges or deletions retain displaced content in recoverable history.
- Derive connections from traversable geometry rather than leaving manual corridors
  permanently unconnected in metadata. A real dead end remains a dead end.
- Recompute reachability and label stale narrative/plan data when an edit invalidates
  it. Intentionally disconnected rooms are allowed with a visible warning; do not
  silently carve extra corridors to make the warning disappear.
- Make undo/redo restore the geometry and associated metadata/content effects as one
  operation. Prevent stale selections and room routes after a room is removed.

**Main areas:** `src/engine/edit-engine.ts`, `src/engine/types.ts`, grid/graph helpers,
`src/renderer/`, `DungeonCanvas`, `src/store/dungeon-store.ts`, room inspector.

**Acceptance and reviewer demonstration**

1. Erase a door, stair, trap, or treasure: no stale feature remains in either feature
   list, the renderer, or export inputs. Undo restores it once.
2. Cut into a rectangular/circular room: erased cells stay erased on screen, after
   reload, and in shared-renderer output; selection matches the new footprint.
3. Draw a fast corridor between two rooms: its cells are contiguous, its endpoints
   resolve, and connection metadata agrees. Erase it and connectivity updates.
4. Split, merge, and completely erase rooms: identity policy is deterministic and
   authored content stays recoverable. Undo/redo restores a consistent document.
5. Run edit invariants over constructed, organic, and blueprint maps, including wide
   corridors and repeated strokes. Keep the existing generation invariants passing.

**Boundary:** advanced brushes, rectangle tools, touch gestures, and performance
rewrites are not prerequisites for correctness. Reuse the existing renderer; do
not create another edit-only rendering implementation or reintroduce hatch fringe.

### M1.4 — Atomic, recoverable note ingestion

**Proposed PR title:** `Preserve indexed notes across replacement, failure, and retry`

**Depends on:** M1.1's campaign ownership and request lifecycle. This package is
otherwise independent of M1.2/M1.3; the default review order remains sequential.

**Outcome:** uploading a revision cannot destroy the last valid note/index; retry
and status accurately distinguish source storage, embeddings, and summaries.

**Why this is one PR:** deduplication, atomic replacement, source persistence, and
retry need one document/revision model. A hash check alone cannot repair unsafe
replacement ordering or recover a missing source for summarization.

**Scope**

- Store original source text and a content revision for new/reuploaded documents.
  Give documents stable identities; associate chunks and embeddings with the right
  source revision and processing version.
- Compare campaign, filename, content hash, chunker version, and embedding model
  before doing work. An unchanged, fully processed upload is a no-op; a missing
  summary retries only summarization, not embeddings.
- Build and validate replacement chunks/vectors before swapping the active revision.
  Commit the replacement in a short SQLite transaction after network work succeeds;
  never hold a database transaction open during a provider call.
- Keep the old active revision intact on timeout, rate limit, cancellation, invalid
  vector count/dimensions, model mismatch, or commit failure. A new upload that fails
  remains explicitly pending/failed and is not reported as fully indexed.
- Prevent an older concurrent upload from becoming the final active revision after
  a newer upload. Retrying the same completed job does not duplicate processing.
- Treat summarization as a separate retryable stage. Valid searchable content remains
  available if a summary fails. Backfill reads the stored source of each pending
  document, including documents outside the latest upload batch in the same campaign.
- Bound upload batch size, retained source memory, and provider concurrency. Provide
  per-file outcomes, readable errors, cancellation, and retry-failed actions.
- Display the notes embedding and summary providers before upload. Choosing Ollama
  for dungeon generation must not imply that notes processing is local.
- Migrate existing documents without discarding their chunks/embeddings. Original
  source text cannot be perfectly recovered from every legacy chunk set; mark that
  case explicitly and require reupload only for operations needing the exact source.
- Replace any recovery advice to delete the entire application database with a
  scoped reindex path that preserves campaigns, maps, chats, and authorship.

**Main areas:** `src/notes/`, `src/api/upload-notes.ts`, `src/db/`,
`src/store/notes-store.ts`, `NotesView`, notes provider metadata.

**Acceptance and reviewer demonstration**

1. Upload unchanged content twice: the second upload makes no embedding/summary
   calls and preserves document identity.
2. Replace a valid document and fail each processing stage: the previous active
   text, chunks, vectors, and summary remain available until a successful swap.
3. Fail summarization after indexing: the UI reports partial success, then retries
   only the missing stage using the correct stored text.
4. Reverse completion order for two revisions of the same file: stale work cannot
   overwrite the newer accepted revision. Campaigns with identical filenames remain
   independent.
5. Backfill an older pending summary during a later batch: it receives its own source
   text, not an empty string. Interrupted work can resume after restart.
6. Migrate a legacy database and run a failed reindex: existing notes and unrelated
   campaign data remain intact; foreign-key checks pass.

**Boundary:** M1 stores reliable retrieval inputs. The document reader, search
ranking, citations, and answering agent belong to M2.

### M1 completion gate

All four PRs pass their scenario checks, existing tests, type checking, and build.
Migrations are tested against representative legacy data and rollback/failure cases.
Document the limits of recovery, revision retention, and cancellation. Update the
README only for behavior actually delivered. M1 completion is not a claim that
retrieval or the remaining export defects are fixed.

## M2 — Complete the defining workflow

**Outcome:** a GM uploads notes, asks a question with inspectable citations, and
builds a dungeon whose plan and descriptions agree with both those notes and the map.

**Dependencies:** M2.1 builds on M1.4's source revisions; M2.2 and M2.3 reuse M2.1.
Both use M1's operation, save, and authorship contracts. The suggested review order
is M2.1 → M2.2 → M2.3; no general-purpose agent platform is a prerequisite.

### M2.1 — Document reader, hybrid retrieval, and retrieval evaluation

Build a reader that opens a document/heading/chunk and its source revision. Expose
campaign-scoped lexical search using the existing FTS5 index, semantic search over
normalized vectors, reciprocal-rank fusion, deduplication, and neighbor expansion.
Start with the existing linear vector scan; introduce an index only when measured
corpus sizes justify it. Provide a CLI/API diagnostic surface before attaching an AI.

Use explicit source selection and a context budget. A citation contains document
identity, revision, heading, and span; editing a document must not silently make an
old citation point to new text. Preserve cited revisions or display their removal
explicitly if a user deletes the source.

Create a checked-in, non-private evaluation corpus with at least 30 queries covering
proper names, paraphrases, multi-document facts, conflicts, repeated filenames,
missing facts, and campaign isolation. Report lexical, semantic, and fused results.
Initial target: relevant source in the top five for at least 90% of answerable
queries, with zero results from another campaign. Record the dataset and threshold
before tuning to avoid quietly redefining success around failures.

**Acceptance:** reader deep links resolve; results remain tied to source revisions;
isolation and ranking targets pass; empty queries, empty indexes, and missing vector
models have useful outcomes. Deterministic tests use cached/synthetic vectors.
Live cloud query embedding can cost credit; retrieval logic testing does not require it.

### M2.2 — Loremaster with bounded tools and inspectable answers

Implement `list_documents`, `search_notes`, and `read_document` as read-only,
campaign-bound tools. Add a bounded tool loop, context/turn limits, streaming answers,
cancel/retry, and persistent messages/tool provenance. Retrieved text is evidence,
not executable instructions or authority to change the application.

Render readable responses with clickable citations, source previews, and an explicit
distinction between documented facts and proposed ideas. Handle contradictory notes
and insufficient evidence honestly. Preserve a cancelled/failed draft and partial
answer visibly. Remove the unfinished banner only when answering is functional.

**Acceptance:** an answer opens its supporting source; unsupported questions do not
fabricate citations; conflicting notes are identified; tool budgets terminate loops;
cancellation/navigation remains safe under M1. Test tool orchestration with mocks and
record the scope of any separate live-provider evaluation.

### M2.3 — Grounded Architect, Narrator, and constraint checks

Reuse the same retrieval service for Architect briefs and Narrator context. Let the
user select sources and inspect which passages informed the plan. Store generation
provenance and separate source facts from invented connective material.

Present an editable room/connection plan, with stable node identities and locked
requirements. Carry door preferences and gate requirements into generation or report
them as unmet; a prose annotation must not masquerade as an enforced constraint.
Validate requested entrances, connectivity, reachability, room budget, and mandatory
connections against the built map. Make blueprint/procedural limits and ignored
controls explicit. Use actual built connections for narrator entries and retain the
room-ID validation from M1.2.

**Acceptance:** the reference scenario, "build the crypt under Vess as described in
these notes," yields a plan with inspectable sources, a map whose constraint report
matches its geometry, and room descriptions consistent with that geometry. Updating
a note offers an explicit refresh; it never silently overwrites a saved dungeon.

**M2 exit gate:** run the full notes → question → sourced plan → map → descriptions
journey on a sample campaign. Keep the procedural API usable without AI; the
first-run preset UI is delivered in M3.2.
An implementation with only upload and chat storage does not satisfy this milestone.

## M3 — Make it comfortable at the table

**Outcome:** common GM tasks are easy to find, feedback is clear, and exported
material can be trusted. Export correctness is the first package because it includes
known defects, not just polish.

**Dependencies:** all packages reuse M1's ownership and revision model. M3.1 can
ship ahead of M2 if prioritized; M3.2's sourced creation path and M3.3's source-link
round trips require M2. M3.4 instruments the provider operations delivered by both
earlier milestones. Keep each package independently reviewable.

### M3.1 — Trustworthy exports and audience controls

- Resolve current room notes, legacy descriptions, overview, names, and annotations
  into one export model. Fix the map PDF's outdated description fields and paginate
  long prose, lists, and room keys without clipping.
- Add explicit GM/player profiles. Player output omits GM prose, hidden treasure,
  traps, revealing labels, and visible secret-door glyphs. Define separately how
  secret passages remain concealed and how GM-only VTT wall/portal data behaves;
  hiding a glyph alone does not hide a secret entrance.
- Correct VTT portal bounds, radians, states, wall alignment, and feature visibility.
  Keep audience rules consistent across PNG, PDF, VTT, and description formats.
- Add export preview, pixel/grid resolution, labels, grid, physical scale, paper size,
  and tiled printing. Cap pixel area and memory before allocating canvases; allow
  lower resolution or tiles for large maps and report failures accessibly.
- Consolidate duplicate export controls and load PDF/export dependencies on demand.

**Acceptance:** authored room text appears in the combined PDF; player fixtures
contain no GM-only content; horizontal/vertical and secret/open/locked portals import
correctly in documented supported VTT versions; a representative large map completes
within the declared export budget or receives an actionable preflight message.
Retain sample export fixtures and import evidence, not just screenshots of buttons.

### M3.2 — Clear creation flow and adaptable map workspace

- Offer quick procedural presets, an AI brief, and campaign-sourced generation at
  creation. A first map works without a provider key; provide a sample campaign.
- Group basic and advanced configuration, explain blueprint overrides, and make
  requested versus delivered layout results visible. Distinguish Build Map,
  Populate Rooms, Reroll/New Version, and Apply Proposed Changes.
- Replace raw streaming JSON with named stages, useful progress, cancellation, and
  next actions. Surface bulk room actions and incomplete-room filters.
- Add resizable/collapsible panels, Fit Map, Focus Selected Room, and persistent
  layout preferences. Use drawers/tabs at narrow widths; support pointer/touch pan
  and zoom. Keep developer inspection tools in a debug surface.
- Improve room preparation with read-aloud/GM sections, editable overview, per-field
  locks, and field-level regeneration. Add before/after refinement previews and
  partial acceptance that preserves locks and stable identities.
- Make keyboard navigation, tab semantics, dialog focus trapping/restoration,
  accessible labels, status announcements, focus visibility, and reduced motion part
  of the components being delivered. Preserve native text shortcuts.

**Acceptance:** create a first map with no AI key; complete the core workflow by
keyboard; select and edit a room on a tablet layout without losing the map; test at
390, 768, 1280, and 1920 CSS pixels and at 200% browser zoom. No core action is
available only by hover, and unsupported small-screen editing has an explicit,
usable fallback rather than clipped controls.

### M3.3 — Campaign library, versions, and recovery

Add campaign/map search, sorting, thumbnails, rename for chats and campaign details,
and visible parent/version navigation. Include version comparison, recoverable
deletion/trash with clear retention, and a versioned project backup/import format.
The backup includes source documents, geometry, authored content, provenance, and
appropriate history; exclude API keys and machine-specific secrets. Explain whether
embeddings are included or must be rebuilt, and the cost implications of rebuilding.

**Acceptance:** restore an exported campaign into a clean database and compare its
map, notes, authored content, and source links. Restore a trashed dungeon with its
notes/chat intact. Validate an import completely before committing it; a corrupt or
unsupported file leaves existing campaigns unchanged. Lists remain usable with a
representative large campaign, and missing/deleted routes provide a path back.

### M3.4 — Transparent providers, operations, and estimated usage

Show readiness and active models separately for generation, note embedding, and
summarization. Support intentional Ollama endpoint/model selection and make the
scope of local processing explicit. Separate browser-safe catalog metadata from
server-only provider clients and credentials. Show compatible capabilities instead
of controls that a selected model ignores.

Record usage for ingestion and query embedding as well as generation. Include
failed/cancelled operations and distinguish known token usage from unknown usage.
Store the rate version/date applicable to an estimate; do not silently reprice all
historical calls when a rate changes. Keep unknown rates visibly unknown. Show
expected stages/calls, configurable operation limits, and actual recorded usage;
provider billing remains the authority for final charges.

**Acceptance:** every provider operation is attributable to the correct owner and
operation; unpriced/partially measured calls cannot appear as free; changing today's
rate leaves historical estimates reproducible; setting a generation provider does
not silently alter notes processing. Broken credentials, unavailable models, and
unsupported capabilities produce actionable setup feedback.

**M3 exit gate:** conduct a complete sample-session preparation and export walkthrough
covering the narrow layout, keyboard flow, failure feedback, and player-facing files.
Document supported browsers/VTT targets and remaining accessibility limitations.

## M4 — Expand after measuring

These are candidate packages after the core workflow is dependable. Select their
order from observed use and measured bottlenecks rather than opening all at once.

### M4.1 — Complete and distinguish map themes

Implement Natural, Arcane, Undead, Mechanical, and Frozen palettes with previews.
Separate map style, narrative motif, and application light/dark mode. Check text,
door, grid, and feature readability in exports and both UI modes. Preserve the
current wall treatment and the explicit decision not to add hatch fringe.

**Acceptance:** every offered visual theme has a distinct implemented preview and
consistent shared-renderer output; semantic features remain distinguishable in print.

### M4.2 — Encounter and session preparation

Expose game system/edition, party level/size, encounter intensity, and tone. Provide
structured, editable encounters and treasure, a compact GM session view, and optional
at-table revealed/visited state that does not modify the underlying authored map.
Use verified rules/content sources where available; do not present invented book
pages or model-generated mechanics as authoritative references.

**Acceptance:** changing encounter settings has inspectable effects, authored locks
survive regeneration, and a session can be run from the exported or local GM view.

### M4.3 — Connected dungeon levels

Introduce level identities and explicit stair/transition endpoints, migrate existing
dungeons to one level, and add level navigation and cross-level validation. Extend
room links, history, backups, provenance, and exports together. Preserve independent
level editing; a level deletion must explain affected transitions and be recoverable.

**Acceptance:** a two-level dungeon round-trips through backup, each stair resolves
to its actual destination, and editing one level does not corrupt another's content.

### M4.4 — Measured performance and Rust/WASM integration

Benchmark generation, edit reconciliation, rendering, API serialization, and export
separately. Use representative constructed/organic/blueprint maps and campaign sizes;
record p50/p95 time, memory, and UI responsiveness on named hardware. Set budgets
from those measurements before selecting work.

Continue Rust ports behind the TypeScript implementation, using unchanged golden
fixtures plus invariant/property tests. Add engine-version metadata to reproducible
artifacts. Port only demonstrated bottlenecks, retaining a tested fallback and a
clear WASM loading/error path. Seed + config + blueprint + engine version describe
procedural reproduction; manual edits and authored prose require a saved artifact.

**Acceptance:** the selected workload improves against the recorded baseline without
breaking conformance or the shared geometry/rendering contract. Test the documented
PRNG compatibility boundary as relevant; do not regenerate golden data merely to
make a port pass. If profiling favors TypeScript changes or worker isolation, use
that result to revise the package.

## Verification and PR handoff

The review baseline on 2026-09-19 was 1,288 passing Bun tests across 14 files,
28 passing Rust tests, a passing TypeScript check, and a successful production build.
Those checks did not cover the reproduced workflow defects. The browser connection
was unavailable during that review; interactive UI observations still need execution.

For each implementation PR:

- Add focused regression tests for the observable failure and meaningful invariant
  checks for the changed behavior. Keep tests with their fix; avoid separate test-only
  PRs and assertions that merely mirror implementation details.
- Use isolated temporary/in-memory databases, mocked providers, and synthetic notes
  for regression checks. Do not mutate real campaigns or spend provider credit just
  to exercise a retry/cancellation path. Track any live-provider validation separately.
- Run `bun test`, `bun x tsc --noEmit`, and `bun run build`. Run Rust tests when Rust,
  shared generation contracts, or conformance data changes; do not repeatedly run
  unrelated checks for documentation-only changes.
- For schema changes, test populated upgrades, interruption/rollback, ownership
  cascades, revision retention, and `PRAGMA foreign_key_check`. Provide a backup and
  rollback procedure; do not use the user's live database as a migration fixture.
- For UI behavior, run the package's browser scenarios and attach concise screenshots
  or a recording where visual comparison helps. Report unavailable browser checks as
  unverified, not as passing. For exports, inspect the produced artifact/import.
- Write a PR description with the concrete before/after behavior, grouped scope,
  acceptance results, migration/recovery impact, and remaining limits. Include one
  short reviewer walkthrough for the complete feature.
- Update TASKS status and README capabilities in the same PR. Mark a package complete
  only when its acceptance criteria pass; a green legacy test count alone is not enough.

## Known follow-ups and boundaries

- The historical task tracker records an exposed `ANTHROPIC_API_KEY`. Verify rotation
  outside the code-change workflow and then close that follow-up. Never print a key,
  inspect transcripts to rediscover it, or describe its current status as verified
  without evidence. Do not use a `VITE_` prefix for secrets.
- Until M3 export safeguards ship, exports should be treated as GM material and
  inspected before sharing. A player-safe claim must wait for audience filtering.
- Usage events intentionally survive deletion with nullable owner references; they
  are an accounting exception to the otherwise cascading campaign ownership tree.
- Clean up the obsolete `src/index.ts` entry point and dead CSS when touching the
  relevant startup/workspace areas. These do not need standalone PRs.
- The initial build's largest JS chunk was about 809 kB uncompressed. Establish a
  measured bundle baseline and lazy-load export/provider-only code within M3.
- Multi-user hosting, public sharing, marketplaces, and a general agent framework
  are outside these four milestones. They would require a separate product decision.
