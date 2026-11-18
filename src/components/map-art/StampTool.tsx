import { useCallback, useEffect, useState } from "react";
import { useDungeonStore } from "../../store/dungeon-store.ts";
import { useUIStore } from "../../store/ui-store.ts";
import type { MapObject } from "../../engine/types.ts";
import { applyStyle } from "./style-layers.ts";
import { assetTitle, thumbUrl, useAssetStore } from "./asset-store.ts";
import { useStampStore, type StampSettings } from "./stamp-store.ts";
import { SliderField } from "./SliderField.tsx";
import { TextureCatalog } from "./TextureCatalog.tsx";
import "./map-art.css";

/** Replace or remove (null) one placed object. */
export function patchObject(id: string, next: MapObject | null): void {
  useDungeonStore.getState().patchDungeon((d) => {
    const objects = (d.style?.objects ?? []).flatMap((o) => (o.id !== id ? [o] : next ? [next] : []));
    return applyStyle(d, { ...d.style, objects: objects.length ? objects : undefined });
  });
}

/**
 * Stamp tool panel. With nothing selected the settings are for the next object
 * placed; with an object selected they edit that object.
 */
export function StampTool() {
  const setArtTool = useUIStore((s) => s.setArtTool);
  const objects = useDungeonStore((s) => s.dungeon?.style?.objects);
  const stamp = useStampStore();
  const { assets, load, recents, touchRecent, error } = useAssetStore();
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [tab, setTab] = useState<"recents" | "favorites">("recents");

  useEffect(() => { void load(); }, [load]);

  // Del / Backspace deletes the selected object, Esc deselects it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      const id = useStampStore.getState().selectedObjectId;
      if (!id) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        useDungeonStore.getState().pushEditSnapshot();
        patchObject(id, null);
        useStampStore.getState().select(null);
      } else if (e.key === "Escape") {
        useStampStore.getState().select(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const selected = objects?.find((o) => o.id === stamp.selectedObjectId);
  const assetId = selected?.asset ?? stamp.asset;
  const asset = assetId ? assets.find((a) => a.id === assetId) : undefined;

  // Settings shown: the selected object's, or the stamp's.
  const settings: StampSettings = selected
    ? {
        size: selected.size, rotation: selected.rotation ?? 0, randomRotation: stamp.randomRotation,
        opacity: selected.opacity ?? 1, shadow: selected.shadow !== false, flipX: !!selected.flipX,
      }
    : stamp;

  const change = useCallback(
    (patch: Partial<StampSettings>) => {
      if (selected) {
        const { randomRotation, ...rest } = patch;
        if (randomRotation !== undefined) stamp.setSettings({ randomRotation });
        if (Object.keys(rest).length) patchObject(selected.id, { ...selected, ...rest });
      } else stamp.setSettings(patch);
    },
    [selected, stamp],
  );

  const pick = (id: string) => {
    touchRecent(id);
    if (selected) patchObject(selected.id, { ...selected, asset: id });
    else stamp.setAsset(id);
  };

  const shelf = (tab === "recents" ? recents.map((id) => assets.find((a) => a.id === id)) : assets.filter((a) => a.favorite))
    .filter((a): a is NonNullable<typeof a> => !!a && !a.tileable);

  return (
    <aside className="art-tool" aria-label="Stamp tool">
      <header className="art-tool-header">
        <span className="art-tool-title">Stamp Tool</span>
        <button className="art-icon-btn" onClick={() => setArtTool("select")} aria-label="Close stamp tool" title="Close">×</button>
      </header>

      <section className="art-card">
        <div className="art-card-row">
          <span className="art-card-title art-card-title--strong">{selected ? "Selected object" : "Stamp"}</span>
          {selected && (
            <span className="art-card-actions">
              <button className="art-icon-btn" title="Deselect (Esc)" aria-label="Deselect" onClick={() => stamp.select(null)}>✓</button>
              <button
                className="art-icon-btn"
                title="Delete (Del)"
                aria-label="Delete object"
                onClick={() => {
                  useDungeonStore.getState().pushEditSnapshot();
                  patchObject(selected.id, null);
                  stamp.select(null);
                }}
              >
                🗑
              </button>
            </span>
          )}
        </div>
        <button
          className={`art-preview art-preview--object${assetId ? "" : " art-preview--empty"}`}
          onClick={() => setCatalogOpen(true)}
          aria-label="Open catalog"
          style={assetId ? { backgroundImage: `url(${thumbUrl(assetId, 384)})` } : undefined}
        >
          <span className="art-preview-label">{asset ? assetTitle(asset) : assetId ?? "Choose an object"}</span>
          <span className="art-preview-hint">Catalog</span>
        </button>
        <p className="art-empty">
          {selected
            ? "Drag it on the map to move it. Del deletes, Esc deselects."
            : assetId
              ? "Click on the map to place it. Click a placed object to select it."
              : "Pick a prop, decal or token, then click on the map to place it."}
        </p>
      </section>

      <section className="art-card">
        <SliderField label="Size" icon="⤢" value={settings.size} min={0.25} max={20} step={0.25} unit="cells" onChange={(size) => change({ size })} />
        <div className="art-slider-row">
          <SliderField label="Rotation" icon="↻" value={settings.rotation} min={0} max={359} step={1} unit="°" onChange={(rotation) => change({ rotation })} />
          <button
            className={`art-icon-btn art-dice${settings.randomRotation ? " art-icon-btn--active" : ""}`}
            aria-pressed={settings.randomRotation}
            title="Random rotation for each placement"
            aria-label="Random rotation for each placement"
            onClick={() => change({ randomRotation: !settings.randomRotation })}
          >
            🎲
          </button>
        </div>
        <SliderField label="Opacity" icon="◐" value={settings.opacity} min={0.05} max={1} step={0.01} unit="%" scale={100} onChange={(opacity) => change({ opacity })} />
        <div className="art-toggles">
          <label className="art-check">
            <input type="checkbox" checked={settings.shadow} onChange={(e) => change({ shadow: e.target.checked })} /> Shadow
          </label>
          <button className={`art-chip${settings.flipX ? " is-on" : ""}`} aria-pressed={settings.flipX} onClick={() => change({ flipX: !settings.flipX })}>
            ⇋ Flip
          </button>
        </div>
      </section>

      <section className="art-card">
        <div className="art-tabs" role="tablist">
          <button role="tab" aria-selected={tab === "recents"} className={tab === "recents" ? "is-on" : ""} onClick={() => setTab("recents")}>Recents</button>
          <button role="tab" aria-selected={tab === "favorites"} className={tab === "favorites" ? "is-on" : ""} onClick={() => setTab("favorites")}>Favorites</button>
        </div>
        {shelf.length === 0 ? (
          <p className="art-empty">{error ?? (tab === "recents" ? "Objects you stamp show up here." : "Star an object in the catalog to keep it here.")}</p>
        ) : (
          <div className="art-shelf">
            {shelf.map((a) => (
              <button key={a.id} className={`art-swatch art-swatch--alpha${a.id === assetId ? " art-swatch--active" : ""}`}
                title={assetTitle(a)} aria-label={assetTitle(a)} onClick={() => pick(a.id)}>
                <img src={thumbUrl(a.id, 96)} alt="" loading="lazy" />
              </button>
            ))}
          </div>
        )}
      </section>

      {catalogOpen && (
        <TextureCatalog
          layerLabel={selected ? "the selected object" : "the stamp"}
          currentId={assetId ?? undefined}
          tilesOnlyDefault={false}
          onPick={(id) => {
            pick(id);
            setCatalogOpen(false);
          }}
          onClose={() => setCatalogOpen(false)}
        />
      )}
    </aside>
  );
}
