/** Small, publisher-specific readers for the fixed consultation pilot.
 *
 * These readers consume retained HTML. They never execute publisher scripts: a
 * Formstack response is the JSON argument embedded in FSForm.render(...).
 */

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

export const CB14_URLS = Object.freeze({
  page: "https://cb14brooklyn.com/city-budget/community-budget-recommendations/",
  form: "https://docs.google.com/forms/d/e/1FAIpQLSde52JfdijqUs_dGI678yM1jvL0aJqLw_7TRoYhEubt9mgyrQ/viewform?usp=send_form",
  shortlinks: Object.freeze([
    "https://forms.gle/t15nswNwmpKTKFaZ8",
    "https://forms.gle/QJfMVoKrzzJQ4dsH7",
  ]),
  pdf: "https://cb14brooklyn.com/wp-content/uploads/2026/06/FY28-Budget-Recommendation-Form-with-QR.pdf",
  archive: "https://cb14brooklyn.com/participate-in-the-budget-process-for-fiscal-year-2027/",
});

export const BLOOMINGDALE_URLS = Object.freeze({
  organizer: "https://edc.nyc/project/bloomingdale-library",
  english: "https://nycedc.formstack.com/forms/bloomingdale_library_and_housing_survey",
  spanish: "https://nycedc.formstack.com/forms/bloomingdale_library_and_housing_survey_sp",
  reviewed_link: "https://edc.nyc/project/bloomingdale-library",
});

const decode = (value) => String(value ?? "")
  .replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
  .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");

function links(html, base) {
  const result = [];
  for (const match of String(html ?? "").matchAll(/<(?:a|iframe)\b[^>]*(?:href|data-src)=["']([^"']+)["'][^>]*>/gi)) {
    try { result.push(new URL(decode(match[1]), base).href); } catch { /* malformed publisher link */ }
  }
  return result;
}

export function canonicalizeGoogleFormUrl(value) {
  const url = new URL(String(value));
  if (url.hostname !== "docs.google.com" || !url.pathname.includes("/forms/d/e/")) return null;
  return `${url.origin}${url.pathname}`;
}

export function parseCb14BudgetPage(html, sourceUrl = CB14_URLS.page) {
  const text = clean(String(html ?? "").replace(/<[^>]+>/g, " "));
  const discovered = links(html, sourceUrl);
  const formLinks = [...new Set(discovered.filter((url) => url.includes("forms.gle/") || url.includes("docs.google.com/forms/")))];
  const iframe = discovered.find((url) => url.includes("docs.google.com/forms/")) || null;
  return {
    round: text.match(/FY\s*2028|fiscal year 2028/i) ? "FY2028" : null,
    deadline: text.match(/September\s+4,\s+2026/i) ? { value: "2026-09-04", precision: "day" } : null,
    form_links: formLinks,
    iframe_url: iframe,
    aliases: [...new Set([...CB14_URLS.shortlinks, ...(formLinks.filter((url) => url.includes("forms.gle/"))), ...(iframe ? [iframe] : [])])],
    archive_url: CB14_URLS.archive,
    archive_is_distinct_round: text.includes("FY2027") ? false : true,
  };
}

export function parseGoogleFormHtml(html) {
  const text = clean(String(html ?? "").replace(/<[^>]+>/g, " "));
  const canonical = [...String(html ?? "").matchAll(/https:\/\/docs\.google\.com\/forms\/d\/e\/[^"'\\ ]+/g)]
    .map((match) => canonicalizeGoogleFormUrl(match[0])).find(Boolean) || null;
  return { canonical_url: canonical, title: text.match(/FY\s*2028[^|<]*/i)?.[0] || null, readable: Boolean(text) };
}

function embeddedJson(html) {
  const text = String(html ?? "");
  const marker = text.search(/formResponse["']?\s*[:=]/i);
  const start = marker < 0 ? -1 : text.indexOf("{", marker);
  if (start < 0) return null;
  let depth = 0; let quote = false; let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (quote) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quote = false; continue; }
    if (char === '"') quote = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  return null;
}

export function decodeFormstackResponse(html) {
  const payload = embeddedJson(html);
  if (!payload) return { readable: false, accepted: false, payload: null };
  const formResponse = payload.formResponse ?? payload;
  const disabled = formResponse.disableSubmission === true || formResponse.disable_submission === true;
  return { readable: true, accepted: !disabled, payload: formResponse };
}

export const parseFormstackHtml = decodeFormstackResponse;

export const CONSULTATION_PILOT_SEEDS = Object.freeze([
  { id: "dot-fast-buses-central-brooklyn", category: "transit", title: "Fast Buses: Central Brooklyn" },
  { id: "dot-coney-island-transportation-study", category: "street_design", title: "Coney Island Transportation Study" },
  { id: "dot-secure-bike-parking", category: "facility_siting", title: "Secure Bike Parking" },
  { id: "dot-public-ebike-charging", category: "facility_siting", title: "Public E-Bike Charging" },
  {
    id: "cb14-community-budget-fy2028", category: "community_budget", title: "Brooklyn CB14 district needs, FY2028", organizer: "Brooklyn Community Board 14",
    round: "FY2028", deadline: { value: "2026-09-04", precision: "day", historical: true },
    channels: [{ kind: "google_form", url: CB14_URLS.form }, { kind: "offline_pdf", url: CB14_URLS.pdf }],
    aliases: CB14_URLS.shortlinks, archive_round: { id: "cb14-community-budget-fy2027", url: CB14_URLS.archive, round: "FY2027" },
  },
  {
    id: "bloomingdale-library-and-housing", category: "library_redevelopment", title: "Bloomingdale Library and Housing", organizer: "NYCEDC",
    channels: [{ kind: "survey", language: "en", url: BLOOMINGDALE_URLS.english }, { kind: "survey", language: "es", url: BLOOMINGDALE_URLS.spanish }],
    deadline: null, organizer_link: BLOOMINGDALE_URLS.reviewed_link, organizer_refresh: { status: "failed", http_status: 403, automated: true },
  },
]);

export function buildPilotMaterialization() {
  return { schema: "cityscroll.consultation_pilot_seed.v1", consultations: CONSULTATION_PILOT_SEEDS.map((seed) => ({ ...seed })) };
}
