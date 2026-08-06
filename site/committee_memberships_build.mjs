import { COMMITTEE_MEMBERSHIP_SOURCE } from "./committee_memberships.mjs";

const clean = (v) => String(v ?? "").trim();

export function buildCommitteeMembershipLookup(sourceRows = [], peopleDoc = {}) {
  const personNames = new Map();
  for (const row of peopleDoc.rows || []) {
    const id = clean(row.person_id).replace(/^official:/, "");
    if (id && clean(row.person_name)) personNames.set(id, clean(row.person_name));
  }
  const by_member_id = {};
  let linked_row_count = 0;
  for (const raw of sourceRows) {
    const id = clean(raw.member_id);
    if (!id || !personNames.has(id)) continue;
    const sourceName = clean(raw.full_name);
    const corpusName = personNames.get(id);
    const row = {
      member_id: id,
      committee: clean(raw.committee),
      committee_id: clean(raw.committee_id),
      appointment_type: clean(raw.appointment_type),
      start_date: clean(raw.start_date).slice(0, 10) || null,
      end_date: clean(raw.end_date).slice(0, 10) || null,
      modified_date: clean(raw.modified_date).slice(0, 10) || null,
      source_row_id: clean(raw.id),
      provenance: {
        source: COMMITTEE_MEMBERSHIP_SOURCE,
        join_key: "member_id",
        source_name: sourceName,
        corpus_name: corpusName,
        name_conflict: Boolean(sourceName && corpusName && sourceName !== corpusName),
      },
    };
    (by_member_id[id] ||= { member_id: id, person_name: corpusName, rows: [] }).rows.push(row);
    linked_row_count += 1;
  }
  const linked_person_count = Object.keys(by_member_id).length;
  return {
    schema_version: 1,
    title: "City Council committee memberships by exact Legistar member ID",
    source_contract: COMMITTEE_MEMBERSHIP_SOURCE,
    generated_at: new Date().toISOString(),
    vintage: "2026-08-05",
    join: { key: "member_id", source: "aabe-yfm9", corpus: "people_domain_observations" },
    eligible_row_count: sourceRows.length,
    linked_row_count,
    row_rate: sourceRows.length ? Number((linked_row_count / sourceRows.length).toFixed(4)) : null,
    eligible_person_count: personNames.size,
    linked_person_count,
    person_rate: personNames.size ? Number((linked_person_count / personNames.size).toFixed(4)) : null,
    gap: linked_person_count < personNames.size ? "Some committed officials have no exact-key membership rows in this source." : null,
    by_member_id,
    provenance: { method: "exact_member_id_join", weak_joins_rendered: false },
  };
}
