import { useDungeonStore } from "../../store/dungeon-store.ts";

export function DescribeActivityToast() {
  const isDescribingRooms = useDungeonStore((s) => s.isDescribingRooms);
  const progress = useDungeonStore((s) => s.describeProgress);

  if (!isDescribingRooms || !progress) return null;

  const pct = (progress.current / progress.total) * 100;

  return (
    <div className="activity-toast">
      <div className="activity-toast-header">
        <span className="activity-toast-spinner" />
        <span>Describing {progress.roomName}</span>
        <span className="activity-toast-count">{progress.current}/{progress.total}</span>
      </div>
      <div className="activity-toast-bar">
        <div className="activity-toast-fill" style={{ width: `${pct}%` }} />
      </div>
      {progress.streamingText && (
        <p className="activity-toast-preview">
          {progress.streamingText.slice(-120)}
        </p>
      )}
    </div>
  );
}
