/**
 * Property domain explorer — list ontology over disposition process stages.
 *
 * Groups multi-notice disposition spines into one list entry, filters by
 * process stage (hearing → auction_or_rfp → award_or_conveyance), and stamps
 * next-action keys for feed cards. Pure: no DOM, no fetch.
 *
 * Temporal list filters (proposed/soon/upcoming/past) stay in site/index.html
 * (propStage / PROP_STAGES) — they are date-window chips, not process stages.
 */

import {
  PROPERTY_DISPOSITION_PHASES,
  PROPERTY_PHASE_META,
  dispositionStageToPhase,
} from "./property_phase_spine.mjs";
import {
  civicTodayIso,
  commercialCloseDate,
  commercialMatchesFilters,
  commercialPriceAmount,
  isCloseDatePast,
  normalizePropertySort,
} from "./property_commercial.mjs";

export const PROPERTY_EXPLORER_SCHEMA_VERSION = 1;

/** Process-stage filter chips for the Property domain rail (ops ontology). */
export const PROP_PROCESS_STAGES = Object.freeze([
  ["all", "stage_all"],
  ["hearing", "disposition_stage_hearing"],
  ["auction_or_rfp", "disposition_stage_auction_or_rfp"],
  ["award_or_conveyance", "disposition_stage_award_or_conveyance"],
  ["unstaged", "disposition_stage_unstaged"],
]);

const PROCESS_ORDER = new Map(
  PROPERTY_DISPOSITION_PHASES.map((id, i) => [id, i]),
);

function clean(value) {
  if (value == null) return null;
  const s = String(value).replace(/\s+/g, " ").trim();
  return s || null;
}

function isoDate(value) {
  if (!value) return null;
  const s = String(value);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Process stage for a notice row (from materialization; null → unstaged).
 * @param {object} row
 * @returns {string|null}
 */
export function propertyProcessStage(row) {
  return dispositionStageToPhase(row?.disposition_stage) || null;
}

/**
 * Filter key for process rail counts (includes "unstaged").
 * @param {object} row
 */
export function propertyProcessFilterKey(row) {
  return propertyProcessStage(row) || "unstaged";
}

/**
 * Action i18n key for a process stage (next-action affordance on list cards).
 * @param {string|null} stage
 */
export function propertyProcessActionKey(stage) {
  const id = dispositionStageToPhase(stage);
  if (!id) return "property_action_open_notice";
  return PROPERTY_PHASE_META[id]?.action_key || "property_action_open_notice";
}

/**
 * Primary BBL from a property_location bag when present.
 * @param {object|null} location
 */
export function primaryBblFromLocation(location) {
  if (!location || typeof location !== "object") return null;
  const bbls = Array.isArray(location.bbls) ? location.bbls : [];
  for (const b of bbls) {
    const s = String(b || "").replace(/\D/g, "");
    if (/^\d{10}$/.test(s)) return s;
  }
  const lots = Array.isArray(location.tax_lots) ? location.tax_lots : [];
  for (const lot of lots) {
    if (lot && lot.bbl && /^\d{10}$/.test(String(lot.bbl))) return String(lot.bbl);
  }
  const addrs = Array.isArray(location.addresses) ? location.addresses : [];
  for (const a of addrs) {
    if (a && a.bbl && /^\d{10}$/.test(String(a.bbl))) return String(a.bbl);
  }
  return null;
}

/**
 * Index disposition spines by subject_ref and by member request_id.
 * @param {object[]} spines
 */
export function indexDispositionSpines(spines) {
  const bySubject = new Map();
  const byRequestId = new Map();
  for (const spine of spines || []) {
    if (!spine || typeof spine !== "object") continue;
    const subject = clean(spine.subject_ref);
    if (subject) bySubject.set(subject, spine);
    const stages = Array.isArray(spine.stages) ? spine.stages : [];
    for (const stage of stages) {
      for (const id of stage?.request_ids || []) {
        if (id) byRequestId.set(String(id), spine);
      }
    }
    for (const event of spine.events || []) {
      if (event?.request_id) byRequestId.set(String(event.request_id), spine);
    }
  }
  return { bySubject, byRequestId };
}

/**
 * Latest process stage present on a multi-notice spine (last matched in order).
 * @param {object} spine
 */
export function spineCurrentProcessStage(spine) {
  if (!spine || !Array.isArray(spine.stages)) return null;
  let best = null;
  let bestOrder = -1;
  for (const stage of spine.stages) {
    if (!stage?.matched) continue;
    const id = dispositionStageToPhase(stage.kind);
    if (!id) continue;
    const order = PROCESS_ORDER.has(id) ? PROCESS_ORDER.get(id) : -1;
    if (order >= bestOrder) {
      bestOrder = order;
      best = id;
    }
  }
  return best;
}

function sortNoticesNewestFirst(rows) {
  return [...rows].sort((a, b) => {
    const da = isoDate(a?.start_date) || isoDate(a?.event_date) || "";
    const db = isoDate(b?.start_date) || isoDate(b?.event_date) || "";
    return String(db).localeCompare(String(da));
  });
}

/**
 * Build list entries for the Property explorer.
 * Multi-notice disposition subjects collapse to one entry (primary = newest notice);
 * singleton / unjoined notices remain individual cards.
 *
 * @param {object[]} properties — /property-locations properties rows
 * @param {object[]} spines — disposition_spines from the same payload
 * @returns {object[]}
 */
export function buildPropertyExplorerEntries(properties, spines) {
  const rows = Array.isArray(properties) ? properties.filter(Boolean) : [];
  const { bySubject, byRequestId } = indexDispositionSpines(spines);

  // subject_ref → notices in current window
  const membersBySubject = new Map();
  for (const row of rows) {
    const subject =
      clean(row.disposition_subject_ref)
      || (byRequestId.get(String(row.request_id || ""))?.subject_ref || null);
    if (!subject) continue;
    if (!membersBySubject.has(subject)) membersBySubject.set(subject, []);
    membersBySubject.get(subject).push(row);
  }

  // Multi-notice only when spine join says so, or ≥2 notices share the subject in-window.
  const multiSubjects = new Set();
  for (const [subject, members] of membersBySubject) {
    const spine = bySubject.get(subject);
    const joinCount = spine?.join?.notice_count || 0;
    if (joinCount > 1 || members.length > 1) multiSubjects.add(subject);
  }

  const emittedSubjects = new Set();
  const entries = [];

  for (const row of rows) {
    const subject =
      clean(row.disposition_subject_ref)
      || (byRequestId.get(String(row.request_id || ""))?.subject_ref || null);
    const spine = subject ? bySubject.get(subject) : byRequestId.get(String(row.request_id || ""));

    if (subject && multiSubjects.has(subject)) {
      if (emittedSubjects.has(subject)) continue;
      emittedSubjects.add(subject);
      const members = sortNoticesNewestFirst(membersBySubject.get(subject) || [row]);
      const primary = members[0] || row;
      const processStage =
        spineCurrentProcessStage(spine) || propertyProcessStage(primary) || null;
      const bbl =
        primaryBblFromLocation(primary.property_location || primary._location)
        || (Array.isArray(spine?.join?.keys)
          ? (spine.join.keys.find((k) => String(k).startsWith("bbl:")) || "").replace(/^bbl:/, "") || null
          : null);
      entries.push({
        kind: "disposition",
        schema_version: PROPERTY_EXPLORER_SCHEMA_VERSION,
        subject_ref: subject,
        primary,
        members,
        notice_count: members.length,
        spine: spine || null,
        process_stage: processStage,
        process_filter: processStage || "unstaged",
        action_key: propertyProcessActionKey(processStage),
        bbl: bbl && /^\d{10}$/.test(String(bbl)) ? String(bbl) : null,
        join_method: spine?.join?.method || null,
        matched_phases: (spine?.stages || [])
          .filter((s) => s?.matched)
          .map((s) => s.kind)
          .filter(Boolean),
      });
      continue;
    }

    // Singleton notice card
    const processStage = propertyProcessStage(row);
    const bbl = primaryBblFromLocation(row.property_location || row._location);
    entries.push({
      kind: "notice",
      schema_version: PROPERTY_EXPLORER_SCHEMA_VERSION,
      subject_ref: subject || (row.request_id ? `notice:${row.request_id}` : null),
      primary: row,
      members: [row],
      notice_count: 1,
      spine: spine || null,
      process_stage: processStage,
      process_filter: processStage || "unstaged",
      action_key: propertyProcessActionKey(processStage),
      bbl: bbl && /^\d{10}$/.test(String(bbl)) ? String(bbl) : null,
      join_method: spine?.join?.method || "single_notice",
      matched_phases: processStage ? [processStage] : [],
    });
  }

  return entries;
}

/**
 * Filter explorer entries by process stage, asset type, commercial fields, and temporal key.
 * Temporal classifier is injected so this module stays free of DOM date helpers.
 * Commercial filter matching is pure (commercialMatchesFilters) — non-sales drop out
 * of commercial-filtered views but remain on the unfiltered general list.
 *
 * @param {object[]} entries
 * @param {object} opts
 * @param {string} [opts.process="all"]
 * @param {string} [opts.asset="all"]
 * @param {string} [opts.saleMethod="all"]
 * @param {string} [opts.priceBand="all"]
 * @param {string} [opts.temporal="all"]
 * @param {(row: object) => string|null} [opts.temporalOf]
 * @param {(row: object) => string|null} [opts.assetOf]
 * @param {(row: object) => object|null} [opts.commercialOf]
 * @param {string|null} [opts.borough]
 * @param {string|null} [opts.neighborhood]
 */
export function filterPropertyExplorerEntries(entries, opts = {}) {
  const process = opts.process || "all";
  const asset = opts.asset || "all";
  const saleMethod = opts.saleMethod || "all";
  const priceBand = opts.priceBand || "all";
  const temporal = opts.temporal || "all";
  const temporalOf = typeof opts.temporalOf === "function" ? opts.temporalOf : null;
  const assetOf = typeof opts.assetOf === "function" ? opts.assetOf : null;
  const commercialOf = typeof opts.commercialOf === "function"
    ? opts.commercialOf
    : (row) => row?.commercial || null;
  const borough = clean(opts.borough);
  const neighborhood = clean(opts.neighborhood)?.toLowerCase() || null;
  const commercialActive = asset !== "all" || saleMethod !== "all" || priceBand !== "all";

  return (entries || []).filter((entry) => {
    if (!entry || !entry.primary) return false;
    if (process !== "all") {
      // Match current process stage OR any member notice still tagged with that stage
      // so multi-notice chains remain findable under earlier phases.
      if (process === "unstaged") {
        if (entry.process_filter !== "unstaged") return false;
      } else {
        const memberHit = (entry.members || [entry.primary]).some(
          (m) => propertyProcessStage(m) === process,
        );
        if (!memberHit && entry.process_filter !== process) return false;
      }
    }

    if (asset !== "all" && assetOf) {
      // Keep disposition group if any member matches asset bucket.
      const hit = (entry.members || [entry.primary]).some((m) => assetOf(m) === asset);
      if (!hit) return false;
    }

    // Commercial organize filters (method / price / sale gate when any commercial filter on).
    if (commercialActive) {
      const hit = (entry.members || [entry.primary]).some((m) => {
        const commercial = commercialOf(m);
        // Asset already gated above via assetOf; re-check sale_method/price/sale_eligible.
        return commercialMatchesFilters(commercial, {
          asset: "all", // already applied
          saleMethod,
          priceBand,
          commercialOnly: true,
        });
      });
      if (!hit) return false;
    }

    if (temporal !== "all" && temporalOf) {
      const hit = (entry.members || [entry.primary]).some((m) => temporalOf(m) === temporal);
      if (!hit) return false;
    }

    if (borough) {
      const locs = (entry.members || [entry.primary]).map(
        (m) => m._location || m.property_location || null,
      );
      const hit = locs.some((loc) => (loc?.boroughs || []).includes(borough));
      if (!hit) return false;
    }

    if (neighborhood) {
      const hit = (entry.members || [entry.primary]).some((m) => {
        const loc = m._location || m.property_location || {};
        const bag = [
          ...(loc.neighborhoods || []),
          ...(loc.addresses || []).map((a) => a?.label),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return bag.includes(neighborhood);
      });
      if (!hit) return false;
    }

    return true;
  });
}

/**
 * Close ISO day for an explorer entry (or null).
 * @param {object} entry
 * @param {(row: object) => object|null} getCommercial
 */
export function entryCloseDate(entry, getCommercial) {
  const row = entry?.primary;
  return commercialCloseDate(row, typeof getCommercial === "function" ? getCommercial(row) : row?.commercial);
}

/**
 * Stamp open/closed temporal status + honesty action key on explorer entries.
 * Closed = published close/event day strictly before today. No live bid/attend
 * action on a decade-closed sale.
 *
 * @param {object[]} entries
 * @param {{
 *   today?: string|Date,
 *   commercialOf?: (row: object) => object|null,
 * }} [opts]
 * @returns {object[]}
 */
export function stampPropertyExplorerTemporal(entries, opts = {}) {
  const today = opts.today instanceof Date || typeof opts.today === "number"
    ? civicTodayIso(opts.today)
    : (opts.today ? String(opts.today).slice(0, 10) : civicTodayIso());
  const getCommercial = typeof opts.commercialOf === "function"
    ? opts.commercialOf
    : (row) => row?.commercial || null;
  return (Array.isArray(entries) ? entries : []).map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    const close = entryCloseDate(entry, getCommercial);
    const closed = isCloseDatePast(close, today);
    const openAction = entry.action_key && entry.action_key !== "property_action_closed"
      ? entry.action_key
      : propertyProcessActionKey(entry.process_stage);
    return {
      ...entry,
      close_date: close,
      temporal_status: closed ? "closed" : (close ? "open" : "undated"),
      // Honesty: closed sales never keep a live bid/attend CTA.
      action_key: closed ? "property_action_closed" : openAction,
    };
  });
}

/**
 * Sort explorer entries for commercial scan (closing soon / price / newest).
 * Default `closing_soon`: upcoming/open closes first (soonest first), undated
 * next, past-dated closed sales last (most recently closed first) — never the
 * front page of the default Property list.
 *
 * @param {object[]} entries
 * @param {string} [sort="closing_soon"]
 * @param {(row: object) => object|null} [commercialOf]
 * @param {{ today?: string|Date }} [opts]
 */
export function sortPropertyExplorerEntries(entries, sort = "closing_soon", commercialOf, opts = {}) {
  const key = normalizePropertySort(sort);
  const getCommercial = typeof commercialOf === "function"
    ? commercialOf
    : (row) => row?.commercial || null;
  const today = opts.today instanceof Date || typeof opts.today === "number"
    ? civicTodayIso(opts.today)
    : (opts.today ? String(opts.today).slice(0, 10) : civicTodayIso());
  const list = Array.isArray(entries) ? [...entries] : [];

  const closeDay = (entry) => {
    const row = entry?.primary;
    return commercialCloseDate(row, getCommercial(row));
  };
  const closeKey = (entry) => closeDay(entry) || "9999-12-31";
  const closedRank = (entry) => {
    // Prefer stamped temporal_status; fall back to date compare.
    if (entry?.temporal_status === "closed") return 2;
    if (entry?.temporal_status === "undated") return 1;
    if (entry?.temporal_status === "open") return 0;
    const day = closeDay(entry);
    if (!day) return 1;
    return isCloseDatePast(day, today) ? 2 : 0;
  };
  const priceKey = (entry) => {
    const amount = commercialPriceAmount(getCommercial(entry?.primary));
    return amount == null ? null : amount;
  };
  const postedKey = (entry) => {
    const s = String(entry?.primary?.start_date || "");
    const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : "0000-01-01";
  };

  list.sort((a, b) => {
    if (key === "newest") {
      // Even on newest, keep closed sales after open ones when mixed (default all).
      const cr = closedRank(a) - closedRank(b);
      if (cr !== 0) return cr;
      return postedKey(b).localeCompare(postedKey(a));
    }
    if (key === "price_desc" || key === "price_asc") {
      const cr = closedRank(a) - closedRank(b);
      if (cr !== 0) return cr;
      const pa = priceKey(a);
      const pb = priceKey(b);
      // Unpriced sink to the end for both directions.
      if (pa == null && pb == null) return closeKey(a).localeCompare(closeKey(b));
      if (pa == null) return 1;
      if (pb == null) return -1;
      return key === "price_desc" ? pb - pa : pa - pb;
    }
    // closing_soon (default): open soonest → undated → closed (most recent first).
    const cr = closedRank(a) - closedRank(b);
    if (cr !== 0) return cr;
    if (closedRank(a) === 2) {
      // Closed bucket: reverse chrono (2014 before 2013 in the archive, not front page).
      return closeKey(b).localeCompare(closeKey(a));
    }
    return closeKey(a).localeCompare(closeKey(b));
  });
  return list;
}

/**
 * Count process-filter keys across entries (for chip badges).
 * @param {object[]} entries
 */
export function countPropertyProcessStages(entries) {
  const counts = { all: 0 };
  for (const [key] of PROP_PROCESS_STAGES) {
    if (key !== "all") counts[key] = 0;
  }
  for (const entry of entries || []) {
    counts.all += 1;
    const k = entry.process_filter || "unstaged";
    counts[k] = (counts[k] || 0) + 1;
  }
  return counts;
}

/**
 * Normalize a notice title to a grouping stem: lowercase, drop digits and
 * punctuation, collapse whitespace. So "PROPERTY CLERK INVOICE 1234 — PENDING
 * DESTRUCTION" and "…INVOICE 5678…" share a stem — the small-multiples signal.
 * @param {string} value
 */
function titleStem(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[0-9]+/g, " ")
    .replace(/[^a-z ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Default cluster signature for property entries (agency + asset + stage + title stem). */
function defaultEntrySignature(entry) {
  const row = entry && entry.primary;
  if (!row) return null;
  const stem = titleStem(row.short_title);
  if (!stem) return null;
  const agency = clean(row.agency_name) || "";
  const asset = clean(row._asset) || "";
  const stage = clean(entry.process_filter) || "unstaged";
  return `${agency}${asset}${stage}${stem}`;
}

function buildClusterEntry(signature, members) {
  const dates = members
    .map((m) => m.close_date || (m.primary && (m.primary.event_date || m.primary.start_date)) || null)
    .map((d) => (d ? String(d).slice(0, 10) : null))
    .filter(Boolean)
    .sort();
  const allClosed = members.every((m) => m.temporal_status === "closed");
  const anyOpen = members.some((m) => m.temporal_status === "open");
  const rep = members[0] || {};
  return {
    kind: "cluster",
    count: members.length,
    members,
    primary: rep.primary || null,
    signature,
    process_stage: rep.process_stage || null,
    process_filter: rep.process_filter || "unstaged",
    date_range: dates.length ? { start: dates[0], end: dates[dates.length - 1] } : null,
    temporal_status: allClosed ? "closed" : (anyOpen ? "open" : (rep.temporal_status || "undated")),
    close_date: rep.close_date || null,
  };
}

/**
 * Collapse runs of near-identical single-notice entries into one "cluster" entry —
 * Tufte small multiples: one frame, the varying datum is the date. Only single-notice
 * entries are eligible (multi-notice spines are already collapsed). A cluster forms when
 * >= minCount entries share a signature; it takes the list position of its earliest
 * member, and the rest are absorbed (expandable in the UI). Lens-neutral: pass
 * `opts.signatureOf` to reuse the collapse for another lens.
 *
 * @param {object[]} entries — already stamped + sorted explorer entries
 * @param {{minCount?: number, signatureOf?: (e: object) => string|null}} [opts]
 * @returns {object[]} entries with clusters spliced in (order preserved)
 */
export function clusterRepeatedEntries(entries, opts = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const minCount = Number.isFinite(opts.minCount) ? opts.minCount : 3;
  const signatureOf = typeof opts.signatureOf === "function" ? opts.signatureOf : defaultEntrySignature;
  const eligible = (e) => e && e.kind === "notice" && (e.notice_count || 1) === 1;
  const bySig = new Map();
  list.forEach((entry, index) => {
    if (!eligible(entry)) return;
    const sig = signatureOf(entry);
    if (!sig) return;
    if (!bySig.has(sig)) bySig.set(sig, []);
    bySig.get(sig).push(index);
  });
  const clusterAt = new Map();
  const absorbed = new Set();
  for (const [sig, indices] of bySig) {
    if (indices.length < minCount) continue;
    indices.forEach((i) => absorbed.add(i));
    clusterAt.set(indices[0], buildClusterEntry(sig, indices.map((i) => list[i])));
  }
  if (!clusterAt.size) return list;
  const out = [];
  list.forEach((entry, index) => {
    if (clusterAt.has(index)) { out.push(clusterAt.get(index)); return; }
    if (absorbed.has(index)) return;
    out.push(entry);
  });
  return out;
}

/**
 * Parcel lookup URLs for a 10-digit BBL (entity-link affordances on list cards).
 * Reuses site/property_location.mjs so ZoLa / ACRIS / Who Owns What stay one owner.
 * @param {string} bbl
 * @param {(bbl: string) => object|null} [linksFromBbl] — inject parcelLinksFromBbl in tests
 */
export function parcelLookupUrls(bbl, linksFromBbl) {
  const id = String(bbl || "").replace(/\D/g, "");
  if (!/^\d{10}$/.test(id)) return null;
  if (typeof linksFromBbl === "function") {
    const links = linksFromBbl(id);
    return links ? { bbl: id, ...links } : { bbl: id };
  }
  // Lazy-friendly pure shape when caller already has URLs; list UI imports
  // parcelLinksFromBbl from property_location.mjs directly.
  return {
    bbl: id,
    zola_url: `https://zola.planning.nyc.gov/l/lot/${id[0]}/${parseInt(id.slice(1, 6), 10)}/${parseInt(id.slice(6, 10), 10)}`,
    acris_url: `https://a836-acris.nyc.gov/bblsearch/bblsearch.asp?borough=${id[0]}&block=${parseInt(id.slice(1, 6), 10)}&lot=${parseInt(id.slice(6, 10), 10)}`,
    who_owns_what_url: `https://whoownswhat.justfix.org/bbl/${id}`,
  };
}
