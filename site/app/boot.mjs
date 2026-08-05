/* ===================== INIT =====================
   No "Filter" buttons: selects apply on change, text applies as you type (debounced — the
   query cache + stale guards make overlapping keystrokes safe) or on Enter. Craigslist rule:
   the fastest control is the one you don't have to click. */
$("#nlgo").addEventListener("click", nlTranslate);
$("#nlq").addEventListener("keydown", e=>{ if(e.key==="Enter") nlTranslate(); });
// One delegated handler covers every ".nledit" button nlTransHTML() renders (money's
// #nltrans, each lens's #nltrans-<lens>, and the alerts zero-result preview) — avoids
// wiring a fresh listener, and a duplicate-id risk, on every re-render.
document.addEventListener("click", e=>{
  const btn=e.target.closest(".nledit"); if(!btn) return;
  const inp=btn.dataset.nlfor ? $(btn.dataset.nlfor) : null;
  if(inp){ inp.focus(); inp.select(); }
});
injectNLBoxes();
renderNLSamples("money", $("#nltry"));
renderLandingShareActions();
renderNLQPresets();
loadValidatedSuggestions();
document.addEventListener("click",e=>{
  const matterCopy=e.target.closest("[data-matter-copy]");
  if(matterCopy){
    const link=location.origin+location.pathname+"#matter/"+encodeURIComponent(matterCopy.dataset.matterCopy);
    copyText(link,matterCopy);
    return;
  }
  const csv=e.target.closest("[data-export-csv]");
  if(csv){ exportLensCsv(csv.dataset.exportCsv); return; }
  const auctionCsv=e.target.closest("[data-export-property-auction]");
  if(auctionCsv){ exportPropertyAuctionCsv(); return; }
  const xlsx=e.target.closest("[data-export-xlsx]");
  if(xlsx){ exportLensXlsx(xlsx.dataset.exportXlsx); return; }
  const print=e.target.closest("[data-print-view]");
  if(print) printCurrentView(print.dataset.printView);
});
let editionRange=null;
function paintEditionSpan(){ const el=$("#editionspan"); if(el&&editionRange){ el.textContent=fdtLocale(editionRange.a)+" – "+fdtLocale(editionRange.b); } }
soda({"$select":"min(start_date) as a, max(start_date) as b"}).then(r=>{ if(r&&r[0]){ editionRange=r[0]; paintEditionSpan(); } }).catch(()=>{});
$("#kw").addEventListener("keydown", e=>{ if(e.key==="Enter") search(); });
$("#kw").addEventListener("input", debounce(search, 500));
["#mode","#agency","#sort","#minamt","#moneyboro","#moneycd","#moneycouncil"].forEach(s=>$(s).addEventListener("change", search));
$("#moneylocationbasis").addEventListener("change",async()=>{
  if($("#moneylocationbasis").value) await initializeMoneyLocationFilters();
  search();
});
$("#closingweek").addEventListener("click", ()=>{ closingWeek = !closingWeek; $("#closingweek").classList.toggle("on", closingWeek); $("#closingweek").setAttribute("aria-pressed", String(closingWeek)); search(); });

$("#staffing-query").addEventListener("input",debounce(()=>{
  staffingFilters.query=$("#staffing-query").value.trim();
  renderStaffingFeed(); updateHash();
},250));
$("#pkw").addEventListener("keydown", e=>{ if(e.key==="Enter") pSearch(); });
$("#pkw").addEventListener("input", debounce(pSearch, 500));
$("#pmode").addEventListener("change", ()=>{ $("#pkwlabel").textContent = $("#pmode").value==="role"?t("title_keyword_label"):t("person_name_label"); $("#pkw").placeholder = $("#pmode").value==="role"?t("kw_placeholder_people_role"):t("kw_placeholder_people_person"); });
["#career-interest","#career-eligibility","#career-window","#career-format","#career-salary-band","#career-fee-level","#career-no-experience"].forEach(selector=>$(selector).addEventListener("change",()=>{
  careerSelected=null; careerLimit=16; syncStaffingModeUI(); renderCareerGuide(); updateHash();
}));
$("#career-query").addEventListener("input",debounce(()=>{
  careerSelected=null; careerLimit=16; syncStaffingModeUI(); renderCareerGuide();
},200));

$("#awatch").addEventListener("change", ()=>{
  globalThis.aWatchChange?.();
  announce(t("sync_watch_announce", {what: $("#awatch").selectedOptions[0].textContent.trim()}));
});
const districtSelect=$("#adistrict");
if(districtSelect){
  for(let id=1;id<=51;id++){
    const option=document.createElement("option"); option.value=String(id); option.textContent=`Council District ${id}`;
    districtSelect.appendChild(option);
  }
  districtSelect.addEventListener("change",async()=>{
    if(!districtSelect.value) return;
    const tools=await import("../district_weekly_digest.mjs").catch(()=>null);
    const href=tools&&tools.districtDigestAlertsHref?tools.districtDigestAlertsHref(districtSelect.value):"/following/";
    location.assign(href);
  });
}
$("#afreq").addEventListener("change", ()=>{
  globalThis.updateAWhen?.();
  refreshQuizDisplay();
  announce(t("sync_freq_announce", {freq: $("#afreq").selectedOptions[0].textContent.trim()}));
});
$("#asubscribe").addEventListener("click", ()=>globalThis.aSubscribe?.());
// aWatchChange() clears #aparam/#athresh's stale value when the watch type actually changes
// (see the comment inside aWatchChange itself) -- so the suggestion's own param/threshold must
// be applied AFTER that call, and refreshQuizDisplay() re-run once more afterward so the quiz's
// mirrored narrow field picks up the just-applied value rather than the pre-clear one.
function applySuggestion(w, p){
  $("#awatch").value=w; globalThis.aWatchChange?.();
  if(w==="bigaward") $("#athresh").value=p; else $("#aparam").value=p;
  refreshQuizDisplay();
  globalThis.aPreview?.();
}
document.querySelectorAll(".wandchip").forEach(b=>b.addEventListener("click",()=>applySuggestion(b.dataset.w, b.dataset.p)));

/* "Watch this search" — carry the current lens filters into a prefilled alert via hash
   params (same entry path as notice "Watch this notice" and header CTA). */
function currentLensResultCount(lens){
  if(lens==="money" && Array.isArray(currentRows)) return currentRows.length;
  if(lens==="land" && Array.isArray(lRows)) return lRows.length;
  if(["property","rules","meetings"].includes(lens) && feedRows && Array.isArray(feedRows[lens])) return feedRows[lens].length;
  return null;
}
async function watchFromFilters(lens){
  const carry = await ensureAlertsContextCarry();
  const state = currentLensFilterState(lens) || {};
  // Preserve prior money bigaward threshold mapping when award mode + min is set.
  if(lens==="money" && mode==="award" && $("#minamt").value){
    const thr = Number($("#minamt").value);
    const opts = [1000000, 5000000, 10000000, 50000000];
    state.minAmount = opts.filter(o => o <= thr).pop() || opts[0];
    state.noticeType = "award";
    state.mode = "award";
  }
  if(carry && typeof carry.alertScopeFromLensState === "function"){
    const scope = carry.alertScopeFromLensState(lens, state);
    if(scope){
      location.assign(carry.alertsHref(scope, {matchCount:currentLensResultCount(lens)}));
      return;
    }
  }
  // If context adaptation ever fails, the common server form remains the safe entry.
  location.assign("/following/");
}
document.querySelectorAll(".watchbtn").forEach(b=>b.addEventListener("click",()=>watchFromFilters(b.dataset.lens)));

/* Context-carry helpers (pure module). Loaded once; used by prefill + header CTA sync. */
let alertsContextCarryPromise = null;
function ensureAlertsContextCarry(){
  if(!alertsContextCarryPromise){
    alertsContextCarryPromise = import("../alerts_context_carry.mjs").catch(()=>null);
  }
  return alertsContextCarryPromise;
}

/** Last notice row painted by showNotice — header CTA reads this for notice-scoped entry. */
let lastNoticeContext = null; // { row }

/* Saved-search health fix path + context-carrying alert entry —
   #alerts?lens=<lens>&filter=<json>&freq=<daily|weekly>&notice=<id>&project=<id>,
   using the exact {lens,filter} shape already stored on the subscription (see applyHash()).
   A money-lens filter is applied via NL.alerts.apply(), the SAME path the Ask box uses.
   When notice=/project= is present, the real digItemHTML email template is seeded with that
   item so the preview cannot drift. An unrecognized lens leaves the builder at defaults. */
async function prefillAlertFromLink(lens, filter, freq, opts){
  filter = filter || {};
  opts = opts || {};
  noticeWatchSeed = null;
  const parsedCount=opts.matchCount==null||opts.matchCount===""?NaN:Number(opts.matchCount);
  alertEntryMatchCount=Number.isInteger(parsedCount)&&parsedCount>=0?parsedCount:null;
  paintAlertContextLead(null);
  if(freq==="weekly" || freq==="daily") $("#afreq").selectedIndex = freq==="weekly" ? 1 : 0;
  const noticeId = opts.noticeId || filter.requestId || null;
  const projectId = opts.projectId || null;

  // Prefer the shared scope adapter when present; direct URL filters remain the fallback.
  if(lens && globalThis.CrolScope){
    try{
      const scope=CrolScope.scopeFromWatch({lens,filter},{language:window.LANG||"en"});
      const adapted=CrolScope.watchFromScope(scope,{lens});
      lens=adapted.lens;
      filter=adapted.filter;
    }catch(_e){}
  }

  function applyAlertScopeToBuilder(targetLens,targetFilter){
    const f=targetFilter||{};
    if(targetLens==="money"){
      // Cold hash routing precedes quiz initialization, so defer its repaint.
      NL.alerts.apply(f,{skipQuizSync:true});
      return true;
    }
    if(targetLens==="entity"){
      $("#awatch").value = f.kind==="agency" ? "entityagency" : "entityvendor";
      aWatchChange();
      $("#aparam").value = f.name || "";
      return true;
    }
    if(targetLens==="land"){
      $("#awatch").value = "rezone"; aWatchChange();
      $("#aparam").value = (f.keywords||[]).join(" ");
      return true;
    }
    if(targetLens==="district" && /^(?:[1-9]|[1-4]\d|5[01])$/.test(String(f.councilDistrict||""))){
      // Initial hash routing can invoke this hoisted function before the quiz's
      // later const-backed state is initialized. Defer that repaint until below.
      $("#awatch").value = "district"; aWatchChange(true);
      $("#adistrict").value = String(f.councilDistrict);
      $("#afreq").value = "Weekly";
      return true;
    }
    if(SECTION_WATCH_LABEL[targetLens]){
      $("#awatch").value = targetLens; aWatchChange();
      $("#aparam").value = (f.keywords||[]).join(" ");
      $("#aagency").value = f.agency || "";
      if(targetLens==="meetings") meetingWatchExtra={
        borough:f.borough||null, neighborhood:f.neighborhood||null,
        locationScope:f.locationScope||null, dateWindow:f.dateWindow||f.when||"upcoming",
        when:f.when||f.dateWindow||"upcoming",
      };
      if(targetLens==="property") propertyWatchExtra={
        borough:f.borough||null, neighborhood:f.neighborhood||null,
        communityDistrict:f.communityDistrict||null,
        process:f.process||null, stage:f.stage||null,
        asset:f.asset||null, saleMethod:f.saleMethod||null,
        priceBand:f.priceBand||null, sort:f.sort||null,
      };
      return true;
    }
    if(targetLens==="award" && (f.requestId || noticeId)){
      awardWatchTarget = {
        requestId: f.requestId || noticeId,
        agency: f.agency || "",
        label: f.label || f.agency || f.requestId || noticeId,
      };
      $("#awatch").value = "awardwatch";
      aWatchChange();
      return true;
    }
    if(targetLens==="people" && f.view==="guide" && f.interestArea){
      examAreaWatchTarget={id:f.interestArea,label:f.interestLabel||f.interestArea};
      $("#awatch").value="examarea";
      aWatchChange();
      examAreaWatchTarget={id:f.interestArea,label:f.interestLabel||f.interestArea};
      return true;
    }
    return false;
  }

  // Apply URL scope before the optional notice lookup.
  let filled=lens?applyAlertScopeToBuilder(lens,filter):false;
  if(filled) paintAlertContextLead({});

  if((noticeId||projectId) && lens){
    await applyNoticeWatchSeed({noticeId,projectId,lens,filter});
  }else if((noticeId||projectId) && !lens){
    await applyNoticeWatchSeed({noticeId,projectId,lens,filter});
    if(noticeWatchSeed&&noticeWatchSeed.row){
      const carry=await ensureAlertsContextCarry();
      if(carry&&typeof carry.alertScopeFromNotice==="function"){
        const derived=carry.alertScopeFromNotice(noticeWatchSeed.row);
        lens=derived.lens;
        filter=Object.assign({},derived.filter,filter);
        const seed=noticeWatchSeed;
        filled=applyAlertScopeToBuilder(lens,filter);
        noticeWatchSeed={...seed,lens,filter,digKind:derived.digKind||seed.digKind};
      }
    }
  }
  try{ refreshQuizDisplay(); }
  catch(_e){ queueMicrotask(()=>{ try{ refreshQuizDisplay(); }catch(__e){} }); }
  if(typeof syncAlertsAdvDisclosure === "function") syncAlertsAdvDisclosure();
  if(filled || noticeWatchSeed){
    await aPreview();
    // One finish step: focus the single email field (context-carry and bare-topic prefills).
    const dest = $("#adest");
    if(dest) try{ dest.focus({ preventScroll: true }); }catch(_e){ try{ dest.focus(); }catch(__e){} }
  }
}

/** Load a City Record notice (or ZAP project) and store as noticeWatchSeed for aPreview. */
async function applyNoticeWatchSeed({ noticeId, projectId, lens, filter }){
  const carry = await ensureAlertsContextCarry();
  let row = null;
  let digKind = "notice";
  if(noticeId){
    // Prefer the in-memory notice just viewed (avoids a second SODA round-trip).
    if(lastNoticeContext && lastNoticeContext.row
      && String(lastNoticeContext.row.request_id) === String(noticeId)){
      row = lastNoticeContext.row;
    } else {
      try{
        const rows = await soda({
          "$select": typeof NOTICE_SELECT !== "undefined" ? NOTICE_SELECT : SELECT,
          "$where": `request_id='${String(noticeId).replace(/'/g,"''")}'`,
          "$limit": "1",
        });
        row = rows && rows[0] || null;
      }catch(_e){ row = null; }
    }
    if(row){
      digKind = carry && typeof carry.digKindForNotice === "function"
        ? carry.digKindForNotice(row)
        : "notice";
      // If lens was missing, derive scope from the row.
      if(!lens && carry && typeof carry.alertScopeFromNotice === "function"){
        const scope = carry.alertScopeFromNotice(row);
        // Do not recurse — only fill empty builder when nothing was applied.
      }
    }
  } else if(projectId){
    try{
      const rows = await api(ZAP, {
        "$select": "project_id,project_name,project_brief,primary_applicant,public_status,borough,community_district,mih_flag,current_milestone_date",
        "$where": `project_id='${String(projectId).replace(/'/g,"''")}'`,
        "$limit": "1",
      });
      row = rows && rows[0] || null;
    }catch(_e){ row = null; }
    digKind = "rezone";
  }
  if(!row) return;
  noticeWatchSeed = { row, digKind, lens: lens || null, filter: filter || {} };
}

/**
 * Header "Want email updates?" / "or pick topics" — carry current notice or lens filters.
 * Neutral surfaces (home, about-style) stay bare #alerts.
 */
function currentLensFilterState(tab){
    const adapt=state=>CrolScope.lensStateFromScope(CrolScope.scopeFromLensState(tab,state,{language:window.LANG||"en"}),tab);
  if(tab === "money"){
    return adapt({
      agency: $("#agency") && $("#agency").value || "",
      q: $("#kw") && $("#kw").value.trim() || "",
      minAmount: $("#minamt") && $("#minamt").value || null,
      mode: $("#mode") && $("#mode").value || "open",
      noticeType: ($("#mode") && $("#mode").value === "award") ? "award" : null,
    });
  }
  if(tab === "land"){
    return adapt({
      q: $("#lkw") && $("#lkw").value.trim() || "",
      boro: $("#lboro") && $("#lboro").value || "",
      status: $("#lstatus") && $("#lstatus").value || "active",
    });
  }
  if(tab === "meetings" || tab === "property" || tab === "rules"){
    const state = {
      agency: $("#"+tab+"agency") && $("#"+tab+"agency").value || "",
      q: $("#"+tab+"kw") && $("#"+tab+"kw").value.trim() || "",
    };
    if(tab === "meetings"){
      const place = $("#meetingsboro") && $("#meetingsboro").value || "";
      if(place==="citywide-unlocated"||place==="citywide"||place==="virtual"||place==="unlocated") state.locationScope = place;
      else if(place) state.borough = place;
      if($("#meetingsneighborhood") && $("#meetingsneighborhood").value.trim()){
        state.neighborhood = $("#meetingsneighborhood").value.trim();
      }
      if($("#meetingswhen") && $("#meetingswhen").value){
        state.when = $("#meetingswhen").value;
        state.dateWindow = $("#meetingswhen").value;
      }
      if(typeof meetingsCommunityDistrict!=="undefined" && meetingsCommunityDistrict) state.communityDistrict=meetingsCommunityDistrict;
      if(typeof meetingsCouncilDistrict!=="undefined" && meetingsCouncilDistrict) state.councilDistrict=meetingsCouncilDistrict;
    }
    if(tab === "property"){
      if(typeof propAsset !== "undefined" && propAsset && propAsset !== "all") state.asset = propAsset;
      if(typeof propSaleMethod !== "undefined" && propSaleMethod && propSaleMethod !== "all") state.saleMethod = propSaleMethod;
      if(typeof propPriceBand !== "undefined" && propPriceBand && propPriceBand !== "all") state.priceBand = propPriceBand;
      if(typeof propSort !== "undefined" && propSort && propSort !== "closing_soon") state.sort = propSort;
      if(typeof propProcessSel !== "undefined" && propProcessSel && propProcessSel !== "all") state.process = propProcessSel;
      if(typeof propStageSel !== "undefined" && propStageSel && propStageSel !== "all") state.stage = propStageSel;
      const boro = $("#propertyboro") && $("#propertyboro").value || "";
      if(boro) state.borough = boro;
      if($("#propertyneighborhood") && $("#propertyneighborhood").value.trim()){
        state.neighborhood = $("#propertyneighborhood").value.trim();
      }
      if(typeof propertyCommunityDistrict!=="undefined" && propertyCommunityDistrict){
        state.communityDistrict=propertyCommunityDistrict;
      }
      if(typeof propertyCouncilDistrict!=="undefined" && propertyCouncilDistrict){
        state.councilDistrict=propertyCouncilDistrict;
      }
    }
    return adapt(state);
  }
  return null;
}

async function currentAlertsEntryHref(){
  const hash = location.hash || "";
  // On the alerts page itself, keep the current hash (or bare).
  if(hash === "#alerts" || hash.startsWith("#alerts?")) return "/following/";
  // Notice detail → notice-scoped entry.
  if(/^#notice\//.test(hash) && lastNoticeContext && lastNoticeContext.row){
    const carry = await ensureAlertsContextCarry();
    if(!carry) return "/following/";
    return carry.alertsHref(carry.alertScopeFromNotice(lastNoticeContext.row));
  }
  // Land project detail (#land/<project_id>).
  if(/^#land\//.test(hash)){
    const id = decodeURIComponent(hash.slice(6).split("?")[0] || "");
    if(id){
      const carry = await ensureAlertsContextCarry();
      if(!carry) return "/following/";
      const row = (typeof lRows !== "undefined" && Array.isArray(lRows))
        ? lRows.find(r => r && String(r.project_id) === id)
        : null;
      if(row) return carry.alertsHref(carry.alertScopeFromLandProject(row));
      return carry.alertsHref({ lens: "land", filter: { keywords: [], status: "all" }, digKind: "rezone", projectId: id });
    }
  }
  // Active lens tab with filters.
  const tab = document.querySelector(".tabbtn.active")?.dataset.tab;
  if(tab && ["money","land","property","rules","meetings"].includes(tab)){
    const state = currentLensFilterState(tab);
    // Do not load the context-carry helper for the untouched home defaults. The helper is
    // needed only after a reader narrows a lens (or enters through a detail route above).
    const hasBits = !!(state && (state.agency || state.q || state.minAmount
      || state.borough || state.boro || state.neighborhood || state.noticeType
      || state.locationScope || state.asset || state.saleMethod || state.priceBand
      || state.process || state.stage));
    if(hasBits){
      const carry = await ensureAlertsContextCarry();
      const scope = carry && carry.alertScopeFromLensState(tab, state);
      if(scope) return carry.alertsHref(scope, {matchCount:currentLensResultCount(tab)});
    }
  }
  return "/following/";
}

async function syncAlertsEntryHrefs(){
  const href = await currentAlertsEntryHref();
  const topics = document.getElementById("homeCtaTopics");
  if(topics) topics.setAttribute("href", href);
  const compact = document.querySelector("#homeCtaCompact a");
  if(compact) compact.setAttribute("href", href);
}

/* 60-second onboarding: chips → prefilled advanced options → live preview (Meet-Your-Mayor
   pattern). w12-20: the quiz's chips/narrow field/freq chips and the "Advanced options"
   builder fields are two VIEWS of one draft alert -- #awatch/#aparam-or-#quiznarrow/#afreq are
   the shared state (the single Preview button reads them directly, see aFetch()/
   aLensFilter()/aPreview() above), and refreshQuizDisplay()/the listeners below keep the
   quiz's view of them live in both directions so picking a topic here and then editing an
   amount in Advanced options (or vice versa) can never leave the two panels disagreeing about
   what will actually be sent. Before this card, the quiz only ever pushed INTO the builder,
   once, when its own Preview button was clicked -- see test/functional/18_draft_alert_sync.py
   for the pinned before/after repro. */
// Values are i18n keys — resolved with t() at click time so the quiz follows the active language.
const QUIZ_PLACEHOLDER={rfpkw:"quizph_rfpkw", bigaward:"quizph_bigaward",
  rezone:"quizph_rezone", property:"quizph_property", rules:"quizph_rules", meetings:"quizph_meetings"};
let quizW=null;
// The quiz's 6 topic chips are a curated subset of #awatch's 9 "watch for" options -- no chip
// exists for moneynl/entityvendor/entityagency, so a builder-side pick of one of those leaves
// no quiz chip lit (an honest "the quiz has no button for this" state, not a bug).
const QUIZ_TOPICS = new Set(["rfpkw","bigaward","rezone","property","rules","meetings","district"]);
// The main question is the canonical narrowing control for money descriptions; other watch
// types mirror that one question into their existing #aparam subscription field.
function narrowFieldSel(){ return $("#awatch").value==="moneynl" ? "#quiznarrow" : "#aparam"; }
// Repaints the quiz's chips/narrow field/frequency chips from the CURRENT #awatch/narrow-field/
// #afreq values. Pure repaint -- never writes back into the builder fields it reads, so calling
// it after any of those fields changes (from either the quiz or the builder side) can't loop.
function refreshQuizDisplay(){
  const w = $("#awatch").value;
  const narrowBox = $("#quiznarrowbox");
  if(narrowBox) narrowBox.hidden = w==="district";
  quizW = QUIZ_TOPICS.has(w) ? w : null;
  $("#quizwhat").querySelectorAll(".chip").forEach(x=>{
    const on = x.dataset.w===w;
    x.classList.toggle("on", on); x.setAttribute("aria-pressed", String(on));
  });
  $("#quiznarrow").value = $(narrowFieldSel()).value;
  $("#quiznarrow").placeholder = QUIZ_PLACEHOLDER[w] ? t(QUIZ_PLACEHOLDER[w]) : t("quiz_narrow_placeholder");
  $("#quiznarrow").disabled = w==="bigaward" || w==="district";
  const freq = $("#afreq").value;
  $("#quizfreq").querySelectorAll(".chip").forEach(x=>{
    const on = x.dataset.f===freq;
    x.classList.toggle("on", on); x.setAttribute("aria-pressed", String(on));
    x.disabled = w==="district" && x.dataset.f!=="Weekly";
  });
}
$("#quizwhat").querySelectorAll(".chip").forEach(b=>b.addEventListener("click",()=>{
  const changed = $("#awatch").value !== b.dataset.w;
  $("#awatch").value = b.dataset.w;
  if(changed) aWatchChange(); else refreshQuizDisplay(); // aWatchChange() already ends by calling refreshQuizDisplay()
  announce(t("sync_watch_announce", {what: b.textContent.trim()}));
}));
// Live, in both directions: typing in either narrowing field mirrors into the other one
// immediately -- no waiting for either Preview button.
$("#quiznarrow").addEventListener("input", ()=>{ $(narrowFieldSel()).value = $("#quiznarrow").value; });
$("#aparam").addEventListener("input", ()=>{ if($("#awatch").value!=="moneynl") $("#quiznarrow").value = $("#aparam").value; });
$("#quizfreq").querySelectorAll(".chip").forEach(b=>b.addEventListener("click",()=>{
  if($("#awatch").value==="district" && b.dataset.f!=="Weekly") return;
  $("#quizfreq").querySelectorAll(".chip").forEach(x=>{ x.classList.toggle("on", x===b); x.setAttribute("aria-pressed", String(x===b)); });
  if($("#afreq").value !== b.dataset.f){ $("#afreq").value = b.dataset.f; updateAWhen(); }
  announce(t("sync_freq_announce", {freq: b.textContent.trim()}));
}));
$("#apreview").addEventListener("click", async ()=>{
  if(!quizW){
    // Field report (2026-07-15): typing straight into step 2 without clicking a step-1
    // topic chip first used to silently no-op — the swapped placeholder is invisible once
    // the field holds text, so the click looked like it did nothing at all. A typed keyword
    // is enough signal on its own: resolve it the same way the Alerts Ask box would, rather
    // than requiring the redundant chip click.
    const text=$("#quiznarrow").value.trim();
    if(!text){ $("#quiznarrow").placeholder=t("pick_topic_first"); return; }
    $("#apreview").disabled=true;
    await nlTranslateLens("alerts", {text, inputSel:"#quiznarrow"});
    $("#apreview").disabled=false;
    $("#apreviewbox").scrollIntoView({behavior:"smooth", block:"start"});
    return;
  }
  $("#awatch").value=quizW; aWatchChange();
  // Always assign — every topic gets the same treatment: your narrowing, or the topic's
  // own "all notices" default. Never a value left over from a previous topic.
  if(quizW!=="bigaward" && quizW!=="district") $("#aparam").value=$("#quiznarrow").value.trim();
  const f=$("#quizfreq").querySelector(".chip.on"); if(f) $("#afreq").value=f.dataset.f;
  updateAWhen();
  if(!(await resolveMoneyNarrow())) aPreview();
  $("#apreviewbox").scrollIntoView({behavior:"smooth", block:"start"});
});

$("#lkw").addEventListener("keydown", e=>{ if(e.key==="Enter") landSearch(); });
const debouncedLandSearch=debounce(landSearch, 700); // geocoding behind it — a touch lazier
$("#lkw").addEventListener("input", ()=>{ landResolvedArea=null; landCommunityDistrict=""; landCouncilDistrict=""; debouncedLandSearch(); });
$("#lboro").addEventListener("change", ()=>{ landResolvedArea=null; landCommunityDistrict=""; landCouncilDistrict=""; landSearch(); });
$("#lstatus").addEventListener("change", landSearch);
$("#land-status-rail").querySelectorAll("[data-land-status]").forEach(button=>button.addEventListener("click",()=>{
  $("#lstatus").value=button.dataset.landStatus||"active";
  landSearch();
}));
const lhearingmode=$("#lhearingmode");
if(lhearingmode) lhearingmode.addEventListener("change", landSearch);
const landLocationOptions={
  permissions:navigator.permissions,
  geolocation:navigator.geolocation,
  fetchImpl:url=>fetch(url),
  onResolved:area=>{
    landResolvedArea=area;
    landCommunityDistrict=area.communityDistrict||"";
    landCouncilDistrict=area.councilDistrict||"";
    $("#lboro").value=area.borough;
    $("#lkw").value="";
    landSearch();
  },
};
function maybeAutoLocateLand(){
  if(landAutoLocationChecked) return;
  landAutoLocationChecked=true;
  let storage=null;
  try{ storage=localStorage; }catch(e){}
  const button=$("#landlocation");
  button.disabled=true;
  resolveLandEntryLocation({...landLocationOptions, storage}).finally(()=>{ button.disabled=false; });
}
bindLocationControl($("#landlocation"), landLocationOptions);
bindLocationControl($("#propertylocation"), {
  geolocation:navigator.geolocation,
  fetchImpl:fetch,
  mapPlutoEndpoint:MAPPLUTO_QUERY,
  onResolved:area=>{
    propertyCouncilDistrict="";
    $("#propertyboro").value=area.borough||"";
    $("#propertyneighborhood").value=area.neighbourhood||"";
    renderPropExplorer();
    updateHash();
    renderSearchComponents("property");
  },
});
bindLocationControl($("#meetingslocation"), {
  geolocation:navigator.geolocation,
  fetchImpl:fetch,
  mapPlutoEndpoint:MAPPLUTO_QUERY,
  onResolved:area=>{
    meetingsCommunityDistrict="";
    meetingsCouncilDistrict="";
    $("#meetingsboro").value=area.borough||"";
    $("#meetingsneighborhood").value=area.neighbourhood||"";
    loadSection("meetings");
  },
});

["property","rules","meetings"].forEach(k=>{
  $("#"+k+"kw").addEventListener("keydown",e=>{ if(e.key==="Enter") loadSection(k); });
  $("#"+k+"kw").addEventListener("input", debounce(()=>loadSection(k), 500));
  const w=$("#"+k+"when"); if(w) w.addEventListener("change",()=>loadSection(k));
  const ag=$("#"+k+"agency"); if(ag) ag.addEventListener("change",()=>loadSection(k));
});
$("#meetingsboro").addEventListener("change",()=>{ meetingsCommunityDistrict=""; meetingsCouncilDistrict=""; loadSection("meetings"); });
$("#meetingsneighborhood").addEventListener("keydown",event=>{ if(event.key==="Enter") loadSection("meetings"); });
$("#meetingsneighborhood").addEventListener("input",debounce(()=>{ meetingsCommunityDistrict=""; meetingsCouncilDistrict=""; loadSection("meetings"); },500));
$("#propertyboro").addEventListener("change",()=>{ propertyCommunityDistrict=""; propertyCouncilDistrict=""; renderPropExplorer(); updateHash(); renderSearchComponents("property"); });
const rulesBoroSel=$("#rulesboro");
if(rulesBoroSel) rulesBoroSel.addEventListener("change",()=>{
  if(typeof renderRulesExplorer==="function") renderRulesExplorer();
  else loadSection("rules");
  updateHash();
  renderSearchComponents("rules");
});
$("#propertyneighborhood").addEventListener("keydown",event=>{ if(event.key==="Enter"){ renderPropExplorer(); updateHash(); renderSearchComponents("property"); } });
$("#propertyneighborhood").addEventListener("input",debounce(()=>{ propertyCouncilDistrict=""; renderPropExplorer(); updateHash(); renderSearchComponents("property"); },500));
loadAgencies();
document.addEventListener("click",rememberItemRouteContext);
window.addEventListener("popstate",event=>prepareHistoryRouteScroll(event.state));
window.addEventListener("hashchange", async ()=>{
  const targetHash=location.hash;
  await globalThis.CrolRouteModules?.ensureForHash(targetHash);
  if(location.hash!==targetHash) return;
  commitPendingItemRouteContext();
  if(!hashLock && !applyHash()) showTab("money");
  restoreHistoryRouteScroll();
}); // empty/unknown hash (e.g. Back to the first entry) → default view
// Publish alert prefill bindings BEFORE the first applyHash() so #alerts?lens=…&notice=…
// deep links (and health-fix links) can call prefillAlertFromLink on cold load.
// routing.mjs resolves that free name on globalThis; assigning after applyHash left
// cold entry as "prefillAlertFromLink is not defined" and a blank builder.
globalThis.prefillAlertFromLink = prefillAlertFromLink;
globalThis.applyNoticeWatchSeed = applyNoticeWatchSeed;
globalThis.syncAlertsEntryHrefs = syncAlertsEntryHrefs;
globalThis.currentAlertsEntryHref = currentAlertsEntryHref;
globalThis.ensureAlertsContextCarry = ensureAlertsContextCarry;
// Land deep links call showTab("land") during the first applyHash; publish this dependency
// before routing instead of waiting for the general export block at the end of this module.
globalThis.maybeAutoLocateLand = maybeAutoLocateLand;
Object.defineProperty(globalThis, "lastNoticeContext", { configurable: true, get: () => lastNoticeContext, set: value => { lastNoticeContext = value; } });
if(!applyHash()) search(); // an incoming permalink wins over the default Money load
// skipQuizSync=true: a fresh load must not make the quiz LOOK like a topic was already picked
// just because #awatch's mandatory default ("bigaward") happens to match one of its chips —
// the quiz starts genuinely unanswered (test/functional/03_watch_quiz_feeds.py's "quiz CTA
// without topic" probe pins this). Skip when the hash already carries alert context — applyHash
// scheduled prefillAlertFromLink, and a second aWatchChange would race the draft fields.
const alertsEntryHash = location.hash || "";
const isAlertsContextEntry = (alertsEntryHash.startsWith("#alerts?")
  && /(?:^|[?&])(?:lens|notice|project)=/.test(alertsEntryHash.slice(1)));
if(typeof globalThis.aWatchChange==="function"){
  if(!isAlertsContextEntry) globalThis.aWatchChange(true);
  globalThis.updateAWhen?.();
  globalThis.aRenderSaved?.();
  globalThis.initAlertsRollupPrefs?.();
}

// Language switch must also repaint DYNAMICALLY-BUILT surfaces (2026-07-13 hotfix): applyStrings()
// only covers data-i18n chrome, so lists, dropdowns and detail panels kept their old language.
// Re-render from cache/memory — the 5-minute API cache makes the re-runs free.
function rerenderForLang(){
  const sessionBanner = document.getElementById("sessionBanner");
  if(sessionBanner && sessionBanner.dataset.open === "true"){
    sessionShowBanner({
      email: sessionBanner.dataset.email || "",
      prefsUrl: sessionBanner.dataset.prefsUrl || "",
    });
  }
  document.querySelectorAll(".filtertoggle").forEach(b=>{ b.textContent = "☰ " + t("filters_toggle"); });
  const nav = document.querySelector(".tabs"); if(nav) nav.setAttribute("aria-label", t("tablist_label"));
  paintEditionSpan();
  loadAgencies();
  if(typeof globalThis.aWatchChange==="function"){
    globalThis.aWatchChange(true); globalThis.updateAWhen?.(); globalThis.aRenderSaved?.(); globalThis.renderAlertsRollupPrefs?.();
    if(document.querySelector("#tab-alerts.active")) globalThis.initWatchTemplates?.();
  }
  renderLandingShareActions(); renderNLQPresets(); // same skipQuizSync reasoning as the page-init call above
  // #notice/#vendor/#agency/#matter permalink views have no .tabbtn (comment above
  // syncTabAria()'s role wiring), so the .tabbtn.active lookup below finds nothing for them
  // and their chrome — built once via t() when the view was first shown — silently kept
  // whatever language was active at that moment. Re-run the hash router instead, which
  // dispatches back to whichever show*(id) built the currently-active pane (2026-07-13 hotfix 3).
  const activePane = document.querySelector(".tabpane.active");
  if(activePane && (activePane.id === "tab-notice" || activePane.id === "tab-entity" || activePane.id === "tab-task")){ applyHash(); return; }
  const active = document.querySelector(".tabbtn.active");
  const tab = active ? active.dataset.tab : null;
  // Loaded-but-inactive lenses re-fetch on their next visit instead of re-rendering now.
  Object.keys(feedLoaded).forEach(k=>{ if(k!==tab && feedLoaded[k]) feedLoaded[k]=false; });
  if(tab!=="money") moneyLoaded=false;
  if(tab!=="land") landLoaded=false;
  if(tab==="money" && moneyLoaded) search();
  else if(tab==="people"){
    populateCareerInterests(); renderCareerGuide(); renderStaffingFeed();
  }
  else if(tab==="land" && landLoaded){
    const raw=location.hash.slice(1);
    if(raw.startsWith("land/")) showLandEntry(parseLandHashSegment(raw.slice(5)));
    else landSearch();
  }
  else if(tab && SECTIONS[tab] && feedLoaded[tab]){ loadSectionAgencies(tab); loadSection(tab); }
}

/* ===================== MAGIC-LINK SESSION (digest email recognition) =====================
   Quiet sign-in: a pins-scoped token from an alert email is exchanged for an HttpOnly
   session cookie on the API host. The token is stripped from the URL immediately so it
   never sits in history/referrers. The cookie may bootstrap the narrower watch manager;
   unsubscribe and other purpose-specific actions never accept it directly. */
function sessionShowBanner(session){
  const el = document.getElementById("sessionBanner");
  if(!el) return;
  const open = !!session;
  el.hidden = !open;
  el.dataset.open = open ? "true" : "false";
  if(open){
    el.dataset.email = String(session.email || "");
    el.dataset.prefsUrl = String(session.prefsUrl || "");
    const txt = document.getElementById("sessionBannerText");
    if(txt && window.t) txt.textContent = t("session_signed_in", { email: String(session.email || "") });
    const manage = document.getElementById("sessionManage");
    if(manage){
      manage.href = session.prefsUrl || ((API || "https://api.cityscroll.org").replace(/\/+$/, "") + "/prefs");
      if(window.t) manage.textContent = t("session_manage_watches");
    }
    // Keep the Alerts-tab manage link in lockstep with the session banner prefs URL.
    globalThis.syncAlertsPrefsManageLink?.();
    const ny = document.getElementById("sessionNotYou");
    if(ny && window.t) ny.textContent = t("session_not_you");
    const di = document.getElementById("sessionDismiss");
    if(di && window.t) di.textContent = t("session_dismiss");
  }
}
function sessionStripUrlToken(){
  try{
    const u = new URL(location.href);
    if(!u.searchParams.has("s") && !u.searchParams.has("token")) return null;
    const tok = u.searchParams.get("s") || u.searchParams.get("token") || null;
    u.searchParams.delete("s");
    u.searchParams.delete("token");
    history.replaceState(null, "", u.pathname + u.search + u.hash);
    return tok;
  }catch(e){ return null; }
}
async function sessionExchange(token){
  if(!token || !API) return false;
  try{
    const r = await workerFetch("/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    }, 10000);
    if(!r || !r.ok) return false;
    const j = await r.json();
    return !!(j && j.recognized);
  }catch(e){ return false; }
}
async function sessionCheck(){
  if(!API) return null;
  try{
    const r = await workerFetch("/session", null, 8000);
    if(!r || !r.ok) return null;
    const j = await r.json();
    return j && j.recognized && j.email ? j : null;
  }catch(e){ return null; }
}
async function sessionLogout(){
  try{
    await workerFetch("/session/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, 8000);
  }catch(e){}
  invSessionRecognized = false;
  invServerHydrated = false;
  sessionShowBanner(false);
}
async function sessionBoot(){
  // Prefer a URL token (if a client ever lands with ?s=); usually the worker redirect
  // already set the cookie and the token is gone from the final URL.
  const fromUrl = sessionStripUrlToken();
  if(fromUrl) await sessionExchange(fromUrl);
  const session = await sessionCheck();
  if(!session) return;
  invSessionRecognized = true;
  sessionShowBanner(session);
  await invPullAndMerge();
}
(function initSessionUi(){
  const wire = ()=>{
    const ny = document.getElementById("sessionNotYou");
    const di = document.getElementById("sessionDismiss");
    if(ny) ny.addEventListener("click", ()=>{ sessionLogout(); });
    if(di) di.addEventListener("click", ()=>{ sessionShowBanner(false); });
    sessionBoot();
  };
  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();

// Homepage general-interest form stays tiny and independent of the deferred Following island.
async function homeCtaSubscribeStatic(event){
  event?.preventDefault?.();
  const msg=$("#homeCtaMsg"),dest=$("#homeCtaEmail"),btn=$("#homeCtaSubmit");
  if(!msg||!dest||!btn)return;
  const email=dest.value.trim();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){
    msg.textContent=t("enter_valid_email");dest.setAttribute("aria-invalid","true");dest.focus();return;
  }
  dest.removeAttribute("aria-invalid");btn.disabled=true;
  msg.innerHTML='<span class="loading"></span> '+t("sending_confirm_link");
  try{
    const response=await workerFetch("/subscribe",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email,lens:"money",filter:{},freq:"weekly",lang:window.LANG||"en"})});
    const result=await response.json().catch(()=>({}));
    if(result.ok){msg.innerHTML="<b>"+t("check_inbox")+"</b> "+t("sent_confirm_to",{email:email.replace(/[<>&]/g," ")});dest.value="";}
    else msg.textContent=t("cant_reach_server");
  }catch{msg.textContent=t("cant_reach_server");}
  btn.disabled=false;
}

// Language switcher init — compact <select> top-right; i18n.js already loaded in <head>.
(function(){
  function initLangSwitcher(){
    const sel = document.getElementById("langSelect");
    if(!sel) return;
    const saved = window.LANG || "en";
    if([...sel.options].some(function(o){ return o.value === saved; })) sel.value = saved;
    // applyStrings() also runs updateLangNotice() (i18n.js), which shows the "notices stay
    // English" + machine-translation-disclosure banner — no manual #langNotice wiring here.
    if(window.applyStrings) applyStrings();

    sel.addEventListener("change", function(){
      const lang = sel.value;
      const changed = lang !== window.LANG;
      // rerenderForLang() repaints DYNAMICALLY-BUILT content (search results, today-strip,
      // detail panel — all t()/tn() template literals, invisible to applyStrings()'s
      // [data-i18n] walk). setLang()'s second param re-runs it once a lazily-loaded
      // shipping language's dictionary finishes fetching.
      setLang(lang, changed ? rerenderForLang : null);
      if(changed) rerenderForLang();
    });
  }
  function initHomeCta(){
    const form = document.getElementById("homeCtaForm");
    if(form) form.addEventListener("submit", homeCtaSubscribeStatic);
  }
  function boot(){
    initLangSwitcher();
    initHomeCta();
  }
  if(document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
// Publish live bindings for neighboring modules and legacy inline handlers.
globalThis.QUIZ_PLACEHOLDER = QUIZ_PLACEHOLDER;
globalThis.QUIZ_TOPICS = QUIZ_TOPICS;
globalThis.applySuggestion = applySuggestion;
globalThis.debouncedLandSearch = debouncedLandSearch;
globalThis.landLocationOptions = landLocationOptions;
globalThis.maybeAutoLocateLand = maybeAutoLocateLand;
globalThis.narrowFieldSel = narrowFieldSel;
globalThis.paintEditionSpan = paintEditionSpan;
// prefillAlertFromLink / applyNoticeWatchSeed / syncAlertsEntryHrefs / lastNoticeContext
// are published earlier (before first applyHash) — see hashchange wiring above.
globalThis.refreshQuizDisplay = refreshQuizDisplay;
globalThis.rerenderForLang = rerenderForLang;
globalThis.sessionBoot = sessionBoot;
globalThis.sessionCheck = sessionCheck;
globalThis.sessionExchange = sessionExchange;
globalThis.sessionLogout = sessionLogout;
globalThis.sessionShowBanner = sessionShowBanner;
globalThis.sessionStripUrlToken = sessionStripUrlToken;
globalThis.watchFromFilters = watchFromFilters;
Object.defineProperty(globalThis, "editionRange", { configurable: true, get: () => editionRange, set: value => { editionRange = value; } });
Object.defineProperty(globalThis, "quizW", { configurable: true, get: () => quizW, set: value => { quizW = value; } });
