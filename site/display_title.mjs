/**
 * Total display-name helpers for cards and detail headings.
 *
 * Published names win. Placeholder-like source values are treated as missing. A
 * descriptive fallback is used only when the record itself supplies both the
 * action and place evidence; otherwise the stable publisher identifier remains
 * the honest, searchable name.
 */

const PLACEHOLDER_TITLE = /^\s*(?:null|none|n\/?a|unknown|untitled|unnamed|\((?:untitled|unnamed)(?:\s+[^)]*)?\))\s*$/i;

function text(value) {
  return String(value == null ? "" : value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

export function publishedDisplayTitle(value) {
  const title = text(value);
  return title && !PLACEHOLDER_TITLE.test(title) ? title : "";
}

function communityDistrictLabel(value) {
  const raw = text(value);
  if (!raw) return "";
  const exact = raw.match(/^(?:[MXKQR])?0*(\d{1,2})$/i);
  return exact ? `Community District ${Number(exact[1])}` : "";
}

function landActionLabel(row) {
  const evidence = text(row?.project_brief || row?.actions);
  if (!evidence) return "";
  if (/\b(?:disposition|dispose|sale of city[- ]owned property)\b/i.test(evidence)) return "Property disposition";
  if (/\b(?:zoning map (?:amendment|change)|rezoning|rezone|zone change)\b/i.test(evidence)) return "Zoning change";
  if (/\b(?:zoning text amendment|text amendment)\b/i.test(evidence)) return "Zoning text amendment";
  if (/\bspecial permit\b/i.test(evidence)) return "Special permit";
  if (/\b(?:site selection|selection of a site)\b/i.test(evidence)) return "Site selection";
  if (/\b(?:demapping|de[- ]map)\b/i.test(evidence)) return "Street demapping";
  return "";
}

export function landProjectDisplayTitle(row = {}) {
  const published = publishedDisplayTitle(row.project_name || row.title);
  if (published) return published;

  const action = landActionLabel(row);
  // Source fields: NYC ZAP project records (https://zap.planning.nyc.gov/projects).
  const place = [publishedDisplayTitle(row.borough), communityDistrictLabel(row.community_district)]
    .filter(Boolean).join(", ");
  if (action && place) return `${action} — ${place}`;

  const id = publishedDisplayTitle(row.project_id);
  return id ? `Project ${id}` : "Project";
}

export function noticeDisplayTitle(row = {}, label = "Notice") {
  const published = publishedDisplayTitle(row.short_title || row.title || row.name);
  if (published) return published;
  const id = publishedDisplayTitle(row.request_id || row.id);
  return id ? `${label} ${id}` : label;
}
