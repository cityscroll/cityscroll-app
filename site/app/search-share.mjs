import { walkEntryHref } from "../walk_entry.mjs";

let nlParserPromise;
function scopeHash(lens, hash){
  return hash&&CrolScope.routeHashFromScope(CrolScope.scopeFromRouteHash(hash,{language:window.LANG||"en"}),{surface:lens});
}
function loadNlParser(){
  return nlParserPromise ||= new Promise(resolve=>{
    const script=document.createElement("script");
    script.src="nl_parse.js";
    script.onload=()=>resolve(typeof parseNL==="function");
    script.onerror=()=>resolve(false);
    document.head.append(script);
  });
}

async function nlResolve(text, lens){
  lens = lens || "money";
  // Prefer the model-backed worker when API is set; fall back to the on-device heuristic.
  if(API){
    try{
      const r=await workerFetch("/nl",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text, lens})}, 12000);
      if(r.ok){const j=await r.json(); if(j&&j.filter&&!j.degraded) return enrichNeighborhoodFilter(text,lens,{source:"model",...withPersonName(text, lens, j.filter)});}
    }catch(e){}
  }
  if(typeof parseNL!=="function" && !await loadNlParser()){
    return enrichNeighborhoodFilter(text,lens,{source:"device",keywords:[text]});
  }
  return enrichNeighborhoodFilter(text,lens,{source:"device",...deviceParse(text, lens)});
}

async function enrichNeighborhoodFilter(text,lens,filter){
  if(!/^(?:land|property|rules|meetings)$/.test(lens)) return filter;
  return import("../neighborhood_search.mjs").then(m=>m.enrichNeighborhoodFilter(text,lens,filter)).catch(()=>filter);
}

const NLQ_PRESET_KEY = "crd_nlq_presets_v1";
function nlqPresetStore(){
  try{ return parsePresetStore(localStorage.getItem(NLQ_PRESET_KEY)); }catch(e){ return []; }
}
function nlqPresetSet(list){
  try{ localStorage.setItem(NLQ_PRESET_KEY, JSON.stringify(list)); }catch(e){}
}
function nlqEscape(value){
  return String(value||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;");
}
function renderNLQPresets(){
  const list=nlqPresetStore();
  document.querySelectorAll("[data-search-presets]").forEach(box=>{
    box.innerHTML = list.length
      ? `<div class="nlqpresets"><div class="nlqpresets-title">${t("saved_searches_heading")}</div><div class="nlqpreset-list">` +
        list.map((preset,i)=>{
          const lens=presetLens(preset);
          const lensLabel=t("tab_"+lens);
          return `<span class="nlqpreset"><button type="button" class="nlqpreset-run" data-i="${i}"><span class="nlqpreset-lens">${nlqEscape(lensLabel)}</span><span>${nlqEscape(preset.label)}</span></button><button type="button" class="nlqpreset-remove" data-i="${i}" aria-label="${nlqEscape(t("remove_saved_search_aria",{label:lensLabel+" — "+preset.label}))}">×</button></span>`;
        }).join("") +
        `</div></div>`
      : "";
    box.querySelectorAll(".nlqpreset-run").forEach(btn=>btn.addEventListener("click",()=>{
      const preset=nlqPresetStore()[+btn.dataset.i]; if(!preset) return;
      const hash=scopeHash(presetLens(preset),preset.hash);
      if(location.hash===hash) applyHash(); else location.hash=hash;
    }));
    box.querySelectorAll(".nlqpreset-remove").forEach(btn=>btn.addEventListener("click",()=>{
      const next=removePreset(nlqPresetStore(), +btn.dataset.i); nlqPresetSet(next); renderNLQPresets();
    }));
  });
}
function qrButtonHTML(id, className){
  return `<button type="button" class="${className||"mini"}"${id?` id="${id}"`:""} data-qr-share data-i18n="qr_share_btn">${t("qr_share_btn")}</button>`;
}
function qrLabels(){
  return {
    title:t("qr_dialog_title"),
    alt:t("qr_image_alt"),
    destination:t("qr_destination_label"),
    download:t("qr_download_png"),
    close:t("qr_close")
  };
}
function bindQRShare(button, url){
  if(button && window.QRShare) QRShare.bind(button, currentLanguageURL(url), qrLabels);
}
function renderLandingShareActions(){
  const root=$("#landing-share-actions"); if(!root) return;
  const url=currentLanguageURL(location.origin+location.pathname);
  root.innerHTML=`<div class="nlqactions"><button type="button" class="mini" data-landing-copy data-i18n="copy_link">${t("copy_link")}</button>${qrButtonHTML()}</div>`;
  const copy=root.querySelector("[data-landing-copy]");
  copy.addEventListener("click",()=>copyText(url, copy));
  bindQRShare(root.querySelector("[data-qr-share]"), url);
}
function searchWalkHref(lens, hash){
  const params = new URLSearchParams((hash || "").split("?", 2)[1] || "");
  const href = walkEntryHref("/browse/", {
    source: "search",
    query: params.get("q") || params.get("agency") || "",
    place: {
      borough: params.get("boro") || params.get("borough") || "",
      community_district: params.get("cd") || "",
      council_district: params.get("council") || "",
      neighborhood: params.get("neighborhood") || "",
      location_scope: params.get("scope") || "",
    },
  });
  const url = new URL(href, location.origin);
  url.searchParams.set("walk_lens", lens || "");
  return `${url.pathname}${url.search}`;
}
function searchActionsHTML(lens, hash){
  if(!hash) return "";
  const moneyIds=lens==="money";
  return `<div class="nlqactions"><a class="act walk-entry-link" data-search-walk href="${nlqEscape(searchWalkHref(lens, hash))}">Start a walk</a><a class="act" data-search-share ${moneyIds?'id="nlqshare" ':''}href="${nlqEscape(currentLanguageURL(canonicalSearchURL(location, hash)))}" target="_blank" rel="noopener noreferrer"><span data-i18n="share_search_link">${t("share_search_link")}</span><span class="sr-only" data-i18n="ext_link_new_tab_sr"> ${t("ext_link_new_tab_sr")}</span></a><button type="button" class="mini" data-search-copy ${moneyIds?'id="nlqcopy" ':''}data-i18n="copy_search_link">${t("copy_search_link")}</button>${qrButtonHTML(moneyIds?"nlqqr":"")}<button type="button" class="mini" data-search-save ${moneyIds?'id="nlqsave" ':''}data-i18n="save_search_btn">${t("save_search_btn")}</button></div>`;
}
function bindSearchActions(root, label, hash){
  hash=scopeHash(presetLens(hash)||globalThis.activeViewTab?.(),hash);
  if(!root || !hash) return;
  const url=currentLanguageURL(canonicalSearchURL(location, hash));
  const walk=root.querySelector("[data-search-walk]"); if(walk) walk.href=currentLanguageURL(location.origin + searchWalkHref(presetLens(hash), hash));
  const share=root.querySelector("[data-search-share]"); if(share) share.href=url;
  const copy=root.querySelector("[data-search-copy]");
  if(copy) copy.addEventListener("click",()=>copyText(url, copy));
  bindQRShare(root.querySelector("[data-qr-share]"), url);
  const save=root.querySelector("[data-search-save]");
  if(save) save.addEventListener("click",()=>{
    nlqPresetSet(savePreset(nlqPresetStore(), label, hash));
    renderNLQPresets();
    save.dataset.i18n="saved_check";
    save.textContent=t("saved_check");
  });
}
function nlqResolvedActionsHTML(hash){
  return searchActionsHTML("money", hash);
}
function bindNLQResolvedActions(label, hash){
  bindSearchActions($("#nltrans"), label, hash);
}
async function nlTranslate(){
  const text=$("#nlq").value.trim(); if(!text) return;
  askPanel("money")?.setAttribute("open","");
  const btn=$("#nlgo"); if(btn) btn.disabled=true; $("#nltrans").innerHTML=nlWorkingHTML();
  const p=await nlResolve(text, "money");
  // Entity/forecast intents leave the list surface for the agency (or vendor) profile.
  if(p.route==="agency" && p.name){
    if(btn) btn.disabled=false;
    $("#nltrans").innerHTML="";
    location.hash=agencyHref(p.name, p.tab||null);
    return;
  }
  if(p.route==="vendor" && p.name){
    if(btn) btn.disabled=false;
    $("#nltrans").innerHTML="";
    location.hash=vendorHref(p.name, p.tab||null);
    return;
  }
  const deepLink=buildMoneyDeepLink(p);
  const wantsAward = !p.closingWeek && (p.noticeType==="award" || (!p.noticeType && (p.minAmount || p.maxAmount)));
  moneyNlResolved={category:p.category||null, maxAmount:p.maxAmount||null, months:p.months||null,
    noticeType:p.noticeType||null, excludeSpecial:!!p.excludeSpecial};
  $("#mode").value=wantsAward?"award":"open"; $("#sort").value="deadline";
  $("#agency").value=""; forceSelect("#agency", p.agency);
  $("#kw").value=(p.keywords||[]).join(" "); forceAmountSelect(p.minAmount);
  closingWeek=!!p.closingWeek && !wantsAward;
  $("#closingweek").classList.toggle("on", closingWeek);
  $("#closingweek").setAttribute("aria-pressed", String(closingWeek));
  await search();
  if(btn) btn.disabled=false;
  $("#nltrans").innerHTML=nlqResolvedActionsHTML(deepLink);
  bindNLQResolvedActions(text, deepLink);
  if(currentRows.length === 0) $("#list").innerHTML = `<div class="empty">${t("nl_no_matches_note")}</div>`;
}

function nlWorkingHTML(){ return '<div class="nlworking"><span class="loading"></span><span>' + t("translating") + '</span></div>'; }

// Informal notice translation — original English always stays primary above this mount.
// An explicit language on a canonical notice document is a request for the translated aid,
// so that route opens it on first paint. Saved-language visits and in-app notice navigation
// remain on-demand. The worker caches per (notice, lang), and invariant failures return
// ok:false → we show the short unavailable line, never a partial translation.
function mountUnofficialTranslation(el, r){
  if(!el || !r || !r.request_id) return;
  const lang = window.LANG || "en";
  const shipping = (window.SHIPPING_LANGS || []).includes(lang);
  if(!shipping || lang === "en" || !API){ el.innerHTML = ""; return; }
  el.innerHTML = `<button type="button" class="act" data-xlate-btn>${t("unofficial_translation_show")}</button>`
    + `<div class="xlate-pane" data-xlate-pane hidden></div>`;
  const btn = el.querySelector("[data-xlate-btn]");
  const pane = el.querySelector("[data-xlate-pane]");
  if(!btn || !pane) return;
  let state = "idle"; // idle | loading | open | unavailable
  const activate = async ()=>{
    if(state === "open"){
      pane.hidden = true;
      btn.textContent = t("unofficial_translation_show");
      state = "idle";
      return;
    }
    if(state === "unavailable") return;
    if(state === "loading") return;
    if(pane.dataset.loaded === "1"){
      pane.hidden = false;
      btn.textContent = t("unofficial_translation_hide");
      state = "open";
      return;
    }
    state = "loading";
    btn.disabled = true;
    btn.textContent = t("unofficial_translation_loading");
    try{
      const resp = await workerFetch(
        "/translate/" + encodeURIComponent(r.request_id) + "?lang=" + encodeURIComponent(lang),
        null,
        20000,
      );
      const j = resp && resp.ok ? await resp.json() : null;
      if(!j || !j.ok || !j.title && !j.description){
        pane.hidden = false;
        pane.dataset.loaded = "0";
        pane.innerHTML = `<span class="lbl">${t("unofficial_translation")}</span>`
          + `<p class="xlate-body">${t("unofficial_translation_unavailable")}</p>`;
        btn.textContent = t("unofficial_translation");
        btn.disabled = true;
        state = "unavailable";
        return;
      }
      const title = cleanText(j.title || "");
      const body = cleanText(j.description || "");
      // lang on the pane matches the active UI language; original English stays above with lang=en.
      pane.setAttribute("lang", lang);
      pane.innerHTML = `<span class="lbl">${t("unofficial_translation")}</span>`
        + (title ? `<div class="xlate-title">${title}</div>` : "")
        + (body ? `<p class="xlate-body">${body.slice(0,6000)}${body.length>6000?"…":""}</p>` : "");
      pane.dataset.loaded = "1";
      pane.hidden = false;
      btn.disabled = false;
      btn.textContent = t("unofficial_translation_hide");
      state = "open";
    }catch(e){
      pane.hidden = false;
      pane.innerHTML = `<span class="lbl">${t("unofficial_translation")}</span>`
        + `<p class="xlate-body">${t("unofficial_translation_unavailable")}</p>`;
      btn.textContent = t("unofficial_translation");
      btn.disabled = true;
      state = "unavailable";
    }
  };
  btn.addEventListener("click", activate);
  const explicitLang = new URLSearchParams(location.search).get("lang");
  const noticeDocument = /^\/notices\/[A-Za-z0-9_-]{1,80}\/?$/.test(location.pathname);
  if(noticeDocument && explicitLang === lang) void activate();
}

// The chips summarizing what was understood are inert status text (role="status"), not the
// clickable sample queries above them (.trychip) — an explicit label keeps the two from
// reading as the same kind of thing; the "Edit search" button is a real, separately-styled
// control (.mini), a sibling of the status line rather than nested inside it. `forSel` is the
// input it should refocus (delegated at the bottom of this file — see the "#nlgo" click
// listener), so one handler covers every render across every lens instead of rewiring a
// listener each time. `weak` (little/nothing understood, or zero matches) wraps both in a
// visible callout instead of leaving them to blend into quiet status text (w12-02: never a
// bare empty result — field evidence 2026-07-14).
function nlTransHTML(chips, forSel, weak){
  if(!chips.length) return "";
  // A plain space, not "" -- adjacent .qchip spans read fine visually (CSS margin separates
  // the pills either way), but joining with no text node between them at all left the DOM/
  // accessible text of consecutive chips mashed together with no boundary -- a real "rezonings
  // in the Bronx" query echoed as the single run-on word "Bronxall" to anything reading
  // textContent (a screen reader's accessible-name computation, copy/paste, a test assertion),
  // not just visually.
  const status = `<div class="nlunderstood" role="status">${t("nl_understood_label")} ${chips.join(" ")}</div>`;
  const edit = `<button type="button" class="mini nledit" data-nlfor="${forSel}">${t("nl_edit_btn")}</button>`;
  return weak ? `<div class="nlunderstood-weak">${status}${edit}</div>` : `${status}${edit}`;
}

// "look up someone named X" → the model sets lookupType:"person" but often omits the name
// (it reads a surname as not a "topic keyword"), so #pkw ends up empty and the search bails.
// Recover the name from the raw text. Used by both the model path and the device fallback.
function personName(text){
  const t=(text||"").trim();
  let m=t.match(/(?:named|name of|called)\s+([A-Za-z][A-Za-z'’.\-]+)/i);
  if(!m) m=t.match(/(?:look\s*up|find|search for|about)\s+(?:someone|somebody|a person|the person|person|mr\.?|ms\.?|mrs\.?)?\s*([A-Za-z][A-Za-z'’.\-]+)/i);
  if(m) return m[1];
  const stop=new Set("look up lookup someone somebody person people named name find search for a an the of about mr ms mrs role title".split(" "));
  const cand=t.replace(/[^A-Za-z'’.\- ]/g," ").split(/\s+/).filter(w=>w.length>2 && !stop.has(w.toLowerCase()));
  return cand.length ? cand[cand.length-1] : null;
}
function withPersonName(text, lens, f){
  if(lens==="people" && f && f.lookupType==="person" && (!f.keywords || !f.keywords.length)){
    const nm=personName(text); if(nm) return {...f, keywords:[nm]};
  }
  return f;
}
function deviceParse(text, lens){
  if(lens==="money") return parseNL(text);
  const out={keywords:[]};
  const low=normalizeNaturalLanguageText(text);
  if(lens==="alerts"){
    // Rezonings are a different lens (land/ZAP) with no dollar amount, agency, or due date,
    // so they stay their own shape; everything else (contracts, RFPs, awards) reuses
    // parseNL()'s general field extraction — the same function the Money tab's own search
    // box calls, so a new field added there benefits both without any alerts-specific code.
    if(/\brezon\w*\b|\bzoning\b/.test(low)){
      const place=(text.match(/(?:near|by|around)\s+(.+)$/i)||[])[1];
      return {watchType:"rezone", place: place ? place.trim() : null};
    }
    return parseNL(text);
  }
  if(lens==="land"){
    const boros=["Manhattan","Brooklyn","Queens","Bronx","Staten Island"];
    out.boro=boros.find(b=>low.includes(" "+b.toLowerCase()+" "))||null;
    out.councilDistrict=extractCouncilDistrict(low);
    out.communityDistrict=communityDistrictWithBoro(low, out.boro)||extractCommunityDistrict(low);
    out.nearMe=extractNearMe(low);
    if(/\b(all|closed|approved|completed)\b/.test(low) && /\b(status|including|incl)\b/.test(low)) out.status="all";
  }
  if(lens==="people"){
    if(extractStaffingGuide(low)){ out.view="guide"; out.lookupType="role"; return out; }
    const personish=/\b(person|people|someone|somebody|individual|named|name of|mr|ms|mrs)\b/.test(low);
    const roleish=/\b(role|roles|title|titles|position|job|jobs)\b/.test(low);
    const nm=personName(text);
    if((personish || nm) && !roleish){ out.lookupType="person"; if(nm) out.keywords=[nm]; return out; }
    out.lookupType="role";
  }
  if(lens==="rules"){
    out.process=extractRulesProcess(low);
    out.agency=extractAgency(low);
  }
  if(lens==="property"){
    out.process=extractPropertyProcess(low);
    out.agency=extractAgency(low);
    out.nearMe=extractNearMe(low);
    const boros=["Manhattan","Brooklyn","Queens","Bronx","Staten Island"];
    out.borough=boros.find(b=>low.includes(" "+b.toLowerCase()+" "))||null;
  }
  if(lens==="meetings"){
    out.when=extractMeetingWhen(low);
    out.process=extractMeetingsProcess(low);
    out.nearMe=extractNearMe(low);
    out.agency=extractAgency(low);
    const boros=["Manhattan","Brooklyn","Queens","Bronx","Staten Island"];
    out.borough=boros.find(b=>low.includes(" "+b.toLowerCase()+" "))||null;
    // Action phrasing ("what can I comment on this week") → this week's hearings.
    if(/\bcomment on\b|\btestify\b|\battend\b/.test(low) && !out.when) out.when="week";
  }
  const stop=new Set("the a an of in on for to and or with show me find list all near over under within new nyc city our your their about that this week month what can comment open competitive exams exam guide council district community board process stage hearing hearings auction disposition forecast contracts closing".split(" "));
  out.keywords=[...new Set(text.toLowerCase().replace(/[^a-z0-9 ]/g," ").split(/\s+/).filter(w=>w.length>3&&!stop.has(w)))].slice(0,4);
  // A borough already has its own structured field. Do not also send its words through ZAP's
  // full-text query: "rezonings in Queens" is canonically #land?boro=Queens, not the same
  // borough twice as both boro=Queens and q=queens.
  if(lens==="land" && out.boro){
    const boroWords=new Set(out.boro.toLowerCase().split(/\s+/));
    out.keywords=out.keywords.filter(word=>!boroWords.has(word));
  }
  // Strip district numbers and process stopwords already captured as structured fields.
  if(out.councilDistrict) out.keywords=out.keywords.filter(w=>w!==out.councilDistrict && w!=="district" && w!=="council");
  if(out.process) out.keywords=out.keywords.filter(w=>!["public","process","comment","hearing","hearings","auction","proposal","adoption","effective","scheduled","agenda","outcomes"].includes(w));
  if(out.when) out.keywords=out.keywords.filter(w=>!["week","month","upcoming","recent","past"].includes(w));
  return out;
}

// Keywords that just restate a lens's own implied type read as redundant "keyword soup" once
// the lens-implied chip (below) already states that type distinctly -- e.g. "environmental
// protection land" used to echo "about environmental protection / land", with "land" doing
// nothing but repeating what the Property tab already is. Stripped from both the echo AND the
// applied search filter (not just hidden from view), so what's shown is always what's searched.
const LENS_IMPLIED_WORDS = {
  land: ["rezoning","rezonings","rezone","rezones","zoning","land use","landuse"],
  property: ["property","properties","land","disposition","dispositions","property disposition"],
  rules: ["rule","rules","regulation","regulations","agency rule","agency rules"],
  meetings: ["meeting","meetings","hearing","hearings","public hearing","public hearings"],
};
function stripImpliedKeywords(lens, keywords){
  const stop=new Set((LENS_IMPLIED_WORDS[lens]||[]).map(w=>w.toLowerCase()));
  return (keywords||[]).filter(k=>!stop.has(String(k||"").trim().toLowerCase()));
}

const NL = {
  people: {
    placeholder:"for example, paramedic roles, open competitive exams, or look up someone named Rodriguez",
    chips:f=>[
               f.view==="guide"?`<span class="qchip"><b>${t("nl_chip_exam_guide")}</b></span>`:"",
               f.lookupType?`<span class="qchip">a <b>${f.lookupType==='person'?'person':'role'}</b></span>`:"",
               (f.keywords&&f.keywords.length)?`<span class="qchip">about <b>${f.keywords.join(' / ')}</b></span>`:"" ],
    apply:f=>{
      if(f.view==="guide"){
        location.hash="#people?view=guide";
        return;
      }
      if(f.lookupType){ $("#pmode").value=f.lookupType; $("#pmode").dispatchEvent(new Event("change")); }
      $("#pkw").value=(f.keywords||[]).join(" "); return pSearch();
    }
  },
  land: {
    placeholder:"for example, rezonings in Brooklyn, council district 33, or 79 Rivington",
    // The Land tab is *always* rezonings -- there's no field for it in the filter schema
    // (nothing else the ZAP dataset returns), so a query that names no keyword/borough of its
    // own (e.g. "rezonings in Queens" -- boro consumes "Queens", "rezonings" has nowhere to
    // go) used to echo as just "in Queens", dropping the very thing the user asked about. The
    // leading chip is unconditional, not read off any extracted field. stripImpliedKeywords()
    // keeps "rezoning"/"zoning" out of the "about" chip too -- it's occasionally extracted as
    // a keyword (the device-parser fallback does this), which used to double up on the leading
    // chip ("rezonings · about rezoning").
    chips:f=>{
      const kw=stripImpliedKeywords("land", f.keywords);
      return [ `<span class="qchip">${t("nl_chip_land_kind")}</span>`,
               f.nearMe?`<span class="qchip">${t("near_you_area",{area:"…"})}</span>`:"",
               f.boro?`<span class="qchip">in <b>${f.boro}</b></span>`:"",
               f.communityDistrict?`<span class="qchip">CD <b>${Number(f.communityDistrict.slice(1))}</b></span>`:"",
               f.councilDistrict?`<span class="qchip">${t("council_district_short",{n:f.councilDistrict})}</span>`:"",
               kw.length?`<span class="qchip">about <b>${kw.join(' / ')}</b></span>`:"",
               // Plain language, not filter jargon ("all · incl. closed") -- every echoed
               // filter must be readable as a sentence fragment on its own.
               f.status==='all'?`<span class="qchip">${t("nl_chip_land_status_all")}</span>`:"" ];
    },
    apply:f=>{
      landResolvedArea=null;
      if(f.boro) landBorough=f.boro;
      if(f.status) $("#lstatus").value=f.status;
      landCommunityDistrict=f.communityDistrict||"";
      landCouncilDistrict=f.councilDistrict||"";
      $("#lkw").value=stripImpliedKeywords("land", f.keywords).join(" ");
      if(f.nearMe){
        const btn=$("#landlocation");
        if(btn && !btn.disabled) btn.click();
        else return landSearch();
        return;
      }
      return landSearch();
    }
  },
  property: nlFeed("property","for example, HPD property sales, disposition hearings, DEP land"),
  rules:    nlFeed("rules","for example, buildings rules, rules open for comment"),
  meetings: nlFeed("meetings","for example, hearings this week, landmarks, city council"),
  alerts: {
    placeholder:"for example, education contracts over $200K due in 3 months, or awards over $1M",
    // Reuses parseNL()'s general filter shape — not a single-payload watchType classifier —
    // so ANY combination of category/agency/amount/notice-type/deadline it recognizes
    // survives together, instead of the query collapsing onto whichever one field a fixed
    // enum picked. Rezonings alone stay their own shape (no amount/deadline/agency exists
    // for that lens). The visible "Build an alert" fields cover keywords/amount/months —
    // agency/category/noticeType/maxAmount have no dedicated input (moneynlExtra, below)
    // but still flow into the stored filter and the live preview query.
    chips:f=>{
      if(f.watchType==="rezone") return [`<span class="qchip">rezonings near <b>${f.place||"…"}</b></span>`];
      if(f.route==="agency" && f.name) return [`<span class="qchip">agency <b>${f.name}</b>${f.tab==="forecast"?" · forecast":""}</span>`];
      const chips=[];
      if(f.noticeType) chips.push(`<span class="qchip">${f.noticeType==="award"?"awards":"open RFPs"}</span>`);
      if(f.agency) chips.push(`<span class="qchip">agency <b>${f.agency}</b></span>`);
      if(f.keywords && f.keywords.length) chips.push(`<span class="qchip">about <b>${f.keywords.join(" / ")}</b></span>`);
      if(f.category) chips.push(`<span class="qchip">category <b>${f.category}</b></span>`);
      if(f.minAmount) chips.push(`<span class="qchip">amount ≥ <b>${money(f.minAmount)}</b></span>`);
      if(f.maxAmount) chips.push(`<span class="qchip">amount ≤ <b>${money(f.maxAmount)}</b></span>`);
      if(f.closingWeek) chips.push(`<span class="qchip"><b>${t("nl_chip_closing_this_week")}</b></span>`);
      if(f.months) chips.push(`<span class="qchip">due within <b>${f.months} mo</b></span>`);
      return chips;
    },
    apply:(f,opts)=>{
      if(f.watchType==="rezone"){ applySuggestion("rezone", f.place||""); return; }
      if(f.route==="agency" && f.name){ location.hash=agencyHref(f.name, f.tab||null); return; }
      $("#awatch").value="moneynl"; aWatchChange(opts&&opts.skipQuizSync);
      $("#quiznarrow").value=(f.keywords||[]).join(" ");
      $("#amoneymin").value=f.minAmount||"";
      $("#amoneymonths").value=f.months||"";
      moneynlExtra={agency:f.agency||null, category:f.category||null, maxAmount:f.maxAmount||null, noticeType:f.noticeType||null};
      syncAlertConditionalFields();
      aPreview();
    }
  }
};

// One query brain: "rfpkw"'s free-text field (#aparam, reached either directly via "Build
// an alert" or prefilled by the 60-second quiz's "Narrow by keyword") is the one Alerts
// control that's money-shaped enough to carry a full sentence. Before this, a query typed
// there went to SODA as one literal $q phrase -- "education contracts over 200k due in the
// next 3 months" matched nothing that way -- while the SAME text in the Ask box (which
// already calls nlResolve()) worked, because only the Ask box ran it through parseNL(). This
// is the one place both paths now resolve a non-literal query: promote the watch to the
// fuller "moneynl" shape via NL.alerts.apply(), the SAME function the Ask box's apply step
// calls, so Preview and a saved alert are built from ONE interpreted filter, never the raw
// string re-matched literally. A literal single word or quoted phrase is left alone (returns
// false) so the caller runs its own preview unchanged -- no worker round-trip for that case.
async function resolveMoneyNarrow(){
  if($("#awatch").value !== "rfpkw") return false;
  const text = $("#aparam").value.trim();
  if(!text) return false;
  if(typeof isLiteralKeyword!=="function" && !await loadNlParser()) return false;
  if(isLiteralKeyword(text)) return false;
  const buttons=[$("#apreview")].filter(Boolean);
  buttons.forEach(b=>b.disabled=true);
  const parsed = await nlResolve(text, "alerts");
  buttons.forEach(b=>b.disabled=false);
  const trans=$("#nltrans-alerts");
  const narrowChips=(NL.alerts.chips(parsed)||[]).filter(Boolean);
  if(trans) trans.innerHTML = nlTransHTML(narrowChips, "#aparam", narrowChips.length===0);
  NL.alerts.apply(parsed); // sets #awatch/moneynl fields + moneynlExtra, and calls aPreview()
  return true;
}

function nlFeed(key, placeholder){
  return {
    placeholder,
    // Same class of gap as Land (see NL.land.chips above): Property/Rules/Meetings are each
    // pinned to one City Record section_name, with no field in the filter schema for it -- a
    // query like "HPD property sales" that resolves to agency-only (the model treats "property
    // sales" as lens-implicit, the same way it treats "rezonings") used to echo just the agency,
    // dropping what the results actually are. SECTIONS[key].section is the exact section_name
    // this feed already queries by, and tSection() is the translated label already used
    // everywhere else that name is shown (Today strip, agency profiles) -- reused here rather
    // than a new set of per-language strings.
    // stripImpliedKeywords() (see NL.land.chips above) keeps the lens's own type-word out of
    // the "about" chip and the applied search -- e.g. "environmental protection land" used to
    // echo "about environmental protection / land", with "land" repeating what the lens-implied
    // chip above already says plainly.
    chips:f=>{
      const kw=stripImpliedKeywords(key, f.keywords);
      const processChip = f.process
        ? `<span class="qchip">${t("nl_filter_about_label")} <b>${f.process.replace(/_/g," ")}</b></span>`
        : "";
      return [ `<span class="qchip">${tSection(SECTIONS[key].section)}</span>`,
               f.agency?`<span class="qchip">agency <b>${f.agency}</b></span>`:"",
               kw.length?`<span class="qchip">about <b>${kw.join(' / ')}</b></span>`:"",
               processChip,
               f.nearMe?`<span class="qchip">${t("near_you_area",{area:"…"})}</span>`:"",
               (key==='meetings'&&f.when)?`<span class="qchip"><b>${f.when}</b></span>`:"",
               (key==='meetings'&&f.borough)?`<span class="qchip">${t("affected_area_label")} <b>${f.borough}</b></span>`:"",
               (key==='meetings'&&f.neighborhood)?`<span class="qchip">${t("neighborhood_label")} <b>${f.neighborhood}</b></span>`:"",
               (key==='property'&&f.borough)?`<span class="qchip">${t("borough_label")} <b>${f.borough}</b></span>`:"",
               (key==='property'&&f.neighborhood)?`<span class="qchip">${t("neighborhood_label")} <b>${f.neighborhood}</b></span>`:"",
               (key==='rules'&&f.neighborhood)?`<span class="qchip">${t("neighborhood_label")} <b>${f.neighborhood}</b></span>`:"",
               (key==='property'&&f.asset&&f.asset!=="all")?`<span class="qchip">${t("property_asset_rail_label")} <b>${f.asset}</b></span>`:"",
               (key==='property'&&(f.saleMethod||f.method)&& (f.saleMethod||f.method)!=="all")?`<span class="qchip">${t("property_sale_method_rail_label")} <b>${f.saleMethod||f.method}</b></span>`:"",
               (key==='property'&&(f.priceBand||f.price)&&(f.priceBand||f.price)!=="all")?`<span class="qchip">${t("property_price_rail_label")} <b>${f.priceBand||f.price}</b></span>`:"" ];
    },
    apply:f=>{
      if(key==='meetings'){
        if(f.when){ const w=$("#meetingswhen"); if(w) w.value=f.when; }
        if(f.locationScope==="virtual"||f.locationScope==="citywide"||f.locationScope==="citywide-unlocated"||f.locationScope==="unlocated"){
          $("#meetingsboro").value=f.locationScope;
        } else if(f.borough) $("#meetingsboro").value=f.borough;
        if(f.neighborhood) $("#meetingsneighborhood").value=f.neighborhood;
        meetingsCommunityDistrict=f.communityDistrict||"";
        meetingsCouncilDistrict=f.councilDistrict||"";
        if(f.process && ["scheduled","agenda","held","outcomes","unstaged"].includes(f.process)){
          meetingsProcessSel=f.process;
        }
        if(f.nearMe){
          const btn=$("#meetingslocation");
          if(btn && !btn.disabled){ btn.click(); }
        }
      }
      if(key==='property'){
        if(f.agency) propAgency=f.agency;
        if(f.borough) propertyBorough=f.borough;
        if(f.neighborhood) $("#propertyneighborhood").value=f.neighborhood;
        propertyResolvedNeighborhood=f.neighborhood?{
          name:f.neighborhood,borough:f.borough||null,
          community_districts:f.communityDistrict?[f.communityDistrict]:[],
        }:null;
        propertyCommunityDistrict=f.communityDistrict||"";
        propertyCouncilDistrict=f.councilDistrict||"";
        if(f.process && ["hearing","auction_or_rfp","award_or_conveyance","unstaged"].includes(f.process)){
          propProcessSel=f.process;
        }
        if(f.stage) propStageSel=f.stage;
        if(f.asset) propAsset=f.asset;
        if(f.saleMethod || f.method) propSaleMethod=f.saleMethod||f.method;
        if(f.priceBand || f.price) propPriceBand=f.priceBand||f.price;
        if(f.sort) propSort=f.sort;
        const sortEl=$("#propsort"); if(sortEl && propSort) sortEl.value=propSort;
        if(f.nearMe){
          const btn=$("#propertylocation");
          if(btn && !btn.disabled){ btn.click(); }
        }
      }
      if(key==='rules'){
        if(f.process && ["proposal","public_process","adoption","effective","unstaged"].includes(f.process)){
          rulesProcessSel=f.process;
        }
        if(f.locationScope==="citywide") rulesBorough="citywide";
        else if(f.borough) rulesBorough=f.borough;
      }
      forceSelect("#"+key+"agency", f.agency);
      $("#"+key+"kw").value=stripImpliedKeywords(key, f.keywords).join(" ");
      return loadSection(key);
    }
  };
}

function searchFilterFromHash(lens, hash){
  hash=scopeHash(lens,hash);
  const qi=(hash||"").indexOf("?");
  if(qi<0 || !hash.startsWith("#"+lens+"?")) return null;
  const q=new URLSearchParams(hash.slice(qi+1));
  const keywords=q.get("q")?[q.get("q")]:[];
  if(lens==="people") return {lookupType:q.get("mode")==="person"?"person":"role", keywords};
  if(lens==="land") return {boro:q.get("boro"), communityDistrict:q.get("cd"), councilDistrict:q.get("council"), keywords, status:q.get("status")==="all"?"all":"active"};
  const filter={agency:q.get("agency"), keywords};
  if(lens==="meetings"){
    filter.when=["week","month","upcoming","past","all"].includes(q.get("when"))?q.get("when"):"week";
    filter.borough=DEEPLINK_BOROS.includes(q.get("boro"))?q.get("boro"):null;
    filter.neighborhood=q.get("neighborhood")||null;
    filter.communityDistrict=/^(?:M|X|K|Q|R)\d{2}$/.test(q.get("cd")||"")?q.get("cd"):null;
    filter.councilDistrict=/^(?:[1-9]|[1-4]\d|5[01])$/.test(q.get("council")||"")?q.get("council"):null;
    filter.locationScope=["citywide-unlocated","citywide","virtual","unlocated"].includes(q.get("scope"))?q.get("scope"):null;
    filter.process=q.get("process")||"all";
  }
  if(lens==="property"){
    filter.asset=q.get("asset")||"all";
    filter.saleMethod=q.get("method")||"all";
    filter.priceBand=q.get("price")||"all";
    filter.sort=q.get("sort")||"closing_soon";
    filter.process=q.get("process")||"all";
    filter.stage=q.get("stage")||"all";
    filter.borough=DEEPLINK_BOROS.includes(q.get("boro"))?q.get("boro"):null;
    filter.neighborhood=q.get("neighborhood")||null;
    filter.communityDistrict=/^(?:M|X|K|Q|R)\d{2}$/.test(q.get("cd")||"")?q.get("cd"):null;
    filter.councilDistrict=/^(?:[1-9]|[1-4]\d|5[01])$/.test(q.get("council")||"")?q.get("council"):null;
  }
  if(lens==="rules"){
    filter.borough=DEEPLINK_BOROS.includes(q.get("boro"))?q.get("boro"):null;
    filter.locationScope=q.get("scope")==="citywide"?"citywide":null;
    filter.process=q.get("process")||"all";
  }
  return filter;
}

function searchFilterChips(lens, filter){
  if(lens==="money") return moneyActiveFilterItems(filter).map(moneyActiveFilterChip);
  const keywords=(filter.keywords||[]).filter(Boolean);
  let chips=[];
  if(lens==="people"){
    chips.push(`<span class="qchip">${t("look_up_label")} <b>${t(filter.lookupType==="person"?"pmode_person":"pmode_role")}</b></span>`);
    if(keywords.length) chips.push(`<span class="qchip">${t("nl_filter_about_label")} <b>${enTitle(keywords.join(" / "))}</b></span>`);
  } else if(lens==="land"){
    chips.push(`<span class="qchip">${t("nl_chip_land_kind")}</span>`);
    if(filter.locationArea) chips.push(`<span class="qchip">${t("near_you_area",{area:filter.locationArea})}</span>`);
    else if(filter.boro) chips.push(`<span class="qchip">${t("borough_label")} <b>${filter.boro}</b></span>`);
    if(filter.communityDistrict && !filter.locationArea) chips.push(`<span class="qchip">CD <b>${Number(filter.communityDistrict.slice(1))}</b></span>`);
    if(filter.councilDistrict && !filter.locationArea) chips.push(`<span class="qchip">${t("council_district_short",{n:filter.councilDistrict})}</span>`);
    if(keywords.length) chips.push(`<span class="qchip">${t("nl_filter_about_label")} <b>${enTitle(keywords.join(" / "))}</b></span>`);
    if(filter.status==="all") chips.push(`<span class="qchip">${t("nl_chip_land_status_all")}</span>`);
  } else if(lens==="property"){
    // Active-only (like money): the selected-filters summary hides when nothing is set.
    const methodKeys={online_auction:"sale_method_online_auction",public_auction:"sale_method_public_auction",sealed_bid:"sale_method_sealed_bid",rfp:"sale_method_rfp",lease_auction:"sale_method_lease_auction"};
    const bandKeys={priced:"price_band_priced",under_10k:"price_band_under_10k","10k_100k":"price_band_10k_100k","100k_plus":"price_band_100k_plus"};
    if(filter.asset && filter.asset!=="all") chips.push(`<span class="qchip">${t("property_asset_label")} <b>${t(ASSET_LABEL[filter.asset]||"asset_other")}</b></span>`);
    const method=filter.saleMethod||filter.method;
    if(method && method!=="all") chips.push(`<span class="qchip">${t("property_sale_method_rail_label")} <b>${t(methodKeys[method]||"sale_method_unknown")}</b></span>`);
    const band=filter.priceBand||filter.price;
    if(band && band!=="all") chips.push(`<span class="qchip">${t("property_price_rail_label")} <b>${t(bandKeys[band]||"price_band_priced")}</b></span>`);
    if(filter.process && filter.process!=="all") chips.push(`<span class="qchip">${t("property_process_label")} <b>${t(([["hearing","disposition_stage_hearing"],["auction_or_rfp","disposition_stage_auction_or_rfp"],["award_or_conveyance","disposition_stage_award_or_conveyance"],["unstaged","disposition_stage_unstaged"]].find(([key])=>key===filter.process)||[])[1]||"stage_all")}</b></span>`);
    if(filter.stage && filter.stage!=="all") chips.push(`<span class="qchip">${t("property_stage_label")} <b>${t((PROP_STAGES.find(([key])=>key===filter.stage)||[])[1]||"stage_all")}</b></span>`);
    if(filter.borough) chips.push(`<span class="qchip">${t("borough_label")} <b>${filter.borough}</b></span>`);
    if(filter.neighborhood) chips.push(`<span class="qchip">${t("neighborhood_label")} <b>${filter.neighborhood}</b></span>`);
    else if(filter.communityDistrict) chips.push(`<span class="qchip">CD <b>${Number(filter.communityDistrict.slice(1))}</b></span>`);
    if(filter.councilDistrict) chips.push(`<span class="qchip">${t("council_district_short",{n:filter.councilDistrict})}</span>`);
    if(keywords.length) chips.push(`<span class="qchip">${t("nl_filter_about_label")} <b>${enTitle(keywords.join(" / "))}</b></span>`);
    return chips;
  } else {
    chips.push(`<span class="qchip">${tSection(SECTIONS[lens].section)}</span>`);
    if(filter.agency) chips.push(`<span class="qchip">${t("agency_label")} <b>${enTitle(filter.agency)}</b></span>`);
    if(keywords.length) chips.push(`<span class="qchip">${t("nl_filter_about_label")} <b>${enTitle(keywords.join(" / "))}</b></span>`);
    if(lens==="meetings"){
      const whenKey=filter.when==="week"?"this_week":filter.when==="month"?"next_30_days":filter.when==="past"?"recent_past":filter.when==="all"?"map_drill_when_all":"all_upcoming";
      chips.push(`<span class="qchip"><b>${t(whenKey)}</b></span>`);
      if(filter.borough) chips.push(`<span class="qchip">${t("affected_area_label")} <b>${filter.borough}</b></span>`);
      if(filter.neighborhood) chips.push(`<span class="qchip">${t("neighborhood_label")} <b>${filter.neighborhood}</b></span>`);
      if(filter.communityDistrict) chips.push(`<span class="qchip">${t("community_district_short",{n:filter.communityDistrict})}</span>`);
      if(filter.councilDistrict) chips.push(`<span class="qchip">${t("council_district_short",{n:filter.councilDistrict})}</span>`);
      if(filter.locationScope==="virtual") chips.push(`<span class="qchip">${t("map_bucket_virtual")}</span>`);
      else if(filter.locationScope==="citywide") chips.push(`<span class="qchip">${t("map_bucket_citywide")}</span>`);
      else if(filter.locationScope==="unlocated") chips.push(`<span class="qchip">${t("map_bucket_unlocated")}</span>`);
      else if(filter.locationScope) chips.push(`<span class="qchip">${t("citywide_unlocated")}</span>`);
      if(filter.process && filter.process!=="all") chips.push(`<span class="qchip">${t("meetings_process_label")} <b>${t(([["scheduled","meeting_stage_scheduled"],["agenda","meeting_stage_agenda"],["held","meeting_stage_held"],["outcomes","meeting_stage_outcomes"],["unstaged","meeting_stage_unstaged"]].find(([key])=>key===filter.process)||[])[1]||"stage_all")}</b></span>`);
    }
    if(lens==="rules"){
      if(filter.locationScope==="citywide") chips.push(`<span class="qchip">${t("map_bucket_citywide")}</span>`);
      if(filter.borough) chips.push(`<span class="qchip">${t("borough_label")} <b>${filter.borough}</b></span>`);
      if(filter.process && filter.process!=="all") chips.push(`<span class="qchip">${t("rules_process_label")} <b>${t(([["proposal","rule_phase_proposal"],["public_process","rule_phase_public_process"],["adoption","rule_phase_adoption"],["effective","rule_phase_effective"],["unstaged","rule_stage_unstaged"]].find(([key])=>key===filter.process)||[])[1]||"stage_all")}</b></span>`);
    }
  }
  return chips;
}

// One interpreted-row component for every arrival path: Ask, hand-set controls, or a cold
// shared link. Lens-specific code supplies only the filter-to-chip conversion.
function interpretedSearchRowHTML(lens, filter, suppliedChips){
  const chips=suppliedChips||searchFilterChips(lens, filter);
  if(!chips.length) return "";
  const clearId=lens==="money"?' id="moneyactiveclear"':"";
  return `<div class="nlunderstood searchactive${lens==="money"?" moneyactive":""}"><span role="status">${t("nl_understood_label")} ${chips.join(" ")}</span><button type="button" class="mini"${clearId} data-search-clear="${lens}">${t("clear_filters_btn")}</button></div>`;
}

function bindClearSearchState(lens, root){
  const clear=root?.querySelector("[data-search-clear]"); if(!clear) return;
  clear.addEventListener("click",()=>{
    if(lens==="money"){
      moneyNlResolved={};
      $("#mode").value="open"; $("#agency").value=""; $("#kw").value=""; $("#sort").value="deadline";
      forceAmountSelect(null); closingWeek=false; methodSel="";
      $("#closingweek").classList.remove("on"); $("#closingweek").setAttribute("aria-pressed", "false");
      $("#nltrans").innerHTML=""; search(); return;
    }
    if(lens==="people"){
      $("#pmode").value="role"; $("#pmode").dispatchEvent(new Event("change")); $("#pkw").value="";
      $("#nltrans-people").innerHTML=""; pSearch(); return;
    }
    if(lens==="land"){
      landResolvedArea=null;
      landCommunityDistrict="";
      landCouncilDistrict="";
      landBorough=""; $("#lkw").value=""; $("#lstatus").value="all";
      $("#nltrans-land").innerHTML=""; landSearch(); return;
    }
    forceSelect("#"+lens+"agency", "");
    $("#"+lens+"agency").value="";
    $("#"+lens+"kw").value="";
    const when=$("#"+lens+"when"); if(when) when.value="upcoming";
    if(lens==="meetings"){ $("#meetingswhen").value="week"; $("#meetingsboro").value=""; $("#meetingsneighborhood").value=""; meetingsCommunityDistrict=""; meetingsCouncilDistrict=""; meetingsProcessSel="all"; meetingsPlaceGroupSel="flat"; }
    if(lens==="property"){
      propAsset="all"; propStageSel="all"; propProcessSel="all"; propAgency="";
      propSaleMethod="all"; propPriceBand="all"; propSort="closing_soon";
      const sortEl=$("#propsort"); if(sortEl) sortEl.value="closing_soon";
      propertyBorough=""; $("#propertyneighborhood").value="";
      propertyCommunityDistrict=""; propertyCouncilDistrict=""; propertyResolvedNeighborhood=null;
    }
    if(lens==="rules"){ rulesProcessSel="all"; rulesBorough=""; }
    $("#nltrans-"+lens).innerHTML="";
    loadSection(lens);
  });
}

function searchLabelFromHash(lens, hash){
  const q=new URLSearchParams((hash.split("?")[1]||""));
  const parts=["q","agency","boro","neighborhood","scope","cd","mode","status","when","asset","stage"].map(key=>q.get(key)).filter(Boolean);
  return parts.join(" · ") || t("tab_"+lens);
}

function documentSearchHash(lens){
  const facets={money:"contracts",people:"staffing",land:"zoning",property:"property",rules:"rules",meetings:"meetings"};
  const expected=facets[lens];
  const match=location.pathname.replace(/\/+$/,"").match(/^\/browse(?:\/([^/]+))?$/);
  const facet=match?match[1]||null:null;
  if(!expected || facet!==expected) return null;
  const params=new URLSearchParams(location.search);
  params.delete("lang");
  params.delete("legacy");
  return "#"+lens+(params.size?"?"+params.toString():"");
}

function renderSearchComponents(lens, options){
  if(!["people","land","property","rules","meetings"].includes(lens)) return;
  const serialized=location.hash.startsWith("#"+lens+"?")?serializeState():documentSearchHash(lens);
  const hash=(options&&options.hash)||serialized;
  const safeHash=hash&&hash.startsWith("#"+lens+"?")?hash:null;
  const filter=(options&&options.filter)||searchFilterFromHash(lens, safeHash);
  const state=document.querySelector(`[data-search-state="${lens}"]`);
  const actions=document.querySelector(`[data-search-actions="${lens}"]`);
  if(state){
    state.innerHTML=filter?interpretedSearchRowHTML(lens, filter):"";
    bindClearSearchState(lens, state);
  }
  if(actions){
    actions.innerHTML=searchActionsHTML(lens, safeHash);
    bindSearchActions(actions, (options&&options.label)||searchLabelFromHash(lens, safeHash||""), safeHash);
  }
  renderNLQPresets();
}

function currentMeetingsQueryFilter(){
  const hash=serializeState();
  const filter=searchFilterFromHash("meetings",hash)||{};
  const query=new URLSearchParams((hash.split("?")[1]||""));
  // The default week view is presentation state, not an explicit clause. An Ask time
  // proposal may replace it without manufacturing a conflict.
  if(!query.has("when")) delete filter.when;
  return filter;
}

function queryConflictHTML(composed){
  const conflict=composed.conflicts[0];
  return `<div class="nlunderstood-weak query-conflict" role="alert"><p>${t("query_conflict_prompt")}</p><div class="chiprow"><button type="button" class="mini" data-query-conflict-choice="keep_current">${t("query_conflict_keep",{value:nlqEscape(conflict.current)})}</button><button type="button" class="mini" data-query-conflict-choice="use_proposed">${t("query_conflict_use",{value:nlqEscape(conflict.proposed)})}</button></div></div>`;
}

function bindQueryConflict(root, composed, label){
  root.querySelectorAll("[data-query-conflict-choice]").forEach(button=>button.addEventListener("click",async()=>{
    root.querySelectorAll("button").forEach(candidate=>{ candidate.disabled=true; });
    const state=composed.choices[button.dataset.queryConflictChoice];
    const filter=lensQueryStateFilter(state);
    const hash=buildSearchDeepLink("meetings",filter);
    await NL.meetings.apply(filter);
    root.innerHTML="";
    renderSearchComponents("meetings",{hash,label});
  }));
}

async function nlTranslateLens(lens, opts){
  const inpSel=(opts&&opts.inputSel)||("#nlq-"+lens);
  const text=(opts&&opts.text!=null)?opts.text:($(inpSel)?.value.trim()||"");
  if(!text) return;
  if(inpSel==="#nlq-"+lens) askPanel(lens)?.setAttribute("open","");
  const btn=$("#nlgo-"+lens); if(btn) btn.disabled=true;
  $("#nltrans-"+lens).innerHTML=nlWorkingHTML();
  const f=await nlResolve(text, lens);
  const chips=(NL[lens].chips(f)||[]).filter(Boolean);
  $("#nltrans-"+lens).innerHTML=nlTransHTML(chips, inpSel, chips.length===0);
  if(btn) btn.disabled=false;
  const context=globalThis.CrolPlaceContext;
  const inputFilter={...f};
  if(["land","property","rules","meetings"].includes(lens)) inputFilter.keywords=stripImpliedKeywords(lens, f.keywords);
  const contextual=context?.lensSearchState?.(inputFilter, lens, buildSearchDeepLink);
  let linkFilter=contextual?.filter||inputFilter;
  if(lens==="meetings"){
    const composed=composeLensQueryState("meetings",currentMeetingsQueryFilter(),linkFilter);
    if(composed.conflicts.length){
      const root=$("#nltrans-meetings");
      root.innerHTML=queryConflictHTML(composed);
      bindQueryConflict(root,composed,text);
      if(btn) btn.disabled=false;
      return;
    }
    linkFilter=lensQueryStateFilter(composed.state);
  }
  const deepLink=buildSearchDeepLink(lens, linkFilter);
  const carriedDeepLink=lens==="meetings"?deepLink:(contextual?.hash||deepLink);
  await NL[lens].apply(linkFilter);
  if(chips.length) $("#nltrans-"+lens).innerHTML="";
  renderSearchComponents(lens, {hash:carriedDeepLink, label:text});
}

const NL_SUGGESTIONS_FALLBACK = {
  money: [0, 1, 2, 3, 4, 5, 6, 7],
  people: [1, 3],
  land: [0, 1, 2, 3, 4],
  property: [0, 1, 2, 4],
  rules: [0, 1, 2, 3, 4],
  meetings: [0, 1, 2, 3, 4, 5],
  alerts: [0, 1, 2, 3],
};
let NL_SUGGESTIONS_VALIDATED = null; // {lens: [{idx,count,lineageRich,forecastBearing}, ...]} once GET /suggestions resolves

function currentSuggestionIndices(lens){
  const validated = NL_SUGGESTIONS_VALIDATED && NL_SUGGESTIONS_VALIDATED[lens];
  if(validated && validated.length) return validated.map(c=>c.idx);
  return NL_SUGGESTIONS_FALLBACK[lens] || [];
}

function currentSuggestionMeta(lens){
  const validated = (NL_SUGGESTIONS_VALIDATED && NL_SUGGESTIONS_VALIDATED[lens]) || [];
  const lineage = new Set(), forecast = new Set();
  validated.forEach(c=>{
    if(c.lineageRich) lineage.add(c.idx);
    if(c.forecastBearing) forecast.add(c.idx);
  });
  return { lineage, forecast };
}

function pickSuggestions(indices, displayCount, seed){
  if(!indices || !indices.length) return [];
  const n = indices.length;
  const start = ((seed % n) + n) % n;
  const count = Math.min(displayCount, n);
  const out = [];
  for(let i=0;i<count;i++) out.push(indices[(start+i)%n]);
  return out;
}

const LINEAGE_GUARANTEE_MIN = 2;
function pickSuggestionsGuaranteed(indices, lineageIndices, displayCount, seed, guarantee){
  if(!lineageIndices || !lineageIndices.length || !guarantee) return pickSuggestions(indices, displayCount, seed);
  const need = Math.min(guarantee, lineageIndices.length, displayCount);
  const lineagePicked = pickSuggestions(lineageIndices, need, seed);
  const rest = indices.filter(idx=>!lineagePicked.includes(idx));
  const restPicked = pickSuggestions(rest, displayCount - lineagePicked.length, seed);
  return [...lineagePicked, ...restPicked].slice(0, displayCount);
}
function daySeed(){ return Math.floor(Date.now()/86400000); }

// Hints stay outside the button so applyStrings() can replace its translated text.
function trychipHTML(lens, idx, meta){
  const isLineage = meta.lineage.has(idx), isForecast = meta.forecast.has(idx);
  const cls = ["trychip", "teaching-example"];
  if(isLineage) cls.push("has-lineage");
  if(isForecast) cls.push("has-forecast");
  const describedBy = [], hints = [];
  if(isLineage){
    const id = `sugghint-lineage-${lens}-${idx}`;
    describedBy.push(id);
    hints.push(`<span id="${id}" class="sr-only" data-i18n="sugg_lineage_hint">${t("sugg_lineage_hint")}</span>`);
  }
  if(isForecast){
    const id = `sugghint-forecast-${lens}-${idx}`;
    describedBy.push(id);
    hints.push(`<span id="${id}" class="sr-only" data-i18n="sugg_forecast_hint">${t("sugg_forecast_hint")}</span>`);
  }
  const describedAttr = describedBy.length ? ` aria-describedby="${describedBy.join(" ")}"` : "";
  return `<button type="button" class="${cls.join(" ")}" data-i="${idx}" data-i18n="sugg_${lens}_${idx}"${describedAttr}>${t("sugg_"+lens+"_"+idx)}</button>${hints.join("")}`;
}

function renderNLSamples(lens, el){
  if(!el) return;
  const meta = currentSuggestionMeta(lens);
  const indices = currentSuggestionIndices(lens);
  const picked = lens==="money"
    ? pickSuggestionsGuaranteed(indices, [...meta.lineage], 3, daySeed(), LINEAGE_GUARANTEE_MIN)
    : pickSuggestions(indices, 3, daySeed());
  const examples=picked.map(idx=>trychipHTML(lens, idx, meta)).join("");
  el.innerHTML = `<span class="teaching-examples-label" data-i18n="try_asking_label">${t("try_asking_label")}</span><div class="teaching-example-list">${examples}</div>`;
  el.querySelectorAll(".teaching-example").forEach(b=>b.addEventListener("click",()=>{
    const inp = lens==="money" ? $("#nlq") : $("#nlq-"+lens);
    if(inp) inp.value = b.textContent;
    lens==="money" ? nlTranslate() : nlTranslateLens(lens);
  }));
}

function rerenderAllSuggestions(){
  renderNLSamples("money", $("#nltry"));
  ["people","land","property","rules","meetings","alerts"].forEach(lens=>renderNLSamples(lens, $("#nltry-"+lens)));
}

async function loadValidatedSuggestions(){
  try{
    const r = await workerFetch("/suggestions", null, 6000);
    if(r && r.ok){
      const data = await r.json();
      if(data && data.byLens){ NL_SUGGESTIONS_VALIDATED = data.byLens; rerenderAllSuggestions(); }
    }
  }catch(e){ /* stays on the static fallback */ }
}

function askPanel(lens){ return document.querySelector(`[data-ask-lens="${lens}"]`); }

function deactivateAskSearch(lens){
  const suffix=lens==="money"?"":"-"+lens;
  const input=$("#nlq"+suffix), translation=$("#nltrans"+suffix);
  if(input) input.value="";
  askPanel(lens)?.removeAttribute("open");
  if(translation) translation.innerHTML="";
  if(lens==="money") moneyNlResolved={};
}

function injectNLBoxes(){
  const tabs={people:["#tab-people",".controls"],land:["#tab-land","#land-toolbar"],property:["#tab-property",".controls"],rules:["#tab-rules","#rules-toolbar"],meetings:["#tab-meetings","#meetings-toolbar"],alerts:["#tab-alerts",".grid"]};
  Object.entries(tabs).forEach(([lens,[sel,anchorSel]])=>{
    const wrap=document.querySelector(sel+" .wrap"); if(!wrap) return;
    const anchor=wrap.querySelector(anchorSel); if(!anchor) return;
    const box=document.createElement("details"); box.className="nlbox ask-cityscroll"; box.dataset.askLens=lens;
    box.innerHTML='<summary data-i18n="ask_cityscroll_action">'+t("ask_cityscroll_action")+'</summary><div class="nlbody">'+
      '<div class="nlrow"><input type="text" id="nlq-'+lens+'" aria-label="'+t("nl_aria")+'" data-i18n-aria="nl_aria" data-i18n-placeholder="nl_placeholder_'+lens+'" placeholder="'+NL[lens].placeholder+'">'+
      '<button id="nlgo-'+lens+'" data-i18n="ask_btn">Ask</button></div>'+
      '<div id="nltry-'+lens+'" class="nltry"></div><div id="nltrans-'+lens+'"></div></div>';
    if(lens==="alerts") anchor.parentNode.insertBefore(box, anchor);
    else anchor.insertAdjacentElement("afterend", box);
    $("#nlgo-"+lens).addEventListener("click",()=>nlTranslateLens(lens));
    $("#nlq-"+lens).addEventListener("keydown",e=>{ if(e.key==="Enter") nlTranslateLens(lens); });
    const state=wrap.querySelector(`[data-search-state="${lens}"]`)?"":'<div id="searchstate-'+lens+'" data-search-state="'+lens+'"></div>';
    box.insertAdjacentHTML("afterend",'<p class="ask-context" data-i18n="ask_cityscroll_context">'+t("ask_cityscroll_context")+'</p>'+(lens==="alerts"?"":'<div class="search-scope-tools">'+state+'<div id="searchactions-'+lens+'" data-search-actions="'+lens+'"></div><div id="nlpresets-'+lens+'" data-search-presets></div></div>'));
    renderNLSamples(lens, $("#nltry-"+lens));
  });
  Object.entries({money:"kw",people:"pkw",land:"lkw",property:"propertykw",rules:"ruleskw",meetings:"meetingskw",alerts:"quiznarrow"}).forEach(([lens,id])=>$("#"+id)?.addEventListener("input",()=>deactivateAskSearch(lens)));
}

function exportContextForRow(row){
  const context={actions:[]};
  if(globalThis.CrolActions && typeof CrolActions.compileActionRail==="function" && typeof noticeActionMatter==="function"){
    try{
      const lifecycle=row?._export_context?.lifecycle||null;
      context.actions=(CrolActions.compileActionRail(noticeActionMatter(row,null,lifecycle),{today:todayISO()})||[]).map(action=>({
        type:action.type||action.kind||"",
        label:typeof actionRailLabel==="function"?actionRailLabel(action):(action.label||action.type||""),
        destination:action.destination||action.url||"",
        destination_label:action.destination_label||"",
        delivery:action.delivery||"",
        deadline:action.deadline||row.due_date||row.event_date||"",
      }));
      const primary=context.actions.find(action=>action.destination);
      if(primary) context.primary_action_url=primary.destination;
    }catch(_e){}
  }
  return context;
}

function noticeRenderedExportContext(root){
  const context={actions:[],timed_events:[],lifecycle_rows:[],entities:[],sources:[],rendered_context:[]};
  if(!root) return context;
  const policy=CrolExports.EXPORT_CLASS_POLICY||{};
  root.querySelectorAll("[data-export-class]").forEach(section=>{
    const dataClass=section.dataset.exportClass||"";
    if(!dataClass||policy[dataClass]?.excluded) return;
    const text=(section.textContent||"").replace(/\s+/g," ").trim();
    if(!text) return;
    const links=[...section.querySelectorAll("a[href]")].map(link=>link.href).filter(Boolean);
    context.rendered_context.push({data_class:dataClass,text,links});
    context.lifecycle_rows.push({lifecycle:dataClass,stage:dataClass,status:"rendered",detail:text,source_url:links[0]||""});
    section.querySelectorAll("a[href]").forEach(link=>{
      const href=link.href||"";
      const label=(link.textContent||"").replace(/\s+/g," ").trim();
      if(/^https?:/i.test(href)) context.sources.push({source_class:dataClass,label,url:href});
      if(/(?:#|\/)(?:agency|vendor|land|notices?)\b/i.test(href)){
        const match=href.match(/(?:#|\/)(agency|vendor|land|notices?)\b/i);
        context.entities.push({entity_type:match?.[1]||"linked",name:label,relationship:dataClass,url:href,evidence:"rendered"});
      }
    });
    ["[datetime]","[data-land-statutory-due]","[data-date-chip]"].forEach(selector=>{
      section.querySelectorAll(selector).forEach(node=>{
        const date=node.getAttribute("datetime")||node.dataset.landStatutoryDue||node.dataset.date||"";
        if(date) context.timed_events.push({event_type:dataClass,event_at:date,label:(node.textContent||"").trim(),status:node.dataset.deadlineState||node.dataset.landStatutoryStatus||""});
      });
    });
  });
  const actionNodes=[];
  root.querySelectorAll('[data-export-class="actions"]').forEach(section=>{
    section.querySelectorAll("a[href]").forEach(node=>actionNodes.push(node));
    ["[data-next-calendar]","[data-rule-event]","[data-ev]"].forEach(selector=>{
      section.querySelectorAll(selector).forEach(node=>actionNodes.push(node));
    });
  });
  actionNodes.forEach(node=>{
    const label=(node.textContent||"").replace(/\s+/g," ").trim();
    if(!label) return;
    context.actions.push({
      type:node.hasAttribute("data-next-calendar")?"calendar":"rendered_action",
      label,
      destination:node.href||node.dataset.copyValue||"",
      delivery:node.href&&/^https?:/i.test(node.href)?"official_handoff":"local",
    });
  });
  const primary=root.querySelector('[data-export-class="actions"] a[href]');
  if(primary) context.primary_action_url=primary.href;
  return context;
}

function mergeExportContexts(...contexts){
  const merged={actions:[],timed_events:[],lifecycle_rows:[],entities:[],sources:[],rendered_context:[]};
  contexts.filter(Boolean).forEach(context=>{
    Object.keys(merged).forEach(key=>merged[key].push(...(Array.isArray(context[key])?context[key]:[])));
    if(!merged.primary_action_url&&context.primary_action_url) merged.primary_action_url=context.primary_action_url;
  });
  return merged;
}

function withEnrichedExportSpec(lens,spec){
  const labels=new Set((spec.columns||[]).map(column=>Array.isArray(column)?column[0]:column.label));
  const extras=CrolExports.enrichedCsvColumns({
    kind:lens==="land"?"land":"notice",
    contextFor:exportContextForRow,
    permalinkFor:row=>row.request_id?noticeLink(row.request_id):(row.project_id?landLink(row.project_id):location.href),
    cityRecordFor:row=>row.request_id?REQ_URL(row.request_id):"",
  }).filter(column=>!labels.has(column.label));
  return {...spec,columns:[...(spec.columns||[]),...extras]};
}

function exportSpec(lens){
  const searchLink=()=>location.href;
  if(lens==="money") return withEnrichedExportSpec(lens,{rows:currentRows, columns:[
    {label:"Type",value:r=>r.type_of_notice_description,width:22},
    {label:"Agency",value:r=>r.agency_name,width:32},
    {label:"Title",value:r=>cleanText(r.short_title),width:48},
    ["Category",r=>r.category_description],
    {label:"Posted",value:r=>fdate(r.start_date),xlsxValue:r=>r.start_date,type:"date",width:13},
    {label:"Due",value:r=>isRollingDeadline(r.due_date)?"no fixed deadline (rolling)":fdate(r.due_date),xlsxValue:r=>isRollingDeadline(r.due_date)?"":r.due_date,type:"date",width:13},
    {label:"Days left",value:r=>{if(isRollingDeadline(r.due_date)) return "";const d=daysLeft(r.due_date);return d==null?"":d;},type:"number",width:12},
    ["Method",r=>cleanText(r.selection_method_description)],["Contact",r=>cleanText(r.contact_name)],
    ["Email",r=>r.email||""],["Phone",r=>cleanText(r.contact_phone)],
    ["Submit to",r=>cleanText(r.address_to_request)],["PIN",r=>r.pin||""],
    {label:"Amount",value:r=>r.contract_amount||"",type:"number",width:16},
    ["Request ID",r=>r.request_id||""],
    ["Permalink",r=>noticeLink(r.request_id)],["City Record URL",r=>REQ_URL(r.request_id)]
  ]});
  if(lens==="people") return withEnrichedExportSpec(lens,{rows:staffingVisibleItems(), columns:[
    ["Type",r=>r.kind==="exam"?t("staffing_filter_exams"):t("staffing_new_hire_tag")],
    [t("csv_role"),r=>r.role||""],[t("person_name_label"),r=>r.person||""],["Agency",r=>r.agency||""],
    {label:"Posted / application start",value:r=>r.published_at||"",type:"date",width:22},
    ["Effective / application end",r=>r.kind==="exam"?(r.exam.application_end||""):(r.effective_date||"")],
    {label:t("staffing_salary",{amount:""}).trim(),value:r=>r.salary||"",type:"number",width:16},
    [t("staffing_title_code",{code:""}).trim()+" / "+t("career_exam_number",{number:""}).trim(),r=>r.kind==="exam"?r.request_id:(r.title_code||"")],
    ["Request ID",r=>r.kind==="hire"?r.request_id:""],
    ["City Record URL",r=>r.kind==="hire"?REQ_URL(r.request_id):CrolStaffing.examUrl(r.request_id, location.origin)],
    [t("csv_search_permalink"),searchLink]
  ]});
  if(lens==="land") return withEnrichedExportSpec(lens,{rows:lRows, columns:[
    {label:t("csv_project"),value:r=>r.project_name,width:40},
    ["Borough",r=>r.borough],["Community district",r=>r.community_district],
    [t("csv_status"),r=>r.public_status||r.project_status],["Milestone",r=>cleanText(r.current_milestone)],
    {label:"Milestone date",value:r=>fdate(r.current_milestone_date),xlsxValue:r=>r.current_milestone_date,type:"date",width:15},
    [t("csv_applicant"),r=>r.primary_applicant],
    [t("csv_project_id"),r=>r.project_id],["Permalink",r=>landLink(r.project_id)]
  ]});
  const rows=feedVisible[lens]||[];
  const columns=[
    {label:"Type",value:r=>r.type_of_notice_description,width:22},
    {label:"Agency",value:r=>r.agency_name,width:32},
    {label:"Title",value:r=>cleanText(r.short_title),width:48},
    {label:"Posted",value:r=>fdate(r.start_date),xlsxValue:r=>r.start_date,type:"date",width:13},
    {label:"Event date",value:r=>fdate(r.event_date),xlsxValue:r=>r.event_date,type:"date",width:13},
    [t("csv_address"),r=>cleanText(r.street_address_1)],
    ["Request ID",r=>r.request_id],["Permalink",r=>noticeLink(r.request_id)],
    ["City Record URL",r=>REQ_URL(r.request_id)]
  ];
  if(lens==="property"){
    columns.splice(3,0,
      [t("csv_asset_type"),r=>r._asset||(r.commercial&&r.commercial.item&&r.commercial.item.category)||""],
      [t("csv_commercial_item"),r=>(r.commercial&&r.commercial.glance&&r.commercial.glance.item)||(r.commercial&&r.commercial.item&&r.commercial.item.label)||""],
      [t("csv_primary_price"),r=>{
        const p=r.commercial&& (r.commercial.primary_price|| (r.commercial.glance&&r.commercial.glance.price));
        return p ? (p.display || (p.amount!=null?String(p.amount):"")) : "";
      }],
      [t("csv_price_kind"),r=>{
        const p=r.commercial&& (r.commercial.primary_price|| (r.commercial.glance&&r.commercial.glance.price));
        return p&&p.kind ? p.kind : "";
      }],
      [t("csv_sale_method"),r=>(r.commercial&&r.commercial.sale_method&&r.commercial.sale_method.method)||""],
      [t("csv_close_date"),r=>(r.commercial&&r.commercial.close_date)||r.event_date||""],
      [t("property_process_label"),r=>r.disposition_stage||""],
      ["Lifecycle",r=>r._stage||""],
      [t("csv_sale_eligible"),r=>r.commercial&&r.commercial.sale_eligible===false?"no":"yes"],
    );
  }
  return withEnrichedExportSpec(lens,{rows,columns});
}
async function exportLensCsv(lens){
  await ensureCrolExports();
  const spec=exportSpec(lens);
  if(!spec||!spec.rows.length) return;
  CrolExports.downloadFile(
    `crol-${lens}-${new Date().toISOString().slice(0,10)}.csv`,
    CrolExports.excelSafeCsv(spec.columns,spec.rows),
    "text/csv;charset=utf-8"
  );
}
async function exportPropertyAuctionCsv(){
  await ensureCrolExports();
  const rows=globalThis.propertyAuctionExportVisible||[];
  if(!rows.length) return;
  const columns=[
    [t("csv_address"),r=>r.address], ["Block",r=>r.block], ["Lot",r=>r.lot],
    ["BBL",r=>r.bbl], [t("property_process_label"),r=>r.stage],
    ["Posted",r=>r.posted], ["Event date",r=>r.event_date],
    [t("csv_close_date"),r=>r.close_date], ["Boroughs",r=>r.boroughs],
    ["Community districts",r=>r.community_districts], ["Council districts",r=>r.council_districts],
    ["Neighborhoods",r=>r.neighborhoods], ["Latitude",r=>r.latitude], ["Longitude",r=>r.longitude],
    [t("csv_asset_type"),r=>r.asset_type], [t("csv_commercial_item"),r=>r.commercial_item],
    [t("csv_primary_price"),r=>r.price_amount], [t("csv_price_kind"),r=>r.price_kind],
    [t("csv_sale_method"),r=>r.sale_method], ["Participation URL",r=>r.participation_url],
    ["Disposition subject",r=>r.disposition_subject], ["Disposition join keys",r=>r.disposition_join_keys],
    [t("csv_project_id"),r=>r.project_ids], ["Request ID",r=>r.request_id],
    ["Permalink",r=>r.permalink], ["City Record URL",r=>r.source_link],
  ];
  CrolExports.downloadFile(
    `cityscroll-property-auction-parcels-${new Date().toISOString().slice(0,10)}.csv`,
    CrolExports.excelSafeCsv(columns,rows),
    "text/csv;charset=utf-8"
  );
}
async function exportLensXlsx(lens){
  await ensureCrolExports();
  const spec=exportSpec(lens);
  if(!spec||!spec.rows.length) return;
  const bytes=CrolExports.buildEnrichedListWorkbook(
    lens.charAt(0).toUpperCase()+lens.slice(1),
    spec.rows,
    {
      kind:lens==="land"?"land":"notice",
      primaryColumns:spec.columns,
      contextFor:exportContextForRow,
      permalinkFor:row=>row.kind==="exam"?CrolStaffing.examUrl(row.request_id, location.origin):(row.request_id?noticeLink(row.request_id):(row.project_id?landLink(row.project_id):location.href)),
      cityRecordFor:row=>row.kind==="exam"?CrolStaffing.examUrl(row.request_id, location.origin):(row.request_id?REQ_URL(row.request_id):""),
    }
  );
  CrolExports.downloadFile(
    `crol-${lens}-${new Date().toISOString().slice(0,10)}.xlsx`,
    new Blob([bytes],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"})
  );
}
async function exportNoticeXlsx(notice, chain){
  await ensureCrolExports();
  const root=document.querySelector("#noticeview .route-item")||document.querySelector("#detail");
  const context=mergeExportContexts(exportContextForRow(notice),noticeRenderedExportContext(root));
  const bytes=CrolExports.buildNoticeWorkbook(notice,chain,record=>noticeLink(record.request_id),context);
  CrolExports.downloadFile(
    `crol-notice-${String(notice.request_id||"export").replace(/[^a-z0-9_-]/gi,"-")}.xlsx`,
    new Blob([bytes],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"})
  );
}
function preparePrintView(kind, permalink){
  const meta=t("print_header",{
    link:permalink||location.href,
    date:new Date().toLocaleDateString((window.LANG_META[window.LANG||"en"]||{}).intlDate||"en-US",{year:"numeric",month:"long",day:"numeric"})
  });
  document.body.setAttribute("data-print-meta",meta);
  document.body.classList.toggle("printing-list",kind!=="notice");
  document.body.classList.toggle("printing-notice",kind==="notice");
}
function clearPrintView(){
  document.body.classList.remove("printing-list","printing-notice");
}
function printCurrentView(kind, permalink){
  preparePrintView(kind,permalink);
  window.print();
}
window.addEventListener("afterprint",clearPrintView);

// Publish live bindings for neighboring modules and legacy inline handlers.
globalThis.LENS_IMPLIED_WORDS = LENS_IMPLIED_WORDS;
globalThis.LINEAGE_GUARANTEE_MIN = LINEAGE_GUARANTEE_MIN;
globalThis.NL = NL;
globalThis.NLQ_PRESET_KEY = NLQ_PRESET_KEY;
globalThis.NL_SUGGESTIONS_FALLBACK = NL_SUGGESTIONS_FALLBACK;
globalThis.bindClearSearchState = bindClearSearchState;
globalThis.bindNLQResolvedActions = bindNLQResolvedActions;
globalThis.bindQRShare = bindQRShare;
globalThis.bindSearchActions = bindSearchActions;
globalThis.clearPrintView = clearPrintView;
globalThis.currentSuggestionIndices = currentSuggestionIndices;
globalThis.currentSuggestionMeta = currentSuggestionMeta;
globalThis.daySeed = daySeed;
globalThis.deviceParse = deviceParse;
globalThis.exportLensCsv = exportLensCsv;
globalThis.exportPropertyAuctionCsv = exportPropertyAuctionCsv;
globalThis.exportLensXlsx = exportLensXlsx;
globalThis.exportNoticeXlsx = exportNoticeXlsx;
globalThis.exportContextForRow = exportContextForRow;
globalThis.noticeRenderedExportContext = noticeRenderedExportContext;
globalThis.exportSpec = exportSpec;
globalThis.injectNLBoxes = injectNLBoxes;
globalThis.interpretedSearchRowHTML = interpretedSearchRowHTML;
globalThis.loadValidatedSuggestions = loadValidatedSuggestions;
globalThis.mountUnofficialTranslation = mountUnofficialTranslation;
globalThis.nlFeed = nlFeed;
globalThis.nlResolve = nlResolve;
globalThis.nlTransHTML = nlTransHTML;
globalThis.nlTranslate = nlTranslate;
globalThis.nlTranslateLens = nlTranslateLens;
globalThis.nlWorkingHTML = nlWorkingHTML;
globalThis.nlqEscape = nlqEscape;
globalThis.nlqPresetSet = nlqPresetSet;
globalThis.nlqPresetStore = nlqPresetStore;
globalThis.nlqResolvedActionsHTML = nlqResolvedActionsHTML;
globalThis.personName = personName;
globalThis.pickSuggestions = pickSuggestions;
globalThis.pickSuggestionsGuaranteed = pickSuggestionsGuaranteed;
globalThis.preparePrintView = preparePrintView;
globalThis.printCurrentView = printCurrentView;
globalThis.qrButtonHTML = qrButtonHTML;
globalThis.qrLabels = qrLabels;
globalThis.renderLandingShareActions = renderLandingShareActions;
globalThis.renderNLQPresets = renderNLQPresets;
globalThis.renderNLSamples = renderNLSamples;
globalThis.renderSearchComponents = renderSearchComponents;
globalThis.rerenderAllSuggestions = rerenderAllSuggestions;
globalThis.resolveMoneyNarrow = resolveMoneyNarrow;
globalThis.searchActionsHTML = searchActionsHTML;
globalThis.searchFilterChips = searchFilterChips;
globalThis.searchFilterFromHash = searchFilterFromHash;
globalThis.searchLabelFromHash = searchLabelFromHash;
globalThis.stripImpliedKeywords = stripImpliedKeywords;
globalThis.trychipHTML = trychipHTML;
globalThis.withPersonName = withPersonName;
Object.defineProperty(globalThis, "NL_SUGGESTIONS_VALIDATED", { configurable: true, get: () => NL_SUGGESTIONS_VALIDATED, set: value => { NL_SUGGESTIONS_VALIDATED = value; } });
