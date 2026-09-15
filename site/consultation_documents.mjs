import { materializeConsultations } from "./consultation_acquisition.mjs";

export const CONSULTATION_DOCUMENT_SCHEMA = "cityscroll.consultation_document.v1";
export const CONSULTATIONS_ROUTE = "/consultations/";

const esc = (value) => String(value ?? "").replace(/[&<>\"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[char]));
const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const PILOT_EXTENSIONS = Object.freeze([
  {
    id: "cb14-community-budget-fy2028", title: "Brooklyn CB14 district needs, FY2028", category: "Community budget", organizer: "Brooklyn Community Board 14",
    purpose: "Share district needs and budget recommendations for the next fiscal year.", place: "Community Board 14", deadline: { value: "2026-09-04", precision: "day", historical: true },
    channels: [{ kind: "google_form", label: "View the published form", url: "https://docs.google.com/forms/d/e/1FAIpQLSde52JfdijqUs_dGI678yM1jvL0aJqLw_7TRoYhEubt9mgyrQ/viewform?usp=send_form" }, { kind: "offline_pdf", label: "View the paper form", url: "https://cb14brooklyn.com/wp-content/uploads/2026/06/FY28-Budget-Recommendation-Form-with-QR.pdf" }],
    sources: [{ role: "organizer invitation", url: "https://cb14brooklyn.com/city-budget/community-budget-recommendations/" }],
  },
  {
    id: "bloomingdale-library-and-housing", title: "Bloomingdale Library and Housing", category: "Library redevelopment", organizer: "NYCEDC",
    purpose: "Share feedback about the Bloomingdale library and housing project.", place: "Bloomingdale", deadline: null,
    channels: [{ kind: "survey", language: "en", label: "View the English survey", url: "https://nycedc.formstack.com/forms/bloomingdale_library_and_housing_survey" }, { kind: "survey", language: "es", label: "View the Spanish survey", url: "https://nycedc.formstack.com/forms/bloomingdale_library_and_housing_survey_sp" }],
    sources: [{ role: "organizer project page", url: "https://edc.nyc/project/bloomingdale-library" }],
  },
]);

function sourceMaterialization() {
  const base = materializeConsultations();
  return { ...base, consultations: [...base.consultations, ...PILOT_EXTENSIONS] };
}

export function safeConsultationId(pathname) {
  const match = String(pathname || "").match(/^\/consultations\/([^/?#]{1,160})\/?$/);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

export function consultationHref(id, query = "") {
  const suffix = query ? `?${String(query).replace(/^\?/, "")}` : "";
  return `/consultations/${encodeURIComponent(String(id))}/${suffix}`;
}

function dateLabel(deadline) {
  if (!deadline?.value) return null;
  const value = String(deadline.value);
  const parsed = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return parsed ? `${parsed[2]}/${parsed[3]}/${parsed[1]}` : value;
}

function normalizeRecord(record) {
  const deadline = record.deadline || null;
  const channels = Array.isArray(record.channels) ? record.channels : [];
  const sources = Array.isArray(record.sources) ? record.sources : [];
  const expired = record.lifecycle?.current === "deadline_passed" || Boolean(deadline?.historical);
  return {
    ...record,
    title: clean(record.title),
    organizer: clean(record.organizer) || "Publisher not specified",
    category: clean(record.category) || null,
    geography: record.geography?.labels?.join(", ") || clean(record.place) || null,
    deadline,
    deadlineLabel: dateLabel(deadline),
    lifecycleLabel: expired ? "Deadline passed" : deadline ? "Response date published" : "No response date published",
    channels: channels.map((channel) => ({ ...channel, url: clean(channel.url), open_now: false })),
    sources,
    responseChannels: expired ? [] : channels,
  };
}

export function buildConsultationCollection({ materialization = sourceMaterialization(), query = new URLSearchParams() } = {}) {
  const records = (materialization.consultations || []).map(normalizeRecord);
  const category = clean(query.get?.("category"));
  const place = clean(query.get?.("place"));
  const lifecycle = clean(query.get?.("lifecycle"));
  const filtered = records.filter((record) => {
    if (category && record.category !== category) return false;
    if (place && !(record.geography || "").toLowerCase().includes(place.toLowerCase())) return false;
    if (lifecycle === "closed" && record.lifecycleLabel !== "Deadline passed") return false;
    if (lifecycle === "undated" && record.deadline) return false;
    if (lifecycle === "dated" && !record.deadline) return false;
    return true;
  });
  return { schema: CONSULTATION_DOCUMENT_SCHEMA, records: filtered, total: records.length, query: String(query.toString?.() || "") };
}

export function buildConsultationDetail(id, { materialization = sourceMaterialization(), query = "" } = {}) {
  const record = (materialization.consultations || []).map(normalizeRecord).find((item) => item.id === id);
  return record ? { ...record, schema: CONSULTATION_DOCUMENT_SCHEMA, backHref: `${CONSULTATIONS_ROUTE}${query ? `?${String(query).replace(/^\?/, "")}` : ""}` } : null;
}

function chrome(title, description, body, canonical) {
  return `<!doctype html><html lang="en"><head><base href="/"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · CityScroll</title><meta name="description" content="${esc(description)}"><link rel="canonical" href="https://cityscroll.org${esc(canonical)}"><link rel="stylesheet" href="/brand.css"><link rel="stylesheet" href="/civic-documents.css"></head><body><header class="document-mast"><div class="document-mast-inner"><a class="document-brand brand-lockup home" href="/">CityScroll</a><nav class="document-nav" aria-label="Primary"><a href="/now/">Now</a><a href="/near-you/">Near you</a><a href="/browse/">Browse</a><a href="/consultations/" aria-current="page">Consultations</a><a href="/guide/">Guide</a></nav></div></header><main id="main" data-document-rendered="true" class="civic-document consultation-document" tabindex="-1">${body}</main></body></html>`;
}

function actionHTML(record) {
  if (!record.responseChannels.length) return `<p class="consultation-passed" role="status">The published response date has passed. Response links are retained below as source details.</p>`;
  return `<ul class="consultation-actions">${record.responseChannels.map((channel) => `<li><a href="${esc(channel.url)}" rel="noopener noreferrer">${esc(channel.label || "View response information")}</a>${channel.language ? ` <span lang="en">(${esc(channel.language)})</span>` : ""}</li>`).join("")}</ul>`;
}

export function renderConsultationCollectionDocument(view) {
  const query = new URLSearchParams(view.query || "");
  const categories = [...new Set(view.records.map((record) => record.category).filter(Boolean))].sort();
  const options = (name, values, selected) => `<label>${name}<select name="${name.toLowerCase()}"><option value="">Any</option>${values.map((value) => `<option value="${esc(value)}"${value === selected ? " selected" : ""}>${esc(value)}</option>`).join("")}</select></label>`;
  const rows = view.records.map((record) => `<article class="consultation-row" data-consultation-id="${esc(record.id)}"><div><p class="consultation-kicker">${esc(record.category || "Public invitation")}</p><h2><a href="${esc(consultationHref(record.id, view.query))}">${esc(record.title)}</a></h2><p>${esc(record.organizer)}${record.geography ? ` · ${esc(record.geography)}` : ""}</p><p>${record.deadlineLabel ? `<time datetime="${esc(record.deadline.value)}">Response date: ${esc(record.deadlineLabel)}</time>` : "No response date published"}</p></div><p class="consultation-row-actions"><a class="consultation-inspect" href="#inspect-${esc(record.id)}">Inspect</a> <a href="${esc(consultationHref(record.id, view.query))}">Open details</a></p><details id="inspect-${esc(record.id)}"><summary>Inspect context</summary><p>${esc(record.purpose || "Publisher context is available on the detail document.")}</p><p><a href="${esc(consultationHref(record.id, view.query))}">Open the canonical detail</a></p></details></article>`).join("");
  return chrome("Consultations", "Browse public consultations and inspect their response channels.", `<p class="node-back"><a href="/browse/">Back to Browse</a></p><header><p class="ftype">Resident participation</p><h1>Consultations</h1><p>Public invitations to share feedback, ideas, and priorities. Inspect the context before visiting a provider.</p></header><form method="get" class="consultation-filters" aria-label="Filter consultations">${options("Category", categories, query.get("category"))}<label>Place<input name="place" value="${esc(query.get("place") || "")}"></label><label>Lifecycle<select name="lifecycle"><option value="">Any</option><option value="dated"${query.get("lifecycle") === "dated" ? " selected" : ""}>Dated</option><option value="undated"${query.get("lifecycle") === "undated" ? " selected" : ""}>No date published</option><option value="closed"${query.get("lifecycle") === "closed" ? " selected" : ""}>Deadline passed</option></select></label><button type="submit">Apply filters</button></form><p data-consultation-count="${view.records.length}">${view.records.length} of ${view.total} consultations</p><section class="consultation-list" aria-label="Consultation results">${rows || "<p>No consultations match this scope.</p>"}</section>`, CONSULTATIONS_ROUTE);
}

export function renderConsultationDetailDocument(record) {
  const sourceDetails = record.sources.length ? `<details><summary>Source details</summary><ul>${record.sources.map((source) => `<li><a href="${esc(source.url)}" rel="noopener noreferrer">${esc(source.role || "Publisher source")}</a></li>`).join("")}</ul></details>` : "";
  const dateSection = record.deadlineLabel ? `<p><strong>${record.deadline.historical ? "Published response date (passed)" : "Response date"}:</strong> <time datetime="${esc(record.deadline.value)}">${esc(record.deadlineLabel)}</time></p>` : "";
  return chrome(record.title, `${record.title} consultation details.`, `<p class="node-back"><a href="${esc(record.backHref)}" data-return-focus="consultation-${esc(record.id)}">Back to consultations</a></p><header><p class="ftype">${esc(record.category || "Consultation")}</p><h1>${esc(record.title)}</h1><p class="document-lede">${esc(record.organizer)}${record.geography ? ` · ${esc(record.geography)}` : ""}</p></header><section aria-labelledby="about"><h2 id="about">About this invitation</h2>${record.purpose ? `<p>${esc(record.purpose)}</p>` : ""}${dateSection}<p><strong>Status:</strong> ${esc(record.lifecycleLabel)}</p></section><section aria-labelledby="respond"><h2 id="respond">How to respond</h2>${actionHTML(record)}</section>${sourceDetails}` , consultationHref(record.id));
}
