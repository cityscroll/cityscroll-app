/**
 * Official influence edges: eLobbyist targets + CFB campaign finance recipients
 * bound to the person hub (uvw5-9znb / Legistar PersonId).
 *
 * Gates (repository flywheel): usefulness ≥ 30% AND reviewed precision ≥ 95%.
 * Only exact unique person-name keys become public edges. Source-null stays null.
 */

import {
  parseLobbyTargets,
  isPersonShapedLobbyTarget,
} from "../entity_resolution/officials/lobby_targets.mjs";
import {
  resolvePersonName,
  personNameKeys,
} from "../entity_resolution/officials/person_name.mjs";
import {
  orgKeyPreferringVendorStem,
  consolidateOrgKeys,
} from "../entity_resolution/officials/org_resolve.mjs";
import { personHubNameIndex } from "./person_hub.mjs";
import { officialEntityId } from "../entity_resolution/officials/index.mjs";

export const LOBBY_SOURCE = "fmf3-knd8";
export const CFB_SOURCE = "rjkp-yttg";
export const INFLUENCE_SCHEMA_VERSION = 1;
export const INFLUENCE_USEFULNESS_THRESHOLD = 0.3;
export const INFLUENCE_PRECISION_FLOOR = 0.95;

const clean = (value, max = 400) =>
  String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

const money = (value) => {
  if (value == null || value === "") return null;
  const n = Number(String(value).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
};

/**
 * Mechanical precision review for exact unique name-key joins.
 *
 * Resolution already required a unique hub key. Review accepts when:
 *  - match_key is one of the hub person's name keys (primary), or
 *  - lobby-stripped target keys share a hub key, or
 *  - CFB/raw target keys share a hub key.
 * Soft similarity never promotes a join.
 */
export function reviewPersonNameJoin({ target_display, hub_name, match_key }) {
  const hubKeys = new Set(personNameKeys(hub_name));
  if (!hubKeys.size) {
    return { label: "reject", reason: "empty_hub_keys" };
  }
  const mk = clean(match_key);
  if (mk && hubKeys.has(mk)) {
    return { label: "same", reason: "unique_hub_match_key" };
  }
  // Lobby free-text often wraps the person name ("NYC Council Members Gale Brewer").
  const stripped = parseLobbyTargets(target_display);
  for (const t of stripped) {
    if (hubKeys.has(t.key)) return { label: "same", reason: "lobby_stripped_key" };
    for (const k of personNameKeys(t.display)) {
      if (hubKeys.has(k)) return { label: "same", reason: "lobby_display_key" };
    }
  }
  for (const k of personNameKeys(target_display)) {
    if (hubKeys.has(k)) return { label: "same", reason: "shared_exact_key" };
  }
  return { label: "reject", reason: "no_shared_key" };
}

/**
 * Measure lobby target → person hub join on a fixed sample.
 * @param {Array<object>} lobbyRows
 * @param {object} personHubLookup
 */
export function measureLobbyTargetJoin(lobbyRows = [], personHubLookup = {}) {
  const index = personHubNameIndex(personHubLookup);
  let personMentions = 0;
  let joined = 0;
  let ambiguous = 0;
  let miss = 0;
  const reviewed = [];
  const byPerson = new Map();

  for (const row of Array.isArray(lobbyRows) ? lobbyRows : []) {
    const targets = parseLobbyTargets(row.lobbyist_targets);
    for (const t of targets) {
      if (!isPersonShapedLobbyTarget(t.display) && !isPersonShapedLobbyTarget(t.key)) {
        // Still try resolve — Council Member lines dominate; agency targets stay miss.
      }
      const personShaped = isPersonShapedLobbyTarget(t.display);
      if (!personShaped) continue;
      personMentions += 1;
      const hit = resolvePersonName(t.display, index)
        || resolvePersonName(t.key, index);
      if (!hit) {
        // Ambiguity: if any personNameKeys map to >1 id
        const keys = personNameKeys(t.display);
        let multi = false;
        for (const k of keys) {
          const ids = index.byKey.get(k);
          if (ids && ids.size > 1) {
            multi = true;
            break;
          }
        }
        if (multi) ambiguous += 1;
        else miss += 1;
        if (reviewed.length < 60) {
          reviewed.push({
            target_key: t.key,
            target_display: t.display,
            client_name: clean(row.client_name),
            report_year: clean(row.report_year),
            label: multi ? "ambiguous" : "miss",
          });
        }
        continue;
      }
      joined += 1;
      const hub = personHubLookup.by_person_id?.[hit.person_id];
      const review = reviewPersonNameJoin({
        target_display: t.display,
        hub_name: hub?.person_name || "",
        match_key: hit.match_key,
      });
      if (reviewed.filter((r) => r.label === "same" || r.label === "reject").length < 40) {
        reviewed.push({
          target_key: t.key,
          target_display: t.display,
          person_id: hit.person_id,
          hub_name: hub?.person_name || null,
          match_key: hit.match_key,
          client_name: clean(row.client_name),
          report_year: clean(row.report_year),
          label: review.label,
          review_reason: review.reason,
        });
      }
      if (!byPerson.has(hit.person_id)) {
        byPerson.set(hit.person_id, { person_id: hit.person_id, mention_count: 0 });
      }
      byPerson.get(hit.person_id).mention_count += 1;
    }
  }

  const same = reviewed.filter((r) => r.label === "same");
  const rejects = reviewed.filter((r) => r.label === "reject");
  const precisionDenom = same.length + rejects.length;
  const precision = precisionDenom
    ? Number((same.length / precisionDenom).toFixed(4))
    : null;
  const usefulness = personMentions
    ? Number((joined / personMentions).toFixed(4))
    : null;

  const gate = {
    usefulness_threshold: INFLUENCE_USEFULNESS_THRESHOLD,
    precision_floor: INFLUENCE_PRECISION_FLOOR,
    usefulness,
    precision,
    usefulness_pass: usefulness != null && usefulness >= INFLUENCE_USEFULNESS_THRESHOLD,
    precision_pass: precision != null && precision >= INFLUENCE_PRECISION_FLOOR,
    promoted: false,
  };
  gate.promoted = Boolean(gate.usefulness_pass && gate.precision_pass);

  return {
    source: LOBBY_SOURCE,
    sample_lobby_rows: lobbyRows.length,
    person_shaped_mentions: personMentions,
    joined_mentions: joined,
    ambiguous_mentions: ambiguous,
    miss_mentions: miss,
    usefulness,
    precision,
    reviewed_sample_size: precisionDenom,
    reviewed,
    distinct_officials_joined: byPerson.size,
    gate,
  };
}

/**
 * Materialize Org → Lobbyist → Official edges when measurement clears gates.
 */
export function buildLobbyInfluenceLookup({
  lobbyRows = [],
  personHubLookup = {},
  measurement = null,
  retrievedAt = null,
  capPerOfficial = 40,
} = {}) {
  const measured = measurement || measureLobbyTargetJoin(lobbyRows, personHubLookup);
  const index = personHubNameIndex(personHubLookup);
  const byPerson = new Map();
  const orgKeys = [];

  if (!measured.gate?.promoted) {
    return {
      schema_version: INFLUENCE_SCHEMA_VERSION,
      title: "eLobbyist official targets (gated)",
      source_contract: LOBBY_SOURCE,
      retrieved_at: retrievedAt || new Date().toISOString(),
      gate: measured.gate,
      measurement: {
        person_shaped_mentions: measured.person_shaped_mentions,
        joined_mentions: measured.joined_mentions,
        usefulness: measured.usefulness,
        precision: measured.precision,
        distinct_officials_joined: measured.distinct_officials_joined,
      },
      by_person_id: {},
      edge_count: 0,
      provenance: {
        method: "exact_unique_person_name_key",
        weak_joins_rendered: false,
        materialization: "stopped_below_gate",
      },
    };
  }

  for (const row of lobbyRows) {
    const client = clean(row.client_name);
    const org = orgKeyPreferringVendorStem(client);
    if (org) orgKeys.push(org);
    const lobbyist = clean(row.lobbyist_name) || null;
    const year = clean(row.report_year) || null;
    const compensation = money(row.compensation_total);
    for (const t of parseLobbyTargets(row.lobbyist_targets)) {
      if (!isPersonShapedLobbyTarget(t.display)) continue;
      const hit = resolvePersonName(t.display, index) || resolvePersonName(t.key, index);
      if (!hit) continue;
      const hub = personHubLookup.by_person_id?.[hit.person_id];
      if (!hub) continue;
      if (!byPerson.has(hit.person_id)) {
        byPerson.set(hit.person_id, {
          person_id: hit.person_id,
          person_name: hub.person_name,
          official_id: officialEntityId({ personId: hit.person_id }),
          edges: [],
          client_keys: new Set(),
        });
      }
      const bag = byPerson.get(hit.person_id);
      const edgeKey = `${org || client}\0${lobbyist || ""}\0${year || ""}`;
      if (bag.client_keys.has(edgeKey)) continue;
      bag.client_keys.add(edgeKey);
      bag.edges.push({
        type: "lobbied_by",
        from_org_key: org || null,
        from_org_display: client || null,
        lobbyist_name: lobbyist,
        target_display: t.display,
        match_key: hit.match_key,
        report_year: year,
        compensation_total: compensation,
        registration_id: clean(row.registration_id) || null,
        provenance: {
          source: LOBBY_SOURCE,
          join_method: hit.method,
          match_key: hit.match_key,
        },
      });
    }
  }

  const { canon, merges } = consolidateOrgKeys(orgKeys);
  let edgeCount = 0;
  const by_person_id = {};
  for (const [id, bag] of byPerson) {
    for (const edge of bag.edges) {
      if (edge.from_org_key && canon.has(edge.from_org_key)) {
        edge.from_org_key = canon.get(edge.from_org_key);
      }
    }
    bag.edges.sort((a, b) =>
      clean(b.report_year).localeCompare(clean(a.report_year))
      || clean(a.from_org_display).localeCompare(clean(b.from_org_display))
    );
    const edges = bag.edges.slice(0, capPerOfficial);
    edgeCount += edges.length;
    by_person_id[id] = {
      person_id: id,
      person_name: bag.person_name,
      official_id: bag.official_id,
      edge_count: bag.edges.length,
      edges,
    };
  }

  return {
    schema_version: INFLUENCE_SCHEMA_VERSION,
    title: "eLobbyist official targets bound to person hub",
    source_contract: LOBBY_SOURCE,
    retrieved_at: retrievedAt || new Date().toISOString(),
    gate: measured.gate,
    measurement: {
      person_shaped_mentions: measured.person_shaped_mentions,
      joined_mentions: measured.joined_mentions,
      usefulness: measured.usefulness,
      precision: measured.precision,
      distinct_officials_joined: measured.distinct_officials_joined,
      org_merges: merges.length,
    },
    by_person_id,
    edge_count: edgeCount,
    person_count: Object.keys(by_person_id).length,
    provenance: {
      method: "exact_unique_person_name_key",
      weak_joins_rendered: false,
      materialization: "public_edges",
      org_er: "org_consolidate_v1",
    },
  };
}

/**
 * Measure CFB recipient → person hub join (unique name keys).
 */
export function measureCfbRecipientJoin(cfbRows = [], personHubLookup = {}) {
  const index = personHubNameIndex(personHubLookup);
  let eligible = 0;
  let joined = 0;
  let ambiguous = 0;
  let miss = 0;
  const reviewed = [];
  const byRecip = new Map();

  for (const row of Array.isArray(cfbRows) ? cfbRows : []) {
    const recipName = clean(row.recipname);
    const candFirst = clean(row.candfirst);
    const label = recipName
      || (candFirst ? `${candFirst}` : "");
    if (!label && !recipName) continue;
    // Prefer "Last, First" when CFB splits fields.
    const display = recipName.includes(",")
      ? recipName
      : (candFirst && recipName ? `${recipName}, ${candFirst}` : recipName || label);
    const recipId = clean(row.recipid);
    if (recipId && byRecip.has(recipId)) continue;
    if (recipId) byRecip.set(recipId, true);
    eligible += 1;
    const hit = resolvePersonName(display, index) || resolvePersonName(recipName, index);
    if (!hit) {
      const keys = personNameKeys(display);
      let multi = false;
      for (const k of keys) {
        const ids = index.byKey.get(k);
        if (ids && ids.size > 1) {
          multi = true;
          break;
        }
      }
      if (multi) ambiguous += 1;
      else miss += 1;
      continue;
    }
    joined += 1;
    const hub = personHubLookup.by_person_id?.[hit.person_id];
    const review = reviewPersonNameJoin({
      target_display: display,
      hub_name: hub?.person_name || "",
      match_key: hit.match_key,
    });
    if (reviewed.length < 40) {
      reviewed.push({
        recipid: recipId || null,
        recipname: display,
        person_id: hit.person_id,
        hub_name: hub?.person_name || null,
        match_key: hit.match_key,
        label: review.label,
        review_reason: review.reason,
      });
    }
  }

  const same = reviewed.filter((r) => r.label === "same");
  const rejects = reviewed.filter((r) => r.label === "reject");
  const precisionDenom = same.length + rejects.length;
  const precision = precisionDenom
    ? Number((same.length / precisionDenom).toFixed(4))
    : null;
  const usefulness = eligible ? Number((joined / eligible).toFixed(4)) : null;
  const gate = {
    usefulness_threshold: INFLUENCE_USEFULNESS_THRESHOLD,
    precision_floor: INFLUENCE_PRECISION_FLOOR,
    usefulness,
    precision,
    usefulness_pass: usefulness != null && usefulness >= INFLUENCE_USEFULNESS_THRESHOLD,
    precision_pass: precision != null && precision >= INFLUENCE_PRECISION_FLOOR,
    promoted: false,
  };
  gate.promoted = Boolean(gate.usefulness_pass && gate.precision_pass);

  return {
    source: CFB_SOURCE,
    sample_rows: cfbRows.length,
    distinct_recipients: eligible,
    joined_recipients: joined,
    ambiguous_recipients: ambiguous,
    miss_recipients: miss,
    usefulness,
    precision,
    reviewed_sample_size: precisionDenom,
    reviewed,
    gate,
  };
}

/**
 * Aggregate CFB contributions to officials (recipient side only).
 * Donor org identity is retained as display + org_key when present; no vendor invent.
 */
export function buildCfbInfluenceLookup({
  cfbRows = [],
  personHubLookup = {},
  measurement = null,
  retrievedAt = null,
  capPerOfficial = 30,
} = {}) {
  const measured = measurement || measureCfbRecipientJoin(cfbRows, personHubLookup);
  const index = personHubNameIndex(personHubLookup);

  if (!measured.gate?.promoted) {
    return {
      schema_version: INFLUENCE_SCHEMA_VERSION,
      title: "Campaign finance recipients (gated)",
      source_contract: CFB_SOURCE,
      retrieved_at: retrievedAt || new Date().toISOString(),
      gate: measured.gate,
      measurement: {
        distinct_recipients: measured.distinct_recipients,
        joined_recipients: measured.joined_recipients,
        usefulness: measured.usefulness,
        precision: measured.precision,
      },
      by_person_id: {},
      edge_count: 0,
      provenance: {
        method: "exact_unique_person_name_key",
        weak_joins_rendered: false,
        materialization: "stopped_below_gate",
      },
    };
  }

  const byPerson = new Map();
  for (const row of cfbRows) {
    const recipName = clean(row.recipname);
    const candFirst = clean(row.candfirst);
    const display = recipName.includes(",")
      ? recipName
      : (candFirst && recipName ? `${recipName}, ${candFirst}` : recipName);
    if (!display) continue;
    const hit = resolvePersonName(display, index) || resolvePersonName(recipName, index);
    if (!hit) continue;
    const hub = personHubLookup.by_person_id?.[hit.person_id];
    if (!hub) continue;
    if (!byPerson.has(hit.person_id)) {
      byPerson.set(hit.person_id, {
        person_id: hit.person_id,
        person_name: hub.person_name,
        official_id: officialEntityId({ personId: hit.person_id }),
        contribution_count: 0,
        contribution_total: 0,
        donors: new Map(),
      });
    }
    const bag = byPerson.get(hit.person_id);
    const amt = money(row.amnt) || 0;
    bag.contribution_count += 1;
    bag.contribution_total += amt;
    const donorName = clean(row.name) || null;
    if (donorName) {
      const dKey = orgKeyPreferringVendorStem(donorName) || donorName.toUpperCase();
      if (!bag.donors.has(dKey)) {
        bag.donors.set(dKey, {
          donor_display: donorName,
          donor_key: dKey,
          amount_total: 0,
          contribution_count: 0,
        });
      }
      const d = bag.donors.get(dKey);
      d.amount_total += amt;
      d.contribution_count += 1;
    }
  }

  let edgeCount = 0;
  const by_person_id = {};
  for (const [id, bag] of byPerson) {
    const donors = [...bag.donors.values()]
      .sort((a, b) => b.amount_total - a.amount_total)
      .slice(0, capPerOfficial)
      .map((d) => ({
        type: "campaign_contribution",
        donor_display: d.donor_display,
        donor_key: d.donor_key,
        amount_total: Number(d.amount_total.toFixed(2)),
        contribution_count: d.contribution_count,
        provenance: { source: CFB_SOURCE, join_method: "exact_unique_person_name_key" },
      }));
    edgeCount += donors.length;
    by_person_id[id] = {
      person_id: id,
      person_name: bag.person_name,
      official_id: bag.official_id,
      contribution_count: bag.contribution_count,
      contribution_total: Number(bag.contribution_total.toFixed(2)),
      donors,
    };
  }

  return {
    schema_version: INFLUENCE_SCHEMA_VERSION,
    title: "Campaign finance recipients bound to person hub",
    source_contract: CFB_SOURCE,
    retrieved_at: retrievedAt || new Date().toISOString(),
    gate: measured.gate,
    measurement: {
      distinct_recipients: measured.distinct_recipients,
      joined_recipients: measured.joined_recipients,
      usefulness: measured.usefulness,
      precision: measured.precision,
    },
    by_person_id,
    edge_count: edgeCount,
    person_count: Object.keys(by_person_id).length,
    provenance: {
      method: "exact_unique_person_name_key",
      weak_joins_rendered: false,
      materialization: "public_edges",
    },
  };
}

export function lobbyEdgesForId(lookup, personId) {
  const id = clean(personId).replace(/^official:/, "");
  const bag = lookup?.by_person_id?.[id];
  return bag && Array.isArray(bag.edges) ? bag.edges : [];
}

export function cfbForId(lookup, personId) {
  const id = clean(personId).replace(/^official:/, "");
  return lookup?.by_person_id?.[id] || null;
}

/** Compact district/term line for official profiles. */
export function renderPersonHubFactsHTML(hubBag, { escapeHtml } = {}) {
  if (!hubBag?.person_id) return "";
  const esc = typeof escapeHtml === "function" ? escapeHtml : (v) => String(v ?? "");
  const parts = [];
  if (hubBag.district) parts.push(`District ${esc(hubBag.district)}`);
  const term = hubBag.current_term;
  if (term?.term_start) {
    const end = term.term_end ? `–${esc(term.term_end)}` : "";
    parts.push(`Term ${esc(term.term_start)}${end}`);
  }
  if (!parts.length) return "";
  return `<p class="official-hub-facts" data-person-hub="linked" lang="en" dir="ltr">${parts.join(" · ")}</p>`;
}

/** Lobby client list for one official — omit empty. */
export function renderLobbyInfluenceHTML(bag, { escapeHtml, translate } = {}) {
  const esc = typeof escapeHtml === "function" ? escapeHtml : (v) => String(v ?? "");
  const edges = Array.isArray(bag?.edges) ? bag.edges : [];
  if (!edges.length) return "";
  const items = edges.slice(0, 12).map((e) => {
    const org = esc(e.from_org_display || e.from_org_key || "—");
    const lob = e.lobbyist_name ? ` · ${esc(e.lobbyist_name)}` : "";
    const yr = e.report_year ? ` · ${esc(e.report_year)}` : "";
    return `<li><strong>${org}</strong>${lob}${yr}</li>`;
  }).join("");
  const more = edges.length > 12
    ? `<p class="note">${edges.length - 12} more recorded filings</p>`
    : "";
  return `<section class="official-lobby-influence" data-lobby-status="linked">
    <div class="chain-h">Lobbying clients (City Clerk eLobbyist)</div>
    <ul>${items}</ul>
    ${more}
  </section>`;
}

/** Campaign finance donor summary — omit empty. */
export function renderCfbInfluenceHTML(bag, { escapeHtml } = {}) {
  const esc = typeof escapeHtml === "function" ? escapeHtml : (v) => String(v ?? "");
  const donors = Array.isArray(bag?.donors) ? bag.donors : [];
  if (!donors.length && !(bag?.contribution_count > 0)) return "";
  const total = bag.contribution_total != null
    ? `$${Number(bag.contribution_total).toLocaleString("en-US", { maximumFractionDigits: 0 })}`
    : null;
  const lead = total
    ? `<p class="ei-lead">${esc(String(bag.contribution_count))} contributions · ${esc(total)} total in sample</p>`
    : "";
  const items = donors.slice(0, 10).map((d) => {
    const amt = d.amount_total != null
      ? `$${Number(d.amount_total).toLocaleString("en-US", { maximumFractionDigits: 0 })}`
      : "—";
    return `<li><strong>${esc(d.donor_display)}</strong> · ${esc(amt)}</li>`;
  }).join("");
  return `<section class="official-cfb-influence" data-cfb-status="linked">
    <div class="chain-h">Campaign contributions (CFB sample)</div>
    ${lead}
    ${items ? `<ul>${items}</ul>` : ""}
  </section>`;
}
