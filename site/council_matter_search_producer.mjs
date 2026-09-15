import { exactIdentifierVariants, siteHistoryForParcelIds } from "./search_identifier_support.mjs";
import {
  SEARCH_DOCUMENT_SCHEMA,
  SEARCH_TEXT_MAX_LENGTH,
  admitSearchDocument,
} from "./search_document_contract.mjs";

export const COUNCIL_MATTER_SEARCH_PRODUCER_SCHEMA = "cityscroll.council_matter_search_producer.v1";

const compact = (values, max) => values.map((value) => String(value ?? "").replace(/<[^>]*>/g, " "))
  .join(" ").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** Project retained Council matters without changing their native identity. */
export function buildCouncilMatterSearchDocuments(lookup = {}) {
  const rows = Object.values(lookup?.matters || {});
  const documents = rows.map((row) => {
    const matterId = String(row?.matter_id || "").trim();
    if (!/^\d+$/.test(matterId) || !row?.source_url) return null;
    const identifiers = exactIdentifierVariants([
      row.matter_file, row.join_value, row.project_id, row.resolution_ids,
    ]);
    const title = compact([row.title || row.matter_file || `Council matter ${matterId}`], 500);
    const siteHistory = siteHistoryForParcelIds(row.parcel_ids || row.bbls || []);
    const admitted = admitSearchDocument({
      schema: SEARCH_DOCUMENT_SCHEMA,
      object_ref: `council:matter:${matterId}`,
      object_type: "meeting",
      domain: "meetings",
      canonical_href: `/matters/${encodeURIComponent(matterId)}/`,
      title,
      summary: row.matter_file || null,
      search_text: compact([title, ...identifiers, row.project_id], SEARCH_TEXT_MAX_LENGTH),
      source_family: "retained_council_land_matter_links",
      source_observation_refs: [`legistar:matter:${matterId}`],
      process_role: null,
      classification: { method: "retained_council_matter_identifier", basis: "accepted exact land-matter bridge identifier" },
      provenance: {
        producer: "retained_council_matter_search_document.v1",
        source_url: row.source_url,
        matter_file: row.matter_file || null,
        identifier_values: identifiers,
        ...(siteHistory ? { site_history: siteHistory } : {}),
      },
    });
    return admitted.document ? Object.freeze({ ...admitted.document, outcome: admitted.outcome, coverage_state: "matched" }) : null;
  }).filter(Boolean);
  return Object.freeze({
    schema: COUNCIL_MATTER_SEARCH_PRODUCER_SCHEMA,
    generated_at: lookup.generated_at || null,
    documents: Object.freeze(documents),
    coverage: Object.freeze({ state: documents.length ? "matched" : "empty", total_count: rows.length, indexed_count: documents.length }),
  });
}
