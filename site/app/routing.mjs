import { noticeDocumentUrl } from "../notice_permalink.mjs";
import { landProjectDisplayTitle, noticeDisplayTitle } from "../display_title.mjs";
import { resolveAgencyIdentity } from "../agency_identity.mjs";
import { agencyNameFromEntityFacet } from "../agency_scope_route.mjs";
import { entityRouteRef } from "../entity_pivot.mjs";
import { officialSourceLink } from "../affordance_grammar.mjs";

/* ===================== PERMALINKS & URL STATE =====================
   Document routes are canonical for Now, Browse facets, notices, and entity profiles. The same finite
   hash grammar remains as an internal adapter for controls and retained item routes. */
const DOCUMENT_FACET_HASHES=Object.freeze({
  contracts:"money",staffing:"people",zoning:"land",property:"property",rules:"rules",meetings:"meetings",
});
function documentRouteRaw(){
  const path=location.pathname.replace(/\/+$/,"")||"/";
  const notice=path.match(/^\/notices\/([A-Za-z0-9_-]{1,80})$/);
  if(notice){
    const params=new URLSearchParams(location.search);
    const bounded=new URLSearchParams();
    for(const key of ["w","focus"]) if(params.has(key)) bounded.set(key,params.get(key));
    return `notice/${notice[1]}${bounded.size?`?${bounded}`:""}`;
  }
  const entity=path.match(/^\/(agencies|vendors|officials)\/([^/]+)$/);
  if(entity){
    const kind=({agencies:"agency",vendors:"vendor",officials:"official"})[entity[1]];
    const params=new URLSearchParams(location.search); params.delete("lang");
    const allowed=kind==="official"?["event","notice"]:["tab"];
    const bounded=new URLSearchParams();
    for(const key of allowed) if(params.has(key)) bounded.set(key,params.get(key));
    return `${kind}/${decodeURIComponent(entity[2])}${bounded.size?`?${bounded}`:""}`;
  }
  if(path==="/now"){
    const params=new URLSearchParams(location.search); params.delete("lang");
    return `now${params.size?`?${params}`:""}`;
  }
  const browse=path.match(/^\/browse(?:\/([^/]+))?$/);
  if(browse){
    const facet=browse[1];
    if(!facet) return "browse";
    const route=DOCUMENT_FACET_HASHES[facet];
    if(!route) return "";
    const params=new URLSearchParams(location.search); params.delete("lang"); params.delete("legacy");
    const canonical = globalThis.CrolRouteMigration?.canonicalizeBrowseUrl?.(`${path}${params.size?`?${params}`:""}`) || `${path}${params.size?`?${params}`:""}`;
    if (canonical !== `${path}${params.size?`?${params}`:""}`) history.replaceState(null, "", canonical);
    const canonicalUrl = new URL(canonical, location.origin);
    const canonicalParams = new URLSearchParams(canonicalUrl.search);
    return `${route}${canonicalParams.size?`?${canonicalParams}`:""}`;
  }
  return "";
}
function documentUrlForHash(hash){
  const language=new URLSearchParams(location.search).get("lang");
  const input=`/${language?`?lang=${encodeURIComponent(language)}`:""}${hash}`;
  const mapped=CrolRouteMigration.migrateLegacyUrl(input);
  return mapped.migrated?mapped.target:null;
}
function routeUrlForHash(hash){ return documentUrlForHash(hash)||hash; }
function routeFocusKey(){
  return location.hash
    ? routeUrlForHash(location.hash)
    : `${location.pathname}${location.search}`;
}
const noticeLink = id => currentLanguageURL(noticeDocumentUrl(id, location.origin));
const landLink = id => currentLanguageURL(location.origin + location.pathname + "#land/" + encodeURIComponent(id));
let hashLock = false;
let focusedItemRouteHash = "";
let activeRouteFacetValues = {};

// `facet` is the scope-v0 escape hatch for typed constraints that do not own a
// visible control. Keep those values while serializeState() rebuilds the rest
// of the route from the active lens controls; otherwise canonical document
// hydration silently drops entity intersections on its first rewrite.
function facetValuesFromRouteRaw(raw){
  const queryAt=String(raw||"").indexOf("?");
  if(queryAt<0) return {};
  const encoded=new URLSearchParams(String(raw).slice(queryAt+1)).get("facet");
  if(!encoded || encoded.length>2000) return {};
  try{
    const parsed=JSON.parse(encoded);
    if(!parsed || typeof parsed!=="object" || Array.isArray(parsed)) return {};
    const probe=CrolScope.emptyScope(window.LANG||"en");
    probe.facets.values=parsed;
    return CrolScope.normalizeScope(probe,{language:window.LANG||"en"}).facets.values;
  }catch(e){ return {}; }
}

function agencyFromRouteFacet(values){
  return agencyNameFromEntityFacet(values);
}

// Hash navigation changes both the visual viewport and the assistive-technology reading point.
// The active-pane guard prevents a slow route from reclaiming focus after navigation moved on.
// When history is restoring a prior scroll point, focus without scrollIntoView so we do not
// yank the reader to the item top and erase "where you came from."
function focusItemRouteTarget(target){
  if(!target) return;
  const routeKey=routeFocusKey();
  requestAnimationFrame(()=>{
    if(routeFocusKey()!==routeKey || focusedItemRouteHash===routeKey ||
       !target.isConnected || !target.closest(".tabpane.active")) return;
    const restoring=isRestoringHistoryRouteScroll();
    if(!restoring) target.scrollIntoView({block:"start"});
    if(target.getAttribute("tabindex")!=="-1") target.setAttribute("tabindex","-1");
    target.setAttribute("aria-current","page");
    target.focus({preventScroll:true});
    focusedItemRouteHash=routeKey;
    if(restoring) applyActiveHistoryRouteScroll();
  });
}

async function copyText(txt, btn){ // NOT `t` — that's the i18n lookup
  if(/^https?:\/\//i.test(String(txt||""))) txt=currentLanguageURL(txt);
  let ok = false;
  try{ await navigator.clipboard.writeText(txt); ok = true; }
  catch(e){
    try{ const ta=document.createElement("textarea"); ta.value=txt; document.body.appendChild(ta); ta.select(); ok=document.execCommand("copy"); ta.remove(); }catch(_){}
  }
  if(btn){ const old=btn.innerHTML; btn.innerHTML = ok ? t("copied_check") : t("copy_failed"); setTimeout(()=>{ btn.innerHTML = old; }, 1800); }
}

// Select an option that may not be loaded yet (agency lists populate async).
function forceSelect(sel, val){
  const s = $(sel); if(!s || !val) return;
  if(![...s.options].some(o=>o.value===val)){ const o=document.createElement("option"); o.textContent=val; s.appendChild(o); }
  s.value = val;
}
function forceAmountSelect(value){
  const select=$("#minamt"), amount=positiveAmount(value);
  if(!select) return;
  if(!amount){ select.value=""; return; }
  const val=String(amount);
  if(![...select.options].some(option=>option.value===val)){
    const option=document.createElement("option"); option.value=val; option.textContent=money(amount)+"+"; select.appendChild(option);
  }
  select.value=val;
}

function serializeState(){
  const tab = document.querySelector(".tabbtn.active")?.dataset.tab;
  if(!tab) return location.hash || "#money"; // notice view keeps its own hash
  // Preserve #exam/<id> while a deep-linked exam detail is selected. Rewriting to
  // #people?view=guide would re-enter applyHash and clear careerSelected (list-only race).
  if(tab === "people" && careerSelected && /^\d{4}$/.test(String(careerSelected))){
    return "#exam/"+encodeURIComponent(String(careerSelected));
  }
  const q = new URLSearchParams();
  if(tab === "money"){
    if($("#mode").value !== "open") q.set("mode", $("#mode").value);
    if($("#agency").value) q.set("agency", $("#agency").value);
    if($("#kw").value.trim()) q.set("q", $("#kw").value.trim());
    if($("#sort").value !== "deadline") q.set("sort", $("#sort").value);
    if($("#minamt").value) q.set("min", $("#minamt").value);
    if(moneyNlResolved.maxAmount) q.set("max", String(moneyNlResolved.maxAmount));
    if(moneyNlResolved.category) q.set("category", moneyNlResolved.category);
    if(moneyNlResolved.months) q.set("months", String(moneyNlResolved.months));
    if(moneyNlResolved.excludeSpecial) q.set("standard", "1");
    if(closingWeek) q.set("closing", "week");
    if(methodSel) q.set("m", methodSel);
    if(moneyLocationFilter?.layer==="contract_action_address"){
      q.set("basis","contract_action_address");
      if(moneyLocationFilter.basis) q.set("actionBasis",moneyLocationFilter.basis);
      if(moneyLocationFilter.borough) q.set("boro",moneyLocationFilter.borough);
      if(moneyLocationFilter.communityDistrict) q.set("cd",moneyLocationFilter.communityDistrict);
      if(moneyLocationFilter.councilDistrict) q.set("council",moneyLocationFilter.councilDistrict);
    }
  } else if(tab === "people"){
    if($("#staffing-query").value.trim()) q.set("q", $("#staffing-query").value.trim());
    if(staffingFilters.role) q.set("role", staffingFilters.role);
    if(staffingFilters.agency) q.set("agency", staffingFilters.agency);
    // Declarative interest routing only: structured attributes the visitor chose, never a profile.
    // The exam browser is the default Staffing entry and is always mounted. Only
    // preserve guide filters when the visitor arrived through an explicit guide
    // route; otherwise a tab switch must mint the clean Staffing document URL.
    const guideRouteMarker = ["view", "guide"].join("=");
    const explicitGuideRoute = location.hash.includes(guideRouteMarker)
      || (location.pathname === "/browse/staffing/" && new URLSearchParams(location.search).get("view") === guideRouteMarker.split("=")[1]);
    if(explicitGuideRoute){
      const facetState=globalThis.careerFacetState || {};
      const interest=facetState.interest;
      if(interest && interest !== "all" && CrolStaffing.isInterestArea(interest)) q.set("interest", interest);
      const eligibility=$("#career-eligibility")?.value;
      if(eligibility && eligibility !== "open_competitive") q.set("eligibility", eligibility);
      const windowFilter=facetState.window;
      if(windowFilter && windowFilter !== "actionable") q.set("window", windowFilter);
      const format=facetState.format;
      if(format && format !== "all") q.set("format", format);
      const salaryBand=facetState.salary_band;
      if(salaryBand && salaryBand !== "all") q.set("salary", salaryBand);
      const feeLevel=facetState.fee_level;
      if(feeLevel && feeLevel !== "all") q.set("fee", feeLevel);
      const noExp=facetState.no_experience;
      if(noExp && noExp !== "all") q.set("experience", noExp);
    }
  } else if(tab === "land"){
    if(landBorough) q.set("boro", landBorough);
    if(landCommunityDistrict) q.set("cd", landCommunityDistrict);
    if(landCouncilDistrict) q.set("council", landCouncilDistrict);
    if($("#lkw").value.trim()) q.set("q", $("#lkw").value.trim());
    if($("#lstatus").value !== "all") q.set("status", $("#lstatus").value);
    if($("#lstatus").value==="hearings" && landAttendance) q.set("attendance", landAttendance);
    if($("#lstatus").value==="hearings" && landClosingWeek) q.set("closing", "week");
  } else if(SECTIONS[tab]){
    const ag=$("#"+tab+"agency"); if(ag && ag.value) q.set("agency", ag.value);
    const kw=$("#"+tab+"kw"); if(kw && kw.value.trim()) q.set("q", kw.value.trim());
    const w=$("#"+tab+"when");
    if(w && tab==="meetings" && w.value && w.value !== "week") q.set("when", w.value);
    else if(w && tab!=="meetings" && w.value !== "upcoming") q.set("when", w.value);
    if(tab==="meetings"){
      const place=$("#meetingsboro").value;
      if(place==="citywide-unlocated"||place==="citywide"||place==="virtual"||place==="unlocated") q.set("scope",place);
      else if(place) q.set("boro",place);
      if(meetingsCommunityDistrict) q.set("cd",meetingsCommunityDistrict);
      if(meetingsCouncilDistrict) q.set("council",meetingsCouncilDistrict);
      if($("#meetingsneighborhood").value.trim()) q.set("neighborhood",$("#meetingsneighborhood").value.trim());
      if(meetingsProcessSel !== "all") q.set("process", meetingsProcessSel);
      if(meetingsPlaceGroupSel === "place") q.set("group", "place");
    }
    if(tab === "property"){
      if(propAgency) q.set("agency", propAgency);
      if(propertyBorough) q.set("boro", propertyBorough);
      if($("#propertyneighborhood").value.trim()) q.set("neighborhood", $("#propertyneighborhood").value.trim());
      if(propertyCommunityDistrict) q.set("cd", propertyCommunityDistrict);
      if(propertyCouncilDistrict) q.set("council", propertyCouncilDistrict);
      if(propAsset !== "all") q.set("asset", propAsset);
      if(typeof propSaleMethod !== "undefined" && propSaleMethod !== "all") q.set("method", propSaleMethod);
      if(typeof propPriceBand !== "undefined" && propPriceBand !== "all") q.set("price", propPriceBand);
      if(typeof propSort !== "undefined" && propSort && propSort !== "closing_soon") q.set("sort", propSort);
      if(propProcessSel !== "all") q.set("process", propProcessSel);
      if(propStageSel !== "all") q.set("stage", propStageSel);
      if(propertyView === "archive") q.set("view", "archive");
      if(globalThis.propertyParcelScopeBbl) q.set("facet",JSON.stringify({entity_refs_all:[`bbl:${globalThis.propertyParcelScopeBbl}`]}));
    }
    if(tab === "rules"){
      if(rulesAgency) q.set("agency", rulesAgency);
      if(rulesProcessSel !== "all") q.set("process", rulesProcessSel);
      if(rulesBorough==="citywide") q.set("scope","citywide");
      else if(rulesBorough) q.set("boro", rulesBorough);
    }
  }
  if(tab === "property"){
    const taxPanel=$("#tax-lien-sale-panel");
    if(propertyView !== "archive" && taxPanel && !taxPanel.hidden) q.set("view", "tax-lien");
  }
  const qs = q.toString();
  const rawHash="#" + tab + (qs ? "?" + qs : "");
  const scope=CrolScope.scopeFromRouteHash(rawHash,{language:window.LANG||"en"});
  scope.facets.values={...scope.facets.values,...activeRouteFacetValues};
  if(tab === "rules" && rulesAgency){
    const ref=entityRouteRef("agency", rulesAgency);
    if(ref){
      scope.facets.agencies=[];
      const refs=Array.isArray(scope.facets.values.entity_refs_all)
        ? scope.facets.values.entity_refs_all.filter(item=>!/^agency:/.test(String(item)))
        : [];
      scope.facets.values.entity_refs_all=[...new Set([...refs, ref])];
    }
  }
  return CrolScope.routeHashFromScope(scope,{surface:tab});
}
function nearYouHref(scope){
  const normalized=CrolScope.normalizeScope(scope,{language:window.LANG||"en"});
  const common=CrolScope.commonNearYouPath(normalized);
  if(common) return common;
  return CrolScope.nearYouUrlFromScope(normalized,{base:"https://cityscroll.org/near-you"});
}
function syncNearYouLinks(currentHash){
  const active=document.querySelector(".tabbtn.active")?.dataset.tab||"meetings";
  const activeHash=currentHash||serializeState();
  document.querySelectorAll("[data-near-you-link]").forEach(link=>{
    const requested=link.dataset.lens==="current"?active:(link.dataset.lens||active);
    const supported=["money","people","land","property","rules","meetings","now","alerts"].includes(requested);
    const route=supported&&requested===active?activeHash:`#${supported?requested:"meetings"}`;
    const scope=CrolScope.scopeFromRouteHash(route,{language:window.LANG||"en"});
    link.href=nearYouHref(scope);
  });
}
function updateHash(){ // filter changes rewrite the current entry
  if(hashLock) return;
  const h = serializeState();
  if(!location.hash && !documentRouteRaw() && h === "#money") return; // don't decorate a fresh default load
  const url=routeUrlForHash(h);
  if(`${location.pathname}${location.search}${location.hash}` !== url){
    // Preserve cityscrollRoute (referrer/back + scroll entry). replaceState(null) used to
    // wipe it, so native Back after a filter tweak could not restore place.
    const entry={hash:h,x:normalizeHistoryPoint(scrollX),y:normalizeHistoryPoint(scrollY)};
    history.replaceState(routeHistoryState({entry}), "", url);
  }
  syncNearYouLinks(h);
}
function pushHash(){ // tab changes create a history entry (back returns to the prior tab)
  if(hashLock) return;
  const h = serializeState();
  const url=routeUrlForHash(h);
  if(`${location.pathname}${location.search}${location.hash}` !== url){
    const entry={hash:h,x:normalizeHistoryPoint(scrollX),y:normalizeHistoryPoint(scrollY)};
    // New tab entries do not inherit an item-route back target.
    history.pushState(routeHistoryState({entry, back:null}), "", url);
  }
  syncNearYouLinks(h);
}

// ===== Digest deep-links (w12-12) =====
// A digest email's notice link carries the originating watch's own {lens, filter} as a "?w="
// query on the "#notice/<id>" hash segment -- worker/src/lib/filter.mjs's encodeWatchFilter()
// builds it, worker/src/redirect.mjs forwards it through the count-only /r click-through
// unread. Landing here, showNotice() re-renders the exact same Matched-evidence highlighting +
// interpretation echo the subscriber would see running the watch themselves -- no server-side
// state, nothing identifying beyond the notice id itself (the URL is exactly as shareable as a
// plain "#notice/<id>" link already was).
//
// DEEPLINK_LENSES/deeplinkClampField/sanitizeDeepLinkFilter are a hand-synced client port of
// worker/src/lib/filter.mjs's LENSES/clampField/sanitize -- same dual-implementation convention
// as external_awards.js/lib/external_award.mjs (see AGENTS.md). test/deeplink_watch.test.mjs
// cross-checks the two stay in sync. Reusing sanitize()'s clamp-to-schema behavior is what makes
// an unexpected extra key or an out-of-range value fail soft (silently dropped, not an error)
// rather than break rendering.
const DEEPLINK_LENSES = {
  // Keep field-for-field parity with worker/src/lib/filter.mjs LENSES (deeplink_watch.test).
  money:    ["keywords", "agency", "minAmount", "maxAmount", "category", "months", "noticeType", "excludeSpecial", "closingWeek", "route", "name", "tab", "entity_refs_all", "connection_relation"],
  people:   ["keywords", "lookupType", "view", "interestArea", "interestLabel", "examNumber", "subject_refs_all"],
  land:     ["keywords", "boro", "status", "communityDistrict", "councilDistrict", "nearMe"],
  property: ["keywords", "agency", "process", "stage", "asset", "saleMethod", "priceBand", "sort", "borough", "neighborhood", "communityDistrict", "nearMe"],
  rules:    ["keywords", "agency", "process"],
  meetings: ["keywords", "agency", "when", "borough", "neighborhood", "locationScope", "dateWindow", "process", "nearMe"],
  district: ["councilDistrict"],
  entity:   ["name", "kind", "tab"],
  mandates: ["agency_id", "agency", "mandate_id", "deliverable_type", "windowDays"],
  obligations: ["agency_id", "agency", "mandate_id", "deliverable_type", "windowDays"],
  alerts:   ["watchType", "place", "keywords", "agency", "minAmount", "maxAmount", "category", "months", "noticeType", "excludeSpecial", "closingWeek", "route", "name", "tab", "entity_refs_all", "connection_relation"],
  award:    ["requestId", "agency"],
};
const DEEPLINK_CATEGORIES = ["Goods", "Goods and Services", "Services (other than human services)",
  "Human Services/Client Services", "Construction/Construction Services", "Construction Related Services"];
const DEEPLINK_BOROS = ["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island"];
function deeplinkClampField(name, v){
  switch(name){
    case "keywords": return Array.isArray(v) ? v.map(k=>String(k).toLowerCase().trim()).filter(Boolean).slice(0,4) : [];
    case "agency": return typeof v==="string" && v.trim() ? v.trim() : null;
    case "agency_id": { const s=typeof v==="string"?v.trim().toLowerCase():""; return /^[a-z0-9][a-z0-9-]{1,80}$/.test(s)?s:null; }
    case "mandate_id": {
      // Exact statutory duty id — bare id or legacy mandate:/obligation: subject ref.
      // Keep field-for-field parity with worker/src/lib/filter.mjs + site/mandate_subject_ref.mjs.
      let s = typeof v === "string" ? v.trim() : "";
      const legacy = s.match(/^(?:mandate|obligation):([^:\s]+)$/i);
      if (legacy) s = legacy[1];
      if (!s || /\s/.test(s) || s.includes(":")) return null;
      return /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(s) ? s : null;
    }
    case "deliverable_type": { const s=typeof v==="string"?v.trim().toLowerCase():""; return ["report","rulemaking","program","data publication","other"].includes(s)?s:null; }
    case "windowDays": {
      const n=typeof v==="number"?v:(typeof v==="string"&&v.trim()?Number(v):NaN);
      if(!Number.isFinite(n)) return null;
      const days=Math.round(n);
      return days>=1&&days<=365?days:null;
    }
    case "minAmount": return typeof v==="number" && v>=1000 ? Math.round(v) : null;
    case "maxAmount": return typeof v==="number" && v>=1000 ? Math.round(v) : null;
    case "category": return DEEPLINK_CATEGORIES.includes(v) ? v : null;
    case "months": return typeof v==="number" && v>0 && v<=60 ? Math.round(v) : null;
    case "noticeType": return v==="award" ? "award" : v==="solicitation" ? "solicitation" : null;
    case "excludeSpecial": return !!v;
    case "boro": { const s = typeof v==="string" ? v.trim().toLowerCase() : ""; return DEEPLINK_BOROS.find(b=>b.toLowerCase()===s) || null; }
    case "status": return v==="all" ? "all" : v==="active" ? "active" : null;
    case "when": return ["all","upcoming","week","month","past"].includes(v) ? v : null;
    case "borough": { const s=typeof v==="string"?v.trim().toLowerCase():""; return DEEPLINK_BOROS.find(b=>b.toLowerCase()===s)||null; }
    case "neighborhood": return typeof v==="string"&&v.trim()?v.replace(/\s+/g," ").trim().slice(0,80):null;
    case "locationScope": return v==="citywide-unlocated"||v==="citywide"||v==="virtual"||v==="unlocated"?v:null;
    case "dateWindow": return ["week","month","upcoming"].includes(v)?v:null;
    case "lookupType": return v==="person" ? "person" : v==="role" ? "role" : null;
    case "view": return v==="guide" ? "guide" : null;
    case "interestArea": return ["public-safety","health-care","engineering-construction","technology-science","community-social-services","administration-finance","trades-operations"].includes(v)?v:null;
    case "interestLabel": return typeof v==="string"&&v.trim()?v.replace(/\s+/g," ").trim().slice(0,80):null;
    case "examNumber": return typeof v==="string" && /^\d{4}$/.test(v.trim()) ? v.trim() : null;
    case "name": return typeof v==="string" && v.trim() ? v.replace(/\s+/g," ").trim().slice(0,120) : null;
    case "kind": return v==="agency" ? "agency" : v==="vendor" ? "vendor" : null;
    case "watchType": return v==="rezone" ? "rezone" : null;
    case "place": return typeof v==="string" && v.trim() ? v.trim() : null;
    case "requestId": return typeof v==="string" && /^[A-Za-z0-9_-]{4,40}$/.test(v.trim()) ? v.trim() : null;
    case "entity_refs_all": return Array.isArray(v) ? [...new Set(v.map(item=>String(item||"").trim()).filter(item=>/^(?:agency:[^:\s]+:[^:\s]+|vendor:stem:[^:\s]+|entity:official:[^:\s]+|project:[A-Za-z0-9][A-Za-z0-9_-]{2,24}|notice:[A-Za-z0-9][A-Za-z0-9_-]{3,39}|pin:[A-Za-z0-9][A-Za-z0-9_-]{3,39}|exam:\d{4}|bbl:\d{10})$/.test(item)))].slice(0,20) : [];
    case "connection_relation": return typeof v==="string" && ["published_by_agency","named_vendor","sited_on_parcel","votes_on","references_contract","registered_as","shares_authority_key","about_notice","parcel_links_project","named_owner","same_rulemaking"].includes(v) ? v : null;
    case "closingWeek": return !!v;
    case "route": return v==="agency" || v==="vendor" ? v : null;
    case "tab": return v==="forecast" || v==="overview" ? v : null;
    case "communityDistrict": { const s=typeof v==="string"?v.trim().toUpperCase():""; return /^(?:M|X|K|Q|R)\d{2}$/.test(s)?s:null; }
    case "councilDistrict": { const s=(typeof v==="string"||typeof v==="number")?String(v).trim():""; return /^(?:[1-9]|[1-4]\d|5[01])$/.test(s)?s:null; }
    case "nearMe": return !!v;
    case "process": {
      const allowed=["proposal","public_process","adoption","effective","unstaged","hearing","auction_or_rfp","award_or_conveyance","scheduled","agenda","held","outcomes"];
      return allowed.includes(v)?v:null;
    }
    case "stage": { const s=typeof v==="string"?v.trim():""; return s&&s!=="all"?s.slice(0,40):null; }
    case "asset": { const s=typeof v==="string"?v.trim():""; return s&&s!=="all"?s.slice(0,40):null; }
    case "saleMethod": {
      const s=typeof v==="string"?v.trim().toLowerCase().replace(/-/g,"_"):"";
      return ["online_auction","public_auction","sealed_bid","rfp","lease_auction"].includes(s)?s:null;
    }
    case "priceBand": {
      const s=typeof v==="string"?v.trim().toLowerCase().replace(/-/g,"_"):"";
      return ["priced","under_10k","10k_100k","100k_plus"].includes(s)?s:null;
    }
    case "sort": {
      const s=typeof v==="string"?v.trim().toLowerCase().replace(/-/g,"_"):"";
      return ["closing_soon","newest","price_desc","price_asc"].includes(s)?s:null;
    }
    default: return null;
  }
}
function sanitizeDeepLinkFilter(lens, input){
  const fields = DEEPLINK_LENSES[lens] || DEEPLINK_LENSES.money;
  const f = input || {};
  const out = {};
  for(const name of fields) out[name] = deeplinkClampField(name, f[name]);
  return out;
}
// raw is already percent-decoded (URLSearchParams.get()). null on anything malformed, truncated
// (JSON.parse throws), or naming an unrecognized lens -- the caller then renders the plain
// notice view, same as if no watch had been carried at all.
function parseWatchParam(raw){
  if(!raw || raw.length > 2000) return null;
  let obj;
  try{ obj = JSON.parse(raw); }catch(e){ return null; }
  if(!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const lens = typeof obj.lens === "string" ? obj.lens : null;
  if(!lens || !DEEPLINK_LENSES[lens]) return null;
  return { lens, filter: sanitizeDeepLinkFilter(lens, obj.filter) };
}
// The "We understood this as" echo chips, reusing each lens's own chip builder so a deep-linked
// notice reads exactly like running the watch would have. NL.alerts.chips() already covers the
// full money-shaped schema (money's own Ask box has no NL.money entry -- nlTranslate() builds
// its chips inline -- but the shape is identical to NL.alerts', which money-lens deep links
// reuse here). Entity watches match by name, not keyword: there's nothing hidden to explain (the
// agency/vendor name is already shown plainly elsewhere on the notice), so they render no
// chips -- same posture matchEvidence() already takes for entity subs (see lib/digest.mjs).
function watchChipsFor(lens, filter){
  if(lens==="money") return (NL.alerts.chips(filter)||[]).filter(Boolean);
  if(NL[lens] && typeof NL[lens].chips === "function") return (NL[lens].chips(filter)||[]).filter(Boolean);
  return [];
}
// rest: whatever follows "notice/" in the hash, e.g. "20260701099?w=%7B...%7D" or a bare id
// with no query at all (the pre-w12-12 shape, still fully supported -- watch comes back null).
function parseNoticeHashSegment(rest){
  const qi = rest.indexOf("?");
  const id = decodeURIComponent(qi < 0 ? rest : rest.slice(0, qi));
  const params = qi < 0 ? new URLSearchParams() : new URLSearchParams(rest.slice(qi+1));
  const watch = parseWatchParam(params.get("w"));
  // focus=follow-the-dollars (and future in-notice anchors) — scroll after async panels load.
  const focus = params.get("focus") || null;
  return { id, watch, focus };
}

// Pending in-notice scroll target set by applyHash; cleared after a successful scroll.
let pendingNoticeFocus = null;
function scrollToLifecycleFocus(){
  const focus = pendingNoticeFocus || (() => {
    const raw = location.hash.slice(1)||documentRouteRaw();
    if(!raw.startsWith("notice/")) return null;
    return parseNoticeHashSegment(raw.slice(7)).focus;
  })();
  if(focus !== LIFECYCLE_DOLLARS_ANCHOR) return;
  const target = document.getElementById(LIFECYCLE_DOLLARS_ANCHOR);
  if(!target) return;
  pendingNoticeFocus = null;
  try{ target.scrollIntoView({behavior:"smooth", block:"start"}); }catch(e){ target.scrollIntoView(); }
  try{ target.focus({preventScroll:true}); }catch(e){}
}

function parseLandHashSegment(rest){
  let id;
  try{ id=decodeURIComponent(rest); }catch(e){ return null; }
  return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : null;
}

// Every hash prefix that addresses one item also has a collection-level landing. This keeps
// hand-typed/share-trimmed routes useful instead of letting them fall through to the default tab.
function bareCollectionHash(raw){
  const route=raw.endsWith("/")?raw.slice(0,-1):raw;
  return {
    notice:"#money",
    exam:"#people?view=guide",
    land:"#land",
    vendor:"#money",
    agency:"#money",
    matter:"#money",
    "investigation/shared":"#investigation",
    "task/can-i-bid":"#task/can-i-bid",
    "task/what-will-change":"#task/what-will-change",
    task:"#money",
  }[route]||null;
}

// Readers still use the former Staffing lens name in hand-written and shared URLs.
// Normalize only the route token so every query parameter survives byte-for-byte; generated
// links continue to use the canonical People namespace.
function canonicalInputRoute(raw){
  const qi=raw.indexOf("?");
  const route=qi<0?raw:raw.slice(0,qi);
  return route==="staffing"?"people"+raw.slice(route.length):raw;
}

// Item routes are a same-document SPA navigation, so their visible Back control should traverse
// the entry that opened them instead of guessing a global landing. The URL remains canonical and
// shareable; this small history-state sidecar carries only the prior hash and viewport position.
function safeHistoryHash(value){
  if(typeof value!=="string" || value.length<2 || value.length>3000 || value[0]!=="#") return null;
  return /[\u0000-\u001f\u007f#]/.test(value.slice(1))?null:value;
}
function normalizeHistoryPoint(value){
  const number=Number(value);
  return Number.isFinite(number)?Math.max(0,Math.round(number)):0;
}
function itemRouteFallbackHash(hash){
  const safe=safeHistoryHash(hash);
  if(!safe) return null;
  const raw=safe.slice(1), path=raw.split("?",1)[0];
  if(/^notice\/[^/]+$/.test(path)) return "#money";
  if(/^exam\/[^/]+$/.test(path)) return "#people?view=guide";
  if(/^land\/[^/]+$/.test(path)) return "#land";
  if(/^(?:vendor|agency|matter)\/[^/]+$/.test(path)) return "#money";
  if(/^investigation\/shared\/[^/]+$/.test(path)) return "#investigation";
  if(path==="investigation") return "#money";
  if(/^task\/can-i-bid\/[^/]+$/.test(path)) return "#task/can-i-bid";
  if(/^task\/what-will-change\/[^/]+$/.test(path)) return "#task/what-will-change";
  if(path==="task/can-i-bid") return "#money";
  if(path==="task/what-will-change") return "#land";
  return null;
}
function routeHistoryEntry(state){
  const entry=state&&state.cityscrollRoute&&state.cityscrollRoute.entry;
  const hash=entry&&safeHistoryHash(entry.hash);
  return hash?{hash,x:normalizeHistoryPoint(entry.x),y:normalizeHistoryPoint(entry.y)}:null;
}
function routeReturnContext(state){
  const back=state&&state.cityscrollRoute&&state.cityscrollRoute.back;
  const hash=back&&safeHistoryHash(back.hash);
  return hash?{hash,x:normalizeHistoryPoint(back.x),y:normalizeHistoryPoint(back.y)}:null;
}
function routeHistoryState(patch){
  const current=history.state&&typeof history.state==="object"&&!Array.isArray(history.state)?history.state:{};
  const prior=current.cityscrollRoute&&typeof current.cityscrollRoute==="object"?current.cityscrollRoute:{};
  const next={...prior,...patch};
  // Explicit null clears a prior back target (tab push) without leaving a stale referrer.
  if(Object.prototype.hasOwnProperty.call(patch,"back") && patch.back==null) delete next.back;
  return {...current,cityscrollRoute:next};
}
function currentRouteSnapshot(){
  const hasActiveLens=!!document.querySelector(".tabbtn.active");
  const currentHash=safeHistoryHash(location.hash);
  const hash=(currentHash&&itemRouteFallbackHash(currentHash)?currentHash:
    safeHistoryHash(hasActiveLens?serializeState():currentHash))||"#money";
  const entry={hash,x:normalizeHistoryPoint(scrollX),y:normalizeHistoryPoint(scrollY)};
  history.replaceState(routeHistoryState({entry}),"",hash);
  return entry;
}
// Name the referring view for the back control: lens tab label, or a short item-route kind.
// Cold deep links keep the collection fallback label (back_browse / caller override).
function routeBackViewName(hash){
  const safe=safeHistoryHash(hash);
  if(!safe) return null;
  const path=safe.slice(1).split("?",1)[0];
  if(path.startsWith("agency/")) return t("meta_agency_profile");
  if(path.startsWith("vendor/")) return t("meta_vendor_profile");
  if(path.startsWith("notice/")) return t("notice_fallback");
  if(path.startsWith("matter/")) return t("money_trail_heading");
  if(path.startsWith("land/")) return t("tab_land");
  if(path.startsWith("exam/")) return t("tab_people");
  if(path==="investigation" || path.startsWith("investigation/")) return t("inv_default_name");
  const tab=path.split("/")[0];
  const tabKey={money:"tab_money",people:"tab_people",land:"tab_land",property:"tab_property",
    rules:"tab_rules",meetings:"tab_meetings",alerts:"tab_alerts"}[tab];
  return tabKey?t(tabKey):null;
}
function routeBackLabel(context, fallbackLabel){
  if(!context) return fallbackLabel||t("back_browse");
  const view=routeBackViewName(context.hash);
  return view?t("back_to_view",{view}):t("back_previous_view");
}
function routeBackHTML(fallbackHash,fallbackLabel,className){
  const context=routeReturnContext(history.state);
  const fallback=safeHistoryHash(fallbackHash)||"#money";
  const href=context?context.hash:routeUrlForHash(fallback);
  const label=routeBackLabel(context, fallbackLabel);
  const classAttr=className?' class="'+escUiHtml(className)+'"':"";
  const styleAttr=className?"":' style="font:600 13px/1 ui-sans-serif,system-ui,sans-serif;text-decoration:none"';
  return '<a'+classAttr+styleAttr+' href="'+escUiHtml(href)+'" data-route-back="'+(context?"history":"fallback")+'">'+label+'</a>';
}

let pendingItemRouteContext=null;
let pendingHistoryRouteScroll=null;
// Active restore target survives async detail re-paints (agency/vendor/notice fetches) that
// would otherwise leave the reader at the top after history.back().
let activeHistoryRouteScroll=null;
function rememberItemRouteContext(event){
  if(event.defaultPrevented || event.button!==0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const target=event.target instanceof Element?event.target.closest("a[href]"):null;
  if(!target || (target.target&&target.target!=="_self") || target.hasAttribute("download")) return;
  let destination;
  try{ destination=new URL(target.href,location.href); }catch(e){ return; }
  if(destination.origin!==location.origin || destination.pathname!==location.pathname || destination.search!==location.search) return;

  if(target.dataset.routeBack==="history"){
    const context=routeReturnContext(history.state);
    if(!context) return;
    event.preventDefault();
    pendingItemRouteContext=null;
    currentRouteSnapshot();
    history.back();
    return;
  }

  if(!itemRouteFallbackHash(destination.hash) || destination.hash===location.hash) return;
  activeHistoryRouteScroll=null;
  pendingItemRouteContext={destination:destination.hash,back:currentRouteSnapshot()};
  setTimeout(()=>{
    if(pendingItemRouteContext&&pendingItemRouteContext.destination===destination.hash&&location.hash!==destination.hash) pendingItemRouteContext=null;
  },0);
}
function commitPendingItemRouteContext(){
  const pending=pendingItemRouteContext;
  pendingItemRouteContext=null;
  if(!pending || pending.destination!==location.hash) return;
  history.replaceState(routeHistoryState({back:pending.back}),"",location.href);
}
function prepareHistoryRouteScroll(state){ pendingHistoryRouteScroll=routeHistoryEntry(state); }
function isRestoringHistoryRouteScroll(){
  const entry=activeHistoryRouteScroll||pendingHistoryRouteScroll;
  if(!entry) return false;
  return (safeHistoryHash(location.hash)||"#money")===entry.hash;
}
function applyActiveHistoryRouteScroll(){
  const entry=activeHistoryRouteScroll;
  if(!entry || (safeHistoryHash(location.hash)||"#money")!==entry.hash) return false;
  scrollTo(entry.x,entry.y);
  return Math.abs(scrollY-entry.y)<=2;
}
function restoreHistoryRouteScroll(){
  const entry=pendingHistoryRouteScroll;
  pendingHistoryRouteScroll=null;
  if(!entry || (safeHistoryHash(location.hash)||"#money")!==entry.hash){
    // Forward/cold navigations are not restores — drop any stale active target.
    if(!entry) activeHistoryRouteScroll=null;
    return;
  }
  activeHistoryRouteScroll=entry;
  let attempts=0;
  const restore=()=>{
    if(activeHistoryRouteScroll!==entry) return;
    if((safeHistoryHash(location.hash)||"#money")!==entry.hash) return;
    scrollTo(entry.x,entry.y);
    attempts++;
    // Item routes re-fetch after popstate; keep trying longer than a list re-paint.
    if(Math.abs(scrollY-entry.y)>2&&attempts<40) setTimeout(restore,50);
  };
  requestAnimationFrame(restore);
}

/* ===================== TASK-FIRST ENTRY (bounded examples) =====================
   Precomputed data/task_first_examples.json — five procurement + five ZAP records.
   Routes are additive (#task/…); existing lenses stay intact. See task_first.js. */
let taskFirstBundle = null;
let taskFirstBundlePromise = null;
function loadTaskFirstBundle(){
  if(taskFirstBundle) return Promise.resolve(taskFirstBundle);
  if(taskFirstBundlePromise) return taskFirstBundlePromise;
  taskFirstBundlePromise = fetch("data/task_first_examples.json")
    .then(r => r.ok ? r.json() : null)
    .then(data => { taskFirstBundle = data; return data; })
    .catch(() => { taskFirstBundle = null; return null; });
  return taskFirstBundlePromise;
}
function taskEsc(value){
  return String(value == null ? "" : value)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function taskBidAnswerHTML(presentation){
  const status = presentation.bid_status || {};
  if(status.key === "open") return t("task_bid_yes_until",{date:fdt(presentation.facts.deadline),n:status.days_left});
  if(status.key === "due_today") return t("task_bid_yes_today");
  if(status.key === "rolling") return t("task_bid_yes_rolling");
  if(status.key === "closed") return t("task_bid_no_closed",{date:fdt(presentation.facts.deadline)});
  return t("task_bid_unknown");
}
function taskPaymentLagHTML(lag){
  if(!lag || lag.bid_count_causality_claimed) return "";
  const subject = lag.subject ? taskEsc(lag.subject) : t("task_payment_lag_related");
  const source = lag.source_url
    ? `<a href="${taskEsc(lag.source_url)}" ${EXT_ATTRS}>${taskEsc(lag.source)}${extSR()}</a>`
    : taskEsc(lag.source);
  // Observed figure only — never bid-count causality (unmeasured).
  const copy = t("task_payment_lag_observed_html",{days:lag.days, subject, source});
  if(window.TaskFirst && !TaskFirst.paymentLagCopyIsSafe(copy.replace(/<[^>]+>/g," "))) return "";
  return `<div class="task-payment-lag">${copy}</div>`;
}
function taskCanIBidCardHTML(presentation, focused){
  const f = presentation.facts;
  const leadRows = [
    [t("task_lead_stage"), f.stage],
    [t("task_lead_method"), f.method],
    [t("task_lead_deadline"), f.deadline ? fdt(f.deadline) : null],
    [t("task_lead_agency"), f.agency],
    [t("task_lead_pin"), f.pin],
  ].filter(([,v]) => v);
  const more = [
    [t("task_fact_category"), f.category],
    [t("task_fact_contact"), [f.contact_name, f.contact_phone, f.email].filter(Boolean).join(" · ")],
    [t("task_fact_submit"), f.submit_to],
    [t("task_fact_other"), f.other_info],
    [t("task_fact_published"), f.start_date ? fdate(f.start_date) : null],
    [t("task_fact_request_id"), f.request_id],
  ].filter(([,v]) => v);
  const desc = f.description
    ? `<div class="scope"><span class="lbl">${t("what_they_want")}</span>${taskEsc(f.description.slice(0,900))}${f.description.length>900?"…":""}</div>`
    : "";
  const itemHref = presentation.id ? TaskFirst.taskItemHash("can-i-bid", presentation.id) : "#task/can-i-bid";
  const noticeHref = presentation.notice_hash || "#money";
  const sourceHref = (presentation.source && presentation.source.url) || (f.request_id ? REQ_URL(f.request_id) : null);
  const sourceLink = sourceHref
    ? officialSourceLink({ href:sourceHref, label:t("city_record_link"), className:"task-city-record-source", escape:taskEsc })
    : "";
  return `<article class="task-card${focused?" route-item":""}"${focused?' tabindex="-1"':""} data-task-id="${taskEsc(presentation.id||"")}">
    <p class="task-card-answer">${taskEsc(taskBidAnswerHTML(presentation))}</p>
    <h3 class="task-card-title" lang="en" dir="ltr">${taskEsc(noticeDisplayTitle({short_title:f.title,request_id:f.request_id}))}</h3>
    <dl class="task-lead">${leadRows.map(([k,v])=>`<div><dt>${taskEsc(k)}</dt><dd lang="en" dir="ltr">${taskEsc(v)}</dd></div>`).join("")}</dl>
    <dl class="task-facts">${more.map(([k,v])=>`<dt>${taskEsc(k)}</dt><dd lang="en" dir="ltr">${taskEsc(v)}</dd>`).join("")}</dl>
    ${desc}
    ${taskPaymentLagHTML(presentation.observed_payment_lag)}
    <div class="task-card-actions actions">
      ${focused?"":`<a class="act" href="${taskEsc(itemHref)}">${t("task_open_example")}</a>`}
      <a class="act primary" href="${taskEsc(noticeHref)}">${t("task_open_notice_lens")}</a>
      ${sourceLink}
    </div>
  </article>`;
}
function taskWhatWillChangeCardHTML(presentation, focused){
  const f = presentation.facts;
  const leadRows = [
    [t("task_lead_place"), f.place],
    [t("task_lead_boundary"), f.boundary_actions],
    [t("task_lead_stage"), f.stage_public || f.milestone],
  ].filter(([,v]) => v);
  const more = [
    [t("task_fact_milestone"), f.milestone],
    [t("task_fact_project_status"), f.stage_project],
    [t("task_fact_applicant"), f.applicant],
    [t("task_fact_ulurp"), f.ulurp_numbers],
    [t("task_fact_mih"), f.mih_flag == null ? null : (f.mih_flag === "true" ? t("task_mih_yes") : t("task_mih_no"))],
    [t("task_fact_project_id"), f.project_id],
  ].filter(([,v]) => v);
  const brief = f.brief
    ? `<div class="scope"><span class="lbl">${t("in_plain_english")}</span>${taskEsc(f.brief)}</div>`
    : "";
  const itemHref = presentation.id ? TaskFirst.taskItemHash("what-will-change", presentation.id) : "#task/what-will-change";
  const landHref = presentation.land_hash || "#land";
  const sourceHref = (presentation.source && presentation.source.url) || (f.project_id ? `https://zap.planning.nyc.gov/projects/${encodeURIComponent(f.project_id)}` : "#land");
  return `<article class="task-card${focused?" route-item":""}"${focused?' tabindex="-1"':""} data-task-id="${taskEsc(presentation.id||"")}">
    <p class="task-card-answer">${taskEsc(f.place ? t("task_change_place_lead",{place:f.place}) : t("task_change_place_unknown"))}</p>
    <h3 class="task-card-title" lang="en" dir="ltr">${taskEsc(landProjectDisplayTitle({project_name:f.title,project_id:f.project_id,project_brief:f["bri"+"ef"],borough:f.borough,community_district:f.community_district}))}</h3>
    <dl class="task-lead">${leadRows.map(([k,v])=>`<div><dt>${taskEsc(k)}</dt><dd lang="en" dir="ltr">${taskEsc(v)}</dd></div>`).join("")}</dl>
    ${brief}
    <dl class="task-facts">${more.map(([k,v])=>`<dt>${taskEsc(k)}</dt><dd lang="en" dir="ltr">${taskEsc(v)}</dd>`).join("")}</dl>
    <div class="task-card-actions actions">
      ${focused?"":`<a class="act" href="${taskEsc(itemHref)}">${t("task_open_example")}</a>`}
      <a class="act primary" href="${taskEsc(landHref)}">${t("task_open_land_lens")}</a>
      <a class="act" href="${taskEsc(sourceHref)}" ${EXT_ATTRS}>${t("zap_full_project")}${extSR()}</a>
    </div>
  </article>`;
}
function taskCardHTML(presentation, focused){
  if(!presentation) return "";
  if(presentation.task === "can-i-bid") return taskCanIBidCardHTML(presentation, focused);
  if(presentation.task === "what-will-change") return taskWhatWillChangeCardHTML(presentation, focused);
  return "";
}
async function showTaskFirst(task, id){
  showTab("task");
  const box = $("#taskview");
  if(!box) return;
  if(!window.TaskFirst){
    box.innerHTML = `<div class="empty">${t("could_not_reach")}</div>`;
    return;
  }
  box.innerHTML = `<div class="empty"><span class="loading"></span> ${t("task_loading")}</div>`;
  const bundle = await loadTaskFirstBundle();
  if(!bundle || !bundle.tasks || !bundle.tasks[task]){
    const fallback=task==="what-will-change"?"#land":"#money";
    box.innerHTML = `<div class="empty">${t("task_bundle_missing")}<br><br>${routeBackHTML(fallback)}</div>`;
    return;
  }
  const group = bundle.tasks[task];
  const titleKey = task === "can-i-bid" ? "task_can_i_bid_title" : "task_what_will_change_title";
  const deckKey = task === "can-i-bid" ? "task_can_i_bid_deck" : "task_what_will_change_deck";
  const backHref = task === "can-i-bid" ? "#money" : "#land";
  if(id){
    const example = TaskFirst.findExample(bundle, task, id);
    if(!example){
      box.innerHTML = `<div class="empty">${t("task_example_not_found",{id:taskEsc(id)})}<br><br><a href="${TaskFirst.taskCollectionHash(task)}">${t("task_back_examples")}</a></div>`;
      return;
    }
    const presentation = TaskFirst.presentExample(example);
    box.innerHTML = `<div class="task-first">
      <p style="margin:4px 0 12px">${routeBackHTML(TaskFirst.taskCollectionHash(task),t("task_back_examples"))}
      · <a href="${backHref}" style="font:600 13px/1 ui-sans-serif,system-ui,sans-serif;text-decoration:none">${t("back_browse")}</a></p>
      <header class="task-first-head">
        <p class="task-first-kicker">${t("task_entry_kicker")}</p>
        <h2>${t(titleKey)}</h2>
        <p class="task-first-deck">${t(deckKey)}</p>
      </header>
      <div class="task-first-list">${taskCardHTML(presentation, true)}</div>
    </div>`;
    focusItemRouteTarget(box.querySelector(".route-item"));
    applyActiveHistoryRouteScroll();
    return;
  }
  const cards = (group.examples || []).map(ex => taskCardHTML(TaskFirst.presentExample(ex), false)).join("");
  box.innerHTML = `<div class="task-first">
    <p style="margin:4px 0 12px">${routeBackHTML(backHref)}</p>
    <header class="task-first-head">
      <p class="task-first-kicker">${t("task_entry_kicker")}</p>
      <h2>${t(titleKey)}</h2>
      <p class="task-first-deck">${t(deckKey)}</p>
    </header>
    <div class="task-first-list" data-task-collection="${taskEsc(task)}">${cards || `<div class="empty">${t("task_bundle_missing")}</div>`}</div>
  </div>`;
}

function applyHash(){
  setNoticeCompactCta(false);
  const incoming = location.hash.slice(1)||documentRouteRaw();
  const slashPos = incoming.indexOf("/");
  let raw = slashPos >= 0 && incoming.slice(0, slashPos) === "alerts" ? "alerts" : incoming;
  if(incoming !== raw){ history.replaceState(routeHistoryState({}), "", routeUrlForHash("#"+raw)); }
  if(!raw){
    activeRouteFacetValues={};
    globalThis.CROL_ACTIVE_SCOPE_FACET_VALUES={};
    globalThis.CROL_SCOPE_RESULT_COUNT_RECEIPT=null;
    return false;
  }
  activeRouteFacetValues=facetValuesFromRouteRaw(raw);
  globalThis.CROL_ACTIVE_SCOPE_FACET_VALUES={...activeRouteFacetValues};
  const resultCountReceipt=Number(activeRouteFacetValues.result_count_receipt);
  globalThis.CROL_SCOPE_RESULT_COUNT_RECEIPT=Number.isInteger(resultCountReceipt)&&resultCountReceipt>=0
    ?resultCountReceipt:null;
  const canonicalRaw=canonicalInputRoute(raw);
  const normalizedInputAlias=canonicalRaw!==raw;
  if(normalizedInputAlias){
    raw=canonicalRaw;
    history.replaceState(routeHistoryState({entry:{hash:"#"+raw,x:normalizeHistoryPoint(scrollX),y:normalizeHistoryPoint(scrollY)}}),"",routeUrlForHash("#"+raw));
  }
  if(raw==="alerts"||raw.startsWith("alerts" + "?")) return forwardLegacyAlertsToFollowing(raw);
  if(raw==="map"||raw.startsWith("map" + "?")) return forwardLegacyMapToNearYou(raw);
  const scopeSurface=raw.split("?",1)[0];
  const scope=!normalizedInputAlias&&["money","people","land","property","rules","meetings","map","now"].includes(scopeSurface)
    ?CrolScope.scopeFromRouteHash("#"+raw,{language:window.LANG||"en"}):null;
  if(scope){
    const adapted=CrolScope.routeHashFromScope(scope,{surface:scopeSurface});
    if(adapted!=="#"+raw){
      history.replaceState(routeHistoryState({entry:{hash:adapted,x:normalizeHistoryPoint(scrollX),y:normalizeHistoryPoint(scrollY)}}),"",routeUrlForHash(adapted));
      return applyHash();
    }
  }
  const collectionHash=bareCollectionHash(raw);
  if(collectionHash&&location.hash&&location.hash!==collectionHash){
    history.replaceState(routeHistoryState({}),"",collectionHash);
    return applyHash();
  }
  if(raw.startsWith("notice/")){
    setNoticeCompactCta(true);
    const { id, watch, focus } = parseNoticeHashSegment(raw.slice(7));
    pendingNoticeFocus = focus;
    showNotice(id, watch);
    return true;
  }
  if(raw.startsWith("land/")){
    showLandEntry(parseLandHashSegment(raw.slice(5)));
    return true;
  }
  if(raw.startsWith("exam/")){
    const examNumber=decodeURIComponent(raw.slice(5));
    if(/^\d{4}$/.test(examNumber)){ showExam(examNumber); return true; }
    return false;
  }
  // agencyHref()/vendorHref() can append a literal "?tab=forecast" (never inside the
  // encoded name itself, since encodeURIComponent escapes any real "?") to deep-link
  // straight into the profile's Forecast subtab from the notice-detail cross-link.
  const splitEntityTab = rest => { const qi = rest.indexOf("?"); return qi < 0 ? [decodeURIComponent(rest), null] : [decodeURIComponent(rest.slice(0,qi)), new URLSearchParams(rest.slice(qi+1)).get("tab")]; };
  if(raw.startsWith("vendor/")){ const [nm, tab] = splitEntityTab(raw.slice(7)); showVendor(nm, tab); return true; }
  if(raw.startsWith("agency/")){ const [nm, tab] = splitEntityTab(raw.slice(7)); showAgency(nm, tab); return true; }
  if(raw.startsWith("official/")){
    const rest = raw.slice("official/".length);
    const qi = rest.indexOf("?");
    const id = decodeURIComponent(qi < 0 ? rest : rest.slice(0, qi));
    const q = new URLSearchParams(qi < 0 ? "" : rest.slice(qi + 1));
    showOfficial(id, { noticeId: q.get("notice"), eventId: q.get("event") });
    return true;
  }
  if(raw.startsWith("matter/")){ showMatter(decodeURIComponent(raw.slice(7))); return true; }
  if(raw.startsWith("investigation/shared/")){ showSharedInv(decodeURIComponent(raw.slice(21))); return true; }
  if(raw.startsWith("task/") || raw === "task"){
    const parsed = window.TaskFirst ? TaskFirst.parseTaskHash(raw) : null;
    if(!parsed || !parsed.task){
      history.replaceState(routeHistoryState({entry:{hash:"#money",x:0,y:0}}),"","#money");
      return applyHash();
    }
    showTaskFirst(parsed.task, parsed.id);
    return true;
  }
  if(raw === "now" || raw.startsWith("now?")){
    showNow({scope:CrolScope.scopeHasConstraints(scope)?scope:null});
    return true;
  }
  focusedItemRouteHash="";
  if(raw === "investigation"){ showInvestigation(); return true; }
  const qi = raw.indexOf("?"), tab = qi < 0 ? raw : raw.slice(0, qi);
  if(tab === "notice" || tab === "entity" || tab === "task" || !document.getElementById("tab-"+tab)) return false;
  const q = new URLSearchParams(qi < 0 ? "" : raw.slice(qi+1));
  hashLock = true;
  try{
    if(tab === "money"){
      // Reset first: a shared hash must produce the same filter from any prior in-page state.
      $("#mode").value = ["open","allrfp","award"].includes(q.get("mode")) ? q.get("mode") : "open";
      $("#agency").value = "";
      forceSelect("#agency", q.get("agency") || agencyFromRouteFacet(activeRouteFacetValues));
      $("#kw").value = q.get("q") || "";
      $("#sort").value = ["deadline","newest","amount"].includes(q.get("sort")) ? q.get("sort") : "deadline";
      forceAmountSelect(q.get("min"));
      moneyNlResolved = {
        maxAmount: positiveAmount(q.get("max")),
        category: DEEPLINK_CATEGORIES.includes(q.get("category")) ? q.get("category") : null,
        months: Number(q.get("months")) > 0 && Number(q.get("months")) <= 60 ? Math.round(Number(q.get("months"))) : null,
        noticeType: q.get("mode")==="award" ? "award" : q.get("mode")==="open" ? "solicitation" : null,
        excludeSpecial: q.get("standard")==="1",
      };
      closingWeek = q.get("closing") === "week";
      $("#closingweek").classList.toggle("on", closingWeek);
      $("#closingweek").setAttribute("aria-pressed", String(closingWeek));
      methodSel = q.get("m") || "";
      $("#moneylocationbasis").value="";
      $("#moneyboro").value="";
      $("#moneycd").value="";
      $("#moneycouncil").value="";
      const actionBasis=["submission_address","pre_bid_venue","document_pickup"].includes(q.get("actionBasis"))?q.get("actionBasis"):"";
      const hasActionLocation=q.get("basis")==="contract_action_address";
      $("#moneylocationbasis").value=hasActionLocation?(actionBasis||"contract_action_address"):"";
      forceSelect("#moneyboro",hasActionLocation&&DEEPLINK_BOROS.includes(q.get("boro"))?q.get("boro"):"");
      forceSelect("#moneycd",hasActionLocation&&/^(?:M|X|K|Q|R)\d{2}$/.test(q.get("cd")||"")?q.get("cd"):"");
      forceSelect("#moneycouncil",hasActionLocation&&/^(?:[1-9]|[1-4]\d|5[01])$/.test(q.get("council")||"")?q.get("council"):"");
      moneyLocationFilter={
        layer:hasActionLocation?"contract_action_address":"",
        basis:actionBasis,
        borough:hasActionLocation&&DEEPLINK_BOROS.includes(q.get("boro"))?q.get("boro"):"",
        communityDistrict:hasActionLocation&&/^(?:M|X|K|Q|R)\d{2}$/.test(q.get("cd")||"")?q.get("cd"):"",
        councilDistrict:hasActionLocation&&/^(?:[1-9]|[1-4]\d|5[01])$/.test(q.get("council")||"")?q.get("council"):"",
      };
      if(hasActionLocation) $("#mode").value="allrfp";
      showTab("money"); search();
    } else if(tab === "people"){
      const legacyExamRoute=q.get("type")==="exam";
      // The old exam/appointment toggle now resolves to the action-first exam browser.
      // The secondary ledger remains a hires-only historical view.
      staffingFilters.query=q.get("q")||"";
      staffingFilters.role=q.get("role")||"";
      // Typed agency:id:* facets (document Browse URLs) must hydrate the same
      // agency control as legacy ?agency= — otherwise offered scopes are lies.
      const scopedAgency=q.get("agency")||agencyFromRouteFacet(activeRouteFacetValues)||"";
      const agencyScopeChanged=staffingFilters.agency!==scopedAgency;
      staffingFilters.agency=scopedAgency;
      $("#staffing-query").value=staffingFilters.query;
      // A guide route is not an exam detail route — clear any prior #exam/ selection.
      careerSelected=null;
      // Declared structured attributes only (interest/eligibility/window/format facets).
      // No identity profile.
      const interest=q.get("interest");
      const eligibility=q.get("eligibility");
      const windowFilter=q.get("window");
      const format=q.get("format");
      const salaryBand=q.get("salary");
      const feeLevel=q.get("fee");
      const noExperience=q.get("experience");
      const FORMAT_OK=["education_experience","multiple_choice","physical","mixed","written","oral","practical","other","all"];
      const SALARY_OK=["under_45k","45k_60k","60k_80k","80k_plus","all"];
      const FEE_OK=["none","low","fee-bearing","mid","high","all"];
      const EXP_OK=["yes","no","all"];
      if(
        (interest && CrolStaffing.isInterestArea(interest))
        || (eligibility && ["open_competitive","promotion","all"].includes(eligibility))
        || (windowFilter && ["actionable","open","upcoming","closed","all"].includes(windowFilter))
        || (format && FORMAT_OK.includes(format))
        || (salaryBand && SALARY_OK.includes(salaryBand))
        || (feeLevel && FEE_OK.includes(feeLevel))
        || (noExperience && EXP_OK.includes(noExperience))
      ){
        careerRouteFilters={
          interest: CrolStaffing.isInterestArea(interest)?interest:null,
          eligibility: ["open_competitive","promotion","all"].includes(eligibility)?eligibility:null,
          window: ["actionable","open","upcoming","all"].includes(windowFilter)?windowFilter:null,
          format: FORMAT_OK.includes(format)?format:null,
          salary_band: SALARY_OK.includes(salaryBand)?salaryBand:null,
          fee_level: FEE_OK.includes(feeLevel)?feeLevel:null,
          no_experience: EXP_OK.includes(noExperience)?noExperience:null,
        };
      } else if(q.get("view")==="guide" || legacyExamRoute){
        // Explicit guide landing without filters: reset controls to defaults.
        careerRouteFilters={
          interest:null, eligibility:"open_competitive", window:"actionable",
          format:"all", salary_band:"all", fee_level:"all", no_experience:"all",
        };
      }
      // Agency scope reloads the appointment corpus (citywide snapshot is not
      // agency-complete) and re-applies exam certification filtering.
      if(agencyScopeChanged && typeof globalThis.reloadStaffingForAgencyScope==="function"){
        globalThis.reloadStaffingForAgencyScope();
      }
      showTab("people");
      const ledgerRoute=!!(staffingFilters.query||staffingFilters.role||staffingFilters.agency);
      // Agency-scoped Staffing leads with appointments, not the citywide exam guide.
      scrollStaffingView(legacyExamRoute?"guide":ledgerRoute?"notices":q.get("view"));
      if(q.get("view")==="guide" || legacyExamRoute || careerRouteFilters || staffingFilters.agency) loadCareerGuide();
    } else if(tab === "land"){
      landResolvedArea=null;
      landBorough = DEEPLINK_BOROS.includes(q.get("boro"))?q.get("boro"):"";
      landCommunityDistrict=/^(?:M|X|K|Q|R)\d{2}$/.test(q.get("cd")||"")?q.get("cd"):"";
      landCouncilDistrict=/^(?:[1-9]|[1-4]\d|5[01])$/.test(q.get("council")||"")?q.get("council"):"";
      $("#lkw").value = q.get("q") || "";
      const landStatus=q.get("status");
      $("#lstatus").value = landStatus==="all"||landStatus==="hearings"||/^(?:project|public):.+$/.test(landStatus||"") ? landStatus : "active";
      const att=q.get("attendance");
      landAttendance=landStatus==="hearings" && ["in_person","livestream","hybrid"].includes(att||"") ? att : "";
      landClosingWeek=landStatus==="hearings" && q.get("closing")==="week";
      let scopedProjectId="";
      try{
        const facet=JSON.parse(q.get("facet")||"{}");
        const refs=Array.isArray(facet.entity_refs_all)?facet.entity_refs_all:[];
        const projects=[...new Set(refs.map(ref=>String(ref).match(/^project:([A-Za-z0-9][A-Za-z0-9_-]{2,24})$/)?.[1]).filter(Boolean))];
        scopedProjectId=projects.length===1?projects[0]:"";
      }catch(_e){}
      if(scopedProjectId) showLandEntry(scopedProjectId);
      else { const was = landLoaded; showTab("land"); if(was) landSearch(); }
    } else if(SECTIONS[tab]){
      const agency=q.get("agency") || agencyFromRouteFacet(activeRouteFacetValues);
      if(tab === "rules") rulesAgency=agency || "";
      else {
        const agencyControl=$("#"+tab+"agency");
        if(agencyControl){
          agencyControl.value="";
          forceSelect("#"+tab+"agency", agency);
        }
      }
      $("#"+tab+"kw").value = q.get("q") || "";
      const w=$("#"+tab+"when");
      if(w){
        if(tab==="meetings"){
          const whenRaw=q.get("when");
          if(whenRaw==="all"){
            if(![...w.options].some(o=>o.value==="all")){
              const opt=document.createElement("option");
              opt.value="all"; opt.textContent=t("map_drill_when_all");
              w.appendChild(opt);
            }
            w.value="all";
          } else {
            w.value=["week","month","upcoming","past"].includes(whenRaw)?whenRaw:"week";
          }
        } else {
          w.value="upcoming";
        }
      }
      if(tab==="meetings"){
        const scope=q.get("scope");
        $("#meetingsboro").value=(scope==="citywide-unlocated"||scope==="citywide"||scope==="virtual"||scope==="unlocated")
          ?scope
          :(DEEPLINK_BOROS.includes(q.get("boro"))?q.get("boro"):"");
        $("#meetingsneighborhood").value=q.get("neighborhood")||"";
        meetingsCommunityDistrict=/^(?:M|X|K|Q|R)\d{2}$/.test(q.get("cd")||"")?q.get("cd"):"";
        meetingsCouncilDistrict=/^(?:[1-9]|[1-4]\d|5[01])$/.test(q.get("council")||"")?q.get("council"):"";
        const process=q.get("process")||"all";
        meetingsProcessSel=["scheduled","agenda","held","outcomes","unstaged"].includes(process)?process:"all";
        meetingsPlaceGroupSel=q.get("group")==="place"?"place":"flat";
      }
      if(tab === "property"){
        propAgency = q.get("agency") || "";
        propertyBorough=DEEPLINK_BOROS.includes(q.get("boro"))?q.get("boro"):"";
        $("#propertyneighborhood").value=q.get("neighborhood")||"";
        propertyCommunityDistrict=/^(?:M|X|K|Q|R)\d{2}$/.test(q.get("cd")||"")?q.get("cd"):"";
        propertyCouncilDistrict=/^(?:[1-9]|[1-4]\d|5[01])$/.test(q.get("council")||"")?q.get("council"):"";
        propertyResolvedNeighborhood=null;
        propAsset = (typeof normalizePropAsset === "function" ? normalizePropAsset(q.get("asset")) : (q.get("asset") || "all"));
        propSaleMethod = (typeof normalizePropSaleMethod === "function" ? normalizePropSaleMethod(q.get("method")) : (q.get("method") || "all"));
        propPriceBand = (typeof normalizePropPriceBand === "function" ? normalizePropPriceBand(q.get("price")) : (q.get("price") || "all"));
        propSort = (typeof normalizePropSort === "function" ? normalizePropSort(q.get("sort")) : (q.get("sort") || "closing_soon"));
        const sortEl=$("#propsort"); if(sortEl) sortEl.value=propSort;
        propProcessSel = q.get("process") || "all";
        propStageSel = q.get("stage") || "all";
        propertyView = q.get("view")==="archive" ? "archive" : "default";
        let parcelBbl=null;
        try{
          const facet=JSON.parse(q.get("facet")||"{}");
          const refs=Array.isArray(facet.entity_refs_all)?facet.entity_refs_all:[];
          const parcels=[...new Set(refs.map(ref=>String(ref).match(/^bbl:(\d{10})$/)?.[1]).filter(Boolean))];
          parcelBbl=parcels.length===1?parcels[0]:null;
        }catch(_e){}
        globalThis.propertyParcelScopeBbl=parcelBbl;
        const parcelPanel=$("#parcel-biography-panel");
        if(parcelBbl) paintParcelBiographyPanel(parcelBbl);
        else if(parcelPanel){parcelPanel.hidden=true;parcelPanel.innerHTML="";}
        const taxPanel=$("#tax-lien-sale-panel");
        if(taxPanel){
          const showLien=q.get("view")==="tax-lien";
          taxPanel.hidden=!showLien;
          if(showLien) paintTaxLienSalePanel();
        }
      }
      if(tab === "rules"){
        const process=q.get("process")||"all";
        rulesProcessSel=["proposal","public_process","adoption","effective","unstaged"].includes(process)?process:"all";
        const scope=q.get("scope");
        rulesBorough=scope==="citywide"?"citywide"
          :(DEEPLINK_BOROS.includes(q.get("boro"))?q.get("boro"):"");
      }
      const was = feedLoaded[tab]; showTab(tab); if(was) loadSection(tab);
    } else if(tab === "alerts"){
      showTab("alerts");
      const lens = q.get("lens");
      const noticeId = q.get("notice");
      const projectId = q.get("project");
      const rollupView = q.get("view") === "rollup";
      if(lens || noticeId || projectId){
        let filter = {};
        try{ filter = JSON.parse(q.get("filter") || "{}"); }catch(e){ filter = {}; }
        // Context-carrying entry: pre-scope builder + seed real digItemHTML preview.
        Promise.resolve(prefillAlertFromLink(lens, filter, q.get("freq"), {
          noticeId, projectId, matchCount:q.get("count"),
        }))
          .catch(()=>{});
      } else if(!rollupView){
        // Neutral #alerts — clear carried seed and return the single form to a calm bare draft
        // so back-button / bare entry never keep a previous agency/notice prefill.
        // skipQuizSync: refreshQuizDisplay may not be on globalThis yet during first applyHash.
        noticeWatchSeed = null;
        if(typeof paintAlertContextLead === "function") paintAlertContextLead(null);
        if($("#awatch")){
          $("#awatch").value = "rfpkw";
          if(typeof aWatchChange === "function") aWatchChange(true);
          if($("#aparam")) $("#aparam").value = "";
          if($("#aagency")) $("#aagency").value = "";
          if($("#amoneymin")) $("#amoneymin").value = "";
          if($("#amoneymonths")) $("#amoneymonths").value = "";
          alertEntryMatchCount = null;
          if($("#apreviewbox") && typeof t === "function"){
            $("#apreviewbox").innerHTML = `<div class="empty">${t("empty_preview")}</div>`;
          }
          if($("#afeeds")) $("#afeeds").innerHTML = "";
          const adv = document.getElementById("advopts");
          if(adv) adv.open = false;
          if(typeof refreshQuizDisplay === "function") refreshQuizDisplay();
        }
      }
      // #alerts?view=rollup — multi-watch digest rollup + prefs surface (demo fixture).
      if(rollupView){
        Promise.resolve(renderAlertsRollupPrefs())
          .then(()=>focusAlertsRollupPanel())
          .catch(()=>focusAlertsRollupPanel());
      }
    } else {
      showTab(tab);
    }
  } finally { hashLock = false; }
  syncNearYouLinks("#"+raw);
  return true;
}

function forwardLegacyMapToNearYou(raw){
  const scope=CrolScope.scopeFromRouteHash("#"+raw,{language:window.LANG||"en"});
  const target=raw==="map"?"/near-you/":nearYouHref(scope);
  location.replace(target);
  return true;
}

function forwardLegacyAlertsToFollowing(raw){
  const query=raw.includes("?")?raw.slice(raw.indexOf("?")+1):"";
  const target=query
    ? "https://cityscroll.org/following?"+query
    : "/following/";
  location.replace(target);
  return true;
}

function setNoticeCompactCta(isNoticeRoute){
  const homeCta = $("#homeCta");
  if(!homeCta) return;
  homeCta.classList.toggle("compact", !!isNoticeRoute);
  // Header CTA carries current context (notice / lens filters / neutral).
  if(typeof syncAlertsEntryHrefs === "function"){
    Promise.resolve(syncAlertsEntryHrefs()).catch(()=>{});
  }
}

const NOTICE_SELECT = SELECT + ",event_date,street_address_1,section_name,additional_description_2,additional_description_3,other_info_2,other_info_3,printout_1,printout_2,printout_3,building_name,city,state,zip_code";
let attachmentLookupPromise=null;
function noticeAttachmentFallbacks(notice){
  const raw=notice?.document_links;
  const values=[];
  const visit=value=>{
    if(!value)return;
    if(Array.isArray(value)){value.forEach(visit);return;}
    if(typeof value==="object"){visit(value.url||value.href||value.link);return;}
    const text=String(value).trim();
    if(!text)return;
    try{const parsed=JSON.parse(text);if(parsed!==text){visit(parsed);return;}}catch(e){}
    text.replace(/&amp;/gi,"&").split(/\s*[,|]\s*(?=https?:\/\/)/).forEach(item=>values.push(item));
  };
  visit(raw);
  const seen=new Set();
  return values.map(value=>{
    try{
      const url=new URL(value);
      const documentId=url.searchParams.get("documentId")||url.searchParams.get("DocumentID")||url.searchParams.get("documentid");
      if(url.protocol!=="https:"||url.hostname!=="a856-cityrecord.nyc.gov"||!/^\/Search\/GetFile$/i.test(url.pathname)||!documentId||seen.has(documentId))return null;
      seen.add(documentId);
      return {request_id:String(notice?.request_id||""),document_id:documentId,title:null,url:url.href,content_type:null,bytes:null,source:"dataset"};
    }catch(e){return null;}
  }).filter(Boolean);
}
async function noticeAttachmentMetadata(id, notice=null){
  try{
    const response=await workerFetch("/attachment-metadata?id="+encodeURIComponent(id),null,4000);
    if(response.ok){
      const data=await response.json();
      if(Array.isArray(data.attachments) && data.attachments.length) return data;
    }
  }catch(e){}
  if(!attachmentLookupPromise){
    attachmentLookupPromise=fetch("data/attachment_metadata_lookup.json")
      .then(response=>response.ok?response.json():null).catch(()=>null);
  }
  const lookup=await attachmentLookupPromise;
  const attachments=lookup && Array.isArray(lookup.notices?.[String(id)])?lookup.notices[String(id)]:[];
  if(attachments.length) return {request_id:String(id),n_attachments:attachments.length,attachments};
  const fallback=noticeAttachmentFallbacks(notice);
  if(fallback.length) return {request_id:String(id),n_attachments:fallback.length,attachments:fallback};
  return {request_id:String(id),n_attachments:attachments.length,attachments};
}
async function showNotice(id, watch){
  await globalThis.ensureMoneyHistory?.();
  await globalThis.ensureRules?.();
  showTab("notice");
  const box = $("#noticeview");
  const safeId = String(id).replace(/[<>&]/g,"");
  const edgeNotice=box.querySelector(`[data-edge-rendered][data-notice-id="${CSS.escape(String(id))}"]`);
  const meetingFirstPaint=box.querySelector("[data-meeting-outcomes-first-paint]")?.outerHTML||"";
  if(!edgeNotice) box.innerHTML = `<div class="empty"><span class="loading"></span> ${t("fetching_notice_id",{id:safeId})}</div>`;
  let r = null;
  try{
    const rows = await import("../notice-read.mjs").then(m=>m.read(id));
    r = rows[0];
    const attachmentData = await noticeAttachmentMetadata(id,r);
    if(r && attachmentData && Array.isArray(attachmentData.attachments) && attachmentData.attachments.length){
      r.attachments=attachmentData.attachments;
      r.n_documents=Math.max(Number(r.n_documents||0),attachmentData.attachments.length);
      // T3: precomputed related edges from /attachment-metadata when present.
      if(attachmentData.related_by_attachment) r.related_by_attachment=attachmentData.related_by_attachment;
    }
  }catch(e){}
  if(!r){
    lastNoticeContext = null;
    if(edgeNotice){
      applyActiveHistoryRouteScroll();
      if(typeof syncAlertsEntryHrefs === "function") Promise.resolve(syncAlertsEntryHrefs()).catch(()=>{});
      return;
    }
    const cityRecordUrl = cityRecordRequestUrl(id);
    const cityRecordAction = cityRecordUrl
      ? ` · ${officialSourceLink({ href: cityRecordUrl, label: t("try_city_record"), escape: taskEsc })}`
      : "";
    box.innerHTML = `<div class="empty">${t("notice_not_found_html",{id:safeId})} <br><br>${routeBackHTML("#money")}${cityRecordAction}</div>`;
    applyActiveHistoryRouteScroll();
    if(typeof syncAlertsEntryHrefs === "function") Promise.resolve(syncAlertsEntryHrefs()).catch(()=>{});
    return;
  }
  // Property deep links keep the loading state until the route module has supplied the parcel
  // identity used by the action registry. The first rendered action is therefore the final one.
  if(typeof hydratePropertyActionMatter==="function") await hydratePropertyActionMatter(r);
  // Header "Want email updates?" and Watch CTAs read this for notice-scoped #alerts entry.
  lastNoticeContext = { row: r };
  if(typeof syncAlertsEntryHrefs === "function") Promise.resolve(syncAlertsEntryHrefs()).catch(()=>{});
  const link = noticeLink(r.request_id);
  const scope = cleanText(r.additional_description_1);
  const title = noticeDisplayTitle(r);
  const ev = watch ? matchEvidence(title, matchText(r), watch.filter.keywords||[], null, matchAttachmentText(r)) : null;
  const titleInner = (ev && ev.field==="title")
    ? `${title.slice(0,ev.index)}<mark>${title.slice(ev.index, ev.index+ev.term.length)}</mark>${title.slice(ev.index+ev.term.length)}`
    : title;
  const watchChips = watch ? watchChipsFor(watch.lens, watch.filter) : [];
  const initialActionsForGlance = window.CrolActions
    ? CrolActions.compileActionRail(noticeActionMatter(r), { today: todayISO() })
    : [];
  const initialActionRail = window.CrolActions ? actionRailHTML(initialActionsForGlance) : "";
  box.innerHTML = `<div style="max-width:880px;margin:0 auto">
    <p style="margin:4px 0 12px">${routeBackHTML("#money")}</p>
    <div class="panel route-item" tabindex="-1" style="padding:22px 24px">
      <div class="ftype" style="margin-bottom:6px">${r.type_of_notice_description||t("notice_fallback")}${r.section_name?" · "+tSection(r.section_name):""}${r.agency_name?" · "+pivotA(agencyHref(r.agency_name), r.agency_name):""}</div>
      <h2 class="rolename" lang="en" dir="ltr">${titleInner}</h2>
      ${digEvidenceHTML(ev)}
      ${watchChips.length ? `<div class="nlunderstood" role="status">${t("deeplink_watch_context_label")} ${watchChips.join(" ")}</div>` : ""}
      <div id="nactions" data-export-class="actions">${initialActionRail}</div>
      ${r.type_of_notice_description==="Solicitation"?`<div data-export-class="actions">${buildApply(r,false)}</div>`:""}
      <div id="nplain" data-export-class="plain_summary"></div><div id="ncontext" data-export-class="notice_context"></div>
      <div data-export-class="notice_context">${glanceFor(r, actionRailGuideCoverage(initialActionsForGlance))}</div>
      <div id="naddr" data-export-class="address_geography"></div><div id="nmwbe" data-export-class="mwbe_context"></div><div id="nrules" data-export-class="rule_lifecycle"></div><div id="nlifecycle" data-export-class="procurement_lifecycle"></div><div id="nregdwell" data-export-class="award_registration_dwell"></div><div id="nsuboutreach" data-export-class="sub_outreach"></div><div id="ndollars" data-export-class="dollars"></div><div id="nsubsidy" data-export-class="subsidy"></div><div id="naboaward" data-export-class="authority_award"></div><div id="ncommercial" data-export-class="commercial"></div><div id="ndisposition" data-export-class="property_disposition"></div><div id="npropertyxd" data-export-class="property_cross_domain"></div><div id="ntaxlien" data-export-class="tax_lien"></div><div id="nfranchise" data-export-class="franchise"></div><div id="nland" data-export-class="land_project"></div><div id="nmeet" data-export-class="meeting_outcomes">${meetingFirstPaint}</div><div id="nexternal" data-export-class="external_award"></div>
      <div class="actions" style="margin-top:14px">
        <button class="act primary" type="button" id="ncopy">${t("copy_link")}</button>
        ${qrButtonHTML("nqr","act")}
        <a class="act" href="mailto:?subject=${encodeURIComponent("City Record notice: "+(cleanText(r.short_title)||r.request_id))}&body=${encodeURIComponent(link+"\n\nVia CityScroll — NYC’s public record, linked.")}">${t("notice_email_btn")}</a>
        <button class="act export-control" type="button" id="nxlsx">${t("export_xlsx")}</button>
        <button class="act export-control" type="button" id="nprint">${t("print_save_pdf")}</button>
        ${pinBtn("notice", r.request_id, cleanText(r.short_title)||r.request_id, [r.type_of_notice_description, r.agency_name, fdate(r.start_date)].filter(Boolean).join(" · "))}
        ${officialSourceLink({ href: REQ_URL(r.request_id), label: t("view_in_city_record"), className: "notice-source-link", escape: taskEsc })}
      </div>
      ${scope?`<details class="fulltext" data-export-class="official_notice_text"${scope.length<=600?" open":""}><summary>${t("read_full_notice")}</summary><div class="scope" lang="en" dir="ltr" style="margin-top:10px">${scope.slice(0,6000)}${scope.length>6000?"…":""}</div></details>`:""}
      <div class="xlate" id="nxlate" data-export-class="unofficial_translation"></div>
      <div id="nprior" data-export-class="paper_trail"></div>
      <div id="nforecast" data-export-class="agency_forecast"></div>
      <div id="nchain" data-export-class="paper_trail"></div>
      <div class="note" style="margin-top:14px">${t("permalink_note_html",{link, id:r.request_id})}</div>
  </div></div>`;
  $("#ncopy").addEventListener("click", ()=>copyText(link, $("#ncopy")));
  bindQRShare($("#nqr"), link);
  $("#nxlsx").addEventListener("click", async ()=>exportNoticeXlsx(r,await loadChain(r)));
  $("#nprint").addEventListener("click", ()=>printCurrentView("notice",link));
  fillContext(r, $("#ncontext"));
  mountNoticeActionRail($("#nactions"),r);
  if(typeof loadSolicitationMwbe === "function") loadSolicitationMwbe(r, $("#nmwbe"));
  loadRuleLifecycle(r, $("#nrules"));
  loadLifecycle(r, $("#nlifecycle"), $("#ndollars"), $("#nactions"), $("#nsuboutreach"));
  if(typeof loadAwardRegistrationDwell === "function"){
    loadAwardRegistrationDwell(r, $("#nregdwell"));
  }
  loadSubsidyLifecycle(r, $("#nsubsidy"));
  import("./authority-award.mjs").then(()=>loadAboAuthorityAward(r,$("#naboaward"))).then((released)=>{
    if(!released) externalAwardForNotice(r, $("#nexternal"));
  }).catch(()=>externalAwardForNotice(r, $("#nexternal")));
  Promise.allSettled([
    typeof loadPropertyPlainSummary === "function"
      ? loadPropertyPlainSummary(r, $("#nplain"))
      : Promise.resolve(),
    typeof loadPropertyCommercialDetail === "function"
      ? loadPropertyCommercialDetail(r, $("#ncommercial"))
      : Promise.resolve(),
    loadPropertyDispositionSpine(r, $("#ndisposition")),
    fillAddressLinks(r, $("#naddr")),
    loadPropertyCrossDomain(r, $("#npropertyxd")),
  ]).then(()=>{
    // Re-mount action rail once BBL / disposition stage / commercial bid steps are stamped.
    if(isPropertyDispositionEligible(r) && $("#nactions")) mountNoticeActionRail($("#nactions"), r);
    loadTaxLienForNotice(r,$("#ntaxlien"));
  });
  loadFranchiseConcessionSpine(r, $("#nfranchise"));
  loadNoticeLandSpine(r, $("#nland"));
  loadMeetingOutcomes(r, $("#nmeet"));
  priorCycleAwards(r, $("#nprior"));
  agencyForecastTeaser(r, $("#nforecast"));
  mountUnofficialTranslation($("#nxlate"), r);
  if(usablePin(r.pin)){ loadChain(r).then(chain=>{ if(chain.length>1) paintPaperTrail($("#nchain"), r, chain); }).catch(()=>{}); }
  focusItemRouteTarget(box.querySelector(".route-item"));
  applyActiveHistoryRouteScroll();
}

// Publish live bindings for neighboring modules and legacy inline handlers.
globalThis.DEEPLINK_BOROS = DEEPLINK_BOROS;
globalThis.DEEPLINK_CATEGORIES = DEEPLINK_CATEGORIES;
globalThis.DEEPLINK_LENSES = DEEPLINK_LENSES;
globalThis.NOTICE_SELECT = NOTICE_SELECT;
globalThis.applyActiveHistoryRouteScroll = applyActiveHistoryRouteScroll;
globalThis.applyHash = applyHash;
globalThis.bareCollectionHash = bareCollectionHash;
globalThis.commitPendingItemRouteContext = commitPendingItemRouteContext;
globalThis.copyText = copyText;
globalThis.currentRouteSnapshot = currentRouteSnapshot;
globalThis.deeplinkClampField = deeplinkClampField;
globalThis.focusItemRouteTarget = focusItemRouteTarget;
globalThis.forceAmountSelect = forceAmountSelect;
globalThis.forceSelect = forceSelect;
globalThis.isRestoringHistoryRouteScroll = isRestoringHistoryRouteScroll;
globalThis.itemRouteFallbackHash = itemRouteFallbackHash;
globalThis.landLink = landLink;
globalThis.loadTaskFirstBundle = loadTaskFirstBundle;
globalThis.normalizeHistoryPoint = normalizeHistoryPoint;
globalThis.noticeLink = noticeLink;
globalThis.parseLandHashSegment = parseLandHashSegment;
globalThis.parseNoticeHashSegment = parseNoticeHashSegment;
globalThis.parseWatchParam = parseWatchParam;
globalThis.prepareHistoryRouteScroll = prepareHistoryRouteScroll;
globalThis.pushHash = pushHash;
globalThis.rememberItemRouteContext = rememberItemRouteContext;
globalThis.restoreHistoryRouteScroll = restoreHistoryRouteScroll;
globalThis.routeBackHTML = routeBackHTML;
globalThis.routeFocusKey = routeFocusKey;
globalThis.routeBackLabel = routeBackLabel;
globalThis.routeBackViewName = routeBackViewName;
globalThis.routeHistoryEntry = routeHistoryEntry;
globalThis.routeHistoryState = routeHistoryState;
globalThis.routeReturnContext = routeReturnContext;
globalThis.safeHistoryHash = safeHistoryHash;
globalThis.sanitizeDeepLinkFilter = sanitizeDeepLinkFilter;
globalThis.scrollToLifecycleFocus = scrollToLifecycleFocus;
globalThis.serializeState = serializeState;
globalThis.showNotice = showNotice;
globalThis.showTaskFirst = showTaskFirst;
globalThis.taskBidAnswerHTML = taskBidAnswerHTML;
globalThis.taskCanIBidCardHTML = taskCanIBidCardHTML;
globalThis.taskCardHTML = taskCardHTML;
globalThis.taskEsc = taskEsc;
globalThis.taskPaymentLagHTML = taskPaymentLagHTML;
globalThis.taskWhatWillChangeCardHTML = taskWhatWillChangeCardHTML;
globalThis.updateHash = updateHash;
globalThis.syncNearYouLinks = syncNearYouLinks;
globalThis.watchChipsFor = watchChipsFor;
Object.defineProperty(globalThis, "activeHistoryRouteScroll", { configurable: true, get: () => activeHistoryRouteScroll, set: value => { activeHistoryRouteScroll = value; } });
Object.defineProperty(globalThis, "focusedItemRouteHash", { configurable: true, get: () => focusedItemRouteHash, set: value => { focusedItemRouteHash = value; } });
Object.defineProperty(globalThis, "hashLock", { configurable: true, get: () => hashLock, set: value => { hashLock = value; } });
Object.defineProperty(globalThis, "pendingHistoryRouteScroll", { configurable: true, get: () => pendingHistoryRouteScroll, set: value => { pendingHistoryRouteScroll = value; } });
Object.defineProperty(globalThis, "pendingItemRouteContext", { configurable: true, get: () => pendingItemRouteContext, set: value => { pendingItemRouteContext = value; } });
Object.defineProperty(globalThis, "pendingNoticeFocus", { configurable: true, get: () => pendingNoticeFocus, set: value => { pendingNoticeFocus = value; } });
Object.defineProperty(globalThis, "taskFirstBundle", { configurable: true, get: () => taskFirstBundle, set: value => { taskFirstBundle = value; } });
Object.defineProperty(globalThis, "taskFirstBundlePromise", { configurable: true, get: () => taskFirstBundlePromise, set: value => { taskFirstBundlePromise = value; } });
syncNearYouLinks();
