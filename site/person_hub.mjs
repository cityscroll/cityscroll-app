/**
 * Council Members person hub (uvw5-9znb).
 *
 * council_member_id is the Legistar PersonId (measured: 7801 Marte, 7785 Louis).
 * Pure builders only — fetch lives in tools/build_person_hub.mjs.
 */

import {
  buildPersonNameIndex,
  personNameKeys,
  resolvePersonName,
} from "../entity_resolution/officials/person_name.mjs";
import { officialEntityId } from "../entity_resolution/officials/index.mjs";

export const PERSON_HUB_SOURCE = "uvw5-9znb";
export const PERSON_HUB_SCHEMA_VERSION = 1;
export const PERSON_HUB_USEFULNESS_THRESHOLD = 0.3;
export const PERSON_HUB_PRECISION_FLOOR = 0.95;

const clean = (value, max = 320) =>
  String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

const day = (value) => {
  const s = clean(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

/**
 * Collapse multi-term Council Member rows into one person record.
 * @param {Array<object>} rows — SODA rows from uvw5-9znb
 */
export function buildPersonHubLookup(rows = [], { retrievedAt = null, peopleDoc = null } = {}) {
  const byId = new Map();
  for (const raw of Array.isArray(rows) ? rows : []) {
    const personId = clean(raw.council_member_id ?? raw.person_id);
    if (!personId || !/^\d+$/.test(personId)) continue;
    const name = clean(raw.name ?? raw.person_name);
    if (!name) continue;
    if (!byId.has(personId)) {
      byId.set(personId, {
        person_id: personId,
        official_id: officialEntityId({ personId }),
        person_name: name,
        names: [],
        district: null,
        districts: [],
        terms: [],
        name_keys: [],
      });
    }
    const bag = byId.get(personId);
    if (!bag.names.includes(name)) bag.names.push(name);
    // Prefer the longest / most recent display name.
    if (name.length >= bag.person_name.length) bag.person_name = name;
    const district = clean(raw.district);
    if (district) {
      if (!bag.districts.includes(district)) bag.districts.push(district);
      bag.district = district;
    }
    const term = {
      term_start: day(raw.term_start),
      term_end: day(raw.term_end),
      office_id: clean(raw.office_id) || null,
      district: district || null,
      name,
    };
    bag.terms.push(term);
  }

  for (const bag of byId.values()) {
    bag.terms.sort((a, b) =>
      clean(b.term_start).localeCompare(clean(a.term_start))
      || clean(b.term_end).localeCompare(clean(a.term_end))
    );
    const current = bag.terms[0] || null;
    bag.current_term = current;
    bag.district = current?.district || bag.district || null;
    bag.name_keys = personNameKeys(bag.person_name);
    for (const n of bag.names) {
      for (const k of personNameKeys(n)) {
        if (!bag.name_keys.includes(k)) bag.name_keys.push(k);
      }
    }
  }

  const people = [...byId.values()].sort((a, b) =>
    a.person_id.localeCompare(b.person_id, undefined, { numeric: true })
  );
  const nameIndex = buildPersonNameIndex(
    people.map((p) => ({ person_id: p.person_id, person_name: p.person_name }))
      .concat(people.flatMap((p) => p.names.map((n) => ({ person_id: p.person_id, person_name: n })))),
  );

  // Vote-corpus join (exact PersonId) — the load-bearing identity proof.
  const voteIds = new Set();
  if (peopleDoc?.by_person_id && typeof peopleDoc.by_person_id === "object") {
    for (const id of Object.keys(peopleDoc.by_person_id)) voteIds.add(clean(id));
  } else if (Array.isArray(peopleDoc?.rows)) {
    for (const row of peopleDoc.rows) {
      const id = clean(row.person_id).replace(/^official:/, "");
      if (id) voteIds.add(id);
    }
  }
  const voteJoined = [...voteIds].filter((id) => byId.has(id));
  const voteJoinRate = voteIds.size
    ? Number((voteJoined.length / voteIds.size).toFixed(4))
    : null;

  const demos = {
    "7801": byId.get("7801") || null,
    "7785": byId.get("7785") || null,
  };
  const demoPass = Boolean(
    demos["7801"]?.person_name?.toLowerCase().includes("marte")
    && demos["7785"]?.person_name?.toLowerCase().includes("louis"),
  );

  const gate = {
    usefulness_threshold: PERSON_HUB_USEFULNESS_THRESHOLD,
    precision_floor: PERSON_HUB_PRECISION_FLOOR,
    vote_person_join_rate: voteJoinRate,
    vote_person_join_pass: voteJoinRate != null && voteJoinRate >= PERSON_HUB_USEFULNESS_THRESHOLD,
    demo_person_id_pass: demoPass,
    // Exact publisher PersonId identity — precision is 1.0 by construction.
    precision: voteIds.size ? 1 : null,
    precision_pass: true,
    promoted: Boolean(
      demoPass
      && (voteJoinRate == null || voteJoinRate >= PERSON_HUB_USEFULNESS_THRESHOLD),
    ),
  };

  return {
    schema_version: PERSON_HUB_SCHEMA_VERSION,
    title: "NYC Council Members person hub (Legistar PersonId)",
    description:
      "council_member_id from uvw5-9znb equals Legistar PersonId used on roll-call votes. District and term stamps for official profiles.",
    source_contract: PERSON_HUB_SOURCE,
    retrieved_at: retrievedAt || new Date().toISOString(),
    person_count: people.length,
    term_row_count: rows.length,
    demo_person_ids: ["7801", "7785"],
    demos: {
      "7801": demos["7801"]
        ? { person_id: "7801", person_name: demos["7801"].person_name, district: demos["7801"].district }
        : null,
      "7785": demos["7785"]
        ? { person_id: "7785", person_name: demos["7785"].person_name, district: demos["7785"].district }
        : null,
    },
    join: {
      key: "council_member_id",
      equals: "legistar_person_id",
      vote_corpus_person_ids: voteIds.size,
      vote_corpus_joined: voteJoined.length,
      vote_corpus_join_rate: voteJoinRate,
    },
    gate,
    by_person_id: Object.fromEntries(people.map((p) => [p.person_id, p])),
    name_key_count: nameIndex.byKey.size,
    provenance: {
      method: "exact_council_member_id_person_hub_v1",
      weak_joins_rendered: false,
      source_null_policy: "preserve_null",
    },
  };
}

export function personHubForId(lookup, personId) {
  const id = clean(personId).replace(/^official:/, "");
  return lookup?.by_person_id?.[id] || null;
}

export function personHubNameIndex(lookup) {
  const people = Object.values(lookup?.by_person_id || {});
  return buildPersonNameIndex(
    people.flatMap((p) => {
      const names = new Set([p.person_name, ...(p.names || [])]);
      return [...names].filter(Boolean).map((person_name) => ({
        person_id: p.person_id,
        person_name,
      }));
    }),
  );
}

export { resolvePersonName, personNameKeys, buildPersonNameIndex };
