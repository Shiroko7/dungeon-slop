import { useCallback, useEffect, useState } from "react";
import { useCampaignStore } from "../../store/campaign-store.ts";
import { linkProps, navigate, paths } from "../../router/router.ts";
import { Button } from "../shared/Button.tsx";
import { LoadingSpinner } from "../shared/LoadingSpinner.tsx";
import { countLine, useConfirm } from "../shared/ConfirmDialog.tsx";
import type { Campaign } from "../../campaign/types.ts";

function CreateForm({ onDone }: { onDone: () => void }) {
  const createCampaign = useCampaignStore((s) => s.createCampaign);
  const [name, setName] = useState("");
  const [blurb, setBlurb] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    const trimmed = name.trim();
    if (trimmed === "" || busy) return;
    setBusy(true);
    const created = await createCampaign(trimmed, blurb.trim());
    setBusy(false);
    if (created !== null) {
      onDone();
      navigate(paths.campaign(created.id));
    }
  }, [name, blurb, busy, createCampaign, onDone]);

  return (
    <div className="picker-form">
      <input
        className="picker-input"
        value={name}
        autoFocus
        placeholder="Campaign name"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
          if (e.key === "Escape") onDone();
        }}
      />
      <input
        className="picker-input"
        value={blurb}
        placeholder="One line about it (optional)"
        onChange={(e) => setBlurb(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
          if (e.key === "Escape") onDone();
        }}
      />
      <div className="picker-form-actions">
        <Button variant="primary" size="sm" onClick={() => void submit()} disabled={name.trim() === "" || busy}>
          {busy ? "Creating…" : "Create"}
        </Button>
        <Button variant="secondary" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * The root view. Campaigns are independent objects, so this is a real choice
 * rather than a switcher on a single implicit default — there is no campaign
 * until one is made.
 */
export function CampaignPicker() {
  const campaigns = useCampaignStore((s) => s.campaigns);
  const isLoading = useCampaignStore((s) => s.isLoading);
  const error = useCampaignStore((s) => s.error);
  const fetchCampaigns = useCampaignStore((s) => s.fetchCampaigns);
  const deleteCampaign = useCampaignStore((s) => s.deleteCampaign);
  const clearActive = useCampaignStore((s) => s.clearActive);

  const [creating, setCreating] = useState(false);
  const { ask, dialog } = useConfirm();

  useEffect(() => {
    clearActive();
    void fetchCampaigns();
  }, [clearActive, fetchCampaigns]);

  /** Names what is inside, so the prompt is worth reading rather than clicking past. */
  const remove = useCallback(
    async (campaign: Campaign) => {
      const confirmed = await ask({
        title: `Delete "${campaign.name}"?`,
        body: "Everything inside the campaign goes with it.",
        consequences: [
          countLine(campaign.noteCount, "indexed note"),
          countLine(campaign.dungeonCount, "dungeon"),
          countLine(campaign.chatCount, "chat thread"),
        ].filter((line): line is string => line !== null),
        confirmLabel: "Delete campaign",
      });
      if (confirmed) await deleteCampaign(campaign.id);
    },
    [ask, deleteCampaign],
  );

  return (
    <div className="picker">
      <div className="picker-inner">
        <header className="picker-head">
          <h1 className="picker-title">Dungeon Slop</h1>
          <p className="picker-sub">
            A campaign holds its notes, its threads and its maps. Open one, or start another.
          </p>
        </header>

        {error !== null && <div className="picker-error">{error}</div>}

        {isLoading && campaigns.length === 0 && (
          <div className="picker-loading">
            <LoadingSpinner />
          </div>
        )}

        <div className="picker-grid">
          {campaigns.map((c) => (
            <div key={c.id} className="picker-card">
              <a className="picker-card-body" {...linkProps(paths.campaign(c.id))}>
                <span className="picker-card-name">{c.name}</span>
                {c.blurb !== "" && <span className="picker-card-blurb">{c.blurb}</span>}
                <span className="picker-card-stats">
                  {c.noteCount} notes · {c.dungeonCount} dungeons · {c.chatCount} chats
                </span>
              </a>

              <button
                className="picker-card-remove"
                title={`Delete ${c.name}`}
                aria-label={`Delete ${c.name}`}
                onClick={() => void remove(c)}
              >
                &times;
              </button>
            </div>
          ))}

          {creating ? (
            <div className="picker-card picker-card--form">
              <CreateForm onDone={() => setCreating(false)} />
            </div>
          ) : (
            <button className="picker-card picker-card--new" onClick={() => setCreating(true)}>
              <span className="picker-new-plus">+</span>
              <span className="picker-new-label">New campaign</span>
            </button>
          )}
        </div>

        {!isLoading && campaigns.length === 0 && !creating && (
          <p className="picker-empty">
            Nothing here yet. A campaign is the container for everything else — make one to start.
          </p>
        )}
      </div>
      {dialog}
    </div>
  );
}
