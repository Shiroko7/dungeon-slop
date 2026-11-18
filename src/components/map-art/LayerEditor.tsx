import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useDungeonStore } from "../../store/dungeon-store.ts";
import type { TextureRef } from "../../engine/types.ts";
import { applyStyle, getLayer, withLayer, type LayerKey } from "./style-layers.ts";
import { assetTitle, thumbUrl, useAssetStore, variantSetOf } from "./asset-store.ts";
import { SliderField } from "./SliderField.tsx";
import { TextureCatalog } from "./TextureCatalog.tsx";
import "./map-art.css";

/** Sensible first tile size when a layer gets its first texture. */
const DEFAULT_CELLS = { floor: 8, background: 20, room: 8 } as const;

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

interface LayerEditorProps {
  layerKey: LayerKey;
  label: string;
  /** Shown under the title when the layer has no texture of its own. */
  emptyHint?: ReactNode;
  /** Open the catalog with F (only one editor on screen should). */
  hotkey?: boolean;
  /** Open the catalog as soon as this mounts (after "+ Room texture"). */
  openCatalog?: boolean;
  onCatalogClosed?: () => void;
}

/**
 * Edit one art layer: its texture (big preview → catalog, or the recents and
 * favourites shelf) and how it is laid (tile or fit, size, rotation, darken).
 * Used by the Map Art panel and by the room inspector.
 */
export function LayerEditor({ layerKey, label, emptyHint, hotkey = false, openCatalog = false, onCatalogClosed }: LayerEditorProps) {
  const style = useDungeonStore((s) => s.dungeon?.style);
  const patchDungeon = useDungeonStore((s) => s.patchDungeon);
  const { assets, load, recents, touchRecent, setFavorite, error } = useAssetStore();
  const [catalogOpen, setCatalogOpen] = useState(openCatalog);
  const [tab, setTab] = useState<"recents" | "favorites">("recents");

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (openCatalog) setCatalogOpen(true); }, [openCatalog, layerKey]);

  const isRoom = layerKey.startsWith("room:");
  const ref = getLayer(style ?? {}, layerKey);
  // A room without its own texture shows the map floor it actually uses.
  const inherited = !ref && isRoom ? style?.floor : undefined;
  const shown = ref ?? inherited;
  const current = shown ? assets.find((a) => a.id === shown.asset) : undefined;

  const update = useCallback(
    (next: TextureRef | undefined) => patchDungeon((d) => applyStyle(d, withLayer(d.style ?? {}, layerKey, next))),
    [layerKey, patchDungeon],
  );

  const choose = useCallback(
    (id: string) => {
      const asset = assets.find((a) => a.id === id);
      const from = ref ?? inherited;
      const base: TextureRef = from
        ? { ...from, asset: id }
        : { asset: id, cells: isRoom ? DEFAULT_CELLS.room : DEFAULT_CELLS[layerKey as "floor" | "background"] };
      // A one-off picture (not a seamless tile) can only sensibly be fitted to a room.
      if (isRoom && asset && !asset.tileable) base.fit = true;
      // Scatter its edge-matched variants when it has a set.
      const set = variantSetOf(assets, id);
      if (set.length > 1 && !base.fit) base.variants = set;
      else delete base.variants;
      update(base);
      touchRecent(id);
    },
    [assets, inherited, isRoom, layerKey, ref, touchRecent, update],
  );

  const closeCatalog = useCallback(() => {
    setCatalogOpen(false);
    onCatalogClosed?.();
  }, [onCatalogClosed]);

  // F opens the catalog, as in Inkarnate.
  useEffect(() => {
    if (!hotkey) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "f" && !e.ctrlKey && !e.metaKey && !e.altKey && !isTyping(e.target) && !catalogOpen) {
        e.preventDefault();
        setCatalogOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [catalogOpen, hotkey]);

  const shelf = (tab === "recents" ? recents.map((id) => assets.find((a) => a.id === id)) : assets.filter((a) => a.favorite))
    .filter((a): a is NonNullable<typeof a> => !!a);
  const tiledPreview = !!shown && !shown.fit && (current?.tileable ?? true);

  return (
    <>
      <section className="art-card">
        <div className="art-card-row">
          <span className="art-card-title art-card-title--strong">{label}</span>
          <span className="art-card-actions">
            {current && (
              <button
                className={`art-icon-btn${current.favorite ? " art-icon-btn--on" : ""}`}
                aria-pressed={current.favorite}
                aria-label={current.favorite ? "Remove from favourites" : "Add to favourites"}
                title={current.favorite ? "Remove from favourites" : "Add to favourites"}
                onClick={() => void setFavorite(current.id, !current.favorite)}
              >
                ★
              </button>
            )}
            {ref && (
              <button className="art-icon-btn" aria-label="Clear texture" title="Clear texture" onClick={() => update(undefined)}>
                ⌫
              </button>
            )}
          </span>
        </div>
        {!ref && !inherited && emptyHint && <p className="art-empty">{emptyHint}</p>}

        <button
          className={`art-preview${shown ? "" : " art-preview--empty"}`}
          onClick={() => setCatalogOpen(true)}
          aria-label="Open texture catalog"
          style={
            shown
              ? tiledPreview
                ? { backgroundImage: `url(${thumbUrl(shown.asset, 192)})`, backgroundSize: "96px 96px", backgroundRepeat: "repeat" }
                : { backgroundImage: `url(${thumbUrl(shown.asset, 384)})`, backgroundSize: "contain", backgroundRepeat: "no-repeat", backgroundPosition: "center" }
              : undefined
          }
        >
          {inherited && <span className="art-badge">Map floor</span>}
          <span className="art-preview-label">{shown ? (current ? assetTitle(current) : shown.asset) : "Choose a texture"}</span>
          <span className="art-preview-hint">Catalog{hotkey && <kbd>F</kbd>}</span>
        </button>

        {inherited && (
          <>
            <p className="art-empty">This room uses the map floor. Changes made here apply to this room only.</p>
            <button className="art-chip art-chip--wide" onClick={() => update({ ...inherited })}>
              Customise for this room
            </button>
          </>
        )}

        {ref && isRoom && (
          <div className="art-segmented" role="group" aria-label="How the texture is laid">
            <button className={!ref.fit && ref.layout !== "radial" ? "is-on" : ""} aria-pressed={!ref.fit && ref.layout !== "radial"}
              title="Repeat in straight rows" onClick={() => update({ ...ref, fit: false, layout: "grid" })}>Tile</button>
            <button className={!ref.fit && ref.layout === "radial" ? "is-on" : ""} aria-pressed={!ref.fit && ref.layout === "radial"}
              title="Bend the rows into rings that follow the room's curve" onClick={() => update({ ...ref, fit: false, layout: "radial" })}>Radial</button>
            <button className={ref.fit ? "is-on" : ""} aria-pressed={!!ref.fit}
              title="One image stretched over the room" onClick={() => update({ ...ref, fit: true })}>Fit</button>
          </div>
        )}
        {ref && !ref.fit && (
          <SliderField label="Tile size" icon="⤢" value={ref.cells ?? 4} min={1} max={128} step={1} unit="cells"
            onChange={(cells) => update({ ...ref, cells })} />
        )}
        {ref && !ref.fit && variantSetOf(assets, ref.asset).length > 1 && (
          <div className="art-toggles">
            <label className="art-check" title="Scatter edge-matched versions of this tile so large areas don't repeat">
              <input
                type="checkbox"
                checked={(ref.variants?.length ?? 0) > 1}
                onChange={(e) => update(e.target.checked ? { ...ref, variants: variantSetOf(assets, ref.asset) } : { ...ref, variants: undefined })}
              />
              Random variants ({variantSetOf(assets, ref.asset).length})
            </label>
            {(ref.variants?.length ?? 0) > 1 && (
              <button className="art-chip" title="Re-roll which variant goes where"
                onClick={() => update({ ...ref, variantSeed: Math.floor(Math.random() * 1e6) })}>
                🎲 Shuffle
              </button>
            )}
          </div>
        )}
        {ref && !ref.fit && ref.layout === "radial" && (
          <SliderField label="Stagger" icon="⇢" value={ref.stagger ?? 0} min={0} max={1} step={0.01} unit="%" scale={100}
            onChange={(stagger) => update({ ...ref, stagger })} />
        )}
        {ref && ref.layout !== "radial" && (
          <SliderField label="Rotation" icon="↻" value={ref.rotation ?? 0} min={0} max={359} step={1} unit="°"
            onChange={(rotation) => update({ ...ref, rotation })} />
        )}
        {ref && (
          <SliderField label="Darken" icon="◐" value={ref.shade ?? 0} min={0} max={0.8} step={0.01} unit="%" scale={100}
            onChange={(shade) => update({ ...ref, shade })} />
        )}
      </section>

      <section className="art-card">
        <div className="art-tabs" role="tablist">
          <button role="tab" aria-selected={tab === "recents"} className={tab === "recents" ? "is-on" : ""} onClick={() => setTab("recents")}>Recents</button>
          <button role="tab" aria-selected={tab === "favorites"} className={tab === "favorites" ? "is-on" : ""} onClick={() => setTab("favorites")}>Favorites</button>
        </div>
        {shelf.length === 0 ? (
          <p className="art-empty">{error ?? (tab === "recents" ? "Textures you use show up here." : "Star a texture to keep it here.")}</p>
        ) : (
          <div className="art-shelf">
            {shelf.map((a) => (
              <button
                key={a.id}
                className={`art-swatch${a.id === ref?.asset ? " art-swatch--active" : ""}${a.alpha ? " art-swatch--alpha" : ""}`}
                title={assetTitle(a)}
                aria-label={assetTitle(a)}
                onClick={() => choose(a.id)}
              >
                <img src={thumbUrl(a.id, 96)} alt="" loading="lazy" />
              </button>
            ))}
          </div>
        )}
      </section>

      {catalogOpen && (
        <TextureCatalog
          layerLabel={label}
          currentId={ref?.asset}
          tilesOnlyDefault={!isRoom}
          onPick={(id) => {
            choose(id);
            closeCatalog();
          }}
          onClose={closeCatalog}
        />
      )}
    </>
  );
}
