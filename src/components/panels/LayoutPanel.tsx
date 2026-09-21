import { useCallback, useState } from "react";
import { useDungeonStore } from "../../store/dungeon-store.ts";
import { Button } from "../shared/Button.tsx";
import type { RoomRole } from "../../engine/types.ts";
import type { BlueprintEdge, BlueprintNode } from "../../ai/blueprint.ts";
import { roomName } from "../../engine/room-name.ts";
import { linkProps, paths } from "../../router/router.ts";

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
  const editBlueprint = useDungeonStore((s) => s.editBlueprint);

  const [instruction, setInstruction] = useState("");
  const [showPlan, setShowPlan] = useState(false);
  const [editPlan, setEditPlan] = useState(false);
  const [connectFrom, setConnectFrom] = useState("");
  const [connectTo, setConnectTo] = useState("");

  const updateNode = useCallback((key: string, patch: Partial<BlueprintNode>) => {
    editBlueprint((plan) => ({
      ...plan,
      nodes: plan.nodes.map((node) => node.key === key ? { ...node, ...patch } : node),
    }));
  }, [editBlueprint]);

  const updateEdge = useCallback((index: number, patch: Partial<BlueprintEdge>) => {
    editBlueprint((plan) => ({
      ...plan,
      edges: plan.edges.map((edge, edgeIndex) => edgeIndex === index ? { ...edge, ...patch } : edge),
    }));
  }, [editBlueprint]);

  const addConnection = useCallback(() => {
    if (connectFrom === "" || connectTo === "" || connectFrom === connectTo || blueprint === null) return;
    if (blueprint.edges.some((edge) =>
      (edge.from === connectFrom && edge.to === connectTo) ||
      (edge.from === connectTo && edge.to === connectFrom))) return;
    editBlueprint((plan) => ({
      ...plan,
      edges: [...plan.edges, { from: connectFrom, to: connectTo }],
    }));
    setConnectFrom("");
    setConnectTo("");
  }, [blueprint, connectFrom, connectTo, editBlueprint]);

  const removeConnection = useCallback((index: number) => {
    if (blueprint?.edges[index]?.locked) return;
    editBlueprint((plan) => ({ ...plan, edges: plan.edges.filter((_, edgeIndex) => edgeIndex !== index) }));
  }, [blueprint, editBlueprint]);

  const handleRefine = useCallback(() => {
    if (isRefining) return;
    void refineLayout(instruction.trim() === "" ? undefined : instruction.trim());
  }, [isRefining, refineLayout, instruction]);

  const handleAccept = useCallback(() => {
    setInstruction("");
    void acceptRefinement();
  }, [acceptRefinement]);

  if (dungeon === null && blueprint === null) return null;

  const report = dungeon?.report;
  const editStatus = dungeon?.editStatus;
  const planned = dungeon?.rooms.filter((r) => r.role !== "junction") ?? [];
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

      {report?.constraints !== undefined && (
        <div className="layout-constraints">
          <strong>Constraint check</strong>
          <span>
            {report.constraints.deliveredConnections}/{report.constraints.requestedConnections} planned connections delivered;
            {report.constraints.deliveredEntrances}/{report.constraints.requestedEntrances} entrances delivered.
          </span>
          <span>
            {report.constraints.reachableRooms}/{report.requestedRooms} planned rooms reachable.
          </span>
          {report.constraints.unmetConnections.length > 0 && (
            <span className="layout-stat-warn">
              Unmet connections: {report.constraints.unmetConnections.map((edge) => `${edge.from} → ${edge.to}`).join(", ")}
            </span>
          )}
          {report.constraints.unreachableRooms.length > 0 && (
            <span className="layout-stat-warn">
              Unreachable rooms: {report.constraints.unreachableRooms.join(", ")}
            </span>
          )}
          {report.constraints.unmetRequirements.length > 0 && (
            <details>
              <summary>Advisory requirements ({report.constraints.unmetRequirements.length})</summary>
              <ul>{report.constraints.unmetRequirements.map((item, index) => <li key={index}>{item}</li>)}</ul>
            </details>
          )}
        </div>
      )}

      {blueprint?.grounding !== undefined && (
        <details className="layout-grounding">
          <summary>Campaign sources ({blueprint.grounding.citations.length})</summary>
          <p>Retrieved for “{blueprint.grounding.query}”. Refresh is explicit; this plan is not silently rewritten when notes change.</p>
          {blueprint.grounding.warnings.length > 0 && <p className="layout-notice">{blueprint.grounding.warnings.join(" ")}</p>}
          <ul>
            {blueprint.grounding.citations.map((citation) => (
              <li key={`${citation.documentId}-${citation.revision}-${citation.chunkId}`}>
                <a {...linkProps(paths.note(citation.campaignId, citation.documentId, citation.revision, citation.chunkId))}>{citation.filename}</a>
                <span>{citation.headingPath || "Document"}</span>
                <small>{citation.snippet}</small>
              </li>
            ))}
          </ul>
        </details>
      )}

      {blueprint !== null && (
        <div className="layout-plan-editor">
          <button className="layout-disclosure" onClick={() => setEditPlan((value) => !value)}>
            {editPlan ? "Close plan editor" : "Edit room and connection plan"}
          </button>
          {editPlan && (
            <div className="layout-plan-editor-body">
              <p className="layout-refine-hint">
                Room keys are stable identities. Lock a room or connection to make it a
                requirement that AI refinement cannot change. Edits stay proposed until Generate.
              </p>
              <ul className="layout-plan-nodes">
                {blueprint.nodes.map((node) => (
                  <li key={node.key} className="layout-plan-node">
                    <code>{node.key}</code>
                    <input
                      type="text"
                      aria-label={`Name for ${node.key}`}
                      value={node.name}
                      disabled={node.locked === true}
                      onChange={(event) => updateNode(node.key, { name: event.target.value })}
                    />
                    <select
                      aria-label={`Role for ${node.key}`}
                      value={node.role}
                      disabled={node.locked === true}
                      onChange={(event) => updateNode(node.key, { role: event.target.value as BlueprintNode["role"] })}
                    >
                      {(["entrance", "hub", "gauntlet", "chokepoint", "boss", "vault", "chamber"] as const).map((role) => (
                        <option key={role} value={role}>{role}</option>
                      ))}
                    </select>
                    <label className="layout-plan-lock">
                      <input
                        type="checkbox"
                        checked={node.locked === true}
                        onChange={(event) => updateNode(node.key, { locked: event.target.checked })}
                      />
                      lock
                    </label>
                  </li>
                ))}
              </ul>
              <div className="layout-plan-connections">
                <strong>Connections</strong>
                <ul>
                  {blueprint.edges.map((edge, index) => (
                    <li key={`${edge.from}-${edge.to}-${index}`}>
                      <span>{edge.from} → {edge.to}</span>
                      <input
                        aria-label={`Gate for ${edge.from} to ${edge.to}`}
                        placeholder="gate (optional)"
                        value={edge.gating ?? ""}
                        disabled={edge.locked === true}
                        onChange={(event) => updateEdge(index, event.target.value.trim() === "" ? { gating: undefined } : { gating: event.target.value })}
                      />
                      <input
                        aria-label={`Door for ${edge.from} to ${edge.to}`}
                        placeholder="door (optional)"
                        value={edge.door ?? ""}
                        disabled={edge.locked === true}
                        onChange={(event) => updateEdge(index, event.target.value.trim() === "" ? { door: undefined } : { door: event.target.value })}
                      />
                      <label className="layout-plan-lock">
                        <input
                          type="checkbox"
                          checked={edge.locked === true}
                          onChange={(event) => updateEdge(index, { locked: event.target.checked })}
                        />
                        lock
                      </label>
                      <button type="button" className="layout-plan-remove" disabled={edge.locked === true} onClick={() => removeConnection(index)}>
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="layout-plan-add-connection">
                  <select aria-label="Connection source" value={connectFrom} onChange={(event) => setConnectFrom(event.target.value)}>
                    <option value="">From room…</option>
                    {blueprint.nodes.map((node) => <option key={node.key} value={node.key}>{node.name}</option>)}
                  </select>
                  <select aria-label="Connection destination" value={connectTo} onChange={(event) => setConnectTo(event.target.value)}>
                    <option value="">To room…</option>
                    {blueprint.nodes.map((node) => <option key={node.key} value={node.key}>{node.name}</option>)}
                  </select>
                  <Button variant="secondary" size="sm" onClick={addConnection} disabled={connectFrom === "" || connectTo === "" || connectFrom === connectTo}>
                    Add connection
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {problems.length > 0 && (
        <ul className="layout-problems">
          {problems.map((p, i) => (
            <li key={i}>{p.message}</li>
          ))}
        </ul>
      )}

      {dungeon !== null && (
        <button className="layout-disclosure" onClick={() => setShowPlan((v) => !v)}>
          {showPlan ? "Hide floor plan" : `Show floor plan (${planned.length} rooms)`}
        </button>
      )}

      {dungeon !== null && showPlan && (
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
                      {room.plan?.doorPreferences !== undefined && room.plan.doorPreferences.length > 0 && (
                        <span className="layout-gating" title={room.plan.doorPreferences.join("; ")}>
                          door preference
                        </span>
                      )}
                      {room.plan?.locked === true && <span className="layout-gating">locked</span>}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
        </ol>
      )}

      {dungeon !== null && <div className="layout-refine">
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
      </div>}
    </div>
  );
}
