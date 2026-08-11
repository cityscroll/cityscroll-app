/**
 * Sparse Borough President ULURP recommendation panel for Land detail.
 *
 * Renders only when the receipt-gated lookup has a strict ULURP-token hit for
 * the open ZAP project. Absent hits omit the panel entirely (no apology box).
 * Property Disposition is the wrong universe and never mounts this panel.
 */

import { extractUlurpKeys } from "./ulurp_tokens.mjs";

export const ULURP_RECOMMENDATION_LOOKUP_SCHEMA = "cityscroll.ulurp_recommendations.lookup.v1";

function clean(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || null;
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

function cleanUrl(value) {
  const s = clean(value);
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

function summarizeUlurpRecommendation(row, { kind = "recommendation" } = {}) {
  if (!row || typeof row !== "object") {
    return { kind, ulurp_numbers: null, position: null, date: null, pdf_url: null, project: null };
  }
  if (kind === "pdf" || row.pdf_download) {
    return {
      kind: "pdf",
      ulurp_numbers: clean(row.ulurp_application_number),
      position: null,
      date: isoDate(row.date),
      pdf_url: cleanUrl(row.pdf_download),
      project: clean(row.project),
      community_board: null,
      council_district: null,
    };
  }
  return {
    kind: "recommendation",
    ulurp_numbers: clean(row.ulurp_number_s),
    position: clean(row.borough_president),
    date: isoDate(row.recommendation_date),
    pdf_url: null,
    project: clean(row.ulurp_application_name),
    community_board: clean(row.community_board_s),
    council_district: clean(row.council_district_s),
  };
}

/** Reject Property Disposition / non-ZAP contexts. */
export function isUlurpRecommendationEligible(project = {}) {
  if (!project || typeof project !== "object") return false;
  if (project.wrong_universe === "property_disposition") return false;
  const lens = clean(project.lens || project.section_name || project.section);
  if (lens && /property\s*disposition/i.test(lens)) return false;
  const status = clean(project.public_status || project.project_status);
  if (status && /property disposition/i.test(status)) return false;
  return !!(
    clean(project.project_id) ||
    clean(project.ulurp_numbers) ||
    (Array.isArray(project.ulurp_keys) && project.ulurp_keys.length)
  );
}

export function acceptedUlurpRecommendationLookup(lookup) {
  return !!(
    lookup &&
    lookup.schema === ULURP_RECOMMENDATION_LOOKUP_SCHEMA &&
    lookup.bridge?.status === "accepted" &&
    lookup.bridge?.materialize === true &&
    lookup.by_ulurp_key &&
    typeof lookup.by_ulurp_key === "object"
  );
}

/**
 * Resolve recommendation + PDF rows for a ZAP project via strict ULURP tokens.
 * @returns {{ keys: string[], recommendations: object[], pdfs: object[] } | null}
 */
export function recommendationsForProject(lookup, project = {}) {
  if (!acceptedUlurpRecommendationLookup(lookup) || !isUlurpRecommendationEligible(project)) {
    return null;
  }
  const keys = new Set();
  for (const k of extractUlurpKeys(project.ulurp_numbers)) keys.add(k);
  for (const k of project.ulurp_keys || []) {
    const n = clean(k)?.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (n) keys.add(n);
  }
  if (!keys.size) return null;

  const recommendations = [];
  const pdfs = [];
  const seen = new Set();
  for (const key of [...keys].sort()) {
    const bag = lookup.by_ulurp_key[key];
    if (!bag) continue;
    for (const row of bag.recommendations || []) {
      const id = rowIdentity(row, "recommendation");
      if (seen.has(id)) continue;
      seen.add(id);
      recommendations.push(summarizeUlurpRecommendation(row, { kind: "recommendation" }));
    }
    for (const row of bag.pdfs || []) {
      const id = rowIdentity(row, "pdf");
      if (seen.has(id)) continue;
      seen.add(id);
      pdfs.push(summarizeUlurpRecommendation(row, { kind: "pdf" }));
    }
  }
  if (!recommendations.length && !pdfs.length) return null;
  return { keys: [...keys].sort(), recommendations, pdfs };
}

function rowIdentity(row, kind) {
  if (!row || typeof row !== "object") return String(row);
  return [
    kind,
    row.ulurp_number_s || row.ulurp_application_number || "",
    row.recommendation_date || row.date || "",
    row.borough_president || row.pdf_download || row.project || "",
  ].join("|");
}

/**
 * Pure HTML for the sparse panel. Empty string when there is nothing to show.
 */
export function renderUlurpRecommendationPanel(hit, {
  esc = (value) => String(value ?? ""),
  externalLinkAttributes = 'target="_blank" rel="noopener noreferrer"',
} = {}) {
  if (!hit || (!hit.recommendations?.length && !hit.pdfs?.length)) return "";
  // Sparse historical catalog: plain English only (not a primary translated surface).
  const recLines = (hit.recommendations || []).map((rec) => {
    const position = esc(rec.position || "Position recorded");
    const date = rec.date ? ` · ${esc(rec.date)}` : "";
    const project = rec.project ? ` — ${esc(rec.project)}` : "";
    const place = [rec.community_board, rec.council_district]
      .filter(Boolean)
      .map((v) => esc(v))
      .join(" · ");
    return `<li class="ulurp-rec-item"><span class="ulurp-rec-position">${position}</span>${date}${project}${
      place ? `<div class="muted">${place}</div>` : ""
    }</li>`;
  });
  const pdfLines = (hit.pdfs || []).map((pdf) => {
    const label = esc(pdf.project || pdf.ulurp_numbers || "Recommendation letter");
    const date = pdf.date ? ` · ${esc(pdf.date)}` : "";
    if (pdf.pdf_url) {
      return `<li class="ulurp-rec-pdf"><a class="view" href="${esc(pdf.pdf_url)}" ${externalLinkAttributes}>${label}</a>${date}</li>`;
    }
    return `<li class="ulurp-rec-pdf">${label}${date}</li>`;
  });
  return `<section class="ulurp-recommendation-panel" aria-label="Borough President recommendations">
  <h3 class="ulurp-rec-heading">Borough President recommendations</h3>
  <p class="muted ulurp-rec-scope">Historical Borough President positions matched by ULURP number. Sparse, borough-scoped catalog—not a citywide live feed.</p>
  ${recLines.length ? `<ul class="ulurp-rec-list">${recLines.join("")}</ul>` : ""}
  ${pdfLines.length ? `<ul class="ulurp-rec-pdfs">${pdfLines.join("")}</ul>` : ""}
</section>`;
}

let lookupPromise;

/** Browser mount: fill host when a lookup hit exists; leave host empty otherwise. */
export async function loadUlurpRecommendationPanel(host, project, {
  esc = (value) => String(value ?? ""),
  externalLinkAttributes = 'target="_blank" rel="noopener noreferrer"',
  fetchImpl = globalThis.fetch?.bind(globalThis),
} = {}) {
  if (!host || !isUlurpRecommendationEligible(project)) {
    if (host) host.innerHTML = "";
    return null;
  }
  lookupPromise ||= (fetchImpl
    ? fetchImpl("./data/ulurp_recommendations_lookup.json", {
      credentials: "omit",
      cache: "no-cache",
    }).then((r) => (r?.ok ? r.json() : null)).catch(() => null)
    : Promise.resolve(null));
  const lookup = await lookupPromise;
  const hit = recommendationsForProject(lookup, project);
  host.innerHTML = hit
    ? renderUlurpRecommendationPanel(hit, { esc, externalLinkAttributes })
    : "";
  return hit;
}
