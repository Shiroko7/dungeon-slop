import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { assetTitle, thumbUrl, useAssetStore, type AssetSummary } from "./asset-store.ts";

type GroupBy = "kind" | "motif" | "style" | "none";
type SortBy = "newest" | "oldest" | "name";
/** What the navigator has selected: everything, a shelf, or one kind (optionally one motif in it). */
type Scope = { type: "all" } | { type: "favorites" } | { type: "recents" } | { type: "kind"; kind: string; motif?: string };

const KIND_LABELS: Record<string, string> = {
  floor: "Floors & surfaces",
  wall: "Walls & rock",
  decal: "Ground decals",
  prop: "Props",
  creature: "Creatures",
};
const kindLabel = (k: string) => KIND_LABELS[k] ?? k.charAt(0).toUpperCase() + k.slice(1);

interface TextureCatalogProps {
  layerLabel: string;
  currentId?: string;
  /** Start with only seamless tiles shown (floors, backgrounds). */
  tilesOnlyDefault: boolean;
  onPick: (id: string) => void;
  onClose: () => void;
}

/**
 * Full-screen texture browser, modelled on Inkarnate's catalog: a navigator of
 * kinds and motifs on the left, search, zoomable thumbnail grid grouped into
 * collapsible sections. Click a texture to use it; Esc closes.
 */
export function TextureCatalog({ layerLabel, currentId, tilesOnlyDefault, onPick, onClose }: TextureCatalogProps) {
  const { assets, recents, setFavorite, load, loaded, error } = useAssetStore();
  const [scope, setScope] = useState<Scope>({ type: "all" });
  const [query, setQuery] = useState("");
  const [tilesOnly, setTilesOnly] = useState(tilesOnlyDefault);
  const [size, setSize] = useState(112);
  const [sortBy, setSortBy] = useState<SortBy>("newest");
  const [groupBy, setGroupBy] = useState<GroupBy>("kind");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { searchRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Variant sets show as one tile (the set's base) with a count; members appear
  // only when their set is expanded.
  const sets = useMemo(() => {
    const baseOf = new Map<string, string>();
    const members = new Map<string, AssetSummary[]>();
    const ids = new Set(assets.map((a) => a.id));
    for (const a of assets) {
      const base = a.tags.find((t) => t.startsWith("variant-of-"))?.slice("variant-of-".length);
      if (!base || base === a.id || !ids.has(base)) continue;
      baseOf.set(a.id, base);
      members.set(base, [...(members.get(base) ?? []), a]);
    }
    return { baseOf, members };
  }, [assets]);

  const pool = useMemo(
    () => assets.filter((a) => (!tilesOnly || a.tileable) && !sets.baseOf.has(a.id)),
    [assets, tilesOnly, sets],
  );

  // Navigator tree: kind → motif → count, over the pool.
  const tree = useMemo(() => {
    const kinds = new Map<string, Map<string, number>>();
    for (const a of pool) {
      const m = kinds.get(a.kind) ?? new Map<string, number>();
      m.set(a.motif, (m.get(a.motif) ?? 0) + 1);
      kinds.set(a.kind, m);
    }
    return [...kinds.entries()].sort(([a], [b]) => kindLabel(a).localeCompare(kindLabel(b)));
  }, [pool]);

  const visible = useMemo(() => {
    let list: AssetSummary[];
    if (scope.type === "favorites") list = pool.filter((a) => a.favorite);
    else if (scope.type === "recents") list = recents.map((id) => pool.find((a) => a.id === id)).filter((a): a is AssetSummary => !!a);
    else if (scope.type === "kind") list = pool.filter((a) => a.kind === scope.kind && (!scope.motif || a.motif === scope.motif));
    else list = pool;
    const q = query.trim().toLowerCase();
    if (q) {
      const words = q.split(/\s+/);
      list = list.filter((a) => {
        const hay = `${a.subject} ${a.tags.join(" ")} ${a.motif} ${a.kind} ${a.style}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
    }
    if (scope.type !== "recents") {
      list = [...list].sort((a, b) =>
        sortBy === "name" ? assetTitle(a).localeCompare(assetTitle(b))
          : sortBy === "oldest" ? a.createdAt.localeCompare(b.createdAt)
          : b.createdAt.localeCompare(a.createdAt));
    }
    return list;
  }, [pool, scope, query, sortBy, recents]);

  const groups = useMemo(() => {
    // Expanded sets: members follow their base.
    const withMembers = visible.flatMap((a) => (expanded.has(a.id) ? [a, ...(sets.members.get(a.id) ?? [])] : [a]));
    if (groupBy === "none") return [{ key: "all", label: "All", items: withMembers }];
    const by = new Map<string, AssetSummary[]>();
    for (const a of withMembers) {
      const k = groupBy === "kind" ? kindLabel(a.kind) : groupBy === "motif" ? a.motif : a.style;
      by.set(k, [...(by.get(k) ?? []), a]);
    }
    return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, items]) => ({ key, label: key, items }));
  }, [visible, groupBy, expanded, sets]);

  const crumbs = ["Catalog",
    scope.type === "all" ? "All textures" : scope.type === "favorites" ? "Favorites" : scope.type === "recents" ? "Recently used" : kindLabel(scope.kind),
    ...(scope.type === "kind" && scope.motif ? [scope.motif] : [])];
  const isScope = (s: Scope) => JSON.stringify(s) === JSON.stringify(scope);
  const thumbSize = size > 140 ? 384 : 192;

  // Portalled to <body>: the tool panel is its own stacking context, and the
  // map legend and export buttons would otherwise draw over the catalog.
  return createPortal(
    <div className="catalog-backdrop" role="dialog" aria-modal="true" aria-label="Texture catalog" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="catalog">
        <header className="catalog-titlebar">
          <span>Texture Catalog <span className="catalog-for">for {layerLabel}</span></span>
          <button className="art-icon-btn" onClick={onClose} aria-label="Close catalog" title="Close (Esc)">×</button>
        </header>

        <div className="catalog-body">
          <nav className="catalog-nav" aria-label="Catalog navigator">
            <div className="catalog-nav-heading">Catalog</div>
            <NavItem label="All textures" count={pool.length} active={isScope({ type: "all" })} onClick={() => setScope({ type: "all" })} />
            <NavItem label="★ Favorites" count={pool.filter((a) => a.favorite).length} active={isScope({ type: "favorites" })} onClick={() => setScope({ type: "favorites" })} />
            <NavItem label="Recently used" count={recents.filter((id) => pool.some((a) => a.id === id)).length} active={isScope({ type: "recents" })} onClick={() => setScope({ type: "recents" })} />
            {tree.map(([kind, motifs]) => (
              <div key={kind} className="catalog-nav-group">
                <NavItem
                  label={kindLabel(kind)}
                  count={[...motifs.values()].reduce((s, n) => s + n, 0)}
                  strong
                  active={isScope({ type: "kind", kind })}
                  onClick={() => setScope({ type: "kind", kind })}
                />
                {[...motifs.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([motif, n]) => (
                  <NavItem key={motif} label={motif} count={n} indent active={isScope({ type: "kind", kind, motif })}
                    onClick={() => setScope({ type: "kind", kind, motif })} />
                ))}
              </div>
            ))}
          </nav>

          <main className="catalog-main">
            <div className="catalog-toolbar">
              <div className="catalog-crumbs">{crumbs.map((c, i) => <span key={i}>{c}</span>)}</div>
              <label className="catalog-zoom" title="Thumbnail size">
                <span aria-hidden="true">⊕</span>
                <input type="range" min={64} max={224} step={8} value={size} aria-label="Thumbnail size"
                  style={{ "--pct": `${((size - 64) / 160) * 100}%` } as React.CSSProperties}
                  className="art-range" onChange={(e) => setSize(Number(e.target.value))} />
              </label>
            </div>
            <div className="catalog-toolbar">
              <input ref={searchRef} className="catalog-search" type="search" placeholder="Search textures, tags, motifs…"
                value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search textures" />
              <label className="catalog-check">
                <input type="checkbox" checked={tilesOnly} onChange={(e) => setTilesOnly(e.target.checked)} />
                Seamless tiles only
              </label>
              <span className="catalog-spacer" />
              <label className="catalog-select">Sort by
                <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)}>
                  <option value="newest">Newest</option>
                  <option value="oldest">Oldest</option>
                  <option value="name">Name (A–Z)</option>
                </select>
              </label>
              <label className="catalog-select">Group by
                <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
                  <option value="kind">Kind</option>
                  <option value="motif">Motif</option>
                  <option value="style">Style</option>
                  <option value="none">None</option>
                </select>
              </label>
            </div>

            <div className="catalog-results">
              {!loaded && <p className="art-empty">Loading…</p>}
              {loaded && error && <p className="art-empty">{error}</p>}
              {loaded && !error && visible.length === 0 && (
                <p className="art-empty">
                  Nothing here{query ? ` for “${query}”` : ""}.{tilesOnly ? " Untick “Seamless tiles only” to see props and decals." : ""}
                  {" "}New textures come from <code>bun run assets</code>.
                </p>
              )}
              {groups.map((g) => g.items.length > 0 && (
                <section key={g.key} className="catalog-group">
                  <button className="catalog-group-head" aria-expanded={!collapsed.has(g.key)}
                    onClick={() => setCollapsed((c) => { const n = new Set(c); if (n.has(g.key)) n.delete(g.key); else n.add(g.key); return n; })}>
                    <span className={`catalog-chevron${collapsed.has(g.key) ? " is-collapsed" : ""}`} aria-hidden="true">▾</span>
                    {g.label} <span className="catalog-count">({g.items.length} {g.items.length === 1 ? "texture" : "textures"})</span>
                  </button>
                  {!collapsed.has(g.key) && (
                    <div className="catalog-grid" style={{ gridTemplateColumns: `repeat(auto-fill, ${size}px)` }}>
                      {g.items.map((a) => {
                        const memberCount = sets.members.get(a.id)?.length ?? 0;
                        const isMember = sets.baseOf.has(a.id);
                        const current = a.id === currentId || (!!currentId && sets.baseOf.get(currentId) === a.id && !expanded.has(a.id));
                        return (
                        <div key={a.id} className={`catalog-tile${current ? " is-current" : ""}${a.alpha ? " is-alpha" : ""}${isMember ? " is-member" : ""}${memberCount ? " is-set" : ""}`}
                          style={{ width: size, height: size }}>
                          <button className="catalog-tile-pick" onClick={() => onPick(a.id)} title={`${assetTitle(a)} · ${a.motif} · ${a.style}`}
                            aria-label={`Use ${assetTitle(a)}`}>
                            <img src={thumbUrl(a.id, thumbSize)} alt="" loading="lazy" draggable={false} />
                            <span className="catalog-tile-name">{assetTitle(a)}</span>
                          </button>
                          <button className={`catalog-tile-star${a.favorite ? " is-on" : ""}`} aria-pressed={a.favorite}
                            aria-label={a.favorite ? "Remove from favourites" : "Add to favourites"}
                            onClick={() => void setFavorite(a.id, !a.favorite)}>★</button>
                          {memberCount > 0 && (
                            <button
                              className={`catalog-tile-set${expanded.has(a.id) ? " is-open" : ""}`}
                              title={expanded.has(a.id) ? "Hide the variants" : `A set of ${memberCount + 1} edge-matched variants, placed at random. Click to see them.`}
                              aria-expanded={expanded.has(a.id)}
                              aria-label={`${memberCount + 1} variants`}
                              onClick={() => setExpanded((s) => { const n = new Set(s); if (n.has(a.id)) n.delete(a.id); else n.add(a.id); return n; })}
                            >
                              ×{memberCount + 1}
                            </button>
                          )}
                        </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              ))}
            </div>
          </main>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function NavItem({ label, count, active, strong, indent, onClick }: {
  label: string; count: number; active: boolean; strong?: boolean; indent?: boolean; onClick: () => void;
}) {
  return (
    <button className={`catalog-nav-item${active ? " is-active" : ""}${strong ? " is-strong" : ""}${indent ? " is-indent" : ""}`} onClick={onClick}>
      <span className="catalog-nav-label">{label}</span>
      <span className="catalog-nav-count">({count})</span>
    </button>
  );
}
