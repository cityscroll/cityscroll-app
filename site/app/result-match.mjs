import { landProjectDisplayTitle, noticeDisplayTitle } from "../display_title.mjs";

// Shared result and digest-preview presentation. This stays on reading routes; the
// much larger watch builder in alerts.mjs is a Following-only legacy island.
function locateAnyTerm(text, terms){
  const hay=String(text||"").toLowerCase(); let best=null;
  for(const term of terms){
    const needle=String(term||"").trim(); if(!needle) continue;
    const idx=hay.indexOf(needle.toLowerCase());
    if(idx!==-1 && (best===null || idx<best.index)) best={term:needle, index:idx};
  }
  return best;
}
function matchEvidence(title, description, terms, contextTerms, attachmentText){
  const words=(terms||[]).filter(Boolean);
  const context=(contextTerms||[]).filter(Boolean);
  const all=[...words, ...context];
  if(!all.length) return null;
  const inTitle=locateAnyTerm(title, all);
  if(inTitle) return {field:"title", term:inTitle.term, index:inTitle.index};
  const text=String(description||"");
  const inDesc=locateAnyTerm(text, all);
  if(inDesc){
    const RADIUS=70, start=Math.max(0,inDesc.index-RADIUS), end=Math.min(text.length, inDesc.index+inDesc.term.length+RADIUS);
    return { field:"description", term:inDesc.term,
      before:(start>0?"…":"")+text.slice(start,inDesc.index),
      hit:text.slice(inDesc.index, inDesc.index+inDesc.term.length),
      after:text.slice(inDesc.index+inDesc.term.length, end)+(end<text.length?"…":"") };
  }
  const attach=String(attachmentText||"");
  const inAttach=locateAnyTerm(attach, all);
  if(inAttach){
    const RADIUS=70, start=Math.max(0,inAttach.index-RADIUS), end=Math.min(attach.length, inAttach.index+inAttach.term.length+RADIUS);
    return { field:"attachment-text", provenance:"attachment-text", term:inAttach.term,
      before:(start>0?"…":"")+attach.slice(start,inAttach.index),
      hit:attach.slice(inAttach.index, inAttach.index+inAttach.term.length),
      after:attach.slice(inAttach.index+inAttach.term.length, end)+(end<attach.length?"…":"") };
  }
  if(!words.length) return null;
  return {field:"unknown", term:words[0]};
}
function matchText(r){
  return [cleanText(r.additional_description_1), cleanText(r.other_info_1)].filter(Boolean).join(" ");
}
function matchAttachmentText(r){
  if(r.attachment_text) return cleanText(r.attachment_text);
  const attachments = Array.isArray(r.attachments) ? r.attachments : [];
  const textParts = attachments.map(a=>cleanText(a && a.extracted_text)).filter(Boolean);
  const tableParts = attachments.flatMap(a=>{
    const tables = Array.isArray(a && a.extracted_tables) ? a.extracted_tables : [];
    return tables.flatMap(t=>[...(t.headers||[]), ...(t.rows||[]).flat()].map(c=>cleanText(c)).filter(Boolean));
  });
  return [...textParts, ...tableParts].join(" ");
}
function digTitleHTML(title, ev){
  if(!title) return t("rule_sibling_role_notice");
  const esc=v=>String(v==null?"":v).replace(/[<>&'"]/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;","'":"&#39;",'"':"&quot;"}[c]));
  if(!ev || ev.field!=="title") return enTitle(esc(title));
  const before=title.slice(0,ev.index), hit=title.slice(ev.index, ev.index+ev.term.length), after=title.slice(ev.index+ev.term.length);
  return enTitle(`${esc(before)}<mark>${esc(hit)}</mark>${esc(after)}`);
}
function digEvidenceHTML(ev){
  if(!ev || ev.field==="title") return "";
  const esc=v=>String(v==null?"":v).replace(/[<>&'"]/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;","'":"&#39;",'"':"&quot;"}[c]));
  if(ev.field==="description") return `<div class="dev">${t("digest_match_snippet_html",{snippet:`${esc(ev.before)}<mark>${esc(ev.hit)}</mark>${esc(ev.after)}`})}</div>`;
  if(ev.field==="attachment-text" || ev.field==="attachment-tables") return `<div class="dev" data-match-provenance="${esc(ev.field)}">${t("digest_match_attachment_html",{snippet:`${esc(ev.before)}<mark>${esc(ev.hit)}</mark>${esc(ev.after)}`})}</div>`;
  return `<div class="dev">${t("digest_match_unknown_html",{term:`<mark>${esc(ev.term)}</mark>`})}</div>`;
}
function digContact(r){
  const tel=String(r.contact_phone||"").replace(/[^0-9+]/g,""); const parts=[];
  if(r.contact_name) parts.push(cleanText(r.contact_name));
  if(r.email) parts.push(`<a href="mailto:${r.email}">${r.email}</a>`);
  if(tel.length>=7) parts.push(`<a href="tel:${tel}">${cleanText(r.contact_phone)}</a>`);
  return parts.length?`<div class="dc">${parts.join(" · ")}</div>`:"";
}
let digAwarenessToolsPromise = null;
function ensureDigAwarenessTools(){
  if(!digAwarenessToolsPromise) digAwarenessToolsPromise = import("../digest_item_awareness.mjs").catch(()=>null);
  return digAwarenessToolsPromise;
}
function digAwarenessKind(kind, r){
  if(kind==="rfp"||kind==="award"||kind==="rezone"||kind==="rules"||kind==="meetings"||kind==="property") return kind;
  if(kind==="notice"){
    const section=String(r.section_name||""), type=String(r.type_of_notice_description||"");
    if(section==="Agency Rules") return "rules";
    if(section==="Property Disposition") return "property";
    if(section==="Public Hearings and Meetings"||/hearing|meeting/i.test(type)) return "meetings";
    if(type==="Solicitation") return "rfp";
    if(/Award|Intent to Negotiate|Vendor List/i.test(type)) return "award";
  }
  return kind||null;
}
function digAwarenessHTML(kind, r, tools){
  if(!tools||typeof tools.itemAwarenessHtml!=="function") return "";
  const esc=v=>String(v==null?"":v).replace(/[<>&'"]/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;","'":"&#39;",'"':"&quot;"}[c]));
  const lang=(typeof window!=="undefined"&&window.LANG)||"en";
  const html=tools.itemAwarenessHtml(r, esc, lang, {kind:digAwarenessKind(kind,r),today:todayISO()});
  return html?`<div class="dig-awareness">${html}</div>`:"";
}
function digItemHTML(kind, r, keywords, awarenessTools){
  if(kind==="exam"){
    const band=CrolStaffing.openWindowBand(r,careerToday());
    const meta=[t("career_exam_number",{number:r.exam_number}),r.application_start&&r.application_end?`${r.application_start}–${r.application_end}`:"",band].filter(Boolean).join(" · ");
    const examLink = CrolStaffing.examUrl(r.exam_number, location.origin);
    return `<div class="digitem"><div class="dt"><a href="${examLink}">${escUiHtml(r.title||"")}</a></div><div class="dm" lang="en" dir="ltr">${escUiHtml(meta)}</div>${r.notice_url?`<div class="da" lang="en" dir="ltr">NOE posted</div>`:""}<div class="dc"><a href="${examLink}">${t("view_on_crol")}</a></div></div>`;
  }
  const aw=digAwarenessHTML(kind,r,awarenessTools);
  if(kind==="award"){
    const title=noticeDisplayTitle(r), ev=matchEvidence(title,matchText(r),keywords,null,matchAttachmentText(r));
    return `<div class="digitem"><div class="dt"><a href="#notice/${encodeURIComponent(r.request_id)}">${digTitleHTML(title,ev)}</a></div><div class="dm">${escUiHtml(r.agency_name)} · ${fdate(r.start_date)}${r.vendor_name?" · "+escUiHtml(cleanText(r.vendor_name)):""}</div>${aw}${digEvidenceHTML(ev)}<div class="da">${money(r.contract_amount)||""}</div>${digContact(r)}</div>`;
  }
  if(kind==="notice"){
    const title=noticeDisplayTitle(r), ev=matchEvidence(title,matchText(r),keywords,null,matchAttachmentText(r));
    const meta=[r.agency_name,r.type_of_notice_description,fdate(r.start_date),r.event_date?t("event_meta",{date:fdate(r.event_date)}):""].filter(Boolean).join(" · ");
    return `<div class="digitem"><div class="dt">${digTitleHTML(title,ev)}</div><div class="dm">${meta}</div>${aw}${digEvidenceHTML(ev)}<div class="dc"><a href="#notice/${encodeURIComponent(r.request_id)}">${t("view_on_crol")}</a></div></div>`;
  }
  if(kind==="rfp"){
    const dl=daysLeft(r.due_date), rolling=isRollingDeadline(r.due_date);
    const title=noticeDisplayTitle(r), ev=matchEvidence(title,matchText(r),keywords,null,matchAttachmentText(r));
    const tel=String(r.contact_phone||"").replace(/[^0-9+]/g,""); const acts=[];
    if(r.email) acts.push(`<a href="${mailtoFor(r)}"><b>${t("respond_lbl")}</b></a>`,`<a href="mailto:${r.email}">${r.email}</a>`);
    if(tel.length>=7) acts.push(`<a href="tel:${tel}">${cleanText(r.contact_phone)}</a>`);
    const dc=acts.length?`<div class="dc">${acts.join(" · ")}</div>`:"";
    const when=rolling?t("rolling_deadline_tag"):t("due_on",{date:fdt(r.due_date)})+(dl!=null?t("days_paren",{n:dl}):"");
    return `<div class="digitem"><div class="dt"><a href="#notice/${encodeURIComponent(r.request_id)}">${digTitleHTML(title,ev)}</a></div><div class="dm">${r.agency_name} · ${when}</div>${aw}${digEvidenceHTML(ev)}${dc}</div>`;
  }
  const landHref=r.project_id?`#land/${encodeURIComponent(r.project_id)}`:"#land";
  return `<div class="digitem"><div class="dt"><a href="${landHref}">${enTitle(landProjectDisplayTitle(r))}</a></div><div class="dm">${r.borough||""}${r.community_district?" · CD "+r.community_district:""} · ${r.public_status||""}${r.primary_applicant?" · "+r.primary_applicant:""}${mihOn(r.mih_flag)?" · "+t("affordable_housing_tag"):""}</div>${aw}<div class="dc"><a href="${landHref}">${t("land_dig_open_detail")}</a> · <a href="https://zap.planning.nyc.gov/projects/${r.project_id}" ${EXT_ATTRS}>${t("view_comment_zap")}${extSR()}</a></div></div>`;
}

Object.assign(globalThis,{locateAnyTerm,matchEvidence,matchText,matchAttachmentText,digTitleHTML,digEvidenceHTML,digContact,ensureDigAwarenessTools,digAwarenessKind,digAwarenessHTML,digItemHTML});
Object.defineProperty(globalThis,"digAwarenessToolsPromise",{configurable:true,get:()=>digAwarenessToolsPromise,set:value=>{digAwarenessToolsPromise=value;}});
