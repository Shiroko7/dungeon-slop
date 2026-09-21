# Dungeon Slop — Task Tracker

Updated 2026-09-21. [ROADMAP.md](ROADMAP.md) is the authoritative plan, including
scope, dependencies, and acceptance criteria. This file tracks execution. The
September review and roadmap are complete. M1.1–M1.4 are merged. M2.1 is implemented
merged with automated checks passing; M2.2 is implemented on its review branch;
live browser verification is pending. See the
[M2.2 review guide](docs/M2.2-REVIEW.md) for limits and remaining checks.

## Milestone 1 in four PRs

Review and merge one complete behavior at a time. Include its UI, API, persistence,
migrations, and regression tests together; do not open one PR per checkbox.

| Order | PR / review unit | Status | Depends on |
| --- | --- | --- | --- |
| M1.1 | Reliable requests, saves, and local data ownership | MERGED ([#1](https://github.com/Shiroko7/dungeon-slop/pull/1)); browser checks pending | — |
| M1.2 | Safe drafts, authored revisions, and generation/fork adoption | MERGED ([#2](https://github.com/Shiroko7/dungeon-slop/pull/2)); browser checks pending | M1.1 |
| M1.3 | Consistent geometry, features, and connectivity after edits | MERGED ([#3](https://github.com/Shiroko7/dungeon-slop/pull/3)); browser checks pending | M1.1 + M1.2 |
| M1.4 | Atomic, recoverable note ingestion | MERGED ([#4](https://github.com/Shiroko7/dungeon-slop/pull/4)); browser checks pending | M1.1 |

M1.4 is otherwise independent; the default order remains M1.1 → M1.2 → M1.3 → M1.4
to keep review sequential. The detailed PR contracts are in
[milestone 1](ROADMAP.md#m1--protect-work).

- [x] **M1.1:** owner/revision-bound operations; stale-load guards; cancellation;
      ordered, acknowledged, recoverable saves; conflict/recovery UI; API ownership
      validation; loopback listener; regression scenarios and migration checks.
- [x] **M1.2:** room-specific drafts and native text undo; persisted authorship
      checkpoints; safe new versions for Generate/Reroll/Refine; preserved original
      plans; visible fork adoption; schema/room-ID validation; safe chat editing;
      reachable describe-missing action; failure and retry scenarios.
- [x] **M1.3:** reconcile cells, room footprints, features, corridor endpoints,
      connections, walls, and reports; interpolate strokes; define room split/merge
      identity and content recovery; consistent undo/reload/rendering; edit invariants.
- [x] **M1.4:** stored source revisions; unchanged-upload no-op; staged atomic index
      replacement; concurrency/model checks; separate summary retries; correct
      backfill; bounded uploads; visible notes providers; legacy-preserving migration.
- [ ] **M1 exit gate:** all package acceptance scenarios pass, schema upgrades retain
      existing data, recovery limits are documented, and README claims match delivery.

Implementation checkmarks are not browser sign-off. The M1 exit gate remains open
until the outstanding interactive review checklists are completed.

## Subsequent milestones

The groupings below are provisional until the milestone is scheduled. Keep related
changes together and update the roadmap if evidence changes scope.

| Milestone | Proposed packages | Status |
| --- | --- | --- |
| M2 — Complete the defining workflow | M2.1 reader/retrieval/evaluation; M2.2 Loremaster; M2.3 grounded Architect/Narrator | M2.1 IMPLEMENTED — draft review; M2.2/M2.3 PLANNED |
| M3 — Make it comfortable at the table | M3.1 exports; M3.2 creation/workspace/accessibility; M3.3 library/recovery; M3.4 providers/usage | PLANNED |
| M4 — Expand after measuring | Themes; encounter/session preparation; connected levels; measured Rust/WASM acceleration | CANDIDATES |

M2.1 is merged. M2.2 is the current draft review unit; M2.3 remains planned.

Known export disclosure/format defects are tracked under M3.1 and remain unresolved.
Treat current exports as GM material and inspect before sharing. A focused urgent
correction can move earlier without pulling in the entire export redesign.

### Current review unit: M2.2

Reader deep links bind campaign/document/revision/chunk identity. Campaign-scoped
keyword, semantic and hybrid search share source filtering, rank fusion, overlap
deduplication, neighbor expansion, context budgets, provider validation and cancellation.
M2.2 adds the bounded Loremaster loop over those diagnostics, with streaming,
revision-bound citations, cancellation, and persisted tool provenance.

Automated acceptance covers the bounded Loremaster loop, campaign-owned read-only
tools, SSE streaming, cancellation, persisted citations/tool provenance, and the
chat UI. The fixed 36-query synthetic evaluation still reports 84.8% keyword and
100% semantic/hybrid hit@5 with zero cross-campaign hits. No paid provider calls or
live-database mutations. Interactive browser checks remain unverified, so this
package is not marked complete. See [the M2.2 review guide](docs/M2.2-REVIEW.md).

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
3. Notes are campaign-scoped, never dungeon-scoped. A dungeon never owns them;
   having the Architect/Narrator read them is planned in M2.
4. A dungeon owns its rooms. Rooms are never shared.
5. Chats own nothing. Deleting one loses the transcript and nothing else.

Usage events are an intentional exception: owner references become null on deletion
so the accounting ledger survives. New recovery/history rows must have explicit
ownership and retention rules.

Historical design write-up:
https://claude.ai/code/artifact/0feddc27-c869-429c-806c-a14353584687

---

## Running it

```sh
bun run dev      # API (Bun.serve) on :3000 + vite on :5173, /api proxied
bun test
bun x tsc --noEmit
bun run build
```

Review baseline, 2026-09-19: **1,288 Bun tests across 14 files, 28 Rust tests, no
failures; type checking and build pass.** The reproduced workflow bugs were outside
that coverage. Browser verification was unavailable during the review and remains
required for implementation changes involving UI behavior.

For changes to Rust or shared generation/conformance contracts, also run
`cargo test --manifest-path rust/Cargo.toml`.

`bun` is at `%USERPROFILE%\.bun\bin\bun.exe` if a shell cannot find it on PATH.
`concurrently` spawns two bun processes, so killing one can leave the other bound to
its port. Check process ownership before stopping a server. Health-check both,
since a green vite says nothing about the API:

```sh
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5173
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/campaigns
```

Committed state lives in `notes.sqlite` at the repo root. Never use it as a fixture
for destructive tests or migrations. Use isolated temporary/in-memory databases and
mocked providers. Local verification recipes are in `.claude/skills/verify/SKILL.md`;
PR-level acceptance requirements are in [the roadmap](ROADMAP.md#verification-and-pr-handoff).

---

## Implemented foundations and current gaps

| Area | Current state | Follow-up |
| --- | --- | --- |
| BSP/cellular generation, corridors, shapes, features | Implemented; committed edits reconcile derived geometry | Interactive M1.3 review |
| AI config, blueprint, narration, refinement | Implemented, not connected to campaign retrieval | Ownership/authorship in M1; grounding in M2 |
| Campaign/dungeon/chat ownership and migrations | Implemented; current schema version is 7 | Preserve ownership through M2 |
| SQLite persistence and autosave | Revision-checked queue, conflicts and bounded recovery | Interactive M1.1 review |
| Reroll-as-fork and manual descriptions | Authored checkpoints, persistent drafts and idempotent forks | Interactive M1.2 review |
| Canvas editor | Reconciles derived data and matching undo/redo state | Interactive M1.3 review |
| Note ingestion and campaign note library | Atomic replacement, stored sources and stage-specific retries | M1.4 merged; interactive checks pending |
| Shared static renderer | Live map and exports share `renderStaticLayers` | Keep it shared |
| Visual motifs | Default, Infernal, Aquatic have palettes; five fall back | M4.1 |
| PNG/PDF/VTT and description exports | Implemented; correctness/audience/size gaps | M3.1 |
| Hybrid retrieval (former 7E) | Campaign search, revision-bound reader, diagnostic API and synthetic evaluation implemented | M2.1 merged; interactive review pending |
| Loremaster answers (former 7F) | Bounded campaign tools, streamed answers, revision-bound citations, cancellation, and persisted provenance | M2.2 draft review |
| Architect reads notes (former 7G) | Not implemented | M2.3 |
| Usage ledger | Generation tokens tracked; cloud rates unset; notes calls missing | M3.4 |
| Rust/WASM | PRNG/types/grid ported; production generator remains TypeScript | M4.4 after profiling |

---

## Where things live

| Concern | Module |
|---|---|
| Schema, migrations, connection | `src/db/` |
| Campaign / dungeon / chat accessors | `src/campaign/` |
| Note ingest, chunking, embeddings | `src/notes/` |
| HTTP handlers + route table | `src/api/` |
| Client router | `src/router/router.ts` |
| Typed client for the API | `src/store/api.ts` |
| Rail / context column / views | `src/components/layout/`, `src/components/views/` |
| Server entry point | `src/server.ts` |

The one hard rule: **anything the browser imports must not reach `bun:sqlite`
or `process.env`.** Vite stubs those silently, so the symptom is a blank page
rather than a build error. Shared constants live in `src/notes/shared.ts`;
shared types in `src/campaign/types.ts` (type-only, no runtime imports).

---

## Operational follow-up

- [ ] **Verify rotation of the previously exposed `ANTHROPIC_API_KEY`.** The old
      tracker recorded a full key printed by a pre-commit hook and retained in local
      transcripts. Rotation was not verified in the review. Do not print keys or
      search transcripts to rediscover the exposed value. Never prefix a secret
      with `VITE_`, which makes it eligible for inclusion in the client bundle.

---

## Historical implementation decisions

These record the earlier restructure, not completion of the new roadmap. Preservation
and autosave guarantees below have the gaps now assigned to M1.1/M1.2.

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
