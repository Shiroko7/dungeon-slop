import { useEffect, useRef } from "react";
import { useDungeonStore } from "../../store/dungeon-store.ts";
import { useUIStore } from "../../store/ui-store.ts";
import { navigate, paths } from "../../router/router.ts";
import { Toolbar } from "../layout/Toolbar.tsx";
import { DungeonCanvas } from "../canvas/DungeonCanvas.tsx";
import { ExportActions } from "../canvas/ExportActions.tsx";
import { DescribeActivityToast } from "../canvas/DescribeActivityToast.tsx";
import { MapLegend } from "../canvas/MapLegend.tsx";
import { RoomPanel } from "../panels/RoomPanel.tsx";
import { DungeonPanel } from "../panels/DungeonPanel.tsx";
import { LayoutPanel } from "../panels/LayoutPanel.tsx";
import { LoadingSpinner } from "../shared/LoadingSpinner.tsx";

/**
 * The map itself, plus the inspector for whatever is selected.
 *
 * The room in the URL is the selection: deep-linking a described room is the
 * point of giving rooms their own route, so the route drives the store rather
 * than the other way round.
 */
export function DungeonView({
  campaignId,
  dungeonId,
  roomId,
}: {
  campaignId: number;
  dungeonId: number;
  roomId: number | null;
}) {
  const loadDungeon = useDungeonStore((s) => s.loadDungeon);
  const dungeon = useDungeonStore((s) => s.dungeon);
  const isLoading = useDungeonStore((s) => s.isLoading);
  const loadedCampaign = useDungeonStore((s) => s.campaignId);
  const loadedId = useDungeonStore((s) => s.dungeonId);
  const error = useDungeonStore((s) => s.error);
  const setError = useDungeonStore((s) => s.setError);

  const selectedRoomId = useUIStore((s) => s.selectedRoomId);
  const setSelectedRoomId = useUIStore((s) => s.setSelectedRoomId);

  useEffect(() => {
    void loadDungeon(dungeonId);
  }, [dungeonId, loadDungeon]);

  /*
   * The route and the selection are two views of one fact, and either side may
   * move first: a deep link changes the route, a click on the canvas changes the
   * selection. Whichever actually changed wins, and the pair that has been
   * reconciled is remembered so neither can act on a stale reading of the other.
   *
   * Two independent effects cannot do this. On a deep link they both fire in the
   * same pass: one sets the selection from the route while the other, still
   * closed over the old selection, navigates away from that very route - and the
   * two then chase each other until React gives up with "maximum update depth".
   */
  const syncedRef = useRef<{ route: number | null; selection: number | null }>({
    route: null,
    selection: null,
  });

  useEffect(() => {
    const settled = syncedRef.current;

    if (roomId !== settled.route) {
      syncedRef.current = { route: roomId, selection: roomId };
      if (roomId !== useUIStore.getState().selectedRoomId)
        setSelectedRoomId(roomId);
      return;
    }

    if (selectedRoomId !== settled.selection) {
      syncedRef.current = { route: selectedRoomId, selection: selectedRoomId };
      // Replace rather than push: clicking through eight rooms should not cost
      // eight presses of Back.
      navigate(
        selectedRoomId === null
          ? paths.dungeon(campaignId, dungeonId)
          : paths.room(campaignId, dungeonId, selectedRoomId),
        { replace: true },
      );
    }
  }, [roomId, selectedRoomId, campaignId, dungeonId, setSelectedRoomId]);

  if (isLoading || loadedId !== dungeonId) {
    return (
      <div className="workspace-loading">
        <LoadingSpinner />
      </div>
    );
  }

  if (loadedCampaign !== campaignId)
    return (
      <div className="error-banner" role="alert">
        {error ?? "This dungeon does not belong to the selected campaign."}
        <button onClick={() => void loadDungeon(dungeonId)}>Retry</button>
      </div>
    );

  return (
    <div className="dungeon-view">
      <Toolbar />

      {error !== null && (
        <div className="error-banner">
          <span className="error-banner-text">{error}</span>
          <button
            className="error-banner-dismiss"
            onClick={() => setError(null)}
          >
            &times;
          </button>
        </div>
      )}

      <div className="dungeon-body">
        <div className="canvas-container">
          <DungeonCanvas />
          {dungeon === null && (
            <div className="canvas-empty-state">
              <div className="canvas-empty-title">No Map Yet</div>
              <div className="canvas-empty-subtitle">
                Describe it in the Architect tab, then hit Generate
              </div>
            </div>
          )}
          <DescribeActivityToast />
          <MapLegend />
          <ExportActions />
        </div>

        {dungeon !== null && (
          <aside className="inspector">
            {selectedRoomId === null ? (
              <>
                <LayoutPanel />
                <DungeonPanel />
              </>
            ) : (
              <RoomPanel />
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
