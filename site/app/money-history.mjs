/* Cross-PIN prior-cycle matches require a 180-day gap and remain labeled as heuristic. */
const PRIOR_CYCLE_MIN_GAP_DAYS = 180;
const PRIOR_CYCLE_MAX_MATCHES = 3;
const PRIOR_CYCLE_STOPWORDS = new Set("the a an of for and to in on with by at services service contract contracts renewal option year years extension citywide fiscal".split(" "));

function priorCycleTitleWords(title){
  const seen = new Set();
  String(title||"").toLowerCase().replace(/[^a-z0-9 ]/g," ").split(/\s+/).forEach(w=>{
    if(w.length > 2 && !PRIOR_CYCLE_STOPWORDS.has(w)) seen.add(w);
  });
  return [...seen];
}

function daysBetween(a, b){
  const da = new Date(a), db = new Date(b);
  if(isNaN(da) || isNaN(db)) return null;
  return Math.abs(da - db) / 86400000;
}

function rankPriorCycleCandidates(r, candidates, opts){
  const maxN = (opts && opts.maxN) || PRIOR_CYCLE_MAX_MATCHES;
  const minGapDays = (opts && opts.minGapDays) || PRIOR_CYCLE_MIN_GAP_DAYS;
  const myWords = priorCycleTitleWords(r.short_title);
  if(!myWords.length) return [];
  const seenPins = new Set();
  return candidates
    .filter(c => c.request_id !== r.request_id)
    .filter(c => c.agency_name === r.agency_name) // belt-and-suspenders — the SODA $where already scopes to this agency
    .filter(c => !usablePin(r.pin) || c.pin !== r.pin) // r's own PIN chain is chainHTML()'s job, not this
    .filter(c => (c.start_date||"") < (r.start_date||"")) // only PRIOR cycles — "who won it last time"
    .filter(c => { const g = daysBetween(c.start_date, r.start_date); return g !== null && g >= minGapDays; })
    .map(c => {
      const overlap = priorCycleTitleWords(c.short_title).filter(w => myWords.includes(w));
      return {c, score: overlap.length / myWords.length};
    })
    .filter(x => x.score >= 0.5) // majority of this notice's significant title words must recur
    .sort((a,b)=> b.score - a.score || (b.c.start_date||"").localeCompare(a.c.start_date||""))
    .map(x => x.c)
    .filter(c => { // one row per PIN — a multi-vendor pool's own split shouldn't repeat as separate "cycles"
      if(seenPins.has(c.pin)) return false;
      seenPins.add(c.pin);
      return true;
    })
    .slice(0, maxN);
}

function priorCycleHTML(matches){
  const rows = matches.map(c => `<div class="stage"><div class="box">
      <div class="when">${fdate(c.start_date)}</div>
      <div class="bt">${escUiHtml(cleanText(c.short_title))}</div>
      ${money(c.contract_amount) ? `<div class="amt">${money(c.contract_amount)}</div>` : ""}
      ${c.vendor_name ? `<div class="vend">→ ${pivotA(vendorHref(c.vendor_name), cleanText(c.vendor_name))}</div>` : ""}
      <a class="view" href="${REQ_URL(c.request_id)}" ${EXT_ATTRS}>${t("view_in_city_record")}${extSR()}</a>
    </div></div>`).join("");
  // Matches only — no methodology note about how they were linked.
  return `<div class="chain-h">${t("prior_cycle_heading")}</div><div class="chain">${rows}</div>`;
}

// When there is no confident prior cycle, show nothing — no absence narrative or
// match-method speculation. Optional near matches remain behind an explicit reveal.
function priorCycleNoneHTML(r, eligibleCount, near){
  if(near && near.length) return nearMatchRevealHTML();
  return "";
}

async function priorCycleAwards(r, el){
  if(!isContractLifecycleEligible(r)) return;
  if(!el || !r.agency_name || !cleanText(r.short_title)) return;
  if(priorCycleTitleWords(r.short_title).length < 2){ el.innerHTML = priorCycleNoneHTML(r, 0, []); return; } // too generic to search — no worker round trip
  let data = null;
  try{
    const resp = await workerFetch("/priorcycle/" + encodeURIComponent(r.request_id), null, 8000);
    if(resp && resp.ok) data = await resp.json();
  }catch(e){}
  if(!document.contains(el)) return; // a newer selection replaced this panel
  if(!data || data.ok === false || !Array.isArray(data.strict) || !Array.isArray(data.near)) return; // network/degraded — say nothing rather than something wrong, same posture as followDollars
  if(data.strict.length){ el.innerHTML = priorCycleHTML(data.strict); return; }
  el.innerHTML = priorCycleNoneHTML(r, data.eligibleCount, data.near);
  wireNearMatchReveal(el, data.near);
}

/* Near matches require title overlap plus PIN-prefix or amount corroboration. */
const NEAR_MATCH_MIN_SCORE = 0.34; // "at least a third of this notice's significant title words recur" — looser than the strict majority bar, still real overlap, not one coincidental shared word
const NEAR_MATCH_MAX_MATCHES = 3;
const NEAR_MATCH_PIN_PREFIX_MIN_LEN = 8; // shared leading chars of the renewal-suffix-stripped PIN -- deliberately deeper than a same-agency PIN scheme's own common stem (a 2000s-era Correction PIN's first 6 chars, e.g. "072200", are shared by nearly every contract that agency issued that decade and prove nothing on their own — verified live against 700+ same-agency pairs)
const NEAR_MATCH_AMOUNT_RATIO_MAX = 3; // larger/smaller contract_amount no more than 3x apart counts as "comparable"
const NEAR_MATCH_QUERY_WORDS = 2; // widened $q word count for the near query (now run by the worker's /priorcycle endpoint; mirrored here for the dual-impl) — see file header

function pinPrefixShared(a, b){
  const sa = pinBase(a) || a, sb = pinBase(b) || b;
  let n = 0;
  while(n < sa.length && n < sb.length && sa[n] === sb[n]) n++;
  return n;
}

function nearMatchReasons(r, c, overlapWords){
  const reasons = [{kind:"agency"}, {kind:"title", words:overlapWords}];
  if(usablePin(r.pin) && usablePin(c.pin) && pinPrefixShared(r.pin, c.pin) >= NEAR_MATCH_PIN_PREFIX_MIN_LEN){
    reasons.push({kind:"pin", prefix: (pinBase(c.pin)||c.pin).slice(0, NEAR_MATCH_PIN_PREFIX_MIN_LEN)});
  }
  const ra = +r.contract_amount, ca = +c.contract_amount;
  if(ra > 0 && ca > 0 && Math.max(ra,ca)/Math.min(ra,ca) <= NEAR_MATCH_AMOUNT_RATIO_MAX){
    reasons.push({kind:"amount", a: ra, b: ca});
  }
  return reasons;
}

function rankNearMatchCandidates(r, candidates, strictMatches, opts){
  const maxN = (opts && opts.maxN) || NEAR_MATCH_MAX_MATCHES;
  const minGapDays = (opts && opts.minGapDays) || PRIOR_CYCLE_MIN_GAP_DAYS;
  const minScore = (opts && opts.minScore) || NEAR_MATCH_MIN_SCORE;
  const myWords = priorCycleTitleWords(r.short_title);
  if(!myWords.length) return [];
  const strictIds = new Set((strictMatches||[]).map(c => c.request_id));
  const seenPins = new Set();
  return candidates
    .filter(c => c.request_id !== r.request_id)
    .filter(c => !strictIds.has(c.request_id)) // never re-surface a confident match as a maybe
    .filter(c => c.agency_name === r.agency_name)
    .filter(c => !usablePin(r.pin) || c.pin !== r.pin)
    .filter(c => (c.start_date||"") < (r.start_date||""))
    .filter(c => { const g = daysBetween(c.start_date, r.start_date); return g !== null && g >= minGapDays; })
    .map(c => {
      const cWords = priorCycleTitleWords(c.short_title);
      const overlap = cWords.filter(w => myWords.includes(w));
      return {c, score: overlap.length / myWords.length, overlap};
    })
    .filter(x => x.score >= minScore && x.score < 0.5) // below the strict bar -- an equal-or-better match already is one
    .map(x => ({...x, reasons: nearMatchReasons(r, x.c, x.overlap)}))
    .filter(x => x.reasons.some(rs => rs.kind === "pin" || rs.kind === "amount")) // title overlap alone is too noisy — see file header
    .sort((a,b)=> b.score - a.score || (b.c.start_date||"").localeCompare(a.c.start_date||""))
    .filter(x => { if(seenPins.has(x.c.pin)) return false; seenPins.add(x.c.pin); return true; }) // one row per PIN
    .slice(0, maxN);
}

function nearMatchReasonHTML(reason){
  if(reason.kind === "agency") return t("near_match_reason_agency");
  if(reason.kind === "title") return t("near_match_reason_title_html", {words: reason.words.map(w=>`<mark>${w}</mark>`).join(", ")});
  if(reason.kind === "pin") return t("near_match_reason_pin_html", {prefix: `<code>${reason.prefix}</code>`});
  return t("near_match_reason_amount_html", {a: money(reason.a), b: money(reason.b)});
}

// Visually tiered from the confident chain's own boxes (.box.maybe). "Maybe" marks
// uncertainty; do not narrate internal match reasons or absence methodology.
function nearMatchHTML(items){
  const rows = items.map(x => `<div class="stage"><div class="box maybe">
      <div class="stage-name">${t("near_match_tag")}</div>
      <div class="when">${fdate(x.c.start_date)}</div>
      <div class="bt">${escUiHtml(cleanText(x.c.short_title))}</div>
      ${money(x.c.contract_amount) ? `<div class="amt">${money(x.c.contract_amount)}</div>` : ""}
      ${x.c.vendor_name ? `<div class="vend">→ ${pivotA(vendorHref(x.c.vendor_name), cleanText(x.c.vendor_name))}</div>` : ""}
      <a class="view" href="${REQ_URL(x.c.request_id)}" ${EXT_ATTRS}>${t("view_in_city_record")}${extSR()}</a>
    </div></div>`).join("");
  return `<div class="chain-h">${t("near_match_heading")}</div><div class="chain">${rows}</div>`;
}

function nearMatchRevealHTML(){
  return `<details class="near-match-reveal"><summary>${t("near_match_reveal_btn")}</summary><div class="near-match-body"></div></details>`;
}

// Phase 1b: the near matches arrive PRE-LOADED alongside the strict tier from the /priorcycle
// endpoint, so the reveal no longer fires a lazy second fetch on open — its body is populated up
// front from the near array priorCycleAwards() already has in hand. priorCycleNoneHTML() only
// emits the reveal markup when near.length > 0, so a non-empty near array is guaranteed whenever
// the reveal is present.
function wireNearMatchReveal(el, near){
  const details = el.querySelector(".near-match-reveal");
  if(!details || !near || !near.length) return;
  const body = details.querySelector(".near-match-body");
  if(body) body.innerHTML = nearMatchHTML(near);
}

async function loadAgencyStats(agency, variants){
  try{
    const names = Array.isArray(variants) && variants.length ? variants : [agency];
    const accepted=new Set(names.map(String));
    const rows=(await globalThis.residentMoneyRows?.()||[]).filter(row=>
      accepted.has(String(row.agency_name||"")) && row.type_of_notice_description==="Award" &&
      Number(row.contract_amount)>0 && Number(row.contract_amount)<MONEY_HONESTY_CAP
    );
    return {n:rows.length,total:rows.reduce((sum,row)=>sum+Number(row.contract_amount||0),0)};
  }catch(e){ return null; }
}

/* ===================== AWARDS PUBLISHED OUTSIDE THE CITY RECORD =====================
   Public authorities post solicitations in the City Record but file awards elsewhere. The
   AWARD_SOURCE_REGISTRY (external_awards.js) drives all three of: which agencies are swept,
   the join precision, and the coverage claim the empty state makes. The award DATA is
   precomputed server-side and served by GET /externalaward (worker/src/external_award.mjs) —
   one workerFetch, no live per-view SODA/Checkbook calls. Exact (NYCHA/Checkbook, PIN) and
   fuzzy (ABO, vendor+date) results stay visually and verbally distinct: a fuzzy result reads
   as "possible," never asserted. */

// One loader for both surfaces (notice detail by id, agency profile by agency). Returns the
// endpoint's coverage-shaped JSON, or null on any failure (say-nothing posture — never render a
// wrong "no awards" over a transient outage).
async function loadExternalAward(params){
  if(!API) return null;
  const qs = params.id ? "id="+encodeURIComponent(params.id) : "agency="+encodeURIComponent(params.agency||"");
  try{
    const r = await workerFetch("/externalaward?"+qs, null, 12000);
    if(!r.ok) return null;
    const j = await r.json();
    return (j && j.ok !== false) ? j : null;
  }catch(e){ return null; }
}

import { solicitationResponseContextReady } from "../solicitation_response_context.mjs";
import { noticeDisplayTitle } from "../display_title.mjs";

// Every note naming an external source carries a working, scoped link to it
// — a note that only SAYS the answer lives elsewhere, with no way to go look, isn't an
// affordance. Link shapes below were verified live against the real destinations (contract
// detail resolves purely by contract id regardless of the year/agency path segments; the ABO
// dataset's SODA endpoint accepts a plain `authority_name=` filter param) before shipping.
const CHECKBOOK_NYCHA_AGENCY_ID = "162"; // NYCHA's fixed agency id on checkbooknyc.com

// A link to the human-readable ABO dataset page on data.ny.gov. There is no stable public
// per-record page for these filings, so reader-facing links must not land on the raw JSON API.
// Malformed/missing registry data (no dataset or authority) fails soft to unlinked source-name
// text, never a broken href.
function aboSourceLink(dataset, authority){
  if(!dataset || !authority) return t("external_awards_abo_source");
  return `<a href="https://data.ny.gov/d/${encodeURIComponent(dataset)}" ${EXT_ATTRS}>${t("external_awards_abo_source")}${extSR()}</a>`;
}
// A link to Checkbook NYC's NYCHA contracts, scoped to one matched contract when we have it
// (the most specific view we can construct) or NYCHA's whole contracts list otherwise.
function checkbookNychaLink(contractId){
  if(!contractId) return t("external_awards_checkbook_source");
  return `<a href="https://www.checkbooknyc.com/nycha_contract_details/agency/${CHECKBOOK_NYCHA_AGENCY_ID}/datasource/checkbook_nycha/contract/${encodeURIComponent(contractId)}" ${EXT_ATTRS}>${t("external_awards_checkbook_source")}${extSR()}</a>`;
}
function checkbookNychaContractsLink(){
  return `<a href="https://www.checkbooknyc.com/nycha_contracts/datasource/checkbook_nycha/agency/${CHECKBOOK_NYCHA_AGENCY_ID}" ${EXT_ATTRS}>${t("external_awards_checkbook_source")}${extSR()}</a>`;
}

// The registry-driven empty-state claim for a zero-City-Record-award agency (Deliverable 3):
// covered -> name + link the source; verified-absent -> say so, linked to what we checked;
// unknown -> the existing hedge, linked to the same provenance doc.
function agencyAwardsNote(agency){
  const cov = awardCoverage(agency);
  if(cov==="absent") return `<div class="note">${t("agency_awards_none_open_data_html")}</div>`;
  if(cov==="exact"||cov==="fuzzy"){
    const e = awardSourceFor(agency);
    const src = e.kind==="abo" ? aboSourceLink(e.dataset, e.authority) : checkbookNychaContractsLink();
    return `<div class="note">${t("agency_awards_elsewhere_note",{source:src})}</div>`;
  }
  return `<div class="note">${t("agency_awards_unavailable_note_html")}</div>`;
}

// Award-arrival alerts: the opt-in surfaces exactly where the promise is
// made — the "checked, nothing yet" empty state for a covered agency's own notice, never the
// agency-level profile (no notice param there, and there's no single notice to attach the watch
// to). externalAwardForNotice() wires the click after innerHTML lands.
function awardWatchOfferHTML(notice){
  if(!notice || !notice.request_id) return "";
  return `<button class="act" type="button" data-award-watch-offer style="margin-top:8px">${t("award_watch_offer_btn")}</button>`;
}

function sourceUpdatedHTML(refreshed){
  return refreshed ? ` <span class="rmeta" style="margin:0">${t("external_awards_updated",{date:refreshed})}</span>` : "";
}

// Fuzzy ABO awards render as a "possible" timeline (distinct from the exact NYCHA box below).
function aboAwardsTimelineHTML(awards, source){
  const rows = awards.map(a=>{
    const vendor = a.vendor ? `<b lang="en" dir="ltr">${globalThis.v?.(a.vendor)||escUiHtml(a.vendor)}</b>` : `<b>${t("past_winners_vendor_unlisted")}</b>`;
    const description = a.description ? `<span lang="en" dir="ltr"> — ${escUiHtml(a.description)}</span>` : "";
    const meta = [money(a.amount), a.process ? `<span lang="en" dir="ltr">${escUiHtml(a.process)}</span>` : ""].filter(Boolean).join(" · ");
    return `<div class="tl">
      <span class="tldate">${fdate(a.date)||"—"}</span>
      <span class="tlreason">${vendor}${description}</span>
      <span class="rmeta" style="margin:0">${meta}</span>
    </div>`;
  }).join("");
  return `<div id="external-awards-content"><div class="chain-h">${t("external_awards_heading")}</div>
    <div class="timeline">${rows}</div>
    <div class="pnote">${t("external_awards_abo_note")} ${aboSourceLink(source.dataset, source.authority)}${sourceUpdatedHTML(source?.refreshed)}</div></div>`;
}

// Exact NYCHA award renders as a confident chain box linked to its Checkbook NYC record.
function nychaAwardBoxHTML(c, pin){
  return `<div class="chain-h">${t("external_awards_heading")}</div><div class="chain">
    <div class="stage"><div class="box award">
      <div class="stage-name">${t("mode_award")}</div><div class="when">${fdate(c.approved||c.start)}</div>
      <div class="bt" lang="en" dir="ltr">${escUiHtml(c.purpose||`${t("lifecycle_dollars_contract_lbl")} ${c.id||pin}`)}</div>
      ${money(c.amount)?`<div class="amt">${money(c.amount)}</div>`:""}
      ${c.vendor?`<div class="vend">${t("awarded_to")} <b lang="en" dir="ltr">${globalThis.v?.(c.vendor)||escUiHtml(c.vendor)}</b></div>`:""}
      ${c.method?`<div class="rmeta" lang="en" dir="ltr">${escUiHtml(c.method)}</div>`:""}
    </div></div></div>
    <div class="pnote">${checkbookNychaLink(c.id)}</div>`;
}

// Turn one /externalaward response into the award region's HTML. `notice` (optional) lets the
// NYCHA path show the PIN and gate the "nothing found yet" note to eligible solicitations.
function externalAwardHTML(resp, notice){
  if(!resp) return "";
  if(resp.coverage==="exact"){
    const matches = resp.matches||[];
    if(matches.length) return nychaAwardBoxHTML(matches[0], notice?notice.pin:"");
    if(notice && notice.type_of_notice_description==="Solicitation" && usablePin(notice.pin)){
      return awardWatchOfferHTML(notice);
    }
    return "";
  }
  if(resp.coverage==="fuzzy"){
    const awards = resp.agencyAwards||[];
    const source = resp.source||{};
    if(awards.length) return aboAwardsTimelineHTML(awards, source);
    return awardWatchOfferHTML(notice);
  }
  return "";
}

// Duplicate boxClass declaration removed during module conversion; the second declaration was byte-identical.

function boxClass(t){ return t==="Award" ? "award" : (t==="Intent to Award" ? "intent" : ""); }

function telHref(phone){ const d = String(phone||"").replace(/[^0-9+]/g,""); return d.length>=7 ? "tel:"+d : null; }

/* ===== At-a-glance: who / what / when / act, extracted from fields the record already has.
   No model call — field re-presentation can't hallucinate and costs nothing per view. ===== */
const AGENCY_ABBR = {
  "Housing Preservation and Development":"HPD","Citywide Administrative Services":"DCAS",
  "Design and Construction":"DDC","Environmental Protection":"DEP","Police Department":"NYPD",
  "Transportation":"DOT","Parks and Recreation":"Parks","Health and Mental Hygiene":"DOHMH",
  "Education":"DOE","Fire Department":"FDNY","Sanitation":"DSNY","Buildings":"DOB",
  "Homeless Services":"DHS","Housing Authority":"NYCHA","School Construction Authority":"SCA",
  "Economic Development Corporation":"EDC","Taxi and Limousine Commission":"TLC",
  "City Planning":"DCP","Law Department":"Law Dept","Finance":"DOF",
  "Information Technology and Telecommunications":"OTI","Small Business Services":"SBS",
  "Youth and Community Development":"DYCD","Correction":"DOC","Probation":"DOP",
  "Administration for Children's Services":"ACS","Human Resources Administration":"HRA",
  "Emergency Management":"NYCEM","Landmarks Preservation Commission":"LPC",
  "City University of New York":"CUNY","District Attorney - New York County":"DANY",
  "Environmental Protection Administration":"DEP","Health and Hospitals Corporation":"H+H",
  "Mayor's Office of Contract Services":"MOCS","Board of Standards and Appeals":"BSA"
};
function agencyWho(name){ const a = AGENCY_ABBR[String(name||"").trim()]; return a ? `${name} (${a})` : (name||""); }

// Agency-identity join (site owner's "real other-agency data" ask): the agency profile's plain
// City Record name, enriched with the agency's canonical identity card — website, principal
// officer, organization type, budget code + adopted budget — resolved in the Worker against a
// static crosswalk built from the City's own open data (GET /agency; worker/src/agency.mjs). The
// provenance line names each source dataset by its own NYC Open Data id, per the honest-data
// register. A no-match (matched:false / an out-of-roster body like a bi-state authority) renders
// NOTHING, so the profile degrades gracefully to the City Record name alone.
function agencyBudgetDisplay(n){
  const v = Number(n);
  if(!v || isNaN(v) || v <= 0) return null;
  if(v >= 1e9) return "$" + (v/1e9).toFixed(2) + "B";
  if(v >= 1e6) return "$" + (v/1e6).toFixed(1) + "M";
  return "$" + v.toLocaleString("en-US",{maximumFractionDigits:0});
}
function agencyIdentityHTML(resp){
  if(!resp || !resp.matched || !resp.identity) return "";
  const id = resp.identity;
  const en = (s) => `<span lang="en" dir="ltr">${escUiHtml(s)}</span>`;
  const rows = [];
  if(id.head_name){
    const who = id.head_title ? `${id.head_title} · ${id.head_name}` : id.head_name;
    const leader = id.leader && id.leader.entity_type === "person-leader" && id.leader.id
      ? `<a class="entity-pivot" href="/agencies/${encodeURIComponent(id.leader.agency_id || "")}/" data-entity-ref="${escUiHtml(id.leader.id)}" data-link-confidence="strong" data-relation="agency_led_by">${en(who)}</a>`
      : en(who);
    rows.push([t("agency_identity_led_by"), leader]);
  }
  if(id.reports_to) rows.push([t("agency_identity_reports_to"), en(id.reports_to)]);
  if(id.org_type) rows.push([t("agency_identity_org_type"), en(id.org_type)]);
  const budget = agencyBudgetDisplay(id.budget_adopted);
  if(budget) rows.push([t("agency_identity_budget", {fy: escUiHtml(String(id.budget_fy||""))}), en(budget)]);
  if(id.budget_code) rows.push([t("agency_identity_budget_code"), en(id.budget_code)]);
  if(id.url){
    const aurl = escUiHtml(id.url);
    rows.push([t("agency_identity_website_label"),
      `<a href="${aurl}" ${EXT_ATTRS}>${t("agency_identity_website_link")}${extSR()}</a>`]);
  }
  const defs = rows.map(([k,v]) =>
    `<div class="aidrow"><dt class="aidk">${k}</dt><dd class="aidv">${v}</dd></div>`).join("");

  // Provenance: name each source dataset by its own NYC Open Data id and link it.
  const prov = resp.provenance || {};
  const byId = {}; (prov.sources||[]).forEach(s => { byId[s.id] = s; });
  const srcLink = (sid, textKey) => {
    const s = byId[sid];
    if(!s || !s.url) return t(textKey);
    const surl = escUiHtml(s.url);
    return `<a href="${surl}" ${EXT_ATTRS}>${t(textKey)}${extSR()}</a>`;
  };
  const provLine = t("agency_identity_provenance_html", {
    roster: srcLink("t3jq-9nkf", "agency_identity_source_roster"),
    budget: srcLink("mwzb-yiwb", "agency_identity_source_budget"),
    date: escUiHtml(prov.downloaded || ""),
  });

  return `<div class="aidcard">
      <div class="aidhead">
        <div class="aidname" lang="en" dir="ltr">${escUiHtml(id.canonical_name)}${id.acronym?` <span class="aidacr">${escUiHtml(id.acronym)}</span>`:""}</div>
        <div class="aidtag">${t("agency_identity_heading")}</div>
      </div>
      <dl class="aidgrid">${defs}</dl>
      <p class="aidprov">${provLine}</p>
    </div>`;
}

const CROSS_DOMAIN_ORDER = ["money","land","property","rules","meetings","people","franchise"];

/** Cross-domain entity intelligence panel (materialized object links + provenance). */
function entityIntelligenceHTML(resp){
  if(!resp || !resp.ok || !resp.root) return "";
  const returnHash = globalThis.routeReturnContext?.(history.state)?.hash || "#money";
  const view = globalThis.CrolAgencyConnections?.buildAgencyConnectionView(resp, {
    currentHash: returnHash,
    language: window.LANG || "en",
  });
  if(!view || !view.groups.length) return "";

  const domainLabel = (key) => t("entity_intel_domain_"+key) || key;
  const statusLabel = (st) => {
    if(st === "matched") return t("entity_intel_status_matched");
    if(st === "not_yet_ingested") return t("entity_intel_status_not_yet");
    if(st === "not_applicable") return t("entity_intel_status_not_applicable");
    return t("entity_intel_status_empty");
  };

  const domainBlocks = view.groups.filter((group) =>
    group.status === "matched" && (group.objects || []).length > 0
  ).map((group) => {
    const key = group.domain;
    const objs = [...group.objects] // Source: receipt-backed /entity-intelligence response.
      .sort((a,b)=>(a.confidence==="strong"?0:1)-(b.confidence==="strong"?0:1))
      .slice(0,4);
    const items = objs.map((o) => {
      const label = cleanText(o.label || o.subject_ref || "");
      const when = o.when ? `<span class="ei-when">${escUiHtml(fdate(o.when))}</span>` : "";
      const href = o.href && String(o.href).startsWith("#")
        ? pivotA(o.href, label)
        : escUiHtml(label);
      const conf = o.confidence === "tentative"
        ? `<span class="entity-pivot-band">${t("entity_intel_possible_match")}</span>`
        : "";
      const connections = (o.connected_entities || []).map((entity) =>
        globalThis.CrolEntityPivots?.entityChipHTML({
          ref:entity.entity_ref,
          label:entity.label,
          link_confidence:entity.confidence,
          relation:entity.relation,
          evidence:entity.evidence,
        }) || escUiHtml(entity.label || "")
      ).filter(Boolean).join(" <span aria-hidden=\"true\">·</span> ");
      const connectionLine = connections
        ? `<span class="ei-connections"><span aria-hidden="true">↳</span> ${connections}</span>`
        : "";
      return `<li class="ei-obj" data-link-confidence="${escUiHtml(o.confidence||"")}"><span class="ei-obj-main">${href}${when}${conf}</span>${connectionLine}</li>`;
    }).join("");
    const list = items
      ? `<ul class="ei-list">${items}</ul>`
      : `<p class="ei-empty">${statusLabel(group.status)}</p>`;
    const count = "";
    const possible = group.tentative_count
      ? `<span class="ei-possible">${t("entity_intel_summary_possible",{n:fmtNumber(group.tentative_count)})}</span>`
      : "";
    const viewAll = group.view_all_href
      ? `<a class="ei-view-all" href="${escUiHtml(group.view_all_href)}">${t("entity_intel_view_all_scope")}</a>`
      : "";
    return `<section class="ei-domain" data-domain="${escUiHtml(key)}" data-status="${escUiHtml(group.status||"")}">
      <h3 class="ei-domain-h"><span>${t(group.role_key)}</span><span class="ei-domain-name">${domainLabel(key)}</span>${count}
        <span class="ei-status ei-status-${escUiHtml(group.status||"empty")}">${statusLabel(group.status)}</span>${possible}
      </h3>
      ${list}
      ${viewAll}
    </section>`;
  }).join("");

  const rootName = escUiHtml(resp.root.display_name || resp.root.ref || "");
  const constellationId = String(resp.root.canonical_id || resp.root.ref || "")
    .replace(/^agency:id:/, "");
  const constellationHref = constellationId
    ? `/agencies/${encodeURIComponent(constellationId)}/`
    : "";
  const constellationLink = constellationHref
    ? `<a class="act ei-constellation" href="${escUiHtml(constellationHref)}">Cross-category constellation</a>`
    : "";
  return `<div class="eicard" id="entity-intelligence" data-root="${escUiHtml(resp.root.ref||"")}">
      <div class="ei-heading-row"><div class="chain-h">${t("entity_intel_heading")}</div>
        <a class="act ei-apply" href="${escUiHtml(view.apply_scope_href)}">${t("entity_intel_apply_scope")}</a>
        ${constellationLink}</div>
      <p class="ei-lead">${t("entity_intel_lead", {name: rootName})}</p>
      <div class="ei-domains">${domainBlocks}</div>
    </div>`;
}

function numberLike(v){
  const n = Number(String(v || "").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function sameParty(a, b){
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}
function actionRailGuideCoverage(actions){
  const coverage = {
    vendor: null,
    amount: null,
    deadline: null,
  };
  if(!Array.isArray(actions)) return coverage;
  actions.forEach((action) => {
    const guide = action && action.guide;
    if(!guide) return;
    if(guide.system === "award_lifecycle"){
      if(guide.vendor) coverage.vendor = guide.vendor;
      if(guide.amount) coverage.amount = guide.amount;
    }
    if(action.deadline) coverage.deadline = action.deadline;
  });
  return coverage;
}
function glanceFor(r, actionCoverage){
  const row = (k,v) => v ? `<div class="gl"><b>${k}</b><span>${v}</span></div>` : "";
  const amountCovered = actionCoverage && actionCoverage.amount
    ? numberLike(r.contract_amount) !== null
      && numberLike(r.contract_amount) === numberLike(actionCoverage.amount)
    : false;
  const vendorCovered = actionCoverage && actionCoverage.vendor
    ? sameParty(r.vendor_name, actionCoverage.vendor)
    : false;
  const dueCovered = actionCoverage && actionCoverage.deadline && r.due_date
    ? String(actionCoverage.deadline).slice(0, 10) === String(r.due_date).slice(0, 10)
    : false;
  const who = (r.agency_name ? pivotA(agencyHref(r.agency_name), agencyWho(r.agency_name)) : "")
    + (r.vendor_name && !vendorCovered ? ` ${t("awarded_to")} <b>${pivotA(vendorHref(r.vendor_name), cleanText(r.vendor_name))}</b>` : "");
  const amt = money(r.contract_amount);
  const what = [r.type_of_notice_description, r.category_description || tSection(r.section_name)]
    .filter(Boolean).join(" — ")
    + (amt && !amountCovered ? ` · <b>${amt}</b>` : "");
  const when = [
    r.start_date ? t("published_on",{date:fdt(r.start_date)}) : null,
    r.due_date && !dueCovered
      ? (isRollingDeadline(r.due_date) ? deadlineTag(r.due_date) : `${t("responses_due_html",{date:fdt(r.due_date)})} ${deadlineTag(r.due_date)}`)
      : null,
    r.event_date ? `${t("event_on_html",{date:fdt(r.event_date)})}${eventTag(r.event_date)}` : null
  ].filter(Boolean).join(" · ");
  const act = [];
  if(r.email) act.push(`<a href="mailto:${r.email}">${r.email}</a>`);
  const tel = telHref(r.contact_phone); if(tel) act.push(`<a href="${tel}">${cleanText(r.contact_phone)}</a>`);
  if(r.contact_name) act.push(cleanText(r.contact_name));
  const where = cleanText(r.address_to_request) || (goodAddr(r.street_address_1) ? cleanText(r.street_address_1) : "");
  if(where) act.push(where);
  const body = row(t("glance_who"), who) + row(t("glance_what"), what) + row(t("glance_when"), when) + row(t("glance_act"), act.join(" · "));
  return body ? `<div class="glance">${body}</div>` : "";
}
function mailtoFor(r){
  const subj = `Intent to respond: ${cleanText(r.short_title)}${usablePin(r.pin)?` (PIN ${r.pin})`:""}`;
  const body =
    `To ${cleanText(r.contact_name)||"the procurement officer"},\n\n` +
    `This is a letter of intent in response to the following City of New York solicitation, as published in The City Record:\n\n` +
    `  Title:  ${cleanText(r.short_title)}\n` +
    `  PIN:    ${usablePin(r.pin)?r.pin:"(see notice)"}\n` +
    `  Agency: ${r.agency_name||""}\n` +
    (r.due_date?`  Due:    ${isRollingDeadline(r.due_date)?t("rolling_deadline_tag"):fdt(r.due_date)}\n`:"") +
    `\nWe intend to respond and would appreciate confirmation of (1) how to obtain the full solicitation package and (2) whether responses are submitted via PASSPort or directly to your office.\n\n` +
    `[One-line capability statement about your firm.]\n\n` +
    `Thank you,\n[Your name — firm — phone]`;
  return `mailto:${r.email}?subject=${encodeURIComponent(subj)}&body=${encodeURIComponent(body)}`;
}
function icsForRFP(r){
  if(!r.due_date || isRollingDeadline(r.due_date)) return null; // no real date to remind about
  const d = new Date(r.due_date), pad = n=>String(n).padStart(2,"0");
  const fl = dt=>`${dt.getFullYear()}${pad(dt.getMonth()+1)}${pad(dt.getDate())}T${pad(dt.getHours())}${pad(dt.getMinutes())}00`;
  const esc = s=>String(s||"").replace(/([,;\\])/g,"\\$1").replace(/\n/g,"\\n");
  return [
    "BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//CityScroll//EN","CALSCALE:GREGORIAN","METHOD:PUBLISH",
    "BEGIN:VEVENT","UID:"+(r.request_id||fl(d))+"@crol-list.demo","DTSTAMP:"+fl(new Date()),
    "DTSTART:"+fl(d),"DTEND:"+fl(d),
    "SUMMARY:"+esc("RFP due: "+cleanText(r.short_title)),
    "DESCRIPTION:"+esc(`${r.agency_name||""} · PIN ${usablePin(r.pin)?r.pin:"—"} · ${REQ_URL(r.request_id)}`),
    "BEGIN:VALARM","TRIGGER:-P1D","ACTION:DISPLAY","DESCRIPTION:RFP response due tomorrow","END:VALARM",
    "END:VEVENT","END:VCALENDAR"
  ].join("\r\n");
}
function downloadICS(){
  const ics = selectedRFP && icsForRFP(selectedRFP); if(!ics) return;
  const blob = new Blob([ics], {type:"text/calendar;charset=utf-8"});
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  a.download = `rfp-deadline-${(selectedRFP.request_id||"reminder")}.ics`;
  document.body.appendChild(a); a.click(); a.remove();
}

function buildApply(r, showActions=true){
  const dl = daysLeft(r.due_date);
  const rows = [];
  if(r.selection_method_description) rows.push([t("apply_method_lbl"), cleanText(r.selection_method_description)]);
  if(r.contact_name) rows.push([t("apply_contact_lbl"), cleanText(r.contact_name)]);
  if(r.address_to_request) rows.push([t("apply_submit_lbl"), cleanText(r.address_to_request)]);
  const tel = telHref(r.contact_phone);
  if(!r.due_date && !rows.length && !r.email && !tel) return "";
  const dts = rows.map(([k,v])=>`<dt>${k}</dt><dd>${v}</dd>`).join("");
  let due = "";
  if(r.due_date){
    if(isRollingDeadline(r.due_date)){
      due = `<div class="due"><span class="d">${t("rolling_deadline_tag")}</span></div>`;
    }else{
      const tag = dl === null ? "" : (dl < 0 ? `<span class="tag closed">${t("closed_tag")}</span>` :
        dl <= 3 ? `<span class="tag hot">${dl===0?t("due_today_tag"):tn("days_left",dl)}</span>` :
        dl <= 14 ? `<span class="tag soon">${tn("days_left",dl)}</span>` : `<span class="tag open">${tn("days_left",dl)}</span>`);
      due = `<div class="due"><span class="d">${t("deadline_respond_by",{date:fdt(r.due_date)})}</span>${tag}</div>`;
    }
  }
  let acts = '';
  if(showActions){
    acts = '<div class="actions">';
    if(r.email) acts += `<a class="act primary" href="${mailtoFor(r)}">${t("email_a_response")}</a>`;
    if(tel) acts += `<a class="act" href="${tel}">${t("call_btn",{phone:cleanText(r.contact_phone)})}</a>`;
    if(r.due_date && !isRollingDeadline(r.due_date)) acts += `<button class="act" id="icsbtn" type="button">${t("add_deadline_calendar")}</button>`;
    acts += '</div>';
  }
  return `<div class="apply"><h3>${t("how_to_respond_heading")}</h3><div class="body">
    ${due}${acts}${dts?`<dl>${dts}</dl>`:""}
    <div class="pnote">${r.email ? t("apply_pnote_html") : t("apply_pnote_no_email_html")}</div>
  </div></div>`;
}

/* ===================== PAST WINNERS STRIP (w12-05) =====================
   Rolls chainHTML()'s own award-type stages into an at-a-glance list -- "awarded to X in
   2024 ($2.1M), Y in 2023 ($1.9M)" -- instead of making a reader walk the stage-by-stage
   paper-trail boxes to compare cycles. Same chain data loadChain() already fetched, no new
   fetch, no worker dependency. Renders nothing for a single award (there is nothing to roll
   up against yet) -- chainHTML()'s own boxes already show that one cycle in full. */
function pastWinnersHTML(chain){
  const stages = chain.filter(c => c.type_of_notice_description === "Award" || c.type_of_notice_description === "Intent to Award");
  if(stages.length < 2) return "";
  const rows = [...stages]
    .sort((a,b) => (b.start_date||"").localeCompare(a.start_date||"")) // most recent cycle first
    .map(c => {
      const year = String(c.start_date||"").slice(0,4);
      const amt = money(c.contract_amount);
      // A stage on record with no vendor name is shown honestly, not skipped -- omitting the
      // cycle would understate how many rounds this contract has actually been through.
      const vendor = c.vendor_name
        ? pivotA(vendorHref(c.vendor_name), cleanText(c.vendor_name))
        : t("past_winners_vendor_unlisted");
      return `<div class="tl">${year?`<span class="tldate">${year}</span>`:""}<span class="tlreason">${vendor}</span>${amt?`<span class="tlsal">${amt}</span>`:""}</div>`;
    }).join("");
  return `<div class="chain-h">${t("past_winners_heading")}</div><div class="timeline">${rows}</div>`;
}

// A blanket code bundles several simultaneous awards under one PIN (common for emergency
// declarations) — those awards aren't sequential rebid cycles, so both the paper-trail note
// and the cadence estimate below need to recognize and exclude the same shape.
function isBlanketChain(chain){
  return chain.length > 5 && chain.every(c=>c.type_of_notice_description==="Award");
}

/* ===================== CADENCE ESTIMATE (w12-04) =====================
   "Is this a yearly bid?" answered in words, from data already on hand: the same paper-trail
   chain chainHTML() renders (loadChain()'s same-PIN + renewal-suffix-widened award history —
   no new fetch, no worker dependency). Only ever states a cadence when the chain itself
   supports it; renders nothing when history is insufficient (never guess). */
// CADENCE_MIN_AWARDS: 2 confirmed gaps between awards — matches the reported example's "3 prior
// awards". CADENCE_MIN_GAP_DAYS: a gap under a month is a correction/amendment to the same
// round, not a rebid cycle. CADENCE_MAX_GAP_RATIO: gaps too inconsistent to average honestly
// (e.g. one rushed renewal skews the pattern). CADENCE_YEAR_THRESHOLD_MONTHS: at 2 years
// (24 months) or wider a bid's own cadence reads more naturally in years than in months.
const CADENCE_MIN_AWARDS = 3;
const CADENCE_MIN_GAP_DAYS = 30;
const CADENCE_MAX_GAP_RATIO = 4;
const CADENCE_YEAR_THRESHOLD_MONTHS = 24;

function cadenceEstimate(chain){
  if(!chain || isBlanketChain(chain)) return null; // simultaneous multi-vendor pool, not sequential rebid cycles
  const awards = chain
    .filter(c => c.type_of_notice_description === "Award" && c.start_date)
    .sort((a,b) => a.start_date.localeCompare(b.start_date));
  if(awards.length < CADENCE_MIN_AWARDS) return null;
  const gapsDays = [];
  for(let i=1; i<awards.length; i++){
    const d = daysBetween(awards[i-1].start_date, awards[i].start_date);
    if(d === null) return null;
    gapsDays.push(d);
  }
  if(gapsDays.some(g => g < CADENCE_MIN_GAP_DAYS)) return null;
  if(Math.max(...gapsDays) / Math.min(...gapsDays) > CADENCE_MAX_GAP_RATIO) return null;
  const avgDays = gapsDays.reduce((a,b) => a+b, 0) / gapsDays.length;
  const avgMonths = Math.round(avgDays / 30.44);
  if(avgMonths < 1) return null;
  // avgYears is computed straight from avgDays (not from the already-rounded avgMonths) so a
  // multi-year cadence doesn't compound two roundings into a misleading year count.
  const avgYears = Math.round(avgDays / 365.25);
  // UTC arithmetic throughout — start_date is a date-only ISO string (UTC midnight per spec);
  // local-timezone setDate()/getDate() here would shift the projected day depending on the
  // reader's own timezone offset, making the estimate non-deterministic.
  const nextDate = new Date(awards[awards.length-1].start_date);
  nextDate.setUTCDate(nextDate.getUTCDate() + Math.round(avgDays));
  if(isNaN(nextDate.getTime())) return null;
  // Provenance for the prediction contract (method: cadence). cadenceHTML ignores these
  // fields so rendered copy stays byte-stable; abort-rather-than-guess above is unchanged.
  return {
    count: awards.length,
    avgMonths,
    avgYears,
    nextDate,
    model_name: "award_cadence",
    model_version: "1.0.0",
    basis: {
      method: "cadence",
      n: awards.length,
      // Machine evidence ids only (request_id); not user-facing copy.
      evidence_event_ids: awards.map(a => a.request_id).filter(Boolean),
    },
  };
}

function cadenceMonthYear(d){
  const _lm = (window.LANG_META||{})[window.LANG||"en"];
  const _loc = _lm ? _lm.intlDate : "en-US";
  return d.toLocaleDateString(_loc, {month:"short", year:"numeric", timeZone:"UTC"});
}

// "about 9 months apart" reads naturally short-term; "about 26 months apart" doesn't — past
// CADENCE_YEAR_THRESHOLD_MONTHS this switches to "about 2 years apart" instead.
function cadenceApart(est){
  return est.avgMonths >= CADENCE_YEAR_THRESHOLD_MONTHS
    ? tn("cadence_years_apart", est.avgYears, {years: est.avgYears})
    : tn("cadence_months_apart", est.avgMonths, {months: est.avgMonths});
}

function cadenceHTML(est){
  if(!est) return "";
  const awards = tn("cadence_award_count", est.count);
  const apart = cadenceApart(est);
  const next = t("cadence_next_expected", {date: cadenceMonthYear(est.nextDate)});
  return `<div class="note">${awards}, ${apart}. ${next} <span class="tag renewal">${t("cadence_estimate_tag")}</span></div>`;
}

/* ===================== PAPER TRAIL PHASE UI (PIN siblings) =====================
   Phase-group + aggregate + one City Record link by default. Pure model:
   site/paper_trail_phase.mjs — same shape as land_phase_spine / procurement_phase_spine
   so those surfaces can share a generic phase-timeline chrome later. */
let paperTrailPhaseToolsPromise = null;
function ensurePaperTrailPhaseTools(){
  if(!paperTrailPhaseToolsPromise){
    paperTrailPhaseToolsPromise = import("../paper_trail_phase.mjs").catch(() => null);
  }
  return paperTrailPhaseToolsPromise;
}

function paperTrailPhaseLabel(phase){
  if(!phase) return "—";
  if(phase.label_key) return t(phase.label_key);
  if(typeof phase === "string"){
    const meta = {
      solicitation: "paper_trail_phase_solicitation",
      selection: "paper_trail_phase_selection",
      award: "paper_trail_phase_award",
    };
    return meta[phase] ? t(meta[phase]) : phase;
  }
  return phase.short || "—";
}

/** One notice row inside an expanded aggregate — City Record links only here (disclosure). */
function paperTrailMemberRowHTML(c, opened){
  if(!c) return "";
  const amt = money(c.contract_amount);
  const renewed = c.pin && opened && opened.pin && c.pin !== opened.pin;
  const isOpened = opened && c.request_id && opened.request_id && c.request_id === opened.request_id;
  return `<li class="paper-trail-member${isOpened?" is-opened":""}">
    <span class="paper-trail-member-when">${fdate(c.start_date)}</span>
    <span class="paper-trail-member-type" lang="en" dir="ltr">${escUiHtml(c.type_of_notice_description||t("notice_fallback"))}${renewed?` <span class="tag renewal">${t("renewal_badge")}</span>`:""}</span>
    ${c.vendor_name?`<span class="paper-trail-member-vend">→ ${pivotA(vendorHref(c.vendor_name), cleanText(c.vendor_name))}</span>`:""}
    ${amt?`<span class="paper-trail-member-amt">${amt}</span>`:""}
    ${c.request_id?`<a class="view paper-trail-member-cr" href="${REQ_URL(c.request_id)}" ${EXT_ATTRS}>${t("view_in_city_record")}${extSR()}</a>`:""}
    ${c.request_id?` · <a class="pivot" href="#notice/${encodeURIComponent(c.request_id)}">${t("paper_trail_open_on_site")}</a>`:""}
  </li>`;
}

function paperTrailAggregateHTML(agg, phaseId, idx, opened){
  if(!agg) return "";
  if(agg.count === 1){
    const c = agg.members[0] || {};
    const sourceTitle=cleanText(c.short_title);
    const displayTitle=sourceTitle&&!/^(?:null|none|n\/?a|unknown|untitled|unnamed|\((?:untitled|unnamed)(?:\s+[^)]*)?\))$/i.test(sourceTitle)
      ?sourceTitle:`Notice ${c.request_id||""}`.trim();
    const amt = money(c.contract_amount);
    const renewed = c.pin && opened && opened.pin && c.pin !== opened.pin;
    return `<div class="lc-phase-agg paper-trail-row">
      <div class="lc-phase-agg-title" lang="en" dir="ltr">${escUiHtml(agg.type)}${renewed?` <span class="tag renewal">${t("renewal_badge")}</span>`:""}</div>
      <div class="lc-phase-agg-meta">${agg.first?fdate(agg.first):"—"}${c.vendor_name?` · → ${pivotA(vendorHref(c.vendor_name), cleanText(c.vendor_name))}`:""}${amt?` · ${amt}`:""}</div>
      <div class="lc-phase-agg-meta" lang="en" dir="ltr">${escUiHtml(displayTitle)}</div>
      ${c.request_id?`<button type="button" class="lc-phase-toggle" data-pt-dates="pt-agg-${escUiHtml(phaseId)}-${idx}" aria-expanded="false">${t("paper_trail_show_notices",{n:"1"})}</button>
      <ul class="lc-phase-dates" id="pt-agg-${escUiHtml(phaseId)}-${idx}">${paperTrailMemberRowHTML(c, opened)}</ul>`:""}
    </div>`;
  }
  const listId = `pt-agg-${phaseId}-${idx}`;
  const vendorBit = agg.vendor_count
    ? t("paper_trail_vendors_count", { n: String(agg.vendor_count) })
    : "";
  const range = agg.first && agg.last && agg.first !== agg.last
    ? t("paper_trail_aggregate_range", { first: fdate(agg.first), last: fdate(agg.last) })
    : (agg.first ? fdate(agg.first) : "—");
  const poolTitle = t("paper_trail_pool_title", {
    type: escUiHtml(agg.type),
    n: String(agg.count),
  });
  return `<div class="lc-phase-agg paper-trail-pool">
    <div class="lc-phase-agg-title" lang="en" dir="ltr">${poolTitle}<span class="lc-phase-count">×${agg.count}</span></div>
    <div class="lc-phase-agg-meta">${range}${vendorBit?` · ${vendorBit}`:""}${agg.amount_sum!=null?` · ${money(agg.amount_sum)}`:""}</div>
    <div class="lc-phase-agg-meta" lang="en" dir="ltr">${escUiHtml(agg.title)}</div>
    <button type="button" class="lc-phase-toggle" data-pt-dates="${escUiHtml(listId)}" aria-expanded="false">${t("paper_trail_show_notices",{n:String(agg.count)})}</button>
    <ul class="lc-phase-dates" id="${escUiHtml(listId)}">
      ${(agg.members||[]).map(m=>paperTrailMemberRowHTML(m, opened)).join("")}
    </ul>
  </div>`;
}

function paperTrailPhasePanelHTML(phase, opened){
  if(!phase) return "";
  if(phase.state === "future" && !phase.event_count) return "";
  if(phase.state === "passed" && !phase.event_count) return "";
  const open = phase.state === "current" ? " open" : "";
  const stateWord = phase.state === "current"
    ? t("paper_trail_phase_current")
    : phase.state === "passed"
      ? t("paper_trail_phase_done")
      : t("paper_trail_phase_future");
  let summary = "";
  if(phase.event_count){
    const parts = [
      tn("paper_trail_notices_count", phase.event_count, { n: phase.event_count }),
      phase.first && phase.last && phase.first !== phase.last
        ? t("paper_trail_aggregate_range", { first: fdate(phase.first), last: fdate(phase.last) })
        : (phase.first ? fdate(phase.first) : ""),
    ].filter(Boolean);
    summary = parts.join(" · ");
  } else {
    summary = t("paper_trail_phase_empty");
  }
  const body = (phase.aggregates||[]).map((a, idx)=>paperTrailAggregateHTML(a, phase.id, idx, opened)).join("")
    || `<div class="lc-phase-summary">${t("paper_trail_phase_empty")}</div>`;
  return `<details class="lc-phase${phase.state==="current"?" current-phase":""}"${open} id="pt-phase-${escUiHtml(phase.id)}" data-pt-phase-panel="${escUiHtml(phase.id)}">
    <summary>
      <span class="lc-phase-name">${escUiHtml(paperTrailPhaseLabel(phase))}</span>
      <span class="lc-phase-state">${escUiHtml(stateWord)}</span>
      <span class="lc-phase-summary">${escUiHtml(summary)}</span>
    </summary>
    <div class="lc-phase-body">${body}</div>
  </details>`;
}

function paperTrailPhaseStepperHTML(view){
  if(!view || !view.phases || !view.phases.length) return "";
  const items = view.phases.map((p, i) => {
    const cls = p.state === "current" ? "current" : p.state === "passed" ? "passed" : "future";
    const aria = p.state === "current" ? ` aria-current="step"` : "";
    const arrow = i < view.phases.length - 1
      ? `<span class="lc-step-arrow" aria-hidden="true">→</span>`
      : "";
    return `<li><button type="button" class="lc-step ${cls}" data-pt-phase="${escUiHtml(p.id)}"${aria} title="${escUiHtml(paperTrailPhaseLabel(p))}">${escUiHtml(p.short || paperTrailPhaseLabel(p))}</button>${arrow}</li>`;
  }).join("");
  return `<ol class="lc-stepper lc-phase-stepper" aria-label="${escUiHtml(t("paper_trail_heading"))}">${items}</ol>`;
}

function paperTrailPhaseHTML(view, r){
  if(!view) return "";
  const tlink = usablePin(r.pin)
    ? ` · <a class="pivot" href="#matter/${encodeURIComponent(r.pin)}">${t("full_timeline_link")}</a>`
    : "";
  const crId = view.default_city_record_request_id;
  const portal = crId
    ? `<a class="view lc-phase-portal" href="${REQ_URL(crId)}" ${EXT_ATTRS}>${t("paper_trail_open_notice")}${extSR()}</a>`
    : "";
  const cur = view.current || {};
  const phaseName = paperTrailPhaseLabel({ label_key: cur.label_key });
  const actionKey = cur.action_key || "paper_trail_action_track_award";
  const actionHTML = t(actionKey);
  const lead = `<div class="lc-phase-lead">
    <div class="lc-phase-now-label">${t("paper_trail_now_label")}</div>
    <p class="lc-phase-now-phase">${escUiHtml(phaseName)}</p>
    <p class="lc-phase-now-detail" lang="en" dir="ltr">${escUiHtml(cur.notice_type || "—")}${cur.milestone_label?` · ${escUiHtml(cur.milestone_label)}`:""}${cur.since?` · ${t("paper_trail_since",{date:fdate(cur.since)})}`:""}${cur.vendor_name?`<br>→ ${globalThis.v?.(cur.vendor_name)||escUiHtml(cur.vendor_name)}`:""}</p>
    <p class="lc-phase-action">${actionHTML}</p>
    ${view.next?`<p class="lc-phase-next">${t("paper_trail_next_html",{phase:escUiHtml(paperTrailPhaseLabel(view.next))})}</p>`:""}
  </div>`;
  const stepper = paperTrailPhaseStepperHTML(view);
  const currentPanel = (view.phases||[]).filter(p => p.state === "current")
    .map(p => paperTrailPhasePanelHTML(p, r)).join("");
  const historyPanels = (view.phases||[]).filter(p => p.state === "passed")
    .map(p => paperTrailPhasePanelHTML(p, r)).filter(Boolean).join("");
  const futurePanels = (view.phases||[]).filter(p => p.state === "future" && p.event_count)
    .map(p => paperTrailPhasePanelHTML(p, r)).join("");
  const historyWrap = historyPanels
    ? `<details class="lc-phase-history"><summary>${t("paper_trail_show_history")}</summary>${historyPanels}</details>`
    : "";
  const chrono = (view.chronological||[]).map(c => paperTrailMemberRowHTML(c, r)).join("");
  const allNotices = `<details class="lc-how inline-disclose">
    <summary>${t("paper_trail_show_all")}</summary>
    <ul class="lc-phase-dates show paper-trail-chrono">${chrono}</ul>
  </details>`;
  let notes = "";
  if(view.blanket){
    notes += `<div class="note warn">${t("blanket_note",{pin:r.pin||view.pin||"—", n:view.notice_count})}</div>`;
  }
  return `<div class="chain-h">${t("paper_trail_heading")}${tlink}</div>
    ${portal}
    ${lead}
    ${stepper}
    ${currentPanel}
    ${futurePanels}
    ${historyWrap}
    ${allNotices}
    ${notes}`;
}

function bindPaperTrailPhaseUI(root){
  if(!root || root.dataset.paperTrailBound === "1") return;
  root.dataset.paperTrailBound = "1";
  root.addEventListener("click", (ev) => {
    const step = ev.target.closest?.("[data-pt-phase]");
    if(step && root.contains(step)){
      const id = step.getAttribute("data-pt-phase");
      const panel = root.querySelector(`[data-pt-phase-panel="${CSS.escape(id)}"]`);
      if(panel){
        panel.open = true;
        try{ panel.scrollIntoView({ behavior: "smooth", block: "nearest" }); }catch(_e){}
      }
      return;
    }
    const btn = ev.target.closest?.("[data-pt-dates]");
    if(btn && root.contains(btn)){
      const listId = btn.getAttribute("data-pt-dates");
      const list = listId ? root.querySelector("#" + CSS.escape(listId)) : null;
      if(!list) return;
      const show = !list.classList.contains("show");
      list.classList.toggle("show", show);
      btn.setAttribute("aria-expanded", show ? "true" : "false");
      const n = list.children.length;
      btn.textContent = show
        ? t("paper_trail_hide_notices")
        : t("paper_trail_show_notices", { n: String(n) });
    }
  });
}

/**
 * Flat paper trail — used for single-notice chains and when the phase module fails.
 * Multi-notice fallback still dedupes City Record: one portal link + members without
 * per-row spam (substance stays readable; renewal badges preserved).
 */
function chainHTMLFlat(r, chain){
  const blanket = isBlanketChain(chain);
  const tlink = usablePin(r.pin) ? ` · <a class="pivot" href="#matter/${encodeURIComponent(r.pin)}">${t("full_timeline_link")}</a>` : "";
  const multi = chain.length > 1;
  const primaryId = r.request_id || (chain[0] && chain[0].request_id) || null;
  let portal = "";
  if(multi && primaryId){
    portal = `<a class="view lc-phase-portal" href="${REQ_URL(primaryId)}" ${EXT_ATTRS}>${t("paper_trail_open_notice")}${extSR()}</a>`;
  }
  let html = `<div class="chain-h">${t("paper_trail_heading")}${tlink}</div>${portal}<div class="chain">`;
  chain.forEach((c,idx)=>{
    const amt = money(c.contract_amount);
    const sourceTitle=cleanText(c.short_title);
    const displayTitle=sourceTitle&&!/^(?:null|none|n\/?a|unknown|untitled|unnamed|\((?:untitled|unnamed)(?:\s+[^)]*)?\))$/i.test(sourceTitle)
      ?sourceTitle:`Notice ${c.request_id||""}`.trim();
    // A chain entry pulled in by the renewal-suffix prefix widening (pinBase()) carries a
    // DIFFERENT literal PIN than the notice we opened -- badge it so it reads as "linked via
    // renewal", distinct from a same-PIN duplicate stage (no badge, same literal PIN as r.pin).
    const renewed = c.pin && r.pin && c.pin !== r.pin;
    const showCr = !multi || (primaryId && c.request_id === primaryId);
    html += `<div class="stage"><div class="box ${boxClass(c.type_of_notice_description)}">
        <div class="stage-name">${c.type_of_notice_description||t("notice_fallback")}${renewed?` <span class="tag renewal">${t("renewal_badge")}</span>`:""}</div>
        <div class="when">${fdate(c.start_date)}</div>
        <div class="bt">${escUiHtml(displayTitle)}</div>
        ${amt? `<div class="amt">${amt}</div>`:""}
        ${c.vendor_name? `<div class="vend">→ ${pivotA(vendorHref(c.vendor_name), cleanText(c.vendor_name))}</div>`:""}
        ${showCr && c.request_id?`<a class="view" href="${REQ_URL(c.request_id)}" ${EXT_ATTRS}>${t("view_in_city_record")}${extSR()}</a>`:""}
        ${!showCr && c.request_id?`<a class="pivot" href="#notice/${encodeURIComponent(c.request_id)}">${t("paper_trail_open_on_site")}</a>`:""}
      </div></div>`;
    if(idx < chain.length-1) html += '<div class="connector">→</div>';
  });
  html += '</div>';

  if(chain.length === 1 && !usablePin(r.pin)){
    html += `<div class="note warn">${t("pin_unusable_note",{pin:r.pin||"—"})}</div>`;
  } else if(chain.length === 1){
    html += `<div class="note">${t("only_notice_note",{pin:r.pin})}${r.type_of_notice_description==="Solicitation"?t("award_pending_note"):""}</div>`;
  } else if(blanket){
    html += `<div class="note warn">${t("blanket_note",{pin:r.pin, n:chain.length})}</div>`;
  }
  return html;
}

function chainHTML(r, chain, phaseTools){
  let body = "";
  if(chain.length > 1 && phaseTools && typeof phaseTools.buildPaperTrailPhaseView === "function"){
    const view = phaseTools.buildPaperTrailPhaseView(chain, r);
    if(view && view.needs_phase_ui){
      body = paperTrailPhaseHTML(view, r);
    }
  }
  if(!body) body = chainHTMLFlat(r, chain);
  body += pastWinnersHTML(chain);
  body += cadenceHTML(cadenceEstimate(chain));
  return body;
}

/** Async paint helper: loads phase tools then writes chainHTML + binds disclosure UI. */
async function paintPaperTrail(el, r, chain){
  if(!el) return;
  const tools = await ensurePaperTrailPhaseTools();
  el.innerHTML = chainHTML(r, chain, tools);
  bindPaperTrailPhaseUI(el);
}

// SODA's count(1) aggregate comes back as the STRING "0" (not the number 0) when an agency has
// no matching awards — a bare `stats.n` truthiness check treats that as present, rendering a
// dash-and-zero scoreboard. `+stats.n > 0` is the numeric guard both agency stat blocks share.
function hasAgencyAwards(stats){ return !!(stats && +stats.n > 0); }
function noticeAgencyBar(stats, agencyName, barClass){
  if(!hasAgencyAwards(stats)) return agencyAwardsNote(agencyName);
  return `<div class="${barClass || "agencybar"}">
    <div><div class="big">${money(stats.total)||"—"}</div><div class="lbl">${pivotA(agencyHref(agencyName), agencyName)}<br>${t("total_awarded_lbl")}</div></div>
    <div><div class="big">${fmtNumber(+stats.n)}</div><div class="lbl">${t("awards_published_lbl")}</div></div>
  </div>`;
}
function solicitationContextHeadingHTML(r){
  if(!solicitationResponseContextReady(r)) return "";
  const section = tSection(r.section_name || "Procurement");
  const context = [
    r.type_of_notice_description,
    section,
    r.agency_name ? pivotA(agencyHref(r.agency_name), r.agency_name) : "",
  ].filter(Boolean).join(" · ");
  return `<header class="notice-context-heading" data-solicitation-context-ready="true">
    <div class="ftype" style="margin-bottom:6px">${context}</div>
    <h2 class="rolename" lang="en" dir="ltr">${escUiHtml(noticeDisplayTitle(r))}</h2>
  </header>`;
}
function renderDetail(r, chain, stats, loadContext = true){
  const pending = chain === null; // first paint from the in-memory record; chain/stats hydrate in
  const responseContextReady = solicitationResponseContextReady(r);
  const actionRailContextReady = r.type_of_notice_description !== "Solicitation" || responseContextReady;
  const initialActionsForGlance = window.CrolActions && actionRailContextReady
    ? CrolActions.compileActionRail(noticeActionMatter(r), { today: todayISO() })
    : [];
  let html = `<div class="actions" style="margin:0 0 12px">
    <button class="act" type="button" id="dcopy">${t("copy_link_notice")}</button>
    ${qrButtonHTML("dqr","act")}
    <button class="act export-control" type="button" id="dxlsx"${pending?' disabled aria-busy="true"':""}>${t("export_xlsx")}</button>
    <button class="act export-control" type="button" id="dprint">${t("print_save_pdf")}</button>
    ${pinBtn("notice", r.request_id, cleanText(r.short_title)||r.request_id, [r.type_of_notice_description, r.agency_name, fdate(r.start_date)].filter(Boolean).join(" · "))}
  </div>`;
  html += solicitationContextHeadingHTML(r);
  html += `<div id="dcontext" data-export-class="notice_context"></div><div id="dactions" data-export-class="actions"></div>`;
  // Lead with the response path for solicitations (deadline / contact) before lifecycle
  // context; primary CTAs stay on the action rail. Awards keep the glance strip first.
  if(responseContextReady) html += `<div data-export-class="actions">${buildApply(r,false)}</div>`;
  else html += `<div data-export-class="notice_context">${glanceFor(r, actionRailGuideCoverage(initialActionsForGlance))}</div>`;
  // M/WBE solicitation chips + prime sub-outreach (award_prime_goal) mount points.
  html += `<div id="dmwbe" data-export-class="mwbe_context"></div><div id="drules" data-export-class="rule_lifecycle"></div><div id="dlifecycle" data-export-class="procurement_lifecycle"></div><div id="dsuboutreach" data-export-class="sub_outreach"></div><div id="ddollars" data-export-class="dollars"></div><div id="dsubsidy" data-export-class="subsidy"></div><div id="dmeet" data-export-class="meeting_outcomes"></div>`;

  html += pending
    ? `<div class="chain-h">${t("paper_trail_heading")}</div>${listSkeleton(2)}`
    : `<div id="dchain" data-export-class="paper_trail">${chainHTMLFlat(r, chain)}${pastWinnersHTML(chain)}${cadenceHTML(cadenceEstimate(chain))}</div>`;

  // Original English notice text is the official record — always rendered first.
  // excerptHtml: decode entities, truncate on plain text, escape once (same discipline as cards).
  const scopeHtml = excerptHtml(r.additional_description_1, 900);
  if(scopeHtml) html += `<div class="scope" data-export-class="official_notice_text" lang="en" dir="ltr"><span class="lbl">${t("what_they_want")}</span>${scopeHtml}</div>`;
  // Optional unofficial translation sits AFTER the original; never replaces it.
  html += `<div class="xlate" id="dxlate" data-export-class="unofficial_translation"></div>`;
  html += `<div id="dexternal" data-export-class="external_award"></div><div id="dprior" data-export-class="paper_trail"></div><div id="dforecast" data-export-class="agency_forecast">${pending ? `<div class="chain-h">${t("agency_forecast_heading")}</div><div class="note"><span class="loading"></span></div>` : ""}</div>`;
  // Agency-wide totals are context for this notice, not the headline — rendered last and
  // visually subordinated (smaller figures) so notice-specific facts read first.
  if(!pending) html += noticeAgencyBar(stats, r.agency_name, "agencybar sub");
  $("#detail").innerHTML = html;
  const ib = $("#icsbtn"); if(ib) ib.addEventListener("click", downloadICS);
  const detailURL=noticeLink(r.request_id);
  const dc = $("#dcopy"); if(dc) dc.addEventListener("click", ()=>copyText(detailURL, dc));
  bindQRShare($("#dqr"), detailURL);
  const dx = $("#dxlsx"); if(dx && !pending) dx.addEventListener("click", ()=>exportNoticeXlsx(r, chain));
  const dp = $("#dprint"); if(dp) dp.addEventListener("click", ()=>printCurrentView("notice", detailURL));
  if(pending) return; // context/dollars fetch once, on the hydrated render
  if (loadContext) {
    const contextReady = globalThis.ensureNoticeContext?.() || Promise.resolve();
    contextReady.then(() => {
      if (typeof fillContext === "function") fillContext(r, $("#dcontext"));
      if (typeof externalAwardForNotice === "function") externalAwardForNotice(r, $("#dexternal"));
    }).catch(() => {});
  }
  if(actionRailContextReady) mountNoticeActionRail($("#dactions"),r);
  if(typeof loadSolicitationMwbe === "function") loadSolicitationMwbe(r, $("#dmwbe"));
  if(typeof globalThis.loadRuleLifecycle === "function") loadRuleLifecycle(r, $("#drules"));
  loadLifecycle(r, $("#dlifecycle"), $("#ddollars"), actionRailContextReady ? $("#dactions") : null, $("#dsuboutreach"));
  loadSubsidyLifecycle(r, $("#dsubsidy"));
  loadMeetingOutcomes(r, $("#dmeet"));
  priorCycleAwards(r, $("#dprior"));
  agencyForecastTeaser(r, $("#dforecast"));
  mountUnofficialTranslation($("#dxlate"), r);
  // Phase-group / aggregate paper trail once the module is ready (flat paint above first).
  if(chain && chain.length > 1) paintPaperTrail($("#dchain"), r, chain).catch(()=>{});
}

// parseNL() itself lives in nl_parse.js (lazy plain global — same convention as
// i18n.js), so it can be require()'d from a Node test with no DOM involved.
globalThis.AGENCY_ABBR = AGENCY_ABBR;
globalThis.CADENCE_MAX_GAP_RATIO = CADENCE_MAX_GAP_RATIO;
globalThis.CADENCE_MIN_AWARDS = CADENCE_MIN_AWARDS;
globalThis.CADENCE_MIN_GAP_DAYS = CADENCE_MIN_GAP_DAYS;
globalThis.CADENCE_YEAR_THRESHOLD_MONTHS = CADENCE_YEAR_THRESHOLD_MONTHS;
globalThis.CHECKBOOK_NYCHA_AGENCY_ID = CHECKBOOK_NYCHA_AGENCY_ID;
globalThis.CROSS_DOMAIN_ORDER = CROSS_DOMAIN_ORDER;
globalThis.NEAR_MATCH_AMOUNT_RATIO_MAX = NEAR_MATCH_AMOUNT_RATIO_MAX;
globalThis.NEAR_MATCH_MAX_MATCHES = NEAR_MATCH_MAX_MATCHES;
globalThis.NEAR_MATCH_MIN_SCORE = NEAR_MATCH_MIN_SCORE;
globalThis.NEAR_MATCH_PIN_PREFIX_MIN_LEN = NEAR_MATCH_PIN_PREFIX_MIN_LEN;
globalThis.NEAR_MATCH_QUERY_WORDS = NEAR_MATCH_QUERY_WORDS;
globalThis.PRIOR_CYCLE_MAX_MATCHES = PRIOR_CYCLE_MAX_MATCHES;
globalThis.PRIOR_CYCLE_MIN_GAP_DAYS = PRIOR_CYCLE_MIN_GAP_DAYS;
globalThis.PRIOR_CYCLE_STOPWORDS = PRIOR_CYCLE_STOPWORDS;
globalThis.aboAwardsTimelineHTML = aboAwardsTimelineHTML;
globalThis.aboSourceLink = aboSourceLink;
globalThis.agencyAwardsNote = agencyAwardsNote;
globalThis.agencyBudgetDisplay = agencyBudgetDisplay;
globalThis.agencyIdentityHTML = agencyIdentityHTML;
globalThis.agencyWho = agencyWho;
globalThis.awardWatchOfferHTML = awardWatchOfferHTML;
globalThis.bindPaperTrailPhaseUI = bindPaperTrailPhaseUI;
globalThis.boxClass = boxClass;
globalThis.buildApply = buildApply;
globalThis.cadenceApart = cadenceApart;
globalThis.cadenceEstimate = cadenceEstimate;
globalThis.cadenceHTML = cadenceHTML;
globalThis.cadenceMonthYear = cadenceMonthYear;
globalThis.chainHTML = chainHTML;
globalThis.chainHTMLFlat = chainHTMLFlat;
globalThis.checkbookNychaContractsLink = checkbookNychaContractsLink;
globalThis.checkbookNychaLink = checkbookNychaLink;
globalThis.daysBetween = daysBetween;
globalThis.downloadICS = downloadICS;
globalThis.ensurePaperTrailPhaseTools = ensurePaperTrailPhaseTools;
globalThis.entityIntelligenceHTML = entityIntelligenceHTML;
globalThis.externalAwardHTML = externalAwardHTML;
globalThis.actionRailGuideCoverage = actionRailGuideCoverage;
globalThis.glanceFor = glanceFor;
globalThis.hasAgencyAwards = hasAgencyAwards;
globalThis.icsForRFP = icsForRFP;
globalThis.isBlanketChain = isBlanketChain;
globalThis.loadAgencyStats = loadAgencyStats;
globalThis.loadExternalAward = loadExternalAward;
globalThis.mailtoFor = mailtoFor;
globalThis.nearMatchHTML = nearMatchHTML;
globalThis.nearMatchReasonHTML = nearMatchReasonHTML;
globalThis.nearMatchReasons = nearMatchReasons;
globalThis.nearMatchRevealHTML = nearMatchRevealHTML;
globalThis.noticeAgencyBar = noticeAgencyBar;
globalThis.nychaAwardBoxHTML = nychaAwardBoxHTML;
globalThis.paintPaperTrail = paintPaperTrail;
globalThis.paperTrailAggregateHTML = paperTrailAggregateHTML;
globalThis.paperTrailMemberRowHTML = paperTrailMemberRowHTML;
globalThis.paperTrailPhaseHTML = paperTrailPhaseHTML;
globalThis.paperTrailPhaseLabel = paperTrailPhaseLabel;
globalThis.paperTrailPhasePanelHTML = paperTrailPhasePanelHTML;
globalThis.paperTrailPhaseStepperHTML = paperTrailPhaseStepperHTML;
globalThis.pastWinnersHTML = pastWinnersHTML;
globalThis.pinPrefixShared = pinPrefixShared;
globalThis.priorCycleAwards = priorCycleAwards;
globalThis.priorCycleHTML = priorCycleHTML;
globalThis.priorCycleNoneHTML = priorCycleNoneHTML;
globalThis.priorCycleTitleWords = priorCycleTitleWords;
globalThis.rankNearMatchCandidates = rankNearMatchCandidates;
globalThis.rankPriorCycleCandidates = rankPriorCycleCandidates;
globalThis.renderDetail = renderDetail;
globalThis.sourceUpdatedHTML = sourceUpdatedHTML;
globalThis.telHref = telHref;
globalThis.wireNearMatchReveal = wireNearMatchReveal;
Object.defineProperty(globalThis, "paperTrailPhaseToolsPromise", { configurable: true, get: () => paperTrailPhaseToolsPromise, set: value => { paperTrailPhaseToolsPromise = value; } });
