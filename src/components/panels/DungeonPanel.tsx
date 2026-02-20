import { useCallback } from "react";
import { useDungeonStore } from "../../store/dungeon-store.ts";
import { Button } from "../shared/Button.tsx";

export function DungeonPanel() {
  const dungeon = useDungeonStore((s) => s.dungeon);
  const dungeonDescription = useDungeonStore((s) => s.dungeonDescription);
  const isDescribingDungeon = useDungeonStore((s) => s.isDescribingDungeon);
  const describeDungeon = useDungeonStore((s) => s.describeDungeon);

  const handleDescribe = useCallback(() => {
    if (!dungeon || isDescribingDungeon) return;
    describeDungeon();
  }, [dungeon, isDescribingDungeon, describeDungeon]);

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
      </div>

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
        </>
      )}
    </div>
  );
}
