// Pure helpers for subscription email and user-facing confirm/unsubscribe landing pages.
// describeFilter() renders a stored lens filter back into plain English. No I/O, so these
// templates are unit-tested on their own.

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
  if (f.family && f.family !== "any") parts.push(`action type “${String(f.family).replace(/_/g, " ")}”`);
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

export function welcomeSubject(lang = "en") {
  return lang === "es" ? "Ya estás suscrito a CityScroll" : "You're subscribed to CityScroll";
}

/** Transactional first-touch sent after the subscription is already active. */
export function welcomeEmailHtml({ manageUrl, unsubscribeUrl, lens, filter, freq = "daily", lang = "en", noTopicDefault = false }) {
  const heading = lang === "es" ? "Ya estás suscrito" : "You're subscribed";
  const intro = noTopicDefault
    ? (lang === "es"
      ? "Estás suscrito al resumen semanal de contratos de NYC. Incluye nuevas licitaciones, adjudicaciones y otros avisos de contratación pública de toda la ciudad."
      : "You're subscribed to the weekly NYC contracts digest. It contains new contract solicitations, awards, and other procurement notices from across the city.")
    : (lang === "es"
      ? `Tu alerta está activa: ${describeFilter(lens, filter)} (${freq === "weekly" ? "semanal" : "diaria"}). Incluye nuevos registros públicos que coincidan con este alcance.`
      : `Your watch is active: ${describeFilter(lens, filter)} (${freq === "weekly" ? "weekly" : "daily"}). It contains new public records that match this scope.`);
  const manage = lang === "es" ? "Administrar suscripción" : "Manage subscription";
  const unsubscribe = lang === "es" ? "Darse de baja" : "Unsubscribe";
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;color:#12181f;background:#ffffff">
    <div style="font:700 12px/1 system-ui;letter-spacing:.16em;text-transform:uppercase;color:#1a44e0;margin:0 0 16px">CityScroll</div>
    <h1 style="font:600 24px/1.2 system-ui;margin:0 0 12px;color:#12181f">${esc(heading)}</h1>
    <p style="margin:0 0 20px;color:#37414d;font:16px/1.55 Georgia,serif">${esc(intro)}</p>
    <p style="margin:0 0 18px">
      <a href="${esc(manageUrl)}" style="display:inline-block;background:#1a44e0;color:#ffffff;text-decoration:none;font:700 16px/1.2 system-ui;padding:16px 28px;border-radius:8px">${esc(manage)}</a>
    </p>
    <p style="margin:16px 0 0;padding-top:12px;border-top:1px solid #dde1e7;color:#5b6470;font:12px/1.5 system-ui"><a href="${esc(unsubscribeUrl)}" style="color:#1a44e0">${esc(unsubscribe)}</a>. ${lang === "es" ? "El cambio es inmediato." : "The change takes effect immediately."}</p>
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
