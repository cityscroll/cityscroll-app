/* ===================== ENTITY PAGES (vendor / agency) =====================
   The pivot layer: every agency or vendor mention links here, and each page is a hub of
   further pivots — the search → entity → pivot loop. Vendor identity is resolved at read
   time (v1): normalize to a stem (case/punctuation/legal suffixes), prefix-match server-side,
   then keep only rows whose own stem matches exactly. Honest and zero-infrastructure; a
   nightly clustered alias table can replace it without changing this page. */
const agencyHref = (name, tab) => globalThis.CrolEntityPivots ? globalThis.CrolEntityPivots.entityHref({ref:globalThis.CrolEntityPivots.entityRouteRef("agency",cleanText(name)),label:cleanText(name)},{tab}) : "#agency/"+encodeURIComponent(cleanText(name))+(tab?"?tab="+tab:"");
const vendorHref = (name, tab) => globalThis.CrolEntityPivots ? globalThis.CrolEntityPivots.entityHref({ref:globalThis.CrolEntityPivots.entityRouteRef("vendor",cleanText(name)),label:cleanText(name)},{tab}) : "#vendor/"+encodeURIComponent(cleanText(name))+(tab?"?tab="+tab:"");

/** Cached person_votes_lookup.json (precomputed by_person densify). */
let personVotesLookupPromise = null;
function loadPersonVotesLookup(){
  if(!personVotesLookupPromise){
    personVotesLookupPromise = fetch("data/person_votes_lookup.json", { cache: "force-cache", credentials: "omit" })
      .then(r => (r && r.ok ? r.json() : null))
      .catch(() => null);
  }
  return personVotesLookupPromise;
}

/**
 * Accessible table of one official's votes (matter · hearing · vote).
 * Pure HTML helper for the #official surface — never invents rows.
 */
function officialVotesTableHTML(votes, opts){
  const list = Array.isArray(votes) ? votes : [];
  if(!list.length) return "";
  const showHearing = !(opts && opts.hideHearing);
  const headHearing = showHearing
    ? `<th scope="col">${t("official_vote_hearing_col")}</th>`
    : "";
  const rows = list.map(v => {
    const file = v.matter_file || v.matter_id || "—";
    const matterUrl = v.matter_url
      || (typeof matterDetailUrl === "function" ? matterDetailUrl(v.matter_id) : "")
      || "";
    const fileHTML = matterUrl
      ? `<a class="official-vote-file" href="${escUiHtml(matterUrl)}" ${EXT_ATTRS} lang="en" dir="ltr">${escUiHtml(file)}${extSR()}</a>`
      : `<span class="official-vote-file" lang="en" dir="ltr">${escUiHtml(file)}</span>`;
    const title = v.matter_title
      ? `<div class="official-vote-title" lang="en" dir="ltr">${escUiHtml(v.matter_title)}</div>`
      : "";
    const bucket = v.vote_bucket || v.vote_value || v.vote || "—";
    const voteExtra = v.vote_value && v.vote_bucket && v.vote_value !== v.vote_bucket
      ? ` · ${escUiHtml(String(v.vote_value))}`
      : (v.vote && v.vote_bucket && v.vote !== v.vote_bucket ? ` · ${escUiHtml(String(v.vote))}` : "");
    const hearingCell = showHearing
      ? (() => {
          const date = v.event_date ? fdate(String(v.event_date).slice(0, 10)) : "—";
          const notice = v.request_id
            ? `<a class="view" href="#notice/${encodeURIComponent(v.request_id)}">${escUiHtml(date)}</a>`
            : escUiHtml(date);
          return `<td lang="en" dir="ltr">${notice}</td>`;
        })()
      : "";
    return `<tr data-matter-id="${escUiHtml(v.matter_id || "")}" data-event-id="${escUiHtml(v.event_id || "")}" data-notice-id="${escUiHtml(v.request_id || "")}">
      <th scope="row">${fileHTML}${title}</th>
      ${hearingCell}
      <td lang="en" dir="ltr"><span class="official-vote-bucket">${escUiHtml(String(bucket))}${voteExtra}</span></td>
    </tr>`;
  }).join("");
  return `<table class="official-vote-table" data-official-vote-count="${list.length}">
    <caption class="sr-only">${t("official_votes_table_caption")}</caption>
    <thead>
      <tr>
        <th scope="col">${t("official_vote_matter_col")}</th>
        ${headHearing}
        <th scope="col">${t("official_vote_vote_col")}</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/**
 * Official person page: recent roll-call votes across matters (precompute-first)
 * plus optional event-scoped hearing slice when ?notice= / ?event= is present.
 * Loads person_votes_lookup.json; may enrich one hearing from /meeting-outcomes.
 * Never invents votes.
 */
async function showOfficial(personId, opts){
  showTab("entity");
  const box = $("#entityview");
  delete box.dataset.vendorStem;
  const id = String(personId || "").replace(/^official:/, "").trim();
  const noticeId = opts && opts.noticeId ? String(opts.noticeId).trim() : "";
  const eventId = opts && opts.eventId ? String(opts.eventId).trim() : "";
  const safeId = escUiHtml(id || "—");
  if(!id){
    box.innerHTML = `<div class="empty">${t("official_missing_id_html")} ${routeBackHTML("#meetings")}</div>`;
    applyActiveHistoryRouteScroll();
    return;
  }
  box.innerHTML = `<div class="empty"><span class="loading"></span> ${t("official_loading")}</div>`;

  // Precompute-first: person → votes across densified roll-call hearings.
  let lookupBag = null;
  let preVotes = [];
  let displayName = "";
  try{
    const lookup = await loadPersonVotesLookup();
    if(lookup && lookup.by_person_id){
      lookupBag = lookup.by_person_id[id] || null;
      if(lookupBag){
        displayName = lookupBag.person_name || "";
        preVotes = Array.isArray(lookupBag.votes) ? lookupBag.votes.slice() : [];
      }
    }
  }catch(e){ /* force-cache miss is fine */ }

  // Optional live enrich for the linked hearing (when precompute is thin on that notice).
  let record = null;
  let loadError = false;
  if(noticeId){
    try{
      const resp = await workerFetch("/meeting-outcomes?id=" + encodeURIComponent(noticeId), null, 8000);
      if(resp && resp.ok){
        const data = await resp.json();
        if(data && data.ok !== false && data.record) record = data.record;
      } else {
        loadError = true;
      }
    }catch(e){
      loadError = true;
    }
  }
  if(!document.contains(box)) return;

  // Merge event-scoped live rows for this hearing (prefer live matter titles when present).
  const hearingVotes = [];
  if(record && Array.isArray(record.agenda_items)){
    for(const item of record.agenda_items){
      for(const matter of (item.matters || [])){
        for(const vote of (matter.votes || [])){
          if(vote && vote.vote_identity === "tally_only") continue;
          for(const p of (vote.by_person || [])){
            const pid = typeof officialIdFromPerson === "function"
              ? officialIdFromPerson(p)
              : String((p.official && p.official.id) || p.person_id || "").replace(/^official:/, "");
            if(pid !== id) continue;
            if(!displayName){
              displayName = (p.official && p.official.display_name) || p.person_name || "";
            }
            hearingVotes.push({
              matter_id: matter.matter_id || null,
              matter_file: matter.matter_file || null,
              matter_title: matter.title || null,
              matter_url: matter.matter_url || (typeof matterDetailUrl === "function" ? matterDetailUrl(matter.matter_id) : "") || "",
              vote_value: p.vote_value || p.vote || null,
              vote_bucket: p.vote_bucket || null,
              result: vote.result || null,
              event_id: (record.council_event && record.council_event.event_id) || eventId || null,
              request_id: noticeId || null,
              event_date: (record.council_event && (record.council_event.event_date || record.council_event.start_time)) || null,
            });
          }
        }
      }
    }
  }

  // Hearing slice from precompute when live miss but densify has the notice.
  const preHearing = preVotes.filter(v =>
    (noticeId && String(v.request_id || "") === noticeId)
    || (eventId && String(v.event_id || "") === eventId)
  );
  const scopedVotes = hearingVotes.length ? hearingVotes : preHearing;

  // Recent across matters: full precompute list (newest first already in lookup).
  const recentVotes = preVotes.slice(0, 40);
  const name = displayName || id;
  const event = (record && record.council_event) || {};
  const resolvedEventId = eventId || event.event_id || (scopedVotes[0] && scopedVotes[0].event_id) || "";
  const backHref = noticeId ? `#notice/${encodeURIComponent(noticeId)}` : "#meetings";
  const noticeLink = noticeId
    ? `<a class="view" href="#notice/${encodeURIComponent(noticeId)}">${t("official_open_hearing")}</a>`
    : "";
  const hasScoped = Boolean(noticeId || eventId);
  const eventLine = hasScoped
    ? (resolvedEventId || (event.title || event.body_name)
      ? `<p class="ei-lead" lang="en" dir="ltr">${t("official_event_line_html",{
          event: escUiHtml(event.title || event.body_name || t("official_event_fallback")),
          id: escUiHtml(String(resolvedEventId || "—")),
          date: event.start_time ? fdate(String(event.start_time).slice(0,10)) : (event.event_date ? fdate(String(event.event_date).slice(0,10)) : (scopedVotes[0]?.event_date ? fdate(String(scopedVotes[0].event_date).slice(0,10)) : "—"))
        })}</p>`
      : `<p class="ei-lead">${t("official_event_scoped_note")}</p>`)
    : `<p class="ei-lead">${t("official_recent_lead_html",{
        n: String(recentVotes.length || 0)
      })}</p>`;

  let body = "";
  // Section A: this hearing (when scoped)
  if(hasScoped){
    let scopedBody = "";
    if(loadError && !record && !preHearing.length){
      scopedBody = `<div class="note">${t("official_load_error_html")}</div>`;
    } else if(!scopedVotes.length){
      scopedBody = `<div class="note" data-person-votes-gap="empty">${t("official_no_votes_html",{
        name: escUiHtml(name)
      })}</div>`;
    } else {
      scopedBody = officialVotesTableHTML(scopedVotes, { hideHearing: true });
    }
    body += `<div class="chain-h">${t("official_votes_heading")}</div>${scopedBody}`;
  }

  // Section B: recent votes across matters (precompute)
  if(recentVotes.length){
    const recentHeading = hasScoped
      ? t("official_recent_votes_heading")
      : t("official_all_votes_heading");
    body += `<div class="chain-h" style="margin-top:${hasScoped ? "18" : "0"}px">${recentHeading}</div>`;
    body += officialVotesTableHTML(recentVotes, { hideHearing: false });
  } else if(!hasScoped){
    body = `<div class="note" data-person-votes-gap="empty">${t("official_no_recent_html",{
      name: escUiHtml(name)
    })}</div>`;
  }

  const kicker = hasScoped ? t("official_skim_kicker") : t("official_page_kicker");
  box.innerHTML = `<div style="max-width:880px;margin:0 auto">
    <p style="margin:4px 0 12px">${routeBackHTML(backHref)}</p>
    <div class="panel route-item" tabindex="-1" style="padding:22px 24px" id="official-skim" data-official-id="${safeId}" data-event-id="${escUiHtml(String(resolvedEventId || ""))}" data-notice-id="${escUiHtml(noticeId || "")}" data-precompute-votes="${recentVotes.length}">
      <div class="ftype" style="margin-bottom:6px">${kicker}</div>
      <h2 class="rolename" lang="en" dir="ltr">${escUiHtml(name)}</h2>
      ${eventLine}
      ${body}
      <div class="actions" style="margin-top:16px;display:flex;flex-wrap:wrap;gap:10px">
        ${noticeLink}
        <a class="view" href="${agencyHref("City Council")}">${t("official_city_council_profile")}</a>
      </div>
      <p class="aidprov" style="margin-top:14px">${t("official_provenance_html")}</p>
    </div>
  </div>`;
  focusItemRouteTarget(box.querySelector(".route-item"));
  applyActiveHistoryRouteScroll();
}
const escUiHtml = (s) => String(s == null ? "" : s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&#39;", "\"": "&quot;" }[c]));
// Escape the label once: cleanText now decodes entities to plain Unicode, so an unescaped
// pivot label would re-open injection for any notice field carrying &lt;…&gt;.
function typedPivotHTML(href, text){
  const typed = globalThis.CrolEntityPivots?.entityFromHref(href, cleanText(text));
  return globalThis.CrolEntityPivots.entityChipHTML({
    ref: typed.ref,
    label: typed.label,
    link_confidence: "strong",
  }, typed.options);
}
const pivotA = (href, text) => globalThis.CrolEntityPivots?.entityFromHref(href,cleanText(text)) ? typedPivotHTML(href,text) : `<a class="pivot" href="${href}">${escUiHtml(text)}</a>`;

const VENDOR_SUFFIX = /\s+(INCORPORATED|INC|LLC|L\.L\.C|CORPORATION|CORP|COMPANY|CO|LTD|LIMITED|LP|LLP|PLLC|P\.C|PC|USA|OF NY|OF NEW YORK)\.?$/;
function vendorStem(name){
  let s = cleanText(name).toUpperCase().replace(/[.,'’&]/g, " ").replace(/\s+/g, " ").trim();
  let prev;
  do { prev = s; s = s.replace(VENDOR_SUFFIX, "").trim(); } while (s !== prev && s.length > 3);
  return s;
}

// Cross-source same-entity match for vendor labels. Reuses vendorStem, then tolerates
// Checkbook-style truncation and token-level expansion (AND/LANDSCAPE wording, cut-off tails).
// Used by the dollars panel so a genuine mismatch still warns; HNTB-style variants do not.
function vendorNamesMatch(a, b){
  const sa = vendorStem(a), sb = vendorStem(b);
  if(!sa || !sb) return false;
  if(sa === sb) return true;
  const [short, long] = sa.length <= sb.length ? [sa, sb] : [sb, sa];
  // Shared prefix after normalization (source often truncates around 60 chars).
  if(short.length >= 16 && long.startsWith(short)) return true;
  const tokens = s => s.split(" ").filter(t => t.length > 1);
  const ta = tokens(sa), tb = tokens(sb);
  if(!ta.length || !tb.length) return false;
  const setA = new Set(ta), setB = new Set(tb);
  function tokenHit(t, other){
    if(other.has(t)) return true;
    // Truncated last token: ARCHITE ↔ ARCHITECTURE
    for(const u of other){
      if(u.length >= 5 && t.length >= 5 && (u.startsWith(t) || t.startsWith(u))) return true;
    }
    return false;
  }
  const [small, largeSet] = ta.length <= tb.length ? [ta, setB] : [tb, setA];
  let hits = 0;
  for(const t of small) if(tokenHit(t, largeSet)) hits++;
  const need = Math.max(2, Math.ceil(small.length * 0.75));
  return hits >= need && hits >= Math.min(3, small.length);
}

function renderVendorVariants(variants){
  if(variants.length <= 1) return "";
  const items = variants
    .map(v => {
      const name = v.vendor_name || v.name || "";
      const total = v.t ?? v.total;
      const count = Number(v.n);
      const countText = Number.isFinite(count) ? count.toLocaleString("en-US",{maximumFractionDigits:0}) : "0";
      return `<div class="vendor-variant-item"><span class="vendor-variant-name" lang="en" dir="ltr">${cleanText(name).replace(/&/g,"&amp;")}</span> · <span class="vendor-variant-meta">${countText} · ${money(total) || "—"}</span></div>`;
    })
    .join("");
  const needsCollapse = variants.length > 8;
  const list = `<div class="vendor-variant-list">${items}</div>`;
  if(!needsCollapse) return list;
  return `<details class="vendor-variant-list-wrapper" open><summary style="display:inline;cursor:pointer;border-bottom:1px dotted var(--rule-strong)">${t("which_variants_btn")}</summary>${list}</details>`;
}

function agencyProfileBar(stats, rfpCount, agencyName){
  if(!hasAgencyAwards(stats)) return `${agencyAwardsNote(agencyName)}
      <div class="agencybar">
        <div><div class="big">${rfpCount}${rfpCount===5?"+":""}</div><div class="lbl">open RFPs<br>right now</div></div>
      </div>`;
  return `<div class="agencybar">
        <div><div class="big">${money(stats.total)||"—"}</div><div class="lbl">total awarded,<br>on record</div></div>
        <div><div class="big">${(+stats.n).toLocaleString()}</div><div class="lbl">contract awards<br>published</div></div>
        <div><div class="big">${rfpCount}${rfpCount===5?"+":""}</div><div class="lbl">open RFPs<br>right now</div></div>
      </div>`;
}
// Shared by showAgency/showVendor (both render the same "Procurement Forecast" timeline)
// and by agencyForecastTeaser's cross-link from notice detail — one builder, one shape to
// pin in test/forecast_render.test.mjs, instead of the two hand-copied blocks this used to be.
// (escUiHtml lives next to pivotA above — single definition for all HTML sinks.)
function forecastItemHTML(f){
  const isCheckbook = f.source === "checkbook";
  const badgeText = isCheckbook ? t("forecast_badge_checkbook") : t("forecast_badge_mocs");
  const badgeColor = isCheckbook ? "#eef2ff" : "#e7f4ec";
  const badgeTextCol = isCheckbook ? "#10259e" : "#1a6b34";
  const title = isCheckbook ? (f.vendor_name || t("forecast_vendor_fallback")) : (f.description || t("forecast_solicitation_fallback"));
  const sub = isCheckbook ? `${f.agency_name} · ${t("forecast_amount_label")} ${money(f.amount) || "—"}` : `${f.agency} · ${t("forecast_value_band_label")} ${f.value_band}`;
  const dateText = isCheckbook ? t("forecast_predicted_expiration_label",{date:f.expiration_date}) : t("forecast_expected_quarter_label",{quarter:f.release_quarter});
  const watchKind = isCheckbook ? "vendor" : "agency";
  const watchName = isCheckbook ? f.vendor_name : f.agency_name || f.agency;

  return `<div class="tl" style="margin-bottom:20px;position:relative;padding-inline-start:24px">
    <div style="position:absolute;inset-inline-start:0;top:4px;width:10px;height:10px;border-radius:50%;background:var(--oxblood)"></div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
      <span class="badge" style="background:${badgeColor};color:${badgeTextCol};font-size:11px;font-weight:600;padding:2px 6px;border-radius:4px">${badgeText}</span>
      <span style="font-size:12px;color:var(--muted)">${dateText}</span>
    </div>
    <div style="font-weight:600;font-size:14px;color:#12181f">${escUiHtml(title)}</div>
    <div style="font-size:13px;color:#5b6470;margin-bottom:8px">${escUiHtml(sub)}</div>
    <button class="act mini-sub-btn" type="button" data-watch-kind="${watchKind}" data-watch-name="${escUiHtml(watchName)}" style="font-size:11px;padding:3px 8px;margin:0">${t("mini_subscribe_btn")}</button>
  </div>`;
}
function forecastItemsHTML(forecasts){ return forecasts.map(forecastItemHTML).join(""); }
function forecastPaneHTML(forecasts){
  return `<div class="chain-h">${t("forecast_section_heading")}</div>
    <div class="timeline" style="margin-top:10px">${forecastItemsHTML(forecasts)}</div>
    <div class="note">${t("forecast_honesty_note")}</div>`;
}

// Cross-link from the notice detail's paper-trail area (sibling to priorCycleAwards): a
// quiet teaser naming this notice's agency's own next predicted bid window, linking straight
// into that agency's profile with the Forecast subtab pre-selected (agencyHref's ?tab= param).
// Silent no-op when the agency has no forecast data yet — same quiet-fail posture as
// fillAddressLinks (no geocode match → nothing rendered), not an empty-state note for every
// notice, since most agencies don't have forecast data computed yet.
async function agencyForecastTeaser(r, el){
  if(!el || !r.agency_name) return;
  let data = null;
  try{ data = await workerFetch("/inv/" + encodeURIComponent(r.agency_name), null, 8000).then(x => x.ok ? x.json() : null); }catch(e){}
  if(!document.contains(el)) return; // a newer selection replaced this panel
  const forecasts = data ? (data.forecasts || []) : [];
  if(!forecasts.length) return;
  el.innerHTML = `<div class="chain-h">${t("agency_forecast_heading")}</div>
    <div class="note">${tn("agency_forecast_count", forecasts.length)} <a class="pivot" href="${agencyHref(r.agency_name,"forecast")}">${t("agency_forecast_link")}</a></div>
    <div class="note">${t("forecast_honesty_note")}</div>`;
}

async function showAgency(name, initialTab){
  showTab("entity");
  const box = $("#entityview");
  delete box.dataset.vendorStem;
  const nm = String(name||"").trim(), safe = nm.replace(/[<>&]/g,""), q = nm.replace(/'/g,"''");
  box.innerHTML = `<div class="empty"><span class="loading"></span> building profile: ${safe}…</div>`;
  const [stats, sections, vendors, rfps, events, forecastData, externalAward, agencyIdentity, entityIntel] = await Promise.all([
    loadAgencyStats(nm),
    soda({"$select":"section_name, count(1) as n","$where":`agency_name='${q}'`,"$group":"section_name","$order":"n DESC"}).catch(()=>[]),
    soda({"$select":"vendor_name, count(1) as n, sum(contract_amount) as t","$where":`agency_name='${q}' AND type_of_notice_description='Award' AND contract_amount > 0 AND contract_amount < ${MONEY_HONESTY_CAP} AND vendor_name IS NOT NULL`,"$group":"vendor_name","$order":"t DESC","$limit":"8"}).catch(()=>[]),
    soda({"$select":SELECT,"$where":`agency_name='${q}' AND type_of_notice_description='Solicitation' AND due_date > '${todayISO()}'`,"$order":"due_date ASC","$limit":"5"}).catch(()=>[]),
    soda({"$select":FEED_SELECT,"$where":`agency_name='${q}' AND event_date > '${todayISO()}'`,"$order":"event_date ASC","$limit":"5"}).catch(()=>[]),
    workerFetch("/inv/" + encodeURIComponent(nm), null, 8000).then(r => r.ok ? r.json() : null).catch(() => null),
    // Only fuzzy ABO agencies list awards on the profile; exact (NYCHA) has no agency-wide set,
    // and absent/unknown agencies have nothing to fetch (their claim is the synchronous note).
    awardCoverage(nm)==="fuzzy" ? loadExternalAward({agency: nm}) : Promise.resolve(null),
    // Agency-identity join: resolve this agency's City Record name to its canonical identity
    // card (website, head, budget) from the Worker's static NYC Open Data crosswalk. Fail-soft —
    // a miss or an error just leaves the card unrendered, never blocks the profile.
    workerFetch("/agency?name=" + encodeURIComponent(nm), null, 8000).then(r => r.ok ? r.json() : null).catch(() => null),
    // Cross-domain object links (money/land/rules/meetings/people) from warehouse materialization.
    workerFetch("/entity-intelligence?kind=agency&name=" + encodeURIComponent(nm), null, 8000)
      .then(r => r.ok ? r.json() : null).catch(() => null)
  ]);
  if(!(stats && +stats.n) && !sections.length){
    box.innerHTML = `<div class="empty">No City Record notices found for agency “${safe}”. ${routeBackHTML("#money")}</div>`;
    applyActiveHistoryRouteScroll();
    return;
  }
  const link = location.origin + location.pathname + agencyHref(nm);
  const maxT = Math.max.apply(null, vendors.map(v=>+v.t||0)) || 1;
  const vendorRows = vendors.map(v=>`<div class="lrow">
      <div class="lname">${pivotA(vendorHref(v.vendor_name), cleanText(v.vendor_name))}</div>
      <div class="lbar"><span style="width:${Math.round((+v.t/maxT)*100)}%"></span></div>
      <div class="lval">${money(v.t)||"—"}</div></div>`).join("");
  const secChips = sections.map(c=>{
    const lens = SECTION_LENS[c.section_name];
    const label = `${tSection(c.section_name)}<span class="ct">${fmtNumber(+c.n)}</span>`;
    return lens ? `<a class="chip" style="text-decoration:none" href="#${lens}?agency=${encodeURIComponent(nm)}">${label}</a>` : `<span class="chip" style="cursor:default">${label}</span>`;
  }).join("");
  const rfpItems = rfps.map(r=>`<div class="tl"><span class="tldate">${isRollingDeadline(r.due_date)?"":"due "+fdate(r.due_date)}</span>
      <span class="tlreason">${pivotA("#notice/"+encodeURIComponent(r.request_id), cleanText(r.short_title)||"(untitled)")}</span>${deadlineTag(r.due_date)}</div>`).join("");
  const evItems = events.map(r=>`<div class="tl"><span class="tldate">${fdate(r.event_date)}</span>
      <span class="tlreason">${pivotA("#notice/"+encodeURIComponent(r.request_id), cleanText(r.short_title)||"(untitled)")}</span>${eventTag(r.event_date)}</div>`).join("");

  const forecasts = forecastData ? (forecastData.forecasts || []) : [];
  const hasForecasts = forecasts.length > 0;

  box.innerHTML = `<div style="max-width:880px;margin:0 auto">
    <p style="margin:4px 0 12px">${routeBackHTML("#money")}</p>
    <div class="panel route-item" tabindex="-1" style="padding:22px 24px">
      <div class="ftype" style="margin-bottom:6px">Agency profile · City Record on record</div>
      <h2 class="rolename" lang="en" dir="ltr">${agencyWho(nm)}</h2>
      ${agencyProfileBar(stats, rfps.length, nm)}

      ${hasForecasts ? `<div class="subtabs" style="display:flex;gap:16px;border-bottom:1px solid #dde1e7;margin:16px 0 20px">
        <button class="subtab active" id="btn-overview" style="font-family:var(--font-sc);font-weight:600;font-size:12px;letter-spacing:.15em;text-transform:uppercase;padding:9px 0;border:none;background:none;color:var(--oxblood);border-bottom:2px solid var(--oxblood);cursor:pointer">${t("forecast_overview_tab")}</button>
        <button class="subtab" id="btn-forecast" style="font-family:var(--font-sc);font-weight:600;font-size:12px;letter-spacing:.15em;text-transform:uppercase;padding:9px 0;border:none;background:none;color:var(--muted);border-bottom:2px solid transparent;cursor:pointer">${t("forecast_subtab_label",{n:forecasts.length})}</button>
      </div>` : ""}

      <div id="overview-content">
        ${agencyIdentityHTML(agencyIdentity)}
        ${entityIntelligenceHTML(entityIntel)}
        ${externalAwardHTML(externalAward)}
        <div class="chain-h">Notices by section — click to browse that lens, filtered to this agency</div>
        <div class="chiprow" style="margin-top:6px">${secChips}</div>
        ${vendors.length?`<div class="chain-h">Top vendors by awarded $ (click to pivot)</div><div class="ladder">${vendorRows}</div>`:""}
        ${rfps.length?`<div class="chain-h">Open solicitations</div><div class="timeline">${rfpItems}</div>`:""}
        ${events.length?`<div class="chain-h">Upcoming hearings &amp; events</div><div class="timeline">${evItems}</div>`:""}
      </div>

      ${hasForecasts ? `<div id="forecast-content" style="display:none">${forecastPaneHTML(forecasts)}</div>` : ""}

      <div class="actions" style="margin-top:16px">
        <button class="act primary" type="button" data-follow="agency" data-name="${nm.replace(/"/g,"&quot;")}">${t("agency_follow_btn")}</button>
        <button class="act" type="button" id="ecopy">${t("copy_link")}</button>
        ${qrButtonHTML("eqr","act")}
        ${pinBtn("agency", nm, agencyWho(nm), t("meta_agency_profile"))}
        <button class="act" type="button" data-aw="rules">${t("agency_watch_rules_btn")}</button>
        <button class="act" type="button" data-aw="meetings">${t("agency_watch_meetings_btn")}</button>
        ${API?`<a class="act" href="${API.replace(/\/+$/,"")}/feed.xml?lens=entity&kind=agency&name=${encodeURIComponent(nm)}">RSS</a>`:""}
      </div>
      <div class="note">Figures are what this agency has <b>published in the City Record</b> (2003→present for procurement) — registration and payment lag; a per-entity follow across all lenses arrives with the entity-watch feature.</div>
    </div></div>`;

  $("#ecopy").addEventListener("click", ()=>copyText(link, $("#ecopy")));
  bindQRShare($("#eqr"), link);
  // Lens-scoped follow (rules/meetings only) — hash carries agency so prefill is shareable.
  box.querySelectorAll("[data-aw]").forEach(b=>b.addEventListener("click", ()=>{
    const lens = b.dataset.aw;
    const filter = { keywords: [], agency: nm };
    import("../alerts_context_carry.mjs")
      .then(carry=>location.assign(carry.alertsHref({lens,filter})))
      .catch(()=>location.assign("/following/"));
  }));

  if (hasForecasts) {
    const btnOverview = $("#btn-overview");
    const btnForecast = $("#btn-forecast");
    const paneOverview = $("#overview-content");
    const paneForecast = $("#forecast-content");

    btnOverview.addEventListener("click", () => {
      btnOverview.style.color = "var(--oxblood)";
      btnOverview.style.borderBottomColor = "var(--oxblood)";
      btnForecast.style.color = "var(--muted)";
      btnForecast.style.borderBottomColor = "transparent";
      paneOverview.style.display = "block";
      paneForecast.style.display = "none";
    });

    btnForecast.addEventListener("click", () => {
      btnForecast.style.color = "var(--oxblood)";
      btnForecast.style.borderBottomColor = "var(--oxblood)";
      btnOverview.style.color = "var(--muted)";
      btnOverview.style.borderBottomColor = "transparent";
      paneOverview.style.display = "none";
      paneForecast.style.display = "block";
    });

    box.querySelectorAll(".mini-sub-btn").forEach(b => b.addEventListener("click", () => {
      const kind = b.dataset.watchKind === "agency" ? "agency" : "vendor";
      const watchName = b.dataset.watchName || "";
      import("../alerts_context_carry.mjs")
        .then(carry=>location.assign(carry.alertsHref({lens:"entity",filter:{kind,name:watchName}})))
        .catch(()=>location.assign("/following/"));
    }));

    if(initialTab === "forecast") btnForecast.click();
  }

  announce(t("meta_agency_profile_announce",{name:nm}));
  focusItemRouteTarget(box.querySelector(".route-item"));
  applyActiveHistoryRouteScroll();
}

function vendorProfileFromVariants(variants){
  const normalized = variants.map(v=>({
    name:v.name||v.vendor_name, n:+v.n||0, total:+(v.total??v.t)||0,
    first:v.first||null, last:v.last||null
  }));
  const ordered = normalized.slice().sort((a,b)=>b.n-a.n || b.total-a.total || a.name.localeCompare(b.name));
  return {
    stem:vendorStem(ordered[0]?.name||""),
    display:ordered[0]?.name||"",
    variants:normalized,
    awardCount:normalized.reduce((s,v)=>s+v.n,0),
    total:normalized.reduce((s,v)=>s+v.total,0),
    first:normalized.map(v=>v.first).filter(Boolean).sort()[0]||null,
    last:normalized.map(v=>v.last).filter(Boolean).sort().pop()||null,
    topAgencies:[]
  };
}

function doingBusinessCardHTML(db){
  if(!db || typeof db !== "object") return "";
  const structure = db.ownership_structure
    ? t("vendor_doing_business_structure",{structure: cleanText(db.ownership_structure)})
    : "";
  const phone = db.organization_phone
    ? t("vendor_doing_business_phone",{phone: cleanText(db.organization_phone)})
    : "";
  const start = db.doing_business_start_date
    ? t("vendor_doing_business_start",{date: fdate(db.doing_business_start_date)})
    : "";
  const listedAs = db.organization_name
    ? `<div class="sub" style="margin-top:4px">${t("vendor_doing_business_listed_as",{name: cleanText(db.organization_name)})}</div>`
    : "";
  const facts = [structure, phone, start].filter(Boolean)
    .map(line => `<div class="sub" style="margin-top:2px">${line}</div>`).join("");
  return `<div style="margin:14px 0 0;padding:12px 14px;border:1px solid #dde1e7;border-radius:8px;background:#f6f7f9">
      <div class="chain-h" style="margin:0 0 6px">${t("vendor_doing_business_heading")}</div>
      <div style="font-size:14px;font-weight:700">${t("vendor_doing_business_listed")}</div>
      ${listedAs}
      ${facts}
      <div class="rmeta" style="margin-top:8px"><a class="pivot" href="https://data.cityofnewyork.us/d/72mk-a8z7" target="_blank" rel="noopener noreferrer">${t("vendor_doing_business_source")}<span class="sr-only"> ${t("ext_link_new_tab_sr")}</span></a></div>
    </div>`;
}

function vendorProfileHeaderHTML(profile){
  const variants = Array.isArray(profile.variants) ? profile.variants : [];
  const display = cleanText(profile.display||variants[0]?.name||variants[0]?.vendor_name||"");
  const nAwards = +profile.awardCount||0;
  return `<div class="ftype" style="margin-bottom:6px">${t("vendor_profile_variants",{n:variants.length,s:variants.length===1?"":"s"})}</div>
      ${renderVendorVariants(variants)}
      <h2 class="rolename" lang="en" dir="ltr">${display}</h2>
      <div class="agencybar">
        <div><div class="big">${money(profile.total)||"—"}</div><div class="lbl">total awarded,<br>on record</div></div>
        <div><div class="big">${nAwards.toLocaleString()}</div><div class="lbl">award notice${nAwards===1?"":"s"}</div></div>
        <div><div class="big" style="font-size:17px">${profile.first?fdate(profile.first):"—"} – ${profile.last?fdate(profile.last):"—"}</div><div class="lbl">first / latest<br>award published</div></div>
      </div>
      ${doingBusinessCardHTML(profile.doingBusiness)}`;
}

async function loadVendorProfileRecord(name){
  try{
    const response = await workerFetch("/vendor-profile?name="+encodeURIComponent(cleanText(name)), null, 900);
    if(!response.ok) return null;
    const body = await response.json();
    const profile = body && body.profile;
    if(!body?.ok || !profile || profile.stem !== vendorStem(name) || !Array.isArray(profile.variants) || !profile.variants.length
      || !Array.isArray(profile.recentNotices) || !Array.isArray(profile.forecasts)) return null;
    profile.asOf = body.generated;
    return profile;
  }catch(e){ return null; }
}

let vendorFootprintToolsPromise = null;
function ensureVendorFootprintTools(){
  if(!vendorFootprintToolsPromise){
    vendorFootprintToolsPromise = import("../vendor_footprint.mjs").catch(() => null);
  }
  return vendorFootprintToolsPromise;
}

async function loadVendorFootprint(name){
  try{
    const response = await workerFetch("/entity-intelligence?kind=vendor&name="+encodeURIComponent(cleanText(name)), null, 3000);
    if(!response.ok) return null;
    const body = await response.json();
    return body?.vendor_footprint ? body : null;
  }catch(e){ return null; }
}

async function paintVendorFootprint(box, response){
  const host = box?.querySelector("#vendor-footprint");
  if(!host || !response) return;
  const tools = await ensureVendorFootprintTools();
  if(!tools || !document.contains(host)) return;
  host.innerHTML = tools.renderVendorFootprintHTML(response, { formatDate: fdate });
}

function vendorMentionItemsHTML(mentions){
  return mentions.map(r=>`<div class="tl"><span class="tldate">${fdate(r.start_date)}</span>
      <span class="tlreason">${pivotA("#notice/"+encodeURIComponent(r.request_id), cleanText(r.short_title)||"(untitled)")}</span>
      <span class="rmeta" style="margin:0">${tSection(r.section_name)||r.type_of_notice_description||""}</span></div>`).join("");
}

/* ===================== VENDOR PHASE SPINE (award → registration → payments) =========
   Pure model: site/vendor_phase_spine.mjs (same shape as matter / procurement phase spines).
   Flat chronological dump is the fallback when the module fails to load. */
let vendorPhaseSpineToolsPromise = null;
function ensureVendorPhaseSpineTools(){
  if(!vendorPhaseSpineToolsPromise){
    vendorPhaseSpineToolsPromise = import("../vendor_phase_spine.mjs").catch(() => null);
  }
  return vendorPhaseSpineToolsPromise;
}

function vendorTimelineFlatHTML(rows){
  return (rows || []).map(r=>`<div class="tl"><span class="tldate">${fdate(r.start_date)}</span>
      <span class="tlreason">${pivotA("#notice/"+encodeURIComponent(r.request_id), cleanText(r.short_title)||"(untitled)")}</span>
      <span class="rmeta" style="margin:0">${escUiHtml(r.type_of_notice_description||"")} · ${pivotA(agencyHref(r.agency_name), r.agency_name||"")}</span>
      ${money(r.contract_amount)?`<span class="tlsal">${money(r.contract_amount)}</span>`:""}</div>`).join("");
}

function vendorPhaseLabel(phase){
  if(!phase) return "—";
  if(phase.label_key) return t(phase.label_key);
  if(typeof phase === "string"){
    const meta = {
      award: "vendor_phase_award",
      registration: "vendor_phase_registration",
      payments: "vendor_phase_payments",
    };
    return meta[phase] ? t(meta[phase]) : phase;
  }
  return phase.short || "—";
}

function vendorPhaseYearAggHTML(agg, phaseId, idx){
  if(!agg) return "";
  if(agg.count === 1){
    const m = agg.members[0] || {};
    const noticeLink = m.request_id
      ? pivotA("#notice/" + encodeURIComponent(m.request_id), cleanText(m.title) || m.request_id)
      : escUiHtml(cleanText(m.title) || "—");
    const meta = [
      m.date ? fdate(m.date) : "",
      m.agency_name ? pivotA(agencyHref(m.agency_name), m.agency_name) : "",
      m.contract_amount != null ? money(m.contract_amount) : "",
    ].filter(Boolean).join(" · ");
    return `<div class="vendor-phase-row">
      <div class="vendor-phase-row-title" lang="en" dir="ltr"><b>${escUiHtml(m.notice_type || t("lifecycle_stage_award"))}</b> — ${noticeLink}</div>
      <div class="vendor-phase-row-meta">${meta}</div>
    </div>`;
  }
  const listId = `vendor-agg-${phaseId}-${idx}`;
  const yearLabel = agg.year
    ? t("vendor_phase_year_cycle",{year:escUiHtml(agg.year),n:String(agg.count)})
    : t("vendor_phase_milestones_count",{n:String(agg.count)});
  const range = agg.first && agg.last && agg.first !== agg.last
    ? t("vendor_phase_aggregate_range",{first:fdate(agg.first),last:fdate(agg.last)})
    : (agg.first ? fdate(agg.first) : "");
  const amt = agg.amount_sum != null ? money(agg.amount_sum) : "";
  return `<div class="vendor-phase-agg">
    <div class="vendor-phase-agg-title" lang="en" dir="ltr">${yearLabel}<span class="vendor-phase-count">×${agg.count}</span></div>
    <div class="vendor-phase-agg-meta">${[range, amt].filter(Boolean).join(" · ")}</div>
    <button type="button" class="vendor-phase-toggle" data-vendor-dates="${listId}" aria-expanded="false">${t("vendor_phase_show_dates",{n:String(agg.count)})}</button>
    <ul class="vendor-phase-dates" id="${listId}">
      ${(agg.members || []).map(m => {
        const link = m.request_id
          ? pivotA("#notice/" + encodeURIComponent(m.request_id), fdate(m.date) || m.request_id)
          : (m.date ? fdate(m.date) : "—");
        const bits = [
          link,
          m.agency_name ? escUiHtml(cleanText(m.agency_name)) : "",
          m.contract_amount != null ? money(m.contract_amount) : "",
          m.title ? `<span lang="en" dir="ltr">${escUiHtml(cleanText(m.title))}</span>` : "",
        ].filter(Boolean).join(" · ");
        return `<li>${bits}</li>`;
      }).join("")}
    </ul>
  </div>`;
}

function vendorPhasePanelHTML(phase){
  if(!phase) return "";
  if(phase.state === "future" && !phase.event_count) return "";
  if(phase.state === "passed" && !phase.event_count) return "";
  // Substance behind disclosure — current phase summary only until opened.
  const open = "";
  const stateWord = phase.state === "current"
    ? t("vendor_phase_current")
    : phase.state === "passed"
      ? t("vendor_phase_done")
      : t("vendor_phase_future");
  let summary = "";
  if(phase.event_count){
    const parts = [
      t("vendor_phase_milestones_count",{n:String(phase.event_count)}),
      phase.first && phase.last && phase.first !== phase.last
        ? t("vendor_phase_aggregate_range",{first:fdate(phase.first),last:fdate(phase.last)})
        : (phase.first ? fdate(phase.first) : ""),
    ].filter(Boolean);
    summary = parts.join(" · ");
  } else {
    summary = t("vendor_phase_empty");
  }
  let body = "";
  if(phase.id === "award" && (phase.year_aggregates || []).length){
    body = (phase.year_aggregates || []).map((a, idx) => vendorPhaseYearAggHTML(a, phase.id, idx)).join("");
  } else if((phase.milestones || []).length){
    body = (phase.milestones || []).map((m, idx) => vendorPhaseYearAggHTML({
      count: 1, members: [m], year: m.year, first: m.date, last: m.date, amount_sum: m.contract_amount,
    }, phase.id, idx)).join("");
  } else {
    body = `<div class="vendor-phase-row"><div class="vendor-phase-row-meta">${t("vendor_phase_empty")}</div></div>`;
  }
  return `<details class="vendor-phase${phase.state === "current" ? " current-phase" : ""}"${open} id="vendor-phase-${escUiHtml(phase.id)}" data-vendor-phase-panel="${escUiHtml(phase.id)}">
    <summary>
      <span class="vendor-phase-name">${escUiHtml(vendorPhaseLabel(phase))}</span>
      <span class="vendor-phase-state">${escUiHtml(stateWord)}</span>
      <span class="vendor-phase-summary">${escUiHtml(summary)}</span>
    </summary>
    <div class="vendor-phase-body">${body}</div>
  </details>`;
}

function vendorPhaseStepperHTML(view){
  if(!view || !view.phases || !view.phases.length) return "";
  const items = view.phases.map((p, i) => {
    const cls = p.state === "current" ? "current" : p.state === "passed" ? "passed" : "future";
    const aria = p.state === "current" ? ` aria-current="step"` : "";
    const arrow = i < view.phases.length - 1
      ? `<span class="lc-step-arrow" aria-hidden="true">→</span>`
      : "";
    return `<li><button type="button" class="lc-step ${cls}" data-vendor-phase="${escUiHtml(p.id)}"${aria} title="${escUiHtml(vendorPhaseLabel(p))}">${escUiHtml(p.short || vendorPhaseLabel(p))}</button>${arrow}</li>`;
  }).join("");
  return `<ol class="lc-stepper vendor-phase-stepper" aria-label="${escUiHtml(t("vendor_phase_heading"))}">${items}</ol>`;
}

function vendorPhaseActionHTML(view){
  const cur = view && view.current;
  if(!cur) return "";
  const key = cur.action_key || "vendor_phase_action_review_awards";
  if(key === "vendor_phase_action_follow_money" && view.checkbook){
    const href = checkbookSearchUrl(view.checkbook);
    return t("vendor_phase_action_follow_money",{
      href: escUiHtml(href),
      link: `<a href="${escUiHtml(href)}" ${EXT_ATTRS}>${t("lifecycle_source_checkbook")}${extSR()}</a>`
    });
  }
  if(key === "vendor_phase_action_track_registration" && view.checkbook){
    const href = checkbookSearchUrl(view.checkbook);
    return t("vendor_phase_action_track_registration",{
      href: escUiHtml(href),
      link: `<a href="${escUiHtml(href)}" ${EXT_ATTRS}>${t("lifecycle_source_checkbook")}${extSR()}</a>`
    });
  }
  if(key === "vendor_phase_action_review_awards" && view.action_notice_id){
    const parts = [
      t("vendor_phase_action_review_awards_html",{
        href: "#notice/" + encodeURIComponent(view.action_notice_id)
      }),
    ];
    // One Checkbook handoff for registration/payments — never N per award row.
    if(view.checkbook){
      const href = checkbookSearchUrl(view.checkbook);
      parts.push(t("vendor_phase_action_checkbook_once",{
        link: `<a href="${escUiHtml(href)}" ${EXT_ATTRS}>${t("lifecycle_source_checkbook")}${extSR()}</a>`
      }));
    }
    return parts.join(" ");
  }
  return t(key);
}

function vendorChronoRowHTML(m){
  const date = m.date ? fdate(m.date) : "—";
  let label = "";
  if(m.kind === "notice" && m.request_id){
    label = `<b>${escUiHtml(m.notice_type || t("lifecycle_stage_award"))}</b> — ${pivotA("#notice/"+encodeURIComponent(m.request_id), cleanText(m.title)||"(untitled)")}`;
  } else {
    label = `<b>${escUiHtml(m.title || m.stage || "—")}</b>`;
  }
  const extra = [
    m.agency_name ? pivotA(agencyHref(m.agency_name), m.agency_name) : "",
    m.contract_amount != null ? money(m.contract_amount) : "",
  ].filter(Boolean).join(" · ");
  return `<div class="tl"><span class="tldate">${date}</span>
    <span class="tlreason" style="font-weight:400">${label}</span>
    ${extra ? `<span class="rmeta" style="margin:0">${extra}</span>` : ""}</div>`;
}

function vendorPhaseTimelineHTML(view){
  if(!view) return "";
  const cur = view.current || {};
  const phaseName = vendorPhaseLabel({label_key: cur.label_key});
  const countBit = cur.award_count
    ? t("vendor_phase_lead_awards",{n:String(cur.award_count)})
    : (cur.milestone_label || "—");
  const sinceBit = cur.since ? t("vendor_phase_since",{date:fdate(cur.since)}) : "";
  const actionHTML = vendorPhaseActionHTML(view);
  const lead = `<div class="vendor-phase-lead">
    <div class="vendor-phase-now-label">${t("vendor_phase_now_label")}</div>
    <p class="vendor-phase-now-phase">${escUiHtml(phaseName)}</p>
    <p class="vendor-phase-now-detail" lang="en" dir="ltr">${escUiHtml(countBit)}${sinceBit ? ` · ${sinceBit}` : ""}</p>
    ${actionHTML ? `<p class="vendor-phase-action">${actionHTML}</p>` : ""}
    ${view.next ? `<p class="vendor-phase-next">${t("vendor_phase_next_html",{phase:escUiHtml(vendorPhaseLabel(view.next))})}</p>` : ""}
  </div>`;
  const stepper = vendorPhaseStepperHTML(view);
  // All substance behind disclosure (current panel closed until opened).
  const currentPanel = (view.phases || []).filter(p => p.state === "current")
    .map(vendorPhasePanelHTML).join("");
  const historyPanels = (view.phases || []).filter(p => p.state === "passed")
    .map(vendorPhasePanelHTML).filter(Boolean).join("");
  const historyWrap = historyPanels
    ? `<details class="vendor-phase-history"><summary>${t("vendor_phase_show_history")}</summary>${historyPanels}</details>`
    : "";
  const futureNote = (view.phases || []).some(p => p.state === "future" && !p.event_count)
    ? `<p class="vendor-phase-gap">${t("vendor_phase_future_gap_html")}</p>`
    : "";
  const chronoRows = (view.chronological || []).map(vendorChronoRowHTML).join("");
  const how = `<details class="inline-disclose lc-how">
    <summary>${t("vendor_phase_show_all")}</summary>
    <div class="timeline vendor-phase-chrono">${chronoRows}</div>
  </details>
  <details class="inline-disclose lc-how">
    <summary>${t("vendor_phase_how_summary")}</summary>
    <div class="inline-disclose-body">${t("vendor_phase_how_html")}</div>
  </details>`;
  return `${lead}${stepper}${currentPanel}${historyWrap}${futureNote}${how}`;
}

function bindVendorPhaseTimeline(root){
  if(!root) return;
  root.addEventListener("click", (ev) => {
    const step = ev.target.closest?.("[data-vendor-phase]");
    if(step){
      const id = step.getAttribute("data-vendor-phase");
      const panel = root.querySelector(`[data-vendor-phase-panel="${CSS.escape(id)}"]`);
      if(panel){
        panel.open = true;
        panel.scrollIntoView({block:"nearest", behavior:"smooth"});
      }
      return;
    }
    const toggle = ev.target.closest?.("[data-vendor-dates]");
    if(toggle){
      const listId = toggle.getAttribute("data-vendor-dates");
      const list = root.querySelector("#" + CSS.escape(listId));
      if(!list) return;
      const open = list.classList.toggle("show");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.textContent = open
        ? t("vendor_phase_hide_dates")
        : t("vendor_phase_show_dates",{n:String(list.children.length)});
    }
  });
}

async function paintVendorPhaseTimeline(box, profile, rows){
  const host = box && box.querySelector("#vendor-on-the-record");
  if(!host || !rows || !rows.length) return;
  const tools = await ensureVendorPhaseSpineTools();
  if(box.dataset.vendorStem !== profile.stem) return;
  if(!tools || typeof tools.buildVendorPhaseView !== "function"){
    host.innerHTML = `<div class="timeline">${vendorTimelineFlatHTML(rows)}</div>`;
    return;
  }
  const view = tools.buildVendorPhaseView(rows, {
    vendorName: cleanText(profile.display),
    stem: profile.stem,
  });
  host.innerHTML = vendorPhaseTimelineHTML(view);
  bindVendorPhaseTimeline(host);
}

function vendorProfileHTML(profile, details, hydrating){
  const display = cleanText(profile.display);
  const agencies = details?.agencies || profile.topAgencies || [];
  const rows = details?.rows || [];
  const mentions = details?.mentions || [];
  const mentionsProvided = !!details && Object.prototype.hasOwnProperty.call(details,"mentions");
  const forecasts = details?.forecasts || [];
  const hasForecasts = forecasts.length > 0;
  const agChips = agencies.map(a=>{
    const name = a.name||a.agency_name||"";
    return `<a class="chip" style="text-decoration:none" href="${agencyHref(name)}">${escUiHtml(cleanText(name))}<span class="ct">${money(a.total??a.t)||a.n}</span></a>`;
  }).join("");
  // Flat fallback inside the host; paintVendorPhaseTimeline upgrades to phase UI.
  const onTheRecord = rows.length
    ? `<div class="chain-h">${t("vendor_on_the_record")}</div>
        <div id="vendor-on-the-record" class="vendor-phase-timeline" style="margin-top:8px">
          <div class="timeline">${vendorTimelineFlatHTML(rows)}</div>
        </div>`
    : "";
  const mentionItems = vendorMentionItemsHTML(mentions);
  const lazyMentions = !hydrating && !mentionsProvided ? `<details id="vendor-mentions-lazy" style="margin-top:18px">
        <summary class="chain-h" style="cursor:pointer">${t("vendor_mentions_heading")}</summary>
        <div id="vendor-mentions-results"></div>
      </details>` : "";
  const loadingSections = hydrating ? `<div id="vendor-live" aria-busy="true">
        <div class="chain-h">${t("vendor_on_the_record")}</div><div class="empty" style="padding:12px"><span class="loading"></span></div>
        <div class="chain-h">${t("vendor_mentions_heading")}</div><div class="empty" style="padding:12px"><span class="loading"></span></div>
        <div class="chain-h">${t("forecast_section_heading")}</div><div class="empty" style="padding:12px"><span class="loading"></span></div>
      </div>` : "";
  // Checkbook outbound is only in the phase lead (one per profile) — note names the source only.
  return `<div style="max-width:880px;margin:0 auto">
    <p style="margin:4px 0 12px">${routeBackHTML("#money")}</p>
    <div class="panel route-item" tabindex="-1" style="padding:22px 24px">
      ${vendorProfileHeaderHTML(profile)}

      ${hasForecasts ? `<div class="subtabs" style="display:flex;gap:16px;border-bottom:1px solid #dde1e7;margin:16px 0 20px">
        <button class="subtab active" id="btn-overview" style="font-family:var(--font-sc);font-weight:600;font-size:12px;letter-spacing:.15em;text-transform:uppercase;padding:9px 0;border:none;background:none;color:var(--oxblood);border-bottom:2px solid var(--oxblood);cursor:pointer">${t("forecast_overview_tab")}</button>
        <button class="subtab" id="btn-forecast" style="font-family:var(--font-sc);font-weight:600;font-size:12px;letter-spacing:.15em;text-transform:uppercase;padding:9px 0;border:none;background:none;color:var(--muted);border-bottom:2px solid transparent;cursor:pointer">${t("forecast_subtab_label",{n:forecasts.length})}</button>
      </div>` : ""}

      <div id="overview-content">
        ${agencies.length?`<div class="chain-h">${t("vendor_agencies_heading")}</div><div class="chiprow" style="margin-top:6px">${agChips}</div>`:""}
        <div id="vendor-footprint"></div>
        ${onTheRecord}
        ${mentions.length?`<div class="chain-h">${t("vendor_mentions_heading")}</div><div class="timeline">${mentionItems}</div>`:""}
        ${loadingSections}
        ${lazyMentions}
      </div>

      ${hasForecasts ? `<div id="forecast-content" style="display:none">${forecastPaneHTML(forecasts)}</div>` : ""}

      ${profile.asOf?`<div class="rmeta" style="margin-top:12px">${t("external_awards_updated",{date:fdate(profile.asOf)})}</div>`:""}
      <div class="actions" style="margin-top:16px">
        <button class="act primary" type="button" data-follow="vendor" data-name="${display.replace(/"/g,"&quot;")}">${t("vendor_follow_btn")}</button>
        <button class="act" type="button" id="ecopy">${t("copy_link")}</button>
        ${qrButtonHTML("eqr","act")}
        ${pinBtn("vendor", display, display, t("meta_vendor_profile"))}
        ${API?`<a class="act" href="${API.replace(/\/+$/,"")}/feed.xml?lens=entity&kind=vendor&name=${encodeURIComponent(display)}">RSS</a>`:""}
      </div>
      <div class="note">${t("vendor_identity_note_html",{source: t("lifecycle_source_checkbook")})}</div>
    </div></div>`;
}

function renderVendorProfile(box, profile, details, initialTab, hydrating){
  const display = cleanText(profile.display);
  const link = location.origin + location.pathname + vendorHref(display);
  box.dataset.vendorStem = profile.stem;
  box.innerHTML = vendorProfileHTML(profile, details, hydrating);
  $("#ecopy").addEventListener("click", ()=>copyText(link, $("#ecopy")));
  bindQRShare($("#eqr"), link);
  const rows = details?.rows || [];
  if(rows.length && !hydrating) paintVendorPhaseTimeline(box, profile, rows);
  if(details?.footprint) paintVendorFootprint(box, details.footprint);
  const lazyMentions = $("#vendor-mentions-lazy");
  if(lazyMentions) lazyMentions.addEventListener("toggle", ()=>{
    if(!lazyMentions.open || lazyMentions.dataset.loaded) return;
    lazyMentions.dataset.loaded = "true";
    loadVendorMentions(profile, $("#vendor-mentions-results"));
  });

  if(details?.forecasts?.length){
    const btnOverview = $("#btn-overview"), btnForecast = $("#btn-forecast");
    const paneOverview = $("#overview-content"), paneForecast = $("#forecast-content");
    btnOverview.addEventListener("click", ()=>{
      btnOverview.style.color="var(--oxblood)"; btnOverview.style.borderBottomColor="var(--oxblood)";
      btnForecast.style.color="var(--muted)"; btnForecast.style.borderBottomColor="transparent";
      paneOverview.style.display="block"; paneForecast.style.display="none";
    });
    btnForecast.addEventListener("click", ()=>{
      btnForecast.style.color="var(--oxblood)"; btnForecast.style.borderBottomColor="var(--oxblood)";
      btnOverview.style.color="var(--muted)"; btnOverview.style.borderBottomColor="transparent";
      paneOverview.style.display="none"; paneForecast.style.display="block";
    });
    box.querySelectorAll(".mini-sub-btn").forEach(b=>b.addEventListener("click", ()=>{
      const kind = b.dataset.watchKind === "agency" ? "agency" : "vendor";
      const watchName = b.dataset.watchName || "";
      import("../alerts_context_carry.mjs")
        .then(carry=>location.assign(carry.alertsHref({lens:"entity",filter:{kind,name:watchName}})))
        .catch(()=>location.assign("/following/"));
    }));
    if(initialTab==="forecast") btnForecast.click();
  }
}

async function loadVendorMentions(profile, el){
  if(!el) return;
  el.innerHTML = `<div class="empty" style="padding:12px"><span class="loading"></span></div>`;
  let mentions = [];
  try{
    mentions = await soda({"$select":SELECT,"$where":`vendor_name IS NULL AND start_date > '${recentCut()}'`,"$q":profile.stem,"$order":"start_date DESC","$limit":"8"},8000);
  }catch(e){}
  if(!document.contains(el)) return;
  el.innerHTML = mentions.length ? `<div class="timeline">${vendorMentionItemsHTML(mentions)}</div>` : "";
}

async function hydrateVendorProfile(profile, initialTab, box, fetchAgencies){
  const names = profile.variants.map(v=>v.name).slice(0,20);
  const inList = names.map(n=>`'${n.replace(/'/g,"''")}'`).join(",");
  const [agencies, rows, mentions, forecastData, footprint] = await Promise.all([
    fetchAgencies
      ? soda({"$select":"agency_name, count(1) as n, sum(contract_amount) as t","$where":`vendor_name in(${inList}) AND type_of_notice_description='Award' AND contract_amount < ${MONEY_HONESTY_CAP}`,"$group":"agency_name","$order":"t DESC","$limit":"10"},15000).catch(()=>[])
      : Promise.resolve(profile.topAgencies||[]),
    soda({"$select":SELECT,"$where":`vendor_name in(${inList})`,"$order":"start_date DESC","$limit":"15"},15000).catch(()=>[]),
    soda({"$select":SELECT,"$where":`vendor_name IS NULL AND start_date > '${recentCut()}'`,"$q":profile.stem,"$order":"start_date DESC","$limit":"8"},8000).catch(()=>[]),
    workerFetch("/inv/"+encodeURIComponent(profile.display),null,8000).then(r=>r.ok?r.json():null).catch(()=>null),
    loadVendorFootprint(profile.display)
  ]);
  if(box.dataset.vendorStem !== profile.stem) return;
  renderVendorProfile(box, profile, {agencies,rows,mentions,forecasts:forecastData?.forecasts||[],footprint}, initialTab, false);
}

async function showVendorLive(name, initialTab, box){
  const stem = vendorStem(name), safe = cleanText(name).replace(/[<>&]/g,"");
  box.innerHTML = `<div class="empty"><span class="loading"></span> resolving vendor: ${safe}…</div>`;
  let variants = [];
  try{
    variants = await soda({"$select":"vendor_name, count(1) as n, sum(contract_amount) as t, min(start_date) as first, max(start_date) as last",
      "$where":`vendor_name IS NOT NULL AND type_of_notice_description='Award' AND contract_amount < ${MONEY_HONESTY_CAP}`,
      "$q":stem,"$group":"vendor_name","$limit":"100"});
  }catch(e){}
  variants = variants.filter(v=>vendorStem(v.vendor_name)===stem);
  if(!variants.length){
    box.innerHTML = `<div class="empty">No awards on record for “${safe}”. <a href="#money?q=${encodeURIComponent(stem.toLowerCase())}">Search notices mentioning them →</a></div>`;
    return;
  }
  const profile = vendorProfileFromVariants(variants);
  renderVendorProfile(box, profile, null, initialTab, true);
  announce(t("meta_vendor_profile_announce",{name:cleanText(profile.display)}));
  await hydrateVendorProfile(profile, initialTab, box, true);
  focusItemRouteTarget(box.querySelector(".route-item"));
  applyActiveHistoryRouteScroll();
}

async function showVendor(name, initialTab){
  showTab("entity");
  const box = $("#entityview");
  delete box.dataset.vendorStem;
  const stem = vendorStem(name), safe = cleanText(name).replace(/[<>&]/g,"");
  if(stem.length < 3){ box.innerHTML = `<div class="empty">${t("vendor_name_too_short",{name:safe})} ${routeBackHTML("#money")}</div>`; applyActiveHistoryRouteScroll(); return; }
  box.innerHTML = `<div style="max-width:880px;margin:0 auto"><div class="panel" style="padding:22px 24px"><h2 class="rolename" lang="en" dir="ltr">${safe}</h2><div class="agencybar" aria-hidden="true"><div><div class="big">—</div></div><div><div class="big">—</div></div><div><div class="big">—</div></div></div></div></div>`;
  const [profile, footprint] = await Promise.all([
    loadVendorProfileRecord(name),
    loadVendorFootprint(name),
  ]);
  if(!profile) return showVendorLive(name, initialTab, box);
  renderVendorProfile(box, profile, {
    agencies:profile.topAgencies||[],
    rows:profile.recentNotices,
    forecasts:profile.forecasts,
    footprint
  }, initialTab, false);
  announce(t("meta_vendor_profile_announce",{name:cleanText(profile.display)}));
  focusItemRouteTarget(box.querySelector(".route-item"));
  applyActiveHistoryRouteScroll();
}

// Publish live bindings for neighboring modules and legacy inline handlers.
globalThis.VENDOR_SUFFIX = VENDOR_SUFFIX;
globalThis.agencyForecastTeaser = agencyForecastTeaser;
globalThis.agencyHref = agencyHref;
globalThis.agencyProfileBar = agencyProfileBar;
globalThis.bindVendorPhaseTimeline = bindVendorPhaseTimeline;
globalThis.doingBusinessCardHTML = doingBusinessCardHTML;
globalThis.ensureVendorPhaseSpineTools = ensureVendorPhaseSpineTools;
globalThis.escUiHtml = escUiHtml;
globalThis.forecastItemHTML = forecastItemHTML;
globalThis.forecastItemsHTML = forecastItemsHTML;
globalThis.forecastPaneHTML = forecastPaneHTML;
globalThis.hydrateVendorProfile = hydrateVendorProfile;
globalThis.loadVendorFootprint = loadVendorFootprint;
globalThis.loadVendorMentions = loadVendorMentions;
globalThis.loadVendorProfileRecord = loadVendorProfileRecord;
globalThis.paintVendorPhaseTimeline = paintVendorPhaseTimeline;
globalThis.pivotA = pivotA;
globalThis.renderVendorProfile = renderVendorProfile;
globalThis.renderVendorVariants = renderVendorVariants;
globalThis.showAgency = showAgency;
globalThis.showOfficial = showOfficial;
globalThis.showVendor = showVendor;
globalThis.showVendorLive = showVendorLive;
globalThis.vendorChronoRowHTML = vendorChronoRowHTML;
globalThis.vendorHref = vendorHref;
globalThis.vendorMentionItemsHTML = vendorMentionItemsHTML;
globalThis.vendorNamesMatch = vendorNamesMatch;
globalThis.vendorPhaseActionHTML = vendorPhaseActionHTML;
globalThis.vendorPhaseLabel = vendorPhaseLabel;
globalThis.vendorPhasePanelHTML = vendorPhasePanelHTML;
globalThis.vendorPhaseStepperHTML = vendorPhaseStepperHTML;
globalThis.vendorPhaseTimelineHTML = vendorPhaseTimelineHTML;
globalThis.vendorPhaseYearAggHTML = vendorPhaseYearAggHTML;
globalThis.vendorProfileFromVariants = vendorProfileFromVariants;
globalThis.vendorProfileHTML = vendorProfileHTML;
globalThis.vendorProfileHeaderHTML = vendorProfileHeaderHTML;
globalThis.vendorStem = vendorStem;
globalThis.vendorTimelineFlatHTML = vendorTimelineFlatHTML;
Object.defineProperty(globalThis, "vendorPhaseSpineToolsPromise", { configurable: true, get: () => vendorPhaseSpineToolsPromise, set: value => { vendorPhaseSpineToolsPromise = value; } });
