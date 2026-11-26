---
name: dungeon-design
description: Game-design knowledge for planning dungeons - structures (five-room, loops, hub, lock-and-key, cyclic), non-linearity, pacing, stocking, room purpose, and a review checklist, each mapped onto this project's floor-plan format. Use whenever designing, critiquing or revising a dungeon plan, together with the `dungeon` skill that builds it.
---

# Dungeon design

A dungeon is an *adventure location*, not a story: the players' route through it is
the story. Good plans give them real choices with readable consequences. Everything
below serves that, and each pattern ends with how to express it in a blueprint
(`src/ai/prompts/blueprint.ts`; build with the `dungeon` skill).

## Core philosophy

1. **Choices, not a corridor.** A linear dungeon is a railroad: every "choice"
   leads to the same place. Non-linear layouts give agency, real exploration and
   replay value, and they are no harder to run: each room still just has exits.
   (Alexander, *Xandering the Dungeon*.)
2. **Information → Choice → Impact.** Players can only choose well when they can
   see enough to decide; without information a choice is gambling. Telegraph
   danger: a good trap has at least one part that is visible. (McDowall, ICI.)
3. **Every room earns its place.** Ask what a room is FOR: a fight, a decision, a
   discovery, a breather, a view of somewhere they cannot reach yet. A dead end
   must pay. A room that only connects two others is a corridor.
4. **The place makes sense.** Inhabitants need food, water, latrines, a way in
   and out; factions hold territory and have reasons. Mundane rooms (kitchen,
   store, barracks) make the strange ones land. Use in moderation. (Gygaxian
   naturalism.)
5. **Rhythm over uniformity.** Alternate pressure and relief; escalate toward a
   climax; let a cleared room become safe ground.

## Structures

### Five-room dungeon (the smallest complete adventure)
Entrance + guardian → puzzle or roleplaying challenge → trick or setback →
climax → reward, revelation or twist. The "rooms" are beats, not literal rooms;
the setback is what makes it memorable. (Johnn Four.)
- Blueprint: entrance (tier 0) → gauntlet (1) → chamber with a setback in its
  notes (2) → chokepoint/boss (3-4) → vault for the reward. Add one loop edge if
  you can; a pure line is the failure mode below.

### Loops (xandering)
Checklist for a non-linear map (Alexander's simplified Jaquays checklist):
1. Non-linear, asymmetric layout.
2. Multiple ways in.
3. Loops - big enough to matter, not tight coils.
4. Multiple paths from start to finish.
5. Secret passages and chambers.
6. Shortcuts that loop back or skip cleared rooms.
- Blueprint: at least one edge that joins a deep room back to a shallow one;
  `door: "Secret"` on an edge for a hidden route; a second route to the boss
  through a different wing.

### Hub and spokes
A central room branching to three or more wings; the wings can be done in any
order; the exit is locked behind something gathered from them.
- Blueprint: `role: "hub"`, one `wing` id per branch, the chokepoint/boss edge
  carrying `gating` that names what the wings provide.
- `layout: "radial"` is the literal version: a round centre with ring slices,
  ordered by `sector` clockwise from twelve.

### Lock and key
A key opens a lock somewhere else. The key must never be behind its own lock.
Lessons from Zelda (Mark Brown, *Boss Keys*): one key with one obvious lock
removes the decision; many keys for one big lock, or one key for several locks,
creates real choices; long dead-end hallways for a key cause tedious backtracking,
while big loops let the party return a different way.
- Blueprint: `gating` text naming the key on the lock edge (draws a locked door on
  the `to` side); put the key's room in another branch's notes. The engine does
  not model keys or check solvability: keep the key's room reachable without
  crossing its own lock, and say where the key is in the notes.

### Cyclic (Dormans, *Unexplored*)
Instead of a path with branches, build a loop with the entrance and goal on it;
the two arcs between them are used as a pattern. Examples:
- **Two alternative routes**: both arcs reach the goal, with different obstacles
  (stealth vs. fight, short and dangerous vs. long and safe).
- **Lock on one arc, key on the other**: the party must go round.
- **Hidden shortcut**: a long arc forward, a secret short arc home.
- **Hub cycle**: the loop is easy to walk; the exit is locked behind a challenge.
Add minor cycles as short detours carrying extra keys and obstacles.
- Blueprint: make the plan a ring of edges with entrance and boss/goal on it;
  put the arc pattern in edge `gating`/`door` and room notes.

### Mission vs. space
Design what the players must DO (the mission: keys, obstacles, the order of
beats) separately from where it happens (the space). This project already splits
them: you write the mission as the graph, the engine draws the space. Do not try
to control geometry through node order; use roles, tiers, wings, rings.

## Pacing

- Shape: safe entry → small challenge → recovery → larger test → discovery or
  reward → complication → climax → exit. A template, not a formula.
- Never more than two high-intensity rooms in a row; a breather after every peak.
- Escalate: rooms between entrance and boss should get harder or stranger, not
  repeat. Four interchangeable chambers in a row is a flat middle.
- A chokepoint right before the boss signals the point of no return.
- Gate the late game; something deep should be locked.

## Stocking

Classic B/X proportions, as a starting point for a whole level: about one third
empty, one third monsters, one sixth traps, one sixth special; treasure in a bit
over a third of rooms, mostly with monsters. Empty rooms are not wasted: they are
pacing, they hold clues, and they make the next fight a surprise. (Check the
original table before quoting exact dice mappings; summaries disagree.)
- Engine knobs (config): `trap_density`, `treasure_density`, `stairs`,
  `door_types`. Room purpose goes in node `notes` and role.

## Rooms worth entering

- Something to interact with beyond the monster: a lever, an altar, a view down
  into a later room, a clue to a lock elsewhere.
- Environmental storytelling shows the past (a fallen torch, scorch marks, a
  barricade facing the wrong way); it cannot show the present - put live events
  in encounters.
- Landmarks and signposting help navigation: a distinctive room the party can
  orient by, light leading toward the main path.
- A vault is a dead end that pays: treasure, a secret, a revelation.

## Reviewing a plan

Reduce the plan to its graph (a Melan diagram: rooms as nodes, connections as
lines, ignore geometry) and check:
- [ ] Not a line: some room has 3+ connections, and at least one loop exists
      (`bun run dungeon show` reports the route; the layout report says "Loops
      back" vs "Dead-ends only").
- [ ] Start to boss has more than one route, or the single route is deliberate
      (a short five-room dungeon).
- [ ] Every leaf room is a vault with a reason to visit.
- [ ] The middle escalates; there is a breather after each peak.
- [ ] A chokepoint guards the boss; something deep is gated, and its key is
      reachable without passing its own lock.
- [ ] Each room's notes answer "what happens here, and why is it here?"
- [ ] Danger is telegraphed somewhere the players can see it first.

## What this engine cannot express yet

Be honest with the user when a design needs these; describe the workaround.
- **More than one entrance**: normalization keeps exactly one `entrance`. Work
  around with an extra edge from a shallow chamber noted as a second way in.
- **Multiple levels / stairs between levels / sub-levels**: one map is one level.
- **One-way passages (valves), drops, elevation**: not modelled; say so in notes.
- **Key placement and solvability**: `gating` is text plus a locked door; the
  engine does not know where the key is.
- **Exact positions**: only the radial layout gives positional control (ring,
  sector); graph plans are placed by the solver.

## Sources

- Justin Alexander, *Xandering (Jaquaying) the Dungeon* and the Melan diagram addendum: https://thealexandrian.net/wordpress/13085/roleplaying-games/jaquaying-the-dungeon , https://thealexandrian.net/wordpress/45711/roleplaying-games/jaquaying-the-dungeon-addendum-how-to-use-a-melan-diagram
- Simplified Jaquays checklist: https://www.goodreads.com/author_blog_posts/23244936-a-simpler-checklist-for-jaquays-style-dungeon-maps
- Johnn Four, Five Room Dungeon (summary): https://www.scabard.com/features/5-room-dungeon
- Boris the Brave, *Dungeon Generation in Unexplored*: https://www.boristhebrave.com/2021/04/10/dungeon-generation-in-unexplored/
- Joris Dormans, *Adventures in Level Design: Generating Missions and Spaces*: https://pcgworkshop.com/archive/dormans2010adventures.pdf
- Mark Brown, *Boss Keys* (Zelda dungeon design), series overview: https://zeldauniverse.net/2017/01/26/explore-zelda-dungeon-design-in-mark-browns-youtube-series-boss-keys/
- Chris McDowall, ICI doctrine and good traps: https://www.bastionland.com
- Gygaxian naturalism / dungeon ecology: https://www.greyhawkgrognard.com/2010/09/16/megadungeon-in-its-natural-habita/
- B/X stocking proportions: https://www.martinralya.com/tabletop-rpgs/bx-dd-vs-labyrinth-lord-dungeon-stocking/
- The Level Design Book (environmental storytelling, prospect/refuge): https://book.leveldesignbook.com
