// Pure helpers for the double-opt-in confirmation email + the user-facing confirm/unsubscribe
// landing pages. describeFilter() renders a stored lens filter back into plain English so the
// confirm email restates exactly what the user asked for — catching a model misread before the
// alert ever goes live. No I/O, so it's unit-tested on its own.
import { emailT } from "./i18n.mjs";

const LENS_LABEL = {
  money: "Contracts and RFPs",
  people: "Staffing and exams",
  land: "Zoning",
  property: "Property",
  rules: "Rules",
  meetings: "Hearings and meetings",
  district: "Council district weekly",
  mandates: "Mandates",
  obligations: "Mandates",
  entity: "Agency or vendor",
};
const usd = (n) => "$" + Number(n).toLocaleString("en-US");
const esc = (s) => String(s == null ? "" : s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

/** Scope chips for confirm email / Following list — plain axis labels. */
export function describeFilterChips(lens, filter) {
  const f = filter || {};
  const chips = [];
  const topic = LENS_LABEL[lens] || lens;
  if (topic) chips.push({ axis: "topic", label: topic });
  if (lens === "district") {
    chips.push({ axis: "council", label: `Council District ${f.councilDistrict || "?"}` });
    return chips;
  }
  if (lens === "mandates" || lens === "obligations") {
    if (f.agency || f.agency_id) chips.push({ axis: "agency", label: String(f.agency || f.agency_id) });
    if (f.deliverable_type) chips.push({ axis: "deliverable", label: String(f.deliverable_type).replace(/_/g, " ") });
    if (f.mandate_id) chips.push({ axis: "mandate", label: String(f.mandate_id) });
    if (typeof f.windowDays === "number") chips.push({ axis: "window", label: `next ${f.windowDays} days` });
    return chips;
  }
  if (lens === "entity") {
    chips.push({ axis: "kind", label: f.kind === "agency" ? "agency" : "vendor" });
    if (f.name) chips.push({ axis: "name", label: String(f.name) });
    return chips;
  }
  const kws = Array.isArray(f.keywords) ? f.keywords.filter(Boolean) : [];
  if (kws.length) chips.push({ axis: "keyword", label: kws.join(" ") });
  if (f.agency) chips.push({ axis: "agency", label: String(f.agency) });
  if (f.boro) chips.push({ axis: "place", label: String(f.boro) });
  if (f.borough) chips.push({ axis: "place", label: String(f.borough) });
  if (f.neighborhood) chips.push({ axis: "place", label: String(f.neighborhood) });
  if (f.councilDistrict) chips.push({ axis: "council", label: `Council District ${f.councilDistrict}` });
  if (f.noticeType === "award") chips.push({ axis: "type", label: "awards" });
  else if (f.noticeType === "solicitation") chips.push({ axis: "type", label: "open solicitations" });
  if (f.minAmount) chips.push({ axis: "min", label: `≥ ${usd(f.minAmount)}` });
  if (f.maxAmount) chips.push({ axis: "max", label: `≤ ${usd(f.maxAmount)}` });
  return chips;
}

// A stored lens filter → one human-readable line.
export function describeFilter(lens, filter) {
  const f = filter || {};
  if (lens === "district") {
    return `Council District ${f.councilDistrict || "?"} weekly digest`;
  }
  if (lens === "mandates" || lens === "obligations") {
    const who = f.agency || f.agency_id || "?";
    if (f.mandate_id) {
      return `Mandate ${f.mandate_id} for ${who}`;
    }
    const type = f.deliverable_type ? String(f.deliverable_type).replace(/_/g, " ") : "";
    if (type === "report") return `${who} report mandates — expected filings`;
    if (type === "rulemaking") return `${who} rulemaking mandates — expected filings`;
    if (type) {
      const window = typeof f.windowDays === "number" ? ` · next ${f.windowDays} days` : "";
      return `${who} ${type} mandates${window}`;
    }
    const window = typeof f.windowDays === "number" ? ` · next ${f.windowDays} days` : "";
    return `${who} mandates — expected filings${window}`;
  }
  if (lens === "people" && f.view === "guide" && f.examNumber) {
    return `Civil-service exam ${f.examNumber} — exact exam updates`;
  }
  if (lens === "people" && f.view === "guide" && f.interestArea) {
    return `Civil-service exams — ${f.interestLabel || f.interestArea}`;
  }
  if (lens === "award") {
    return `Award watch — notice ${f.requestId || "?"}${f.agency ? ` (${f.agency})` : ""} — you'll hear when the award registers`;
  }
  if (lens === "entity") {
    const k = f.kind === "agency" ? "agency" : "vendor";
    return `${k} “${f.name || "?"}” — every new City Record notice naming them`;
  }
  const kws = Array.isArray(f.keywords) ? f.keywords.filter(Boolean) : [];
  const parts = [];
  if (f.lookupType === "person") parts.push(kws.length ? `a person named “${kws.join(" ")}”` : "a person");
  else if (f.lookupType === "role") parts.push(kws.length ? `roles matching “${kws.join(" / ")}”` : "roles");
  else if (kws.length) parts.push(`about “${kws.join(" / ")}”`);
  if (f.noticeType === "award") parts.push("awards only");
  else if (f.noticeType === "solicitation") parts.push("open solicitations only");
  if (f.minAmount) parts.push(`≥ ${usd(f.minAmount)}`);
  if (f.maxAmount) parts.push(`≤ ${usd(f.maxAmount)}`);
  if (f.category) parts.push(`category “${f.category}”`);
  if (f.agency) parts.push(`agency “${f.agency}”`);
  if (f.boro) parts.push(`in ${f.boro}`);
  if (f.borough) parts.push(`in ${f.borough}`);
  if (f.neighborhood) parts.push(`near ${f.neighborhood}`);
  if (f.process) parts.push(`stage “${({ hearing: "hearing", auction_or_rfp: "auction / RFP", award_or_conveyance: "award / conveyance", unstaged: "unclassified" })[f.process] || String(f.process).replace(/_/g, " ")}”`);
  if (f.stage) parts.push(`when “${f.stage}”`);
  if (f.months) parts.push(`due within ${f.months} mo`);
  if (f.status === "all") parts.push("including closed");
  if (f.connection_relation === "published_by_agency"
      && Array.isArray(f.entity_refs_all) && f.entity_refs_all.length) {
    parts.push("published by this agency");
  }
  const detail = parts.length ? parts.join(" · ") : "all notices";
  return `${LENS_LABEL[lens] || lens} — ${detail}`;
}

export function confirmSubject(lang = "en") {
  return emailT(lang, "confirm_subject");
}

/**
 * Brand-consistent first-touch confirm email: CityScroll mark, scope chips,
 * one large CTA, no marketing chrome. Matches digest action blue (#1a44e0).
 */
export function confirmEmailHtml({ confirmUrl, lens, filter, freq = "daily", lang = "en" }) {
  const desc = esc(describeFilter(lens, filter));
  const chips = describeFilterChips(lens, filter);
  const chipHtml = chips.length
    ? `<p style="margin:10px 0 0">${chips.map((c) => (
      `<span style="display:inline-block;margin:0 6px 6px 0;padding:4px 10px;border:1px solid #c9d5ff;border-radius:999px;background:#eef2ff;color:#10259e;font:600 12px/1.3 system-ui,sans-serif">${esc(c.label)}</span>`
    )).join("")}</p>`
    : "";
  const cadence = String(freq || "daily").toLowerCase() === "weekly" ? "weekly" : "daily";
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;color:#12181f;background:#ffffff">
    <div style="font:700 12px/1 system-ui;letter-spacing:.16em;text-transform:uppercase;color:#1a44e0;margin:0 0 16px">CityScroll</div>
    <h1 style="font:600 24px/1.2 system-ui;margin:0 0 12px;color:#12181f">${esc(emailT(lang, "confirm_heading"))}</h1>
    <p style="margin:0 0 14px;color:#37414d;font:16px/1.55 Georgia,serif">${esc(emailT(lang, "confirm_someone_asked"))}</p>
    <div style="background:#f5f6f8;border:1px solid #dde1e7;border-radius:8px;padding:14px 16px;margin:0 0 20px">
      <p style="margin:0;font:700 16px/1.4 system-ui;color:#12181f">${desc}</p>
      <p style="margin:8px 0 0;font:14px/1.4 system-ui;color:#5b6470">${esc(cadence)} · by email</p>
      ${chipHtml}
    </div>
    <p style="margin:0 0 18px">
      <a href="${esc(confirmUrl)}" style="display:inline-block;background:#1a44e0;color:#ffffff;text-decoration:none;font:700 16px/1.2 system-ui;padding:16px 28px;border-radius:8px">${esc(emailT(lang, "confirm_btn"))}</a>
    </p>
    <p style="margin:0 0 8px;color:#5b6470;font:13px/1.5 system-ui">${esc(emailT(lang, "confirm_expires"))}</p>
    <p style="margin:16px 0 0;padding-top:12px;border-top:1px solid #dde1e7;color:#5b6470;font:12px/1.5 system-ui">${esc(emailT(lang, "confirm_didnt_ask"))}</p>
  </div>`;
}

// Minimal styled landing page for the GET confirm / unsubscribe responses. `message` is
// trusted HTML the caller assembles (never raw user input); `title` is escaped.
export function htmlPage(title, message) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · CityScroll</title>
<body style="margin:0;background:#f5f6f8;color:#12181f;font:17px/1.6 system-ui,-apple-system,Segoe UI,sans-serif">
<div style="max-width:520px;margin:14vh auto;padding:0 24px;text-align:center">
  <div style="font:700 13px/1 system-ui;letter-spacing:.18em;text-transform:uppercase;color:#1a44e0">CityScroll</div>
  <h1 style="font-size:28px;margin:14px 0 8px;font-weight:600">${esc(title)}</h1>
  <p style="color:#37414d">${message}</p>
  <p style="margin-top:24px"><a href="https://cityscroll.org" style="color:#1a44e0">← cityscroll.org</a></p>
</div>`;
}
