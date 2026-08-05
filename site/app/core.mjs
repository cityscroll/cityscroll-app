import { cityRecordRequestUrl } from "../city_record_id.mjs";

const SODA = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
const PAY  = "https://data.cityofnewyork.us/resource/k397-673e.json";
const CSL  = "https://data.cityofnewyork.us/resource/vx8i-nprf.json";
const PAYFY = "2025";
// Optional backend (crol-worker, a Cloudflare Worker on our own subdomain — user-visible URLs
// like feeds and confirm links should read cityscroll.org, never *.workers.dev). Empty = fully
// client-side: the NL box uses the on-device heuristic, Checkbook $-paid stays hidden, alerts
// are preview-only. Every worker-backed feature falls back to static behavior if unreachable.
const API = window.CROL_API_ORIGIN || "https://api.cityscroll.org";
// The branded subdomain is young — resolvers with a stale NXDOMAIN (or flaky DNS) would
// otherwise kill every worker feature. workerFetch() fails over to the workers.dev alias
// and remembers which base worked for the rest of the session. Non-idempotent POSTs get no
// timeout (an abort+retry could double-send); the DNS failure mode rejects immediately anyway.
const API_FALLBACK = window.CROL_API_FALLBACK_ORIGIN || "https://crol-worker.crol-worker.workers.dev";
let apiBase = API;
async function workerFetch(path, opts, timeoutMs){
  // Session cookie lives on the API host. Credentialed calls are same-site
  // (cityscroll.org → api.cityscroll.org) and only needed for /session + /pins.
  const needsCreds = path === "/session" || path === "/session/logout" || path === "/pins"
    || path.startsWith("/session?") || path.startsWith("/pins?");
  const withCreds = (o) => {
    const base = Object.assign({}, o || {});
    if (needsCreds) base.credentials = "include";
    return base;
  };
  const attempt = async (base) => {
    if(!timeoutMs) return fetch(base + path, withCreds(opts));
    const ctl = new AbortController();
    const t = setTimeout(()=>ctl.abort(), timeoutMs);
    try{ return await fetch(base + path, {...withCreds(opts), signal: ctl.signal}); }
    finally{ clearTimeout(t); }
  };
  try{ return await attempt(apiBase); }
  catch(e){
    const other = apiBase === API ? API_FALLBACK : API;
    const r = await attempt(other);
    apiBase = other;
    return r;
  }
}
const REQ_URL = id => `https://a856-cityrecord.nyc.gov/RequestDetail/${encodeURIComponent(id)}`;
// City Record/PASSPort/Checkbook NYC carve-out (test/standards/link_targets.py): these three
// government systems open in a new tab so a bid workflow doesn't lose CityScroll's app state.
const EXT_ATTRS = 'target="_blank" rel="noopener noreferrer"';
const extSR = () => `<span class="sr-only"> ${t("ext_link_new_tab_sr")}</span>`;
const STAGE_RANK = {"Solicitation":0,"Intent to Negotiate":1,"Vendor List":2,"Intent to Award":3,"Award":4};
const JUNK_PINS = new Set(["NOPINFOUND","SEE BELOW","LINE 17 BELOW","TBD","N/A","NONE","VARIOUS","SEE ATTACHED","123456"]); // compared UPPERCASED — entries must be uppercase (unit-tested); "123456" is a confirmed placeholder default value, not a real PIN
// Looser second pass alongside JUNK_PINS above: the exact-match set misses common real-world
// phrasings of the same "see the list below" placeholder (measured 37.7% miss rate on a 300-row
// sample). \b keeps this from matching inside a real alphanumeric PIN -- digits and letters are
// both \w, so "SEE12345" never has a word boundary after "see" and is left alone.
const JUNK_PIN_TEXT_RE = /\bsee\b|\bbelow\b|\bline\s*17\b|\bn\/?a\b|\btbd\b|\bvarious\b|\bpending\b|\battached\b/i;
// other_info_1 is fetched alongside additional_description_1 for the same reason
// worker/src/ingest.mjs picks up both -- some notices (e.g. request_id 20260709010, a DYCD
// COMPASS afterschool award) carry all their explanatory text in other_info_1 and leave
// additional_description_1 blank; matchText() below reads both so a real keyword hit doesn't
// silently fall back to "matched via a field this preview doesn't fetch" just because one
// column happened to be empty.
const SELECT = "request_id,start_date,agency_name,type_of_notice_description,category_description,short_title,pin,contract_amount,vendor_name,due_date,address_to_request,contact_name,contact_phone,email,selection_method_description,additional_description_1,other_info_1";

// Honest-data cap (EDA: 3 rows >= $10B are data-entry errors, max legit ~= $6.68B; mirrors
// worker/src/ingest.mjs's AMOUNT_CAP). One named constant is referenced everywhere a Money-lens
// query needs it instead of repeating the literal; test/contract/money_honesty_cap.test.mjs pins
// both sides.
const MONEY_HONESTY_CAP = 10000000000;
const EXPORT_BAND_THRESHOLD = 25;

const $ = s => document.querySelector(s);
const todayISO = () => new Date().toISOString().slice(0,10) + "T00:00:00";
// N months after an ISO date, as a date-only ISO string — mirrors the worker's compileSub()
// monthsFromISO() exactly, so the alert preview's "due within" bound matches the digest.
const addMonthsISO = (iso, months) => { const d=new Date(iso.slice(0,10)+"T00:00:00Z"); d.setUTCMonth(d.getUTCMonth()+months); return d.toISOString().slice(0,10); };
// If a full-history query runs past SLOW_MS, automatically retry within this recent window.
const RECENT_DAYS = 730, SLOW_MS = 7000;
const recentCut = () => new Date(Date.now()-RECENT_DAYS*86400000).toISOString().slice(0,10) + "T00:00:00";
const recentCutLabel = () => { const _lm=(window.LANG_META||{})[window.LANG||"en"]; return new Date(Date.now()-RECENT_DAYS*86400000).toLocaleDateString(_lm?_lm.intlDate:"en-US",{month:"long",day:"numeric",year:"numeric"}); };

/* Read-side cache + in-flight coalescing for the open-data GETs. Repeating a query the session
   already ran (tab A→B→A, re-selecting a row, re-clicking a facet) renders from memory instead
   of re-paying a network round-trip; two callers racing for the same URL share one request.
   Editions change once a day — a 5-minute TTL is conservatively fresh. */
const API_CACHE = new Map(), API_TTL = 300000;
async function api(base, params, timeoutMs){
  const key = base + "?" + new URLSearchParams(params).toString();
  const hit = API_CACHE.get(key);
  if(hit){
    if(hit.p) return hit.p;                       // same request already in flight — share it
    if(Date.now() - hit.at < API_TTL) return hit.rows;
    API_CACHE.delete(key);
  }
  const p = (async ()=>{
    const ctl = timeoutMs ? new AbortController() : null;
    const t = ctl ? setTimeout(()=>ctl.abort(), timeoutMs) : null;
    try{
      const r = await fetch(key, ctl ? {signal:ctl.signal} : undefined);
      if(!r.ok) throw new Error("API " + r.status);
      return await r.json();
    } finally { if(t) clearTimeout(t); }
  })();
  API_CACHE.set(key, {p});
  try{
    const rows = await p;
    API_CACHE.set(key, {rows, at: Date.now()});
    return rows;
  }catch(e){ API_CACHE.delete(key); throw e; }    // failures (incl. timeouts) are never cached
}
const soda = (params, timeoutMs) => api(SODA, params, timeoutMs);

/* Perceived-speed helpers. busyList: keep what's on screen, dimmed, while fresh rows load —
   only skeleton when there's nothing real to keep. staleGuard: interactions can overlap
   (type, click a chip, switch back); each lens keeps a sequence number and late responses
   from superseded requests are dropped instead of clobbering the newest render. */
function listSkeleton(n){
  let s = '<div class="empty skel" aria-hidden="true"><span class="loading"></span>';
  for(let i=0;i<(n||4);i++) s += '<span class="skl"><i></i><i></i></span>';
  return s + '</div>';
}
function setExportBandVisibility(count, bandId, overflowId){
  const band = $("#" + bandId);
  const overflow = $("#" + overflowId);
  if(!band || !overflow) return;
  const value = Number(count);
  band.hidden = Number.isFinite(value) && value <= EXPORT_BAND_THRESHOLD;
  overflow.hidden = !Number.isFinite(value) || value === 0 || value > EXPORT_BAND_THRESHOLD;
}
function busyList(sel, n){
  const el = $(sel); if(!el) return;
  if(el.querySelector(".row, .fcard")) el.classList.add("busy");
  else el.innerHTML = listSkeleton(n);
}
function unbusy(sel){ const el = $(sel); if(el) el.classList.remove("busy"); }
const SEQ = {};
function staleGuard(lens){ const my = (SEQ[lens]||0) + 1; SEQ[lens] = my; return ()=> SEQ[lens] !== my; }
function debounce(fn, ms){ let t; return (...a)=>{ clearTimeout(t); t = setTimeout(()=>fn(...a), ms); }; }

function usablePin(p){
  if(!p) return false;
  const s = String(p).trim();
  if(s.length < 4) return false;
  if(!/[A-Za-z0-9]/.test(s)) return false;
  if(/^[0\W_]+$/.test(s)) return false;
  if(JUNK_PINS.has(s.toUpperCase())) return false;
  if(JUNK_PIN_TEXT_RE.test(s)) return false;
  return true;
}
// Hand-synced with site/text_clean.mjs cleanNoticeText: strip tags, decode entities, collapse
// whitespace. Returns plain Unicode — HTML sinks must escape once (escUiHtml / excerptHtml).
// Incomplete decode left &ldquo; in feed/hearing paths; escUiHtml then re-escaped to the literal
// string "&ldquo;" (notice 20220525018). Truncate only on the decoded result (excerptHtml).
// Self-contained (decoder inlined) so test extractors that pull only cleanText still run.
function cleanText(s){
  if(!s) return "";
  const named={amp:"&",lt:"<",gt:">",quot:'"',apos:"'",nbsp:"\u00A0",ldquo:"\u201C",rdquo:"\u201D",lsquo:"\u2018",rsquo:"\u2019",sbquo:"\u201A",bdquo:"\u201E",ndash:"\u2013",mdash:"\u2014",hellip:"\u2026",bull:"\u2022",middot:"\u00B7",sect:"\u00A7",para:"\u00B6",copy:"\u00A9",reg:"\u00AE",trade:"\u2122",deg:"\u00B0",times:"\u00D7",divide:"\u00F7",plusmn:"\u00B1",frac12:"\u00BD",frac14:"\u00BC",frac34:"\u00BE",euro:"\u20AC",pound:"\u00A3",yen:"\u00A5",cent:"\u00A2"};
  let out=String(s).replace(/<[^>]*>/g," ").replace(/[\u0000-\u001f\u007f-\u009f]/g," ");
  for(let pass=0; pass<2; pass++){
    const next=out.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi,(m,body)=>{
      if(body[0]==="#"){
        const code=(body[1]==="x"||body[1]==="X")?parseInt(body.slice(2),16):parseInt(body.slice(1),10);
        if(!Number.isFinite(code)||code<0||code>0x10ffff) return m;
        try{ return String.fromCodePoint(code); }catch{ return m; }
      }
      const key=String(body).toLowerCase();
      return Object.prototype.hasOwnProperty.call(named,key)?named[key]:m;
    });
    if(next===out) break;
    out=next;
  }
  return out.replace(/\s+/g," ").trim();
}
// Decode → truncate on plain text → escape once. Owner for every notice preview/card excerpt.
// Self-contained so extractors that pull only excerptHtml (+ cleanText) still run.
function excerptHtml(s, n){
  const plain=cleanText(s);
  if(!plain) return "";
  const esc=v=>String(v).replace(/[<>&'"]/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;","'":"&#39;",'"':"&quot;"}[c]));
  const max=Math.max(0, Number(n)||0);
  if(plain.length<=max) return esc(plain);
  return esc(plain.slice(0,max))+"…";
}
// w9-06 (WCAG 3.1.2): City Record data values (notice titles, agency/vendor names, addresses)
// are always English, regardless of UI language -- wrap them so es-mode screen readers don't
// apply Spanish phonetics. Chrome/labels around them stay translated; only the data span here
// gets tagged. No-op (returns the raw string) when there's nothing to wrap.
// dir="ltr" (w8-03): under ar/ur RTL chrome this same span also needs bidi isolation, so a
// title's punctuation/numerals don't reorder against the surrounding RTL text (WCAG 1.3.2) --
// an explicit dir attribute gets the browser's UA-stylesheet unicode-bidi:isolate for free.
function enTitle(s){ return s ? `<span lang="en" dir="ltr">${s}</span>` : s; }
function money(v){
  const n = Number(v);
  if(!v || isNaN(n) || n === 0) return null;
  if(n >= 1e9) return "$" + (n/1e9).toFixed(2) + "B";
  if(n >= 1e6) return "$" + (n/1e6).toFixed(2) + "M";
  if(n >= 1e3) return "$" + Math.round(n/1e3) + "K";
  return "$" + n.toLocaleString("en-US",{maximumFractionDigits:0});
}
function fdate(s){ return s ? String(s).slice(0,10) : ""; }
function fdt(s, opts){
  if(!s) return "";
  opts=opts||{};
  const raw=String(s);
  const calendarDay=raw.match(/^(\d{4}-\d{2}-\d{2})/);
  const dateOnly=opts.dateOnly===true;
  const d = dateOnly&&calendarDay
    ? new Date(`${calendarDay[1]}T00:00:00Z`)
    : new Date(s);
  if(Number.isNaN(d.getTime())) return String(s).slice(0,10);
  const _lm=(window.LANG_META||{})[window.LANG||"en"];
  const _loc=_lm?_lm.intlDate:"en-US";
  if(dateOnly){
    return d.toLocaleDateString(_loc,{year:"numeric",month:"long",day:"numeric",timeZone:"UTC"});
  }
  // Full ISO with a non-midnight clock → include local time (ULURP hearing logistics).
  const hasClock=/T\d{2}:\d{2}/.test(raw) && !/T00:00:00/.test(raw);
  if(hasClock){
    return d.toLocaleString(_loc,{year:"numeric",month:"long",day:"numeric",hour:"numeric",minute:"2-digit"});
  }
  return d.toLocaleDateString(_loc,{year:"numeric",month:"long",day:"numeric"});
}
function daysLeft(s){ if(!s) return null; return Math.ceil((new Date(s) - new Date())/86400000); }
// Honest deadline label: due dates in year >= 2090 are rolling placeholders (pre-qualified-list
// entries), not real deadlines — mirrors worker/src/ingest.mjs's ROLLING_YEAR /
// worker/src/alerts.mjs's dueLabel(). Never render one as a real date or a day-count.
const ROLLING_DUE_YEAR = 2090;
function isRollingDeadline(due){
  if(!due) return false;
  const y = Number(String(due).slice(0,4));
  return Number.isFinite(y) && y >= ROLLING_DUE_YEAR;
}
const _SPELL = ["zero","one","two","three","four","five","six","seven","eight","nine"];
function _spellNum(n){ return n < 10 ? _SPELL[n] : String(n); }
function deadlineTag(due){
  if(isRollingDeadline(due)) return `<span class="tag open">${t("rolling_deadline_tag")}</span>`;
  const dl = daysLeft(due);
  if(dl === null) return "";
  if(dl < 0) return `<span class="tag closed">${t("closed_tag")}</span>`;
  if(dl === 0) return `<span class="tag hot">${t("closes_today")}</span>`;
  if(dl === 1) return `<span class="tag hot">${t("closes_in_1_day")}</span>`;
  if(dl <= 3) return `<span class="tag hot">${t("closes_in_n_days",{n:_spellNum(dl)})}</span>`;
  if(dl <= 14) return `<span class="tag soon">${t("closes_in_n_days",{n:dl<10?_spellNum(dl):dl})}</span>`;
  return `<span class="tag open">${t("open_days_left",{n:dl})}</span>`;
}
// Countdown chip for event dates (hearings, meetings, sales). Past events get no chip —
// the date itself still shows; urgency chips are for what the reader can still attend.
function eventTag(ev){
  const dl = daysLeft(ev);
  if(dl === null || dl < 0) return "";
  if(dl <= 3) return ` <span class="tag hot">${dl===0?t("event_today"):tn("event_in_n_days",dl)}</span>`;
  if(dl <= 14) return ` <span class="tag soon">${tn("event_in_n_days",dl)}</span>`;
  return ` <span class="tag open">${tn("event_in_n_days",dl)}</span>`;
}

/* ===================== TABS ===================== */
function announce(msg){ const el=$("#srstatus"); if(el) el.textContent = msg; }
function countWithScopeReceipt(observed){
  const raw=globalThis.CROL_SCOPE_RESULT_COUNT_RECEIPT;
  if(raw==null||raw==="") return observed;
  const receipt=Number(raw);
  return Number.isInteger(receipt)&&receipt>=0?receipt:observed;
}
globalThis.countWithScopeReceipt=countWithScopeReceipt;
function syncTabAria(){
  const btns=[...document.querySelectorAll(".tabbtn")];
  let any=false;
  btns.forEach(b=>{ const on=b.classList.contains("active"); b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1; if(on) any=true; });
  if(!any && btns[0]) btns[0].tabIndex = 0; // notice view: no tab selected — keep the tablist reachable
}
let pendingRouteModuleTab=null;
function showTab(name, push){
  const routeModules=globalThis.CrolRouteModules;
  if(routeModules && !routeModules.isReady(name)){
    pendingRouteModuleTab=name;
    routeModules.ensure(name).then(()=>{
      if(pendingRouteModuleTab!==name) return;
      pendingRouteModuleTab=null;
      showTab(name,push);
    }).catch(()=>{});
    return;
  }
  pendingRouteModuleTab=null;
  const leavingLandEntry = name==="land" && push && location.hash.startsWith("#land/");
  document.querySelectorAll(".tabpane").forEach(p=>p.classList.toggle("active", p.id === "tab-"+name));
  document.querySelectorAll(".tabbtn").forEach(b=>b.classList.toggle("active", b.dataset.tab === name));
  syncTabAria();
  // Push BEFORE any lazy load below runs updateHash(), or the load's replaceState
  // rewrites the prior entry and the push turns into a no-op (Back would skip a tab).
  if(push) pushHash();
  if(name==="land"){ loadLeaflet().catch(()=>{}); if(!landLoaded || leavingLandEntry){ landLoaded=true; landSearch(); } if(landMap) setTimeout(()=>landMap.invalidateSize(),120); }
  if(name==="money" && !moneyLoaded) search(); // deep links land on other tabs; Money lazy-loads like the rest
  if(name==="money" && matchMedia("(max-width:680px)").matches){
    const controls=document.getElementById("tab-money").querySelector(".controls");
    const toggle=controls && controls.previousElementSibling;
    if(controls) controls.classList.add("open");
    if(toggle && toggle.classList.contains("filtertoggle")) toggle.setAttribute("aria-expanded","true");
  }
  if(name==="people"){
    loadCareerGuide(); loadStaffingFeed();
    if(push && !globalThis.careerSelected){
      requestAnimationFrame(()=>scrollStaffingView("notices"));
    }
  }
  if(name==="property"){
    const panel=$("#tax-lien-sale-panel");
    if(panel){
      // Only keep the tax-lien panel open on its dedicated deep link.
      const openLien=location.hash.includes("view=tax-lien");
      panel.hidden=!openLien;
      if(openLien) paintTaxLienSalePanel();
    }
  }
  if(name==="map") paintMapExploration();
  // Monitor-pack code and data are Alerts-only; keep both off the home cold path.
  if(name==="alerts" && typeof initWatchTemplates==="function") initWatchTemplates();
  if(SECTIONS[name] && !feedLoaded[name]){ feedLoaded[name]=true; loadSectionAgencies(name); loadSection(name); }
  // Header alert CTA carries the active lens/filter (or clears to bare #alerts).
  if(typeof syncAlertsEntryHrefs === "function"){
    Promise.resolve(syncAlertsEntryHrefs()).catch(()=>{});
  }
}

document.querySelectorAll(".tabbtn").forEach(b=>b.addEventListener("click",()=>showTab(b.dataset.tab, true)));

/* ARIA tab semantics (WAI-ARIA Authoring Practices "tabs" pattern) + arrow-key navigation */
(function(){
  const nav=document.querySelector(".tabs"); if(!nav) return;
  nav.setAttribute("role","tablist"); nav.setAttribute("aria-label", t("tablist_label"));
  document.querySelectorAll(".tabbtn").forEach(b=>{
    b.id="tabbtn-"+b.dataset.tab; b.setAttribute("role","tab"); b.setAttribute("aria-controls","tab-"+b.dataset.tab);
  });
  document.querySelectorAll(".tabpane").forEach(p=>{
    // #tab-notice/#tab-entity have no corresponding .tabbtn (reached only via permalink/pivot,
    // never the tablist) — role=tabpanel with no owning tab is an orphan per WAI-ARIA APG, so
    // they get no tab role at all rather than a false aria-labelledby.
    const btn=document.getElementById("tabbtn-"+p.id.slice(4));
    if(btn){ p.setAttribute("role","tabpanel"); p.setAttribute("aria-labelledby", btn.id); }
  });
  nav.addEventListener("keydown", e=>{
    const tabs=[...nav.querySelectorAll(".tabbtn")];
    const i=tabs.indexOf(document.activeElement); if(i<0) return;
    let j=null;
    if(e.key==="ArrowRight") j=(i+1)%tabs.length;
    else if(e.key==="ArrowLeft") j=(i-1+tabs.length)%tabs.length;
    else if(e.key==="Home") j=0;
    else if(e.key==="End") j=tabs.length-1;
    if(j!==null){ e.preventDefault(); tabs[j].focus(); tabs[j].click(); }
  });
  syncTabAria();
})();

/* Result-list rows are keyboard-operable: Enter/Space activates the focused row */
["#list","#plist","#llist"].forEach(sel=>{
  const el=$(sel); if(!el) return;
  el.addEventListener("keydown", e=>{
    if((e.key==="Enter"||e.key===" ") && e.target.classList && e.target.classList.contains("row")){ e.preventDefault(); e.target.click(); }
  });
});

/* Mobile: filters collapse behind a toggle (NN/g mobile faceted-search tray, lite) */
document.querySelectorAll(".tabpane .controls").forEach(c=>{
  const b=document.createElement("button");
  const startsOpen=!!c.closest("#tab-money") && matchMedia("(max-width:680px)").matches;
  if(startsOpen) c.classList.add("open");
  b.type="button"; b.className="filtertoggle"; b.textContent="☰ " + t("filters_toggle"); b.setAttribute("aria-expanded",String(startsOpen));
  c.parentNode.insertBefore(b,c);
  b.addEventListener("click",()=>{ const open=c.classList.toggle("open"); b.setAttribute("aria-expanded", String(open)); });
});

// Publish live bindings for neighboring modules and legacy inline handlers.
globalThis.$ = $;
globalThis.API = API;
globalThis.API_CACHE = API_CACHE;
globalThis.API_FALLBACK = API_FALLBACK;
globalThis.API_TTL = API_TTL;
globalThis.CSL = CSL;
globalThis.EXT_ATTRS = EXT_ATTRS;
globalThis.JUNK_PINS = JUNK_PINS;
globalThis.JUNK_PIN_TEXT_RE = JUNK_PIN_TEXT_RE;
globalThis.MONEY_HONESTY_CAP = MONEY_HONESTY_CAP;
globalThis.PAY = PAY;
globalThis.PAYFY = PAYFY;
globalThis.RECENT_DAYS = RECENT_DAYS;
globalThis.REQ_URL = REQ_URL;
globalThis.cityRecordRequestUrl = cityRecordRequestUrl;
globalThis.ROLLING_DUE_YEAR = ROLLING_DUE_YEAR;
globalThis.EXPORT_BAND_THRESHOLD = EXPORT_BAND_THRESHOLD;
globalThis.SELECT = SELECT;
globalThis.SEQ = SEQ;
globalThis.SLOW_MS = SLOW_MS;
globalThis.SODA = SODA;
globalThis.STAGE_RANK = STAGE_RANK;
globalThis._SPELL = _SPELL;
globalThis._spellNum = _spellNum;
globalThis.addMonthsISO = addMonthsISO;
globalThis.announce = announce;
globalThis.api = api;
globalThis.busyList = busyList;
globalThis.cleanText = cleanText;
globalThis.daysLeft = daysLeft;
globalThis.deadlineTag = deadlineTag;
globalThis.debounce = debounce;
globalThis.enTitle = enTitle;
globalThis.eventTag = eventTag;
globalThis.excerptHtml = excerptHtml;
globalThis.extSR = extSR;
globalThis.fdate = fdate;
globalThis.fdt = fdt;
globalThis.isRollingDeadline = isRollingDeadline;
globalThis.listSkeleton = listSkeleton;
globalThis.money = money;
globalThis.recentCut = recentCut;
globalThis.recentCutLabel = recentCutLabel;
globalThis.showTab = showTab;
globalThis.soda = soda;
globalThis.staleGuard = staleGuard;
globalThis.syncTabAria = syncTabAria;
globalThis.todayISO = todayISO;
globalThis.unbusy = unbusy;
globalThis.usablePin = usablePin;
globalThis.setExportBandVisibility = setExportBandVisibility;
globalThis.workerFetch = workerFetch;
Object.defineProperty(globalThis, "apiBase", { configurable: true, get: () => apiBase, set: value => { apiBase = value; } });
