import { roomName } from "../../engine/room-name.ts";
import { useState, useCallback } from "react";
import { useDungeonStore } from "../../store/dungeon-store.ts";
import { api } from "../../store/api.ts";
import { useUIStore } from "../../store/ui-store.ts";
import { Button } from "../shared/Button.tsx";
import { useConfirm } from "../shared/ConfirmDialog.tsx";
import type { Room, RoomDescription, RoomEntry } from "../../engine/types.ts";
import {
  clearRoomDraft,
  descriptionToDraft,
  getRoomDraft,
  saveRoomDraft,
  type RoomDraftFields,
} from "../../store/content-drafts.ts";

function RoomListItem({
  room,
  description,
  onSelect,
}: {
  room: Room;
  description: RoomDescription | undefined;
  onSelect: (id: number) => void;
}) {
  const desc = description ?? room.description;
  const name = roomName(room, desc);
  const isDescribed = !!desc;
  return (
    <button
      className={`room-list-item ${isDescribed ? "room-list-item--described" : ""}`}
      onClick={() => onSelect(room.id)}
    >
      <span className="room-list-item-name">
        {isDescribed && <span className="room-list-item-check">&#10003;</span>}
        {name}
      </span>
      <span className="room-list-item-size">
        {room.width}x{room.height}
      </span>
    </button>
  );
}

interface EditDraft extends RoomDraftFields {}

function descToText(desc: RoomDescription | undefined): string {
  return desc?.features ?? desc?.description ?? "";
}

function EntryList({ entries }: { entries: RoomEntry[] }) {
  return (
    <div className="room-detail-section">
      <h4 className="room-detail-section-title">Entries</h4>
      <ul className="room-entries-list">
        {entries.map((entry, i) => (
          <li key={i} className="room-entry-item">
            <span className="room-entry-direction">{entry.direction}</span>
            <span className="room-entry-door">{entry.doorType}</span>
            {entry.leadsTo && <span className="room-entry-leads">→ {entry.leadsTo}</span>}
            {entry.trap && <span className="room-entry-trap">⚠ {entry.trap}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RoomDetail({
  room,
  description,
  onBack,
  onRegenerate,
}: {
  room: Room;
  description: RoomDescription | undefined;
  onBack: () => void;
  onRegenerate: () => void;
}) {
  const setRoomDescription = useDungeonStore((s) => s.setRoomDescription);
  const clearRoomDescription = useDungeonStore((s) => s.clearRoomDescription);
  const restoreRevision = useDungeonStore((s) => s.restoreRevision);
  const dungeonId = useDungeonStore((s) => s.dungeonId);
  const { ask, dialog } = useConfirm();
  const desc = description ?? room.description;
  const name = roomName(room, desc);

  const [isEditing, setIsEditing] = useState(false);
  const [history, setHistory] = useState<Awaited<ReturnType<typeof api.dungeons.revisions>>>([]);
  const [draft, setDraft] = useState<EditDraft>(() =>
    getRoomDraft(dungeonId, room.id) ?? descriptionToDraft(desc),
  );

  const updateDraft = useCallback(
    (patch: Partial<EditDraft>) => {
      setDraft((previous) => {
        const next = { ...previous, ...patch };
        saveRoomDraft(dungeonId, room.id, next);
        return next;
      });
    },
    [dungeonId, room.id],
  );

  const startEdit = useCallback(() => {
    setDraft(getRoomDraft(dungeonId, room.id) ?? descriptionToDraft(desc));
    setIsEditing(true);
  }, [desc]);

  const saveEdit = useCallback(() => {
    const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
    const saved: RoomDescription = {
      name: draft.name.trim() || roomName(room),
      entries: desc?.entries,
      features: draft.features.trim() || undefined,
      monsters: lines(draft.monsters),
      treasure: lines(draft.treasure),
      hiddenTreasure: draft.hiddenTreasure.trim() || undefined,
      traps: lines(draft.traps),
      tricks: lines(draft.tricks),
      notes: draft.notes.trim() || undefined,
      empty: desc?.empty,
    };
    setRoomDescription(room.id, saved);
    clearRoomDraft(dungeonId, room.id);
    setIsEditing(false);
  }, [draft, room.id, desc, dungeonId, setRoomDescription]);

  const loadHistory = useCallback(async () => {
    if (dungeonId === null) return;
    setHistory(await api.dungeons.revisions(dungeonId, { kind: "room", roomIndex: room.id }));
  }, [dungeonId, room.id]);

  if (isEditing) {
    return (
      <div className="room-detail">
        <div className="room-detail-header">
          <Button variant="icon" size="sm" onClick={() => setIsEditing(false)} aria-label="Cancel edit">
            &larr;
          </Button>
          <h3 className="room-detail-name">Edit Room</h3>
        </div>

        <div className="room-edit-form">
          <label className="room-edit-label">
            Name
            <input
              className="room-edit-input"
              value={draft.name}
              onChange={(e) => updateDraft({ name: e.target.value })}
              placeholder={roomName(room)}
            />
          </label>

          <label className="room-edit-label">
            Description
            <textarea
              className="room-edit-textarea"
              value={draft.features}
              onChange={(e) => updateDraft({ features: e.target.value })}
              rows={4}
              placeholder="Room description…"
            />
          </label>

          <label className="room-edit-label">
            Monsters <span className="room-edit-hint">(one per line)</span>
            <textarea
              className="room-edit-textarea"
              value={draft.monsters}
              onChange={(e) => updateDraft({ monsters: e.target.value })}
              rows={3}
              placeholder={"2 Goblins (CR 1/4, MM p.166, 50 XP each)\n1 Hobgoblin"}
            />
          </label>

          <label className="room-edit-label">
            Treasure <span className="room-edit-hint">(one per line)</span>
            <textarea
              className="room-edit-textarea"
              value={draft.treasure}
              onChange={(e) => updateDraft({ treasure: e.target.value })}
              rows={3}
              placeholder={"50 sp in a cracked clay pot\nOrnate dagger (+1)"}
            />
          </label>

          <label className="room-edit-label">
            Hidden Treasure
            <input
              className="room-edit-input"
              value={draft.hiddenTreasure}
              onChange={(e) => updateDraft({ hiddenTreasure: e.target.value })}
              placeholder="Loose flagstone (DC 14 Perception): 120 gp"
            />
          </label>

          <label className="room-edit-label">
            Traps <span className="room-edit-hint">(one per line)</span>
            <textarea
              className="room-edit-textarea"
              value={draft.traps}
              onChange={(e) => updateDraft({ traps: e.target.value })}
              rows={2}
              placeholder="Needle trap on chest: DC 13 Perception, DC 12 Dex save or 1 piercing"
            />
          </label>

          <label className="room-edit-label">
            Tricks <span className="room-edit-hint">(one per line)</span>
            <textarea
              className="room-edit-textarea"
              value={draft.tricks}
              onChange={(e) => updateDraft({ tricks: e.target.value })}
              rows={2}
              placeholder="Magic mirror shows a different room…"
            />
          </label>

          <label className="room-edit-label">
            Notes
            <textarea
              className="room-edit-textarea"
              value={draft.notes}
              onChange={(e) => updateDraft({ notes: e.target.value })}
              rows={2}
              placeholder="DM notes…"
            />
          </label>
        </div>

        <div className="room-edit-actions">
          <Button variant="primary" size="sm" onClick={saveEdit}>Save</Button>
          <Button variant="secondary" size="sm" onClick={() => setIsEditing(false)}>Cancel</Button>
        </div>
      </div>
    );
  }

  const prose = descToText(desc);

  return (
    <div className="room-detail">
      <div className="room-detail-header">
        <Button variant="icon" size="sm" onClick={onBack} aria-label="Back to room list">
          &larr;
        </Button>
        <h3 className="room-detail-name">{name}</h3>
        <Button variant="icon" size="sm" onClick={startEdit} aria-label="Edit description" title="Edit description">
          ✎
        </Button>
      </div>

      {desc ? (
        <>
          {desc.entries && desc.entries.length > 0 && <EntryList entries={desc.entries} />}

          {prose && (
            <div className="room-detail-section">
              <h4 className="room-detail-section-title">Description</h4>
              <p className="room-detail-description">{prose}</p>
            </div>
          )}

          {desc.monsters && desc.monsters.length > 0 && (
            <div className="room-detail-section">
              <h4 className="room-detail-section-title">Monsters</h4>
              <ul className="room-detail-list">
                {desc.monsters.map((m, i) => <li key={i}>{m}</li>)}
              </ul>
            </div>
          )}

          {(desc.treasure && desc.treasure.length > 0 || desc.hiddenTreasure) && (
            <div className="room-detail-section">
              <h4 className="room-detail-section-title">Treasure</h4>
              {desc.treasure && desc.treasure.length > 0 && (
                <ul className="room-detail-list">
                  {desc.treasure.map((t, i) => <li key={i}>{t}</li>)}
                </ul>
              )}
              {desc.hiddenTreasure && (
                <p className="room-detail-hidden-treasure">&#128273; {desc.hiddenTreasure}</p>
              )}
            </div>
          )}

          {desc.traps && desc.traps.length > 0 && (
            <div className="room-detail-section">
              <h4 className="room-detail-section-title">Traps</h4>
              <ul className="room-detail-list room-detail-list--trap">
                {desc.traps.map((t, i) => <li key={i}>{t}</li>)}
              </ul>
            </div>
          )}

          {desc.tricks && desc.tricks.length > 0 && (
            <div className="room-detail-section">
              <h4 className="room-detail-section-title">Tricks</h4>
              <ul className="room-detail-list room-detail-list--trick">
                {desc.tricks.map((t, i) => <li key={i}>{t}</li>)}
              </ul>
            </div>
          )}

          {desc.notes && (
            <div className="room-detail-section">
              <h4 className="room-detail-section-title">Notes</h4>
              <p className="room-detail-notes">{desc.notes}</p>
            </div>
          )}

          {desc.empty && (
            <p className="room-detail-empty-tag">This room is empty.</p>
          )}
        </>
      ) : (
        <p className="room-detail-empty">No description yet. Use Describe All or edit manually.</p>
      )}

      <div className="room-detail-actions">
        <Button variant="secondary" size="sm" onClick={onRegenerate}>
          Regenerate Description
        </Button>
        <Button variant="secondary" size="sm" onClick={() => void loadHistory()}>
          History
        </Button>
        {desc && (
          <button
            className="room-detail-clear"
            title="Clear this room's description"
            onClick={() => {
              void ask({
                title: `Clear the description for "${name}"?`,
                body: "The room stays on the map; only what was written about it is removed.",
                confirmLabel: "Clear",
              }).then((confirmed) => {
                if (confirmed) void clearRoomDescription(room.id);
              });
            }}
          >
            Clear
          </button>
        )}
      </div>
      {history.length > 0 && (
        <div className="dungeon-panel-history">
          <strong>Previous versions</strong>
          {history.slice(0, 5).map((revision) => (
            <button key={revision.id} onClick={() => void restoreRevision(revision.id)}>
              {new Date(revision.createdAt).toLocaleString()} — Restore
            </button>
          ))}
        </div>
      )}
      {dialog}
    </div>
  );
}

export function RoomPanel() {
  const dungeon = useDungeonStore((s) => s.dungeon);
  const roomDescriptions = useDungeonStore((s) => s.roomDescriptions);
  const isDescribingRooms = useDungeonStore((s) => s.isDescribingRooms);
  const describeProgress = useDungeonStore((s) => s.describeProgress);
  const missingRoomIds = useDungeonStore((s) => s.missingRoomIds);
  const selectedRoomId = useUIStore((s) => s.selectedRoomId);
  const setSelectedRoomId = useUIStore((s) => s.setSelectedRoomId);

  const describeRoom = useDungeonStore((s) => s.describeRoom);
  const describeRooms = useDungeonStore((s) => s.describeRooms);

  const handleRegenerate = useCallback(() => {
    if (selectedRoomId === null) return;
    describeRoom(selectedRoomId);
  }, [selectedRoomId, describeRoom]);

  const handleDescribeAll = useCallback(() => {
    if (!dungeon || isDescribingRooms) return;
    describeRooms(missingRoomIds.length > 0 ? missingRoomIds : undefined);
  }, [dungeon, isDescribingRooms, describeRooms, missingRoomIds]);

  if (!dungeon) {
    return (
      <div className="room-panel room-panel--empty">
        <p>Generate a dungeon first to see rooms.</p>
      </div>
    );
  }

  const selectedRoom =
    selectedRoomId !== null
      ? dungeon.rooms.find((r) => r.id === selectedRoomId)
      : undefined;

  if (selectedRoom) {
    return (
      <div className="room-panel">
        <RoomDetail
          room={selectedRoom}
          description={roomDescriptions.get(selectedRoom.id)}
          onBack={() => setSelectedRoomId(null)}
          onRegenerate={handleRegenerate}
        />
      </div>
    );
  }

  return (
    <div className="room-panel">
      <div className="room-panel-header">
        <h3 className="room-panel-heading">Rooms ({dungeon.rooms.length})</h3>
        <Button
          variant="secondary"
          size="sm"
          onClick={handleDescribeAll}
          disabled={isDescribingRooms}
        >
          {isDescribingRooms
            ? "Describing..."
            : missingRoomIds.length > 0
              ? `Retry ${missingRoomIds.length} missing`
              : "Describe All"}
        </Button>
      </div>
      {describeProgress && (
        <div className="describe-progress">
          <div className="describe-progress-header">
            <span>Describing {describeProgress.roomName}...</span>
            <span className="describe-progress-count">{describeProgress.current}/{describeProgress.total}</span>
          </div>
          <div className="describe-progress-bar">
            <div
              className="describe-progress-fill"
              style={{ width: `${(describeProgress.current / describeProgress.total) * 100}%` }}
            />
          </div>
          {describeProgress.streamingText && (
            <pre className="describe-progress-stream">{describeProgress.streamingText.slice(-200)}</pre>
          )}
        </div>
      )}
      <div className="room-list">
        {dungeon.rooms.map((room) => (
          <RoomListItem
            key={room.id}
            room={room}
            description={roomDescriptions.get(room.id)}
            onSelect={setSelectedRoomId}
          />
        ))}
      </div>
    </div>
  );
}
