import { scopeFromWatch, watchFromScope } from "./scope_v0.mjs";
import { normalizeWatchTemplateRegistry } from "./watch_templates.mjs";
import { migrateLegacyUrl } from "./route_migration.mjs";
import {
  renderCivicDocumentAssets,
  renderCivicDocumentMast,
} from "./civic_document_chrome.mjs";

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
  district: "District digest",
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
    ["deliverable type", filter.deliverable_type],
    ["deadline window", typeof filter.windowDays === "number" ? `next ${filter.windowDays} days` : null],
    ["exam number", Array.isArray(filter.examNumber) ? filter.examNumber.join(", ") : filter.examNumber],
    ["subject ref", Array.isArray(filter.subject_refs_all) && filter.subject_refs_all.length ? filter.subject_refs_all.join(", ") : null],
  ];
  for (const [axis, label] of values) if (label) chips.push({ axis, label: String(label) });
  return chips;
}

export function buildFollowingViewModel(input = {}, templateRegistry = {}) {
  const watch = normalizedWatch(input.lens || "money", input.filter || {});
  const requested = input.requested == null
    ? !!(input.lens || Object.keys(input.filter || {}).length || input.previewItems)
    : !!input.requested;
  const previewItems = Array.isArray(input.previewItems) ? input.previewItems.slice(0, 5) : [];
  const matchCount = cleanCount(input.matchCount);
  const registry = normalizeWatchTemplateRegistry(templateRegistry);
  return {
    schema: "cityscroll.following_view.v1",
    ...watch,
    requested,
    frequency: cleanFrequency(input.frequency),
    matchCount: matchCount == null && requested ? previewItems.length : matchCount,
    previewItems,
    previewError: input.previewError || null,
    scopeSummary: scopeSummary(watch.lens, watch.filter),
    templates: registry.templates,
    followingUrl: followingUrlFromWatch(watch, {
      frequency: cleanFrequency(input.frequency),
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
  const on = active ? " on" : "";
  const current = active ? ' aria-current="page"' : "";
  return `<a class="chip following-scope-link${on}" href="${esc(href)}" data-following-scope-axis="${esc(axis)}" data-following-scope-value="${esc(value)}" data-scope-edge="following.${esc(axis)}.${esc(value || "all")}"${current}>${esc(label)}</a>`;
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

function scopeHtml(view) {
  if (!view.requested) return "";
  const chips = view.scopeSummary.map((chip) => `<li data-scope-axis="${esc(chip.axis)}">${esc(chip.label)}</li>`).join("");
  return `<section class="following-scope" data-following-scope-panel aria-labelledby="following-scope-heading">
    <h2 id="following-scope-heading">Watch criteria</h2>
    <ul aria-label="Watch criteria">${chips}</ul>
  </section>`;
}

function previewItem(item) {
  const mapped = migrateLegacyUrl(item.url || "/browse/");
  return `<li data-preview-id="${esc(item.id)}"><a href="${esc(mapped.target)}">${esc(item.title || "Untitled record")}</a>${item.summary ? `<p>${esc(item.summary)}</p>` : ""}</li>`;
}

function previewHtml(view) {
  if (!view.requested) return "";
  const count = view.matchCount ?? view.previewItems.length;
  const body = view.previewError
    ? `<p class="following-note" role="status">${esc(view.previewError)}</p>`
    : view.previewItems.length
      ? `<ol>${view.previewItems.map(previewItem).join("")}</ol>`
      : `<p class="following-empty">No records match now. The watch can still tell you when a new match appears.</p>`;
  return `<section class="following-preview" data-following-preview-panel data-scope-count="${count}" aria-labelledby="following-preview-heading">
    <p class="following-kicker">Preview</p><h2 id="following-preview-heading">${count} matching records</h2>
    <p>${view.previewItems.length < count ? `${view.previewItems.length} recent matches are shown.` : "Every current match is shown."}</p>
    ${body}
  </section>`;
}

function subscribeHtml(view) {
  if (!view.requested) return `<section class="following-subscribe" data-following-subscribe-panel><h2>Create a watch</h2><p>Pick a topic or place to see matches.</p></section>`;
  return `<section class="following-subscribe" data-following-subscribe-panel aria-labelledby="following-subscribe-heading">
    <p class="following-kicker">Delivery</p><h2 id="following-subscribe-heading">Create this watch</h2>
    <form method="post" action="${API_BASE}/subscribe" data-following-subscribe-form>
      <input type="hidden" name="lens" value="${esc(view.lens)}">
      <input type="hidden" name="filter" value="${esc(JSON.stringify(view.filter))}">
      <input type="hidden" name="freq" value="${esc(view.frequency)}">
      <input type="hidden" name="lang" value="en">
      <label>Email address<input type="email" name="email" required autocomplete="email" inputmode="email" aria-describedby="following-confirm-note"></label>
      <button type="submit">Email me this watch</button>
      <p id="following-confirm-note">We send one link first. Click it to start the watch.</p>
      <p data-following-submit-status role="status" aria-live="polite"></p>
    </form>
  </section>`;
}

function templateHtml(template) {
  const watches = template.watches.map((watch) => `<li>${esc(watch.label)}.</li>`).join("");
  const href = `/following/packs/${encodeURIComponent(template.id)}/`;
  return `<article class="following-pack"><h3>${esc(template.title)}</h3><p>This pack has ${template.watches.length} watches.</p><details><summary>Show watches</summary><ul>${watches}</ul></details><a href="${esc(href)}">Open this pack</a></article>`;
}

function controlsHtml(view) {
  const query = Array.isArray(view.filter.keywords) ? view.filter.keywords.join(" ") : "";
  const borough = placeBorough(view.filter);
  return `${topicPlacePickersHtml(view)}
  <form class="following-form" method="get" action="${SITE_BASE}/following" data-following-preview-form>
    <input type="hidden" name="lens" value="${esc(view.lens)}">
    <input type="hidden" name="filter" value="${esc(JSON.stringify(view.filter))}">
    ${borough ? `<input type="hidden" name="boro" value="${esc(borough)}">` : ""}
    <label>Keyword<input name="q" value="${esc(query)}" placeholder="housing, school buses, curb…"></label>
    <label>Agency<input name="agency" value="${esc(view.filter.agency || "")}" placeholder="Any agency"></label>
    <label>Council district<input name="council" value="${esc(view.filter.councilDistrict || "")}" inputmode="numeric" pattern="(?:[1-9]|[1-4][0-9]|5[01])" placeholder="1–51"></label>
    <label>Cadence<select name="freq"><option value="daily"${view.frequency === "daily" ? " selected" : ""}>Daily</option><option value="weekly"${view.frequency === "weekly" ? " selected" : ""}>Weekly, Mondays</option></select></label>
    <button type="submit">See matches</button>
    <p data-following-preview-status role="status" aria-live="polite"></p>
  </form>`;
}

function personalSectionHtml(view) {
  // Mid-create: collapse the (often empty) saved-watches region so it is not
  // dead weight above the criteria → matches → create flow.
  const demoted = !!view.requested;
  const list = `<div data-personal-watch-list><p>Open a CityScroll email to see your watches.</p></div><p data-personal-status role="status" aria-live="polite"></p>`;
  if (demoted) {
    return `<section id="your-following" class="following-personal following-personal--demoted" data-following-personal-mode="demoted" aria-labelledby="following-personal-heading">
      <details class="following-personal-details">
        <summary><span class="following-kicker">Saved</span> <span id="following-personal-heading">Your watches</span></summary>
        ${list}
      </details>
    </section>`;
  }
  return `<section id="your-following" class="following-personal" data-following-personal-mode="secondary" aria-labelledby="following-personal-heading">
    <p class="following-kicker">Saved</p><h2 id="following-personal-heading">Your watches</h2>${list}
  </section>`;
}

function createSectionHtml(view) {
  return `<section id="create" class="following-create" aria-labelledby="following-create-heading">
    <p class="following-kicker">Create</p>
    <h2 id="following-create-heading">Pick a topic or place</h2>
    ${controlsHtml(view)}
  </section>`;
}

export function renderFollowingBody(view) {
  const create = createSectionHtml(view);
  const workspace = `<div class="following-workspace" data-following-workspace>${scopeHtml(view)}${previewHtml(view)}${subscribeHtml(view)}</div>`;
  const personal = personalSectionHtml(view);
  const packs = `<section id="packs" class="following-packs" aria-labelledby="following-packs-heading"><p class="following-kicker">Start with a set</p><h2 id="following-packs-heading">Watch sets</h2><div>${view.templates.map(templateHtml).join("")}</div></section>`;
  // Create flow leads; saved watches are secondary (collapsed when mid-create).
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
    data-msg-personal-error="Could not save that change. Try again.">
    <section class="following-hero">
      <h1>Following</h1>
    </section>
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
