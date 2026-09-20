import { useCallback, useState } from "react";
import { useDungeonStore } from "../../store/dungeon-store.ts";
import { Button } from "../shared/Button.tsx";
import type { RoomRole } from "../../engine/types.ts";
import { roomName } from "../../engine/room-name.ts";

const ROLE_LABELS: Record<string, string> = {
  entrance: "Entrance",
  hub: "Hub",
  gauntlet: "Gauntlet",
  chokepoint: "Chokepoint",
  boss: "Boss",
  vault: "Vault",
  junction: "Junction",
  chamber: "Chamber",
};

function RoleTag({ role }: { role: RoomRole | string }) {
  return <span className={`layout-role layout-role--${role}`}>{ROLE_LABELS[role] ?? role}</span>;
}

function feet(cells: number): string {
  return `${cells * 5} ft`;
}

/**
 * The floor plan behind the map, and the place to argue with it.
 *
 * Everything shown here is structure rather than prose: what each room is for,
 * how deep it sits, what gates it. It is the layer the generator never had, so
 * it is also the layer worth reviewing before any description gets written
 * against it.
 */
export function LayoutPanel() {
  const dungeon = useDungeonStore((s) => s.dungeon);
  const appliedBlueprint = useDungeonStore((s) => s.blueprint);
  const proposedBlueprint = useDungeonStore((s) => s.proposedBlueprint);
  const blueprint = proposedBlueprint ?? appliedBlueprint;
  const problems = useDungeonStore((s) => s.blueprintProblems);
  const refinement = useDungeonStore((s) => s.refinement);
  const isRefining = useDungeonStore((s) => s.isRefining);
  const isGenerating = useDungeonStore((s) => s.isGeneratingDungeon);
  const refineLayout = useDungeonStore((s) => s.refineLayout);
  const acceptRefinement = useDungeonStore((s) => s.acceptRefinement);
  const discardRefinement = useDungeonStore((s) => s.discardRefinement);

  const [instruction, setInstruction] = useState("");
  const [showPlan, setShowPlan] = useState(false);

  const handleRefine = useCallback(() => {
    if (isRefining) return;
    void refineLayout(instruction.trim() === "" ? undefined : instruction.trim());
  }, [isRefining, refineLayout, instruction]);

  const handleAccept = useCallback(() => {
    setInstruction("");
    void acceptRefinement();
  }, [acceptRefinement]);

  if (dungeon === null) return null;

  const report = dungeon.report;
  const editStatus = dungeon.editStatus;
  const planned = dungeon.rooms.filter((r) => r.role !== "junction");
  const byTier = new Map<number, typeof planned>();
  for (const room of planned) {
    const tier = room.tier ?? 0;
    const list = byTier.get(tier);
    if (list === undefined) byTier.set(tier, [room]);
    else list.push(room);
  }

  return (
    <div className="layout-panel">
      <div className="layout-panel-header">
        <h3 className="layout-panel-heading">Layout</h3>
        {blueprint !== null && <span className="layout-badge">{proposedBlueprint ? "proposed" : "planned"}</span>}
      </div>

      {proposedBlueprint !== null && (
        <p className="layout-notice">This floor plan is proposed and unapplied. Generate to create a new version.</p>
      )}

      {editStatus?.narrativeStale && (
        <p className="layout-notice layout-notice--warning">
          Map geometry changed. Review room descriptions, dungeon overview, and the floor plan before publishing.
        </p>
      )}

      {editStatus?.planStale && !editStatus.narrativeStale && (
        <p className="layout-notice layout-notice--warning">
          Connectivity changed. Review the floor plan before publishing.
        </p>
      )}

      {editStatus !== undefined && editStatus.disconnectedRoomIds.length > 0 && (
        <p className="layout-notice layout-notice--warning">
          {editStatus.disconnectedRoomIds.length} room{editStatus.disconnectedRoomIds.length === 1 ? " is" : "s are"} disconnected from the map route.
        </p>
      )}

      {report !== undefined && (
        <dl className="layout-stats">
          <div className="layout-stat">
            <dt>Rooms</dt>
            <dd>
              {report.deliveredRooms}
              {report.deliveredRooms < report.requestedRooms && (
                <span className="layout-stat-warn"> of {report.requestedRooms} asked for</span>
              )}
            </dd>
          </div>
          <div className="layout-stat">
            <dt>Longest corridor</dt>
            <dd>{feet(report.longestCorridorCells)}</dd>
          </div>
          <div className="layout-stat">
            <dt>Junction chambers</dt>
            <dd>{report.junctionsAdded}</dd>
          </div>
          <div className="layout-stat">
            <dt>Route</dt>
            <dd>{report.hasLoop ? "Loops back" : "Dead-ends only"}</dd>
          </div>
        </dl>
      )}

      {report !== undefined && report.deliveredRooms < report.requestedRooms && (
        <p className="layout-notice">
          The grid only had space for {report.capacityRooms} rooms at this room size. Use
          smaller rooms or a bigger grid to get the {report.requestedRooms} requested.
        </p>
      )}

      {problems.length > 0 && (
        <ul className="layout-problems">
          {problems.map((p, i) => (
            <li key={i}>{p.message}</li>
          ))}
        </ul>
      )}

      <button className="layout-disclosure" onClick={() => setShowPlan((v) => !v)}>
        {showPlan ? "Hide floor plan" : `Show floor plan (${planned.length} rooms)`}
      </button>

      {showPlan && (
        <ol className="layout-tiers">
          {[...byTier.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([tier, rooms]) => (
              <li key={tier} className="layout-tier">
                <span className="layout-tier-label">Tier {tier}</span>
                <ul className="layout-tier-rooms">
                  {rooms.map((room) => (
                    <li key={room.id} className="layout-room">
                      <RoleTag role={room.role ?? "chamber"} />
                      <span className="layout-room-name">
                        {roomName(room, room.description)}
                      </span>
                      {room.plan?.wing !== undefined && (
                        <span className="layout-wing">{room.plan.wing}</span>
                      )}
                      {room.plan?.gating !== undefined && room.plan.gating.length > 0 && (
                        <span className="layout-gating" title={room.plan.gating.join("; ")}>
                          gated
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
        </ol>
      )}

      <div className="layout-refine">
        {refinement === null ? (
          <>
            <input
              className="layout-refine-input"
              type="text"
              placeholder="Anything specific to fix? (optional)"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              disabled={isRefining}
            />
            <Button variant="secondary" size="sm" onClick={handleRefine} disabled={isRefining}>
              {isRefining ? "Reviewing the map…" : "Refine layout with AI"}
            </Button>
            <p className="layout-refine-hint">
              Sends the plan and a render of the map for critique. Nothing changes until you
              accept it.
            </p>
          </>
        ) : (
          <div className="layout-review">
            <h4 className="layout-review-heading">
              Proposed changes
              {refinement.imageUsed && <span className="layout-badge">saw the map</span>}
            </h4>

            {refinement.critique !== "" && (
              <p className="layout-critique">{refinement.critique}</p>
            )}

            {refinement.changes.length === 0 ? (
              <p className="layout-review-empty">
                No changes proposed — the critic thinks this layout is sound.
              </p>
            ) : (
              <ul className="layout-changes">
                {refinement.changes.map((change, i) => (
                  <li
                    key={i}
                    className={change.applied ? "layout-change" : "layout-change--refused"}
                  >
                    <span className="layout-change-summary">{change.summary}</span>
                    {change.reason !== null && (
                      <span className="layout-change-reason">{change.reason}</span>
                    )}
                    {!change.applied && change.note !== null && (
                      <span className="layout-change-note">Skipped: {change.note}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}

            <div className="layout-review-actions">
              <Button
                size="sm"
                onClick={handleAccept}
                disabled={isGenerating || refinement.changes.every((c) => !c.applied)}
              >
                {isGenerating ? "Rebuilding…" : "Accept and rebuild"}
              </Button>
              <Button variant="secondary" size="sm" onClick={discardRefinement}>
                Discard
              </Button>
            </div>
            <p className="layout-refine-hint">
              Rebuilding replaces the geometry. Room descriptions already written are kept on
              a copy of this map.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
