import { scopeFromWatch, watchFromScope } from "./scope_v0.mjs";
import { normalizeWatchTemplateRegistry } from "./watch_templates.mjs";
import { migrateLegacyUrl } from "./route_migration.mjs";
import {
  renderCivicDocumentAssets,
  renderCivicDocumentMast,
} from "./civic_document_chrome.mjs";

const API_BASE = "https://api.cityscroll.org";
const SITE_BASE = "https://cityscroll.org";
const LENSES = Object.freeze(["money", "people", "land", "property", "rules", "meetings", "district", "entity"]);
const LENS_LABELS = Object.freeze({
  money: "Contracts and RFPs",
  people: "Staffing and exams",
  land: "Zoning",
  property: "Property",
  rules: "Rules",
  meetings: "Hearings and meetings",
  district: "District digest",
  entity: "Agency or vendor",
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

function first(values) {
  return Array.isArray(values) && values.length ? values[0] : null;
}

function normalizedWatch(lens, filter) {
  const wantedLens = LENSES.includes(lens) ? lens : "money";
  const watch = watchFromScope(scopeFromWatch({ lens: wantedLens, filter: compact(filter) }), { lens: wantedLens });
  return { lens: watch.lens, filter: compact(watch.filter) };
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
  const lens = LENSES.includes(params.get("lens")) ? params.get("lens") : "money";
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

function lensOptions(current) {
  return LENSES.map((lens) => `<option value="${lens}"${lens === current ? " selected" : ""}>${esc(LENS_LABELS[lens])}</option>`).join("");
}

function boroughOptions(current) {
  return `<option value="">Any borough</option>${BOROUGHS.map((borough) => `<option${borough === current ? " selected" : ""}>${borough}</option>`).join("")}`;
}

function scopeHtml(view) {
  const chips = view.scopeSummary.map((chip) => `<li data-scope-axis="${esc(chip.axis)}">${esc(chip.label)}</li>`).join("");
  return `<section class="following-scope" data-following-scope-panel aria-labelledby="following-scope-heading">
    <p class="following-kicker">Saved filters</p>
    <h2 id="following-scope-heading">What this watch follows</h2>
    <ul aria-label="Watch criteria">${chips}</ul>
    <p>The preview and each email use these same terms. There is no second set of filters.</p>
  </section>`;
}

function previewItem(item) {
  const mapped = migrateLegacyUrl(item.url || "/browse/");
  return `<li data-preview-id="${esc(item.id)}"><a href="${esc(mapped.target)}">${esc(item.title || "Untitled record")}</a>${item.summary ? `<p>${esc(item.summary)}</p>` : ""}</li>`;
}

function previewHtml(view) {
  if (!view.requested) {
    return `<section class="following-preview" data-following-preview-panel data-following-empty aria-labelledby="following-preview-heading">
      <p class="following-kicker">Preview</p><h2 id="following-preview-heading">Choose a topic or place</h2>
      <p>Choose some filters. See what they find before you ask for email.</p>
    </section>`;
  }
  const count = view.matchCount ?? view.previewItems.length;
  const body = view.previewError
    ? `<p class="following-note" role="status">${esc(view.previewError)}</p>`
    : view.previewItems.length
      ? `<ol>${view.previewItems.map(previewItem).join("")}</ol>`
      : `<p class="following-empty">No records match now. The watch can still tell you when a new match appears.</p>`;
  return `<section class="following-preview" data-following-preview-panel data-scope-count="${count}" aria-labelledby="following-preview-heading">
    <p class="following-kicker">Preview</p><h2 id="following-preview-heading">${count} records match these saved filters</h2>
    <p>${view.previewItems.length < count ? `${view.previewItems.length} recent matches are shown.` : "Every current match is shown."}</p>
    ${body}
  </section>`;
}

function subscribeHtml(view) {
  if (!view.requested) return `<section class="following-subscribe" data-following-subscribe-panel><h2>Create a watch</h2><p>Preview your filters first. The preview becomes the saved watch.</p></section>`;
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
  const firstWatch = template.watches[0];
  const href = followingUrlFromWatch(firstWatch, { frequency: "weekly" });
  return `<article class="following-pack"><h3>${esc(template.title)}</h3><p>This pack saves ${template.watches.length} watches. Open it to see each one.</p><details><summary>Show saved watches</summary><ul>${watches}</ul></details><a href="${esc(href)}">Preview one watch</a></article>`;
}

function controlsHtml(view) {
  const query = Array.isArray(view.filter.keywords) ? view.filter.keywords.join(" ") : "";
  const borough = view.filter.borough || view.filter.boro || "";
  return `<form class="following-form" method="get" action="${SITE_BASE}/following" data-following-preview-form>
    <input type="hidden" name="filter" value="${esc(JSON.stringify(view.filter))}">
    <label>Topic<select name="lens">${lensOptions(view.lens)}</select></label>
    <label>Keyword<input name="q" value="${esc(query)}" placeholder="housing, school buses, curb…"></label>
    <label>Agency<input name="agency" value="${esc(view.filter.agency || "")}" placeholder="Any agency"></label>
    <label>Borough<select name="boro">${boroughOptions(borough)}</select></label>
    <label>Council district<input name="council" value="${esc(view.filter.councilDistrict || "")}" inputmode="numeric" pattern="(?:[1-9]|[1-4][0-9]|5[01])" placeholder="1–51"></label>
    <label>Cadence<select name="freq"><option value="daily"${view.frequency === "daily" ? " selected" : ""}>Daily</option><option value="weekly"${view.frequency === "weekly" ? " selected" : ""}>Weekly, Mondays</option></select></label>
    <button type="submit">Preview these filters</button>
    <p data-following-preview-status role="status" aria-live="polite"></p>
  </form>`;
}

export function renderFollowingBody(view) {
  return `<main id="main" data-following-root data-personal-url="${API_BASE}/following/personal"
    data-msg-duplicate="You already follow these filters. Manage the saved watch instead of making a copy."
    data-msg-preview-loading="Updating the preview…"
    data-msg-preview-ready="Preview updated. The saved terms did not change."
    data-msg-preview-error="The quick preview is not ready. Submit again to open the full preview."
    data-msg-submit-loading="Sending a link…"
    data-msg-submit-ready="Check your inbox. The watch starts after you click the link."
    data-msg-submit-error="We could not send the link. Check the address and try again.">
    <section class="following-hero">
      <p class="following-kicker">All your watches</p><h1>Following</h1>
      <p>Save a set of filters once. See what it finds. Pick when it comes. Change each watch here.</p>
      <nav aria-label="Following sections"><a href="#create">Create a watch</a><a href="#packs">Monitor packs</a><a href="#your-following">Your following</a></nav>
    </section>
    <section class="following-explainer" aria-label="What Following includes">
      <article><h2>Watches</h2><p>A watch saves your filters from Browse, Now, or Near you.</p></article>
      <article><h2>Sets of watches</h2><p>A monitor pack saves a set of watches. You can see and change each one.</p></article>
      <article><h2>District digests</h2><p>A district watch can send one email each week. It can track deals, events, land, and homes.</p></article>
      <article><h2>One digest</h2><p>One email groups the new matches from all your watches.</p></article>
    </section>
    <section id="create" class="following-create" aria-labelledby="following-create-heading"><p class="following-kicker">Create</p><h2 id="following-create-heading">Follow a topic or place</h2>${controlsHtml(view)}</section>
    <div class="following-workspace">${scopeHtml(view)}${previewHtml(view)}${subscribeHtml(view)}</div>
    <section id="packs" class="following-packs" aria-labelledby="following-packs-heading"><p class="following-kicker">Sets to start with</p><h2 id="following-packs-heading">Monitor packs</h2><div>${view.templates.map(templateHtml).join("")}</div></section>
    <section class="following-privacy" aria-labelledby="following-privacy-heading"><p class="following-kicker">Email and privacy</p><h2 id="following-privacy-heading">Confirm first</h2><p>This is called double opt-in. We send one link. Click it to start the watch. Until then, we save nothing. Each email has a link to change or stop the watch. You do not need to sign in to use the preview.</p></section>
    <section id="your-following" class="following-personal" aria-labelledby="following-personal-heading"><p class="following-kicker">Your saved watches</p><h2 id="following-personal-heading">Your following</h2><div data-personal-watch-list><p>Open a link from one of our emails. Your watches can then show here.</p><p><a href="${SITE_BASE}/prefs">Manage from a CityScroll email</a></p></div></section>
  </main>`;
}

export function renderFollowingDocument(view, options = {}) {
  const assetPrefix = options.assetPrefix || "/";
  const prefix = assetPrefix.endsWith("/") ? assetPrefix : `${assetPrefix}/`;
  const siteBase = String(options.siteBase || "").replace(/\/$/, "");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Following · CityScroll</title><meta name="description" content="Preview, create, and manage CityScroll watches, monitor packs, digests, and district updates.">
<link rel="canonical" href="https://cityscroll.org/following/">${renderCivicDocumentAssets(assetPrefix)}</head>
<body><a class="skip" href="#main">Skip to content</a>
${renderCivicDocumentMast({ current: "following", siteBase, surfaceClass: "following-mast" })}
${renderFollowingBody(view)}
<footer class="following-footer">The preview and each email use the same saved terms. Check each item at its source.</footer>
<script type="module" src="${esc(prefix)}app/following.mjs"></script></body></html>`.replace(/[ \t]+$/gm, "");
}
