/**
 * Subject registry — shared subject_ref vocabulary + typed links.
 *
 * Spines (civic-time, entity resolution, ops action log, claim layer) name the same
 * real-world objects with `kind:id` refs. This module:
 *   - parses/formats those refs without silent rewrite
 *   - defines a closed set of typed inter-subject links
 *   - extracts notice↔contract links from existing lifecycle joins
 *   - extracts notice↔rules / notice↔legistar-event links from matched
 *     rules and meeting-outcomes materialization joins
 *   - measures cross_subject_link_rate on PIN-bearing award cases
 *   - measures rules_meetings_subject_link_rate on matched domain records
 *
 * Subjects stay distinct (notice:… is never rewritten to contract:…). Agreement is
 * expressed as an edge, not a collapsed id.
 */

import { parseAuthorityKey, authorityKeyId } from "../../../entity_resolution/authority_keys/index.mjs";

export const SUBJECT_REGISTRY_VERSION = "subject_registry_v1";
export const SUBJECT_LINK_METHOD = "subject_registry_lifecycle_v1";
export const SUBJECT_LINK_METHOD_VERSION = "1.0.0";

/** Closed subject kind registry (prefix of subject_ref). */
export const SUBJECT_KINDS = Object.freeze({
  notice: { description: "City Record notice (request_id)" },
  contract: { description: "Checkbook / PASSPort contract id" },
  project: { description: "ZAP land-use project" },
  parcel: { description: "NYC tax lot (10-digit BBL)" },
  pin: { description: "NYC procurement PIN/EPIN authority value" },
  vendor: { description: "Vendor identity handle" },
  agency: { description: "Agency identity handle" },
  bbl: { description: "NYC borough-block-lot tax parcel (10-digit BBL)" },
  "legistar-event": { description: "Legistar council calendar event" },
  rules: { description: "NYC Rules item" },
  "entity-pair": { description: "Desk review pair object" },
  entity: { description: "Canonical entity id" },
});

/**
 * Closed typed link vocabulary. Aligns with public graph edge names where they
 * already exist (references_contract); adds registry-specific kinds for PIN and
 * lifecycle registration joins.
 */
export const SUBJECT_LINK_TYPES = Object.freeze({
  references_contract: {
    description: "Notice references a contract id (publisher or join evidence)",
    from_kinds: Object.freeze(["notice"]),
    to_kinds: Object.freeze(["contract"]),
  },
  registered_as: {
    description: "Award notice registered as a distinct contract subject via lifecycle join",
    from_kinds: Object.freeze(["notice"]),
    to_kinds: Object.freeze(["contract"]),
  },
  shares_authority_key: {
    description: "Subjects share a structured PIN/EPIN authority key",
    from_kinds: Object.freeze(["notice", "contract", "pin", "vendor"]),
    to_kinds: Object.freeze(["notice", "contract", "pin", "vendor"]),
  },
  about_notice: {
    description: "Downstream subject is about a City Record notice",
    from_kinds: Object.freeze(["contract", "legistar-event", "project", "entity-pair", "rules"]),
    to_kinds: Object.freeze(["notice"]),
  },
  published_by_agency: {
    description: "Notice or record published by an agency subject",
    from_kinds: Object.freeze(["notice", "contract", "award"]),
    to_kinds: Object.freeze(["agency"]),
  },
  named_vendor: {
    description: "Procurement subject names a vendor subject",
    from_kinds: Object.freeze(["notice", "contract"]),
    to_kinds: Object.freeze(["vendor"]),
  },
  sits_on_parcel: {
    description: "Notice or land project sits on an exact BBL tax parcel",
    from_kinds: Object.freeze(["notice", "project"]),
    to_kinds: Object.freeze(["bbl"]),
  },
  parcel_links_project: {
    description: "Property disposition notice shares an exact BBL with a ZAP project",
    from_kinds: Object.freeze(["notice"]),
    to_kinds: Object.freeze(["project"]),
  },
  named_owner: {
    description: "Disposition notice names a winning bidder / grantee as owner vendor",
    from_kinds: Object.freeze(["notice"]),
    to_kinds: Object.freeze(["vendor"]),
  },
  same_rulemaking: {
    description: "City Record notices that belong to the same rulemaking lifecycle (proposal / hearing / adoption siblings)",
    from_kinds: Object.freeze(["notice"]),
    to_kinds: Object.freeze(["notice"]),
  },
});

const KIND_SET = new Set(Object.keys(SUBJECT_KINDS));
const LINK_TYPE_SET = new Set(Object.keys(SUBJECT_LINK_TYPES));

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

/**
 * Parse `kind:id` into a structured subject. Unknown kinds fail closed (null).
 * Never rewrites kind or id — invalid shape returns null.
 *
 * @param {string} ref
 * @returns {{ kind: string, id: string, ref: string } | null}
 */
export function parseSubjectRef(ref) {
  const raw = clean(ref);
  if (!raw) return null;
  const colon = raw.indexOf(":");
  if (colon <= 0 || colon === raw.length - 1) return null;
  const kind = raw.slice(0, colon).toLowerCase();
  const id = raw.slice(colon + 1).trim();
  if (!KIND_SET.has(kind) || !id) return null;
  // Reject embedded whitespace or second kind rewrite attempts.
  if (/\s/.test(id)) return null;
  return { kind, id, ref: `${kind}:${id}` };
}

/**
 * Format a subject_ref. Kind must be registered; id is not rewritten.
 *
 * @param {string} kind
 * @param {string|number} id
 * @returns {string|null}
 */
export function formatSubjectRef(kind, id) {
  const k = clean(kind).toLowerCase();
  const i = clean(id);
  if (!KIND_SET.has(k) || !i || /\s/.test(i)) return null;
  return `${k}:${i}`;
}

/**
 * Map a source_records-style observation onto a subject_ref without collapsing
 * systems into one namespace.
 *
 * city_record → notice:…, checkbook contract ids → contract:…
 */
export function subjectRefFromSourceRecord(row = {}) {
  const system = clean(row.source_system || row.system).toLowerCase();
  const id = clean(row.source_system_id || row.native_key || row.id);
  if (!system || !id) return null;
  if (system === "city_record" || system === "city-record") {
    return formatSubjectRef("notice", id);
  }
  if (system === "checkbook" || system === "passport" || system === "passport_public") {
    // Prefer explicit contract_id when the native key is something else.
    const contractId = clean(row.contract_id || row.attrs?.contract_id || id);
    if (/^CT/i.test(contractId) || system === "checkbook" || system === "passport" || system === "passport_public") {
      return formatSubjectRef("contract", contractId);
    }
  }
  if (system === "legistar") {
    return formatSubjectRef("legistar-event", id);
  }
  if (system === "zap" || system === "zap_api") {
    return formatSubjectRef("project", id);
  }
  return null;
}

/**
 * Map ops action-log object { type, id } onto a subject_ref when the object type
 * is in the registry vocabulary (entity_pair → entity-pair:…).
 */
export function subjectRefFromActionObject(object = {}) {
  const type = clean(object.type || object.object_type).toLowerCase().replace(/_/g, "-");
  const id = clean(object.id || object.object_id);
  if (!type || !id) return null;
  if (type === "entity-pair" || type === "entitypair") {
    return formatSubjectRef("entity-pair", id);
  }
  if (KIND_SET.has(type)) return formatSubjectRef(type, id);
  return null;
}

/**
 * Build one typed subject link. Fails closed on unknown types or kind mismatches.
 * Does not rewrite from/to refs.
 *
 * @returns {object|null}
 */
export function makeSubjectLink(input = {}) {
  const type = clean(input.type || input.link_type).toLowerCase();
  if (!LINK_TYPE_SET.has(type)) return null;
  const from = parseSubjectRef(input.from || input.from_ref);
  const to = parseSubjectRef(input.to || input.to_ref);
  if (!from || !to) return null;
  if (from.ref === to.ref) return null;

  const meta = SUBJECT_LINK_TYPES[type];
  if (meta.from_kinds && !meta.from_kinds.includes(from.kind)) return null;
  if (meta.to_kinds && !meta.to_kinds.includes(to.kind)) return null;

  const link = {
    type,
    from: from.ref,
    to: to.ref,
    method: clean(input.method) || SUBJECT_LINK_METHOD,
    method_version: clean(input.method_version) || SUBJECT_LINK_METHOD_VERSION,
  };
  if (input.evidence != null && typeof input.evidence === "object") {
    link.evidence = { ...input.evidence };
  }
  if (input.confidence != null) link.confidence = input.confidence;
  return link;
}

/**
 * Stable link id for graph/dedupe (type + ordered endpoints).
 */
export function subjectLinkId(link) {
  if (!link?.type || !link?.from || !link?.to) return "";
  return `${link.type}|${link.from}|${link.to}`;
}

/**
 * Deduplicate link arrays by subjectLinkId (first wins).
 */
export function dedupeSubjectLinks(links = []) {
  const seen = new Map();
  for (const link of links || []) {
    if (!link) continue;
    const id = subjectLinkId(link);
    if (!id || seen.has(id)) continue;
    seen.set(id, link);
  }
  return [...seen.values()].sort((a, b) =>
    a.from.localeCompare(b.from) || a.type.localeCompare(b.type) || a.to.localeCompare(b.to),
  );
}

/**
 * Undirected connected-component walk from root through typed links.
 * Returns sorted unique subject_ref strings including the root when valid.
 */
export function resolveConnectedSubjects(rootRef, links = []) {
  const root = parseSubjectRef(rootRef);
  if (!root) return [];
  const adj = new Map();
  const add = (a, b) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a).add(b);
  };
  for (const link of links || []) {
    if (!link?.from || !link?.to) continue;
    add(link.from, link.to);
    add(link.to, link.from);
  }
  const out = new Set([root.ref]);
  const queue = [root.ref];
  while (queue.length) {
    const cur = queue.shift();
    for (const next of adj.get(cur) || []) {
      if (out.has(next)) continue;
      out.add(next);
      queue.push(next);
    }
  }
  return [...out].sort();
}

/**
 * True when both subjects are in the same connected component under the link set.
 */
export function subjectsConnected(aRef, bRef, links = []) {
  const a = parseSubjectRef(aRef);
  const b = parseSubjectRef(bRef);
  if (!a || !b) return false;
  if (a.ref === b.ref) return true;
  return resolveConnectedSubjects(a.ref, links).includes(b.ref);
}

/**
 * Build subject_refs + typed links from an assembled contract lifecycle and notice row.
 * Uses only existing join evidence (matched registered/pending contract_id + PIN).
 * Never invents a contract link on unmatched/ambiguous registration.
 *
 * @param {object} lifecycle - assembleLifecycle output (timeline, pin, …)
 * @param {object} [noticeRow] - City Record notice fields (request_id, pin, vendor_name, …)
 * @returns {{ subject_refs: object, subject_links: object[] }}
 */
export function linksFromLifecycle(lifecycle, noticeRow = {}) {
  const r = noticeRow || {};
  const pin = clean(lifecycle?.pin || r.pin);
  const requestId = clean(r.request_id || r.id);
  const subject_refs = {};
  const links = [];

  if (requestId) {
    const noticeRef = formatSubjectRef("notice", requestId);
    if (noticeRef) subject_refs.notice = noticeRef;
  }

  const timeline = Array.isArray(lifecycle?.timeline) ? lifecycle.timeline : [];
  const reg = timeline.find((e) => e && e.stage === "registered" && e.status === "matched");
  const pending = timeline.find((e) => e && e.stage === "pending" && e.status === "matched");
  const contractId = clean(
    reg?.detail?.contract_id || pending?.detail?.contract_id || "",
  );
  if (contractId) {
    const contractRef = formatSubjectRef("contract", contractId);
    if (contractRef) subject_refs.contract = contractRef;
  }

  if (pin) {
    const pinRef = formatSubjectRef("pin", pin);
    if (pinRef) subject_refs.pin = pinRef;
  }

  const vendor = clean(r.vendor_name || reg?.detail?.vendor || pending?.detail?.vendor);
  if (vendor) {
    // Stable text handle — not a canonical entity id; same pattern as public graph.
    const vendorRef = formatSubjectRef("vendor", `name:${encodeURIComponent(vendor.toLowerCase())}`);
    if (vendorRef) subject_refs.vendor = vendorRef;
  }

  const noticeRef = subject_refs.notice;
  const contractRef = subject_refs.contract;
  const pinRef = subject_refs.pin;

  if (noticeRef && contractRef) {
    const linkType = reg?.status === "matched" ? "registered_as" : "references_contract";
    const edge = makeSubjectLink({
      type: linkType,
      from: noticeRef,
      to: contractRef,
      evidence: {
        basis: reg?.status === "matched" ? "lifecycle_registered_join" : "lifecycle_pending_join",
        source: reg?.source || pending?.source || "checkbook-contracts",
        pin: pin || null,
        contract_id: contractId,
        request_id: requestId || null,
      },
    });
    if (edge) links.push(edge);
  }

  // PIN authority key edges — structured, not raw-value equality alone.
  if (pinRef && pin) {
    const auth = parseAuthorityKey("pin", pin);
    const authority_key_id = auth ? authorityKeyId(auth) : null;
    for (const other of [noticeRef, contractRef].filter(Boolean)) {
      const edge = makeSubjectLink({
        type: "shares_authority_key",
        from: other,
        to: pinRef,
        evidence: {
          basis: "pin_field",
          authority_key_id,
          pin,
        },
      });
      if (edge) links.push(edge);
    }
  }

  if (noticeRef && subject_refs.vendor) {
    const edge = makeSubjectLink({
      type: "named_vendor",
      from: noticeRef,
      to: subject_refs.vendor,
      evidence: { basis: "notice_vendor_name", vendor },
    });
    if (edge) links.push(edge);
  }

  return {
    subject_refs,
    subject_links: dedupeSubjectLinks(links),
  };
}

/**
 * Stable NYC Rules subject id from a publisher guid or official URL.
 * Never invents — returns null when neither guid nor url is present.
 * Ids keep publisher shape (guid preferred); formatSubjectRef rejects whitespace.
 *
 * @param {object} nycRules - nyc_rules nested block or normalized RSS item
 * @returns {string|null}
 */
export function rulesNativeId(nycRules = {}) {
  const guid = clean(nycRules?.guid || nycRules?.Guid || nycRules?.GUID);
  if (guid && !/\s/.test(guid)) return guid;
  const url = clean(nycRules?.url || nycRules?.link || nycRules?.Link);
  if (url && !/\s/.test(url)) return url;
  return null;
}

/**
 * Build subject_refs + typed links from a rules:materialized:v2 record.
 * Stamps notice and/or rules subjects from real ids only. The notice↔rules
 * about_notice edge is emitted only when join.matched and both subjects resolve.
 * When multi-notice rulemaking siblings are stamped (related_notices with
 * high-confidence join), emits same_rulemaking notice↔notice edges — link not
 * merge; each notice keeps its own subject_ref.
 *
 * @param {object} record - public rules materialization row
 * @returns {{ subject_refs: object, subject_links: object[] }}
 */
export function linksFromRuleRecord(record = {}) {
  const r = record || {};
  const subject_refs = {};
  const links = [];
  const requestId = clean(r.request_id || r.city_record?.request_id || r.city_record?.id);
  const matched = r.join?.matched === true;
  const nycRules = r.nyc_rules && typeof r.nyc_rules === "object" ? r.nyc_rules : null;

  if (requestId) {
    const noticeRef = formatSubjectRef("notice", requestId);
    if (noticeRef) subject_refs.notice = noticeRef;
  }

  // Rules subject: only when a publisher guid/url exists. Matched joins use the
  // nested nyc_rules block; unmatched RSS-only rows also carry nyc_rules.
  if (nycRules) {
    const rulesId = rulesNativeId(nycRules);
    if (rulesId) {
      const rulesRef = formatSubjectRef("rules", rulesId);
      if (rulesRef) subject_refs.rules = rulesRef;
    }
  }

  // Link only on a genuine City Record ↔ NYC Rules join (no speculative edges).
  if (matched && subject_refs.notice && subject_refs.rules) {
    const edge = makeSubjectLink({
      type: "about_notice",
      from: subject_refs.rules,
      to: subject_refs.notice,
      evidence: {
        basis: "rules_rss_city_record_join",
        source: "nyc-rules-rss",
        confidence: clean(r.join?.confidence) || null,
        join_basis: clean(r.join?.basis) || null,
        request_id: requestId || null,
        rules_id: rulesNativeId(nycRules),
      },
    });
    if (edge) links.push(edge);
  }

  // Multi-notice rulemaking siblings (proposal / hearing / adoption). Only
  // high-confidence related_notices entries get same_rulemaking edges.
  const selfNotice = subject_refs.notice;
  const related = Array.isArray(r.related_notices) ? r.related_notices : [];
  if (selfNotice && related.length) {
    for (const sib of related) {
      const sibId = clean(sib?.request_id || sib?.id);
      if (!sibId || sibId === requestId) continue;
      const joinOk = sib?.join?.matched === true && sib?.join?.confidence === "high";
      // When related_notices lack per-sibling join detail, fall back to the
      // record-level rulemaking_join (attach only sets matched on high-conf groups).
      const groupOk = r.rulemaking_join?.matched === true
        && r.rulemaking_join?.confidence === "high";
      if (!joinOk && !groupOk) continue;
      const sibRef = formatSubjectRef("notice", sibId);
      if (!sibRef) continue;
      // Emit ordered by request_id so undirected pairs dedupe cleanly.
      const [from, to] = selfNotice < sibRef ? [selfNotice, sibRef] : [sibRef, selfNotice];
      const edge = makeSubjectLink({
        type: "same_rulemaking",
        from,
        to,
        evidence: {
          basis: "rulemaking_sibling_stitch",
          source: "city-record",
          method: clean(sib?.join?.method || r.rulemaking_join?.method) || null,
          confidence: clean(sib?.join?.confidence || r.rulemaking_join?.confidence) || "high",
          join_basis: clean(sib?.join?.basis || r.rulemaking_join?.basis) || null,
          rulemaking_subject_ref: clean(r.rulemaking_subject_ref) || null,
          request_id: requestId || null,
          sibling_request_id: sibId,
          role: clean(r.rulemaking_join?.role || sib?.role) || null,
          sibling_role: clean(sib?.role) || null,
        },
      });
      if (edge) links.push(edge);
    }
  }

  return {
    subject_refs,
    subject_links: dedupeSubjectLinks(links),
  };
}

/**
 * Build subject_refs + typed links from a meeting-outcomes:materialized:v2 record.
 * Stamps notice when request_id exists. Stamps legistar-event only when the
 * Council join matched and an event_id is present. about_notice edge only when
 * both subjects resolve on a matched join — no speculative stamps.
 *
 * @param {object} record - public meeting-outcomes materialization row
 * @returns {{ subject_refs: object, subject_links: object[] }}
 */
export function linksFromMeetingRecord(record = {}) {
  const r = record || {};
  const subject_refs = {};
  const links = [];
  const requestId = clean(r.request_id || r.notice?.request_id || r.notice?.id);
  const matched = r.join?.matched === true;
  const eventId = clean(
    r.council_event?.event_id
      || r.council_event?.EventId
      || r.event_id
      || r.legistar_event_id,
  );

  if (requestId) {
    const noticeRef = formatSubjectRef("notice", requestId);
    if (noticeRef) subject_refs.notice = noticeRef;
  }

  // Legistar event subject only when the join actually resolved to an event.
  if (matched && eventId) {
    const eventRef = formatSubjectRef("legistar-event", eventId);
    if (eventRef) subject_refs["legistar-event"] = eventRef;
  }

  if (matched && subject_refs.notice && subject_refs["legistar-event"]) {
    const edge = makeSubjectLink({
      type: "about_notice",
      from: subject_refs["legistar-event"],
      to: subject_refs.notice,
      evidence: {
        basis: "legistar_city_record_join",
        source: "nyc-legistar",
        method: clean(r.join?.method) || null,
        request_id: requestId || null,
        event_id: eventId,
      },
    });
    if (edge) links.push(edge);
  }

  return {
    subject_refs,
    subject_links: dedupeSubjectLinks(links),
  };
}

/**
 * Measure notice↔rules / notice↔legistar-event product-surface link rate.
 * Eligible when a case has a notice ref and a domain peer (rules or
 * legistar-event). Linked only when product subject_links connect them —
 * builders are not re-run for the numerator.
 *
 * @param {Array<object>} cases - rows with subject_refs + subject_links, or
 *   raw materialization records (builders used only to recover identity refs)
 * @returns {{ metric: string, version: string, eligible: number, linked: number, rate: number, cases: object[] }}
 */
export function measureRulesMeetingsSubjectLinkRate(cases = []) {
  const rows = Array.isArray(cases) ? cases : [];
  const details = [];
  let eligible = 0;
  let linked = 0;

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;

    let noticeRef = row.subject_refs?.notice || null;
    let peerRef = row.subject_refs?.rules || row.subject_refs?.["legistar-event"] || null;
    let measureLinks = Array.isArray(row.subject_links)
      ? dedupeSubjectLinks(row.subject_links.map((l) => makeSubjectLink(l)).filter(Boolean))
      : [];

    // Recover identity refs from materialization shape without inventing links.
    if (!noticeRef || !peerRef) {
      const isMeeting = !!(row.council_event || row.event_id || row.legistar_event_id
        || (row.join && (row.agenda_items || row.spines)));
      const identity = isMeeting ? linksFromMeetingRecord(row) : linksFromRuleRecord(row);
      noticeRef = noticeRef || identity.subject_refs.notice || null;
      peerRef = peerRef
        || identity.subject_refs.rules
        || identity.subject_refs["legistar-event"]
        || null;
      // Product surface only: do not fall back to identity.subject_links for rate.
    }

    if (!noticeRef || !peerRef) {
      details.push({
        id: row.id || row.request_id || null,
        eligible: false,
        linked: false,
        reason: "missing_notice_or_domain_peer",
      });
      continue;
    }

    eligible += 1;
    const ok = subjectsConnected(noticeRef, peerRef, measureLinks);
    if (ok) linked += 1;
    details.push({
      id: row.id || row.request_id || `${noticeRef}|${peerRef}`,
      eligible: true,
      linked: ok,
      notice_ref: noticeRef,
      peer_ref: peerRef,
      link_count: measureLinks.length,
      connected: resolveConnectedSubjects(noticeRef, measureLinks),
    });
  }

  const rate = eligible === 0 ? 0 : linked / eligible;
  return {
    metric: "rules_meetings_subject_link_rate",
    version: SUBJECT_REGISTRY_VERSION,
    eligible,
    linked,
    rate,
    cases: details,
  };
}

/**
 * Build links from a procurement observation pair (gold / authority / field case).
 * Prefer this when lifecycle is not yet assembled but notice + contract + pin exist.
 */
export function linksFromProcurementPair(pair = {}) {
  const noticeId = clean(pair.notice_id || pair.request_id || pair.left?.native_key);
  const contractId = clean(
    pair.contract_id
      || pair.right?.attrs?.contract_id
      || pair.right?.native_key
      || pair.contract_native_key,
  );
  const pin = clean(pair.pin || pair.left?.attrs?.pin || pair.right?.attrs?.pin);
  const subject_refs = {};
  const links = [];

  if (noticeId) {
    const ref = formatSubjectRef("notice", noticeId);
    if (ref) subject_refs.notice = ref;
  }
  if (contractId && /^CT/i.test(contractId)) {
    const ref = formatSubjectRef("contract", contractId);
    if (ref) subject_refs.contract = ref;
  }
  if (pin) {
    const ref = formatSubjectRef("pin", pin);
    if (ref) subject_refs.pin = ref;
  }

  if (subject_refs.notice && subject_refs.contract) {
    const edge = makeSubjectLink({
      type: pair.registered === false ? "references_contract" : "registered_as",
      from: subject_refs.notice,
      to: subject_refs.contract,
      evidence: {
        basis: pair.basis || "procurement_pair",
        pin: pin || null,
        sources: pair.sources || null,
      },
    });
    if (edge) links.push(edge);
  }

  if (subject_refs.pin && pin) {
    const auth = parseAuthorityKey("pin", pin);
    const authority_key_id = auth ? authorityKeyId(auth) : null;
    for (const other of [subject_refs.notice, subject_refs.contract].filter(Boolean)) {
      const edge = makeSubjectLink({
        type: "shares_authority_key",
        from: other,
        to: subject_refs.pin,
        evidence: { basis: "pin_field", authority_key_id, pin },
      });
      if (edge) links.push(edge);
    }
  }

  return {
    subject_refs,
    subject_links: dedupeSubjectLinks(links),
  };
}

/**
 * Read optional subject_links from a civic-time fixture document.
 * Never rewrites assertion subject_ref values.
 */
export function linksFromCivicFixtureDoc(doc = {}) {
  const listed = Array.isArray(doc.subject_links) ? doc.subject_links : [];
  const built = listed.map((row) => makeSubjectLink(row)).filter(Boolean);
  return dedupeSubjectLinks(built);
}

/**
 * Attach a subject_ref onto claim-layer objects without changing classification.
 * Fails soft: returns claims unchanged when subject_ref is invalid.
 */
export function attachSubjectRefToClaims(claims, subjectRef) {
  const parsed = parseSubjectRef(subjectRef);
  if (!parsed) return claims;
  if (Array.isArray(claims)) {
    return claims.map((c) => (c && typeof c === "object" ? { ...c, subject_ref: parsed.ref } : c));
  }
  if (claims && typeof claims === "object") {
    return { ...claims, subject_ref: parsed.ref };
  }
  return claims;
}

/**
 * Measure cross_subject_link_rate on PIN-bearing award cases.
 *
 * A case is eligible when it names notice + contract + pin (modern PIN-bearing
 * award path). It is linked only when the **product-surface** link set connects
 * those subjects — from `lifecycle.subject_links`, `subject_links`, or `links`.
 * The registry never invents edges for the rate numerator (that would make the
 * metric always 1.0 even when spines stay split).
 *
 * @param {Array<object>} cases
 * @returns {{
 *   metric: string,
 *   version: string,
 *   eligible: number,
 *   linked: number,
 *   rate: number,
 *   cases: Array<object>
 * }}
 */
export function measureCrossSubjectLinkRate(cases = []) {
  const rows = Array.isArray(cases) ? cases : [];
  const details = [];
  let eligible = 0;
  let linked = 0;

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;

    let noticeRef = null;
    let contractRef = null;
    let pin = clean(row.pin);
    let measureLinks = [];

    if (row.lifecycle && typeof row.lifecycle === "object") {
      // Product surface only: links already stamped by assembleLifecycle (or absent).
      measureLinks = Array.isArray(row.lifecycle.subject_links)
        ? dedupeSubjectLinks(row.lifecycle.subject_links.map((l) => makeSubjectLink(l)).filter(Boolean))
        : [];
      noticeRef = row.lifecycle.subject_refs?.notice
        || formatSubjectRef("notice", row.notice_id || row.request_id);
      contractRef = row.lifecycle.subject_refs?.contract
        || formatSubjectRef("contract", row.contract_id);
      pin = pin || clean(row.lifecycle.pin);
      if (!contractRef) {
        const reg = (row.lifecycle.timeline || []).find(
          (e) => e && e.stage === "registered" && e.status === "matched",
        );
        if (reg?.detail?.contract_id) {
          contractRef = formatSubjectRef("contract", reg.detail.contract_id);
        }
      }
    } else {
      const identity = linksFromProcurementPair(row);
      noticeRef = identity.subject_refs.notice;
      contractRef = identity.subject_refs.contract;
      pin = pin || clean(identity.subject_refs.pin?.replace(/^pin:/, ""));
      const raw = Array.isArray(row.subject_links)
        ? row.subject_links
        : Array.isArray(row.links)
          ? row.links
          : [];
      measureLinks = dedupeSubjectLinks(raw.map((l) => makeSubjectLink(l)).filter(Boolean));
    }

    if (!noticeRef || !contractRef || !pin) {
      details.push({
        id: row.id || null,
        eligible: false,
        linked: false,
        reason: "missing_notice_contract_or_pin",
      });
      continue;
    }
    eligible += 1;
    const ok = subjectsConnected(noticeRef, contractRef, measureLinks);
    if (ok) linked += 1;
    details.push({
      id: row.id || `${noticeRef}|${contractRef}`,
      eligible: true,
      linked: ok,
      notice_ref: noticeRef,
      contract_ref: contractRef,
      pin,
      link_count: measureLinks.length,
      connected: resolveConnectedSubjects(noticeRef, measureLinks),
    });
  }

  const rate = eligible === 0 ? 0 : linked / eligible;
  return {
    metric: "cross_subject_link_rate",
    version: SUBJECT_REGISTRY_VERSION,
    eligible,
    linked,
    rate,
    cases: details,
  };
}

/**
 * Assert subject_ref values are never silently rewritten between two envelope sets
 * for the same event_id. Used by characterization tests.
 */
export function subjectRefsUnchanged(previousEvents = [], currentEvents = []) {
  const prev = new Map((previousEvents || []).map((e) => [e.event_id, e.subject_ref]));
  const violations = [];
  for (const event of currentEvents || []) {
    if (!event?.event_id) continue;
    if (!prev.has(event.event_id)) continue;
    const before = prev.get(event.event_id);
    if (before !== event.subject_ref) {
      violations.push({
        event_id: event.event_id,
        previous: before,
        current: event.subject_ref,
      });
    }
  }
  return { ok: violations.length === 0, violations };
}
