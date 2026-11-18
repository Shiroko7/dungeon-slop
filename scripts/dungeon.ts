/**
 * dungeon — drive the map generator from a terminal (or from an agent).
 *
 * Works on the same SQLite file the app uses, through the app's own campaign
 * and dungeon modules, so whatever this writes is exactly what the app shows.
 * The dev server does not need to be running. Saves to an existing map go
 * through the same revision check as the app's autosave: a map changed in an
 * open browser tab conflicts instead of being silently overwritten.
 *
 *   bun run dungeon help
 */
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openAppDb } from "../src/db/open.ts";
import { listCampaigns, createCampaign, deleteCampaign, getCampaign } from "../src/campaign/campaigns.ts";
import { listDungeons, getDungeon, createDungeon, deleteDungeon } from "../src/campaign/dungeons.ts";
import { commitDungeon } from "../src/campaign/mutations.ts";
import { BlueprintSchema, normalizeBlueprint, type Blueprint } from "../src/ai/blueprint.ts";
import { DEFAULT_CONFIG, DungeonConfigSchema, type DungeonConfig } from "../src/ai/schema.ts";
import { generateFromBlueprint } from "../src/engine/generate.ts";
import { CellType, type Dungeon, type DungeonStyle, type TextureRef } from "../src/engine/types.ts";
import { AssetLibrary } from "../src/assets/library.ts";

const ROOT = resolve(import.meta.dir, "..");
const DB_PATH = process.env.NOTES_DB_PATH ?? join(ROOT, "notes.sqlite");
const APP_URL = process.env.DUNGEON_APP_URL ?? "http://localhost:5173";

const HELP = `dungeon — drive the Dungeon Slop map generator

  campaigns                                  list campaigns
  campaign create <name> [--blurb <text>]    create a campaign, print its id
  campaign delete <id>                       delete a campaign and everything in it
  wipe --yes                                 back up the database, then delete ALL campaigns

  dungeons <campaignId>                      list a campaign's maps
  generate <campaignId> <blueprint.json> [--name <n>] [--seed <n>] [--config <config.json>]
                                             build a map from a floor plan and save it as a new map
  rebuild <dungeonId> [--blueprint <file>] [--seed <n>] [--config <file>]
                                             rebuild an existing map (keeps its plan unless given one)
  show <dungeonId> [--no-map]                print the map as ASCII, its rooms, doors and report
  blueprint <dungeonId>                      print the map's floor plan as JSON
  dungeon delete <dungeonId>                 delete one map
  style <dungeonId> [--floor <assetId> | --background <assetId>] [--cells <n>] [--shade <0..1>] [--room <roomId> [--fit | --radial [--stagger 0..1]]] [--blend <assetId> [--blend-amount 0.5] [--blend-cells 24] [--blend-mode soft-light]] [--no-variants] [--shuffle <n>] [--clear [--objects]]
                                             set map art: a floor texture from (bun run assets)
                                             for the whole map, or for one room with --room;
                                             --fit draws one image over the room instead of tiling;
                                             --background tiles what lies around and between rooms

A blueprint file is the floor-plan JSON described in src/ai/prompts/blueprint.ts.
Generated maps print a URL; it opens in the app while \`bun run dev\` is running.`;

// ─── arguments ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flags = new Map<string, string | true>();
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!;
  if (arg.startsWith("--")) {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags.set(arg.slice(2), true);
    else {
      flags.set(arg.slice(2), next);
      i++;
    }
  } else positional.push(arg);
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function flag(name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function intArg(value: string | undefined, what: string): number {
  const n = Number(value);
  if (value === undefined || !Number.isInteger(n)) fail(`${what} must be a whole number`);
  return n;
}

function readJson(path: string): unknown {
  const full = resolve(process.cwd(), path);
  if (!existsSync(full)) fail(`no such file: ${full}`);
  try {
    return JSON.parse(readFileSync(full, "utf8"));
  } catch (err) {
    fail(`${full} is not valid JSON: ${(err as Error).message}`);
  }
}

function loadBlueprint(path: string): Blueprint {
  const parsed = BlueprintSchema.safeParse(readJson(path));
  if (!parsed.success) {
    fail(`invalid blueprint:\n  ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ")}`);
  }
  return parsed.data;
}

function loadConfig(path: string | undefined, base: DungeonConfig): DungeonConfig {
  const raw = path === undefined ? base : { ...base, ...(readJson(path) as object) };
  const parsed = DungeonConfigSchema.safeParse(raw);
  if (!parsed.success) {
    fail(`invalid config:\n  ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ")}`);
  }
  return parsed.data;
}

// ─── output ───────────────────────────────────────────────────────────────────

const GLYPH: Record<number, string> = {
  [CellType.Empty]: " ",
  [CellType.Wall]: "#",
  [CellType.Corridor]: ",",
  [CellType.Door]: "D",
  [CellType.SecretDoor]: "S",
  [CellType.StairsUp]: "<",
  [CellType.StairsDown]: ">",
};
const ROOM_GLYPHS = "0123456789abcdefghijklmnopqrstuvwxyzABCEFGHIJKLMNOPQRTUVWXYZ";

/** The map as text, cropped to what is drawn. Floor shows its room's id. */
function ascii(d: Dungeon): string {
  let x0 = d.width, y0 = d.height, x1 = -1, y1 = -1;
  d.grid.forEach((row, y) =>
    row.forEach((cell, x) => {
      if (cell.type === CellType.Empty) return;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }),
  );
  if (x1 < 0) return "(empty map)";
  const lines: string[] = [];
  for (let y = y0; y <= y1; y++) {
    let line = "";
    for (let x = x0; x <= x1; x++) {
      const cell = d.grid[y]![x]!;
      if (cell.type === CellType.Floor) {
        line += cell.roomId === null ? "." : (ROOM_GLYPHS[cell.roomId % ROOM_GLYPHS.length] ?? "?");
      } else line += GLYPH[cell.type] ?? "?";
    }
    lines.push(line.trimEnd());
  }
  return lines.join("\n");
}

function describe(d: Dungeon): string {
  const out: string[] = [];
  out.push(`grid ${d.width}x${d.height}, seed ${d.seed}, ${d.rooms.length} rooms, ${d.corridors.length} corridors`);
  if (d.report !== undefined) out.push(`route: ${d.report.hasLoop ? "loops back" : "dead-ends only (no loop)"}`);
  out.push("rooms (id glyph: name — role, tier, shape, connections):");
  for (const r of d.rooms) {
    const glyph = ROOM_GLYPHS[r.id % ROOM_GLYPHS.length];
    const name = r.description?.name ?? r.plan?.name ?? `Room ${r.id}`;
    out.push(`  ${r.id} [${glyph}]: ${name} — ${r.role ?? "?"}, tier ${r.tier ?? "?"}, ${r.shape}, -> ${r.connections.join(", ") || "none"}`);
  }
  const doors = d.features.filter((f) => /door|portcullis|archway/.test(f.type));
  if (doors.length > 0) {
    out.push("doors:");
    for (const f of doors) {
      const meta = f.metadata === undefined ? "" : ` ${JSON.stringify(f.metadata)}`;
      out.push(`  ${f.type} at ${f.x},${f.y}${meta}`);
    }
  }
  const c = d.report?.constraints;
  if (c !== undefined) {
    out.push(`plan: ${c.deliveredConnections}/${c.requestedConnections} connections, ${c.reachableRooms} rooms reachable`);
    for (const m of c.unmetConnections) out.push(`  UNMET connection ${m.from} -> ${m.to}`);
    for (const r of c.unreachableRooms) out.push(`  UNREACHABLE ${r}`);
    for (const r of c.unmetRequirements) out.push(`  UNMET ${r}`);
  }
  return out.join("\n");
}

function printBuilt(d: Dungeon, problems: Array<{ message: string }>): void {
  for (const p of problems) console.log(`plan repaired: ${p.message}`);
  console.log(describe(d));
  console.log();
  console.log(ascii(d));
}

// ─── commands ─────────────────────────────────────────────────────────────────

const db = openAppDb(DB_PATH);
const [command, sub] = positional;

switch (command) {
  case undefined:
  case "help":
    console.log(HELP);
    break;

  case "campaigns": {
    const rows = listCampaigns(db);
    if (rows.length === 0) console.log("(no campaigns)");
    for (const c of rows) {
      console.log(`${c.id}\t${c.name}\t${c.noteCount} notes, ${c.dungeonCount} maps, ${c.chatCount} chats`);
    }
    break;
  }

  case "campaign": {
    if (sub === "create") {
      const name = positional.slice(2).join(" ");
      if (name.trim() === "") fail("campaign create needs a name");
      const c = createCampaign(db, { name, blurb: flag("blurb") });
      console.log(`created campaign ${c.id} "${c.name}" — ${APP_URL}/c/${c.id}`);
    } else if (sub === "delete") {
      const id = intArg(positional[2], "campaign id");
      const c = getCampaign(db, id) ?? fail(`no campaign ${id}`);
      deleteCampaign(db, id);
      console.log(`deleted campaign ${id} "${c.name}" (${c.dungeonCount} maps, ${c.noteCount} notes, ${c.chatCount} chats)`);
    } else fail("usage: campaign create <name> | campaign delete <id>");
    break;
  }

  case "wipe": {
    if (flags.get("yes") !== true) fail("wipe deletes every campaign; pass --yes to confirm");
    // Fold the WAL into the main file so the backup is complete on its own.
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = `${DB_PATH}.${stamp}.bak`;
    copyFileSync(DB_PATH, backup);
    const rows = listCampaigns(db);
    db.transaction(() => {
      for (const c of rows) deleteCampaign(db, c.id);
    })();
    db.run("VACUUM");
    console.log(`backed up to ${backup}`);
    console.log(`deleted ${rows.length} campaigns`);
    break;
  }

  case "dungeons": {
    const campaignId = intArg(sub, "campaign id");
    getCampaign(db, campaignId) ?? fail(`no campaign ${campaignId}`);
    const rows = listDungeons(db, campaignId);
    if (rows.length === 0) console.log("(no maps)");
    for (const d of rows) console.log(`${d.id}\t${d.name}\t${d.roomCount} rooms\t${APP_URL}/c/${campaignId}/d/${d.id}`);
    break;
  }

  case "generate": {
    const campaignId = intArg(sub, "campaign id");
    getCampaign(db, campaignId) ?? fail(`no campaign ${campaignId}`);
    const file = positional[2] ?? fail("generate needs a blueprint file");
    const plan = loadBlueprint(file);
    const config = loadConfig(flag("config"), {
      ...DEFAULT_CONFIG,
      seed: flags.has("seed") ? intArg(flag("seed"), "seed") : Math.floor(Math.random() * 2147483647),
    });
    const { blueprint, problems } = normalizeBlueprint(plan);
    const built = generateFromBlueprint(blueprint, config);
    const record = createDungeon(db, campaignId, {
      name: flag("name") ?? blueprint.name ?? "Untitled map",
      seed: built.seed,
      config: built.config,
      geometry: built,
      blueprint,
    });
    console.log(`created map ${record.id} "${record.name}" — ${APP_URL}/c/${campaignId}/d/${record.id}`);
    printBuilt(built, problems);
    break;
  }

  case "rebuild": {
    const id = intArg(sub, "dungeon id");
    const current = getDungeon(db, id) ?? fail(`no map ${id}`);
    const file = flag("blueprint");
    const plan = file !== undefined ? loadBlueprint(file) : (current.blueprint ?? fail(`map ${id} has no floor plan; pass --blueprint`));
    const base = current.config ?? DEFAULT_CONFIG;
    const config = loadConfig(flag("config"), {
      ...base,
      seed: flags.has("seed") ? intArg(flag("seed"), "seed") : (current.seed ?? base.seed),
    });
    const { blueprint, problems } = normalizeBlueprint(plan);
    const built = generateFromBlueprint(blueprint, config);
    // New geometry makes old room notes point at the wrong rooms; clear them.
    const staleNotes = current.roomNotes.map(([roomId]) => [roomId, null] as [number, null]);
    const revision = commitDungeon(db, id, {
      expectedRevision: current.revision,
      operationId: crypto.randomUUID(),
      patch: {
        seed: built.seed,
        config: built.config,
        // Map art is independent of the layout; carry it over.
        geometry: current.geometry?.style ? { ...built, style: current.geometry.style } : built,
        blueprint,
        overview: null,
        ...(staleNotes.length > 0 ? { roomNotes: staleNotes } : {}),
      },
    });
    console.log(`rebuilt map ${id} (revision ${revision}) — ${APP_URL}/c/${current.campaignId}/d/${id}`);
    printBuilt(built, problems);
    break;
  }

  case "show": {
    const id = intArg(sub, "dungeon id");
    const record = getDungeon(db, id) ?? fail(`no map ${id}`);
    if (record.geometry === null) fail(`map ${id} has not been generated yet`);
    console.log(`map ${id} "${record.name}" (revision ${record.revision}) — ${APP_URL}/c/${record.campaignId}/d/${id}`);
    console.log(describe(record.geometry));
    if (flags.get("no-map") !== true) {
      console.log();
      console.log(ascii(record.geometry));
    }
    break;
  }

  case "style": {
    const id = intArg(sub, "dungeon id");
    const current = getDungeon(db, id) ?? fail(`no map ${id}`);
    if (current.geometry === null) fail(`map ${id} has not been generated yet`);
    const room = flag("room");
    if (room !== undefined && !current.geometry.rooms.some((r) => String(r.id) === room)) fail(`map ${id} has no room ${room}`);
    const style: DungeonStyle = structuredClone(current.geometry.style ?? {});
    const background = flags.has("background");
    if (background && room !== undefined) fail("--background is for the whole map, not one room");
    if (flags.has("clear")) {
      // --clear alone clears all textures; with --background, --room or --objects, just that part.
      if (flags.has("objects")) delete style.objects;
      else if (background) delete style.background;
      else if (room !== undefined) delete style.rooms?.[room];
      else {
        delete style.floor;
        delete style.background;
        delete style.rooms;
      }
    } else {
      const asset = (background ? flag("background") : flag("floor")) ?? fail("style needs --floor <assetId> or --background <assetId> (or --clear)");
      const library = new AssetLibrary();
      let found;
      try {
        found = library.resolve(asset);
      } catch (e) {
        fail((e as Error).message);
      }
      const ref: TextureRef = { asset: found.id };
      // Scatter the tile's edge-matched variants, when it has any.
      const set = library.variantSet(found.id);
      if (set.length > 1 && !flags.has("no-variants") && !flags.has("fit")) {
        ref.variants = set;
        if (flags.has("shuffle")) ref.variantSeed = Number(flag("shuffle"));
      }
      if (flags.has("cells")) ref.cells = Number(flag("cells"));
      if (flags.has("shade")) ref.shade = Number(flag("shade"));
      if (flags.has("radial")) {
        if (room === undefined) fail("--radial is for one room (--room <id>): rows bend around that room's circle");
        ref.layout = "radial";
      }
      if (flags.has("stagger")) ref.stagger = Number(flag("stagger"));
      const blendAsset = flag("blend");
      if (blendAsset) {
        let over;
        try {
          over = library.resolve(blendAsset);
        } catch (e) {
          fail((e as Error).message);
        }
        const mode = flag("blend-mode") ?? "soft-light";
        if (!["soft-light", "overlay", "multiply", "color", "normal"].includes(mode)) fail("--blend-mode is soft-light, overlay, multiply, color or normal");
        ref.blend = {
          asset: over.id,
          cells: Number(flag("blend-cells") ?? 24),
          amount: Number(flag("blend-amount") ?? 0.5),
          mode: mode as NonNullable<TextureRef["blend"]>["mode"],
        };
        if (!(ref.blend.amount! >= 0 && ref.blend.amount! <= 1)) fail("--blend-amount is 0 to 1");
      }
      if (ref.stagger !== undefined && !(ref.stagger >= 0 && ref.stagger <= 1)) fail("--stagger is 0 to 1");
      if (flags.has("fit")) {
        if (room === undefined || background) fail("--fit is for one room (--room <id>): the image is drawn once over that room");
        ref.fit = true;
      } else if (!found.tileable) console.log(`warning: ${found.id} is a ${found.kind}, not a seamless tile; --fit draws it once over the room`);
      if (ref.cells !== undefined && !(ref.cells >= 0.25 && ref.cells <= 128)) fail("--cells is 0.25 to 128");
      if (ref.shade !== undefined && !(ref.shade >= 0 && ref.shade <= 1)) fail("--shade is 0 to 1");
      if (background) style.background = ref;
      else if (room === undefined) style.floor = ref;
      else (style.rooms ??= {})[room] = { floor: ref };
    }
    const geometry: Dungeon = { ...current.geometry, style };
    if (!style.floor && !style.background && Object.keys(style.rooms ?? {}).length === 0 && !style.objects?.length) delete geometry.style;
    else if (style.rooms && Object.keys(style.rooms).length === 0) delete style.rooms;
    const revision = commitDungeon(db, id, {
      expectedRevision: current.revision,
      operationId: crypto.randomUUID(),
      patch: { geometry },
    });
    console.log(`map ${id} style (revision ${revision}): ${JSON.stringify(geometry.style ?? {})}`);
    console.log(`${APP_URL}/c/${current.campaignId}/d/${id}  (reload the page if it is open)`);
    break;
  }

  case "blueprint": {
    const id = intArg(sub, "dungeon id");
    const record = getDungeon(db, id) ?? fail(`no map ${id}`);
    if (record.blueprint === null) fail(`map ${id} has no floor plan`);
    console.log(JSON.stringify(record.blueprint, null, 2));
    break;
  }

  case "dungeon": {
    if (sub !== "delete") fail("usage: dungeon delete <id>");
    const id = intArg(positional[2], "dungeon id");
    const record = getDungeon(db, id) ?? fail(`no map ${id}`);
    deleteDungeon(db, id);
    console.log(`deleted map ${id} "${record.name}"`);
    break;
  }

  default:
    fail(`unknown command "${command}" — try: bun run dungeon help`);
}

db.close();
