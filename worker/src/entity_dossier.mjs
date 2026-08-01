// Public entity-centered dossier over canonical entities and immutable source records.
// Read-only: this route never changes links, source observations, or review state.

import {
  PUBLIC_DOSSIER_VERSION,
  serializePublicEntityDossier,
} from "../../entity_resolution/publication/dossier.mjs";

const DOSSIER_CACHE = "public, max-age=300";
export const DOSSIER_RECORD_LIMIT = 250;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": status === 200 ? DOSSIER_CACHE : "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  }[char]));
}

function formattedValue(value) {
  if (typeof value === "number") return new Intl.NumberFormat("en-US").format(value);
  return clean(value);
}

function humanStatus(value) {
  return clean(value).replace(/_/g, " ").replace(/^./, (letter) => letter.toUpperCase());
}

function observedTime(value) {
  const text = clean(value);
  const date = new Date(text);
  if (!text || Number.isNaN(date.valueOf())) return text;
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date) + " UTC";
}

function sourceLink(source = {}) {
  const label = `${clean(source.system)} · ${clean(source.id)}`;
  return source.url
    ? `<a href="${escapeHtml(source.url)}" rel="noopener">${escapeHtml(label)}</a>`
    : escapeHtml(label);
}

function assertionGroupHtml(group) {
  if (group.status === "not_observed") {
    return `<section class="fact missing" data-fact="${escapeHtml(group.fact)}">
      <div class="fact-head"><h2>${escapeHtml(group.label)}</h2><span class="status">Not observed</span></div>
      <p>${escapeHtml(group.missingness)}</p>
    </section>`;
  }
  const assertions = group.assertions.map((assertion) => `<li>
    <p class="value">${escapeHtml(formattedValue(assertion.value))}</p>
    <p class="source">Source assertion · ${sourceLink(assertion.provenance.source)}</p>
    <dl>
      <div><dt>Publisher field</dt><dd>${escapeHtml(assertion.provenance.source_field)}</dd></div>
      <div><dt>Observed</dt><dd><time datetime="${escapeHtml(assertion.provenance.observed_at)}">${escapeHtml(observedTime(assertion.provenance.observed_at))}</time></dd></div>
      <div><dt>Derivation</dt><dd>${escapeHtml(humanStatus(assertion.derivation.status))}</dd></div>
      <div><dt>Confidence / review</dt><dd>${escapeHtml(humanStatus(assertion.confidence.status))} · ${escapeHtml(humanStatus(assertion.review.status))}</dd></div>
    </dl>
  </li>`).join("");
  const disagreement = group.status === "disagreement"
    ? `<p class="disagreement">${escapeHtml(group.disagreement)}</p>`
    : "";
  return `<section class="fact ${escapeHtml(group.status)}" data-fact="${escapeHtml(group.fact)}">
    <div class="fact-head"><h2>${escapeHtml(group.label)}</h2><span class="status">${escapeHtml(group.status)}</span></div>
    ${disagreement}<ul>${assertions}</ul>
  </section>`;
}

export function renderEntityDossierPage(dossier) {
  const records = dossier.linked_records.map((record) => `<li>${sourceLink(record.source)}<span><time datetime="${escapeHtml(record.observed_at)}">${escapeHtml(observedTime(record.observed_at))}</time></span></li>`).join("");
  const facts = dossier.assertions.map(assertionGroupHtml).join("\n");
  const derived = dossier.derived_assertions.map((assertion) => `<section class="derived">
    <p class="eyebrow">Derived assertion</p>
    <h2>${escapeHtml(assertion.label)}</h2>
    <p class="derived-value">${escapeHtml(assertion.value)}</p>
    <p>Derivation: ${escapeHtml(humanStatus(assertion.derivation.status))} from ${assertion.derivation.evidence_assertion_ids.length} linked source assertion${assertion.derivation.evidence_assertion_ids.length === 1 ? "" : "s"}. Confidence: ${escapeHtml(humanStatus(assertion.confidence.status))}. Review: ${escapeHtml(humanStatus(assertion.review.status))}.</p>
  </section>`).join("");
  const relationshipsUrl = `/entity-relationships?id=${encodeURIComponent(dossier.entity.id)}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(dossier.entity.name)} · Entity dossier · CityScroll</title>
    <style>
      :root{--paper:#f7f2e8;--card:#fffdf8;--ink:#17202a;--muted:#5e6a73;--line:#d7cdbd;--accent:#9c3f32;--warn:#8a4b11;--blue:#295d76}
      *{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}a{color:var(--blue);overflow-wrap:anywhere}main{width:min(1100px,calc(100% - 32px));margin:0 auto;padding:48px 0 72px}.eyebrow{text-transform:uppercase;letter-spacing:.12em;font-size:.72rem;font-weight:800;color:var(--accent)}h1{font:700 clamp(2rem,5vw,4.5rem)/.98 Georgia,serif;max-width:15ch;margin:.25rem 0 1rem}.lede{max-width:70ch;color:var(--muted);font-size:1.05rem}.scope,.records,.derived,.fact{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;min-width:0}.summary{display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,.45fr);gap:18px;margin:28px 0}.summary h2,.fact h2,.derived h2{margin:0;font:700 1.25rem Georgia,serif}.scope dl,.fact dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.scope dl div,.fact dl div{min-width:0}.scope dt,.fact dt{font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}.scope dd,.fact dd{margin:2px 0 0;overflow-wrap:anywhere}.records ul,.fact ul{list-style:none;padding:0;margin:12px 0 0}.records li{display:flex;gap:12px;justify-content:space-between;border-top:1px solid var(--line);padding:10px 0}.records li span{color:var(--muted);font-size:.85rem}.derived{border-left:5px solid var(--blue);margin-bottom:18px}.derived-value{font:700 1.5rem Georgia,serif;margin:.3rem 0}.facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:start;gap:18px}.fact-head{display:flex;align-items:start;justify-content:space-between;gap:12px}.status{border:1px solid var(--line);border-radius:999px;padding:3px 8px;font-size:.7rem;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap}.fact.disagreement{border-color:#d39355}.fact.disagreement .status{background:#fff1df;border-color:#d39355;color:var(--warn)}.fact.missing{color:var(--muted);background:#f5f0e7}.fact li{border-top:1px solid var(--line);padding:12px 0}.value{font-weight:750;font-size:1.08rem;margin:0;overflow-wrap:anywhere}.source{margin:.15rem 0 .7rem;color:var(--muted);font-size:.88rem}.disagreement{border-left:4px solid #d39355;padding-left:10px;color:var(--warn)}footer{margin-top:28px;color:var(--muted);font-size:.86rem}
      @media(max-width:760px){main{padding-top:28px}.summary,.facts{grid-template-columns:1fr}.scope dl,.fact dl{grid-template-columns:1fr}.records li{display:block}.records li span{display:block;margin-top:3px}}
    </style></head><body><main>
      <header><p class="eyebrow">CityScroll · bounded public dossier</p><h1>${escapeHtml(dossier.entity.name)}</h1><p class="lede">Public assertions linked to one canonical ${escapeHtml(dossier.entity.type)}. Conflicting values remain separate and attributed.</p><p><a href="${escapeHtml(relationshipsUrl)}">Explore typed public relationships</a></p></header>
      <div class="summary"><section class="scope"><h2>Dossier scope</h2><p>${escapeHtml(dossier.scope.note)}</p><dl>
        <div><dt>Sources</dt><dd>${escapeHtml(dossier.scope.sources.join(", ") || "No linked sources")}</dd></div>
      <div><dt>Observation period</dt><dd>${escapeHtml(dossier.scope.observed_from ? observedTime(dossier.scope.observed_from) : "Not observed")} – ${escapeHtml(dossier.scope.observed_through ? observedTime(dossier.scope.observed_through) : "Not observed")}</dd></div>
      </dl></section><section class="records"><h2>Linked source records</h2><ul>${records || "<li>No linked source records.</li>"}</ul></section></div>
      ${derived}<div class="facts">${facts}</div>
      <footer>Dossier contract ${escapeHtml(dossier.version)} · Missing fields mean only that they were not observed in these linked records.</footer>
    </main></body></html>`;
}

/** Query one dossier by canonical entity id. */
export async function readEntityDossier(db, canonicalEntityId) {
  if (!db) return null;
  const entityId = clean(canonicalEntityId);
  if (!entityId || entityId.length > 300) return null;
  const result = await db.prepare(
    `SELECT entity.id AS entity_id, entity.entity_type, entity.display_name,
            record.source_system, record.source_system_id,
            record.raw_snapshot, record.ingested_at
       FROM canonical_entity AS entity
       LEFT JOIN (
         SELECT DISTINCT canonical_entity_id, source_record_id
           FROM entity_link
          WHERE decision = 'auto_link'
       ) AS link
         ON link.canonical_entity_id = entity.id
       LEFT JOIN source_records AS record
         ON link.source_record_id = (
           record.source_system || ':' || record.source_system_id || ':' || record.content_hash
         )
      WHERE entity.id = ?
      ORDER BY record.ingested_at DESC, record.source_system ASC, record.source_system_id ASC
      LIMIT ?`,
  ).bind(entityId, DOSSIER_RECORD_LIMIT + 1).all();
  const rows = result?.results || [];
  const truncated = rows.length > DOSSIER_RECORD_LIMIT;
  return serializePublicEntityDossier(rows.slice(0, DOSSIER_RECORD_LIMIT), {
    recordLimit: DOSSIER_RECORD_LIMIT,
    truncated,
  });
}

export async function handleEntityDossier(request, env) {
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
  if (!env?.DB) return json({ error: "no-store" }, 503);
  const url = new URL(request.url);
  const entityId = clean(url.searchParams.get("id"));
  if (!entityId || entityId.length > 300) return json({ error: "id-required" }, 400);
  let dossier;
  try {
    dossier = await readEntityDossier(env.DB, entityId);
  } catch {
    return json({ error: "dossier-unavailable" }, 503);
  }
  if (!dossier) return json({ error: "not-found" }, 404);
  if (url.searchParams.get("format") === "json"
      || (request.headers.get("accept") || "").includes("application/json")) {
    return json(dossier);
  }
  return new Response(renderEntityDossierPage(dossier), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": DOSSIER_CACHE,
    },
  });
}

export { PUBLIC_DOSSIER_VERSION };
