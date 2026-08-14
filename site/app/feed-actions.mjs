import {
  inferFranchiseStageFromNotice,
  isFranchiseConcessionNoticeEligible,
} from "../franchise_notice.mjs";
import { landProjectDisplayTitle, noticeDisplayTitle } from "../display_title.mjs";
import { agencyScopeLinksHTML } from "../agency_scope_links.mjs";
import { bindCardinalityAdaptiveFacets } from "../cardinality_adaptive_facets.mjs";
import { officialSourceLink } from "../affordance_grammar.mjs";
import { meetingOriginLabel } from "../meeting_origin.mjs";
import { communityBoardPageHref } from "../community_board_links.mjs";

/* ===================== FEED LENSES (Property / Rules / Meetings) ===================== */
const SECTIONS={
  property:{section:"Property Disposition", showAddr:true},
  rules:{section:"Agency Rules"},
  meetings:{section:"Public Hearings and Meetings", upcoming:true}
};
const feedRows={}, feedLoaded={}, feedVisible={};
const FEED_SELECT="request_id,start_date,event_date,agency_name,type_of_notice_description,section_name,short_title,building_name,street_address_1,street_address_2,city,state,zip_code,additional_description_1,additional_description_2,additional_description_3,other_info_1,other_info_2,other_info_3,printout_1,printout_2,printout_3";
function goodAddr(a){ return a && !/not listed|^n\/?a$|^none$|^various|^see /i.test(a.trim()); }
let propertyLocationToolsPromise=null;
function propertyLocationTools(){
  if(!propertyLocationToolsPromise) propertyLocationToolsPromise=import("../property_location.mjs");
  return propertyLocationToolsPromise;
}
let ruleLocationToolsPromise=null;
function ruleLocationTools(){
  if(!ruleLocationToolsPromise) ruleLocationToolsPromise=import("../rule_location.mjs");
  return ruleLocationToolsPromise;
}
let districtBagToolsPromise=null;
function districtBagTools(){
  if(!districtBagToolsPromise) districtBagToolsPromise=import("../map_exploration.mjs").catch(()=>null);
  return districtBagToolsPromise;
}
function feedDistrictFilter(key){
  if(key==="property") return {
    borough:globalThis.propertyBorough||null,
    communityDistrict:globalThis.propertyCommunityDistrict||null,
    councilDistrict:globalThis.propertyCouncilDistrict||null,
  };
  if(key==="meetings"){
    const place=$("#meetingsboro")?.value||"";
    const locationScope=["citywide-unlocated","citywide","virtual","unlocated"].includes(place)?place:null;
    return {
      borough:locationScope?null:(place||null),
      communityDistrict:meetingsCommunityDistrict||null,
      councilDistrict:meetingsCouncilDistrict||null,
      locationScope,
    };
  }
  return {};
}
function hasFeedDistrictFilter(filter){
  return !!(filter?.borough||filter?.communityDistrict||filter?.councilDistrict||filter?.locationScope);
}
async function filterFeedRowsToDistrictBag(key,rows){
  const filter=feedDistrictFilter(key);
  if(!hasFeedDistrictFilter(filter)) return rows;
  // The stamped district bag is a map read model, not the Meetings list's source
  // of truth. A borough-only list scope must match every current affected-area
  // record, including newly published and multi-borough hearings that have not
  // reached the next map build yet.
  if(key==="meetings" && (filter.borough || filter.locationScope)
    && !filter.communityDistrict && !filter.councilDistrict){
    return filterMeetingRowsByAffectedArea(rows, filter);
  }
  const tools=await districtBagTools();
  if(!tools?.materializeDistrictBagRowsFromFiles) return [];
  const materialized=await tools.materializeDistrictBagRowsFromFiles(key,rows,filter);
  return key==="meetings"?materialized.map(normalizeHearingRow):materialized;
}
// Precompute-first rule-lifecycle enrichment: the /rules read model (KV key
// rules:materialized:v2) joins City Record notices to NYC Rules official comment/adoption
// pages and classifies a lifecycle stage. We consume it here — no live upstream NYC Rules
// fetch from the client — and join to the live City Record rows by request_id.
let rulesViewPromise=null;
function loadRulesView(){
  if(rulesViewPromise) return rulesViewPromise;
  rulesViewPromise=workerFetch("/rules",{},12000).then(r=>r.ok?r.json():null).catch(()=>null);
  return rulesViewPromise;
}
// Map request_id -> lifecycle record (stage + nyc_rules links/dates). Covers matched
// notices (classified stage) and unmatched City Record notices (stage "proposed"); the
// NYC-Rules-only entries carry request_id:null and are skipped (they have no City Record
// row to enrich here).
function buildRulesStageMap(view){
  const m=new Map();
  if(!view || !Array.isArray(view.rules)) return m;
  for(const rec of view.rules){
    if(rec.request_id) m.set(rec.request_id, rec);
  }
  return m;
}

async function resolveFeedNeighborhood(key, query){
  return import("../neighborhood_search.mjs")
    .then(tools=>tools.resolveFeedNeighborhood(key,query))
    .catch(()=>null);
}

async function loadSection(key){
  if(key === "rules") await globalThis.ensureRules?.();
  const cfg=SECTIONS[key];
  const keepHash=hashLock;
  let kw=($("#"+key+"kw").value||"").trim();
  const resolvedNeighborhood=await resolveFeedNeighborhood(key, kw);
  if(resolvedNeighborhood) kw="";
  else if(key==="property" && kw){ propertyResolvedNeighborhood=null; propertyCommunityDistrict=""; }
  if(!keepHash || resolvedNeighborhood) updateHash();
  globalThis.syncAlertsEntryHrefs?.();
  renderSearchComponents(key);
  if(key==="meetings") return loadHearings();
  const whenSel=$("#"+key+"when");
  let where=`section_name='${cfg.section}'`, order="start_date DESC";
  const ag=key==="rules" ? (globalThis.rulesAgency || "") : ($("#"+key+"agency")?$("#"+key+"agency").value:"");
  if(ag) where+=` AND agency_name='${ag.replace(/'/g,"''")}'`;
  if(cfg.upcoming && (!whenSel || whenSel.value==="upcoming")){ where+=` AND event_date > '${todayISO()}'`; order="event_date ASC"; }
  // Property is a small section (~250 rows) whose value is the derived taxonomy — fetch wide, classify client-side.
  // Rules: wider window so multi-notice rulemaking collapse has siblings in-window.
  const p={"$select":FEED_SELECT,"$where":where,"$order":order,"$limit":key==="property"?"300":key==="rules"?"200":"40"};
  if(kw) p["$q"]=kw;
  busyList("#"+key+"feed", 3);
  const stale = staleGuard("feed:"+key);
  try{
    let rows=null;
    if(key==="property"){
      try{
        const response=await workerFetch("/property-locations",{},12000);
        if(response.ok){
          const payload=await response.json();
          if(Array.isArray(payload.disposition_spines)){
            propSpines=payload.disposition_spines;
          }
          if(Array.isArray(payload.properties)){
            rows=payload.properties.filter(row=>(!ag||row.agency_name===ag)
              && (!kw||matchText(row).toLowerCase().includes(kw.toLowerCase())));
          }
        }
      }catch(e){}
    }
    if(!rows) rows=await soda(p);
    if(stale()) return;
    unbusy("#"+key+"feed");
    if(key==="rules"){
      const tools=await ruleLocationTools();
      rows.forEach(row=>{
        const hearingArea=tools.isRuleHearing(row)
          ? normalizeHearingRow(row).affected_area : null;
        row._ruleLocation=tools.ruleLocationFromRow(row,{hearingArea});
      });
      // Attach precomputed lifecycle stage from the /rules read model (best-effort: a
      // stale/unreachable read model just leaves _ruleStage unset and no chip renders —
      // the row still shows as a City Record notice). Cache the full view for explorer
      // multi-notice stitch.
      try{
        const rulesView=await loadRulesView();
        rulesViewCache=rulesView;
        const stageMap=buildRulesStageMap(rulesView);
        rows.forEach(row=>{ const rec=stageMap.get(row.request_id); if(rec) row._ruleStage=rec; });
      }catch(e){ rulesViewCache=null; }
      if(stale()) return;
    }
    feedRows[key]={}; rows.forEach(r=>feedRows[key][r.request_id]=r);
    if(key==="property"){
      const tools=await propertyLocationTools();
      rows.forEach(r=>{ r._location=r.property_location||tools.propertyLocationFromRow(r); });
      rows=await filterFeedRowsToDistrictBag("property",rows);
      rows.forEach(r=>{ r._location=r.property_location||tools.propertyLocationFromRow(r); });
      if(stale()) return;
      propAll=rows; renderPropExplorer();
    } else if(key==="rules"){
      rulesAll=rows; renderRulesExplorer();
    }
    else { announce(t("notices_announce",{n:rows.length})); renderFeed(key, rows); }
  }catch(e){ if(!stale()){ unbusy("#"+key+"feed"); $("#"+key+"feed").innerHTML='<div class="empty">' + t("could_not_reach") + '</div>'; } }
}

let hearingAll=null;
const hearingPastCache=new Map();
let communityBoardMeetingsPromise=null;
function loadCommunityBoardMeetings(){
  if(communityBoardMeetingsPromise) return communityBoardMeetingsPromise;
  communityBoardMeetingsPromise=fetch("/data/community_board_meeting_index.json",{credentials:"omit"})
    .then(response=>response.ok?response.json():null)
    .then(index=>(Array.isArray(index?.rows)?index.rows:[]).map(normalizeHearingRow))
    .catch(()=>[]);
  return communityBoardMeetingsPromise;
}
let hearingRenderSeq=0;
let hearingWideningDismissed="";
let meetingsProcessSel="all";
let meetingsCommunityDistrict="", meetingsCouncilDistrict="";
// Place grouping is opt-in (default flat). Affected-area / near-me filters own place navigation.
let meetingsPlaceGroupSel="flat";
let meetingsExplorerToolsPromise=null;
function meetingsExplorerTools(){
  if(!meetingsExplorerToolsPromise){
    meetingsExplorerToolsPromise=import("../meetings_explorer.mjs").catch(()=>null);
  }
  return meetingsExplorerToolsPromise;
}
const MEETING_PHASE_IDS=["scheduled","agenda","held","outcomes"];
const MEETING_PHASE_LABEL_KEYS={
  scheduled:"meeting_stage_scheduled",
  agenda:"meeting_stage_agenda",
  held:"meeting_stage_held",
  outcomes:"meeting_stage_outcomes",
};
function meetingStageLabel(stage){
  if(!stage) return t("rule_sibling_role_notice");
  return t(MEETING_PHASE_LABEL_KEYS[stage]||"rule_sibling_role_notice");
}
function hearingWindowEnd(){
  return hearingDateWindowEnd(todayISO(), $("#meetingswhen").value);
}
function hearingFilter(){
  const place=$("#meetingsboro").value;
  const scopePlaces=new Set(["citywide-unlocated","citywide","virtual","unlocated"]);
  return {
    borough: place && !scopePlaces.has(place) ? place : null,
    locationScope: scopePlaces.has(place) ? place : null,
    neighborhood: $("#meetingsneighborhood").value.trim() || null,
  };
}
function hearingEventRow(record){
  return {
    request_id:record.request_id,
    start_date:record.published_at,
    event_date:record.event_date,
    agency_name:record.agency,
    type_of_notice_description:record.notice_type,
    section_name:record.source_section,
    short_title:record.title,
    street_address_1:record.venue&&record.venue.address,
    additional_description_1:record.description,
    venue:record.venue||null,
    participation:record.participation||null,
    source_url:record.source_url||null,
  };
}
function hearingViewFilter(){
  return {
    when:$("#meetingswhen").value,
    agency:$("#meetingsagency").value,
    keyword:$("#meetingskw").value.trim(),
    ...hearingFilter(),
  };
}
function renderMeetingsAgencyScope(records){
  const rail=$("#meetings-agency-scope");
  if(!rail) return;
  const searchQuery=rail.querySelector(".facet-typeahead-input")?.value||"";
  const selected=$("#meetingsagency")?.value||"";
  const names=[...new Set((records||[]).map(record=>record?.agency).filter(Boolean).concat(selected||[]))].sort((a,b)=>String(a).localeCompare(String(b)));
  const current=location.hash.startsWith("#meetings")
    ? location.hash
    : (globalThis.serializeState?.()||"#meetings");
  rail.innerHTML=agencyScopeLinksHTML({
    surface:"meetings",
    agencies:names,
    selected,
    currentHash:current,
    t,
    searchQuery,
    escape:escUiHtml,
  });
  bindCardinalityAdaptiveFacets(rail);
}
function hearingFilterKey(filter){
  return JSON.stringify([
    filter.when, filter.agency, filter.keyword, filter.borough,
    filter.locationScope, filter.neighborhood,
  ]);
}
function hearingWidenedShown(scope){
  const key=scope==="month"?"meetings_shown_month":scope==="past"?"meetings_shown_past":"meetings_shown_upcoming";
  return t(key);
}
function hearingWidenedNone(selection){
  const scope=selection.scope==="past"?"upcoming":selection.requested;
  const key=scope==="week"?"meetings_none_week":scope==="month"?"meetings_none_month":"meetings_none_upcoming";
  return t(key);
}
function hearingWideningHTML(selection, filter){
  if(!selection.widened) return "";
  const query=filter.keyword ? `“${escUiHtml(filter.keyword)}”` : t("this_search");
  return `<div class="note widening-note" role="status"><span>${t("meetings_widened_notice",{
    query,
    shown:hearingWidenedShown(selection.scope),
    none:hearingWidenedNone(selection),
  })}</span><button type="button" class="mini" data-remove-widening>${t("show_exact_search")}</button></div>`;
}
function hearingCommunityBoardDisambiguationHTML(filter){
  const query=typeof hearingCommunityBoardQuery==="function"
    ? hearingCommunityBoardQuery(filter.keyword)
    : null;
  if(!query?.ambiguous) return "";
  const boards=[
    ["Bronx","bronx"],["Brooklyn","brooklyn"],["Manhattan","manhattan"],
    ["Queens","queens"],["Staten Island","staten-island"],
  ];
  const links=boards.map(([borough,slug])=>{
    const id=slug+"-cb-"+String(query.number).padStart(2,"0");
    const label=escUiHtml(borough+" Community Board "+query.number);
    return "<li><a href=\"/browse/people/?board="+encodeURIComponent(id)+"#community-boards\">"+label+"</a></li>";
  }).join("");
  return "<div class=\"note meetings-board-disambiguation\" role=\"status\" data-community-board-disambiguation>"
    +"<p><strong>"+escUiHtml(t("meetings_board_disambiguation_heading",{number:query.number}))+
    "</strong> "+escUiHtml(t("meetings_board_disambiguation_copy",{number:query.number}))+
    "</p><ul>"+links+"</ul></div>";
}
function hearingCommunityBoardPivotHTML(){
  return "<p class=\"meetings-board-institution-pivot\"><a href=\"/browse/people/#community-boards\">"+
    escUiHtml(t("meetings_board_institution_pivot"))+"</a></p>";
}
async function loadPastHearings(filter){
  const cacheKey=JSON.stringify([filter.agency,filter.keyword]);
  if(hearingPastCache.has(cacheKey)) return hearingPastCache.get(cacheKey);
  let where=`(section_name='Public Hearings and Meetings' OR (section_name='Agency Rules' AND type_of_notice_description='Public Hearings' AND event_date IS NOT NULL)) AND event_date < '${todayISO()}'`;
  if(filter.agency) where+=` AND agency_name='${filter.agency.replace(/'/g,"''")}'`;
  const params={"$select":FEED_SELECT,"$where":where,"$order":"event_date DESC","$limit":"500"};
  if(filter.keyword) params["$q"]=filter.keyword;
  const rows=await soda(params);
  const records=rows.map(normalizeHearingRow);
  hearingPastCache.set(cacheKey,records);
  return records;
}
function hearingSafeURL(value){
  try{ const url=new URL(value); return url.protocol==="https:"||url.protocol==="http:" ? url.toString() : null; }
  catch(e){ return null; }
}
// Shared list+detail participation actions. Derives from normalizeHearingRow.participation
// (one-owner): meetings cards and the notice permalink use the same links/labels.
// Cap is one outbound affordance — duplicates were a body-regex trailing-comma bug.
function participationLinksHTML(record){
  const links=((record&&record.participation&&record.participation.links)||[])
    .map(link=>({
      url:hearingSafeURL(link.url),
      label:String(link.label||""),
      join:/\bjoin\b/i.test(link.label||""),
      ida:/ida meetings/i.test(link.label||""),
    }))
    .filter(link=>link.url)
    .slice(0,1);
  return links.map(link=>{
    const key=link.join?"join_online":(link.ida?"ida_meetings_page":"participation_link");
    return `<a class="act" href="${escUiHtml(link.url)}" ${EXT_ATTRS}>${t(key)}${extSR()}</a>`;
  }).join("");
}
function noticeActionMatter(r, ruleRecord, lifecycleData){
  const hearing=r.hearing||isMeetingOutcomesEligible(r)&&normalizeHearingRow(r);
  const participation=((hearing&&hearing.participation&&hearing.participation.links)||[])
    .map(link=>hearingSafeURL(link.url)).find(Boolean)||null;
  const zapParticipation=participation&&/^https:\/\/zap\.planning\.nyc\.gov\//i.test(participation);
  const rule=ruleRecord&&ruleRecord.nyc_rules;
  const rolling=!!(r.due_date&&isRollingDeadline(r.due_date));
  const isProperty=r.section_name==="Property Disposition";
  const isFranchise=isFranchiseConcessionNoticeEligible(r);
  const franchiseStage=isFranchise?(r.franchise_stage||inferFranchiseStageFromNotice(r)||null):null;
  const noticeType=r.type_of_notice_description||"";
  // Franchise/FCRC eligible notices use the stage-tied franchise rail (solicitation →
  // hearing → committee → award). Prefer that over generic solicitation/hearing/award.
  let kind=r.section_name==="Agency Rules"?"rule"
    :isProperty?"property"
    :isFranchise?"franchise"
    :zapParticipation?"zoning"
    :isMeetingOutcomesEligible(r)?"hearing"
    :noticeType==="Solicitation"?"solicitation"
    // Award + selection intermediates (Intent to Award matches /Award/; Negotiate/Vendor List do not).
    :/Award|Intent to Negotiate|Vendor List/i.test(noticeType)?"award":"notice";
  // Full ingested body for hearing participation steps (testimony, contact, venue prose).
  const noticeBody=[
    r.additional_description_1,r.additional_description_2,r.additional_description_3,
    r.other_info_1,r.other_info_2,r.other_info_3,
    r.printout_1,r.printout_2,r.printout_3,
  ].filter(Boolean).join(" ");
  const propBbl=isProperty?(r._property_bbl||r.primary_bbl||null):null;
  // Lifecycle stages for the award action rail (vendor / registration / spending).
  const timeline=lifecycleData&&Array.isArray(lifecycleData.timeline)?lifecycleData.timeline:[];
  const stageOf=name=>timeline.find(e=>e&&e.stage===name)||null;
  const franchiseHearingStage=franchiseStage==="public_hearing"||franchiseStage==="committee_meeting";
  return {
    kind,
    section_name:r.section_name,
    type_of_notice_description:r.type_of_notice_description,
    lifecycle_stage:kind==="rule"?(ruleDisplayStage(ruleRecord)||"proposed")
      :kind==="hearing"&&(r.event_date&&String(r.event_date).slice(0,10)<todayISO())?"past"
      :kind==="property"?(r.disposition_stage||null)
      :kind==="franchise"?franchiseStage:null,
    disposition_stage:kind==="property"?(r.disposition_stage||null):null,
    franchise_stage:kind==="franchise"?franchiseStage:null,
    deadline:kind==="rule"?(
      // Prefer open comment deadline; hearing-stage calendar uses hearing_date when comment is closed.
      (rule&&rule.comment_by_date)
      || (rule&&rule.hearing_date)
      || r.event_date
      || null
    )
      :kind==="hearing"?r.event_date
      :kind==="property"?r.event_date||null
      :kind==="franchise"?(franchiseHearingStage?r.event_date:rolling?null:r.due_date||r.event_date||null)
      :rolling?null:r.due_date||null,
    event_date:r.event_date||null,
    // NYC Rules RSS fields for concrete comment + hearing rail steps.
    comment_by_date:rule&&rule.comment_by_date||null,
    hearing_date:rule&&rule.hearing_date||null,
    summary:rule&&rule.summary||null,
    rolling_deadline:rolling,
    official_notice_url:kind==="rule"?(rule&&rule.url||REQ_URL(r.request_id)):REQ_URL(r.request_id),
    request_id:r.request_id||null,
    agency_name:r.agency_name,
    pin:r.pin,
    // City Record award fields (also used before lifecycle hydrates).
    vendor_name:r.vendor_name||null,
    contract_amount:r.contract_amount!=null&&r.contract_amount!==""?Number(r.contract_amount):null,
    title:cleanText(r.short_title),
    notice_text:noticeBody||[r.additional_description_1,r.other_info_1,r.additional_description_2].filter(Boolean).join(" "),
    // Structured response fields from the City Record row — used to build concrete steps
    // instead of deferring to “read the official notice.”
    email:r.email||null,
    contact_name:r.contact_name||null,
    contact_phone:r.contact_phone||null,
    address_to_request:r.address_to_request||null,
    selection_method:r.selection_method_description||null,
    // lifecycle_loaded false on first paint so PASSPort handoff stays pending (never
    // "could not match") until /contract-lifecycle repaints with a resolved rfx_detail.
    lifecycle_loaded:!!lifecycleData,
    rfx_detail:lifecycleData?lifecycleData.rfx_detail??null:null,
    // Award rail: Checkbook registration/payment + OCP side-car already on /contract-lifecycle.
    lifecycle_pin:lifecycleData&&lifecycleData.pin||null,
    registration:stageOf("registered"),
    payment:stageOf("payment"),
    pending:stageOf("pending"),
    award_stage:stageOf("award")||stageOf("intent_to_award"),
    ocp_award:lifecycleData&&lifecycleData.ocp_award||null,
    comment_url:rule&&(rule.comment_url||rule.url),
    participation_url:participation,
    // Hearing venue + participation (from hearing_location.js) for step extraction.
    // Agency Rules Public Hearings also normalize so rule rails can attend/testify.
    venue:hearing&&hearing.venue||null,
    participation:hearing&&hearing.participation||null,
    building_name:r.building_name||null,
    street_address_1:r.street_address_1||null,
    street_address_2:r.street_address_2||null,
    city:r.city||null,
    state:r.state||null,
    zip_code:r.zip_code||null,
    project_url:zapParticipation?participation:null,
    bbl:propBbl,
    owner_name:r._property_owner||null,
    // Surplus-buyer commercial payload (item / price / bid steps) when extracted.
    commercial:isProperty?(r.commercial||null):null,
    // Deterministic source spans grouped into the existing action rail guide.
    reader_actions:r.property_reader_actions||null,
    // T0/T1 attachment inventory (GetFile DocumentID) — package handoff when body has none.
    attachments:Array.isArray(r.attachments)?r.attachments:null,
    package_url:(()=>{
      if(r.package_url) return r.package_url;
      if(window.CrolActions&&typeof CrolActions.packageUrlFromAttachments==="function"){
        return CrolActions.packageUrlFromAttachments(r.attachments)||null;
      }
      return null;
    })(),
  };
}
function actionRailLabel(action){
  const vars=Object.assign(
    {},
    action.deadline?{date:fdt(action.deadline)}:{},
    action.label_vars&&typeof action.label_vars==="object"?action.label_vars:{}
  );
  // Registered date is an ISO day — format when present.
  if(vars.date&&/^\d{4}-\d{2}-\d{2}/.test(String(vars.date))) vars.date=fdate(vars.date)||vars.date;
  return t(action.label_key,vars);
}
function actionRailGuideHTML(actions){
  const action=actions.find(item=>item.guide);
  const guide=action&&action.guide;
  if(!guide) return "";
  const factSeen = new Set();
  const fact = (key, row) => {
    if(!row) return "";
    factSeen.add(key);
    return row;
  };
  const step = (value, key) => (key && factSeen.has(key) ? "" : value);
  const copyFact=(label,value)=>value?`<dt>${label}</dt><dd><code>${escUiHtml(value)}</code><button type="button" class="bid-guide-copy" data-copy-value="${escUiHtml(value)}">${t("copy_value")}</button></dd>`:"";
  const plainFact=(label,value)=>value?`<dt>${label}</dt><dd>${value}</dd>`:"";
  const hostOf=url=>{ try{ return new URL(url).hostname; }catch(e){ return url; } };
  // When an identifier has an outbound URL (City Record notice, public RFx browse, …),
  // wrap the code value — copy button still works on the raw id.
  const idValue=guide.identifier?(guide.identifier_url
    ?`<a href="${escUiHtml(guide.identifier_url)}" ${EXT_ATTRS}><code>${escUiHtml(guide.identifier)}</code>${extSR()}</a>`
    :`<code>${escUiHtml(guide.identifier)}</code>`):"";
  let facts="";
  let steps=[];
  let guideExtra="";
  let headingKey="bid_guide_heading";
  if(typeof guide.render_steps==="function"){
    headingKey=guide.heading_key||headingKey;
    steps=guide.render_steps(guide.actions,{t,escape:escUiHtml,formatDate:fdt,extAttrs:EXT_ATTRS,extSr:extSR});
  }
  else if(guide.system==="hearing_extracted"){
    // Attend / testify / contact — fields only when the notice published them.
    headingKey="hearing_guide_heading";
    const when=guide.event_date||action.deadline;
    const whereBits=[guide.venue_building,guide.venue_address].filter(Boolean);
    const where=whereBits.map(escUiHtml).join(" · ");
    facts=[
      when?fact("hearing_when",`<dt>${t("hearing_guide_when_label")}</dt><dd>${fdt(when)}</dd>`):"",
      where?fact("hearing_where",`<dt>${t("venue_label")}</dt><dd>${where}</dd>`):"",
      guide.testimony_email?fact("hearing_testimony",`<dt>${t("hearing_guide_testimony_label")}</dt><dd><a href="mailto:${escUiHtml(guide.testimony_email)}">${escUiHtml(guide.testimony_email)}</a></dd>`):"",
      (()=>{
        const bits=[];
        if(guide.contact_name) bits.push(escUiHtml(guide.contact_name));
        if(guide.email && (!guide.testimony_email || String(guide.email).toLowerCase()!==String(guide.testimony_email).toLowerCase())){
          bits.push(`<a href="mailto:${escUiHtml(guide.email)}">${escUiHtml(guide.email)}</a>`);
        }
        if(guide.contact_phone) bits.push(escUiHtml(guide.contact_phone));
        return bits.length?fact("hearing_contact",`<dt>${t("apply_contact_lbl")}</dt><dd>${bits.join(" · ")}</dd>`):"";
      })(),
    ].join("");
    if(when && where) steps.push(step(t("hearing_guide_attend_step",{date:fdt(when),where}),"hearing_when"));
    else if(when) steps.push(step(t("hearing_guide_attend_date_step",{date:fdt(when)}),"hearing_when"));
    else if(where) steps.push(step(t("hearing_guide_attend_where_step",{where}),"hearing_where"));
    if(guide.participation_url){
      const host=escUiHtml(hostOf(guide.participation_url));
      steps.push(step(guide.join_kind==="join"
        ? t("hearing_guide_join_step_html",{url:escUiHtml(guide.participation_url),host})
        : t("hearing_guide_materials_step_html",{url:escUiHtml(guide.participation_url),host}),"hearing_participation"));
    }
    if(guide.testimony_signup_url){
      const url=escUiHtml(guide.testimony_signup_url);
      const host=escUiHtml(hostOf(guide.testimony_signup_url));
      steps.push(t("hearing_guide_signup_step_html",{url,host}));
    }
    if(guide.testimony_email){
      const email=escUiHtml(guide.testimony_email);
      if(guide.testimony_until&&guide.testimony_until.kind==="datetime"&&guide.testimony_until.label){
        steps.push(step(t("hearing_guide_testimony_until_date_step_html",{email,date:escUiHtml(guide.testimony_until.label)}),"hearing_testimony_deadline"));
      }else if(guide.testimony_until&&guide.testimony_until.kind==="hearing_close"){
        steps.push(step(t("hearing_guide_testimony_until_close_step_html",{email}),"hearing_testimony_deadline"));
      }else{
        steps.push(step(t("hearing_guide_testimony_step_html",{email}),"hearing_testimony_method"));
      }
    }
    if(guide.contact_name || guide.email || guide.contact_phone){
      const who=[guide.contact_name, guide.email, guide.contact_phone].filter(Boolean).map(escUiHtml).join(" · ");
      steps.push(step(t("hearing_guide_contact_step_html",{who}),"hearing_contact"));
    }
    if(!steps.length) steps.push(t("hearing_guide_fallback_step"));
    if(guide.testimony_starter){
      const starter=guide.testimony_starter;
      const spanish=(window.LANG||"en")==="es";
      const blocks=spanish
        ? [
            {lang:"es",label:"Texto inicial en español — edítelo",value:starter.es},
            {lang:"en",label:"English starter — edit it",value:starter.en},
          ]
        : [{lang:"en",label:"Starter paragraph — edit it",value:starter.en}];
      guideExtra=`<div class="hearing-testify-starter" data-spanish-first="${spanish?"true":"false"}">${blocks.map(block=>
        `<div class="hearing-testify-copy" lang="${block.lang}"><b>${block.label}</b><p>${escUiHtml(block.value)}</p><button type="button" class="bid-guide-copy" data-copy-value="${escUiHtml(block.value)}">${t("copy_value")}</button></div>`
      ).join("")}</div>`;
    }
  }
  else if(guide.system==="rules_extracted"){
    // Comment-open + hearing-day: deadline, how-to-comment, attend/testify — only published fields.
    headingKey="rule_guide_heading";
    const commentWhen=guide.comment_deadline||(guide.comment_open?action.deadline:null);
    const hearingWhen=guide.hearing_date;
    const whereBits=[guide.venue_building,guide.venue_address].filter(Boolean);
    const where=whereBits.map(escUiHtml).join(" · ");
    facts=[
      commentWhen?fact("rule_deadline",`<dt>${t("rule_guide_deadline_label")}</dt><dd>${fdt(commentWhen)}</dd>`):"",
      hearingWhen?fact("rule_hearing",`<dt>${t("rule_guide_hearing_label")}</dt><dd>${fdt(hearingWhen)}</dd>`):"",
      where?fact("rule_where",`<dt>${t("venue_label")}</dt><dd>${where}</dd>`):"",
      guide.testimony_email?fact("rule_testimony",`<dt>${t("hearing_guide_testimony_label")}</dt><dd><a href="mailto:${escUiHtml(guide.testimony_email)}">${escUiHtml(guide.testimony_email)}</a></dd>`):"",
      (()=>{
        const bits=[];
        if(guide.contact_name) bits.push(escUiHtml(guide.contact_name));
        if(guide.email && (!guide.testimony_email || String(guide.email).toLowerCase()!==String(guide.testimony_email).toLowerCase())){
          bits.push(`<a href="mailto:${escUiHtml(guide.email)}">${escUiHtml(guide.email)}</a>`);
        }
        if(guide.contact_phone) bits.push(escUiHtml(guide.contact_phone));
        return bits.length?fact("rule_contact",`<dt>${t("apply_contact_lbl")}</dt><dd>${bits.join(" · ")}</dd>`):"";
      })(),
    ].join("");
    if(commentWhen) steps.push(step(t("rule_guide_comment_by_step",{date:fdt(commentWhen)}), "rule_deadline"));
    if(guide.comment_url){
      const host=escUiHtml(hostOf(guide.comment_url));
      steps.push(step(t("rule_guide_comment_portal_step_html",{url:escUiHtml(guide.comment_url),host}),"rule_comment_portal"));
    }else if(guide.testimony_email || (guide.email && guide.comment_open)){
      const email=escUiHtml(guide.testimony_email||guide.email);
      steps.push(step(t("rule_guide_comment_email_step_html",{email}),"rule_testimony"));
    }else if(guide.rule_url && guide.comment_open){
      const host=escUiHtml(hostOf(guide.rule_url));
      steps.push(step(t("rule_guide_comment_rule_page_step_html",{url:escUiHtml(guide.rule_url),host}),"rule_rule_page"));
    }
    if(hearingWhen && where) steps.push(step(t("rule_guide_attend_step",{date:fdt(hearingWhen),where}),"rule_hearing"));
    else if(hearingWhen) steps.push(step(t("rule_guide_attend_date_step",{date:fdt(hearingWhen)}),"rule_hearing"));
    else if(where && guide.hearing_upcoming) steps.push(step(t("rule_guide_attend_where_step",{where}),"rule_where"));
    if(guide.participation_url){
      const host=escUiHtml(hostOf(guide.participation_url));
      steps.push(step(guide.join_kind==="join"
        ? t("rule_guide_join_step_html",{url:escUiHtml(guide.participation_url),host})
        : t("rule_guide_materials_step_html",{url:escUiHtml(guide.participation_url),host}),"rule_participation"));
    }
    // Testimony for a hearing is distinct from the comment-email how-to step above when both exist.
    if(guide.testimony_email && hearingWhen){
      const email=escUiHtml(guide.testimony_email);
      if(guide.testimony_until&&guide.testimony_until.kind==="datetime"&&guide.testimony_until.label){
        steps.push(step(t("rule_guide_testimony_until_date_step_html",{email,date:escUiHtml(guide.testimony_until.label)}),"rule_testimony"));
      }else if(guide.testimony_until&&guide.testimony_until.kind==="hearing_close"){
        steps.push(step(t("rule_guide_testimony_until_close_step_html",{email}),"rule_testimony"));
      }else if(!guide.comment_open || guide.comment_url){
        // Avoid duplicating the how-to-comment email step when that was the only email path.
        steps.push(step(t("rule_guide_testimony_step_html",{email}),"rule_testimony"));
      }
    }
    if(guide.contact_name || (guide.email && guide.email!==guide.testimony_email) || guide.contact_phone){
      const who=[guide.contact_name,
        (guide.email && guide.email!==guide.testimony_email)?guide.email:null,
        guide.contact_phone].filter(Boolean).map(escUiHtml).join(" · ");
      if(who) steps.push(step(t("rule_guide_contact_step_html",{who}),"rule_contact"));
    }
    if(!steps.length) steps.push(t("rule_guide_fallback_step"));
  }
  else if(guide.system==="zoning_extracted"){
    // Land / ULURP: phase context + next hearing participation (only fields the city published).
    headingKey="land_guide_heading";
    const when=guide.event_date||action.deadline;
    const whereBits=[guide.venue_building,guide.venue_address].filter(Boolean);
    const where=whereBits.map(escUiHtml).join(" · ");
    const phaseName=guide.phase_label
      ? escUiHtml(guide.phase_label)
      : (guide.phase_id ? escUiHtml(landPhaseLabel(guide.phase_id)) : "");
    facts=[
      phaseName?fact("land_phase",`<dt>${t("land_guide_phase_label")}</dt><dd>${phaseName}</dd>`):"",
      guide.public_status?fact("land_status",`<dt>${t("land_guide_status_label")}</dt><dd><b>${escUiHtml(guide.public_status)}</b></dd>`):"",
      when?fact("land_hearing",`<dt>${t("land_guide_hearing_label")}</dt><dd>${fdt(when)}${guide.next_hearing&&guide.next_hearing.agency?` · ${escUiHtml(guide.next_hearing.agency)}`:""}</dd>`):"",
      where?fact("land_where",`<dt>${t("venue_label")}</dt><dd>${where}</dd>`):"",
      guide.testimony_email?fact("land_testimony",`<dt>${t("land_guide_testimony_label")}</dt><dd><a href="mailto:${escUiHtml(guide.testimony_email)}">${escUiHtml(guide.testimony_email)}</a></dd>`):"",
      (()=>{
        const bits=[];
        if(guide.contact_name) bits.push(escUiHtml(guide.contact_name));
        if(guide.email && (!guide.testimony_email || String(guide.email).toLowerCase()!==String(guide.testimony_email).toLowerCase())){
          bits.push(`<a href="mailto:${escUiHtml(guide.email)}">${escUiHtml(guide.email)}</a>`);
        }
        if(guide.contact_phone) bits.push(escUiHtml(guide.contact_phone));
        return bits.length?fact("land_contact",`<dt>${t("apply_contact_lbl")}</dt><dd>${bits.join(" · ")}</dd>`):"";
      })(),
    ].join("");
    if(guide.mode==="closed"){
      steps.push(t("land_guide_closed_step"));
    }else if(guide.mode==="pre_review"){
      steps.push(step(phaseName
        ? t("land_guide_pre_review_phase_step",{phase:phaseName})
        : t("land_guide_pre_review_step"),"land_phase"));
    }else if(phaseName){
      steps.push(step(t("land_guide_phase_step",{phase:phaseName}),"land_phase"));
    }
    if(when && where) steps.push(step(t("land_guide_attend_step",{date:fdt(when),where}),"land_hearing"));
    else if(when) steps.push(step(t("land_guide_attend_date_step",{date:fdt(when)}),"land_hearing"));
    else if(where) steps.push(step(t("land_guide_attend_where_step",{where}),"land_where"));
    // Maps-friendly in-person deep link when ZAP disposition logistics published an address.
    if(guide.maps_url && guide.venue_address){
      steps.push(step(t("land_guide_attend_maps_step_html",{
        address:escUiHtml(guide.venue_address),
        url:escUiHtml(guide.maps_url),
      }),"land_maps"));
    }
    const liveUrl=guide.livestream_url
      || (guide.join_kind==="livestream"?guide.participation_url:null);
    if(liveUrl){
      const host=escUiHtml(hostOf(liveUrl));
      steps.push(step(t("land_guide_watch_live_step_html",{url:escUiHtml(liveUrl),host}),"land_livestream"));
    }else if(guide.participation_url){
      const host=escUiHtml(hostOf(guide.participation_url));
      steps.push(step(guide.join_kind==="join"
        ? t("land_guide_join_step_html",{url:escUiHtml(guide.participation_url),host})
        : t("land_guide_materials_step_html",{url:escUiHtml(guide.participation_url),host}),"land_participation"));
    }
    // When free-text logistics could not be fully parsed, show the raw publisher string.
    if(guide.hearing_location_raw && !guide.venue_address && !liveUrl){
      steps.push(step(t("land_guide_hearing_location_raw_step",{
        text:escUiHtml(guide.hearing_location_raw),
      }),"land_hearing_raw"));
    }
    if(guide.testimony_email){
      const email=escUiHtml(guide.testimony_email);
      if(guide.testimony_until&&guide.testimony_until.kind==="datetime"&&guide.testimony_until.label){
        steps.push(step(t("land_guide_testimony_until_date_step_html",{email,date:escUiHtml(guide.testimony_until.label)}),"land_testimony"));
      }else if(guide.testimony_until&&guide.testimony_until.kind==="hearing_close"){
        steps.push(step(t("land_guide_testimony_until_close_step_html",{email}),"land_testimony"));
      }else{
        steps.push(step(t("land_guide_testimony_step_html",{email}),"land_testimony"));
      }
    }
    if(guide.contact_name || guide.email || guide.contact_phone){
      const who=[guide.contact_name, guide.email, guide.contact_phone].filter(Boolean).map(escUiHtml).join(" · ");
      steps.push(step(t("land_guide_contact_step_html",{who}),"land_contact"));
    }
    if(guide.project_url && guide.mode==="public_review"){
      const host=escUiHtml(hostOf(guide.project_url));
      steps.push(step(t("land_guide_zap_comment_step_html",{url:escUiHtml(guide.project_url),host}),"land_project"));
    }else if(guide.project_url && guide.mode!=="closed"){
      const host=escUiHtml(hostOf(guide.project_url));
      steps.push(step(t("land_guide_zap_project_step_html",{url:escUiHtml(guide.project_url),host}),"land_project"));
    }
    if(guide.official_notice_url && !guide.participation_url){
      const host=escUiHtml(hostOf(guide.official_notice_url));
      steps.push(step(t("land_guide_notice_step_html",{url:escUiHtml(guide.official_notice_url),host}),"land_notice"));
    }
    // Additional upcoming hearings (CB/BP/CPC/Council) beyond the primary.
    (guide.hearings||[]).slice(0,4).forEach(h=>{
      if(!h||!h.event_date||h.past) return;
      if(guide.next_hearing&&h.request_id&&guide.next_hearing.request_id===h.request_id) return;
      if(guide.next_hearing&&!h.request_id&&h.event_date===guide.next_hearing.event_date) return;
      const body=h.body_kind?landPhaseLabel(h.body_kind):escUiHtml(h.agency||h.title||"");
      if(body) steps.push(step(t("land_guide_other_hearing_step",{body:escUiHtml(body),date:fdt(h.event_date)}),"land_other_hearing"));
    });
    if(!steps.length) steps.push(t("land_guide_fallback_step"));
  }else if(guide.system==="award_lifecycle"){
    // Award / selection: vendor, amount, registration, spending — only published fields.
    // Never a "submit a bid" step (solicitation is over for Award and selection intermediates).
    headingKey=guide.mode==="selection"?"award_guide_selection_heading":"award_guide_heading";
    const regDate=guide.registration_date?fdate(guide.registration_date):null;
    facts=[
      guide.vendor?fact("award_vendor",`<dt>${t("award_guide_vendor_label")}</dt><dd lang="en" dir="ltr"><b>${globalThis.v?.(guide.vendor)||escUiHtml(guide.vendor)}</b></dd>`):"",
      guide.amount?fact("award_amount",`<dt>${t("award_guide_amount_label")}</dt><dd><b>${escUiHtml(guide.amount)}</b></dd>`):"",
      regDate?fact("award_registered",`<dt>${t("award_guide_registered_label")}</dt><dd>${escUiHtml(regDate)}</dd>`):"",
      guide.pending_registration&&!guide.registered
        ?fact("award_pending",`<dt>${t("award_guide_pending_label")}</dt><dd>${t("award_guide_pending_status")}</dd>`):"",
      guide.spent?fact("award_spent",`<dt>${t("award_guide_spent_label")}</dt><dd><b>${escUiHtml(guide.spent)}</b></dd>`):"",
      guide.contract_id?fact("award_contract",`<dt>${t("award_guide_contract_label")}</dt><dd><code>${escUiHtml(guide.contract_id)}</code><button type="button" class="bid-guide-copy" data-copy-value="${escUiHtml(guide.contract_id)}">${t("copy_value")}</button></dd>`):"",
      guide.pin?fact("award_pin",`<dt>${t("award_guide_pin_label")}</dt><dd><code>${escUiHtml(guide.pin)}</code><button type="button" class="bid-guide-copy" data-copy-value="${escUiHtml(guide.pin)}">${t("copy_value")}</button></dd>`):"",
    ].join("");
    if(guide.mode==="selection"){
      if(guide.selection_phase==="intent_to_award") steps.push(t("award_guide_selection_intent_award_step"));
      else if(guide.selection_phase==="intent_to_negotiate") steps.push(t("award_guide_selection_intent_negotiate_step"));
      else if(guide.selection_phase==="vendor_list") steps.push(t("award_guide_selection_vendor_list_step"));
      else steps.push(t("award_guide_selection_intent_award_step"));
      if(guide.vendor) steps.push(step(t("award_guide_vendor_step",{vendor:globalThis.v?.(guide.vendor)||escUiHtml(guide.vendor)}),"award_vendor"));
      if(guide.amount) steps.push(step(t("award_guide_amount_step",{amount:escUiHtml(guide.amount)}),"award_amount"));
      steps.push(step(t("award_guide_no_bid_step"),"award_no_bid"));
      steps.push(t("award_guide_selection_watch_step"));
    }else{
      if(guide.vendor) steps.push(step(t("award_guide_vendor_step",{vendor:globalThis.v?.(guide.vendor)||escUiHtml(guide.vendor)}),"award_vendor"));
      if(guide.amount) steps.push(step(t("award_guide_amount_step",{amount:escUiHtml(guide.amount)}),"award_amount"));
      if(guide.registered&&regDate) steps.push(step(t("award_guide_registered_step",{date:escUiHtml(regDate)}),"award_registered"));
      else if(guide.pending_registration) steps.push(t("award_guide_pending_step"));
      if(guide.spent) steps.push(step(t("award_guide_spent_step",{amount:escUiHtml(guide.spent)}),"award_spent"));
      steps.push(step(t("award_guide_no_bid_step"),"award_no_bid"));
    }
    if(guide.checkbook_url){
      const host=escUiHtml(hostOf(guide.checkbook_url));
      steps.push(step(t("award_guide_checkbook_step_html",{url:escUiHtml(guide.checkbook_url),host}),"award_checkbook"));
    }
    if(!steps.length) steps.push(t("award_guide_fallback_step"));
  }else if(guide.system==="parcel_lookup"){
    if(guide.bbl) steps.push(step(t("property_guide_bbl_step",{bbl:escUiHtml(guide.bbl)}),"property_bbl"));
    if(guide.zola_url) steps.push(step(t("property_guide_zola_step_html",{url:escUiHtml(guide.zola_url)}),"property_zola"));
    if(guide.acris_url) steps.push(step(t("property_guide_acris_step_html",{url:escUiHtml(guide.acris_url)}),"property_acris"));
    if(guide.who_owns_what_url) steps.push(step(t("property_guide_wow_step_html",{url:escUiHtml(guide.who_owns_what_url)}),"property_wow"));
    if(guide.owner_name) steps.push(step(t("property_guide_owner_step",{name:escUiHtml(guide.owner_name)}),"property_owner"));
    if(guide.email || guide.contact_name || guide.contact_phone){
      const who=[guide.contact_name, guide.email, guide.contact_phone].filter(Boolean).map(escUiHtml).join(" · ");
      steps.push(step(t("bid_guide_notice_contact_step_html",{who}),"property_contact"));
    }
    if(!steps.length) steps.push(t("property_guide_fallback_step"));
  }else{
    facts=[
      guide.identifier?fact("guide_identifier",`<dt>${t("bid_guide_id_label")}</dt><dd>${idValue}<button type="button" class="bid-guide-copy" data-copy-value="${escUiHtml(guide.identifier)}">${t("copy_value")}</button></dd>`):"",
      guide.procurement_name?copyFact(t("bid_guide_name_label"),guide.procurement_name):"",
      guide.status?fact("guide_status",`<dt>${t("bid_guide_status_label")}</dt><dd><b>${escUiHtml(guide.status)}</b></dd>`):"",
      action.deadline?fact("guide_due",`<dt>${t("bid_guide_due_label")}</dt><dd>${fdt(action.deadline)}</dd>`):"",
      guide.selection_method?plainFact(t("apply_method_lbl"),escUiHtml(guide.selection_method)):"",
      (()=>{
        const bits=[];
        if(guide.contact_name) bits.push(escUiHtml(guide.contact_name));
        if(guide.email) bits.push(`<a href="mailto:${escUiHtml(guide.email)}">${escUiHtml(guide.email)}</a>`);
        if(guide.contact_phone) bits.push(escUiHtml(guide.contact_phone));
        return bits.length?fact("guide_contact",`<dt>${t("apply_contact_lbl")}</dt><dd>${bits.join(" · ")}</dd>`):"";
      })(),
      guide.address_to_request?fact("guide_submit",plainFact(t("apply_submit_lbl"),escUiHtml(guide.address_to_request))):"",
    ].join("");
    if(guide.system==="nycha_isupplier"){
      steps=[t("bid_guide_nycha_register_step"),t("bid_guide_nycha_search_step"),t("bid_guide_nycha_submit_step")];
      if(guide.approval_delay) steps.splice(1,0,t("bid_guide_nycha_delay_step"));
    }else if(guide.system==="notice_portal"){
      steps=[
        step(t("bid_guide_named_portal_open_step",{system:escUiHtml(guide.system_name||"")}),"notice_portal_open"),
        step(t("bid_guide_named_portal_search_step"),"notice_portal_search"),
        step(t("bid_guide_named_portal_submit_step"),"notice_portal_submit"),
      ];
    }else if(guide.system==="notice_extracted"){
      // Concrete steps extracted from this notice's fields and body — never "see the official notice."
      if(action.deadline) steps.push(step(t("bid_guide_notice_due_step",{date:fdt(action.deadline)}),"guide_due"));
      if(guide.package_url){
        steps.push(step(t("bid_guide_notice_package_step_html",{
          url:escUiHtml(guide.package_url),
          host:escUiHtml(hostOf(guide.package_url))
        }),"guide_package"));
      }
      if(guide.email || guide.contact_name || guide.contact_phone){
        const who=[guide.contact_name, guide.email, guide.contact_phone].filter(Boolean).map(escUiHtml).join(" · ");
        steps.push(step(t("bid_guide_notice_contact_step_html",{who}),"guide_contact"));
      }
      if(guide.address_to_request){
        steps.push(step(t("bid_guide_notice_submit_step",{where:escUiHtml(guide.address_to_request)}),"guide_submit"));
      }
      if(guide.selection_method){
        steps.push(step(t("bid_guide_notice_method_step",{method:escUiHtml(guide.selection_method)}),"guide_method"));
      }
      if(!steps.length){
        steps.push(t("bid_guide_notice_fallback_step"));
      }
    }else{
      // PASSPort modes: pending | matched | ambiguous | search_only.
      // Never narrate join failure. Deep-linked matches skip the "search the list" step.
      if(guide.mode==="matched" && guide.deep_link){
        steps=[
          t("bid_guide_passport_open_matched_step"),
          String(guide.status||"").toLowerCase()==="released"
            ? t("bid_guide_passport_released_step")
            : `<span class="guide-warning">${t("bid_guide_passport_not_released_step",{status:escUiHtml(guide.status||"—")})}</span>`,
          t("bid_guide_passport_submit_step"),
        ];
      }else if(guide.mode==="matched"){
        steps=[
          t("bid_guide_passport_search_step"),
          String(guide.status||"").toLowerCase()==="released"
            ? t("bid_guide_passport_released_step")
            : `<span class="guide-warning">${t("bid_guide_passport_not_released_step",{status:escUiHtml(guide.status||"—")})}</span>`,
          t("bid_guide_passport_submit_step"),
        ];
      }else if(guide.mode==="ambiguous"){
        steps=[
          t("bid_guide_passport_ambiguous_step"),
          t("bid_guide_passport_submit_step"),
        ];
      }else if(guide.mode==="pending"){
        // First paint before lifecycle: constructive recipe only — no miss claim.
        steps=[
          t("bid_guide_passport_search_step"),
          t("bid_guide_passport_submit_step"),
        ];
      }else{
        // Confirmed miss after lookup: still find + submit; no "could not match".
        steps=[
          t("bid_guide_passport_search_step"),
          t("bid_guide_passport_submit_step"),
        ];
      }
    }
  }
  // upstream_unavailable_note_key remains an internal signal (suppresses broken package
  // URLs); never surface "link not published here" / match-failure chrome in the guide.
  const renderedSteps=guide.system==="property_reader_actions"
    ? `<div class="property-action-sections">${steps.filter(Boolean).join("")}</div>`
    : `<ol>${steps.map((stepItem)=>stepItem?`<li>${stepItem}</li>`:"").join("")}</ol>`;
  return `<details class="bid-guide" open><summary>${t(headingKey)}</summary>${facts?`<dl class="bid-guide-facts">${facts}</dl>`:""}${renderedSteps}${guideExtra}</details>`;
}
// Deliberately dormant until there is a concrete, decision-useful question for the
// aggregate. Flip this one flag to re-enable the existing component and analytics.
const ACTION_OUTCOME_PROMPT_ENABLED = false;

function actionRailHTML(actions){
  let primaryUsed=false;
  const items=actions.map((action,index)=>{
    const label=actionRailLabel(action);
    // Skip empty / "link not published" absence status — show nothing when nothing to do.
    if(action.delivery==="unavailable"){
      if(!label || action.label_key==="next_action_unavailable_handoff") return "";
      return `<div class="next-action-unavailable" role="status">${label}</div>`;
    }
    if(action.type==="bid_checklist"){
      // Guide lead — steps render below; do not dump the reader into watch alerts.
      return `<div class="next-action-guide-lead" role="status">${label}</div>`;
    }
    if(action.delivery==="official_handoff"){
      // City Record is evidence, not a kinetic destination. Keep a reader's route to
      // the official notice, but never let that source become the rail's primary CTA.
      let cityRecordNotice=false;
      try{
        const url=new URL(String(action.destination||""));
        cityRecordNotice=url.protocol==="https:"&&url.hostname.toLowerCase()==="a856-cityrecord.nyc.gov"&&/^\/RequestDetail\//i.test(url.pathname);
      }catch(_e){}
      if(cityRecordNotice){
        return officialSourceLink({ href:action.destination, label:t("city_record_link"), className:"next-action-source", escape:escUiHtml });
      }
      const primary=primaryUsed?"":" primary"; primaryUsed=true;
      const accessible=`${label} — ${action.destination_label}`;
      return `<a class="act${primary}" aria-label="${escUiHtml(accessible)}" title="${escUiHtml(action.destination_label)}" href="${escUiHtml(action.destination)}" data-action-outcome-index="${index}" ${EXT_ATTRS}>${label}${extSR()}</a>`;
    }
    if(action.type==="calendar") return `<button class="act" type="button" data-next-calendar>${label}</button>`;
    // Local watch (and other local navigations): use the action destination when present
    // so "Watch this notice" carries #alerts?lens=…&filter=…&notice=… context.
    const href = action.destination || "/following/";
    return `<a class="act" href="${escUiHtml(href)}">${label}</a>`;
  }).join("");
  const outcomeSlot = ACTION_OUTCOME_PROMPT_ENABLED ? `<div data-action-outcome-slot></div>` : "";
  return `<section class="next-action-rail"><h3>${t("next_action_heading")}</h3><div class="next-action-list">${items}</div>${actionRailGuideHTML(actions)}${outcomeSlot}</section>`;
}
function bindActionOutcomePrompt(el,actions,contextKey){
  if(!ACTION_OUTCOME_PROMPT_ENABLED) return;
  const options={registry:window.CrolActions,analytics:window.crolAnalytics,t,escape:escUiHtml,today:todayISO(),contextKey};
  const load=(selected,officialClicked=false)=>import("../action_outcome_prompt.mjs").then(module=>{
    if(document.contains(el)) module.bindActionOutcomePrompt(el,selected,{...options,officialClicked});
  }).catch(()=>{});
  const passedCandidate=actions.some(action=>(action?.guide?.system==="property_reader_actions"&&action.guide.mode==="historical")||action?.delivery==="unavailable");
  if(passedCandidate){ load(actions); return; }
  el.querySelectorAll("a[data-action-outcome-index]").forEach(link=>link.addEventListener("click",()=>{
    const action=actions[Number(link.dataset.actionOutcomeIndex)];
    if(action) load([action],true);
  }));
}
function paintNoticeActionRail(el,r,ruleRecord,lifecycleData){
  if(!el||!window.CrolActions) return;
  const actions=CrolActions.compileActionRail(noticeActionMatter(r,ruleRecord,lifecycleData),{today:todayISO()});
  el.innerHTML=actionRailHTML(actions);
  bindActionOutcomePrompt(el,actions,r.request_id||null);
  const calendar=el.querySelector("[data-next-calendar]");
  if(calendar) calendar.addEventListener("click",()=>{
    if(r.type_of_notice_description==="Solicitation"){
      selectedRFP=r;
      downloadICS();
    }else downloadEventICS(r);
  });
  el.querySelectorAll("[data-copy-value]").forEach(button=>button.addEventListener("click",()=>copyText(button.dataset.copyValue,button)));
}
async function mountNoticeActionRail(el,r){
  paintNoticeActionRail(el,r,null);
  if(r.section_name!=="Agency Rules") return;
  const view=await loadRulesView();
  if(!document.contains(el)) return;
  paintNoticeActionRail(el,r,buildRulesStageMap(view).get(r.request_id)||null);
}

/** Build hearings for land action rail from zap-outcomes city_record_notices (+ hearing_location). */
function landActionZapHearingsFromRecord(record){
  const logistics=Array.isArray(record&&record.hearing_logistics)?record.hearing_logistics:[];
  if(!logistics.length) return [];
  return logistics.map(row=>{
    const venueAddress=row.venue_address||null;
    const livestream=row.livestream_url||null;
    const modes=Array.isArray(row.attendance_modes)?row.attendance_modes:[];
    const venue=venueAddress
      ? {
          address:venueAddress,
          building:null,
          mode:livestream||modes.includes("livestream")?"hybrid":"in-person",
        }
      : livestream
        ? {address:null, building:null, mode:"virtual"}
        : null;
    // Prefer full hearing_at (clock time) when CRM published it.
    const when=row.hearing_at||row.hearing_date||null;
    return {
      request_id:null,
      event_date:when,
      agency:row.representing||null,
      title:row.representing||null,
      // Free-text logistics so extractors can re-parse; never drop the raw string.
      notice_text:row.hearing_location_raw||"",
      venue,
      participation:livestream
        ? {links:[{url:livestream, kind:"livestream", label:t("land_action_watch_live")}]}
        : null,
      participation_url:livestream||null,
      street_address_1:venueAddress||null,
      source_url:row.portal_url||(record&&record.portal_url)||null,
      body_kind:row.phase_id||null,
      maps_url:row.maps_url||(venueAddress
        ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(venueAddress+", New York, NY")}`
        : null),
      livestream_url:livestream,
      hearing_location_raw:row.hearing_location_raw||null,
      parse_status:row.parse_status||null,
      provenance:row.provenance||null,
      source:"zap_disposition",
    };
  });
}
function landActionHearingsFromRecord(record){
  const zapHearings=landActionZapHearingsFromRecord(record);
  const notices=Array.isArray(record&&record.city_record_notices)?record.city_record_notices:[];
  let cityRecord=[];
  if(notices.length){
    cityRecord=notices.map(row=>{
      const body=[
        row.additional_description_1,row.additional_description_2,row.additional_description_3,
        row.other_info_1,row.other_info_2,row.other_info_3,
        row.printout_1,row.printout_2,row.printout_3,
      ].filter(Boolean).join(" ");
      let venue=null, participation=null;
      try{
        if(typeof normalizeHearingRow==="function"){
          const rec=normalizeHearingRow(row);
          venue=rec&&rec.venue||null;
          participation=rec&&rec.participation||null;
        }
      }catch(_e){}
      if(!participation && typeof hearingParticipationFromBody==="function"){
        try{
          participation=hearingParticipationFromBody(body, REQ_URL(row.request_id));
        }catch(_e){}
      }
      return {
        request_id:row.request_id,
        event_date:row.event_date||null,
        agency:row.agency_name||null,
        title:row.short_title||null,
        notice_text:body,
        venue,
        participation,
        participation_url:participation&&participation.links&&participation.links[0]
          ? participation.links[0].url : null,
        street_address_1:row.street_address_1||null,
        street_address_2:row.street_address_2||null,
        city:row.city||null,
        state:row.state||null,
        zip_code:row.zip_code||null,
        building_name:row.building_name||null,
        email:row.email||null,
        contact_name:row.contact_name||null,
        contact_phone:row.contact_phone||null,
        source_url:row.request_id?REQ_URL(row.request_id):null,
        source:"city_record",
      };
    });
  }else{
    // Fallback: spine city_record_hearing events only (title/date/agency — no body).
    const events=((record&&record.spine&&record.spine.events)||[]).filter(e=>e&&e.kind==="city_record_hearing");
    cityRecord=events.map(e=>({
      request_id:null,
      event_date:e.time&&e.time.value||null,
      agency:e.detail||null,
      title:e.title||null,
      notice_text:"",
      source_url:e.source&&e.source.url||null,
      source:"city_record_spine",
    }));
  }
  // ZAP disposition logistics first (structured venue + livestream); City Record fills gaps.
  return zapHearings.concat(cityRecord);
}
function landActionMatter(projectRow, outcomeRecord, phaseTools){
  const r=projectRow||{};
  const rec=outcomeRecord||null;
  const projectId=r.project_id||(rec&&rec.project_id)||null;
  const portal=rec&&rec.portal_url
    || (projectId?`https://zap.planning.nyc.gov/projects/${encodeURIComponent(projectId)}`:null);
  const publicStatus=r.public_status||(rec&&rec.public_status)||(rec&&rec.open_data&&rec.open_data.public_status)||null;
  let phaseId=null, phaseLabel=null;
  if(rec&&rec.spine&&phaseTools&&typeof phaseTools.buildLandPhaseView==="function"){
    try{
      const view=phaseTools.buildLandPhaseView(rec.spine,{
        open_data:rec.open_data||null,
        portal_url:portal,
        public_status:publicStatus,
        project_id:projectId,
      });
      phaseId=view&&view.current&&view.current.phase_id||null;
      if(view&&view.current&&view.current.label_key) phaseLabel=t(view.current.label_key);
    }catch(_e){}
  }
  const hearings=rec?landActionHearingsFromRecord(rec):[];
  // Prefer nearest upcoming hearing date as deadline when present.
  const upcoming=hearings
    .map(h=>h.event_date)
    .filter(Boolean)
    .map(d=>String(d).slice(0,10))
    .filter(d=>/^\d{4}-\d{2}-\d{2}$/.test(d)&&d>=todayISO())
    .sort();
  return {
    kind:"zoning",
    project_id:projectId,
    project_name:r.project_name||(rec&&rec.project_name)||null,
    title:r.project_name||(rec&&rec.project_name)||null,
    public_status:publicStatus,
    lifecycle_stage:null, // zoningStage derives from public_status / phase_id
    phase_id:phaseId,
    phase_label:phaseLabel,
    project_url:portal,
    deadline:upcoming[0]||null,
    hearings,
    official_notice_url:hearings[0]&&hearings[0].source_url||null,
  };
}
function paintLandActionRail(el, projectRow, outcomeRecord, phaseTools){
  if(!el||!window.CrolActions) return;
  const matter=landActionMatter(projectRow, outcomeRecord, phaseTools);
  const actions=CrolActions.compileActionRail(matter,{today:todayISO()});
  el.innerHTML=actionRailHTML(actions);
  bindActionOutcomePrompt(el,actions,projectRow.project_id||null);
  const calendar=el.querySelector("[data-next-calendar]");
  if(calendar) calendar.addEventListener("click",()=>{
    // Hearing-shaped ICS when a next hearing date is known; else skip silently.
    const guide=(actions.find(a=>a.guide)||{}).guide;
    const when=guide&&(guide.event_date||guide.deadline)||matter.deadline;
    if(!when) return;
    const synthetic={
      request_id:guide&&guide.next_hearing&&guide.next_hearing.request_id||projectRow.project_id||"land",
      short_title:landProjectDisplayTitle(projectRow),
      event_date:when,
      agency_name:guide&&guide.next_hearing&&guide.next_hearing.agency||"",
      section_name:"Public Hearings and Meetings",
      type_of_notice_description:"Public Hearings",
    };
    try{ downloadEventICS(synthetic); }catch(_e){}
  });
  el.querySelectorAll("[data-copy-value]").forEach(button=>button.addEventListener("click",()=>copyText(button.dataset.copyValue,button)));
  // Watch CTA destinations already carry land scope via action_registry.watchDestination
  // (#alerts?lens=land&filter=…&project=…). No showTab side-channel — hash apply does the prefill.
}
function hearingAreaText(record){
  const area=record.affected_area||{};
  if(area.scope==="citywide") return t("citywide");
  if(area.scope==="unlocated") return "";
  const values=[
    ...(area.neighborhoods||[]),
    ...(area.boroughs||[]),
    ...(area.community_districts||[]).map(cd=>t("community_district_short",{n:cd})),
    ...(area.community_boards||[]),
    ...(area.addresses||[]).map(address=>address.label),
    ...(area.street_ranges||[]).map(range=>range.label),
    ...(area.tax_lots||[]).map(lot=>lot.label),
    ...(area.project_names||[]),
  ].filter(Boolean);
  return [...new Set(values)].join(" · ");
}
function hearingAreaHTML(record){
  const area=record.affected_area||{};
  if(area.scope==="citywide") return escUiHtml(t("citywide"));
  if(area.scope==="unlocated") return "";
  const values=[
    ...(area.neighborhoods||[]),
    ...(area.boroughs||[]),
    ...(area.community_districts||[]).map(cd=>t("community_district_short",{n:cd})),
    ...(area.community_boards||[]),
    ...(area.addresses||[]).map(address=>address.label),
    ...(area.street_ranges||[]).map(range=>range.label),
    ...(area.tax_lots||[]).map(lot=>lot.label),
    ...(area.project_names||[]),
  ].filter(Boolean);
  return [...new Set(values)].map(value=>{
    const href=communityBoardPageHref(value);
    return href
      ? `<a class="community-board-reference" href="${escUiHtml(href)}">${escUiHtml(value)}</a>`
      : escUiHtml(value);
  }).join(" · ");
}
function hearingVenueText(record){
  const venue=record.venue||{}, labels={
    "virtual":"venue_virtual","in-person":"venue_in_person","hybrid":"venue_hybrid"
  };
  return [labels[venue.mode]?t(labels[venue.mode]):"", venue.building, venue.address].filter(Boolean).join(" · ");
}
function hearingCardHTML(record, terms=[]){
  // Flat fallback when the explorer module fails to load.
  return meetingsExplorerCardHTML({
    kind:"notice",
    primary:record,
    members:[record],
    notice_count:1,
    process_stage:null,
    process_filter:"unstaged",
    action_key:"meeting_action_open_notice",
    agency:record.agency||null,
    title:record.decides||record.title||null,
    place_scope:record.affected_area&&record.affected_area.scope||"unlocated",
    matched_phases:[],
    participation:record.participation||{},
    sibling_notices:[],
  }, terms);
}
function compactCardActions(primaryAction, secondaryActions){
  const overflow = (secondaryActions || []).filter(Boolean);
  const menuLabel = t("actions_lbl").replace(/:\s*$/, "");
  if(!primaryAction && !overflow.length) return "";
  if(!overflow.length) return `<div class="fcard-compact-actions">${primaryAction || ""}</div>`;
  return `<div class="fcard-compact-actions">
      ${primaryAction || ""}
      <details class="factions-overflow">
        <summary class="act">${escUiHtml(menuLabel)}</summary>
        <div class="fcard-actions-menu">${overflow.join("")}</div>
      </details>
    </div>`;
}
function meetingsExplorerCardHTML(entry, terms=[]){
  const record=entry&&entry.primary;
  if(!record) return "";
  const scope=entry.place_scope||(record.affected_area&&record.affected_area.scope)||"unlocated";
  const sectionKey=record.source_section==="Agency Rules"?"rules_hearing_badge":"public_hearing_badge";
  const past=!!record.event_date&&String(record.event_date).slice(0,10)<todayISO().slice(0,10);
  const sourceUrl=hearingSafeURL(record.source_url);
  const nativeSource=record.source_system==="community_board";
  const noticeHref=nativeSource&&sourceUrl ? sourceUrl : `#notice/${encodeURIComponent(record.request_id)}`;
  const processStage=entry.process_stage||null;
  const processLabel=meetingStageLabel(processStage);
  const agency=entry.agency||record.agency||null;
  const matched=new Set(entry.matched_phases||(processStage?[processStage]:[]));
  const chainChip=entry.notice_count>1
    ? `<span class="tag asset">${escUiHtml(t("meetings_chain_notice_count",{n:String(entry.notice_count)}))}</span>`
    : "";
  const origin=record.meeting_origin||"unknown";
  const originChip=`<span class="tag source" data-meeting-origin="${escUiHtml(origin)}">${sourceUrl
    ? `<a href="${escUiHtml(sourceUrl)}" ${EXT_ATTRS}>${escUiHtml(meetingOriginLabel(origin))}${extSR()}</a>`
    : escUiHtml(meetingOriginLabel(origin))}</span>`;
  const processLine=`<div class="meetings-process-line">
    <span class="tag open">${escUiHtml(processLabel)}</span>
    ${chainChip}
    ${agency?`<span class="tag place">${pivotA(agencyHref(agency), agency)}</span>`:""}
    ${originChip}
  </div>`;
  // Next-action lead: concrete attend / join / testimony when data supports it.
  const actionKey=entry.action_key||"meeting_action_open_notice";
  let actionLeadText=t(actionKey);
  if(actionKey==="meeting_action_attend_dated" && record.event_date){
    actionLeadText=t("meeting_action_attend_dated",{date:fdt(record.event_date)});
  }
  const actionLead=`<div class="meetings-action-lead">${escUiHtml(actionLeadText)}</div>`;
  // Primary kinetic destination: notice detail (outcomes + action rail live there);
  // participation join/materials stay as secondary classified EXT links.
  const participation=entry.participation||record.participation||{};
  const primaryAction=`<a class="act primary" href="${noticeHref}">${escUiHtml(actionLeadText)}</a>`;
  const secondaryActions=[];
  if(agency) secondaryActions.push(`<a class="act" href="${agencyHref(agency)}">${t("meetings_action_agency_profile")}</a>`);
  const participationAction=participationLinksHTML({ participation });
  if(participationAction) secondaryActions.push(participationAction);
  (participation.emails||[]).slice(0,1).forEach(email=>{
    secondaryActions.push(`<a class="act" href="mailto:${encodeURIComponent(email)}">${t("email_in_notice")}</a>`);
  });
  secondaryActions.push(`<button class="act" type="button" data-link="${record.request_id}">${t("copy_link_btn")}</button>`);
  if(record.event_date) secondaryActions.push(`<button class="act" type="button" data-ev="meetings:${record.request_id}">${t("calendar_ics")}</button>`);
  const venue=record.venue||{};
  if(venue.address) secondaryActions.push(`<a class="act" href="https://www.google.com/maps/search/${encodeURIComponent(venue.address+' New York NY')}" ${EXT_ATTRS}>${t("map_venue")}${extSR()}</a>`);
  const cardMatter={
    kind:"hearing",
    lifecycle_stage:past?"past":null,
    deadline:record.event_date||null,
    event_date:record.event_date||null,
    title:entry.title||record.decides||record.title||null,
    notice_text:record.description||"",
    official_notice_url:nativeSource&&sourceUrl ? sourceUrl : REQ_URL(record.request_id),
    agency_name:agency,
    venue,
    participation,
    participation_url:((participation.links||[]).find(link=>hearingSafeURL(link.url))||{}).url||null,
  };
  const cardAttendPack=window.CrolActions
    ? actionRailGuideHTML(CrolActions.compileActionRail(cardMatter,{today:todayISO()}))
    : "";
  // Sibling notices for multi-notice event / matter chains (entity links across rows).
  let siblingsHtml="";
  if((entry.kind==="event"||entry.kind==="matter") && (entry.sibling_notices||[]).length>1){
    const chips=(entry.sibling_notices||[]).slice(0,6).map(sib=>{
      const id=sib.request_id;
      if(!id) return "";
      const href=`#notice/${encodeURIComponent(id)}`;
      const label=sib.title||id;
      const selfMark=sib.is_self?` aria-current="true"`:"";
      return `<a href="${href}"${selfMark}>${escUiHtml(label.length>48?label.slice(0,48)+"…":label)}</a>`;
    }).filter(Boolean).join(" · ");
    if(chips) siblingsHtml=`<div class="meetings-siblings">${t("meetings_siblings_label")}: ${chips}</div>`;
  }
  const title=noticeDisplayTitle({title:entry.title||record.decides||record.title,request_id:record.request_id},t("now_event_meeting"));
  const ev=resultMatchEvidence(title, matchText(record), terms);
  const areaText=hearingAreaText(record);
  const areaHTML=hearingAreaHTML(record);
  const venueText=hearingVenueText(record);
  const areaFact=areaText
    ? `<div class="hfact"><b>${t("affected_area_label")}</b><span>${areaHTML}</span></div>`
    : "";
  const venueFact=venueText
    ? `<div class="hfact"><b>${t("venue_label")}</b><span>${escUiHtml(venueText)}</span></div>`
    : "";
  const affectsFact=record.affects&&record.affects.length
    ? `<div class="hfact"><b>${t("who_affected_label")}</b><span>${escUiHtml(record.affects.map(value=>t(value)).join(" · "))}</span></div>`
    : "";
  const factsHTML=`${areaFact}${venueFact}${affectsFact}`;
  return `<article class="fcard hcard meetings-fcard" data-scope="${scope}" data-meeting-kind="${escUiHtml(entry.kind||"notice")}" data-process-stage="${escUiHtml(processStage||"unstaged")}">
      <div class="ftype"><span class="tag asset">${t(sectionKey)}</span>${past?` <span class="tag closed">${t("past_tag")}</span>`:""}${record.event_date?` · <b style="color:var(--color-text)">${fdt(record.event_date)}</b>${eventTag(record.event_date)}`:""}</div>
      ${processLine}
      ${actionLead}
      <div class="ftitle"><a href="${noticeHref}">${excerptHtml(title,400)}</a></div>
      ${siblingsHtml}
      ${factsHTML?`<div class="hfacts">${factsHTML}</div>`:""}
      ${record.description?`<div class="fscope">${excerptHtml(record.description,260)}</div>`:""}
      ${digEvidenceHTML(ev)}
      <div class="factions">${compactCardActions(primaryAction, secondaryActions)}</div>
      ${cardAttendPack}
    </article>`;
}
function renderHearingGroup(scope, entries, terms=[]){
  if(!entries.length) return "";
  const label=scope==="local"?"local_hearings_group":scope==="citywide"?"citywide_hearings_group":"unlocated_hearings_group";
  const noteText=scope==="citywide"?t("citywide_hearings_note"):"";
  return `<h2 class="hearinggroup">${t(label)}${noteText?` <small>${noteText}</small>`:""}</h2>${entries.map(entry=>meetingsExplorerCardHTML(entry,terms)).join("")}`;
}
function updateMeetingsMoreFiltersState(){
  const badge=$("#meetings-filter-badge");
  if(!badge) return;
  const active=Number(["month","upcoming","past"].includes($("#meetingswhen")?.value||""))
    +Number(!!$("#meetingsboro")?.value)
    +Number(!!meetingsCommunityDistrict)
    +Number(!!meetingsCouncilDistrict)
    +Number(!!$("#meetingsneighborhood")?.value.trim())
    +Number(!!$("#meetingsagency")?.value)
    +Number(meetingsPlaceGroupSel==="place");
  badge.textContent=active?t("property_filters_active",{n:fmtNumber(active)}):"";
  badge.hidden=active===0;
}
function setMeetingsResultCount(count){
  const element=$("#meetings-count");
  if(element) element.textContent=t("results_count",{n:fmtNumber(countWithScopeReceipt(count))});
}
async function renderHearingExplorer(){
  const seq=++hearingRenderSeq;
  const filter=hearingViewFilter(), key=hearingFilterKey(filter);
  const allowWidening=hearingWideningDismissed!==key && filter.when!=="all";
  let records=await filterFeedRowsToDistrictBag("meetings",hearingAll||[]);
  renderMeetingsAgencyScope(hearingAll||[]);
  let selection=chooseHearingScope(records,filter,todayISO(),allowWidening);
  // when=all (map drill) and past / empty-widen need the past SODA slice.
  const needsPast=filter.when==="all" || filter.when==="past" || (allowWidening && !selection.rows.length);
  if(needsPast){
    try{
      const past=await loadPastHearings(filter);
      if(seq!==hearingRenderSeq) return;
      records=await filterFeedRowsToDistrictBag("meetings",records.concat(past));
      renderMeetingsAgencyScope(hearingAll||[]);
      selection=chooseHearingScope(records,filter,todayISO(),allowWidening);
    }catch(e){ /* the exact zero state remains actionable below */ }
  }
  if(seq!==hearingRenderSeq) return;
  const rows=selection.rows;
  const terms=filter.keyword?[filter.keyword]:[];
  const widening=$("#meetingswidening");
  widening.innerHTML=hearingWideningHTML(selection,filter)+hearingCommunityBoardDisambiguationHTML(filter)+hearingCommunityBoardPivotHTML();
  const remove=widening.querySelector("[data-remove-widening]");
  if(remove) remove.addEventListener("click",()=>{
    hearingWideningDismissed=key;
    renderHearingExplorer();
  });

  // Process-stage ontology + multi-notice collapse (pure module). Place grouping is opt-in.
  const tools=await meetingsExplorerTools();
  if(seq!==hearingRenderSeq) return;
  const now=todayISO();
  let entries=[];
  if(tools && tools.buildMeetingsExplorerEntries){
    entries=tools.buildMeetingsExplorerEntries(rows,{ now });
    entries=tools.filterMeetingsExplorerEntries(entries,{ process:meetingsProcessSel, now });
    // Rail counts from the place/time-filtered set (before process chip).
    const base=tools.buildMeetingsExplorerEntries(rows,{ now });
    const pc=tools.countMeetingsProcessStages(base);
    const processRail=$("#meetingsprocessrail");
    if(processRail){
      const stages=tools.MEETINGS_PROCESS_STAGES||[["all","stage_all"]];
      processRail.innerHTML=stages.map(([k,l])=>
        `<button type="button" class="chip ${meetingsProcessSel===k?"on":""}" data-p="${k}" aria-pressed="${meetingsProcessSel===k?"true":"false"}">${t(l)}<span class="ct">${pc[k]||0}</span></button>`
      ).join("");
      processRail.querySelectorAll(".chip").forEach(b=>b.addEventListener("click",()=>{
        meetingsProcessSel=b.dataset.p;
        renderHearingExplorer();
        updateHash();
        renderSearchComponents("meetings");
      }));
    }
    const placeRail=$("#meetingsplacegrouprail");
    if(placeRail){
      const modes=tools.MEETINGS_PLACE_GROUP_MODES||[["flat","meetings_place_group_flat"],["place","meetings_place_group_place"]];
      placeRail.innerHTML=modes.map(([k,l])=>
        `<button type="button" class="chip ${meetingsPlaceGroupSel===k?"on":""}" data-g="${k}" aria-pressed="${meetingsPlaceGroupSel===k?"true":"false"}">${t(l)}</button>`
      ).join("");
      placeRail.querySelectorAll(".chip").forEach(b=>b.addEventListener("click",()=>{
        meetingsPlaceGroupSel=b.dataset.g==="place"?"place":"flat";
        renderHearingExplorer();
        updateHash();
        renderSearchComponents("meetings");
      }));
    }
  } else {
    const processRail=$("#meetingsprocessrail");
    if(processRail) processRail.innerHTML="";
    const placeRail=$("#meetingsplacegrouprail");
    if(placeRail) placeRail.innerHTML="";
    entries=rows.map(record=>({
      kind:"notice",
      primary:record,
      members:[record],
      notice_count:1,
      process_stage:null,
      process_filter:"unstaged",
      action_key:"meeting_action_open_notice",
      agency:record.agency||null,
      title:record.decides||record.title||null,
      place_scope:record.affected_area&&record.affected_area.scope||"unlocated",
      matched_phases:[],
      participation:record.participation||{},
      sibling_notices:[],
    }));
  }

  // Export/print still want notice rows (primaries + members of visible entries).
  setExportBandVisibility(entries.length, "meetings-export-band", "meetings-export-overflow");
  const visibleRows=[];
  feedRows.meetings={};
  for(const e of entries){
    for(const m of e.members||[e.primary]){
      if(m?.request_id){
        visibleRows.push(m);
        feedRows.meetings[m.request_id]=hearingEventRow(m);
      }
    }
  }
  // Dedupe for export summary counts by request_id.
  const seenRid=new Set();
  const uniqueRows=visibleRows.filter(r=>{
    if(!r.request_id||seenRid.has(r.request_id)) return false;
    seenRid.add(r.request_id);
    return true;
  });
  feedVisible.meetings=uniqueRows.map(hearingEventRow);
  updateMeetingsMoreFiltersState();
  // District map counts are request-id counts. Collapsed event/matter cards still
  // represent every member notice, so the list counter must use the same identity
  // cardinality as district_items rather than the number of rendered cards.
  setMeetingsResultCount(uniqueRows.length);
  const el=$("#meetingsfeed");
  if(!entries.length){
    widening.innerHTML="";
    el.innerHTML="";
    announce(t("meetings_entries_announce",{n:0})); return;
  }
  const groupByPlace=tools&&typeof tools.meetingsPlaceGroupEnabled==="function"
    ? tools.meetingsPlaceGroupEnabled(meetingsPlaceGroupSel)
    : meetingsPlaceGroupSel==="place";
  if(groupByPlace){
    const byPlace=tools&&tools.groupMeetingsByPlace
      ? tools.groupMeetingsByPlace(entries)
      : { local:entries.filter(e=>(e.place_scope||"unlocated")==="local"),
          citywide:entries.filter(e=>(e.place_scope||"unlocated")==="citywide"),
          unlocated:entries.filter(e=>(e.place_scope||"unlocated")==="unlocated") };
    el.innerHTML=["local","citywide","unlocated"].map(scope=>renderHearingGroup(scope, byPlace[scope]||[],terms)).join("");
  } else {
    // Default: single chronological list (near-me / borough filters own place navigation).
    el.innerHTML=entries.map(entry=>meetingsExplorerCardHTML(entry,terms)).join("");
  }
  el.querySelectorAll("[data-link]").forEach(button=>button.addEventListener("click",()=>copyText(noticeLink(button.dataset.link),button)));
  el.querySelectorAll("[data-ev]").forEach(button=>button.addEventListener("click",()=>downloadEventICS(feedRows.meetings[button.dataset.ev.split(":")[1]])));
  el.querySelectorAll("[data-copy-value]").forEach(button=>button.addEventListener("click",()=>copyText(button.dataset.copyValue,button)));
  announce(t("meetings_entries_announce",{n:uniqueRows.length}));
}
async function loadHearings(){
  if(hearingAll){ await renderHearingExplorer(); return; }
  busyList("#meetingsfeed",3);
  const key="meetings", stale=staleGuard("feed:"+key);
  try{
    let records=null;
    try{
      const response=await workerFetch("/hearings",{},12000);
      if(response.ok){ const payload=await response.json(); if(Array.isArray(payload.hearings)) records=payload.hearings; }
    }catch(e){}
    if(!records){
      const rows=await soda({
        "$select":FEED_SELECT,
        "$where":`(section_name='Public Hearings and Meetings' OR (section_name='Agency Rules' AND type_of_notice_description='Public Hearings' AND event_date IS NOT NULL)) AND event_date >= '${todayISO()}'`,
        "$order":"event_date ASC","$limit":"500"
      });
      records=rows.map(normalizeHearingRow);
    }
    records=records.concat(await loadCommunityBoardMeetings());
    if(stale()) return;
    hearingAll=records;
    renderMeetingsAgencyScope(hearingAll);
    unbusy("#meetingsfeed");
    await renderHearingExplorer();
  }catch(e){
    if(!stale()){ unbusy("#meetingsfeed"); $("#meetingsfeed").innerHTML=""; }
  }
}

globalThis.FEED_SELECT = FEED_SELECT;
globalThis.MEETING_PHASE_IDS = MEETING_PHASE_IDS;
globalThis.MEETING_PHASE_LABEL_KEYS = MEETING_PHASE_LABEL_KEYS;
globalThis.SECTIONS = SECTIONS;
globalThis.actionRailGuideHTML = actionRailGuideHTML;
globalThis.actionRailHTML = actionRailHTML;
globalThis.actionRailLabel = actionRailLabel;
globalThis.buildRulesStageMap = buildRulesStageMap;
globalThis.compactCardActions = compactCardActions;
globalThis.feedLoaded = feedLoaded;
globalThis.feedRows = feedRows;
globalThis.feedVisible = feedVisible;
globalThis.goodAddr = goodAddr;
globalThis.hearingAreaText = hearingAreaText;
globalThis.hearingCardHTML = hearingCardHTML;
globalThis.hearingEventRow = hearingEventRow;
globalThis.hearingFilter = hearingFilter;
globalThis.hearingFilterKey = hearingFilterKey;
globalThis.hearingPastCache = hearingPastCache;
globalThis.hearingSafeURL = hearingSafeURL;
globalThis.hearingVenueText = hearingVenueText;
globalThis.hearingViewFilter = hearingViewFilter;
globalThis.hearingWidenedNone = hearingWidenedNone;
globalThis.hearingWidenedShown = hearingWidenedShown;
globalThis.hearingWideningHTML = hearingWideningHTML;
globalThis.hearingWindowEnd = hearingWindowEnd;
globalThis.landActionHearingsFromRecord = landActionHearingsFromRecord;
globalThis.landActionMatter = landActionMatter;
globalThis.loadHearings = loadHearings;
globalThis.loadPastHearings = loadPastHearings;
globalThis.loadRulesView = loadRulesView;
globalThis.loadSection = loadSection;
globalThis.meetingStageLabel = meetingStageLabel;
globalThis.meetingsExplorerCardHTML = meetingsExplorerCardHTML;
globalThis.meetingsExplorerTools = meetingsExplorerTools;
globalThis.mountNoticeActionRail = mountNoticeActionRail;
globalThis.noticeActionMatter = noticeActionMatter;
globalThis.paintLandActionRail = paintLandActionRail;
globalThis.paintNoticeActionRail = paintNoticeActionRail;
globalThis.participationLinksHTML = participationLinksHTML;
globalThis.propertyLocationTools = propertyLocationTools;
globalThis.renderHearingExplorer = renderHearingExplorer;
globalThis.renderHearingGroup = renderHearingGroup;
globalThis.ruleLocationTools = ruleLocationTools;
Object.defineProperty(globalThis, "hearingAll", { configurable: true, get: () => hearingAll, set: value => { hearingAll = value; } });
Object.defineProperty(globalThis, "hearingRenderSeq", { configurable: true, get: () => hearingRenderSeq, set: value => { hearingRenderSeq = value; } });
Object.defineProperty(globalThis, "hearingWideningDismissed", { configurable: true, get: () => hearingWideningDismissed, set: value => { hearingWideningDismissed = value; } });
Object.defineProperty(globalThis, "meetingsExplorerToolsPromise", { configurable: true, get: () => meetingsExplorerToolsPromise, set: value => { meetingsExplorerToolsPromise = value; } });
Object.defineProperty(globalThis, "meetingsCommunityDistrict", { configurable: true, get: () => meetingsCommunityDistrict, set: value => { meetingsCommunityDistrict = value || ""; } });
Object.defineProperty(globalThis, "meetingsCouncilDistrict", { configurable: true, get: () => meetingsCouncilDistrict, set: value => { meetingsCouncilDistrict = value || ""; } });
Object.defineProperty(globalThis, "meetingsPlaceGroupSel", { configurable: true, get: () => meetingsPlaceGroupSel, set: value => { meetingsPlaceGroupSel = value; } });
Object.defineProperty(globalThis, "meetingsProcessSel", { configurable: true, get: () => meetingsProcessSel, set: value => { meetingsProcessSel = value; } });
Object.defineProperty(globalThis, "propertyLocationToolsPromise", { configurable: true, get: () => propertyLocationToolsPromise, set: value => { propertyLocationToolsPromise = value; } });
Object.defineProperty(globalThis, "ruleLocationToolsPromise", { configurable: true, get: () => ruleLocationToolsPromise, set: value => { ruleLocationToolsPromise = value; } });
Object.defineProperty(globalThis, "rulesViewPromise", { configurable: true, get: () => rulesViewPromise, set: value => { rulesViewPromise = value; } });
