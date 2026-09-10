# Dungeon Slop — Task Tracker

## The model

One tree, and everything is inside it:

```
Campaign          the only root — independent, named, deletable
├── Notes         .md/.txt, chunked + embedded, campaign-scoped
├── Chats         Loremaster threads over those notes
└── Dungeons      each a standalone named map
    ├── Architect chat   exactly one per dungeon — the build log
    ├── Rooms            generated geometry + authored description
    └── Edit history     undo stack, per open dungeon
```

Ownership rules, enforced by foreign keys:

1. Nothing exists outside a campaign.
2. Deleting a campaign deletes its notes, chunks, embeddings, dungeons, room
   notes, chats and messages — one cascade, no orphans.
3. Notes are campaign-scoped, never dungeon-scoped. A dungeon *reads* its
   campaign's notes; it never owns them.
4. A dungeon owns its rooms. Rooms are never shared.
5. Chats own nothing. Deleting one loses the transcript and nothing else.

Design write-up: https://claude.ai/code/artifact/0feddc27-c869-429c-806c-a14353584687

---

## Running it

```sh
bun run dev      # API (Bun.serve) on :3000 + vite on :5173, /api proxied
bun test         # 928 pass, 0 fail
bun x tsc --noEmit
bun run build
```

`bun` is at `%USERPROFILE%\.bun\bin\bun.exe` and is **not** on PATH in non-interactive
shells. `concurrently` spawns two bun processes, so killing one leaves the other bound to
its port — kill by port when restarting. Health-check both, since a green vite says nothing
about the API:

```sh
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5173
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/campaigns
```

State lives in `notes.sqlite` at the repo root, not in localStorage. Full verification
recipes are in `.claude/skills/verify/SKILL.md`.

---

## Phase status

| Phase | Description | Status |
|-------|-------------|--------|
| 0 | Project Scaffold | DONE |
| 1A | AI Provider layer | DONE |
| 1B | AI Architect layer | DONE |
| 2A | BSP Engine | DONE |
| 2B | Cellular Automata Engine | DONE |
| 2C | Corridors & Features | DONE |
| 2D | Engine Test Suite | DONE |
| 3A | Canvas Renderer & Themes | PARTIAL — two render paths that can disagree |
| 3B | Room Interaction | DONE |
| 4 | Content Generation | DONE |
| 5A | Export Pipeline | DONE |
| 5C | Canvas Map Editor | DONE |
| 6A | Note ingest — chunk, embed, summarize | DONE |
| 7A | Schema v2 + migration | DONE |
| 7B | Router, rail, campaign CRUD | DONE |
| 7C | Dungeons as rows, reroll-as-fork | DONE |
| 7D | Notes as a campaign-scoped page | DONE |
| **7E** | **Hybrid retrieval (BM25 + vector, RRF)** | **NOT STARTED — costs no API credit** |
| 7F | Loremaster agent — tool runner, citations | NOT STARTED — spends credit |
| 7G | Architect reads campaign notes | NOT STARTED — spends credit |

Suite: **928 tests, 0 failures, 0 type errors.** There is no known-bad baseline left to
discount — any failure is a regression.

---

## Where things live

| Concern | Module |
|---|---|
| Schema, migrations, connection | `src/db/` |
| Campaign / dungeon / chat accessors | `src/campaign/` |
| Note ingest, chunking, embeddings | `src/notes/` |
| HTTP handlers + route table | `src/api/` |
| Client router (hand-rolled, 6 routes) | `src/router/router.ts` |
| Typed client for the API | `src/store/api.ts` |
| Rail / context column / views | `src/components/layout/`, `src/components/views/` |
| Server entry point | `src/server.ts` |

The one hard rule: **anything the browser imports must not reach `bun:sqlite`
or `process.env`.** Vite stubs those silently, so the symptom is a blank page
rather than a build error. Shared constants live in `src/notes/shared.ts`;
shared types in `src/campaign/types.ts` (type-only, no runtime imports).

---

## Open tasks

### NEXT — the feature this was all for

- [ ] **7E — Hybrid retrieval.** BM25 over the existing FTS5 index + brute-force
      cosine over `embeddings`, fused with reciprocal rank fusion
      (`1/(60+rank)`), plus neighbour expansion on `chunks.ordinal`. Scoped by
      `campaign_id`. Expose as a CLI first so recall is provable before a model
      sees it. **No API calls.**
- [ ] **7F — Loremaster.** Tool runner with `list_documents`, `search_notes`,
      `read_document`. SSE into the existing `ChatThread`; citations already
      have a schema, a store field and a rendered form. Remove the placeholder
      banner in `ChatView.tsx` when this lands.
- [ ] **7G — Architect gets `search_notes`,** scoped to the parent campaign.
      "Build the crypt under Vess the way my session notes describe it."

### SIGNIFICANT — pre-existing bugs, still open

- [ ] **VTT door bounds are identical on both ternary branches**
      (`src/export/vtt-export.ts:253-266`) — the `isHorizontal` ternary returns
      the same four points either way, so horizontal and vertical doors export
      the same rectangle. Only `rotation` differs.
- [ ] **5 of 8 motifs have no palette.** `themeMap` in
      `src/renderer/themes/theme-engine.ts:25` covers Default, Infernal and
      Aquatic; Natural, Arcane, Undead, Mechanical and Frozen fall through
      `?? defaultTheme` silently, so choosing them looks like it did nothing.
- [ ] **Two render paths that can disagree.** `renderDungeon()` exists in
      `src/renderer/canvas-renderer.ts:168`, but `DungeonCanvas` draws inline
      with its own `ctx` calls. It does read the theme via `getTheme`, so this
      is duplication rather than a bypass — but the canvas and the PNG export
      are separate implementations and drift is unnoticed until they differ.

### MINOR

- [ ] **`src/index.ts` is dead code.** The old `Bun.build` frontend bundler,
      superseded by Vite. Nothing imports it, though `package.json`'s `"module"`
      field still points at it. Delete it and repoint the field.
- [ ] Two dead CSS section headers (`/* ===== SIDEBAR ===== */`,
      `/* ── Session history ── */`) sit above the chat rules in `index.css`
      with no rules under them, left over from the components that were removed.
- [ ] Chats cannot be renamed — a thread takes its title from the first user
      message and keeps it.
- [ ] Notes view has no document reader — you can see a summary and chunk count
      but not the text.
- [ ] No search across a campaign's dungeons or chats.
- [ ] Bundle is 757 kB; `jspdf` + `html2canvas` are the bulk and could be
      loaded on demand at the export click.
- [ ] No README. The project has no front door for anyone arriving cold, which
      matters for something being shown as portfolio work.

### SECURITY

- [ ] **Rotate `ANTHROPIC_API_KEY`.** It was printed in full into session output
      by a pre-commit hook bug, and Claude Code transcripts persist under
      `~/.claude/projects/`. `GEMINI_API_KEY` has already been rotated.
      Never prefix a secret with `VITE_` — Vite inlines those into the client bundle.

---

## Done in this pass

- Schema v2: `campaigns`, `dungeons`, `room_notes`, `chats`, `messages`;
  `documents` rebuilt with `campaign_id` and `UNIQUE (campaign_id, filename)`.
- v1 → v2 migration with the create-copy-drop-rename rebuild SQLite requires,
  foreign keys off across it so `DROP TABLE documents` cannot cascade through
  `chunks` and `embeddings`. Idempotent; verified against the live database.
- One-shot localStorage import (`/api/legacy-import`), stamped in `meta` so it
  runs exactly once no matter how many tabs try.
- **Reroll forks instead of overwriting.** It used to replace geometry in place
  and drop every room description with it, because new geometry means new room
  ids. Generating over a described map now inserts a sibling with `parent_id`
  set. Same rule for Generate.
- `history-store` deleted. Its 20 snapshots existed only because there was
  nowhere to put a second dungeon; that is the dungeon list now. Its orphaned
  `undo`/`redo`/`canUndo`/`canRedo` went with it.
- `dungeon-store` no longer persists to localStorage — it is a working copy over
  a debounced autosave, flushed on navigation and on `beforeunload`.
- **Delete + confirmation across the whole tree.** Campaigns, dungeons, chats,
  notes and single room descriptions can all be removed, each behind a shared
  `useConfirm()` prompt (`src/components/shared/ConfirmDialog.tsx`). Before this,
  only campaigns had a delete and note removal fired on the first click with no
  confirmation at all. Prompts state real counts rather than "are you sure?";
  Cancel takes focus; deleting the open dungeon or chat navigates back to
  campaign home so the route is never left pointing at a deleted row.
