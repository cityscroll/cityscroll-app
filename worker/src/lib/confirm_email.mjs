// Pure helpers for the double-opt-in confirmation email + the user-facing confirm/unsubscribe
// landing pages. describeFilter() renders a stored lens filter back into plain English so the
// confirm email restates exactly what the user asked for — catching a model misread before the
// alert ever goes live. No I/O, so it's unit-tested on its own.
import { emailT } from "./i18n.mjs";

const LENS_LABEL = {
  money: "contract money",
  people: "people & roles",
  land: "land & rezonings",
  property: "property notices",
  rules: "rules & notices",
  meetings: "public meetings",
};
const usd = (n) => "$" + Number(n).toLocaleString("en-US");
const esc = (s) => String(s == null ? "" : s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

// A stored lens filter → one human-readable line.
export function describeFilter(lens, filter) {
  const f = filter || {};
  if (lens === "award") {
    return `award watch — notice ${f.requestId || "?"}${f.agency ? ` (${f.agency})` : ""} — you'll hear when the award registers`;
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
  if (f.months) parts.push(`due within ${f.months} mo`);
  if (f.status === "all") parts.push("including closed");
  const detail = parts.length ? parts.join(" · ") : "all notices";
  return `${LENS_LABEL[lens] || lens} — ${detail}`;
}

export function confirmSubject(lang = "en") {
  return emailT(lang, "confirm_subject");
}

export function confirmEmailHtml({ confirmUrl, lens, filter, freq = "daily", lang = "en" }) {
  const desc = esc(describeFilter(lens, filter));
  return `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#1a1714">
    <h2 style="font-family:system-ui">${esc(emailT(lang, "confirm_heading"))}</h2>
    <p>${esc(emailT(lang, "confirm_someone_asked"))}</p>
    <p style="background:#faf6ee;border:1px solid #cdbfa6;border-radius:8px;padding:12px 14px;font-weight:bold">${desc}<br>
      <span style="font-weight:normal;color:#5c5349">${esc(freq)} · by email</span></p>
    <p><a href="${esc(confirmUrl)}" style="display:inline-block;background:#7a1f1f;color:#fff;text-decoration:none;font-family:system-ui;font-weight:bold;padding:13px 24px;border-radius:8px">${esc(emailT(lang, "confirm_btn"))}</a></p>
    <p style="color:#5c5349;font-size:13px">${esc(emailT(lang, "confirm_expires"))}</p>
    <p style="color:#5c5349;font-size:12px;border-top:1px solid #cdbfa6;padding-top:10px">${esc(emailT(lang, "confirm_didnt_ask"))}</p>
  </div>`;
}

// Minimal styled landing page for the GET confirm / unsubscribe responses. `message` is
// trusted HTML the caller assembles (never raw user input); `title` is escaped.
export function htmlPage(title, message) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · CROL-List</title>
<body style="margin:0;background:#f4efe4;color:#1a1714;font:17px/1.6 Georgia,serif">
<div style="max-width:520px;margin:14vh auto;padding:0 24px;text-align:center">
  <div style="font:700 13px/1 system-ui;letter-spacing:.18em;text-transform:uppercase;color:#7a1f1f">CROL-List</div>
  <h1 style="font-size:28px;margin:14px 0 8px">${esc(title)}</h1>
  <p style="color:#3b342c">${message}</p>
  <p style="margin-top:24px"><a href="https://crol-list.org" style="color:#7a1f1f">← crol-list.org</a></p>
</div>`;
}
