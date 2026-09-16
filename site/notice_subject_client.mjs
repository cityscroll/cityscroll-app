/**
 * Client-side notice document route and subject-link projection.
 * Kept outside app/routing.mjs so the route module stays under the short-context
 * working bar while still projecting accepted procurement subjects.
 */

import {
  projectNoticeSubjectLinks,
  renderNoticeSubjectLinksHtml,
} from "./notice_subject_projection.mjs";
import { noticeDisplayTitle } from "./display_title.mjs";
import { renderNoticeBitemporalHistory } from "./civic_time_ledger.mjs";
import { noticeProcurementChain, renderNoticeLandSpine, renderNoticeMeetingOutcomes } from "./notice_lens_sections.mjs";
import { officialSourceLink } from "./affordance_grammar.mjs";
import { noticeDocumentUrl } from "./notice_permalink.mjs";
import { resolveAgencyIdentity } from "./agency_identity.mjs";
import { renderNoticeClientActionRegions } from "./research_discovery.mjs";
import {
  noticeContextReady,
  noticeContextTimingMark,
  noticeContextTimingMeasure,
  noticePrimaryOutcomeFromEdge,
  noticePrimaryOwnerNow,
  noticePrimaryReady,
  noticePrimaryTimingMark,
  runtimeRumSemanticMilestones,
} from "./rum_static_record_instrumentation.mjs";

function noticeLink(id) {
  const currentLanguageURL = globalThis.currentLanguageURL || ((href) => href);
  return currentLanguageURL(noticeDocumentUrl(id, location.origin));
}

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
export async function showNotice(id, watch){
  noticeContextTimingMark("route-start");
  showTab("notice");
  const box = $("#noticeview");
  const safeId = String(id).replace(/[<>&]/g,"");
  const edgeNotice=box.querySelector(`[data-edge-rendered][data-notice-id="${CSS.escape(String(id))}"]`);
  const edgePrimaryState=noticePrimaryOutcomeFromEdge(edgeNotice?.dataset.edgeRendered);
  if(edgePrimaryState){
    // Read the owner clock at the boundary itself so content_ready_ms stays the
    // owner's timing even when the production reporter installs later.
    const edgePrimaryAt=noticePrimaryOwnerNow();
    noticePrimaryTimingMark("edge-primary-ready");
    noticePrimaryReady(runtimeRumSemanticMilestones(),{resultState:edgePrimaryState},edgePrimaryAt);
  }
  // The edge-rendered body is the primary interaction boundary. Optional route
  // modules and the client read/enrichment path may start after that boundary,
  // but must not delay its semantic readiness measurement.
  noticePrimaryTimingMark("deferred-owners-start");
  const optionalRouteModules = Promise.allSettled([
    globalThis.ensureMoneyHistory?.(),
    globalThis.ensureRules?.(),
  ]);
  const meetingFirstPaint=box.querySelector("[data-meeting-outcomes-first-paint]")?.outerHTML||"";
  if(!edgeNotice) box.innerHTML = `<div class="empty"><span class="loading"></span> ${t("fetching_notice_id",{id:safeId})}</div>`;
  let r = null;
  let attachmentDataPromise = Promise.resolve(null);
  try{
    noticeContextTimingMark("notice-read-start");
    const noticeRowsPromise = import("./notice-read.mjs").then(m=>m.read(id));
    const rows = await noticeRowsPromise;
    r = rows[0];
    noticeContextTimingMark("notice-read-end");
    // Attachment metadata is optional context. Start it after the primary row is
    // available, but do not await it before the first useful body or context state.
    noticeContextTimingMark("attachment-start");
    attachmentDataPromise = noticeAttachmentMetadata(id,r)
      .then(data=>{
        noticeContextTimingMark("attachment-end");
        noticeContextTimingMeasure("attachment");
        return data;
      })
      .catch(()=>{
        noticeContextTimingMark("attachment-end");
        noticeContextTimingMeasure("attachment");
        return null;
      });
  }catch(e){}
  if(!r){
    globalThis.lastNoticeContext = null;
    if(edgeNotice){
      noticeContextReady(runtimeRumSemanticMilestones(),{resultState:"unavailable"});
      applyActiveHistoryRouteScroll();
      if(typeof syncAlertsEntryHrefs === "function") Promise.resolve(syncAlertsEntryHrefs()).catch(()=>{});
      return;
    }
    const cityRecordUrl = cityRecordRequestUrl(id);
    const cityRecordAction = cityRecordUrl
      ? ` · ${officialSourceLink({ href: cityRecordUrl, label: t("try_city_record"), escape: taskEsc })}`
      : "";
    box.innerHTML = `<div class="empty">${t("notice_not_found_html",{id:safeId})} <br><br>${routeBackHTML("#money")}${cityRecordAction}</div>`;
    noticePrimaryTimingMark("client-unavailable-terminal");
    noticePrimaryReady(runtimeRumSemanticMilestones(),{resultState:"unavailable"},noticePrimaryOwnerNow());
    noticeContextReady(runtimeRumSemanticMilestones(),{resultState:"unavailable"});
    applyActiveHistoryRouteScroll();
    if(typeof syncAlertsEntryHrefs === "function") Promise.resolve(syncAlertsEntryHrefs()).catch(()=>{});
    return;
  }
  // Header "Want email updates?" and Watch CTAs read this for notice-scoped #alerts entry.
  globalThis.lastNoticeContext = { row: r };
  if(typeof syncAlertsEntryHrefs === "function") Promise.resolve(syncAlertsEntryHrefs()).catch(()=>{});
  // Action-row helpers are published by their owning app modules. Ensure they are
  // present before composing More tools so a cold notice boot cannot throw.
  if (typeof globalThis.qrButtonHTML !== "function") {
    await import("./app/search-share.mjs");
  }
  if (typeof globalThis.pinBtn !== "function") {
    await import("./app/workspace.mjs");
  }
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
  box.innerHTML = `<div style="max-width:880px;margin:0 auto" data-notice-id="${escUiHtml(r.request_id)}">
    <p style="margin:4px 0 12px">${routeBackHTML("#money")}</p>
    <div class="panel route-item" tabindex="-1" style="padding:22px 24px">
      <div class="ftype" style="margin-bottom:6px">${r.type_of_notice_description||t("notice_fallback")}${r.section_name?" · "+tSection(r.section_name):""}${r.agency_name?" · "+pivotA(agencyHref(r.agency_name), r.agency_name):""}</div>
      <h2 class="rolename" lang="en" dir="ltr">${titleInner}</h2>
      ${digEvidenceHTML(ev)}
      ${watchChips.length ? `<div class="nlunderstood" role="status">${t("deeplink_watch_context_label")} ${watchChips.join(" ")}</div>` : ""}
      <div id="nactions" data-export-class="actions">${initialActionRail}</div>
      ${r.type_of_notice_description==="Solicitation"?'<div id="napply" data-export-class="actions"></div>':""}
      <div id="nplain" data-export-class="plain_summary"></div><div id="ncontext" data-export-class="notice_context"></div>
      <div id="nglance" data-export-class="notice_context"></div>
      ${renderNoticeBitemporalHistory({ notice: r, events: r.civic_time?.events || [], state: r.civic_time?.state || "ok" })}
      <div id="naddr" data-export-class="address_geography"></div><div id="nmwbe" data-export-class="mwbe_context"></div><div id="nrules" data-export-class="rule_lifecycle"></div><div id="nlifecycle" data-export-class="procurement_lifecycle"></div><div id="nregdwell" data-export-class="award_registration_dwell"></div><div id="nsuboutreach" data-export-class="sub_outreach"></div><div id="ndollars" data-export-class="dollars"></div><div id="nsubsidy" data-export-class="subsidy"></div><div id="naboaward" data-export-class="authority_award"></div><div id="ncommercial" data-export-class="commercial"></div><div id="ndisposition" data-export-class="property_disposition"></div><div id="npropertyxd" data-export-class="property_cross_domain"></div><div id="ntaxlien" data-export-class="tax_lien"></div><div id="nfranchise" data-export-class="franchise"></div><div id="nland" data-export-class="land_project"></div><div id="nmeet" data-export-class="meeting_outcomes">${meetingFirstPaint}</div><div id="nexternal" data-export-class="external_award"></div>
      ${renderNoticeClientActionRegions(r, link, {
        resolveAgencyIdentity,
        officialSourceLink,
        // App helpers are published on globalThis by their owning modules; read
        // them explicitly so this ESM module does not throw on free bindings.
        qrButtonHTML: globalThis.qrButtonHTML,
        pinBtn: globalThis.pinBtn,
        REQ_URL: globalThis.REQ_URL,
        cleanText: globalThis.cleanText,
        fdate: globalThis.fdate,
        escape: globalThis.taskEsc,
        translate: globalThis.t,
      })}
      ${scope?`<details class="fulltext" data-export-class="official_notice_text"${scope.length<=600?" open":""}><summary>${t("read_full_notice")}</summary><div class="scope" lang="en" dir="ltr" style="margin-top:10px">${scope.slice(0,6000)}${scope.length>6000?"…":""}</div></details>`:""}
      <div class="xlate" id="nxlate" data-export-class="unofficial_translation"></div>
      <div id="nprior" data-export-class="paper_trail"></div>
      <div id="nforecast" data-export-class="agency_forecast"></div>
      <div id="nchain" data-export-class="paper_trail"></div>
      <div class="note" style="margin-top:14px">${t("permalink_note_html",{link, id:r.request_id})}</div>
  </div></div>`;
  const clientPrimaryAt=noticePrimaryOwnerNow();
  noticePrimaryTimingMark("client-primary-ready");
  noticePrimaryReady(runtimeRumSemanticMilestones(),{resultState:"content"},clientPrimaryAt);
  $("#ncopy").addEventListener("click", ()=>copyText(link, $("#ncopy")));
  bindQRShare($("#nqr"), link);
  $("#nxlsx").addEventListener("click", async ()=>exportNoticeXlsx(r,await noticeProcurementChain(r)));
  $("#nprint").addEventListener("click", ()=>printCurrentView("notice",link));
  const contextElement=$("#ncontext");
  const attachmentHydration=attachmentDataPromise.then(attachmentData=>{
    let resolved=attachmentData;
    if(!resolved?.attachments?.length){
      const fallback=noticeAttachmentFallbacks(r);
      if(fallback.length)resolved={...(resolved||{}),request_id:String(r.request_id),n_attachments:fallback.length,attachments:fallback};
    }
    if(resolved&&Array.isArray(resolved.attachments)&&resolved.attachments.length){
      r.attachments=resolved.attachments;
      r.n_documents=Math.max(Number(r.n_documents||0),resolved.attachments.length);
      // T3: precomputed related edges from /attachment-metadata when present.
      if(resolved.related_by_attachment)r.related_by_attachment=resolved.related_by_attachment;
    }
    return resolved;
  }).then(()=>typeof hydrateNoticeAttachments==="function"
    ? hydrateNoticeAttachments(r,contextElement)
    : undefined);
  fillContext(r, contextElement, [attachmentHydration]);
  // Property action identity remains progressively hydrated, but no longer gates the
  // notice body or Notice-context readiness on a cold route-module import. The
  // Solicitation response-apply block (buildApply), the context glance line
  // (glanceFor/actionRailGuideCoverage), the prior-cycle award chain
  // (priorCycleAwards), and the agency forecast teaser (agencyForecastTeaser)
  // are the same kind of cold-import dependency on money-history.mjs: on a
  // fresh landing directly on a notice URL, ensureMoneyHistory() has not
  // necessarily resolved by the time the body above is painted, so these are
  // hydrated here once ready rather than called eagerly inline.
  optionalRouteModules
    .then(()=>{
      noticeContextTimingMark("route-modules-end");
      noticePrimaryTimingMark("deferred-owners-end");
      if(typeof buildApply==="function"){
        const applyMount=$("#napply");
        if(applyMount) applyMount.innerHTML = buildApply(r,false);
      }
      if(typeof glanceFor==="function" && typeof actionRailGuideCoverage==="function"){
        const glanceMount=$("#nglance");
        if(glanceMount) glanceMount.innerHTML = glanceFor(r, actionRailGuideCoverage(initialActionsForGlance));
      }
      if(typeof priorCycleAwards==="function") priorCycleAwards(r, $("#nprior"));
      if(typeof agencyForecastTeaser==="function") agencyForecastTeaser(r, $("#nforecast"));
      return typeof hydratePropertyActionMatter==="function" ? hydratePropertyActionMatter(r) : r;
    })
    .then(()=>{
      if(isPropertyDispositionEligible(r)&&$("#nactions"))mountNoticeActionRail($("#nactions"),r);
    })
    .catch(()=>{});
  mountNoticeActionRail($("#nactions"),r);
  if(typeof loadSolicitationMwbe === "function") loadSolicitationMwbe(r, $("#nmwbe"));
  loadRuleLifecycle(r, $("#nrules"));
  loadLifecycle(r, $("#nlifecycle"), $("#ndollars"), $("#nactions"), $("#nsuboutreach"));
  if(typeof loadAwardRegistrationDwell === "function"){
    loadAwardRegistrationDwell(r, $("#nregdwell"));
  }
  loadSubsidyLifecycle(r, $("#nsubsidy"));
  import("./app/authority-award.mjs").then(()=>loadAboAuthorityAward(r,$("#naboaward"))).then((released)=>{
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
  renderNoticeLandSpine(r, $("#nland"));
  renderNoticeMeetingOutcomes(r, $("#nmeet"), workerFetch);
  mountUnofficialTranslation($("#nxlate"), r);
  if(usablePin(r.pin)){ noticeProcurementChain(r).then(chain=>{ if(chain.length>1) paintPaperTrail($("#nchain"), r, chain); }).catch(()=>{}); }
  focusItemRouteTarget(box.querySelector(".route-item"));
  applyActiveHistoryRouteScroll();
}


/** Load the reverse lookup and render subject continuation links for one notice row. */
export async function renderNoticeSubjectLinksForRow(row, { escape } = {}) {
  let subjectsLookup = null;
  try {
    subjectsLookup = (await import("./data/notice_procurement_subjects_lookup.json", {
      with: { type: "json" },
    })).default;
  } catch (_error) {
    subjectsLookup = null;
  }
  const projection = projectNoticeSubjectLinks(row || {}, { subjectsLookup });
  return renderNoticeSubjectLinksHtml(projection.subjects || [], { escape });
}
