import { useCallback, useState } from "react";
import { useDungeonStore } from "../../store/dungeon-store.ts";
import { api } from "../../store/api.ts";
import {
  clearOverviewDraft,
  getOverviewDraft,
  saveOverviewDraft,
} from "../../store/content-drafts.ts";
import type { DungeonDescription } from "../../engine/types.ts";
import { Button } from "../shared/Button.tsx";
import { GroundingSources } from "../shared/GroundingSources.tsx";

export function DungeonPanel() {
  const dungeon = useDungeonStore((s) => s.dungeon);
  const dungeonDescription = useDungeonStore((s) => s.dungeonDescription);
  const isDescribingDungeon = useDungeonStore((s) => s.isDescribingDungeon);
  const describeDungeon = useDungeonStore((s) => s.describeDungeon);
  const dungeonId = useDungeonStore((s) => s.dungeonId);
  const setDungeonDescription = useDungeonStore((s) => s.setDungeonDescription);
  const restoreRevision = useDungeonStore((s) => s.restoreRevision);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DungeonDescription | null>(null);
  const [revisions, setRevisions] = useState<Awaited<ReturnType<typeof api.dungeons.revisions>>>([]);

  const handleDescribe = useCallback(() => {
    if (!dungeon || isDescribingDungeon) return;
    describeDungeon();
  }, [dungeon, isDescribingDungeon, describeDungeon]);

  const startEdit = () => {
    setDraft(getOverviewDraft(dungeonId) ?? dungeonDescription ?? {
      history: "", corridorFeatures: [], wanderingMonsters: [],
    });
    setEditing(true);
  };
  const updateDraft = (patch: Partial<DungeonDescription>) => {
    setDraft((previous) => {
      const next = { ...(previous ?? { history: "", corridorFeatures: [], wanderingMonsters: [] }), ...patch };
      saveOverviewDraft(dungeonId, next);
      return next;
    });
  };
  const saveEdit = () => {
    if (!draft) return;
    setDungeonDescription(draft);
    clearOverviewDraft(dungeonId);
    setEditing(false);
  };
  const loadHistory = async () => {
    if (dungeonId === null) return;
    setRevisions(await api.dungeons.revisions(dungeonId, { kind: "overview" }));
  };

  if (!dungeon) {
    return (
      <div className="dungeon-panel dungeon-panel--empty">
        <p>Generate a dungeon first.</p>
      </div>
    );
  }

  const d = dungeonDescription;

  return (
    <div className="dungeon-panel">
      <div className="dungeon-panel-header">
        <h3 className="dungeon-panel-heading">General</h3>
        <Button
          variant="secondary"
          size="sm"
          onClick={handleDescribe}
          disabled={isDescribingDungeon}
        >
          {isDescribingDungeon ? "Generating..." : d ? "Regenerate" : "Generate"}
        </Button>
        <Button variant="secondary" size="sm" onClick={startEdit}>Edit</Button>
        <Button variant="secondary" size="sm" onClick={() => void loadHistory()}>History</Button>
      </div>

      {editing && draft && (
        <div className="dungeon-panel-editor">
          <label>History<textarea value={draft.history} rows={5} onChange={(e) => updateDraft({ history: e.target.value })} /></label>
          {(["size", "walls", "floor", "temperature", "illumination"] as const).map((field) => (
            <label key={field}>{field}<input value={draft[field] ?? ""} onChange={(e) => updateDraft({ [field]: e.target.value } as Partial<DungeonDescription>)} /></label>
          ))}
          <div><Button variant="primary" size="sm" onClick={saveEdit}>Save</Button>{" "}<Button variant="secondary" size="sm" onClick={() => setEditing(false)}>Cancel</Button></div>
        </div>
      )}

      {revisions.length > 0 && (
        <div className="dungeon-panel-history">
          <strong>Previous versions</strong>
          {revisions.slice(0, 5).map((revision) => (
            <button key={revision.id} onClick={() => void restoreRevision(revision.id)}>
              {new Date(revision.createdAt).toLocaleString()} — Restore
            </button>
          ))}
        </div>
      )}

      {!d && !isDescribingDungeon && (
        <p className="dungeon-panel-empty">
          Generate the General section for dungeon history, environment, corridor features, and wandering monsters.
        </p>
      )}

      {isDescribingDungeon && (
        <p className="dungeon-panel-loading">Generating dungeon description…</p>
      )}

      {d && (
        <>
          {d.history && (
            <div className="dungeon-panel-section">
              <h4 className="dungeon-panel-section-title">History</h4>
              <p className="dungeon-panel-text">{d.history}</p>
            </div>
          )}

          <div className="dungeon-panel-stats">
            {d.size && (
              <div className="dungeon-panel-stat">
                <span className="dungeon-panel-stat-label">Size</span>
                <span className="dungeon-panel-stat-value">{d.size}</span>
              </div>
            )}
            {d.walls && (
              <div className="dungeon-panel-stat">
                <span className="dungeon-panel-stat-label">Walls</span>
                <span className="dungeon-panel-stat-value">{d.walls}</span>
              </div>
            )}
            {d.floor && (
              <div className="dungeon-panel-stat">
                <span className="dungeon-panel-stat-label">Floor</span>
                <span className="dungeon-panel-stat-value">{d.floor}</span>
              </div>
            )}
            {d.temperature && (
              <div className="dungeon-panel-stat">
                <span className="dungeon-panel-stat-label">Temperature</span>
                <span className="dungeon-panel-stat-value">{d.temperature}</span>
              </div>
            )}
            {d.illumination && (
              <div className="dungeon-panel-stat">
                <span className="dungeon-panel-stat-label">Light</span>
                <span className="dungeon-panel-stat-value">{d.illumination}</span>
              </div>
            )}
          </div>

          {d.corridorFeatures && d.corridorFeatures.length > 0 && (
            <div className="dungeon-panel-section">
              <h4 className="dungeon-panel-section-title">Corridor Features</h4>
              <ul className="corridor-features-list">
                {d.corridorFeatures.map((cf) => (
                  <li key={cf.label} className="corridor-feature-item">
                    <span className="corridor-feature-label">{cf.label}.</span>
                    <span className="corridor-feature-desc">{cf.description}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {d.wanderingMonsters && d.wanderingMonsters.length > 0 && (
            <div className="dungeon-panel-section">
              <h4 className="dungeon-panel-section-title">Wandering Monsters</h4>
              <ul className="dungeon-panel-list">
                {d.wanderingMonsters.map((m, i) => <li key={i}>{m}</li>)}
              </ul>
            </div>
          )}
          <GroundingSources grounding={d.grounding} label="Sources for this overview" />
        </>
      )}
    </div>
  );
}
