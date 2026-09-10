# Verify dungeon-slop changes in the running app

## Launch

- `bun` lives at `%USERPROFILE%\.bun\bin\bun.exe` (NOT on PATH in non-interactive shells — prepend it).
- `bun run dev` starts both servers via concurrently: API (Bun.serve) on :3000, vite on :5173
  with `/api` proxied to :3000. Ready in ~1s.
- Health check both, because a green vite does not mean the API came up:
  ```sh
  curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5173          # 200
  curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/campaigns   # 200
  ```

## State lives in SQLite, not localStorage

`notes.sqlite` in the repo root is the single source of truth. The zustand `persist`
middleware is **gone** — there is no `dungeon-slop-dungeon` key to pre-seed any more, and
writing one does nothing. The client store is a working copy over a debounced autosave
(600 ms, flushed on navigation and `beforeunload`).

So seed through the API, then navigate to the URL that shows the row.

## Get a dungeon on screen without spending API credit

The AI is only needed to turn natural language into a `DungeonConfig`. The engine endpoint
is pure, deterministic and free:

```sh
# 1. a campaign to own it
CID=$(curl -s -X POST localhost:3000/api/campaigns \
  -H 'content-type: application/json' -d '{"name":"Scratch"}' | jq .id)

# 2. an empty dungeon row inside it
DID=$(curl -s -X POST localhost:3000/api/campaigns/$CID/dungeons \
  -H 'content-type: application/json' -d '{"name":"Test map"}' | jq .id)

# 3. geometry from the pure engine (copy DEFAULT_CONFIG from src/ai/schema.ts, add a fixed seed)
curl -s -X POST localhost:3000/api/generate-dungeon \
  -H 'content-type: application/json' -d "{\"config\":$CONFIG}" > geo.json

# 4. write it onto the row — PATCH is a partial: absent key = leave alone, null = clear
curl -s -X PATCH localhost:3000/api/dungeons/$DID -H 'content-type: application/json' \
  -d "{\"seed\":42,\"config\":$CONFIG,\"geometry\":$(jq .dungeon geo.json)}"
```

Then load `http://localhost:5173/c/$CID/d/$DID` — the map renders from the row.

**Clean up after yourself.** `DELETE /api/campaigns/$CID` cascades to its dungeons, rooms,
chats and notes. The user has real campaigns in this database; never drill against one of
theirs, and check `PRAGMA foreign_key_check` returns no rows if you touched the schema.

## Client routes

| Path | View |
|---|---|
| `/` | campaign picker |
| `/c/:cid` | campaign home |
| `/c/:cid/notes` | notes |
| `/c/:cid/chat/:chatId` | Loremaster thread |
| `/c/:cid/d/:did` | dungeon |
| `/c/:cid/d/:did/r/:index` | room inspector |

Vite is configured with an SPA fallback, so deep links work on a hard refresh. If one 404s,
that is a real regression.

## API surface

Campaign-scoped: `GET/POST /api/campaigns`, `GET/PATCH/DELETE /api/campaigns/:id`,
`GET/POST /api/campaigns/:id/{notes,dungeons,chats}`.
Object-scoped: `GET/PATCH/DELETE /api/{dungeons,chats}/:id`, `DELETE /api/notes/:id`,
`POST /api/dungeons/:id/fork`, `GET /api/dungeons/:id/chat`,
`PUT/DELETE /api/dungeons/:id/rooms/:index`,
`POST /api/chats/:id/messages`, `DELETE /api/chats/:id/messages/:index`.
Engine + AI: `POST /api/generate-dungeon` (free), `/api/generate-config`,
`/api/generate-blueprint`, `/api/refine-layout`, `/api/describe-rooms`,
`/api/describe-dungeon`, `/api/describe-room/:id` (all but generate-dungeon spend credit).

`/api/generate-dungeon` takes either a bare config (legacy) or `{config, blueprint}`.
With a blueprint it lays the map out from the plan and IGNORES `grid_width`/`grid_height`
when they are too small for it, so the grid in the response may be bigger than the one
you sent. `/api/refine-layout` accepts an optional `image` as a `data:image/png;base64,`
URL and rejects any other URL form outright.

A path that matches under the wrong verb returns **405, not 404** — useful for telling
"route missing" apart from "wrong method" when a fetch fails.

## Drive the GUI

No playwright browsers are installed under ms-playwright, but **Edge is available**: use
`playwright-core` (npm-install it in a scratch dir, not the repo) with
`chromium.launch({ channel: "msedge", headless: true })`. Screenshot clips around a mouse
anchor verify zoom anchoring; `.toolbar-zoom-label` innerText is the zoom observable;
`[aria-label="Zoom in"/"Zoom out"/"Reset view"]` are the toolbar buttons.

Destructive actions go through a portal-rendered confirm at `z-index: 300` — a click on a
`×` resolves nothing until the `.confirm-danger` button is clicked, so a script that only
clicks the `×` and asserts deletion will fail. `.confirm-cancel` takes focus by default.

## Gotchas

- **Nothing the browser imports may reach `bun:sqlite` or `process.env`.** Vite stubs both
  silently, so the symptom is a blank page at runtime, not a build error. If the app goes
  blank after an import change, check the console for a module-evaluation throw first.
- PowerShell 5.1: don't pipe bun stderr (`2>&1` wraps lines in NativeCommandError); plain
  `bun test | Select-Object -Last 4` works.
- `bun test` and `bun x tsc --noEmit` are both clean (1288 pass, 0 type errors). **Any**
  failure is a regression — there is no longer a known-bad baseline to discount.
- **A corridor never occupies a room cell — no exemption for its own endpoints.**
  Corridors run boundary to boundary and meet a room only at a door. `assertAll`
  enforces this (`corridorCellsInRooms`) along with path contiguity
  (`corridorPathBreaks`); a hole in a path is a route through whatever fills it.
  Routing plans before it carves, so an unroutable pair leaves nothing behind and
  `repairConnectivity` joins the room to one it can legally reach instead.
- **The map has to draw what the grid says is there**, and `render-invariants.test.ts` is
  the only thing that checks it — the renderer had no tests at all, so a room drawn with a
  whole wall missing, or as a rectangle instead of a cave, passed everything for months.
  It asserts: every band loop closes (an outline handed over without its first point
  repeated is stroked one segment short — that segment is a wall); no walkable cell sits
  outside the shape its room is drawn with; a drawn shape stays inside the rectangle the
  layout reserved for it; and a corridor running alongside a room never extends into it.
- **There is no hatch fringe, on purpose.** It was tried five ways and removed at the
  user's request (2026-09-11). Don't reintroduce it unasked. For any visual change, judge it
  against the reference at matched scale and magnified; at map zoom almost anything reads
  as texture.
- **The wall's grey inner face shares its edge with the ink by construction.** The ink band
  leans out by half its width less its jitter, so the floor fill always cuts it at the
  floor's own edge; the face is the floor's exact outline (a `polybooljs` union of room
  shapes and whole-cell rects) stroked at double width and clipped to the floor. Offsetting
  a separately jittered line instead left 1,913 px of bare floor against the ink on
  Icecrown alone. There is no drop shadow: it could not follow a wobbling outer edge.
- **Shape maths lives in two files and both must agree**: `engine/shapes.ts` carves the
  cells, `renderer/room-shapes.ts` draws the outline. Cross bars, the Square inset and the
  pentagon's seating are shared helpers for that reason. `getRoomGeometry` must stay free
  of `Path2D` so the engine and tests can call it outside a browser.
- **Cave rooms**: compare with `isCaveShape`, never `shape === "Cave"`. The cellular
  generator wrote `"cave"` for a long time, and a case-sensitive check silently drew every
  organic room as a filled rectangle over its bounding box.
- **The map's ink is the map theme's, not the UI theme's.** Map paper is light in all three
  motifs; a colour read from a `[data-theme="dark"]` CSS variable lands near-white on it.
- **Check the room route, not just the map route.** `/c/:cid/d/:did/r/:index` renders a
  different panel tree, and a render loop there shows up as a blank body with a single
  "Maximum update depth exceeded" pageerror while `/c/:cid/d/:did` still looks perfect.
  A route smoke test that stops at the map view will miss it.
- Windows holds WAL sidecars open; temp-dir teardown in tests must be best-effort
  try/catch or it throws EBUSY.
- Kill the dev server by killing the background shell or by port; `concurrently` spawns two
  bun processes, so killing one leaves the other bound.
