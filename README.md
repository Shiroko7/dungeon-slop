# dungeon-slop

A dungeon generator and map editor for tabletop games, with an AI architect that
builds from your campaign notes and a narrator that writes the room descriptions.

Runs locally on Bun + SQLite. The name undersells it; the test suite does not.

```
1288 pass · 0 fail · 14 files
```

## The idea

Most dungeon generators hand you noise: a plausible-looking maze with no
relationship to your campaign. Most AI writing tools hand you prose with no
relationship to a map. This does both halves and makes them agree with each
other.

You drop your campaign notes in. You tell the architect "the cult's flooded
undercroft, three ways in, the ritual chamber should be hard to reach." It reads
the notes, produces a **blueprint** — rooms, roles, adjacency — the procedural
engine lays that out as real geometry, and the narrator writes each room knowing
what the room next door is and what your notes say the cult does down there.

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

Ownership is enforced by foreign keys, not by convention: nothing exists outside
a campaign, and deleting a campaign takes its notes, chunks, embeddings,
dungeons, and room descriptions with it. Ten tables, migrated forward on open
(`src/db/migrate.ts`).

## Generation is deterministic

`src/engine/` is a procedural pipeline driven by a **seeded RNG**
(`src/lib/random.ts`). The same seed and config always produce the same dungeon —
which is what makes any of it testable, and what lets you share a map as a short
string instead of a file.

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
5. **Walls** are derived from floor adjacency rather than authored, so they
   cannot desync from the geometry.

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

**Architect** (`src/ai/prompts/architect.ts`) produces a structured blueprint —
validated against a schema (`src/ai/schema.ts`), not free text — which
`blueprint-layout.ts` turns into geometry. **Narrator**
(`src/ai/prompts/narrator.ts`) writes room descriptions afterwards, with the map
and the notes as context. A **refine** pass handles "make the east wing bigger"
style edits against an existing map.

Providers are pluggable (`src/ai/providers/`): **Claude**, **Gemini**, and
**Ollama** for fully local generation. One registry resolves provider, model,
and key; swapping is configuration, not a rewrite.

Token usage and cost are tracked per call into a `usage_events` table, with a
tested pricing module (`src/ai/pricing.test.ts`). You can see exactly what a
dungeon cost you, which is the feature every AI app should have and most do not.

## Notes as retrieval, not as a prompt dump

`src/notes/` is a small RAG pipeline. Documents are chunked with token
estimation and overlap (`chunker.ts`), content-hashed so re-uploading an
unchanged file is a no-op (`ingest.ts`), embedded, and stored as vectors.
Retrieval is cosine similarity over normalised vectors.

The point is that a 200-page campaign wiki does not fit in a context window, and
stuffing in the first 8k tokens of it gets you a dungeon themed around your
table of contents.

## Rendering and export

A canvas renderer (`src/renderer/`) with themed tilesets, real door symbology
(secret doors, portcullises, double doors), a hand-drawn **sketch** mode, and an
SVG overlay layer for text and grid. Polygon work via `polybooljs`.

Export to **PDF** (`jspdf`), **PNG**, **VTT** formats for virtual tabletops, and
plain **Markdown descriptions** for your notes app.

## Running it

```bash
bun install
cp .env.example .env    # fill in whichever provider you want
bun run dev             # API + Vite, concurrently
```

`.env.example` documents each provider, including which ones have usable free
tiers. **Gemini is the default** because one key serves both chat and
embeddings at no cost, which matters a lot when the app makes two LLM calls per
dungeon. Or point it at Ollama and pay nothing to nobody.

```bash
bun test                # 1288 tests
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
- Vector search is a linear scan over the campaign's embeddings. Fine for
  hundreds of documents, wrong for tens of thousands — there is no ANN index.
- The architect is only as good as your notes. Given three bullet points, it
  will confidently invent a cult.
- Local single-user app. No auth, no multi-user, no hosted mode.
- Room descriptions are regenerated wholesale rather than edited in place, so a
  hand-tweaked description is lost if you re-narrate that room.
