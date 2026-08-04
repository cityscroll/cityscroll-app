/* ===================== ALERTS ===================== */
const AKEY = "crd_alerts_v1";
// Values are i18n keys — render with t(SECTION_WATCH_LABEL[w]); truthiness still gates the lens routing.
const SECTION_WATCH_LABEL = {property:"watchlbl_property", rules:"watchlbl_rules", meetings:"watchlbl_meetings"};
// Watch types where #aparam is a free-text keyword search (vs. an entity name or place name) —
// only these can plausibly be "too sentence-like to match" in the sense card w11-12 means.
function isKeywordWatch(w){ return w === "rfpkw" || !!SECTION_WATCH_LABEL[w]; }
const AMOUNT_WORD_RE = /\$|\d|dollar|thousand|million|billion/i;
function keywordLooksSentenceLike(kw){
  const words = String(kw||"").trim().split(/\s+/).filter(Boolean);
  return words.length > 3 || AMOUNT_WORD_RE.test(kw);
}
function aStore(){ try{ return JSON.parse(localStorage.getItem(AKEY)||"[]"); }catch(e){ return []; } }
function aSet(v){ try{ localStorage.setItem(AKEY, JSON.stringify(v)); }catch(e){} }

let lastWatch = null;
// The moneynl watch type's visible fields (keywords/amount/months) cover the common case, but
// parseNL()/the model-backed /nl endpoint can recognize more of money's general schema
// (agency/category/maxAmount/noticeType) than there's a dedicated widget for. Rather than add
// new form controls for fields most alerts never need, the extras from the last NL parse are
// carried here — surfaced read-only via the "understood as" chips, folded into the stored
// filter and the live preview query, cleared whenever the watch type changes or a fresh NL
// parse applies.
let moneynlExtra = {};
// Location carried by a Meetings lens "Watch this search" handoff. It is declarative watch
// state (affected borough/neighborhood), never inferred or retained visitor coordinates.
let meetingWatchExtra = {};
// Set by the "Email me when the award registers" button on a covered-agency notice's empty
// award state (see awardWatchOfferHTML()/externalAwardForNotice()) — the one-notice target an
// "awardwatch" #awatch selection subscribes to. null until that button (or nothing, if the
// dropdown is reached manually with no notice in context) sets it.
let awardWatchTarget = null;
// Seed notice/project row for context-carrying alert entry (#alerts?notice=… / project=…).
// When set, aPreview() renders THIS item through digItemHTML (the real email-template path)
// so the reader sees exactly what would arrive. Cleared when the watch type changes.
let noticeWatchSeed = null; // { row, digKind, lens, filter }
// skipQuizSync: true only for the two bookkeeping call sites (page-init, language re-render)
// that run before/without any real user choice -- those must NOT manufacture a "topic
// picked" look in the quiz above by highlighting whichever chip happens to match #awatch's
// mandatory default value. Every real interaction (a chip click, a wandchip, a saved-search
// "Watch this" button, an NL-resolved query, or the builder's own #awatch/#afreq controls)
// calls this with no argument, so refreshQuizDisplay() runs and the two views stay in sync.
function aWatchChange(skipQuizSync){
  const w = $("#awatch").value;
  // The param means something different per watch type (place vs keyword) — switching types
  // clears it so a value never leaks from one topic into another. Each type's empty state is
  // parallel: "all matching notices", with the placeholder suggesting how to narrow.
  if(lastWatch !== null && lastWatch !== w){
    $("#aparam").value=""; $("#aagency").value="";
    $("#amoneykw").value=""; $("#amoneymin").value=""; $("#amoneymonths").value="";
    moneynlExtra = {};
    meetingWatchExtra = {};
    if(lastWatch==="awardwatch") awardWatchTarget = null; // leaving the type clears its one-notice target
    noticeWatchSeed = null; // type switch leaves the carried notice behind
    paintAlertContextLead(null);
  }
  lastWatch = w;
  $("#aagency").style.display = SECTION_WATCH_LABEL[w] ? "" : "none";
  $("#amoneyfields").style.display = w==="moneynl" ? "" : "none";
  if(w==="moneynl"){ $("#athresh").style.display="none"; $("#aparam").style.display="none"; }
  else if(w==="bigaward"){ $("#aparamlabel").textContent=t("param_label_min_award"); $("#athresh").style.display=""; $("#aparam").style.display="none"; }
  else if(w==="awardwatch"){ $("#athresh").style.display="none"; $("#aparam").style.display="none"; }
  else {
    $("#athresh").style.display="none"; $("#aparam").style.display="";
    if(w==="rfpkw"){ $("#aparamlabel").textContent=t("param_label_keyword"); $("#aparam").placeholder=t("param_placeholder_rfpkw"); }
    else if(w==="entityvendor"){ $("#aparamlabel").textContent=t("param_label_vendor"); $("#aparam").placeholder=t("param_placeholder_vendor"); }
    else if(w==="entityagency"){ $("#aparamlabel").textContent=t("param_label_agency_name"); $("#aparam").placeholder=t("param_placeholder_agency"); }
    else if(SECTION_WATCH_LABEL[w]){ $("#aparamlabel").textContent=t("param_label_keyword"); $("#aparam").placeholder=w==="rules"?t("param_placeholder_rules"):w==="meetings"?t("param_placeholder_meetings"):t("param_placeholder_property"); }
    else { $("#aparamlabel").textContent=t("param_label_place"); $("#aparam").placeholder=t("param_placeholder_rezone"); }
  }
  // w12-20: the quiz above is a second VIEW onto these same fields (see refreshQuizDisplay,
  // defined near the quiz's own event wiring below) -- every watch-type change, from either
  // view, must repaint the other so the two can never show a different draft.
  if(!skipQuizSync) refreshQuizDisplay();
}
function aDescribe(){
  const w=$("#awatch").value;
  const freq=t($("#afreq").value.toLowerCase()==="weekly" ? "freq_weekly_lc" : "freq_daily_lc");
  if(w==="bigaward") return t("desc_bigaward",{freq, amt:money($("#athresh").value)});
  if(w==="rfpkw") return t("desc_rfpkw",{freq, kw:$("#aparam").value||"…"});
  if(w==="moneynl"){
    const kw=$("#amoneykw").value.trim(), minRaw=$("#amoneymin").value.trim(), moRaw=$("#amoneymonths").value.trim();
    const bits=[
      kw ? t("desc_moneynl_about",{kw}) : "",
      minRaw ? t("desc_moneynl_over",{amt:money(Number(minRaw))||minRaw}) : "",
      moRaw ? tn("desc_moneynl_due", Number(moRaw)||1) : "",
    ].filter(Boolean).join("");
    return t("desc_moneynl", {freq, bits: bits || t("desc_moneynl_any")});
  }
  if(w==="entityvendor") return t("desc_vendor",{freq, name:$("#aparam").value.trim()||"…"});
  if(w==="entityagency") return t("desc_agency_watch",{freq, name:$("#aparam").value.trim()||"…"});
  if(w==="awardwatch") return t("desc_awardwatch",{freq, label:(awardWatchTarget&&(awardWatchTarget.label||awardWatchTarget.agency))||"…"});
  if(SECTION_WATCH_LABEL[w]){
    const location=w==="meetings"
      ? (meetingWatchExtra.neighborhood||meetingWatchExtra.borough||(meetingWatchExtra.locationScope?t("citywide_unlocated"):""))
      : "";
    const bits=[$("#aparam").value.trim()?t("desc_matching",{kw:$("#aparam").value.trim()}):"", $("#aagency").value.trim()?t("desc_from_agency",{agency:$("#aagency").value.trim()}):"", location?t("desc_affecting_area",{area:location}):""].filter(Boolean).join("");
    return t("desc_section",{freq, what:t(SECTION_WATCH_LABEL[w]), bits});
  }
  const place=$("#aparam").value.trim();
  return place ? t("desc_rezone_near",{freq, place}) : t("desc_rezone_city",{freq});
}
// When the digest actually goes out. Cron is "0 13 * * *" (13:00 UTC daily); weekly fires only on
// Mondays. 13:00 UTC = around 9 a.m. in New York during EDT, 8 a.m. during EST — hence the winter note.
function aWhenText(){
  return $("#afreq").value.toLowerCase()==="weekly"
    ? t("when_weekly")
    : t("when_daily");
}
function updateAWhen(){ const el=$("#awhen"); if(el) el.textContent=aWhenText(); }

async function aFetch(){
  const w=$("#awatch").value;
  if(w==="entityvendor"){
    const stem=vendorStem($("#aparam").value.trim());
    if(stem.length<3) return {kind:"notice", rows:[]};
    // $q, not a stem-prefix LIKE — mirrors the worker's compileSub (punctuated vendors never
    // prefix-match their own stem); the exact-stem filter keeps precision.
    const rows=await soda({"$select":SELECT,"$where":"vendor_name IS NOT NULL","$q":stem,"$order":"start_date DESC","$limit":"25"});
    return {kind:"notice", rows: rows.filter(r=>vendorStem(r.vendor_name)===stem).slice(0,5)};
  }
  if(w==="entityagency"){
    const nm=$("#aparam").value.trim();
    if(!nm) return {kind:"notice", rows:[]};
    return {kind:"notice", rows: await soda({"$select":SELECT,"$where":`agency_name='${nm.replace(/'/g,"''")}'`,"$order":"start_date DESC","$limit":"5"})};
  }
  if(SECTION_WATCH_LABEL[w]){
    // Mirrors the worker's compileSub() for these lenses, so the preview matches the digest.
    let where=w==="meetings"
      ? "(section_name='Public Hearings and Meetings' OR (section_name='Agency Rules' AND type_of_notice_description='Public Hearings' AND event_date IS NOT NULL))"
      : `section_name='${SECTIONS[w].section}'`, order="start_date DESC";
    if(w==="meetings"){
      where+=` AND event_date > '${todayISO()}'`;
      const end=hearingDateWindowEnd(todayISO(),meetingWatchExtra.dateWindow);
      if(end) where+=` AND event_date <= '${end}T23:59:59'`;
      order="event_date ASC";
    }
    const ag=$("#aagency").value.trim(); if(ag) where+=` AND agency_name='${ag.replace(/'/g,"''")}'`;
    const p={"$select":FEED_SELECT,"$where":where,"$order":order,"$limit":"5"};
    if($("#aparam").value.trim()) p["$q"]=$("#aparam").value.trim();
    let rows=await soda(p);
    if(w==="meetings"&&(meetingWatchExtra.borough||meetingWatchExtra.neighborhood||meetingWatchExtra.locationScope)){
      rows=rows.filter(row=>hearingMatchesArea(normalizeHearingRow(row),meetingWatchExtra));
    }
    return { kind:"notice", rows };
  }
  if(w==="bigaward"){
    const t=$("#athresh").value;
    return { kind:"award", rows: await soda({"$select":SELECT,"$where":`type_of_notice_description='Award' AND contract_amount >= ${t} AND contract_amount < ${MONEY_HONESTY_CAP}`,"$order":"start_date DESC","$limit":"5"}) };
  }
  if(w==="rfpkw"){
    const p={"$select":SELECT,"$where":`type_of_notice_description='Solicitation' AND due_date > '${todayISO()}'`,"$order":"due_date ASC","$limit":"5"};
    if($("#aparam").value.trim()) p["$q"]=$("#aparam").value.trim();
    return { kind:"rfp", rows: await soda(p) };
  }
  if(w==="moneynl"){
    // Mirrors the worker's compileSub() money-lens branch exactly (same field set, same
    // award-vs-solicitation rule), so the preview matches the digest a subscriber gets.
    const kw=$("#amoneykw").value.trim(), minAmt=Number($("#amoneymin").value)||0, months=Number($("#amoneymonths").value)||0;
    const {agency=null, category=null, maxAmount=null, noticeType=null} = moneynlExtra;
    const catClause = category ? ` AND category_description='${category.replace(/'/g,"''")}'` : "";
    const agClause = agency ? ` AND agency_name='${agency.replace(/'/g,"''")}'` : "";
    const wantsAward = noticeType==="award" || (!noticeType && minAmt>=1000);
    if(wantsAward){
      let where=`type_of_notice_description='Award' AND contract_amount >= ${minAmt||1} AND contract_amount < ${MONEY_HONESTY_CAP}`;
      if(maxAmount) where+=` AND contract_amount <= ${maxAmount}`;
      return { kind:"award", rows: await soda({"$select":SELECT,"$where":where+catClause+agClause,"$order":"start_date DESC","$limit":"5"}) };
    }
    let where=`type_of_notice_description='Solicitation' AND due_date > '${todayISO()}'`;
    if(months) where+=` AND due_date <= '${addMonthsISO(todayISO(), months)}'`;
    const p={"$select":SELECT,"$where":where+catClause+agClause,"$order":"due_date ASC","$limit":"5"};
    if(kw) p["$q"]=kw;
    return { kind:"rfp", rows: await soda(p) };
  }
  const zp={"$select":"project_id,project_name,project_brief,primary_applicant,public_status,borough,community_district,mih_flag,current_milestone_date",
    "$where":"ulurp_non='ULURP'","$order":"current_milestone_date DESC","$limit":"5"};
  const REZ_ALIAS={"79 rivington":"Allen Street","79 rivington street":"Allen Street","allen street mall":"Allen Street"};
  const qv=$("#aparam").value.trim(), qq=REZ_ALIAS[qv.toLowerCase()]||qv;
  if(qq) zp["$q"]=qq;
  return { kind:"rezone", rows: await api(ZAP, zp) };
}

// ---- why-match evidence: show why a keyword search notice is in the preview ---------------
// Mirrors worker/src/lib/digest.mjs's matchEvidence() -- the preview must show evidence for
// the same reason the emailed digest does. Observed failure: a search for "education" surfaced
// a Comptroller pension-fund notice -- "NOS - Equity Index Investment Management Products" --
// with nothing visible explaining the match; the hit was buried in the notice's description,
// which names the Board of Education Retirement System, one of the funds the notice covers.
// The same mechanism (matchEvidence()/digTitleHTML()/digEvidenceHTML(), rendered via i18n.js's
// "Matched: ..." string) is reused by moneyRowHTML()/landRowHTML()/feedCardHTML()/roleRowHTML()/
// personRowHTML() below, so every lens result list -- not just this Alerts preview -- carries
// the same why-match explanation.
function locateAnyTerm(text, terms){
  const hay=String(text||"").toLowerCase(); let best=null;
  for(const term of terms){
    const needle=String(term||"").trim(); if(!needle) continue;
    const idx=hay.indexOf(needle.toLowerCase());
    if(idx!==-1 && (best===null || idx<best.index)) best={term:needle, index:idx};
  }
  return best;
}
// Returns null when there are no keywords to explain (amount/name-only watches). Otherwise:
//   {field:"title", term, index}                     -- highlight the term in the title
//   {field:"description", term, before, hit, after}   -- a one-line snippet, term emphasized
//   {field:"unknown", term}                           -- matched via a field the preview
//     doesn't fetch (SODA's $q also searches columns like contact/method fields) -- name the
//     term rather than showing the notice with nothing explaining it.
// contextTerms (w12-09): terms that describe the query but were never sent to SODA as a $q
// text search -- e.g. Land's borough, applied as a structured `borough=` filter, not a keyword
// hit. A row's borough is already shown plainly in its own metadata line, so there's nothing
// hidden to explain the way a buried keyword hit is -- contextTerms therefore never fall
// through to the "unknown" guess (that fallback's whole premise is "SODA's $q matched
// somewhere we didn't fetch," which never happened for a structured filter). They only ever
// surface real evidence: found in the visible text, or nothing rendered at all.
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
  // T1: extracted attachment text is part of the search index (provenance attachment-text).
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
// matchText: the fuller haystack for a City Record row's match evidence. additional_description_1
// is sometimes blank even when the notice has real explanatory text -- request_id 20260709010 (a
// DYCD COMPASS afterschool-program award) carries its whole rationale in other_info_1 instead, so
// a real "childcare"/"afterschool" hit there was falling through to the unnamed "matched via a
// field this preview doesn't fetch" case. Concatenating both fields is what lets matchEvidence()
// find and quote the actual text.
function matchText(r){
  return [cleanText(r.additional_description_1), cleanText(r.other_info_1)].filter(Boolean).join(" ");
}
function matchAttachmentText(r){
  if(r.attachment_text) return cleanText(r.attachment_text);
  const attachments = Array.isArray(r.attachments) ? r.attachments : [];
  return attachments.map(a=>cleanText(a && a.extracted_text)).filter(Boolean).join(" ");
}
// digTitleHTML: the item's title, term <mark>-highlighted when the TITLE is what matched.
// ev.index is an offset into the cleaned (decoded) title. Escape text slices once so a notice
// that carried &lt;script&gt; cannot inject after cleanText decodes entities.
function digTitleHTML(title, ev){
  if(!title) return t("untitled");
  const esc=v=>String(v==null?"":v).replace(/[<>&'"]/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;","'":"&#39;",'"':"&quot;"}[c]));
  if(!ev || ev.field!=="title") return enTitle(esc(title));
  const before=title.slice(0,ev.index), hit=title.slice(ev.index, ev.index+ev.term.length), after=title.slice(ev.index+ev.term.length);
  return enTitle(`${esc(before)}<mark>${esc(hit)}</mark>${esc(after)}`);
}
// digEvidenceHTML: a one-line "why this matched" note for a match NOT in the title.
function digEvidenceHTML(ev){
  if(!ev || ev.field==="title") return "";
  const esc=v=>String(v==null?"":v).replace(/[<>&'"]/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;","'":"&#39;",'"':"&quot;"}[c]));
  if(ev.field==="description") return `<div class="dev">${t("digest_match_snippet_html",{snippet:`${esc(ev.before)}<mark>${esc(ev.hit)}</mark>${esc(ev.after)}`})}</div>`;
  if(ev.field==="attachment-text") return `<div class="dev" data-match-provenance="attachment-text">${t("digest_match_attachment_html",{snippet:`${esc(ev.before)}<mark>${esc(ev.hit)}</mark>${esc(ev.after)}`})}</div>`;
  return `<div class="dev">${t("digest_match_unknown_html",{term:`<mark>${esc(ev.term)}</mark>`})}</div>`;
}
function digContact(r){
  const tel=String(r.contact_phone||"").replace(/[^0-9+]/g,""); const parts=[];
  if(r.contact_name) parts.push(cleanText(r.contact_name));
  if(r.email) parts.push(`<a href="mailto:${r.email}">${r.email}</a>`);
  if(tel.length>=7) parts.push(`<a href="tel:${tel}">${cleanText(r.contact_phone)}</a>`);
  return parts.length?`<div class="dc">${parts.join(" · ")}</div>`:"";
}
// Shared with worker email HTML: phase / open|closing-soon|closed + next-action rail.
// Loaded once via dynamic import (same pattern as alerts_rollup_prefs.mjs).
let digAwarenessToolsPromise = null;
function ensureDigAwarenessTools(){
  if(!digAwarenessToolsPromise){
    digAwarenessToolsPromise = import("../digest_item_awareness.mjs").catch(()=>null);
  }
  return digAwarenessToolsPromise;
}
/** Map aFetch preview kind → awareness digest kind (rules/meetings arrive as "notice"). */
function digAwarenessKind(kind, r){
  if(kind==="rfp"||kind==="award"||kind==="rezone"||kind==="rules"||kind==="meetings"||kind==="property") return kind;
  if(kind==="notice"){
    const section=String(r.section_name||"");
    const type=String(r.type_of_notice_description||"");
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
  const html=tools.itemAwarenessHtml(r, esc, lang, {
    kind: digAwarenessKind(kind, r),
    today: todayISO(),
  });
  return html?`<div class="dig-awareness">${html}</div>`:"";
}
function digItemHTML(kind, r, keywords, awarenessTools){
  const aw=digAwarenessHTML(kind, r, awarenessTools);
  if(kind==="award"){
    const title=cleanText(r.short_title), ev=matchEvidence(title, matchText(r), keywords, null, matchAttachmentText(r));
    return `<div class="digitem"><div class="dt"><a href="#notice/${encodeURIComponent(r.request_id)}">${digTitleHTML(title, ev)}</a></div>
    <div class="dm">${escUiHtml(r.agency_name)} · ${fdate(r.start_date)}${r.vendor_name? " · "+escUiHtml(cleanText(r.vendor_name)):""}</div>
    ${aw}
    ${digEvidenceHTML(ev)}
    <div class="da">${money(r.contract_amount)||""}</div>${digContact(r)}</div>`;
  }
  if(kind==="notice"){
    const title=cleanText(r.short_title), ev=matchEvidence(title, matchText(r), keywords, null, matchAttachmentText(r));
    const meta=[r.agency_name, r.type_of_notice_description, fdate(r.start_date), r.event_date?t("event_meta",{date:fdate(r.event_date)}):""].filter(Boolean).join(" · ");
    return `<div class="digitem"><div class="dt">${digTitleHTML(title, ev)}</div>
    <div class="dm">${meta}</div>
    ${aw}
    ${digEvidenceHTML(ev)}
    <div class="dc"><a href="#notice/${encodeURIComponent(r.request_id)}">${t("view_on_crol")}</a></div></div>`;
  }
  if(kind==="rfp"){ const dl=daysLeft(r.due_date), rolling=isRollingDeadline(r.due_date);
    const title=cleanText(r.short_title), ev=matchEvidence(title, matchText(r), keywords, null, matchAttachmentText(r));
    const tel=String(r.contact_phone||"").replace(/[^0-9+]/g,""); const acts=[];
    if(r.email) acts.push(`<a href="${mailtoFor(r)}"><b>${t("respond_lbl")}</b></a>`);
    if(r.email) acts.push(`<a href="mailto:${r.email}">${r.email}</a>`);
    if(tel.length>=7) acts.push(`<a href="tel:${tel}">${cleanText(r.contact_phone)}</a>`);
    const dc=acts.length?`<div class="dc">${acts.join(" · ")}</div>`:"";
    const when = rolling ? t("rolling_deadline_tag") : t("due_on",{date:fdt(r.due_date)})+(dl!=null?t("days_paren",{n:dl}):"");
    return `<div class="digitem"><div class="dt"><a href="#notice/${encodeURIComponent(r.request_id)}">${digTitleHTML(title, ev)}</a></div>
    <div class="dm">${r.agency_name} · ${when}</div>${aw}${digEvidenceHTML(ev)}${dc}</div>`; }
  // Rezoning dig: deep-link into Land detail (action rail + ULURP timeline), not only ZAP.
  // Scope decision: match evidence highlighting is out of scope for ZAP rows (different shape).
  const landHref=r.project_id?`#land/${encodeURIComponent(r.project_id)}`:"#land";
  return `<div class="digitem"><div class="dt"><a href="${landHref}">${r.project_name ? enTitle(r.project_name) : t("unnamed_rezoning")}</a></div>
    <div class="dm">${r.borough||""}${r.community_district? " · CD "+r.community_district:""} · ${r.public_status||""}${r.primary_applicant? " · "+r.primary_applicant:""}${mihOn(r.mih_flag)? " · "+t("affordable_housing_tag"):""}</div>
    ${aw}
    <div class="dc"><a href="${landHref}">${t("land_dig_open_detail")}</a> · <a href="https://zap.planning.nyc.gov/projects/${r.project_id}" ${EXT_ATTRS}>${t("view_comment_zap")}${extSR()}</a></div></div>`;
}

function feedURLs(){
  if(!API) return null;
  const {lens,filter}=aLensFilter();
  const q=new URLSearchParams({lens});
  if(filter.keywords && filter.keywords.length) q.set("q", filter.keywords.join(" "));
  if(filter.agency) q.set("agency", filter.agency);
  if(filter.minAmount) q.set("min", String(filter.minAmount));
  if(filter.kind) q.set("kind", filter.kind);
  if(filter.name) q.set("name", filter.name);
  const base=API.replace(/\/+$/,""), qs=q.toString();
  return {atom:`${base}/feed.xml?${qs}`, json:`${base}/feed.json?${qs}`, ics:`${base}/feed.ics?${qs}`};
}
function renderFeedLinks(){
  const el=$("#afeeds"); if(!el) return;
  const u=feedURLs(); if(!u){ el.innerHTML=""; return; }
  el.innerHTML=`${t("prefer_feeds_html")}
    <a href="${u.atom}">RSS/Atom</a> ·
    <a href="${u.json}">JSON Feed</a> ·
    <a href="${u.ics}">${t("calendar_ics")}</a> ${t("feeds_suffix")}`;
}
// awardwatch has no notices list to preview — the "digest" is a one-off notification, not a
// standing query, so this just confirms what's about to be watched (or asks the reader to
// open a specific notice first, if the dropdown was reached with no target set).
function awardWatchPreviewHTML(){
  if(!awardWatchTarget || !awardWatchTarget.requestId) return `<div class="empty">${t("award_watch_pick_notice_html")}</div>`;
  const label = escUiHtml(awardWatchTarget.label || awardWatchTarget.agency || "");
  return `<div class="empty">${t("award_watch_preview_note_html",{label})}</div>`;
}
/** Plain-language lead for a context-carried alert entry (notice/lens scope). */
function paintAlertContextLead(seedMeta){
  const el = document.getElementById("acontextlead");
  if(!el) return;
  if(!seedMeta && !noticeWatchSeed){
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  const seed = noticeWatchSeed && noticeWatchSeed.row;
  const digKind = (noticeWatchSeed && noticeWatchSeed.digKind)
    || (seedMeta && seedMeta.digKind)
    || "notice";
  const scopeBits = aDescribe();
  const title = seed
    ? cleanText(seed.short_title || seed.project_name || seed.title || "")
    : "";
  // Next step from the shared email awareness model when a seed notice is present.
  let nextStep = "";
  const tools = seedMeta && seedMeta.awarenessTools;
  if(seed && tools && typeof tools.digestItemAwareness === "function"){
    try{
      const a = tools.digestItemAwareness(seed, { kind: digKind, today: todayISO() });
      if(a && a.action && a.action.label) nextStep = a.action.label;
      else if(a && a.deadline && a.deadline.label) nextStep = a.deadline.label;
    }catch(_e){}
  }
  const parts = [];
  parts.push(`<p class="alert-context-lead-main">${t("alert_context_scope",{scope:escUiHtml(scopeBits)})}</p>`);
  if(title) parts.push(`<p class="alert-context-seed">${t("alert_context_from_notice",{title:escUiHtml(title)})}</p>`);
  if(nextStep) parts.push(`<p class="alert-context-next">${t("alert_context_next_step",{step:escUiHtml(nextStep)})}</p>`);
  parts.push(`<p class="alert-context-confirm muted">${t("alert_context_confirm")}</p>`);
  el.innerHTML = parts.join("");
  el.hidden = false;
}

async function aPreview(){
  $("#apreviewbox").innerHTML='<div class="empty"><span class="loading"></span> ' + t("fetching_today") + '</div>';
  renderFeedLinks();
  if($("#awatch").value === "awardwatch"){ $("#apreviewbox").innerHTML = awardWatchPreviewHTML(); return; }
  // Same time + next-action chrome as the outbound email (digest_item_awareness.mjs).
  const awarenessTools = await ensureDigAwarenessTools();
  paintAlertContextLead({ awarenessTools, digKind: noticeWatchSeed && noticeWatchSeed.digKind });
  // Context-carry seed: always render THIS notice/project through digItemHTML first so the
  // preview cannot drift from the real template even when SODA returns a different top-N.
  const seed = noticeWatchSeed && noticeWatchSeed.row;
  const seedKind = (noticeWatchSeed && noticeWatchSeed.digKind) || "notice";
  const previewKeywords = aLensFilter().filter.keywords || [];
  let seedHtml = "";
  if(seed){
    // digItemHTML: rezone/rfp/award have dedicated branches; section lenses use kind
    // "notice" so digAwarenessKind can read section_name / type_of_notice_description.
    const kindForSeed = seed.project_id && !seed.request_id ? "rezone"
      : (seedKind === "rfp" || seedKind === "award" || seedKind === "rezone") ? seedKind
      : "notice";
    seedHtml = digItemHTML(kindForSeed, seed, previewKeywords, awarenessTools);
  }
  let data;
  try{ data = await aFetch(); }catch(e){
    if(seedHtml){
      const dest=$("#adest").value.trim() || t("email_placeholder");
      $("#apreviewbox").innerHTML = `<div class="emailmock">
        <div class="ehead"><div class="efrom">CityScroll &lt;alerts@crol-list.org&gt; → ${dest}</div>
        <div class="esubj">${t("your_digest_subject",{desc:aDescribe()})}</div></div>
        <div class="ebody">${seedHtml}
          <div style="margin-top:12px;font:12px/1.5 ui-sans-serif,system-ui,sans-serif;color:var(--muted)">${tn("digest_footer",1)}</div>
        </div></div>`;
      return;
    }
    $("#apreviewbox").innerHTML='<div class="empty">' + t("could_not_reach") + '</div>';
    return;
  }
  let rows=data.rows||[];
  // Prefer seed as first item; drop duplicate request_id/project_id from the live fetch.
  if(seed){
    const seedId = seed.request_id || seed.project_id;
    rows = rows.filter(r => (r.request_id || r.project_id) !== seedId);
  }
  const dest=$("#adest").value.trim() || t("email_placeholder");
  const kw = $("#aparam").value.trim();
  const showSimplifyHint = !rows.length && !seed && isKeywordWatch($("#awatch").value) && keywordLooksSentenceLike(kw);
  // A "moneynl" watch is one built from the Ask box (NL.alerts.apply) — reuse its own chip
  // builder so a zero-match preview echoes exactly what the ask translation understood,
  // same fix as the Money tab's own ask flow (field evidence 2026-07-14: a silent empty
  // result read as "the ask button is broken").
  const nlChips = (!rows.length && !seed && $("#awatch").value === "moneynl") ? NL.alerts.chips(aLensFilter().filter).filter(Boolean) : [];
  const liveBody = rows.length ? rows.map(r=>digItemHTML(data.kind,r,previewKeywords,awarenessTools)).join("") : "";
  const body = (seedHtml || liveBody)
    ? (seedHtml + liveBody)
    : `<div class="empty">${t("no_matches_today_html")}${showSimplifyHint ? ` ${t("simplify_keyword_hint_html")}` : ""}${nlChips.length ? nlTransHTML(nlChips, "#nlq-alerts", true) : ""}</div>`;
  const count = (seed ? 1 : 0) + rows.length;
  $("#apreviewbox").innerHTML = `<div class="emailmock">
    <div class="ehead"><div class="efrom">CityScroll &lt;alerts@crol-list.org&gt; → ${dest}</div>
    <div class="esubj">${t("your_digest_subject",{desc:aDescribe()})}</div></div>
    <div class="ebody">${body}
      <div style="margin-top:12px;font:12px/1.5 ui-sans-serif,system-ui,sans-serif;color:var(--muted)">${tn("digest_footer",count)}</div>
    </div></div>`;
}

function aRenderSaved(){
  const list=aStore();
  $("#asaved").innerHTML = list.length
    ? `<div style="margin-top:16px;font:600 11px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)">${t("saved_alerts_heading")}</div>` +
      list.map((a,i)=>`<div class="savedalert"><span>${a.desc} → <b>${a.dest}</b></span><button data-i="${i}">${t("remove_btn")}</button></div>`).join("")
    : "";
  document.querySelectorAll("#asaved .savedalert button").forEach(b=>b.addEventListener("click",()=>{ const l=aStore(); l.splice(+b.dataset.i,1); aSet(l); aRenderSaved(); }));
}
function aSave(){
  const dest=$("#adest").value.trim() || "you@example.com";
  const l=aStore(); l.push({desc:aDescribe(), dest}); aSet(l); aRenderSaved();
}

/* ===================== ALERTS ROLLUP + PREFS (multi-watch digest surface) =====================
   Account delivery consolidates >1 active watch into one email (worker rollup). This panel is
   the public #alerts demonstration: group related watches by topic/agency/geography, show a
   fixture-backed consolidated digest mock, and surface the preference-center cutover path.
   Demo deep link: #alerts?view=rollup */
let alertsRollupToolsPromise = null;
let alertsRollupGroupBy = "topic";
function loadAlertsRollupTools(){
  if(!alertsRollupToolsPromise) alertsRollupToolsPromise = import("../alerts_rollup_prefs.mjs").catch(()=>null);
  return alertsRollupToolsPromise;
}
function usdRollup(n){
  if(n==null || n==="") return "";
  const v = Number(n);
  return Number.isFinite(v) ? "$" + v.toLocaleString("en-US") : "";
}
function alertsRollupSectionHTML(sec, awarenessTools){
  const label = escUiHtml(sec.label || sec.lens || t("alerts_rollup_watch_fallback"));
  if(sec.quiet || !(sec.rows && sec.rows.length)){
    return `<div class="rollup-sec"><h3>${label}</h3><p class="rollup-quiet">${t("alerts_rollup_section_quiet")}</p></div>`;
  }
  const items = sec.rows.map((r)=>{
    if(r.project_name || r.project_id){
      const meta = [r.borough, r.public_status].filter(Boolean).map(escUiHtml).join(" · ");
      const aw = digAwarenessHTML("rezone", r, awarenessTools);
      return `<div class="digitem"><div class="dt">${escUiHtml(r.project_name || r.project_id)}</div><div class="dm">${meta}</div>${aw}</div>`;
    }
    const meta = [r.agency_name, usdRollup(r.contract_amount)].filter(Boolean).map(escUiHtml).join(" · ");
    // Demo fixtures are money-shaped; awareness picks solicitation vs award from type fields.
    const kind = /Award/i.test(String(r.type_of_notice_description || "")) ? "award" : "rfp";
    const aw = digAwarenessHTML(kind, r, awarenessTools);
    return `<div class="digitem"><div class="dt">${escUiHtml(r.short_title || r.request_id || "Notice")}</div><div class="dm">${meta}</div>${aw}</div>`;
  }).join("");
  return `<div class="rollup-sec"><h3>${label}</h3>${items}</div>`;
}
function alertsRollupGroupsHTML(groups){
  if(!groups || !groups.length){
    return `<div class="empty">${t("alerts_rollup_no_groups")}</div>`;
  }
  return groups.map((g)=>{
    const items = (g.watches || []).map((w)=>{
      const freq = w.freq === "weekly" ? t("afreq_weekly_opt") : t("afreq_daily_opt");
      return `<li><span>${escUiHtml(w.query || w.lens || "")}</span> <span class="freq">· ${escUiHtml(freq)}</span></li>`;
    }).join("");
    return `<div class="rollup-group"><h3>${escUiHtml(g.label)} <span class="freq">(${(g.watches||[]).length})</span></h3><ul>${items}</ul></div>`;
  }).join("");
}
function alertsRollupEmailMockHTML(model, awarenessTools){
  if(!model) return `<div class="empty">${t("empty_preview")}</div>`;
  // Recipient is a display label for the mock (not a live address). Product digests
  // still use the real From identity on the worker send path.
  const dest = escUiHtml(model.dest || t("email_placeholder") || "reader");
  const body = (model.sections || []).map((sec)=>alertsRollupSectionHTML(sec, awarenessTools)).join("");
  const summary = escUiHtml(model.summaryLine || "");
  const footer = t("alerts_rollup_digest_footer");
  // Reuse the single-watch preview's From chrome when present so this surface does not
  // re-state the product sender string (keeps one source of truth with aPreview).
  const liveFrom = document.querySelector("#apreviewbox .efrom");
  const fromHtml = liveFrom && liveFrom.innerHTML
    ? liveFrom.innerHTML.replace(/→[\s\S]*$/, "→ " + dest)
    : `CityScroll → ${dest}`;
  return `<div class="emailmock">
    <div class="ehead"><div class="efrom">${fromHtml}</div>
    <div class="esubj">${escUiHtml(model.subject || "")}</div></div>
    <div class="ebody">
      <p style="margin:0 0 12px;font:13px/1.45 ui-sans-serif,system-ui,sans-serif;color:var(--muted)">${summary}</p>
      ${body}
      <div style="margin-top:12px;font:12px/1.5 ui-sans-serif,system-ui,sans-serif;color:var(--muted)">${footer}</div>
    </div></div>`;
}
function syncAlertsPrefsManageLink(){
  const manage = document.getElementById("alertsPrefsManage");
  if(!manage) return;
  const banner = document.getElementById("sessionBanner");
  const fromSession = banner && banner.dataset.open === "true" ? (banner.dataset.prefsUrl || "") : "";
  manage.href = fromSession || ((API || "https://api.cityscroll.org").replace(/\/+$/, "") + "/prefs");
}
async function renderAlertsRollupPrefs(){
  const groupsEl = document.getElementById("alerts-rollup-groups");
  const mockEl = document.getElementById("alerts-rollup-emailmock");
  if(!groupsEl || !mockEl) return;
  const tools = await loadAlertsRollupTools();
  if(!tools || typeof tools.demoRollupPreviewModel !== "function"){
    groupsEl.innerHTML = "";
    mockEl.innerHTML = `<div class="empty">${t("could_not_reach")}</div>`;
    return;
  }
  const model = tools.demoRollupPreviewModel({ groupBy: alertsRollupGroupBy });
  const awarenessTools = await ensureDigAwarenessTools();
  groupsEl.innerHTML = alertsRollupGroupsHTML(model.groups);
  mockEl.innerHTML = alertsRollupEmailMockHTML(model, awarenessTools);
  syncAlertsPrefsManageLink();
  const chips = document.getElementById("rollupgroupby");
  if(chips){
    chips.querySelectorAll(".chip").forEach((x)=>{
      const on = x.dataset.g === alertsRollupGroupBy;
      x.classList.toggle("on", on);
      x.setAttribute("aria-pressed", String(on));
    });
  }
}
function initAlertsRollupPrefs(){
  const chips = document.getElementById("rollupgroupby");
  if(chips){
    chips.querySelectorAll(".chip").forEach((b)=>{
      b.addEventListener("click", ()=>{
        alertsRollupGroupBy = b.dataset.g || "topic";
        renderAlertsRollupPrefs();
        announce(t("alerts_rollup_group_announce", { dim: b.textContent.trim() }));
      });
    });
  }
  renderAlertsRollupPrefs();
}
function focusAlertsRollupPanel(){
  const panel = document.getElementById("alerts-rollup-prefs");
  if(!panel) return;
  // Deep-link contract (demo id alerts-rollup-prefs) and other item routes put
  // programmatic focus on the route target itself (tabindex="-1" route-item),
  // not an inner chip — matches career/notice/entity focus patterns.
  try{ panel.scrollIntoView({ behavior: "smooth", block: "start" }); }catch(e){ panel.scrollIntoView(true); }
  try{ panel.focus({ preventScroll: true }); }catch(e){ try{ panel.focus(); }catch(_e){} }
}

// Map the alert builder to a real content-lens query the worker re-sanitizes + the cron replays.
function aLensFilter(){
  const w=$("#awatch").value, p=$("#aparam").value.trim().toLowerCase();
  if(w==="bigaward") return {lens:"money", filter:{minAmount:Number($("#athresh").value)||1000000}};
  if(w==="rfpkw")    return {lens:"money", filter:{keywords:p?[p]:[]}};
  if(w==="moneynl"){
    const kw=$("#amoneykw").value.trim(), minAmt=Number($("#amoneymin").value)||null, months=Number($("#amoneymonths").value)||null;
    const {agency=null, category=null, maxAmount=null, noticeType=null} = moneynlExtra;
    return {lens:"money", filter:{keywords:kw?[kw]:[], minAmount:minAmt, months, agency, category, maxAmount, noticeType}};
  }
  if(w==="entityvendor") return {lens:"entity", filter:{kind:"vendor", name:$("#aparam").value.trim()||null}};
  if(w==="entityagency") return {lens:"entity", filter:{kind:"agency", name:$("#aparam").value.trim()||null}};
  if(w==="awardwatch") return {lens:"award", filter:{requestId:(awardWatchTarget&&awardWatchTarget.requestId)||null, agency:(awardWatchTarget&&awardWatchTarget.agency)||null}};
  if(SECTION_WATCH_LABEL[w]) return {lens:w, filter:{
    keywords:p?[p]:[], agency:$("#aagency").value.trim()||null,
    ...(w==="meetings"?meetingWatchExtra:{})
  }};
  return {lens:"land", filter:{keywords:p?[p]:[], status:"all"}}; // rezonings — text match on the place
}
function aIsEmail(s){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s||""); }
function subscribeErrorWhy(reason){
  return {"rate-limited":t("rate_limited"),"bad-email":t("bad_email"),"channel-unsupported":t("channel_unsupported"),"not-configured":t("not_configured"),"send-failed":t("send_failed"),"bad-lens":t("generic_error")}[reason]||t("generic_error");
}
async function aSubscribe(){
  const msg=$("#asubmsg"), dest=$("#adest");
  if($("#awatch").value==="awardwatch" && !(awardWatchTarget && awardWatchTarget.requestId)){
    msg.innerHTML = t("award_watch_pick_notice_html"); return;
  }
  const email=dest.value.trim();
  if(!aIsEmail(email)){ msg.innerHTML=t("enter_valid_email"); dest.setAttribute("aria-invalid","true"); return; }
  dest.removeAttribute("aria-invalid");
  if(!API){ msg.innerHTML=t("subs_need_backend"); return; }
  const {lens,filter}=aLensFilter(), freq=$("#afreq").value.toLowerCase();
  const btn=$("#asubscribe"); btn.disabled=true; msg.innerHTML='<span class="loading"></span> ' + t("sending_confirm_link");
  try{
    const r=await workerFetch("/subscribe",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email,lens,filter,freq,lang:window.LANG||"en"})});
    const j=await r.json().catch(()=>({}));
    if(j.ok){ msg.innerHTML="<b>" + t("check_inbox") + "</b> " + t("sent_confirm_to",{email:email.replace(/[<>&]/g," ")}); }
    else { msg.innerHTML="⚠️ "+subscribeErrorWhy(j.reason); }
  }catch(e){ msg.innerHTML="⚠️ " + t("cant_reach_server"); }
  btn.disabled=false;
}
// Homepage general-interest CTA — same /subscribe double-opt-in path as Alerts.
// Empty money filter = open solicitations (describeFilter: "contract money — all notices").
async function homeCtaSubscribe(e){
  if(e && e.preventDefault) e.preventDefault();
  const msg=$("#homeCtaMsg"), dest=$("#homeCtaEmail"), btn=$("#homeCtaSubmit");
  if(!msg || !dest || !btn) return;
  const email=dest.value.trim();
  if(!aIsEmail(email)){ msg.textContent=t("enter_valid_email"); dest.setAttribute("aria-invalid","true"); dest.focus(); return; }
  dest.removeAttribute("aria-invalid");
  if(!API){ msg.textContent=t("subs_need_backend") || t("not_configured"); return; }
  btn.disabled=true;
  msg.innerHTML='<span class="loading"></span> ' + t("sending_confirm_link");
  try{
    const r=await workerFetch("/subscribe",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
      email,
      lens:"money",
      filter:{},
      freq:"weekly",
      lang:window.LANG||"en"
    })});
    const j=await r.json().catch(()=>({}));
    if(j.ok){ msg.innerHTML="<b>" + t("check_inbox") + "</b> " + t("sent_confirm_to",{email:email.replace(/[<>&]/g," ")}); dest.value=""; }
    else { msg.innerHTML="⚠️ "+subscribeErrorWhy(j.reason); }
  }catch(err){ msg.innerHTML="⚠️ " + t("cant_reach_server"); }
  btn.disabled=false;
}

// Section → lens map for agency-profile section chips (not a homepage strip).
const SECTION_LENS = {"Procurement":"money","Public Hearings and Meetings":"meetings","Agency Rules":"rules","Property Disposition":"property","Changes in Personnel":"people"};

/* ===================== RED FLAGS & BENCHMARKS (context, never accusations) =====================
   OCP/Opentender-style computable signals + comparative stats, computed live per view from small
   SODA aggregates and cached per agency for the session. Formulas + false-positive modes are
   documented on about.html#context, which every flag links to. */
const BM_CACHE = {};
const yearCut = () => new Date(Date.now()-365*86400000).toISOString().slice(0,10) + "T00:00:00";
function ordinal(n){ const s=["th","st","nd","rd"], v=n%100; return n+(s[(v-20)%10]||s[v]||s[0]); }

function agencyNorms(agency){
  if(BM_CACHE[agency]) return BM_CACHE[agency];
  const q = agency.replace(/'/g,"''");
  BM_CACHE[agency] = (async ()=>{
    const out = {adMedian:null, adN:0, awardTotal:0, awardCount:0};
    try{
      const sol = await soda({"$select":"start_date,due_date","$where":`agency_name='${q}' AND type_of_notice_description='Solicitation' AND due_date IS NOT NULL`,"$order":"start_date DESC","$limit":"200"}, 8000);
      const ws = sol.map(r=>Math.round((new Date(r.due_date)-new Date(r.start_date))/86400000)).filter(d=>d>0&&d<400).sort((a,b)=>a-b);
      if(ws.length>=8){ out.adMedian = ws[Math.floor(ws.length/2)]; out.adN = ws.length; }
    }catch(e){}
    try{
      const [a] = await soda({"$select":"count(1) as n, sum(contract_amount) as t","$where":`agency_name='${q}' AND type_of_notice_description='Award' AND contract_amount > 0 AND contract_amount < ${MONEY_HONESTY_CAP} AND start_date > '${yearCut()}'`}, 8000);
      if(a){ out.awardCount = +a.n||0; out.awardTotal = +a.t||0; }
    }catch(e){}
    return out;
  })();
  return BM_CACHE[agency];
}

const NONCOMP_RE = /negotiated|sole source|emergency|demonstration project/i;
async function noticeFlags(r){
  const flags = [];
  if(!r || !r.agency_name) return flags;
  if(NONCOMP_RE.test(r.selection_method_description||""))
    flags.push({lvl:"soon", t:`⚑ non-competitive method: ${escUiHtml(cleanText(r.selection_method_description))}`});
  if(r.type_of_notice_description === "Solicitation" && r.due_date && r.start_date){
    const w = Math.round((new Date(r.due_date)-new Date(r.start_date))/86400000);
    if(w > 0 && w <= 10){
      const n = await agencyNorms(r.agency_name);
      if(n.adMedian && w < n.adMedian/2)
        flags.push({lvl:"hot", t:`⚑ short ad window: ${w} day${w===1?"":"s"} (agency median ${n.adMedian})`});
    }
  }
  if(r.type_of_notice_description === "Award" && r.vendor_name){
    try{
      const cut90 = new Date(Date.now()-90*86400000).toISOString().slice(0,10) + "T00:00:00";
      const [c] = await soda({"$select":"count(1) as n","$where":`agency_name='${r.agency_name.replace(/'/g,"''")}' AND vendor_name='${cleanText(r.vendor_name).replace(/'/g,"''")}' AND type_of_notice_description='Award' AND start_date > '${cut90}'`}, 8000);
      if(c && +c.n >= 3) flags.push({lvl:"soon", t:`⚑ ${ordinal(+c.n)} award to this vendor at this agency in 90 days`});
    }catch(e){}
  }
  return flags;
}

async function awardContext(r){
  if(!r || r.type_of_notice_description !== "Award" || !r.agency_name) return "";
  const X = +r.contract_amount;
  if(!X || X <= 0 || X >= MONEY_HONESTY_CAP) return "";
  const q = r.agency_name.replace(/'/g,"''");
  const base = `agency_name='${q}' AND type_of_notice_description='Award' AND contract_amount > 0 AND contract_amount < ${MONEY_HONESTY_CAP} AND start_date > '${yearCut()}'`;
  const bits = [];
  try{
    const [[le],[tot]] = await Promise.all([
      soda({"$select":"count(1) as n","$where":base+` AND contract_amount <= ${X}`}, 8000),
      soda({"$select":"count(1) as n","$where":base}, 8000)
    ]);
    if(tot && +tot.n >= 20) bits.push(`larger than <b>${Math.round((+le.n/+tot.n)*100)}%</b> of this agency's awards (last 12 mo, n=${(+tot.n).toLocaleString()})`);
  }catch(e){}
  if(r.vendor_name){
    try{
      const n = await agencyNorms(r.agency_name);
      if(n.awardTotal > 0){
        const [v] = await soda({"$select":"sum(contract_amount) as t","$where":base+` AND vendor_name='${cleanText(r.vendor_name).replace(/'/g,"''")}'`}, 8000);
        if(v && +v.t > 0){
          const share = Math.round((+v.t/n.awardTotal)*100);
          if(share >= 1) bits.push(`this vendor holds <b>${share}%</b> of the agency's award $ (12 mo)`);
        }
      }
    }catch(e){}
  }
  if(!bits.length) return "";
  // Inline disclosure keeps the reader on the notice; full methodology stays one click away.
  return `<div class="glance" style="border-inline-start-color:var(--amber)"><div class="gl"><b>${t("context_strip_lbl")}</b><span>${bits.join(" · ")} · <details class="inline-disclose"><summary>${t("context_how_computed_summary")}</summary><div class="inline-disclose-body">${t("context_how_computed_body_html")} <a href="about.html#context">${t("context_full_methodology_link")}</a></div></details></span></div></div>`;
}

/* Address / parcel cross-links: street-address geocode first; for Property Disposition,
   fall back to BBL resolved from notice body tax-lot text (same extractor as the list).
   The Datasette lesson — cheap outbound joins deliver most of a warehouse's value. */
function parcelLinksHTML(links, provenanceKey){
  if(!links) return "";
  return `<div class="rmeta2 property-parcel-links" style="margin:8px 0">${t("parcel_elsewhere_label")}
    <a href="${escUiHtml(links.zola_url)}" ${EXT_ATTRS}>${t("parcel_link_zola")}${extSR()}</a> ·
    <a href="${escUiHtml(links.acris_url)}" ${EXT_ATTRS}>${t("parcel_link_acris")}${extSR()}</a> ·
    <a href="${escUiHtml(links.who_owns_what_url)}" ${EXT_ATTRS}>${t("parcel_link_wow")}${extSR()}</a>
    <span class="muted" style="font-size:12px">· ${t(provenanceKey,{bbl:links.bbl})}</span></div>`;
}
async function fillAddressLinks(r, el){
  if(!el || !r) return;
  let geo = null;
  if(goodAddr(r.street_address_1)){
    const addr = cleanText(r.street_address_1);
    try{ geo = await geocode(addr + " New York NY"); }catch(e){}
  }
  if(!document.contains(el)) return;
  if(geo && geo.bbl && /^\d{10}$/.test(geo.bbl)){
    const tools = await propertyLocationTools();
    if(!document.contains(el)) return;
    const links = tools.parcelLinksFromBbl(geo.bbl);
    if(links){ el.innerHTML = parcelLinksHTML(links, "parcel_via_geosearch"); return; }
  }
  // BBL fallback: Property notices often name the site as Block/Lot in the body with no
  // usable street_address_1. Resolve the parcel from extracted tax-lot evidence only —
  // never from multi-borough clerk boilerplate (propertyLocationFromRow already abstains).
  if(r.section_name !== "Property Disposition") return;
  const tools = await propertyLocationTools();
  if(!document.contains(el)) return;
  const location = tools.propertyLocationFromRow(r);
  const bbl = tools.primaryPropertyBbl(location);
  const links = tools.parcelLinksFromBbl(bbl);
  if(!links || location.scope !== "local") return;
  el.innerHTML = `${propertyPlaceChips(location)}${parcelLinksHTML(links, "parcel_via_notice_tax_lot")}`;
}

function attachmentExtractHTML(attachment){
  const text = String(attachment?.extracted_text || "").trim();
  if(!text || attachment.text_status && attachment.text_status !== "ok") return "";
  const preview = String(attachment.text_preview || text.split(/\n+/).filter(Boolean).slice(0,4).join(" · ")).trim();
  const previewShort = preview.length > 280 ? preview.slice(0,277).trimEnd()+"…" : preview;
  // Progressive disclosure: collapsed by default; few-line preview in the summary;
  // expand for the full extract. Original document link stays beside this block.
  return `<details class="attachment-extract inline-disclose" style="margin:6px 0 2px">
    <summary class="attachment-extract-summary" style="font:12px/1.55 ui-sans-serif,system-ui,sans-serif;color:var(--muted);cursor:pointer">
      <span class="attachment-extract-label">${escUiHtml(t("notice_attachment_extract_summary"))}</span>
      <span class="attachment-extract-preview" lang="en" dir="ltr" style="display:block;margin-top:2px;color:var(--ink)">“${escUiHtml(previewShort)}”</span>
    </summary>
    <div class="attachment-extract-body inline-disclose-body scope" lang="en" dir="ltr" style="margin-top:8px;white-space:pre-wrap;font:13px/1.55 ui-sans-serif,system-ui,sans-serif;max-height:22rem;overflow:auto">${escUiHtml(text.slice(0,50000))}${text.length>50000?"…":""}</div>
  </details>`;
}

function attachmentChipHTML(r){
  if((r.section_name || r.section) === "Changes in Personnel") return "";
  const attachments = Array.isArray(r.attachments) ? r.attachments.filter(a=>a && a.url) : [];
  if(!attachments.length) return "";
  const first = attachments[0];
  const rawTitle = String(first.title || t("notice_attachment_title_fallback")).replace(/\s+/g," ").trim();
  const title = rawTitle.length > 108 ? rawTitle.slice(0,105).trimEnd()+"…" : rawTitle;
  const label = tn("notice_attachment_chip", attachments.length, {title});
  const extract = attachmentExtractHTML(first);
  // Always keep the original-document link; text extract is optional progressive disclosure.
  return `<div class="attachment-panel" style="margin:6px 0 4px">
    <a class="tag attachment-chip" href="${escUiHtml(first.url)}" target="_blank" rel="noopener">${escUiHtml(label)} · ${escUiHtml(t("view_in_city_record"))}</a>
    ${extract}
  </div>`;
}

// T3: precomputed attachment-content related notices (no query-time embedding).
let attachmentRelatedToolsPromise = null;
async function attachmentRelatedTools(){
  if(!attachmentRelatedToolsPromise){
    attachmentRelatedToolsPromise = import("../attachment_related.mjs").catch(()=>null);
  }
  return attachmentRelatedToolsPromise;
}
async function attachmentRelatedHTMLFor(r){
  if(!r || !r.request_id) return "";
  // Only surface when this notice has attachment context (chip or extract path).
  const hasAttach = Array.isArray(r.attachments) && r.attachments.some(a=>a && (a.url || a.extracted_text));
  if(!hasAttach) return "";
  const tools = await attachmentRelatedTools();
  if(!tools) return "";
  const artifact = await tools.loadAttachmentRelatedLookup();
  if(!artifact) return "";
  return tools.attachmentRelatedHTML(artifact, r.request_id, { t, esc: escUiHtml });
}

// Fill a placeholder div asynchronously; bail if the view moved on while queries ran.
async function fillContext(r, el){
  if(!el) return;
  const attachmentHTML = attachmentChipHTML(r);
  if(attachmentHTML) el.innerHTML = attachmentHTML;
  const [flags, ctx, relatedHTML] = await Promise.all([
    noticeFlags(r),
    awardContext(r),
    attachmentRelatedHTMLFor(r),
  ]);
  if(!document.contains(el)) return; // a newer selection replaced this panel
  let html = attachmentHTML;
  if(relatedHTML) html += relatedHTML;
  if(flags.length) html += `<div style="margin:6px 0 4px">${flags.map(f=>`<span class="tag ${f.lvl}" style="margin-bottom:4px">${f.t}</span>`).join(" ")} <details class="inline-disclose pivot-disclose"><summary class="pivot" style="font:12px/1.6 ui-sans-serif,system-ui,sans-serif;color:var(--muted)">${t("context_flags_summary")}</summary><div class="inline-disclose-body">${t("context_flags_body_html")} <a href="about.html#context">${t("context_full_methodology_link")}</a></div></details></div>`;
  html += ctx;
  if(html) el.innerHTML = html;
}

/* ===================== FOLLOW THE DOLLARS =====================
   Precompute-first: registration and payment amounts come from GET /contract-lifecycle
   (lifecycleDollarsHTML). No live Checkbook proxy from the notice-detail page. */

// Notice-detail external-award region. Covered agencies (exact NYCHA / fuzzy ABO) resolve the
// precomputed set in one workerFetch; absent/unknown agencies say nothing here (their coverage
// claim lives in the stats-bar note). Say-nothing on any fetch failure — never a wrong "none".
async function externalAwardForNotice(r, el){
  if(!el) return;
  const cov = awardCoverage(r.agency_name);
  if(cov==="absent" || cov==="unknown") return;
  const resp = await loadExternalAward({id: r.request_id});
  if(!document.contains(el) || !resp) return;
  el.innerHTML = externalAwardHTML(resp, r);
  const offerBtn = el.querySelector("[data-award-watch-offer]");
  if(offerBtn) offerBtn.addEventListener("click", ()=>{
    awardWatchTarget = { requestId: r.request_id, agency: r.agency_name, label: r.short_title || r.agency_name || "" };
    showTab("alerts", true);
    $("#awatch").value = "awardwatch";
    aWatchChange();
    aPreview();
    $("#adest").focus();
  });
}

// Publish live bindings for neighboring modules and legacy inline handlers.
globalThis.AKEY = AKEY;
globalThis.AMOUNT_WORD_RE = AMOUNT_WORD_RE;
globalThis.BM_CACHE = BM_CACHE;
globalThis.NONCOMP_RE = NONCOMP_RE;
globalThis.SECTION_LENS = SECTION_LENS;
globalThis.SECTION_WATCH_LABEL = SECTION_WATCH_LABEL;
globalThis.aDescribe = aDescribe;
globalThis.aFetch = aFetch;
globalThis.aIsEmail = aIsEmail;
globalThis.aLensFilter = aLensFilter;
globalThis.aPreview = aPreview;
globalThis.aRenderSaved = aRenderSaved;
globalThis.aSave = aSave;
globalThis.aSet = aSet;
globalThis.aStore = aStore;
globalThis.aSubscribe = aSubscribe;
globalThis.aWatchChange = aWatchChange;
globalThis.aWhenText = aWhenText;
globalThis.agencyNorms = agencyNorms;
globalThis.alertsRollupEmailMockHTML = alertsRollupEmailMockHTML;
globalThis.alertsRollupGroupsHTML = alertsRollupGroupsHTML;
globalThis.alertsRollupSectionHTML = alertsRollupSectionHTML;
globalThis.awardContext = awardContext;
globalThis.awardWatchPreviewHTML = awardWatchPreviewHTML;
globalThis.digAwarenessHTML = digAwarenessHTML;
globalThis.digAwarenessKind = digAwarenessKind;
globalThis.digContact = digContact;
globalThis.digEvidenceHTML = digEvidenceHTML;
globalThis.digItemHTML = digItemHTML;
globalThis.digTitleHTML = digTitleHTML;
globalThis.ensureDigAwarenessTools = ensureDigAwarenessTools;
globalThis.externalAwardForNotice = externalAwardForNotice;
globalThis.feedURLs = feedURLs;
globalThis.fillAddressLinks = fillAddressLinks;
globalThis.fillContext = fillContext;
globalThis.focusAlertsRollupPanel = focusAlertsRollupPanel;
globalThis.homeCtaSubscribe = homeCtaSubscribe;
globalThis.initAlertsRollupPrefs = initAlertsRollupPrefs;
globalThis.isKeywordWatch = isKeywordWatch;
globalThis.keywordLooksSentenceLike = keywordLooksSentenceLike;
globalThis.loadAlertsRollupTools = loadAlertsRollupTools;
globalThis.locateAnyTerm = locateAnyTerm;
globalThis.matchEvidence = matchEvidence;
globalThis.matchAttachmentText = matchAttachmentText;
globalThis.attachmentChipHTML = attachmentChipHTML;
globalThis.attachmentExtractHTML = attachmentExtractHTML;
globalThis.attachmentRelatedHTMLFor = attachmentRelatedHTMLFor;
globalThis.matchText = matchText;
globalThis.noticeFlags = noticeFlags;
globalThis.ordinal = ordinal;
globalThis.parcelLinksHTML = parcelLinksHTML;
globalThis.renderAlertsRollupPrefs = renderAlertsRollupPrefs;
globalThis.renderFeedLinks = renderFeedLinks;
globalThis.subscribeErrorWhy = subscribeErrorWhy;
globalThis.syncAlertsPrefsManageLink = syncAlertsPrefsManageLink;
globalThis.updateAWhen = updateAWhen;
globalThis.usdRollup = usdRollup;
globalThis.yearCut = yearCut;
Object.defineProperty(globalThis, "alertsRollupGroupBy", { configurable: true, get: () => alertsRollupGroupBy, set: value => { alertsRollupGroupBy = value; } });
Object.defineProperty(globalThis, "alertsRollupToolsPromise", { configurable: true, get: () => alertsRollupToolsPromise, set: value => { alertsRollupToolsPromise = value; } });
Object.defineProperty(globalThis, "awardWatchTarget", { configurable: true, get: () => awardWatchTarget, set: value => { awardWatchTarget = value; } });
Object.defineProperty(globalThis, "digAwarenessToolsPromise", { configurable: true, get: () => digAwarenessToolsPromise, set: value => { digAwarenessToolsPromise = value; } });
Object.defineProperty(globalThis, "lastWatch", { configurable: true, get: () => lastWatch, set: value => { lastWatch = value; } });
Object.defineProperty(globalThis, "meetingWatchExtra", { configurable: true, get: () => meetingWatchExtra, set: value => { meetingWatchExtra = value; } });
Object.defineProperty(globalThis, "moneynlExtra", { configurable: true, get: () => moneynlExtra, set: value => { moneynlExtra = value; } });
Object.defineProperty(globalThis, "noticeWatchSeed", { configurable: true, get: () => noticeWatchSeed, set: value => { noticeWatchSeed = value; } });
globalThis.paintAlertContextLead = paintAlertContextLead;
