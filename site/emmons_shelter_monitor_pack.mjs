/**
 * The reviewed 3218 Emmons tracked-issue canary.
 *
 * This is a navigation layer: each object below keeps its own canonical
 * identity.  Editorial aliases and issue events never construct or rename a
 * procurement, parcel, meeting, or board record.
 */

export const EMMONS_SHELTER_PACK_ID = "emmons-shelter";
export const EMMONS_SHELTER_SUBJECT_REF = "monitor-pack:emmons-shelter";
export const EMMONS_SHELTER_SCHEMA = "cityscroll.tracked_issue_monitor_pack.v1";
export const TRACKED_ISSUE_REGISTRY_SCHEMA = "cityscroll.monitor_pack.tracked_issue_registry.v1";
export const TRACKED_ISSUE_REGISTRY_VERSION = 1;

export const EMMONS_ANCHORS = Object.freeze({
  procurement_id: "CT107120258801626",
  procurement_ref: "procurement:contract:CT107120258801626",
  pin: "07124E0044001",
  vendor: "BHRAGS HOME CARE CORP",
  board_ref: "community-board:brooklyn-cb-15",
  address: "3218 Emmons Avenue",
  bbl: "3088150590",
});

export const EMMONS_ROUTES = Object.freeze({
  issue: "/following/packs/emmons-shelter/",
  procurement: "/procurements/procurement%3Acontract%3ACT107120258801626",
  board: "/community-boards/brooklyn-cb-15/",
  parcel: "/parcels/3088150590/",
});

const EVENT_TYPES = new Set([
  "contract_registration", "award", "term", "value", "responsible_entity",
  "checkbook_event", "board_document_hit", "reported_claim", "litigation_event",
]);
const ACTION_TYPES = new Set([
  "formal_board_action", "individual_official_action", "public_comment",
  "litigation_event", "reported_claim",
]);
const REQUIRED_SECTIONS = Object.freeze(["knows", "timeline", "watch", "not_yet_covered"]);

const text = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const esc = (value) => text(value).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c]));

function required(value, name) {
  const result = text(value);
  if (!result) throw new TypeError(`Emmons monitor pack requires ${name}`);
  return result;
}

function normalizeEvent(event, index) {
  const type = required(event?.type, `event ${index} type`);
  if (!EVENT_TYPES.has(type)) throw new TypeError(`unsupported Emmons event type: ${type}`);
  const sourceObservationRef = required(event?.source_observation_ref, `event ${index} source observation`);
  const canonicalHref = required(event?.canonical_href, `event ${index} canonical route`);
  const label = required(event?.label, `event ${index} label`);
  if (!/^\//.test(canonicalHref)) throw new TypeError(`event ${index} canonical route must be internal`);
  const action = event?.action_type == null ? null : required(event.action_type, `event ${index} action type`);
  if (action && !ACTION_TYPES.has(action)) throw new TypeError(`unsupported Emmons action type: ${action}`);
  return {
    type, label, date: text(event.date) || null, source_observation_ref: sourceObservationRef,
    canonical_href: canonicalHref, source_url: text(event.source_url) || null,
    excerpt: text(event.excerpt) || null, action_type: action,
  };
}

function normalizeAlias(alias, index) {
  const value = required(typeof alias === "string" ? alias : alias?.value, `alias ${index}`);
  const target = required(typeof alias === "string" ? EMMONS_SHELTER_SUBJECT_REF : alias?.target_subject_ref, `alias ${index} target`);
  const observation = required(typeof alias === "string" ? `editorial_alias:${value}` : alias?.source_observation_ref, `alias ${index} source observation`);
  if (/\s/.test(target) || !target.includes(":")) throw new TypeError(`alias ${index} target must be a subject reference`);
  return { value, target_subject_ref: target, source_observation_ref: observation };
}

/**
 * Validate the narrow waist between separately authoritative civic objects and
 * the resident page. This deliberately checks structure, not title similarity:
 * an editorial label cannot create or upgrade a canonical object.
 */
export function validateTrackedIssueRegistry(registry) {
  if (!registry || typeof registry !== "object") throw new TypeError("tracked issue registry must be an object");
  if (registry.schema !== TRACKED_ISSUE_REGISTRY_SCHEMA) throw new TypeError("unsupported tracked issue registry schema");
  if (registry.version !== TRACKED_ISSUE_REGISTRY_VERSION) throw new TypeError("unsupported tracked issue registry version");
  if (registry.namespace !== "monitor-pack") throw new TypeError("tracked issue registry must use monitor-pack namespace");
  required(registry.issue_slug, "issue slug");
  if (!Array.isArray(registry.exact_anchors) || !registry.exact_anchors.length) throw new TypeError("tracked issue registry requires exact anchors");
  for (const [index, anchor] of registry.exact_anchors.entries()) {
    required(anchor?.key, `exact anchor ${index} key`);
    required(anchor?.value, `exact anchor ${index} value`);
  }
  if (!Array.isArray(registry.aliases) || !registry.aliases.length) throw new TypeError("tracked issue registry requires curated aliases");
  for (const [index, alias] of registry.aliases.entries()) normalizeAlias(alias, index);
  if (!Array.isArray(registry.source_links) || !registry.source_links.length) throw new TypeError("tracked issue registry requires source links");
  for (const [index, link] of registry.source_links.entries()) {
    required(link?.label, `source link ${index} label`);
    required(link?.source_observation_ref, `source link ${index} source observation`);
    if (!/^https?:\/\//.test(required(link?.href, `source link ${index} href`))) throw new TypeError(`source link ${index} must be absolute`);
  }
  if (!registry.location_evidence?.method || !registry.location_evidence?.source_observation_ref) {
    throw new TypeError("tracked issue registry requires location evidence");
  }
  if (!Array.isArray(registry.watch_children) || !registry.watch_children.length) throw new TypeError("tracked issue registry requires watch children");
  if (!registry.coverage_statements || typeof registry.coverage_statements !== "object") throw new TypeError("tracked issue registry requires coverage statements");
  if (!registry.sections || REQUIRED_SECTIONS.some((section) => !registry.sections[section])) throw new TypeError("tracked issue registry requires four resident sections");
  if (!Array.isArray(registry.timeline)) throw new TypeError("tracked issue registry requires timeline events");
  for (const [index, event] of registry.timeline.entries()) normalizeEvent(event, index);
  return true;
}

function defaultEvents() {
  return [
    { type: "contract_registration", label: "Contract registered", date: "2024-08-28", source_observation_ref: "passport_public_contracts:contract:07124E0044001:5050251", canonical_href: EMMONS_ROUTES.procurement, source_url: "https://a0333-passportpublic.nyc.gov/" },
    { type: "award", label: "Award published", date: "2024-09-05", source_observation_ref: "city_record:20240829105", canonical_href: EMMONS_ROUTES.procurement, source_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20240829105" },
    { type: "term", label: "Contract term: October 11, 2023 through June 30, 2026", date: "2023-10-11", source_observation_ref: "passport_public_contracts:contract:07124E0044001:5050251", canonical_href: EMMONS_ROUTES.procurement, source_url: "https://a0333-passportpublic.nyc.gov/" },
    { type: "value", label: "Registered value: $10,869,881", date: "2024-08-28", source_observation_ref: "passport_public_contracts:contract:07124E0044001:5050251", canonical_href: EMMONS_ROUTES.procurement, source_url: "https://a0333-passportpublic.nyc.gov/" },
    { type: "responsible_entity", label: "Department of Homeless Services · BHRAGS HOME CARE CORP", source_observation_ref: "city_record:20240829105", canonical_href: EMMONS_ROUTES.procurement, source_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20240829105" },
    { type: "board_document_hit", action_type: "public_comment", label: "CB15 document mention (public comment)", date: "2024-06-18", source_observation_ref: "cb15_minutes:2024-06-18:emmons-alias", canonical_href: EMMONS_ROUTES.board, source_url: "https://www.nyc.gov/site/brooklyncb15/meetings/meetings.page", excerpt: "Retained board material mentions the reviewed shelter aliases; this is not a formal board action." },
    { type: "reported_claim", action_type: "reported_claim", label: "Outside reporting claim (source-attributed)", source_observation_ref: "outside_reporting:emmons-shelter:reviewed", canonical_href: EMMONS_ROUTES.issue, excerpt: "Outside reporting is presented as a reported claim, not as a CityScroll finding." },
  ];
}

export function buildEmmonsShelterMonitorPack(input = {}) {
  const anchors = { ...EMMONS_ANCHORS, ...(input.anchors || {}) };
  for (const [key, value] of Object.entries(EMMONS_ANCHORS)) {
    if (text(anchors[key]) !== value) throw new TypeError(`Emmons anchor mismatch: ${key}`);
  }
  const events = (input.events || defaultEvents()).map(normalizeEvent);
  const watches = input.watches || [
    { id: "exact-procurement", label: "Exact procurement", lens: "money", filter: { subject_refs_all: [EMMONS_ANCHORS.procurement_ref] } },
    { id: "project-alias-money", label: "Project aliases in Money", lens: "money", filter: { keywords: ["3218 Emmons Avenue Gold Star Inn Comfort Inn Sheepshead Bay shelter"], subject_refs_all: [EMMONS_ANCHORS.procurement_ref] } },
    { id: "cb15-meeting-alias", label: "CB15 meetings and shelter aliases", lens: "meetings", filter: { communityBoard: EMMONS_ANCHORS.board_ref, text_query: { all: ["3218 Emmons Avenue", "Gold Star Inn", "Comfort Inn Sheepshead Bay"] } } },
  ];
  const aliases = ["3218 Emmons", "3218 Emmons Avenue", "Gold Star Inn", "Comfort Inn Sheepshead Bay", "Sheepshead Bay shelter"];
  const sourceLinks = [
    { label: "Public contract record", href: "https://a0333-passportpublic.nyc.gov/", source_observation_ref: "passport_public_contracts:contract:07124E0044001:5050251" },
    { label: "City Record award", href: "https://a856-cityrecord.nyc.gov/RequestDetail/20240829105", source_observation_ref: "city_record:20240829105" },
    { label: "Community Board 15 meeting material", href: "https://www.nyc.gov/site/brooklyncb15/meetings/meetings.page", source_observation_ref: "cb15_minutes:2024-06-18:emmons-alias" },
  ];
  const registry = {
    schema: TRACKED_ISSUE_REGISTRY_SCHEMA, version: TRACKED_ISSUE_REGISTRY_VERSION, namespace: "monitor-pack",
    issue_slug: EMMONS_SHELTER_PACK_ID, exact_anchors: Object.entries(anchors).map(([key, value]) => ({ key, value })),
    aliases: aliases.map((value) => ({ value, target_subject_ref: EMMONS_SHELTER_SUBJECT_REF, source_observation_ref: `editorial_alias:${value}` })),
    location_evidence: { address: anchors.address, bbl: anchors.bbl, method: "curated_exact_anchor", source_observation_ref: "pad_snapshot:3088150590" },
    watch_children: watches, source_links: sourceLinks, coverage_statements: {
      court: "Court activity is not presently acquired by CityScroll; this does not establish whether a case exists.",
      board: "Community Board opposition is not asserted unless a retained formal board action supports it.",
      property: "Property coverage is limited to the bounded parcel observations retained for BBL 3088150590.",
    },
    timeline: events,
    sections: { knows: "What CityScroll knows", timeline: "Timeline", watch: "What to watch", not_yet_covered: "Not yet covered" },
  };
  validateTrackedIssueRegistry(registry);
  return {
    schema: EMMONS_SHELTER_SCHEMA, kind: "monitor-pack", id: EMMONS_SHELTER_PACK_ID,
    subject_ref: EMMONS_SHELTER_SUBJECT_REF, title: "3218 Emmons shelter tracker",
    anchors, aliases, alias_records: registry.aliases, source_links: sourceLinks,
    location_evidence: registry.location_evidence, registry,
    routes: EMMONS_ROUTES, events, watches,
    coverage: { court: "Court activity is not presently acquired by CityScroll; this does not establish whether a case exists.", board: "Community Board opposition is not asserted unless a retained formal board action supports it.", property: "Property coverage is limited to the bounded parcel observations retained for BBL 3088150590." },
  };
}

export async function createEmmonsWatchChildren(pack, createChild) {
  const view = pack?.id === EMMONS_SHELTER_PACK_ID ? pack : buildEmmonsShelterMonitorPack(pack);
  if (typeof createChild !== "function") throw new TypeError("createChild must be a function");
  const created = [];
  for (const watch of view.watches) {
    const result = await createChild({ pack_id: view.id, child_id: `${view.id}:${watch.id}`, ...watch });
    if (result?.created !== false) created.push(watch.id);
  }
  return { pack_id: view.id, created, child_count: view.watches.length };
}

export function renderEmmonsShelterMonitorPack(view = buildEmmonsShelterMonitorPack()) {
  const pack = view.id === EMMONS_SHELTER_PACK_ID ? view : buildEmmonsShelterMonitorPack(view);
  const timeline = pack.events.map((event) => `<li data-event-type="${esc(event.type)}"><a href="${esc(event.canonical_href)}">${esc(event.label)}</a>${event.date ? ` <time datetime="${esc(event.date)}">${esc(event.date)}</time>` : ""}<details><summary>Source observation</summary><p>${esc(event.source_observation_ref)}${event.excerpt ? ` — ${esc(event.excerpt)}` : ""}</p></details></li>`).join("");
  const watches = pack.watches.map((watch) => `<li data-watch-id="${esc(watch.id)}"><a href="/following/?lens=${encodeURIComponent(watch.lens)}">${esc(watch.label)}</a><code>${esc(JSON.stringify(watch.filter))}</code></li>`).join("");
  const sourceLinks = pack.source_links.map((link) => `<li><a href="${esc(link.href)}">${esc(link.label)}</a><small> · ${esc(link.source_observation_ref)}</small></li>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(pack.title)} · CityScroll</title><link rel="canonical" href="https://cityscroll.org${EMMONS_ROUTES.issue}"></head><body><main id="main" data-civic-object-kind="monitor-pack" data-subject-ref="${EMMONS_SHELTER_SUBJECT_REF}"><p>Monitor pack</p><h1>${esc(pack.title)}</h1><p>Known public records connected with 3218 Emmons Avenue.</p><nav aria-label="Issue links"><a href="${EMMONS_ROUTES.procurement}">Open canonical procurement</a> · <a href="${EMMONS_ROUTES.board}">Open Community Board 15</a> · <a href="${EMMONS_ROUTES.parcel}">Open parcel</a></nav><section id="identity" data-section="knows"><h2>What CityScroll knows</h2><p>Procurement ${esc(pack.anchors.procurement_id)} · PIN ${esc(pack.anchors.pin)} · ${esc(pack.anchors.vendor)} · ${esc(pack.anchors.address)} · BBL ${esc(pack.anchors.bbl)}</p><details><summary>Sources</summary><ul>${sourceLinks}</ul></details></section><section id="timeline"><h2>Timeline</h2><ol>${timeline}</ol></section><section id="watches" data-section="watch"><h2>What to watch</h2><ul>${watches}</ul><button type="button" data-emmons-create-watches>Watch all three</button></section><section id="coverage" data-section="not_yet_covered"><h2>Not yet covered</h2><p>${esc(pack.coverage.court)}</p><p>${esc(pack.coverage.board)}</p><p>${esc(pack.coverage.property)}</p></section></main></body></html>`;
}

export const buildTrackedIssueView = buildEmmonsShelterMonitorPack;
export const renderTrackedIssueHTML = renderEmmonsShelterMonitorPack;
