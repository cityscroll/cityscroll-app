/* ===================== MONEY ===================== */
// Commit-time default open-RFP list + procurement agencies (wave-2 batch precompute).
// Parameterized search stays live SODA; snapshot paints first, then hybrid-refreshes.
const MONEY_DEFAULT_SNAPSHOT_URL="data/money_default_open.json";
const MONEY_AGENCIES_SNAPSHOT_URL="data/money_procurement_agencies.json";
let moneyDefaultSnapshotPromise=null;
let moneyAgenciesSnapshotPromise=null;
function loadMoneyDefaultSnapshot(){
  if(!moneyDefaultSnapshotPromise){
    moneyDefaultSnapshotPromise=fetch(MONEY_DEFAULT_SNAPSHOT_URL)
      .then(r=>r.ok?r.json():null)
      .catch(()=>null);
  }
  return moneyDefaultSnapshotPromise;
}
function loadMoneyAgenciesSnapshot(){
  if(!moneyAgenciesSnapshotPromise){
    moneyAgenciesSnapshotPromise=fetch(MONEY_AGENCIES_SNAPSHOT_URL)
      .then(r=>r.ok?r.json():null)
      .catch(()=>null);
  }
  return moneyAgenciesSnapshotPromise;
}
function isDefaultMoneySearchState({mode, agency, kw, methodSel, closingWeek, minAmount, sort, nlResolved}={}){
  const nl=nlResolved&&typeof nlResolved==="object"?nlResolved:{};
  const hasNl=Boolean(nl.category)||nl.maxAmount!=null||nl.months!=null||Boolean(nl.excludeSpecial);
  return (mode||"open")==="open"
    && !agency
    && !String(kw||"").trim()
    && !methodSel
    && !closingWeek
    && !minAmount
    && !hasNl
    && (!sort || sort==="deadline");
}
function filterStillOpenMoneyNotices(rows, today){
  const floor=String(today||(typeof todayISO==="function"?todayISO():new Date().toISOString().slice(0,10))).slice(0,10);
  return (rows||[]).filter(r=>{
    const due=String(r&&r.due_date||"").slice(0,10);
    return due && due>floor;
  });
}
function paintMoneyAgencyOptions(names){
  const cur=$("#agency")?$("#agency").value:"";
  const list=(names||[]).filter(Boolean);
  $("#agency").innerHTML=`<option value="">${t("all_agencies")}</option>`+list.map(name=>`<option>${name}</option>`).join("");
  if(cur) forceSelect("#agency", cur);
}
async function loadAgencies(){
  let paintedFromSnapshot=false;
  try{
    const snap=await loadMoneyAgenciesSnapshot();
    const names=snap&&Array.isArray(snap.agencies)?snap.agencies:[];
    if(names.length){
      paintMoneyAgencyOptions(names);
      paintedFromSnapshot=true;
    }
  }catch(e){}
  try{
    const rows = await soda({"$select":"agency_name","$where":"section_name='Procurement' AND agency_name IS NOT NULL",
      "$group":"agency_name","$order":"agency_name","$limit":"600"});
    paintMoneyAgencyOptions(rows.map(r=>r.agency_name));
  }catch(e){
    if(!paintedFromSnapshot) $("#agency").innerHTML = `<option value="">${t("all_agencies")}</option>`;
  }
}

let currentRows = [], mode = "open", selectedRFP = null, closingWeek = false, moneyLoaded = false, methodSel = "";
// Category, maximum amount, deadline window, and special-method exclusion have no dedicated
// Money controls. NLQ results and their deep links carry them here so search(), serializeState(),
// and applyHash() all replay the same complete filter.
let moneyNlResolved = {};
const weekOutISO = () => new Date(Date.now()+7*86400000).toISOString().slice(0,10) + "T23:59:59";
function moneyActiveFilterChip(item){
  const value = item.value;
  if(item.kind==="noticeType"){
    const label = value==="award" ? t("nl_filter_award") : value==="allrfp" ? t("head_allrfp") : t("nl_filter_open_rfp");
    return `<span class="qchip">${t("nl_filter_notice_label")} <b>${label}</b></span>`;
  }
  if(item.kind==="agency") return `<span class="qchip">${t("agency_label")} <b>${enTitle(value)}</b></span>`;
  if(item.kind==="keywords") return `<span class="qchip">${t("nl_filter_about_label")} <b>${enTitle(value.join(" / "))}</b></span>`;
  if(item.kind==="category") return `<span class="qchip">${t("nl_filter_category_label")} <b>${enTitle(value.replace(/\//g,"-"))}</b></span>`;
  if(item.kind==="minAmount") return `<span class="qchip">${t("nl_filter_min_label")} <b>${money(value)}</b></span>`;
  if(item.kind==="maxAmount") return `<span class="qchip">${t("nl_filter_max_label")} <b>${money(value)}</b></span>`;
  if(item.kind==="months") return `<span class="qchip">${t("nl_filter_months",{n:value})}</span>`;
  return `<span class="qchip"><b>${t("nl_filter_standard_only")}</b></span>`;
}
function renderMoneyActiveFilters(){
  const box=$("#moneyactivefilters"); if(!box) return;
  const filter={
    noticeType:mode==="award"?"award":mode==="allrfp"?"allrfp":"solicitation",
    agency:$("#agency").value,
    keywords:$("#kw").value.trim(),
    minAmount:$("#minamt").value,
    ...moneyNlResolved,
  };
  const items=moneyActiveFilterItems({
    noticeType:filter.noticeType, agency:filter.agency, keywords:filter.keywords,
    minAmount:filter.minAmount, ...moneyNlResolved,
  });
  box.innerHTML=interpretedSearchRowHTML("money", filter, items.map(moneyActiveFilterChip));
  bindClearSearchState("money", box);
}
async function search(){
  moneyLoaded = true;
  mode = $("#mode").value;
  const agency = $("#agency").value, kw = $("#kw").value.trim();
  const sort = $("#sort").value, minamt = $("#minamt").value;
  const hasMethodDropdown = mode !== "award";
  $("#minwrap").style.display = mode === "award" ? "" : "none";
  $("#methodwrap").style.display = hasMethodDropdown ? "" : "none";
  $("#minamt").disabled = mode !== "award";
  $("#methodfacet").style.display = hasMethodDropdown ? "none" : "";
  // The closing-week quick filter only makes sense for open RFPs.
  if(mode !== "open" && closingWeek){ closingWeek = false; $("#closingweek").classList.remove("on"); $("#closingweek").setAttribute("aria-pressed","false"); }
  $("#moneyquick").style.display = mode === "open" ? "" : "none";
  renderMoneyActiveFilters();

  let where = mode === "award" ? "type_of_notice_description='Award'" : "type_of_notice_description='Solicitation'";
  if(mode === "open") where += ` AND due_date > '${todayISO()}'`;
  if(mode === "open" && closingWeek) where += ` AND due_date <= '${weekOutISO()}'`;
  if(agency) where += ` AND agency_name='${agency.replace(/'/g,"''")}'`;
  if(mode === "award" && minamt) where += ` AND contract_amount >= ${minamt} AND contract_amount < ${MONEY_HONESTY_CAP}`;
  const {category=null, maxAmount=null, months=null, excludeSpecial=false} = moneyNlResolved;
  if(category) where += ` AND category_description='${category.replace(/'/g,"''")}'`;
  if(mode === "award" && maxAmount) where += ` AND contract_amount <= ${maxAmount}`;
  if(mode === "open" && months) where += ` AND due_date <= '${addMonthsISO(todayISO(), months)}'`;
  if(excludeSpecial) where += ` AND selection_method_description NOT LIKE '%Special%'`;
  const facetWhere = where; // method-facet counts are computed WITHOUT the method clause (Datasette-style)
  if(methodSel) where += ` AND selection_method_description='${methodSel.replace(/'/g,"''")}'`;

  let order;
  if(sort === "amount") order = "contract_amount DESC";
  else if(sort === "newest") order = "start_date DESC";
  else order = mode === "award" ? "start_date DESC" : "due_date ASC";

  updateHash();
  loadMethodFacet(facetWhere, kw); // fire-and-forget; the rail renders when it lands
  const heads = {open:t("head_open"), allrfp:t("head_allrfp"), award:t("head_award")};
  $("#reshead").textContent = heads[mode] + (mode==="open" && closingWeek ? t("head_closing_this_week") : "") + (methodSel ? " · " + methodSel : "") + (agency ? " · " + agency : "");
  $("#rescount").textContent = "";
  busyList("#list");
  const stale = staleGuard("money");
  // Default Money tab: paint prebuilt open-solicitation snapshot first (no SODA wait), then hybrid-refresh.
  const useDefaultSnapshot=isDefaultMoneySearchState({
    mode, agency, kw, methodSel, closingWeek, minAmount:minamt, sort, nlResolved:moneyNlResolved,
  });
  let paintedFromSnapshot=false;
  if(useDefaultSnapshot){
    try{
      const snap=await loadMoneyDefaultSnapshot();
      if(stale()) return;
      const notices=filterStillOpenMoneyNotices(snap&&Array.isArray(snap.notices)?snap.notices:[], todayISO());
      if(notices.length){
        paintMoneyRows(notices, {autoSelect:true, narrowed:false});
        paintedFromSnapshot=true;
      }
    }catch(e){}
  }
  const p = {"$select":SELECT,"$where":where,"$order":order,"$limit":"40"};
  if(kw) p["$q"] = kw;
  let narrowed = false, rows;
  try{
    try{
      rows = await soda(p, SLOW_MS);
    }catch(err){
      if(err.name !== "AbortError") throw err;
      // Full-history search ran past SLOW_MS — fall back to recent editions only.
      narrowed = true;
      rows = await soda({...p, "$where": where + " AND start_date > '" + recentCut() + "'"}, SLOW_MS + 4000);
    }
  }catch(e){
    if(stale()) return;
    if(!paintedFromSnapshot){
      unbusy("#list");
      $("#list").innerHTML = '<div class="empty">' + t("retry_open_data") + '</div>';
    }
    return;
  }
  if(stale()) return; // a newer search superseded this one
  // Hybrid refresh after a snapshot paint must not re-autoSelect (would wipe a chosen row).
  paintMoneyRows(rows, {autoSelect:!paintedFromSnapshot, narrowed});
}
function paintMoneyRows(rows, {autoSelect=true, narrowed=false}={}){
  currentRows = rows;
  setExportBandVisibility(currentRows.length, "money-export-band", "money-export-overflow");
  unbusy("#list");
  $("#rescount").textContent = currentRows.length === 40 ? "40+" : currentRows.length;
  announce(t(currentRows.length===40?"or_more_results":"results_count",{n:currentRows.length}) + ` — ${$("#reshead").textContent}`);
  renderList(autoSelect);
  if(narrowed) $("#list").insertAdjacentHTML("afterbegin",
    `<div class="note warn" style="margin:10px 12px 0">${t("narrowed_note",{date:recentCutLabel()})}</div>`);
}

/* Selection-method facet — every value is a pivot with a live count; counts reflect the
   current filters minus the method clause itself, so clicking narrows, re-clicking clears. */
async function loadMethodFacet(where, kw){
  const el = $("#methodfacet");
  const select = $("#methodselect");
  try{
    const p = {"$select":"selection_method_description, count(1) as n",
      "$where": where + " AND selection_method_description IS NOT NULL",
      "$group":"selection_method_description","$order":"n DESC","$limit":"7"};
    if(kw) p["$q"] = kw;
    const rows = (await soda(p)).filter(r=>r.selection_method_description && r.selection_method_description.trim());
    if(rows.length < 2 && !methodSel){
      el.style.display="none";
      if(mode !== "award") $("#methodwrap").style.display="none";
      return;
    }
    if(mode !== "award"){
      select.innerHTML = `<option value="" data-i18n="min_award_any">${t("min_award_any")}</option>` + rows.map(r=>{
        const m = r.selection_method_description;
        return `<option value="${m.replace(/&/g,"&amp;").replace(/"/g,"&quot;")}">${m}</option>`;
      }).join("");
      select.value = methodSel;
      $("#methodwrap").style.display = "";
      el.style.display = "none";
      return;
    }
    el.style.display = "";
    el.innerHTML = `<span class="facetlbl">${t("method_facet_label")}</span>` + rows.map(r=>{
      const m = r.selection_method_description;
      return `<button type="button" class="chip ${methodSel===m?'on':''}" data-m="${m.replace(/"/g,"&quot;")}">${m}<span class="ct">${(+r.n).toLocaleString()}</span></button>`;
    }).join("");
    el.querySelectorAll(".chip").forEach(b=>b.addEventListener("click", ()=>{
      methodSel = methodSel === b.dataset.m ? "" : b.dataset.m;
      search();
    }));
  }catch(e){
    el.style.display = "none";
    if(mode !== "award") $("#methodwrap").style.display="none";
  }
}

// moneyRowHTML: one Money/Contracts result row -- same title-highlight/evidence-line reuse of
// matchEvidence()/digTitleHTML()/digEvidenceHTML() as the Alerts-page ask preview's digItemHTML().
// terms is [] for plain browsing (no #kw typed), so matchEvidence returns null and the row
// renders exactly as it did before this existed.
//
// Solicitation M/WBE chips: pure extract from list fields (selection_method + body chunk).
// Default 20-day floors stay off the list; only distinctive method/goal markers show.
// Named distinctly from procurement-phase ensureMwbeGoalSurfaceTools so the
// reconstructed inline script (module-dom-equivalence) does not double-declare.
let moneyListMwbeSurfacePromise = null;
function moneyListMwbeSurfaceTools(){
  if(!moneyListMwbeSurfacePromise){
    moneyListMwbeSurfacePromise = import("../mwbe_goal_surface.mjs").catch(() => null);
  }
  return moneyListMwbeSurfacePromise;
}
function solicitationListChipsHTML(r){
  // Sync path uses cached module when already loaded; otherwise empty until async patch.
  const tools = moneyListMwbeSurfacePromise && moneyListMwbeSurfacePromise._value
    ? moneyListMwbeSurfacePromise._value
    : null;
  if(!tools || typeof tools.buildSolicitationListChips !== "function") return "";
  const chips = tools.buildSolicitationListChips(r) || [];
  if(!chips.length) return "";
  return `<div class="mwbe-chiprow" data-mwbe-list-chips="1">${chips.map(c => {
    const label = c.i18n_params ? t(c.i18n_key, c.i18n_params) : t(c.i18n_key);
    const tone = c.tone || "method";
    return `<span class="tag ${escUiHtml(tone)}">${escUiHtml(label)}</span>`;
  }).join("")}</div>`;
}
function moneyRowHTML(r, i, terms){
  const isAward = r.type_of_notice_description === "Award";
  const lead = isAward
    ? (money(r.contract_amount) ? `<span class="tag amt">${money(r.contract_amount)}</span>` : "")
    : deadlineTag(r.due_date);
  const title = cleanText(r.short_title), ev = matchEvidence(title, matchText(r), terms);
  const mwbeChips = !isAward ? solicitationListChipsHTML(r) : "";
  return `<div class="row" data-i="${i}" tabindex="0" role="button">
      <p class="rtitle">${title ? digTitleHTML(title, ev) : t("untitled_notice")}</p>
      <p class="rmeta">${lead}<span class="lineage-slot"></span><span class="ragency" lang="en" dir="ltr">${r.agency_name||""}</span> · ${fdate(r.start_date)}
        ${r.category_description? " · "+r.category_description : ""}<br>
        ${usablePin(r.pin)? `<span class="pin">PIN ${r.pin}</span>` : `<span class="pin muted">${t("no_linkable_pin")}</span>`}</p>
      ${mwbeChips}
      ${digEvidenceHTML(ev)}
    </div>`;
}
async function ensureMwbeListChipsReady(){
  const tools = await moneyListMwbeSurfaceTools();
  if(tools) moneyListMwbeSurfacePromise._value = tools;
  return tools;
}
function renderList(autoSelect){
  if(!currentRows.length){ $("#list").innerHTML = '<div class="empty">' + t("nothing_found") + '</div>'; return; }
  const kw = ($("#kw").value||"").trim(), terms = kw ? [kw] : [];
  // Preserve selection across hybrid refresh (snapshot → live) when the notice is still present.
  const keepId=autoSelect===false&&selectedRFP?selectedRFP.request_id:null;
  // Prefetch M/WBE chip tools so the second paint (or first if already cached) shows badges.
  ensureMwbeListChipsReady().then((tools)=>{
    if(!tools || !document.querySelector("#list .row")) return;
    // Re-paint only when chips were missing on first paint (module not yet loaded).
    if(document.querySelector("#list [data-mwbe-list-chips]")) return;
    const needs = currentRows.some((r)=>/solicitation/i.test(r?.type_of_notice_description||""));
    if(!needs) return;
    const selected = document.querySelector("#list .row.sel");
    const selIdx = selected ? selected.dataset.i : null;
    $("#list").innerHTML = currentRows.map((r,i)=>moneyRowHTML(r,i,terms)).join("");
    document.querySelectorAll("#list .row").forEach(el=>el.addEventListener("click",()=>select(+el.dataset.i, el)));
    if(selIdx != null){
      const el = document.querySelector(`#list .row[data-i="${selIdx}"]`);
      if(el) el.classList.add("sel");
    }
  }).catch(()=>{});
  $("#list").innerHTML = currentRows.map((r,i)=>moneyRowHTML(r,i,terms)).join("");
  document.querySelectorAll("#list .row").forEach(el=>el.addEventListener("click",()=>select(+el.dataset.i, el)));
  if(autoSelect===false&&keepId){
    const idx=currentRows.findIndex(r=>r&&r.request_id===keepId);
    if(idx>=0){
      const el=document.querySelector(`#list .row[data-i="${idx}"]`);
      if(el){ el.classList.add("sel"); selectedRFP=currentRows[idx]; }
      loadLineageBadges();
      return;
    }
  }
  if(autoSelect!==false) document.querySelector("#list .row")?.click(); // auto-open the first result — don't make the user click the obvious
  loadLineageBadges(); // fire-and-forget; badges splice into the .lineage-slot markers once the batch lookup lands
}

/* ===================== LINEAGE INDICATOR (w12-10) =====================
   Field evidence: the site owner, already aware the cadence estimate (cadenceEstimate(), w12-04)
   and past-winners strip (pastWinnersHTML(), w12-05) had shipped, could not find a live notice
   exhibiting either one without being handed fixture PINs directly -- both only reveal
   themselves after opening a notice that happens to have a chain. This surfaces the same
   signal one level up, on the result row itself, so a reader can see which notices have
   history before clicking in.

   Cost: ONE extra SODA request per renderList() call, not one per row. It batches every visible
   row's chain key (pinBase()-widened PIN + agency -- the exact same widening loadChain() uses
   to build a single notice's chain) into one $where clause of ORed conditions, restricted to
   Award/Intent-to-Award stages, and fetches all of them at once. A results page never exceeds
   40 rows (search()'s own $limit), so this is at most 40 ORed clauses in one GET -- comfortably
   under URL-length limits, and a small fraction of the cost of 40 individual per-row lookups.
   It fires after the list has already painted (same fire-and-forget-then-patch-in pattern as
   loadMethodFacet()), so it never blocks or slows the list's own render; a badge is spliced into
   each qualifying row's pre-rendered `.lineage-slot` marker once counts are known.

   LINEAGE_MAX_STAGES exists because of a real, live pinBase()/loadChain() edge case found while
   testing this against production data: PIN "82626R0001001" (agency "Environmental Protection")
   is a single, ordinary Award with no renewal history at all -- but its own literal digits
   happen to end in something pinBase()'s `/R0\d+$/` suffix-strip matches, widening it to base
   "82626" and prefix-matching ~180 UNRELATED contracts under that agency's fiscal-year PIN
   prefix. isBlanketChain()'s existing "every stage is Award" check doesn't catch this case (the
   false-widened set mixes Award/Intent-to-Award/Solicitation stages), so without this ceiling
   the batch would render a nonsensical "180 cycles" badge. This is a pre-existing pinBase()
   over-widening gap that also affects chainHTML()/pastWinnersHTML() on the detail view today
   (out of scope to fix here -- worth its own future card); LINEAGE_MAX_STAGES is a narrower,
   more conservative honesty gate specific to this new surface: every genuine chain fixture
   documented in this codebase (test/cadence_estimate.test.mjs, test/past_winners.test.mjs) tops
   out at 6 real stages, so a widened match past 15 reads as a PIN-prefix collision, not a
   legitimate multi-decade renewal history, and is treated the same as "uncertain" -- no badge. */
const LINEAGE_MIN_STAGES = 2; // pastWinnersHTML()'s own threshold — nothing to roll up below this
const LINEAGE_MAX_STAGES = 15; // beyond this, a widened match reads as a PIN-prefix collision, not a real chain

function lineageChainKey(r){
  if(!usablePin(r.pin) || !r.agency_name) return null;
  return { pin: r.pin, base: pinBase(r.pin), agency_name: r.agency_name };
}
function lineageDedupeKey(k){ return (k.base||k.pin) + "|" + k.agency_name; }

function lineageBatchClauses(keys){
  return keys.map(k=>{
    const agency = `agency_name='${k.agency_name.replace(/'/g,"''")}'`;
    const pinClause = k.base
      ? `pin LIKE '${k.base.replace(/'/g,"''")}%'`
      : `pin='${k.pin.replace(/'/g,"''")}'`;
    return `(${pinClause} AND ${agency})`;
  });
}

// Pure: given the rows on screen and the batch of Award/Intent-to-Award stage rows fetched for
// their chain keys, decide which row gets a history badge and what count to show. Same honesty
// gate pastWinnersHTML() applies to a single notice's chain (isBlanketChain() exclusion,
// >=LINEAGE_MIN_STAGES) -- a row's badge promises exactly what pastWinnersHTML()/cadenceHTML()
// will show once you click through, never more, never a guess when lineage is uncertain.
function computeLineageBadgeCounts(rows, batchRows){
  const memo = new Map(); // dedupe key -> count|null, computed once per distinct chain
  return rows.map(r=>{
    const k = lineageChainKey(r);
    if(!k) return null;
    const dedupeKey = lineageDedupeKey(k);
    if(memo.has(dedupeKey)) return memo.get(dedupeKey);
    const stages = batchRows.filter(row => row.agency_name === k.agency_name &&
      (k.base ? String(row.pin||"").startsWith(k.base) : row.pin === k.pin));
    const n = (!isBlanketChain(stages) && stages.length >= LINEAGE_MIN_STAGES && stages.length <= LINEAGE_MAX_STAGES)
      ? stages.length : null;
    memo.set(dedupeKey, n);
    return n;
  });
}

async function loadLineageBadges(){
  const rows = currentRows;
  const keys = [], seenKeys = new Set();
  rows.forEach(r=>{
    const k = lineageChainKey(r);
    if(!k) return;
    const dedupeKey = lineageDedupeKey(k);
    if(seenKeys.has(dedupeKey)) return;
    seenKeys.add(dedupeKey);
    keys.push(k);
  });
  if(!keys.length) return; // nothing with a usable PIN on this page -- no batch worth firing
  const where = `(${lineageBatchClauses(keys).join(" OR ")}) AND (type_of_notice_description='Award' OR type_of_notice_description='Intent to Award')`;
  let batchRows;
  try{
    // $limit is generous (not the ~40 rows a genuine batch of small chains would need) because
    // SODA applies it to the WHOLE combined query, with no per-clause guarantee -- a single
    // widened key colliding with many unrelated PINs (see LINEAGE_MAX_STAGES's comment above)
    // could otherwise silently crowd out and undercount a different, genuine chain sharing this
    // same batch call. Still one request either way.
    batchRows = await soda({"$select":"pin,agency_name,type_of_notice_description","$where":where,"$limit":"2000"});
  }catch(e){ return; } // silent no-op -- a history badge is a bonus, not core content (same posture as agencyForecastTeaser())
  if(currentRows !== rows) return; // a newer search superseded this one
  const counts = computeLineageBadgeCounts(rows, batchRows);
  document.querySelectorAll("#list .row").forEach(el=>{
    const n = counts[+el.dataset.i];
    if(!n) return;
    const slot = el.querySelector(".lineage-slot");
    if(slot) slot.outerHTML = `<span class="tag renewal">${tn("history_cycles_tag", n, {n})}</span>`;
  });
}

async function select(i, el){
  document.querySelectorAll("#list .row.sel").forEach(e=>e.classList.remove("sel"));
  el.classList.add("sel");
  const r = currentRows[i];
  selectedRFP = r;
  // The row's full record is already in memory — paint it now (title, glance, how-to-respond),
  // and hydrate the chain + agency stats in place when they land. Clicking feels instant.
  renderDetail(r, null, null);
  const [chain, stats] = await Promise.all([ loadChain(r), loadAgencyStats(r.agency_name) ]);
  if(selectedRFP !== r) return; // user moved on to another notice
  renderDetail(r, chain, stats);
}

// A renewal round is commonly re-published under the same base PIN with an "R00N" suffix
// appended (e.g. "06823N0030001" → "06823N0030001R001") -- 8.8% of Award rows carry one.
// pinBase() strips it so loadChain()/showMatter() can widen an exact match into a same-agency
// prefix match and show the whole award-and-renewal history as one paper trail, instead of
// 2-3 disconnected single-notice pages. PINs without the suffix are left alone (returns null)
// and keep the cheaper, more precise exact match.
const RENEWAL_SUFFIX_RE = /R0\d+$/;
function pinBase(pin){
  const s = String(pin||"").trim();
  const m = s.match(RENEWAL_SUFFIX_RE);
  return m ? s.slice(0, m.index) : null;
}
async function loadChain(r){
  if(!usablePin(r.pin)) return [r];
  try{
    const base = pinBase(r.pin);
    const where = base
      ? `pin LIKE '${base.replace(/'/g,"''")}%' AND agency_name='${r.agency_name.replace(/'/g,"''")}'`
      : `pin='${r.pin.replace(/'/g,"''")}' AND agency_name='${r.agency_name.replace(/'/g,"''")}'`;
    const rows = await soda({"$select":SELECT,
      "$where":where,
      "$order":"start_date ASC","$limit":"60"});
    rows.sort((a,b)=> (a.start_date||"").localeCompare(b.start_date||"") ||
      (STAGE_RANK[a.type_of_notice_description]??9) - (STAGE_RANK[b.type_of_notice_description]??9));
    return rows.length ? rows : [r];
  }catch(e){ return [r]; }
}

// Publish live bindings for neighboring modules and legacy inline handlers.
globalThis.LINEAGE_MAX_STAGES = LINEAGE_MAX_STAGES;
globalThis.LINEAGE_MIN_STAGES = LINEAGE_MIN_STAGES;
globalThis.RENEWAL_SUFFIX_RE = RENEWAL_SUFFIX_RE;
globalThis.computeLineageBadgeCounts = computeLineageBadgeCounts;
globalThis.lineageBatchClauses = lineageBatchClauses;
globalThis.lineageChainKey = lineageChainKey;
globalThis.lineageDedupeKey = lineageDedupeKey;
globalThis.loadAgencies = loadAgencies;
globalThis.loadChain = loadChain;
globalThis.loadLineageBadges = loadLineageBadges;
globalThis.loadMethodFacet = loadMethodFacet;
globalThis.loadMoneyDefaultSnapshot = loadMoneyDefaultSnapshot;
globalThis.loadMoneyAgenciesSnapshot = loadMoneyAgenciesSnapshot;
globalThis.isDefaultMoneySearchState = isDefaultMoneySearchState;
globalThis.filterStillOpenMoneyNotices = filterStillOpenMoneyNotices;
globalThis.moneyActiveFilterChip = moneyActiveFilterChip;
globalThis.moneyRowHTML = moneyRowHTML;
globalThis.paintMoneyRows = paintMoneyRows;
globalThis.pinBase = pinBase;
globalThis.renderList = renderList;
globalThis.renderMoneyActiveFilters = renderMoneyActiveFilters;
globalThis.search = search;
globalThis.select = select;
globalThis.weekOutISO = weekOutISO;
Object.defineProperty(globalThis, "closingWeek", { configurable: true, get: () => closingWeek, set: value => { closingWeek = value; } });
Object.defineProperty(globalThis, "currentRows", { configurable: true, get: () => currentRows, set: value => { currentRows = value; } });
Object.defineProperty(globalThis, "methodSel", { configurable: true, get: () => methodSel, set: value => { methodSel = value; } });
Object.defineProperty(globalThis, "mode", { configurable: true, get: () => mode, set: value => { mode = value; } });
Object.defineProperty(globalThis, "moneyLoaded", { configurable: true, get: () => moneyLoaded, set: value => { moneyLoaded = value; } });
Object.defineProperty(globalThis, "moneyNlResolved", { configurable: true, get: () => moneyNlResolved, set: value => { moneyNlResolved = value; } });
Object.defineProperty(globalThis, "selectedRFP", { configurable: true, get: () => selectedRFP, set: value => { selectedRFP = value; } });
