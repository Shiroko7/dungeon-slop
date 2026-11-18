---
name: dungeon
description: Create, rebuild, inspect and delete campaigns and maps in the user's Dungeon Slop database through the `bun run dungeon` CLI. Use when the user asks to make a dungeon or map (from a description, a sketch or an image), change one, list or show what exists, or clean up stored campaigns.
---

# Driving the map generator

For changes the app itself can make (textures, objects, selecting rooms, hand
edits, viewing), use the website directly: see the `app-ui` skill. This CLI is
for what the UI cannot do: creating maps from a plan, rebuilding with plan
settings, bulk cleanup.

`scripts/dungeon.ts` (run as `bun run dungeon …`) works straight on `notes.sqlite`
through the app's own modules. The dev server does not need to be running.
`bun` lives at `%USERPROFILE%\.bun\bin\bun.exe`; prepend it to PATH in
non-interactive shells.

```sh
bun run dungeon help
bun run dungeon campaigns                      # id, name, counts
bun run dungeon campaign create "Name" [--blurb "..."]
bun run dungeon dungeons <campaignId>          # maps with app URLs
bun run dungeon generate <campaignId> plan.json [--name N] [--seed N] [--config cfg.json]
bun run dungeon rebuild <dungeonId> [--blueprint plan.json] [--seed N] [--config cfg.json]
bun run dungeon show <dungeonId> [--no-map]    # ASCII map, rooms, doors, plan report
bun run dungeon blueprint <dungeonId>          # the stored plan as JSON
bun run dungeon dungeon delete <dungeonId>
bun run dungeon style <dungeonId> --floor|--background <assetId> [--cells N] [--shade 0..1] [--room <id> [--fit]] [--clear]
                                               # map art from the asset library (see the `assets` skill)
bun run dungeon campaign delete <campaignId>
bun run dungeon wipe --yes                     # back up the db, then delete ALL campaigns
```

## Making a map

For WHAT to build - structure, loops, pacing, stocking, a review checklist - load
the `dungeon-design` skill first. This section is about how to build it.

You write the floor plan; the engine places it. Never hand the engine
coordinates. The plan format, its roles, tiers and rules, is the system prompt in
`src/ai/prompts/blueprint.ts`. Read it before writing a plan. In short:

- `nodes`: `key`, `name`, `role` (entrance, hub, gauntlet, chokepoint, boss,
  vault, chamber), `tier` (depth from the entrance; the boss is deepest), `size`,
  optional `notes`, `wing`, `shape`.
- `edges`: `from`, `to`, optional `door` (Open, Archway, Portcullis, Standard,
  Locked, Secure, Trapped, Secret) and `gating` (text; with no `door` it draws a
  locked door on the `to` side).
- `"scale"` (0.5 to 4) multiplies every room's size: `2` builds the same plan
  twice as big across. Use it when sizes are already Huge or for "make it bigger".
- `"layout": "radial"` for round places: one node with `ring: 0` is the round
  centre room, the others are slices of rings around it (`ring: 1`, `2`, `3`),
  ordered by `sector` clockwise from twelve o'clock. Each edge between touching
  rooms becomes one door in their shared wall. `"gap"` (radial only, 1.25 to 8,
  default 1.25) widens the rock between rooms into channels; edges then become
  short corridors across them (LONGER passages, and it moves every room).
  `"doorWidth"` (radial only, 1 to 3) makes each doorway that many cells wide in
  place: this is what "wider corridors/doors" means. Doors keep their position
  unless a curved wall leaves no room beside them, then they shift along it.

Write the plan to the scratchpad, run `generate`, then read the output:

- `plan repaired:` lines mean normalization changed the plan. Check that it
  still says what was asked.
- `UNMET` / `UNREACHABLE` lines are real failures. Fix the plan and `rebuild`.
- Read the ASCII map: room floor is its room id glyph, `#` wall, `,` corridor,
  `D` door, `S` secret door, `<` `>` stairs. Check placement against the request
  (which room is where, which walls have doors).

When the user gave an image, describe your reading of it (rooms, adjacency, which
connections are doors or gates, which way the loop runs) before or alongside the
result, so a misreading is cheap to correct.

To SEE the rendered map, follow the `verify` skill: start `bun run dev`, open the
printed URL with playwright-core + Edge, and screenshot. Don't claim it looks
right from the ASCII alone when the question is visual.

## Rules

- Deleting is permanent. `wipe` makes a timestamped `notes.sqlite.*.bak` first;
  single deletes do not. Only delete what the user asked to delete.
- `rebuild` replaces the map's geometry, clears its room notes and overview
  (they described the old rooms), and fails with a revision conflict if the map
  changed elsewhere since it was read. That is correct; re-run it, don't force it.
- If the user has the app open on a map you rebuilt, they need to reload it.
- Tests can never touch `notes.sqlite` (`openAppDb` refuses under `bun test`).
  To experiment with the CLI itself, set `NOTES_DB_PATH` to a scratch file.
