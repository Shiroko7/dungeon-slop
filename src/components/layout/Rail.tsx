import { useUIStore } from "../../store/ui-store.ts";
import { useCampaignStore } from "../../store/campaign-store.ts";
import { linkProps, paths, type Route } from "../../router/router.ts";

interface RailButtonProps {
  href: string;
  label: string;
  glyph: string;
  active: boolean;
}

function RailLink({ href, label, glyph, active }: RailButtonProps) {
  return (
    <a
      className={`rail-btn${active ? " is-active" : ""}`}
      title={label}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      {...linkProps(href)}
    >
      <span className="rail-glyph">{glyph}</span>
    </a>
  );
}

/**
 * The constant column: which campaign, which section, and the two global
 * toggles. Everything else on screen changes with the route; this does not.
 */
export function Rail({ route }: { route: Route }) {
  const active = useCampaignStore((s) => s.active);
  const darkMode = useUIStore((s) => s.darkMode);
  const toggleDarkMode = useUIStore((s) => s.toggleDarkMode);
  const toggleSettings = useUIStore((s) => s.toggleSettings);

  const campaignId = active?.id ?? null;
  const initials = (active?.name ?? "")
    .split(/\s+/)
    .filter((w) => w !== "")
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <nav className="rail" aria-label="Sections">
      <a className="rail-home" title="All campaigns" {...linkProps(paths.picker())}>
        <span className="rail-home-glyph">◈</span>
      </a>

      {campaignId !== null && (
        <>
          <a
            className={`rail-campaign${route.view === "campaign" ? " is-active" : ""}`}
            title={active?.name ?? "Campaign"}
            {...linkProps(paths.campaign(campaignId))}
          >
            {initials === "" ? "—" : initials}
          </a>

          <div className="rail-group">
            <RailLink
              href={paths.campaign(campaignId)}
              label="Dungeons"
              glyph="🗺"
              active={route.view === "campaign" || route.view === "dungeon"}
            />
            <RailLink
              href={paths.campaign(campaignId)}
              label="Chats"
              glyph="💬"
              active={route.view === "chat"}
            />
            <RailLink
              href={paths.notes(campaignId)}
              label="Notes"
              glyph="📓"
              active={route.view === "notes" || route.view === "note"}
            />
            <RailLink
              href={paths.usage(campaignId)}
              label="Spend"
              glyph="📊"
              active={route.view === "usage"}
            />
          </div>
        </>
      )}

      <div className="rail-spacer" />

      <button
        className="rail-btn"
        onClick={toggleDarkMode}
        title={darkMode ? "Switch to light" : "Switch to dark"}
        aria-label="Toggle theme"
      >
        <span className="rail-glyph">{darkMode ? "☀" : "☾"}</span>
      </button>
      <button className="rail-btn" onClick={toggleSettings} title="Settings" aria-label="Settings">
        <span className="rail-glyph">⚙</span>
      </button>
    </nav>
  );
}
