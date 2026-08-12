import {
  normalizeScope,
  routeHashFromScope,
  scopeFromWatch,
  scopeWithEntity,
  watchFromScope,
} from "./scope_v0.mjs";
import { normalizeWatchTemplateRegistry, packAttentionCopy } from "./watch_templates.mjs";
import { canonicalizeBrowseUrl, migrateLegacyUrl } from "./route_migration.mjs";
import { entityHref, entityRouteRef, parseEntityRef } from "./entity_pivot.mjs";
import {
  renderCivicDocumentAssets,
  renderCivicDocumentMast,
} from "./civic_document_chrome.mjs";
import { constellationLink, filterChip } from "./affordance_grammar.mjs";

const API_BASE = "https://api.cityscroll.org";
const SITE_BASE = "https://cityscroll.org";

/** Canonical public watch lenses (product identity). */
const LENSES = Object.freeze([
  "money", "people", "land", "property", "rules", "meetings", "district", "entity", "mandates",
]);
/** Legacy URL / storage aliases → canonical lens. */
const LENS_ALIASES = Object.freeze({
  obligations: "mandates", // upstream extract vocabulary; product term is mandates
});
const LENS_LABELS = Object.freeze({
  money: "Contracts and RFPs",
  people: "Staffing and exams",
  land: "Zoning",
  property: "Property",
  rules: "Rules",
  meetings: "Hearings and meetings",
  district: "Council district weekly",
  entity: "Agency or vendor",
  mandates: "Mandates",
});
const BOROUGHS = Object.freeze(["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island"]);

function esc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function compact(value) {
  const out = {};
  for (const [key, item] of Object.entries(value || {})) {
    if (item == null || item === "" || item === false) continue;
    if (Array.isArray(item) && item.length === 0) continue;
    out[key] = item;
  }
  return out;
}

function cleanCount(value) {
  if (value == null || value === "") return null;
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 && count <= 10000 ? count : null;
}

function cleanFrequency(value) {
  return String(value || "").toLowerCase() === "weekly" ? "weekly" : "daily";
}

/** Normalize a public or legacy lens to the product identity. */
export function canonicalFollowingLens(lens) {
  const raw = String(lens || "").trim().toLowerCase();
  const mapped = LENS_ALIASES[raw] || raw;
  return LENSES.includes(mapped) ? mapped : "money";
}

/** True when the raw URL lens is a known alias that should redirect to the canonical name. */
export function followingLensNeedsRedirect(lens) {
  const raw = String(lens || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(LENS_ALIASES, raw);
}

function normalizedWatch(lens, filter) {
  const wantedLens = canonicalFollowingLens(lens);
  const watch = watchFromScope(scopeFromWatch({ lens: wantedLens, filter: compact(filter) }), { lens: wantedLens });
  return { lens: canonicalFollowingLens(watch.lens), filter: compact(watch.filter) };
}

export function watchFromFollowingParams(input) {
  const params = input instanceof URLSearchParams ? input : new URL(input, "https://cityscroll.invalid").searchParams;
  const requested = params.has("lens") || params.has("filter") || params.has("q") || params.has("agency")
    || params.has("boro") || params.has("council");
  let filter = {};
  try {
    const parsed = JSON.parse(params.get("filter") || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) filter = parsed;
  } catch { /* malformed scope fails soft to the visible fields */ }
  const lens = canonicalFollowingLens(params.get("lens") || "money");
  const setOrDelete = (name, value) => {
    if (value == null || value === "") delete filter[name];
    else filter[name] = value;
  };
  if (params.has("q")) setOrDelete("keywords", params.get("q") ? [params.get("q").trim()] : null);
  if (params.has("agency")) setOrDelete("agency", params.get("agency")?.trim());
  if (params.has("boro")) setOrDelete(lens === "land" ? "boro" : "borough", params.get("boro"));
  if (params.has("council")) setOrDelete("councilDistrict", params.get("council"));
  if (params.has("when")) {
    setOrDelete("when", params.get("when"));
    setOrDelete("dateWindow", params.get("when"));
  }
  if (params.has("type")) setOrDelete("noticeType", params.get("type"));
  const watch = normalizedWatch(lens, filter);
  return {
    ...watch,
    requested,
    frequency: cleanFrequency(params.get("freq")),
    matchCount: cleanCount(params.get("count")),
  };
}

export function followingUrlFromWatch(watch, options = {}) {
  const base = String(options.base || `${SITE_BASE}/following`).replace(/\/$/, "");
  if (!watch || !watch.lens) return options.emptyBase || "/following/";
  const normalized = normalizedWatch(watch.lens, watch.filter);
  const params = new URLSearchParams({
    lens: normalized.lens,
    filter: JSON.stringify(normalized.filter),
  });
  const frequency = String(options.frequency || watch.freq || "").toLowerCase();
  if (frequency === "daily" || frequency === "weekly") params.set("freq", frequency);
  const count = cleanCount(options.matchCount ?? watch.matchCount);
  if (count != null) params.set("count", String(count));
  return `${base}?${params}`;
}

const BROWSE_FACETS = Object.freeze({
  money: "contracts",
  people: "staffing",
  land: "zoning",
  property: "property",
  rules: "rules",
  meetings: "meetings",
});

function entityPivotForWatch(watch) {
  const filter = watch?.filter && typeof watch.filter === "object" ? watch.filter : {};
  const refs = [
    ...(Array.isArray(filter.entity_refs_all) ? filter.entity_refs_all : []),
    ...(Array.isArray(filter.subject_refs_all) ? filter.subject_refs_all : []),
  ];
  let ref = refs.map((candidate) => String(candidate || "").trim()).find((candidate) => parseEntityRef(candidate));
  if (!ref && watch?.lens === "entity" && filter.name) {
    ref = entityRouteRef(filter.kind === "agency" ? "agency" : "vendor", filter.name);
  }
  if (!ref) return null;
  const parsed = parseEntityRef(ref);
  if (!parsed) return null;
  const label = String(filter.name || filter.agency || "").trim()
    || (parsed.kind === "agency"
      ? parsed.id.replace(/^id:/, "")
      : parsed.kind === "vendor"
        ? decodeURIComponent(parsed.id.replace(/^stem:/, ""))
        : parsed.id);
  const href = entityHref({ ref, label });
  if (!href) return null;
  return { ref, kind: parsed.kind, label, href };
}

export function currentMatchesHref(watch) {
  const normalized = normalizedWatch(watch?.lens || "money", watch?.filter || {});
  const entity = entityPivotForWatch(normalized);
  let scope = scopeFromWatch(normalized);
  if (entity) scope = scopeWithEntity(scope, entity.ref);
  const surface = normalized.lens === "entity" ? "money" : normalized.lens;
  if (surface === "district") {
    const council = normalized.filter.councilDistrict;
    return council ? `/near-you/?v=0&lens=district&council=${encodeURIComponent(council)}` : "/near-you/";
  }
  const facet = BROWSE_FACETS[surface];
  if (!facet) return followingUrlFromWatch(normalized, { frequency: watch?.frequency || watch?.freq });
  const hash = routeHashFromScope(normalizeScope(scope), { surface });
  return canonicalizeBrowseUrl(`/browse/${facet}/?${hash.split("?")[1] || ""}`);
}

/**
 * Public graph context for one watch. The object is also used by the personal
 * endpoint and watch-set renderer so all three surfaces share the same pivots.
 */
export function buildFollowingGraphContext(watch = {}, options = {}) {
  const normalized = normalizedWatch(watch.lens || "money", watch.filter || {});
  const frequency = cleanFrequency(options.frequency || watch.frequency || watch.freq);
  const filter = normalized.filter;
  const entity = entityPivotForWatch(normalized);
  return {
    schema: "cityscroll.following_graph_context.v1",
    ...normalized,
    filter,
    frequency,
    ruleSentence: composeWatchRuleSentence(normalized.lens, filter, { frequency }),
    scopeSummary: scopeSummary(normalized.lens, filter),
    currentMatchesHref: currentMatchesHref({ ...normalized, frequency }),
    entity,
    topicLabel: LENS_LABELS[normalized.lens] || normalized.lens,
    placeLabel: filter.borough || filter.boro || filter.neighborhood || "Citywide",
    keywordLabel: Array.isArray(filter.keywords) && filter.keywords.length
      ? filter.keywords.join(" ") : null,
    agencyLabel: filter.agency || null,
    districtLabel: filter.councilDistrict
      ? `Council District ${filter.councilDistrict}`
      : filter.communityDistrict || null,
    followingHref: followingUrlFromWatch(normalized, { frequency }),
    backToEntity: !!options.backToEntity,
  };
}

function typedPivotAttributes(entity, relation = "watch_target") {
  if (!entity) return {};
  return {
    "data-entity-ref": entity.ref,
    "data-subject-ref": entity.ref,
    "data-pivot-kind": entity.kind,
    "data-pivot-relation": relation,
  };
}

function graphLink({ href, label, className, entity, relation } = {}) {
  return constellationLink({
    href,
    label,
    className,
    attributes: typedPivotAttributes(entity, relation),
    escape: esc,
  });
}

function watchIdentityRows(context) {
  const rows = [
    ["Topic", context.topicLabel, null],
    ["Place", context.placeLabel, null],
    ["Keyword", context.keywordLabel, null],
    ["Agency", context.agencyLabel, null],
    ["District", context.districtLabel, null],
  ].filter(([, value]) => value);
  if (context.entity) {
    rows.push(["Entity", graphLink({
      href: context.entity.href,
      label: context.entity.label,
      className: "following-entity-link",
      entity: context.entity,
    }), true]);
  }
  return rows.map(([label, value, html]) => `<div class="following-identity-row"><dt>${esc(label)}</dt><dd>${html ? value : esc(value)}</dd></div>`).join("");
}

export function followingWatchScopeLinksHtml(context, { entityClass = "following-watch-entity" } = {}) {
  const scopeLinks = context.scopeSummary.map((item) => (
    `<li>${constellationLink({
      href: context.currentMatchesHref,
      label: item.label,
      className: "following-watch-scope-link",
      attributes: { "data-following-scope-link": item.axis },
      escape: esc,
    })}</li>`
  )).join("");
  const entityLink = context.entity
    ? `<li>${graphLink({
      href: context.entity.href,
      label: context.entity.label,
      className: entityClass,
      entity: context.entity,
    })}</li>`
    : "";
  return `<ul class="following-watch-scope-links" aria-label="Watch links">${scopeLinks}${entityLink}</ul>`;
}

export function followingWatchIdentityHtml(context, {
  heading = "Watch identity",
  headingTag = "h2",
  includeActions = true,
  backToEntity = context.backToEntity,
  className = "",
} = {}) {
  if (!context) return "";
  const entityAction = context.entity
    ? graphLink({
      href: context.entity.href,
      label: `${backToEntity ? "Back to" : "Open"} ${context.entity.label}`,
      className: "following-entity-action",
      entity: context.entity,
      relation: "watch_target",
    })
    : "";
  const actions = includeActions
    ? `<nav class="following-identity-actions" aria-label="Watch destinations">
      ${constellationLink({ href: context.currentMatchesHref, label: "See current matches", className: "following-current-matches", attributes: { "data-following-current-matches": "true" }, escape: esc })}
      ${entityAction}
    </nav>`
    : "";
  return `<section class="following-watch-identity${className ? ` ${esc(className)}` : ""}" data-following-watch-identity>
    <p class="following-kicker">Orientation</p><${headingTag}>${esc(heading)}</${headingTag}>
    <dl class="following-identity-facts">${watchIdentityRows(context)}</dl>
    <p class="following-identity-rule" data-following-identity-rule>${esc(context.ruleSentence)}</p>
    <p class="following-identity-cadence">Cadence: <strong data-following-identity-cadence>${esc(context.frequency === "weekly" ? "Weekly" : "Daily")}</strong></p>
    ${actions}
  </section>`;
}

function scopeSummary(lens, filter) {
  const chips = [{ axis: "topic", label: LENS_LABELS[lens] || lens }];
  const values = [
    ["keywords", Array.isArray(filter.keywords) ? filter.keywords.join(" ") : null],
    ["agency", filter.agency],
    ["borough", filter.borough || filter.boro],
    ["neighborhood", filter.neighborhood],
    ["community district", filter.communityDistrict],
    ["council district", filter.councilDistrict],
    ["record type", filter.noticeType],
    ["stage", filter.process || filter.stage],
    ["time", filter.dateWindow || filter.when],
    ["name", filter.name],
    ["agency id", filter.agency_id],
    ["mandate", filter.mandate_id],
    ["deliverable type", filter.deliverable_type],
    ["deadline window", typeof filter.windowDays === "number" ? `next ${filter.windowDays} days` : null],
    ["exam number", Array.isArray(filter.examNumber) ? filter.examNumber.join(", ") : filter.examNumber],
    ["subject ref", Array.isArray(filter.subject_refs_all) && filter.subject_refs_all.length ? filter.subject_refs_all.join(", ") : null],
  ];
  for (const [axis, label] of values) if (label) chips.push({ axis, label: String(label) });
  return chips;
}

/**
 * Live plain-English conjunction for the watch program (keyword ∩ agency ∩ place).
 * Pure: used by server HTML, client island updates, and unit tests.
 */
export function composeWatchRuleSentence(lens, filter = {}, options = {}) {
  const wanted = canonicalFollowingLens(lens);
  const topic = LENS_LABELS[wanted] || wanted;
  const f = filter && typeof filter === "object" ? filter : {};
  const clauses = [];

  if (wanted === "district") {
    const n = f.councilDistrict || "?";
    return `Notify me for Council District ${n} weekly digest.`;
  }
  if (wanted === "mandates" || wanted === "obligations") {
    const who = f.agency || f.agency_id || "this agency";
    if (f.mandate_id) return `Notify me for mandate ${f.mandate_id} at ${who}.`;
    const type = f.deliverable_type ? String(f.deliverable_type).replace(/_/g, " ") : null;
    if (type === "report") return `Notify me when ${who} report mandates expect filings.`;
    if (type === "rulemaking") return `Notify me when ${who} rulemaking mandates expect filings.`;
    if (type) return `Notify me for ${who} ${type} mandates.`;
    return `Notify me for ${who} mandates — expected filings.`;
  }
  if (wanted === "entity") {
    const kind = f.kind === "agency" ? "agency" : "vendor";
    const name = f.name || "this name";
    return `Notify me when City Record names the ${kind} ${name}.`;
  }

  const keywords = Array.isArray(f.keywords) ? f.keywords.filter(Boolean) : [];
  if (keywords.length) clauses.push(`keyword ${keywords.join(" ")}`);
  if (f.agency) clauses.push(`agency ${f.agency}`);
  if (f.name && wanted !== "entity") clauses.push(`name ${f.name}`);
  if (f.noticeType === "award") clauses.push("awards only");
  else if (f.noticeType === "solicitation") clauses.push("open solicitations only");
  const place = f.borough || f.boro || f.neighborhood || null;
  if (place) clauses.push(`in ${place}`);
  if (f.councilDistrict) clauses.push(`Council District ${f.councilDistrict}`);
  if (f.communityDistrict) clauses.push(`community district ${f.communityDistrict}`);
  if (f.dateWindow || f.when) clauses.push(`time ${f.dateWindow || f.when}`);

  if (!clauses.length) {
    return `Notify me when ${topic} match citywide.`;
  }
  const joined = clauses.map((c, i) => (i === 0 ? c : `AND ${c}`)).join(" ");
  return `Notify me when ${topic} match ${joined}.`;
}

/** True when the filter has no geography pin (citywide / unscoped place). */
export function isCitywideWatchScope(filter = {}) {
  const f = filter && typeof filter === "object" ? filter : {};
  return !(f.borough || f.boro || f.councilDistrict || f.neighborhood || f.communityDistrict);
}

/**
 * Slim digItem-shaped preview card (title, meta, phase chip, next step, deep link).
 * Shares the awareness fields feedItems may attach without pulling the full digest renderer.
 */
export function followingPreviewItemHtml(item) {
  const row = item || {};
  const mapped = migrateLegacyUrl(row.url || "/browse/");
  const href = mapped.target || row.url || "/browse/";
  const title = row.title || "Untitled record";
  const summary = row.summary ? `<p class="following-dig-meta">${esc(row.summary)}</p>` : "";
  const phase = row.phase
    ? `<span class="following-dig-phase">${esc(row.phase)}</span>`
    : "";
  const next = row.nextStep
    ? `<p class="following-dig-next"><span class="following-dig-next-label">Next step:</span> ${esc(row.nextStep)}</p>`
    : "";
  const chips = phase
    ? `<div class="following-dig-awareness" aria-label="Status">${phase}</div>`
    : "";
  return `<li class="following-digitem" data-preview-id="${esc(row.id)}">
    <div class="following-dig-title">${constellationLink({ href, label: title, className: "following-record-link", escape: esc })}</div>
    ${summary}
    ${chips}
    ${next}
    <p class="following-dig-open">${constellationLink({ href, label: "Open on CityScroll", className: "following-record-open", escape: esc })}</p>
  </li>`;
}

export function buildFollowingViewModel(input = {}, templateRegistry = {}) {
  const watch = normalizedWatch(input.lens || "money", input.filter || {});
  const requested = input.requested == null
    ? !!(input.lens || Object.keys(input.filter || {}).length || input.previewItems)
    : !!input.requested;
  const previewItems = Array.isArray(input.previewItems) ? input.previewItems.slice(0, 5) : [];
  const matchCount = cleanCount(input.matchCount);
  const registry = normalizeWatchTemplateRegistry(templateRegistry);
  const frequency = cleanFrequency(input.frequency);
  const ruleSentence = composeWatchRuleSentence(watch.lens, watch.filter, { frequency });
  const citywide = isCitywideWatchScope(watch.filter);
  const graphContext = buildFollowingGraphContext({ ...watch, frequency });
  return {
    schema: "cityscroll.following_view.v1",
    ...watch,
    requested,
    frequency,
    matchCount: matchCount == null && requested ? previewItems.length : matchCount,
    previewItems,
    previewError: input.previewError || null,
    scopeSummary: scopeSummary(watch.lens, watch.filter),
    ruleSentence,
    citywide,
    citywideDailyWarn: citywide && frequency === "daily" && requested,
    graphContext,
    templates: registry.templates,
    followingUrl: followingUrlFromWatch(watch, {
      frequency,
      matchCount,
    }),
  };
}

function placeBorough(filter) {
  return filter.borough || filter.boro || "";
}

function withTopic(view, lens) {
  const nextFilter = { ...view.filter };
  // Land uses `boro`; other place-aware lenses use `borough`.
  if (lens === "land" && nextFilter.borough && !nextFilter.boro) {
    nextFilter.boro = nextFilter.borough;
  } else if (lens !== "land" && nextFilter.boro && !nextFilter.borough) {
    nextFilter.borough = nextFilter.boro;
  }
  if (lens === "land") delete nextFilter.borough;
  else delete nextFilter.boro;
  return followingUrlFromWatch({
    lens,
    filter: nextFilter,
    matchCount: view.matchCount,
  }, { frequency: view.frequency, matchCount: view.matchCount });
}

function withPlace(view, borough) {
  const nextFilter = { ...view.filter };
  if (!borough) {
    delete nextFilter.borough;
    delete nextFilter.boro;
  } else if (view.lens === "land") {
    nextFilter.boro = borough;
    delete nextFilter.borough;
  } else {
    nextFilter.borough = borough;
    delete nextFilter.boro;
  }
  return followingUrlFromWatch({
    lens: view.lens,
    filter: nextFilter,
    matchCount: view.matchCount,
  }, { frequency: view.frequency, matchCount: view.matchCount });
}

function scopeLinkChip(href, label, { active = false, axis = "", value = "" } = {}) {
  return filterChip({
    label,
    pressed: active,
    className: `following-scope-link${active ? " on" : ""}`,
    attributes: {
      "data-following-scope-axis": axis,
      "data-following-scope-value": value,
      "data-scope-edge": `following.${axis}.${value || "all"}`,
      "data-filter-href": href,
    },
    escape: esc,
  });
}

/** Topic + place as shareable scope-link chips (not bare selects). */
function topicPlacePickersHtml(view) {
  const topic = LENSES.map((lens) => scopeLinkChip(
    withTopic(view, lens),
    LENS_LABELS[lens],
    { active: view.lens === lens, axis: "topic", value: lens },
  )).join("");
  const currentBorough = placeBorough(view.filter);
  const place = [
    scopeLinkChip(withPlace(view, ""), "Any place", {
      active: !currentBorough,
      axis: "place",
      value: "all",
    }),
    ...BOROUGHS.map((borough) => scopeLinkChip(withPlace(view, borough), borough, {
      active: currentBorough === borough,
      axis: "place",
      value: borough,
    })),
  ].join("");
  return `<div class="following-scope-pickers">
    <div class="following-scope-rail" role="group" aria-label="Topic">
      <p class="following-scope-rail-label">Topic</p>
      <div class="following-scope-links" data-following-topic-scope>${topic}</div>
    </div>
    <div class="following-scope-rail" role="group" aria-label="Place">
      <p class="following-scope-rail-label">Place</p>
      <div class="following-scope-links" data-following-place-scope>${place}</div>
    </div>
  </div>`;
}

function ruleLineHtml(view) {
  if (!view.requested) return "";
  const warn = view.citywideDailyWarn
    ? `<p class="following-warning" data-following-citywide-warn role="status">This daily watch covers the whole city. Quiet days stay quiet. A match in any borough can email you. Pick a place or choose weekly to cut noise.</p>`
    : "";
  return `<div class="following-rule" data-following-rule-panel>
    <p class="following-rule-line" data-following-rule-line>${esc(view.ruleSentence)}</p>
    ${warn}
  </div>`;
}

function scopeHtml(view) {
  if (!view.requested) return "";
  const chips = view.scopeSummary.map((chip) => (
    `<li class="qchip following-scope-chip" data-scope-axis="${esc(chip.axis)}">${esc(chip.label)}</li>`
  )).join("");
  const count = view.matchCount;
  const countLine = count == null
    ? ""
    : `<p class="following-scope-count" data-scope-count="${esc(String(count))}">${esc(String(count))} matching records</p>`;
  return `<section class="following-scope" data-following-scope-panel aria-labelledby="following-scope-heading">
    <h2 id="following-scope-heading">Watch criteria</h2>
    <ul class="following-scope-chips" aria-label="Watch criteria">${chips}</ul>
    ${countLine}
    ${ruleLineHtml(view)}
  </section>`;
}

function previewHtml(view) {
  if (!view.requested) return "";
  const count = view.matchCount ?? view.previewItems.length;
  const body = view.previewError
    ? `<p class="following-note" role="status">${esc(view.previewError)}</p>`
    : view.previewItems.length
      ? `<ol class="following-diglist">${view.previewItems.map(followingPreviewItemHtml).join("")}</ol>`
      : `<p class="following-empty">No matches now — still watch for new.</p>`;
  return `<section class="following-preview" data-following-preview-panel data-scope-count="${count}" aria-labelledby="following-preview-heading">
    <p class="following-kicker">Preview</p><h2 id="following-preview-heading">${count} matching records</h2>
    <p>${view.previewItems.length < count ? `${view.previewItems.length} recent matches are shown.` : "Every current match is shown."}</p>
    ${body}
  </section>`;
}

function cadenceCardsHtml(view, { name = "freq", form = "preview" } = {}) {
  const dailyOn = view.frequency !== "weekly";
  const weeklyOn = view.frequency === "weekly";
  const idBase = form === "subscribe" ? "following-sub" : "following";
  return `<fieldset class="following-cadence" data-following-cadence>
    <legend>How often to email</legend>
    <div class="following-cadence-cards">
      <label class="following-cadence-card${dailyOn ? " is-selected" : ""}">
        <input type="radio" name="${esc(name)}" value="daily"${dailyOn ? " checked" : ""} data-following-freq="daily">
        <span class="following-cadence-title">Daily</span>
        <span class="following-cadence-copy">Email only on match days. Quiet days stay quiet. After about 14 quiet days, we send a short check-in.</span>
      </label>
      <label class="following-cadence-card${weeklyOn ? " is-selected" : ""}">
        <input type="radio" name="${esc(name)}" value="weekly"${weeklyOn ? " checked" : ""} data-following-freq="weekly">
        <span class="following-cadence-title">Weekly</span>
        <span class="following-cadence-copy">A Monday note even when nothing is new.</span>
      </label>
    </div>
  </fieldset>`;
}

function subscribeHtml(view) {
  if (!view.requested) {
    return `<section class="following-subscribe" data-following-subscribe-panel>
      <p class="following-kicker">Delivery</p><h2>Create a watch</h2>
      <p>Pick a topic or place to see matches.</p>
      <p class="following-note" data-following-delivery-help>No new matches means no email. That is on purpose. After 14 quiet days on a daily watch, we send a short still-watching note. Weekly watches email every Monday. Edits start with the next digest (about 9am Eastern). Unsubscribing is instant.</p>
    </section>`;
  }
  return `<section class="following-subscribe" data-following-subscribe-panel aria-labelledby="following-subscribe-heading">
    <p class="following-kicker">Delivery</p><h2 id="following-subscribe-heading">Create this watch</h2>
    <form method="post" action="${API_BASE}/subscribe" data-following-subscribe-form>
      <input type="hidden" name="lens" value="${esc(view.lens)}">
      <input type="hidden" name="filter" value="${esc(JSON.stringify(view.filter))}">
      <input type="hidden" name="freq" value="${esc(view.frequency)}" data-following-subscribe-freq>
      <input type="hidden" name="lang" value="en">
      <label>Email address<input type="email" name="email" required autocomplete="email" inputmode="email" aria-describedby="following-confirm-note following-delivery-help"></label>
      <button type="submit">Email me this watch</button>
      <p id="following-confirm-note">We send one link first. Click it to start the watch.</p>
      <p id="following-delivery-help" class="following-note" data-following-delivery-help>
        No new matches means no email. That is on purpose. After 14 quiet days on a daily watch, we send a short still-watching note. Weekly watches email every Monday. Edits start with the next digest (about 9am Eastern). Unsubscribing is instant.
      </p>
      <p data-following-submit-status role="status" aria-live="polite"></p>
    </form>
  </section>`;
}

function templateHtml(template) {
  const attention = packAttentionCopy(template, { frequency: "weekly" });
  const matchCount = Number.isInteger(template.matchCount) ? template.matchCount : null;
  const countLine = matchCount == null
    ? ""
    : `<p class="following-pack-count" data-pack-match-count="${esc(String(matchCount))}">${esc(String(matchCount))} matching records</p>`;
  const sampleSubject = matchCount == null
    ? `<p class="following-pack-subject muted">Sample subject line: ${esc(attention.sampleSubject)}</p>`
    : "";
  const watches = template.watches.map((watch) => {
    const context = buildFollowingGraphContext(watch, { frequency: "weekly", backToEntity: true });
    return `<li class="following-pack-watch" data-following-pack-watch>
      ${followingWatchScopeLinksHtml(context, { entityClass: "following-pack-watch-entity" })}.
    </li>`;
  }).join("");
  const href = `/following/packs/${encodeURIComponent(template.id)}/`;
  const resultsHref = template.resultsHref || currentMatchesHref(template.watches[0]);
  return `<article class="following-pack" data-pack-id="${esc(template.id)}">
    <h3>${esc(template.title)}</h3>
    <p class="following-pack-cost" data-pack-attention>${esc(attention.summary)}</p>
    ${countLine}
    ${sampleSubject}
    <ul class="following-pack-watch-list">${watches}</ul>
    ${resultsHref ? constellationLink({ href: resultsHref, label: "See matches", className: "following-pack-results-link", escape: esc }) : ""}
    ${constellationLink({ href, label: "Open this pack", className: "following-pack-link", escape: esc })}
  </article>`;
}

function controlsHtml(view) {
  const query = Array.isArray(view.filter.keywords) ? view.filter.keywords.join(" ") : "";
  const borough = placeBorough(view.filter);
  return `${topicPlacePickersHtml(view)}
  <form class="following-form" method="get" action="${SITE_BASE}/following" data-following-preview-form>
    <input type="hidden" name="lens" value="${esc(view.lens)}">
    <input type="hidden" name="filter" value="${esc(JSON.stringify(view.filter))}">
    ${borough ? `<input type="hidden" name="boro" value="${esc(borough)}">` : ""}
    <label>Keyword<input name="q" value="${esc(query)}" placeholder="housing, school buses, curb…" data-following-refine="keywords"></label>
    <label>Agency<input name="agency" value="${esc(view.filter.agency || "")}" placeholder="Any agency" data-following-refine="agency"></label>
    <label>Council district<input name="council" value="${esc(view.filter.councilDistrict || "")}" inputmode="numeric" pattern="(?:[1-9]|[1-4][0-9]|5[01])" placeholder="1–51" data-following-refine="council"></label>
    ${cadenceCardsHtml(view)}
    <button type="submit">See matches</button>
    <p data-following-preview-status role="status" aria-live="polite"></p>
  </form>
  ${view.requested ? "" : ruleLineHtml({ ...view, requested: true, ruleSentence: composeWatchRuleSentence(view.lens, view.filter), citywideDailyWarn: false })}`;
}

function personalSectionHtml(view) {
  // Mid-create: collapse the (often empty) saved-watches region so it is not
  // dead weight above the criteria → matches → create flow. Client promotes
  // this section when a recognized session has one or more watches.
  const demoted = !!view.requested;
  const list = `<div data-personal-watch-list><p>Open a CityScroll email to see your watches.</p></div><p data-personal-status role="status" aria-live="polite"></p>`;
  if (demoted) {
    return `<section id="your-following" class="following-personal following-personal--demoted" data-following-panel="watches" data-following-personal-mode="demoted" aria-labelledby="following-personal-heading">
      <details class="following-personal-details">
        <summary><span class="following-kicker">Saved</span> <span id="following-personal-heading">Your watches</span></summary>
        ${list}
      </details>
    </section>`;
  }
  return `<section id="your-following" class="following-personal" data-following-panel="watches" data-following-personal-mode="secondary" aria-labelledby="following-personal-heading">
    <p class="following-kicker">Saved</p><h2 id="following-personal-heading">Your watches</h2>${list}
  </section>`;
}

function createSectionHtml(view) {
  return `<section id="create" class="following-create" data-following-panel="create" aria-labelledby="following-create-heading">
    <p class="following-kicker">Create</p>
    <h2 id="following-create-heading">Pick a topic or place</h2>
    ${controlsHtml(view)}
  </section>`;
}

function surfaceTabsHtml() {
  // Client promotes “Your watches” when a recognized session has saved watches.
  return `<nav class="following-surface-tabs" data-following-tabs hidden role="tablist" aria-label="Following sections">
    <button type="button" class="following-surface-tab" role="tab" id="following-tab-watches" data-following-tab="watches" aria-controls="your-following" aria-selected="false">Your watches</button>
    <button type="button" class="following-surface-tab" role="tab" id="following-tab-create" data-following-tab="create" aria-controls="create" aria-selected="true">Create a watch</button>
    <button type="button" class="following-surface-tab" role="tab" id="following-tab-packs" data-following-tab="packs" aria-controls="packs" aria-selected="false">Watch sets</button>
  </nav>`;
}

export function renderFollowingBody(view) {
  const create = createSectionHtml(view);
  // Handoff landing: scope chips + count + rule line before email (workspace order).
  // Panel workspace attribute supports the multi-watch surface tabs from main.
  const identity = view.requested ? followingWatchIdentityHtml(view.graphContext) : "";
  const workspace = `<div class="following-workspace" data-following-workspace data-following-panel-workspace>${identity}${scopeHtml(view)}${previewHtml(view)}${subscribeHtml(view)}</div>`;
  const personal = personalSectionHtml(view);
  const packs = `<section id="packs" class="following-packs" data-following-panel="packs" aria-labelledby="following-packs-heading"><p class="following-kicker">Start with a set</p><h2 id="following-packs-heading">Watch sets</h2><div>${view.templates.map(templateHtml).join("")}</div></section>`;
  // Create flow leads for first-time / empty sessions; client reorders when
  // a recognized multi-watch account loads.
  return `<main id="main" data-following-root data-personal-url="${API_BASE}/following/personal"
    data-following-layout="${view.requested ? "create-first" : "browse"}"
    data-msg-duplicate="You already follow these filters. Manage the saved watch instead of making a copy."
    data-msg-preview-loading="Updating the preview…"
    data-msg-preview-ready="Preview updated."
    data-msg-preview-error="The quick preview is not ready. Submit again to open the full preview."
    data-msg-submit-loading="Sending a link…"
    data-msg-submit-ready="Check your inbox. The watch starts after you click the link."
    data-msg-submit-error="We could not send the link. Check the address and try again."
    data-msg-personal-saving="Saving…"
    data-msg-personal-saved="Saved."
    data-msg-personal-error="Could not save that change. Try again."
    data-msg-citywide-daily-warn="This daily watch covers the whole city. Quiet days stay quiet. A match in any borough can email you. Pick a place or choose weekly to cut noise."
    data-following-lens="${esc(view.lens)}"
    data-following-filter="${esc(JSON.stringify(view.filter))}">
    <section class="following-hero">
      <h1>Following</h1>
    </section>
    ${surfaceTabsHtml()}
    ${create}
    ${workspace}
    ${personal}
    ${packs}
  </main>`;
}

export function renderFollowingDocument(view, options = {}) {
  const assetPrefix = options.assetPrefix || "/";
  const prefix = assetPrefix.endsWith("/") ? assetPrefix : `${assetPrefix}/`;
  const siteBase = String(options.siteBase || "").replace(/\/$/, "");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Following · CityScroll</title><meta name="description" content="Preview, create, and manage CityScroll watches and district updates.">
<link rel="canonical" href="https://cityscroll.org/following/">${renderCivicDocumentAssets(assetPrefix)}</head>
<body><a class="skip" href="#main">Skip to content</a>
${renderCivicDocumentMast({ current: "following", siteBase, surfaceClass: "following-mast" })}
${renderFollowingBody(view)}
<footer class="following-footer">Check each item at its source.</footer>
<script defer src="${esc(prefix)}analytics.js?v=1.3.0"></script>
<script type="module" src="${esc(prefix)}app/following.mjs"></script></body></html>`.replace(/[ \t]+$/gm, "");
}
