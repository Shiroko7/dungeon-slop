import type { GroundingProvenance } from "../../ai/grounding-types.ts";
import { linkProps, paths } from "../../router/router.ts";

export function GroundingSources({
  grounding,
  label = "Campaign sources",
}: {
  grounding: GroundingProvenance | undefined;
  label?: string;
}) {
  if (grounding === undefined) return null;
  return (
    <details className="layout-grounding">
      <summary>{label} ({grounding.citations.length})</summary>
      <p>Retrieved for “{grounding.query}”. Review the source passages before publishing.</p>
      {grounding.warnings.length > 0 && <p className="layout-notice">{grounding.warnings.join(" ")}</p>}
      {grounding.citations.length > 0 ? (
        <ul>
          {grounding.citations.map((citation) => (
            <li key={`${citation.documentId}-${citation.revision}-${citation.chunkId}`}>
              <a {...linkProps(paths.note(citation.campaignId, citation.documentId, citation.revision, citation.chunkId))}>{citation.filename}</a>
              <span>{citation.headingPath || "Document"}</span>
              <small>{citation.snippet}</small>
            </li>
          ))}
        </ul>
      ) : (
        <span>No supporting passages were found.</span>
      )}
    </details>
  );
}
