/**
 * The asset library: generated images on disk plus a SQLite index of what each
 * one is, how it was made (prompt, model, seed, the exact workflow) and how it
 * was judged, so assets can be found again by kind, motif, style or tag and
 * regenerated exactly.
 *
 * Layout under the library root (default `assets/library`, git-ignored):
 *   index.sqlite
 *   <kind>/<motif>/<id>.png
 *
 * Kept apart from notes.sqlite on purpose: assets are shared by every campaign
 * and the folder can be moved or backed up on its own.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const DEFAULT_LIBRARY_DIR = process.env.ASSET_LIBRARY_DIR ?? resolve(import.meta.dir, "../../assets/library");

export type AssetStatus = "new" | "keep" | "reject";

export interface AssetRecord {
  id: string;
  kind: string;
  subject: string;
  style: string;
  motif: string;
  /** Path relative to the library root, forward slashes. */
  file: string;
  width: number;
  height: number;
  alpha: boolean;
  tileable: boolean;
  prompt: string;
  model: string;
  seed: number;
  workflow: unknown;
  metrics: Record<string, unknown>;
  sha256: string;
  status: AssetStatus;
  notes: string;
  createdAt: string;
  tags: string[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS assets (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  subject     TEXT NOT NULL,
  style       TEXT NOT NULL,
  motif       TEXT NOT NULL,
  file        TEXT NOT NULL UNIQUE,
  width       INTEGER NOT NULL,
  height      INTEGER NOT NULL,
  alpha       INTEGER NOT NULL,
  tileable    INTEGER NOT NULL,
  prompt      TEXT NOT NULL,
  model       TEXT NOT NULL,
  seed        INTEGER NOT NULL,
  workflow    TEXT NOT NULL,
  metrics     TEXT NOT NULL DEFAULT '{}',
  sha256      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'keep', 'reject')),
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS assets_kind_motif ON assets (kind, motif);
CREATE TABLE IF NOT EXISTS asset_tags (
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  tag      TEXT NOT NULL,
  PRIMARY KEY (asset_id, tag)
);
CREATE INDEX IF NOT EXISTS asset_tags_tag ON asset_tags (tag);
`;

interface Row {
  id: string; kind: string; subject: string; style: string; motif: string; file: string;
  width: number; height: number; alpha: number; tileable: number; prompt: string; model: string;
  seed: number; workflow: string; metrics: string; sha256: string; status: AssetStatus; notes: string;
  created_at: string; tags: string | null;
}

export interface AssetQuery {
  kind?: string;
  motif?: string;
  style?: string;
  status?: AssetStatus;
  /** Every tag must be present. */
  tags?: string[];
  /** Substring of the subject. */
  text?: string;
  limit?: number;
}

export function slug(text: string, max = 32): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "") || "asset";
}

export function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/\s+/g, "-");
}

export class AssetLibrary {
  readonly db: Database;

  constructor(readonly root: string = DEFAULT_LIBRARY_DIR) {
    mkdirSync(root, { recursive: true });
    this.db = new Database(join(root, "index.sqlite"), { create: true });
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.run(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  path(asset: Pick<AssetRecord, "file">): string {
    return join(this.root, asset.file);
  }

  /** Store image bytes and index them. The id is derived from kind, subject and content hash. */
  add(input: Omit<AssetRecord, "id" | "file" | "sha256" | "status" | "createdAt" | "notes" | "tags"> & {
    png: Uint8Array;
    /** Short label for the id; defaults to the subject. */
    name?: string;
    tags?: string[];
    notes?: string;
    /** Applied only when a new library record is created. */
    initialStatus?: AssetStatus;
  }): AssetRecord {
    const sha256 = createHash("sha256").update(input.png).digest("hex");
    const id = `${slug(input.kind, 10)}-${slug(input.name ?? input.subject, 28)}-${sha256.slice(0, 6)}`;
    // Same bytes for the same kind and subject (same seed and prompt): already stored.
    const existing = this.get(id);
    if (existing) {
      if (existing.sha256 !== sha256) throw new Error(`Content hash collision for ${id}`);
      if (existsSync(this.path(existing))) return existing;
    }
    const file = existing?.file ?? `${slug(input.kind)}/${slug(input.motif)}/${id}.png`;
    const full = join(this.root, file);
    mkdirSync(dirname(full), { recursive: true });
    try {
      writeFileSync(full, input.png, { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // A previous attempt may have written this file before its DB commit.
      if (createHash("sha256").update(readFileSync(full)).digest("hex") !== sha256) {
        throw new Error(`A different image already exists at ${full}`);
      }
    }
    if (existing) return existing;
    const createdAt = new Date().toISOString();
    const tags = [...new Set((input.tags ?? []).map(normalizeTag).filter(Boolean))];
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO assets (id, kind, subject, style, motif, file, width, height, alpha, tileable, prompt, model, seed,
             workflow, metrics, sha256, notes, created_at, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.kind, input.subject, input.style, input.motif, file, input.width, input.height, input.alpha ? 1 : 0,
          input.tileable ? 1 : 0, input.prompt, input.model, input.seed, JSON.stringify(input.workflow),
          JSON.stringify(input.metrics), sha256, input.notes ?? "", createdAt, input.initialStatus ?? "new");
      for (const t of tags) this.db.query("INSERT OR IGNORE INTO asset_tags (asset_id, tag) VALUES (?, ?)").run(id, t);
    })();
    return this.get(id)!;
  }

  get(id: string): AssetRecord | undefined {
    const row = this.db
      .query<Row, [string]>(`SELECT a.*, (SELECT group_concat(tag, ',') FROM asset_tags WHERE asset_id = a.id) AS tags FROM assets a WHERE id = ?`)
      .get(id);
    return row ? fromRow(row) : undefined;
  }

  /** Resolve a full id or an unambiguous prefix. */
  resolve(idOrPrefix: string): AssetRecord {
    const exact = this.get(idOrPrefix);
    if (exact) return exact;
    const rows = this.db.query<{ id: string }, [string]>("SELECT id FROM assets WHERE id LIKE ? || '%' LIMIT 3").all(idOrPrefix);
    if (rows.length === 1) return this.get(rows[0]!.id)!;
    throw new Error(rows.length === 0 ? `no asset ${idOrPrefix}` : `${idOrPrefix} matches several assets: ${rows.map((r) => r.id).join(", ")}…`);
  }

  list(q: AssetQuery = {}): AssetRecord[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.kind) { where.push("a.kind = ?"); args.push(q.kind); }
    if (q.motif) { where.push("a.motif = ?"); args.push(q.motif); }
    if (q.style) { where.push("a.style = ?"); args.push(q.style); }
    if (q.status) { where.push("a.status = ?"); args.push(q.status); }
    if (q.text) { where.push("a.subject LIKE '%' || ? || '%'"); args.push(q.text); }
    for (const t of q.tags ?? []) {
      where.push("EXISTS (SELECT 1 FROM asset_tags t WHERE t.asset_id = a.id AND t.tag = ?)");
      args.push(normalizeTag(t));
    }
    const sql =
      `SELECT a.*, (SELECT group_concat(tag, ',') FROM asset_tags WHERE asset_id = a.id) AS tags FROM assets a` +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      ` ORDER BY a.created_at, a.id` + (q.limit ? ` LIMIT ${Math.floor(q.limit)}` : "");
    return this.db.query<Row, (string | number)[]>(sql).all(...args).map(fromRow);
  }

  tag(id: string, add: string[], remove: string[] = []): AssetRecord {
    this.db.transaction(() => {
      for (const t of add.map(normalizeTag).filter(Boolean)) this.db.query("INSERT OR IGNORE INTO asset_tags (asset_id, tag) VALUES (?, ?)").run(id, t);
      for (const t of remove.map(normalizeTag)) this.db.query("DELETE FROM asset_tags WHERE asset_id = ? AND tag = ?").run(id, t);
    })();
    return this.get(id)!;
  }

  setStatus(id: string, status: AssetStatus, notes?: string): AssetRecord {
    if (notes === undefined) this.db.query("UPDATE assets SET status = ? WHERE id = ?").run(status, id);
    else this.db.query("UPDATE assets SET status = ?, notes = ? WHERE id = ?").run(status, notes, id);
    return this.get(id)!;
  }

  /** Delete the record and its file. */
  remove(id: string): void {
    const a = this.get(id);
    if (!a) return;
    this.db.query("DELETE FROM assets WHERE id = ?").run(id);
    const full = this.path(a);
    if (existsSync(full)) rmSync(full);
    // Cached catalog thumbnails (written by the app server).
    for (const size of [96, 192, 384]) {
      const thumb = join(this.root, ".thumbs", `${a.id}-${size}.png`);
      if (existsSync(thumb)) rmSync(thumb);
    }
  }

  /** Every member of the variant set an asset belongs to (itself included), or just itself. */
  variantSet(id: string): string[] {
    const a = this.get(id);
    const tag = a?.tags.find((t) => t.startsWith("variant-of-"));
    if (!a || !tag) return a ? [a.id] : [];
    const members = this.list({ tags: [tag] }).filter((m) => m.status !== "reject").map((m) => m.id);
    return [a.id, ...members.filter((m) => m !== a.id)];
  }

  tagCounts(): { tag: string; count: number }[] {
    return this.db.query<{ tag: string; count: number }, []>("SELECT tag, count(*) AS count FROM asset_tags GROUP BY tag ORDER BY count DESC, tag").all();
  }
}

function fromRow(r: Row): AssetRecord {
  return {
    id: r.id, kind: r.kind, subject: r.subject, style: r.style, motif: r.motif, file: r.file,
    width: r.width, height: r.height, alpha: r.alpha === 1, tileable: r.tileable === 1,
    prompt: r.prompt, model: r.model, seed: r.seed, workflow: JSON.parse(r.workflow),
    metrics: JSON.parse(r.metrics) as Record<string, unknown>, sha256: r.sha256, status: r.status,
    notes: r.notes, createdAt: r.created_at, tags: r.tags ? r.tags.split(",").sort() : [],
  };
}
