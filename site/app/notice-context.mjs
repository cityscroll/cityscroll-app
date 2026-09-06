// Notice-only context helpers split from the watch builder so reading routes do not
// download alerts.mjs. The helpers still publish the legacy globals used by route modules.
import { officialSourceLink } from "../affordance_grammar.mjs";
import {
  NOTICE_CONTEXT_OPTIONAL_BRANCHES,
  noticeContextPrimaryResultState,
} from "../notice_context_readiness.mjs";
import {
  noticeContextReady,
  noticeContextTimingMark,
  noticeContextTimingMeasure,
  runtimeRumSemanticMilestones,
} from "../rum_static_record_instrumentation.mjs";
import { geocodeAddressText } from "../address_geocoder.mjs";
const SECTION_LENS={"Procurement":"money","Public Hearings and Meetings":"meetings","Agency Rules":"rules","Property Disposition":"property","Changes in Personnel":"people"};
const NOTICE_CONTEXT_LOOKUP_URL="data/notice_context_lookup.json";
let noticeContextLookupPromise=null;
// determinism-lint: allow clock a rolling twelve-month benchmark window is relative to now by definition; it bounds a SODA aggregate, not a rendered date.
const yearCut=()=>new Date(Date.now()-365*86400000).toISOString().slice(0,10)+"T00:00:00";
function ordinal(n){const s=["th","st","nd","rd"],v=n%100;return n+(s[(v-20)%10]||s[v]||s[0]);}
function loadNoticeContextLookup(){
  if(!noticeContextLookupPromise){
    noticeContextTimingMark("lookup-start");
    noticeContextLookupPromise=fetch(NOTICE_CONTEXT_LOOKUP_URL,{cache:"force-cache",credentials:"omit"})
      .then(response=>response.ok?response.json():null)
      .catch(()=>null)
      .finally(()=>{
        noticeContextTimingMark("lookup-end");
        noticeContextTimingMeasure("lookup");
      });
  }
  return noticeContextLookupPromise;
}
async function noticeContextFacts(r){
  if(!r?.request_id)return null;
  const lookup=await loadNoticeContextLookup();
  return lookup?.by_notice?.[String(r.request_id)]||null;
}
const NONCOMP_RE=/negotiated|sole source|emergency|demonstration project/i;


async function noticeFlags(r){
  const flags=[];
  if(!r||!r.agency_name)return flags;
  if(NONCOMP_RE.test(r.selection_method_description||"")) flags.push({lvl:"soon",t:`⚑ non-competitive method: ${escUiHtml(cleanText(r.selection_method_description))}`});
  const facts=await noticeContextFacts(r);
  if(r.type_of_notice_description==="Solicitation"&&r.due_date&&r.start_date){
    const w=Math.round((new Date(r.due_date)-new Date(r.start_date))/86400000);
    if(w>0&&w<=10&&facts?.agency_ad_median_days&&w<facts.agency_ad_median_days/2) flags.push({lvl:"hot",t:`⚑ short ad window: ${w} day${w===1?"":"s"} (agency median ${facts.agency_ad_median_days})`});
  }
  if(r.type_of_notice_description==="Award"&&r.vendor_name&&facts?.vendor_award_count_90d>=3){
    const n=facts.vendor_award_count_90d;
    flags.push({lvl:"soon",t:`⚑ ${ordinal(n)} award to this vendor at this agency in 90 days`});
  }
  return flags;
}
async function awardContext(r){
  if(!r||r.type_of_notice_description!=="Award"||!r.agency_name)return "";const X=+r.contract_amount;if(!X||X<=0||X>=MONEY_HONESTY_CAP)return "";const bits=[];
  const facts=await noticeContextFacts(r);const awardsCount=facts?.agency_award_count_12m||0;if(awardsCount>=20)bits.push(`larger than <b>${Math.round(((facts?.agency_awards_at_or_below||0)/awardsCount)*100)}%</b> of this agency's awards (last 12 mo, n=${awardsCount.toLocaleString()})`);
  if(r.vendor_name&&facts?.vendor_award_total_12m>0){const share=Math.round((facts.vendor_award_total_12m/(facts.agency_award_total_12m||0))*100);if(share>=1)bits.push(`this vendor holds <b>${share}%</b> of the agency's award $ (12 mo)`);}
  if(!bits.length)return "";return `<div class="glance" style="border-inline-start-color:var(--amber)"><div class="gl"><b>${t("context_strip_lbl")}</b><span>${bits.join(" · ")}</span></div></div>`;
}
function timedContextBranch(label,work){
  noticeContextTimingMark(`${label}-start`);
  return Promise.resolve().then(work).then(value=>{
    noticeContextTimingMark(`${label}-end`);
    noticeContextTimingMeasure(label);
    return value;
  },error=>{
    noticeContextTimingMark(`${label}-end`);
    noticeContextTimingMeasure(label);
    throw error;
  });
}
function parcelLinksHTML(links,provenanceKey,displayBbl=links.bbl){if(!links)return "";return `<div class="rmeta2 property-parcel-links" style="margin:8px 0">${t("parcel_elsewhere_label")} <a href="${escUiHtml(links.zola_url)}" ${EXT_ATTRS}>${t("parcel_link_zola")}${extSR()}</a> · <a href="${escUiHtml(links.acris_url)}" ${EXT_ATTRS}>${t("parcel_link_acris")}${extSR()}</a> · <a href="${escUiHtml(links.who_owns_what_url)}" ${EXT_ATTRS}>${t("parcel_link_wow")}${extSR()}</a> <span class="muted" style="font-size:12px">· ${t(provenanceKey,{bbl:displayBbl})}</span></div>`;}
async function fillAddressLinks(r,el){
  if(!el||!r)return;let geo=null;if(goodAddr(r.street_address_1)){const addr=cleanText(r.street_address_1);try{geo=await geocodeAddressText(addr+" New York NY");}catch(e){}}
  if(!document.contains(el))return;if(geo&&geo.bbl&&/^\d{10}$/.test(geo.bbl)){const tools=await propertyLocationTools();if(!document.contains(el))return;const links=tools.parcelLinksFromBbl(geo.bbl);if(links){el.innerHTML=parcelLinksHTML(links,"parcel_via_pad_snapshot",tools.bblReaderLabel(geo.bbl));return;}}
  if(r.section_name!=="Property Disposition")return;const tools=await propertyLocationTools();if(!document.contains(el))return;const location=tools.propertyLocationFromRow(r),bbl=tools.primaryPropertyBbl(location),links=tools.parcelLinksFromBbl(bbl);if(!links||location.scope!=="local")return;el.innerHTML=`${propertyPlaceChips(location)}${parcelLinksHTML(links,"parcel_via_notice_tax_lot",tools.bblReaderLabel(bbl))}`;
}
function attachmentExtractHTML(attachment){const text=String(attachment?.extracted_text||"").trim();if(!text||attachment.text_status&&attachment.text_status!=="ok")return "";const preview=String(attachment.text_preview||text.split(/\n+/).filter(Boolean).slice(0,4).join(" · ")).trim(),previewShort=preview.length>280?preview.slice(0,277).trimEnd()+"…":preview;return `<details class="attachment-extract inline-disclose" style="margin:6px 0 2px"><summary class="attachment-extract-summary" style="font:12px/1.55 ui-sans-serif,system-ui,sans-serif;color:var(--muted);cursor:pointer"><span class="attachment-extract-label">${escUiHtml(t("notice_attachment_extract_summary"))}</span><span class="attachment-extract-preview" lang="en" dir="ltr" style="display:block;margin-top:2px;color:var(--ink)">“${escUiHtml(previewShort)}”</span></summary><div class="attachment-extract-body inline-disclose-body scope" lang="en" dir="ltr" style="margin-top:8px;white-space:pre-wrap;font:13px/1.55 ui-sans-serif,system-ui,sans-serif;max-height:22rem;overflow:auto">${escUiHtml(text.slice(0,50000))}${text.length>50000?"…":""}</div></details>`;}
let attachmentTablesToolsPromise=null;
async function attachmentTablesTools(){if(!attachmentTablesToolsPromise)attachmentTablesToolsPromise=import("../attachment_tables_ui.mjs").catch(()=>null);return attachmentTablesToolsPromise;}
function attachmentHasTablesHint(attachment){const tables=Array.isArray(attachment?.extracted_tables)?attachment.extracted_tables:[];return tables.length>0&&(!attachment.tables_status||attachment.tables_status==="ok");}
async function attachmentTablesHTMLFor(r){const attachments=Array.isArray(r?.attachments)?r.attachments:[],first=attachments.find(a=>a&&a.url)||null;if(!first||!attachmentHasTablesHint(first))return "";const tools=await attachmentTablesTools();return tools?tools.attachmentTablesHTML(first,{t,esc:escUiHtml}):"";}
function attachmentChipHTML(r){if((r.section_name||r.section)==="Changes in Personnel")return "";const attachments=Array.isArray(r.attachments)?r.attachments.filter(a=>a&&a.url):[];if(!attachments.length)return "";const first=attachments[0],rawTitle=String(first.title||t("notice_attachment_title_fallback")).replace(/\s+/g," ").trim(),title=rawTitle.length>108?rawTitle.slice(0,105).trimEnd()+"…":rawTitle,label=tn("notice_attachment_chip",attachments.length,{title}),extract=attachmentExtractHTML(first),tablesHost=attachmentHasTablesHint(first)?`<div class="attachment-tables-host" data-attachment-tables-host="1"></div>`:"";return `<div class="attachment-panel" style="margin:6px 0 4px">${officialSourceLink({ href: first.url, label: `${label} · ${t("view_in_city_record")}`, className: "attachment-source-link", escape: escUiHtml })}${extract}${tablesHost}</div>`;}
let attachmentRelatedToolsPromise=null;
async function attachmentRelatedTools(){if(!attachmentRelatedToolsPromise)attachmentRelatedToolsPromise=import("../attachment_related.mjs").catch(()=>null);return attachmentRelatedToolsPromise;}
async function attachmentRelatedHTMLFor(r){if(!r||!r.request_id)return "";const hasAttach=Array.isArray(r.attachments)&&r.attachments.some(a=>a&&(a.url||a.extracted_text));if(!hasAttach)return "";const tools=await attachmentRelatedTools();if(!tools)return "";let artifact=null;if(r.related_by_attachment&&Array.isArray(r.related_by_attachment.related))artifact={by_notice:{[String(r.request_id)]:{related:r.related_by_attachment.related}}};else artifact=await tools.loadAttachmentRelatedLookup();return artifact?tools.attachmentRelatedHTML(artifact,r.request_id,{t,esc:escUiHtml}):"";}
/* Public mandate backlinks (precompute-first). Empty-safe: no request when the
   notice id is absent; no absence announcement when the lookup has no match.
   Skip when the edge already stamped the same card so hydration cannot duplicate. */
let mandateBacklinksToolsPromise=null;
let mandateBacklinksLookupPromise=null;
function mandateBacklinksTools(){if(!mandateBacklinksToolsPromise)mandateBacklinksToolsPromise=import("../notice_mandate_backlinks.mjs").catch(()=>null);return mandateBacklinksToolsPromise;}
function loadMandateBacklinksLookup(){if(!mandateBacklinksLookupPromise)mandateBacklinksLookupPromise=fetch("data/notice_mandate_backlinks_lookup.json",{cache:"no-cache",credentials:"omit"}).then(r=>r&&r.ok?r.json():null).catch(()=>null);return mandateBacklinksLookupPromise;}
async function mandateBacklinksHTMLFor(r){
  if(!r||!r.request_id)return "";
  // Edge first paint may already own the card; do not double-mount.
  if(document.querySelector("#noticeview [data-connected-mandate='1']"))return "";
  const tools=await mandateBacklinksTools();
  if(!tools)return "";
  const lookup=await loadMandateBacklinksLookup();
  if(!lookup)return "";
  return tools.renderNoticeMandateBacklinksForId(lookup,r.request_id,{esc:escUiHtml})||"";
}
const CONTEXT_SLOTS=["mandate","related","flags","award"];
function contextSlotsHTML(){return CONTEXT_SLOTS.map(slot=>`<span data-notice-context-slot="${slot}"></span>`).join("");}
function contextSlot(el,slot,html){
  if(!html||!document.contains(el))return;
  const host=el.querySelector(`[data-notice-context-slot="${slot}"]`);
  if(host)host.outerHTML=html;
  else el.insertAdjacentHTML("beforeend",html);
}
async function hydrateNoticeAttachments(r,el){
  if(!r||!el||!Array.isArray(r.attachments)||!r.attachments.length||!document.contains(el))return;
  const attachmentHTML=attachmentChipHTML(r);
  const alreadyPainted=Boolean(el.querySelector(".attachment-panel"));
  if(attachmentHTML&&!alreadyPainted){
    const firstSlot=el.querySelector("[data-notice-context-slot]");
    if(firstSlot)firstSlot.insertAdjacentHTML("beforebegin",attachmentHTML);
    else el.insertAdjacentHTML("afterbegin",attachmentHTML);
  }
  // fillContext owns the initial attachment render when the row already carried
  // attachment data; do not duplicate its related/table branches on late resolve.
  if(alreadyPainted)return;
  const relatedHTML=await attachmentRelatedHTMLFor(r);
  contextSlot(el,"related",relatedHTML);
  const tablesHTML=await attachmentTablesHTMLFor(r);
  if(!tablesHTML||!document.contains(el))return;
  const host=el.querySelector("[data-attachment-tables-host]");
  if(host)host.outerHTML=tablesHTML;
  else if(el.querySelector(".attachment-panel"))el.querySelector(".attachment-panel").insertAdjacentHTML("beforeend",tablesHTML);
  const tools=await attachmentTablesTools();
  if(tools&&document.contains(el))tools.bindAttachmentTableSort(el);
}
function contextReady(el,resultState){
  if(!document.contains(el))return;
  el.dataset.noticeContextReady="true";
  el.dataset.noticeContextResult=resultState;
  noticeContextTimingMark("first-ready");
  noticeContextReady(runtimeRumSemanticMilestones(),{resultState});
}
async function fillContext(r,el,settledWith=[]){
  if(!el)return;
  // Primary owner: the context host, plus any attachment chip already on the
  // notice row. Optional flags/award/related/mandate/table work, lookup, and
  // late attachment hydration must not gate this milestone.
  try{
    const attachmentHTML=attachmentChipHTML(r);
    el.innerHTML=attachmentHTML+contextSlotsHTML();
    contextReady(el,noticeContextPrimaryResultState(Boolean(attachmentHTML)));
  }catch{
    contextReady(el,"error");
    return;
  }

  // Keep all optional owners independent: one rejected import/fetch must not prevent
  // the remaining context cards from arriving. Their final settled marker is the
  // content-parity harness boundary, not the component-ready boundary above.
  const optionalWork={
    flags:()=>noticeFlags(r).then(flags=>{
      if(flags.length)contextSlot(el,"flags",`<div style="margin:6px 0 4px">${flags.map(f=>`<span class="tag ${f.lvl}" style="margin-bottom:4px">${f.t}</span>`).join(" ")}</div>`);
    }),
    award:()=>awardContext(r).then(ctx=>contextSlot(el,"award",ctx)),
    related:()=>attachmentRelatedHTMLFor(r).then(relatedHTML=>contextSlot(el,"related",relatedHTML)),
    mandate:()=>mandateBacklinksHTMLFor(r).then(mandateHTML=>contextSlot(el,"mandate",mandateHTML)),
    tables:()=>attachmentTablesHTMLFor(r).then(async tablesHTML=>{
      if(!tablesHTML||!document.contains(el))return;
      const host=el.querySelector("[data-attachment-tables-host]");
      if(host)host.outerHTML=tablesHTML;
      else if(el.querySelector(".attachment-panel"))el.querySelector(".attachment-panel").insertAdjacentHTML("beforeend",tablesHTML);
      const tools=await attachmentTablesTools();
      if(tools&&document.contains(el))tools.bindAttachmentTableSort(el);
    }),
  };
  const settled=NOTICE_CONTEXT_OPTIONAL_BRANCHES.map(branch=>timedContextBranch(branch,optionalWork[branch]).catch(()=>{}));
  const additionalSettled=Array.isArray(settledWith)?settledWith:[settledWith];
  Promise.allSettled([...settled,...additionalSettled]).then(()=>{
    if(document.contains(el)){
      el.dataset.noticeContextSettled="true";
      noticeContextTimingMark("settled");
    }
  });
}
async function externalAwardForNotice(r,el){if(!el)return;const cov=awardCoverage(r.agency_name);if(cov==="absent"||cov==="unknown")return;const resp=await loadExternalAward({id:r.request_id});if(!document.contains(el)||!resp)return;el.innerHTML=externalAwardHTML(resp,r);const offerBtn=el.querySelector("[data-award-watch-offer]");if(offerBtn)offerBtn.addEventListener("click",async()=>{const carry=await import("../alerts_context_carry.mjs").catch(()=>null);const scope=carry?.alertScopeFromNotice({...r,kind:"award"});location.assign(scope?carry.alertsHref(scope):"/following/");});}

Object.assign(globalThis,{SECTION_LENS,NONCOMP_RE,yearCut,ordinal,noticeFlags,awardContext,parcelLinksHTML,fillAddressLinks,attachmentExtractHTML,attachmentTablesHTMLFor,attachmentChipHTML,attachmentRelatedHTMLFor,hydrateNoticeAttachments,mandateBacklinksHTMLFor,fillContext,externalAwardForNotice});
