# dungeon-slop

A dungeon generator and map editor for tabletop games, with an AI architect that
plans rooms and connections and a narrator that writes room descriptions.

Runs locally on Bun + SQLite. The name undersells it; the test suite does not.

```
1390 pass · 0 fail · 29 files
```

M2.1 automated verification: 2026-09-21. Rust has 28 baseline passing tests (not
rerun for this notes-only change). Coverage includes save recovery, authored
revisions, edit reconciliation, recoverable ingestion, source reading and retrieval. Live browser
verification remains pending; export corrections remain on the roadmap.

See [ROADMAP.md](ROADMAP.md) for the four milestones and detailed PR scopes, and
[TASKS.md](TASKS.md) for execution status. Milestone 1 is grouped into four PRs:
reliable requests/saves, authorship/revisions, editor consistency, and note ingestion.

## The idea

Most dungeon generators hand you noise: a plausible-looking maze with no
relationship to your campaign. Most AI writing tools hand you prose with no
relationship to a map. The goal here is to connect both halves with inspectable
sources and dependable editing.

The intended workflow: drop your campaign notes in and tell the architect "the
cult's flooded undercroft, three ways in, the ritual chamber should be hard to
reach." It retrieves relevant notes and produces a **blueprint** — rooms, roles,
adjacency — the procedural engine lays that out as real geometry, and the narrator
writes rooms consistent with the map and those sources.

**Today:** prompt/chat-driven planning, procedural layout, narration, editing,
note ingestion, source reading and campaign search exist. Retrieval is not connected to the Architect or Narrator,
and the Loremaster saves questions but does not answer. Completing that connection
is milestone 2, after protecting existing work in milestone 1.

## Everything lives in one tree

```
Campaign          the only root — independent, named, deletable
├── Notes         .md/.txt, chunked + embedded, campaign-scoped
├── Chats         Loremaster threads over those notes
└── Dungeons      each a standalone named map
    ├── Architect chat   exactly one per dungeon — the build log
    ├── Rooms            generated geometry + authored description
    └── Edit history     undo stack, per open dungeon
```

Campaign content ownership is enforced by foreign keys: deleting a campaign takes
its notes, chunks, embeddings, dungeons, chats, and room descriptions with it.
Usage events intentionally survive with nullable owner references so the accounting
record is retained. Schema migrations run on open (`src/db/migrate.ts`).

## Reliable saves and recovery

Dungeon changes share a revision-checked save queue. Failed saves retain their pending
edits; the workspace shows retry, recovery-export and explicit conflict-resolution
choices. Leaving a dungeon cancels its interactive generation, and stale responses
cannot apply to the newly selected dungeon. Provider work already performed may
still be charged.

Recovery copies are bounded to 4 MiB / 20 pending maps per browser origin. If storage
is full or unavailable, keep the tab open until Saved or export the local copy.
The local API explicitly binds to loopback and checks browser mutation origins.
See [M1.1 review and operating notes](docs/M1.1-REVIEW.md) for API compatibility,
migration precautions, limits and the outstanding browser verification checklist.

## Generation is deterministic

`src/engine/` is a procedural pipeline driven by a **seeded RNG**
(`src/lib/random.ts`). The same seed and config reproduce procedural geometry for
the same engine version; blueprint generation also requires the same blueprint.
Manual edits and authored descriptions require a saved artifact, not just a seed.

The pipeline:

1. **BSP partition** (`bsp.ts`) with a room budget planner, or **cellular
   automata** (`cellular.ts`) for cave-shaped levels.
2. **Room shapes** (`shapes.ts`) carve non-rectangular footprints — rounded,
   cross, irregular — into the grid.
3. **Corridors** (`corridors.ts`) connect them, with a separate entry-corridor
   pass so the way in is not an accident of the graph.
4. **Layout rules** (`layout-rules.ts`) assign room roles, enforce a corridor
   budget, and check for loops — because a dungeon that is a pure tree plays
   badly and a dungeon that is all loops has no tension.
5. **Walls** are derived from floor adjacency. Committed manual edits reconcile
   geometry, features, connectivity, and layout warnings together.

### The tests are invariants, not snapshots

This is the part I would point at. Rather than asserting that seed 12345 makes a
specific map — a test that breaks the instant you tune anything — the suite
asserts properties that must hold for **every** generated dungeon:

- *a corridor never occupies a room cell*
- *a corridor path is contiguous*
- *every room outline is a closed ring*
- *every wall of the drawn floor lies on the outline*

These run over many generated dungeons. Tuning the generator freely is safe;
breaking its guarantees is not. The renderer has its own invariant suite for the
same reason — a map that draws a wall where there is no wall is a bug you will
otherwise find at the table, mid-session, in front of five people.

## Two AI passes, three providers

**Architect** uses separate config and blueprint prompts (`src/ai/prompts/`).
Config is validated by `src/ai/schema.ts`, and the blueprint by
`src/ai/blueprint.ts`; `blueprint-layout.ts` turns the plan into geometry. **Narrator**
(`src/ai/prompts/narrator.ts`) writes room descriptions afterwards, with the map
and chat history as context. A **refine** pass handles "make the east wing bigger"
style edits against an existing map.

Providers are pluggable (`src/ai/providers/`): **Claude**, **Gemini**, and
**Ollama** for local generation. One registry resolves generation provider, model,
and key. Note embedding and summarization use separate environment configuration;
selecting Ollama in the UI does not make note processing local.

Generation token usage is recorded in `usage_events`, with a tested pricing module
(`src/ai/pricing.test.ts`). Cloud rates are currently unset, and note-processing
calls are not yet included. This is not a complete billing record; coverage and
reproducible cost estimates are planned in milestone 3.

## Notes ingestion, source reader and retrieval

`src/notes/` stores original text and stable document revisions, then builds and
validates chunks/vectors before atomically replacing the active index. A failed
replacement keeps the previous index and summary. Unchanged completed uploads make
no provider calls; a failed summary can be retried without re-embedding.

The Notes library shows embedding/summary providers, per-file outcomes, cancellation,
Retry, and per-note Reindex. Uploads are limited to 20 files, 5 MiB per file, and
20 MiB total. Legacy notes keep their existing search data; reupload is required
only when an operation needs their unavailable original source. Current active and
latest attempted source texts are retained, not an unlimited revision history.
See [M1.4 review and recovery limits](docs/M1.4-REVIEW.md) for migration, restart,
model compatibility, retention, and verification details.

The Notes library now offers local keyword search, semantic search, and hybrid
rank fusion, with explicit source selection and an estimated context budget.
Semantic/hybrid searches send the query to the configured notes embedding provider
and may incur charges. Keyword search needs no key. Model mismatch or provider
failure gives an actionable warning; hybrid can fall back to keyword results.

Open a filename, heading, or result to read its source revision and highlighted
passage. Old links never silently switch to a replacement: a removed revision is
explicitly unavailable. Legacy notes show stored chunks when exact text is missing.
The reader displays source text rather than executing embedded HTML.

`bun run eval:retrieval` runs a fixed 36-query, two-campaign synthetic benchmark:
keyword hit@5 **84.8%**, semantic and hybrid **100%**, with **zero cross-campaign
results**. These are deterministic integration results, not cloud-model quality
claims. See [M2.1 review, API and limits](docs/M2.1-REVIEW.md) and the
[checked-in evaluation report](docs/M2.1-EVAL.json). Search retrieves evidence;
it does not generate answers or determine whether a claim is supported.

The point is that a 200-page campaign wiki does not fit in a context window, and
stuffing in the first 8k tokens of it gets you a dungeon themed around your
table of contents.

## Rendering and export

A canvas renderer (`src/renderer/`) with themed tilesets, real door symbology
(secret doors, portcullises, double doors), a hand-drawn **sketch** mode, and an
SVG overlay layer for text and grid. Polygon work via `polybooljs`.

Export to **PDF** (`jspdf`), **PNG**, **VTT** formats for virtual tabletops, and
plain **Markdown descriptions** for your notes app.

Export correctness and audience controls need work: the combined map PDF can miss
current room text, and description exports contain GM secrets. Treat exports as GM
material and inspect them before sharing. Player-safe profiles, VTT corrections,
and large-map export limits are planned in M3.1.

## Running it

```bash
bun install
cp .env.example .env    # fill in whichever provider you want
bun run dev             # API + Vite, concurrently
```

`.env.example` documents provider configuration. **Gemini is the default**;
provider availability, quotas, and pricing depend on the account and model.
Config, blueprint, batched room narration, and overview generation are separate
calls, so call count varies with the chosen workflow and number of rooms. Ollama
supports local generation; configure notes providers separately.

```bash
bun test                # 1390 tests
bun run eval:retrieval  # synthetic notes only; no paid calls
bun run build
```

### On secrets

`.env` is gitignored, and `.githooks/pre-commit` is a backstop that refuses any
staged env file or key-shaped string, reporting a **count and never the value** —
a hook that echoes the secret it caught has leaked it into your scrollback.
Enable it with:

```bash
git config core.hooksPath .githooks
```

## Stack

Bun (runtime, test runner, package manager, and SQLite driver), React 19 +
TypeScript, Vite, a hand-rolled client router, Zustand-style stores. No ORM — the
schema is SQL and the migrations are explicit.

## Honest limitations

- **Single level per dungeon.** Stairs render as features but do not connect to
  a second floor. Multi-level is a data model change, not a rendering one.
- Loremaster answers and retrieval-grounded generation are not implemented. Current AI output
  relies on the prompt/chat and can invent details; it has no verified note citations.
- Recovery is bounded, not a backup system. Review the M1 operating notes and keep
  backups of your SQLite database. Live-browser acceptance checks are still pending.
- Local single-user app. No auth, no multi-user, no hosted mode. The API binds to
  loopback; do not expose it as a hosted service.
- Five of eight visual motifs currently fall back to the default palette.
- Narration still replaces room prose as a whole; previous authored values are
  checkpointed for restoration. It is not a granular collaborative text editor.
