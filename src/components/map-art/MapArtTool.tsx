import { useEffect, useMemo, useState } from "react";
import { useDungeonStore } from "../../store/dungeon-store.ts";
import { useUIStore } from "../../store/ui-store.ts";
import { roomName } from "../../engine/room-name.ts";
import { applyStyle, listLayers, withLayer, type LayerKey } from "./style-layers.ts";
import { thumbUrl } from "./asset-store.ts";
import { LayerEditor } from "./LayerEditor.tsx";
import "./map-art.css";

/**
 * Map art tool: a floating panel over the canvas. Pick a layer (a room, the
 * floor, the background), then edit it with the LayerEditor. Clicking a room
 * on the map while this is open selects that room's layer.
 */
export function MapArtTool() {
  const dungeon = useDungeonStore((s) => s.dungeon);
  const patchDungeon = useDungeonStore((s) => s.patchDungeon);
  const setArtTool = useUIStore((s) => s.setArtTool);
  const selectedRoomId = useUIStore((s) => s.selectedRoomId);
  const [selected, setSelected] = useState<LayerKey>("floor");
  const [openCatalogFor, setOpenCatalogFor] = useState<LayerKey | null>(null);

  // Follow the room selected on the map.
  useEffect(() => {
    if (selectedRoomId !== null) setSelected(`room:${selectedRoomId}`);
  }, [selectedRoomId]);

  const layers = useMemo(() => {
    if (!dungeon) return [];
    const list = listLayers(dungeon);
    // A room without its own texture has no layer yet; show it while it is selected.
    if (selected.startsWith("room:") && !list.some((l) => l.key === selected)) {
      const room = dungeon.rooms.find((r) => String(r.id) === selected.slice(5));
      if (room) list.unshift({ key: selected, label: roomName(room, room.description), hint: `Room ${room.id} · uses the map floor`, ref: undefined });
    }
    return list;
  }, [dungeon, selected]);
  const layer = layers.find((l) => l.key === selected) ?? layers.find((l) => l.key === "floor");

  if (!dungeon || !layer) return null;
  const roomsWithout = dungeon.rooms.filter((r) => !dungeon.style?.rooms?.[String(r.id)]);

  return (
    <aside className="art-tool" aria-label="Map art">
      <header className="art-tool-header">
        <span className="art-tool-title">Texture Tool</span>
        <button className="art-icon-btn" onClick={() => setArtTool("select")} aria-label="Close map art" title="Close">×</button>
      </header>

      <section className="art-card">
        <div className="art-card-title">Layers</div>
        <ul className="art-layers" role="listbox" aria-label="Layers">
          {layers.map((l) => (
            <li
              key={l.key}
              role="option"
              aria-selected={l.key === layer.key}
              className={`art-layer${l.key === layer.key ? " art-layer--active" : ""}`}
              onClick={() => setSelected(l.key)}
            >
              <span
                className={`art-layer-thumb${l.ref ? "" : " art-layer-thumb--empty"}`}
                style={l.ref ? { backgroundImage: `url(${thumbUrl(l.ref.asset, 96)})` } : undefined}
              />
              <span className="art-layer-text">
                <span className="art-layer-label">{l.label}</span>
                <span className="art-layer-hint">{l.hint}</span>
              </span>
              {l.key.startsWith("room:") && l.ref && (
                <button
                  className="art-icon-btn art-layer-remove"
                  aria-label={`Remove ${l.label} texture`}
                  title="Remove room texture (use the map floor)"
                  onClick={(e) => {
                    e.stopPropagation();
                    patchDungeon((d) => applyStyle(d, withLayer(d.style ?? {}, l.key, undefined)));
                  }}
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
        {roomsWithout.length > 0 && (
          <select
            className="art-add-room"
            aria-label="Give a room its own texture"
            value=""
            onChange={(e) => {
              const id = e.target.value;
              if (!id) return;
              setSelected(`room:${id}`);
              setOpenCatalogFor(`room:${id}`);
            }}
          >
            <option value="">+ Room texture…</option>
            {roomsWithout.map((r) => (
              <option key={r.id} value={r.id}>{`${r.id}: ${roomName(r, r.description)}`}</option>
            ))}
          </select>
        )}
      </section>

      <LayerEditor
        key={layer.key}
        layerKey={layer.key}
        label={layer.label}
        hotkey
        emptyHint={layer.key.startsWith("room:") ? "This room uses the map floor. Pick a texture to give it its own." : undefined}
        openCatalog={openCatalogFor === layer.key}
        onCatalogClosed={() => setOpenCatalogFor(null)}
      />
    </aside>
  );
}
