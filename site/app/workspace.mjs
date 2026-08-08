import { noticeDisplayTitle } from "../display_title.mjs";

/* ===================== INVESTIGATION WORKSPACE (#investigation) =====================
   Aleph's Investigations, account-free: pin notices/entities/matters into a named local
   workspace (localStorage — nothing leaves the device), annotate, export citation-grade
   CSV/JSON, print a dossier, or share a read-only snapshot via the worker's /inv store.
   Recognized email sessions (magic-link from digests) also sync pins server-side so
   phone and laptop share the same list; anonymous behavior is unchanged. */
const INVKEY = "crd_invs_v1";
let invSessionRecognized = false;
let invServerHydrated = false;
let invSyncTimer = null;
function invDefaultStore(){
  return {current:"inv1", invs:{inv1:{name:t("inv_default_name"), created:new Date().toISOString().slice(0,10), items:[]}}};
}
function invStore(){
  try{ const s = JSON.parse(localStorage.getItem(INVKEY)||"null"); if(s && s.invs && s.invs[s.current]) return s; }catch(e){}
  return invDefaultStore();
}
function invSave(s){
  try{ localStorage.setItem(INVKEY, JSON.stringify(s)); }catch(e){}
  // Recognized sessions write through to the server (debounced). Failures keep local.
  if(invSessionRecognized) invScheduleServerSave(s);
}
function invItemKey(it){ return String(it && it.t || "") + "|" + String(it && it.id || ""); }
function invMergeItems(a, b){
  const map = new Map();
  for(const it of [...(a||[]), ...(b||[])]){
    if(!it || !it.id || !it.t) continue;
    const k = invItemKey(it);
    const prev = map.get(k);
    if(!prev){ map.set(k, {...it}); continue; }
    map.set(k, {
      ...prev,
      title: (it.title||"").length >= (prev.title||"").length ? it.title : prev.title,
      meta: (it.meta||"").length >= (prev.meta||"").length ? it.meta : prev.meta,
      note: (it.note||"").length >= (prev.note||"").length ? it.note : prev.note,
      added: prev.added && it.added ? (prev.added <= it.added ? prev.added : it.added) : (prev.added || it.added),
    });
  }
  return [...map.values()];
}
/** Union two inv stores (dedupe items by type+id). Pure; used for first-session merge. */
function invMergeStores(local, server){
  if(!local && !server) return invDefaultStore();
  if(!local) return server;
  if(!server) return local;
  const invs = {};
  const ids = new Set([...Object.keys(local.invs||{}), ...Object.keys(server.invs||{})]);
  for(const id of ids){
    const la = (local.invs||{})[id], lb = (server.invs||{})[id];
    if(la && lb){
      invs[id] = {
        name: lb.name || la.name,
        created: la.created && lb.created ? (la.created <= lb.created ? la.created : lb.created) : (la.created || lb.created),
        items: invMergeItems(la.items, lb.items),
      };
    } else invs[id] = la || lb;
  }
  let current = server.current && invs[server.current] ? server.current
    : (local.current && invs[local.current] ? local.current : Object.keys(invs)[0]);
  return { current, invs };
}
function invScheduleServerSave(s){
  if(invSyncTimer) clearTimeout(invSyncTimer);
  invSyncTimer = setTimeout(()=>{ invPushServer(s); }, 400);
}
async function invPushServer(s){
  if(!invSessionRecognized || !API) return;
  try{
    await workerFetch("/pins", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pins: s, merge: false }),
    }, 10000);
  }catch(e){ /* offline / API down — localStorage remains authoritative */ }
}
async function invPullAndMerge(){
  if(!API) return;
  try{
    const r = await workerFetch("/pins", null, 10000);
    if(!r || !r.ok) return;
    const j = await r.json();
    if(!j || !j.recognized){ invSessionRecognized = false; return; }
    invSessionRecognized = true;
    const local = invStore();
    const server = j.pins || null;
    // First recognized session (or any load): union local + server, write both ways.
    const merged = invMergeStores(local, server);
    try{ localStorage.setItem(INVKEY, JSON.stringify(merged)); }catch(e){}
    invServerHydrated = true;
    // Persist the union back so other devices see local pins.
    await invPushServer(merged);
  }catch(e){ /* stay local */ }
}
const INV_HREF = {notice:"/notices/", matter:"#matter/"};
const invItemHref = it => it.t==="agency" ? agencyHref(it.id) : it.t==="vendor" ? vendorHref(it.id) :
  (INV_HREF[it.t]||"/notices/") + encodeURIComponent(it.id) + (it.t==="notice"?"/":"");
function pinBtn(t, id, title, meta){
  const d = JSON.stringify({t, id, title:String(title).slice(0,300), meta:String(meta||"").slice(0,300)})
    .replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;");
  return `<button class="act" type="button" data-pin="${d}">${window.t("pin_btn")}</button>`; // param `t` is the item type — use window.t
}
document.addEventListener("click", e=>{
  const b = e.target.closest("[data-pin]");
  if(b){
    let p; try{ p = JSON.parse(b.dataset.pin); }catch(_){ return; }
    const s = invStore(), inv = s.invs[s.current];
    if(!inv.items.some(i=>i.t===p.t && i.id===p.id)){
      inv.items.push({...p, note:"", added:new Date().toISOString().slice(0,10)});
      invSave(s);
    }
    // w9-03 (2.4.3): b.outerHTML= would destroy the focused node (focus drops to <body>) --
    // build the replacement and move focus onto it explicitly instead.
    const a = document.createElement("a");
    a.className = "act";
    a.href = "#investigation";
    a.textContent = t("pinned_open_inv",{n:s.invs[s.current].items.length});
    b.replaceWith(a);
    a.focus();
    return;
  }
  const f = e.target.closest("[data-follow]");
  if(f){
    // Context-carry contract: the server preview and saved watch consume one scope.
    const kind = f.dataset.follow === "agency" ? "agency" : "vendor";
    const name = String(f.dataset.name || "").trim();
    const scope = { lens: "entity", filter: { kind, name: name || null }, digKind: "notice" };
    import("../alerts_context_carry.mjs")
      .then((carry) => {
        location.assign(typeof carry.alertsHref === "function" ? carry.alertsHref(scope) : "/following/");
      })
      .catch(() => location.assign("/following/"));
  }
});

function invCsv(inv){
  const base = location.origin + location.pathname;
  return CrolExports.excelSafeCsv([
    ["Type",i=>i.t],["Title",i=>i.title],["Meta",i=>i.meta],
    ["Note",i=>i.note],["Added",i=>i.added],["Permalink",i=>base+invItemHref(i)]
  ],inv.items);
}
function invDownload(name, content, type){
  const a=document.createElement("a");
  a.href=URL.createObjectURL(new Blob([content],{type}));
  a.download=name; document.body.appendChild(a); a.click(); a.remove();
}
const PINTYPE_KEY = {notice:"pintype_notice", vendor:"pintype_vendor", agency:"pintype_agency", matter:"pintype_matter"};
function invItemsHtml(items, readonly){
  const acc = new Date().toISOString().slice(0,10);
  return items.map((i,idx)=>`<div class="tl" data-idx="${idx}" style="align-items:flex-start">
    <span class="pin" style="flex:0 0 auto">${t(PINTYPE_KEY[i.t]||"pintype_notice")}</span>
    <span style="flex:1 1 300px;min-width:220px">
      <b>${pivotA(invItemHref(i), i.title.replace(/[<>&]/g,""))}</b>
      <span class="rmeta" style="display:block;margin:2px 0 0">${(i.meta||"").replace(/[<>&]/g,"")} · ${t("inv_pinned_on",{date:i.added})}</span>
      ${readonly
        ? (i.note?`<span class="rmeta2" style="display:block">${i.note.replace(/[<>&]/g,"")}</span>`:"")
        : `<input type="text" class="invnote" data-idx="${idx}" aria-label="${t("invnote_aria")}" data-i18n-aria="invnote_aria" value="${(i.note||"").replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;")}" placeholder="${t("inv_note_placeholder")}" style="margin-top:6px;font-size:13px;padding:7px 9px">`}
    </span>
    ${readonly?"":`<button class="act invdel" data-idx="${idx}" type="button" style="padding:6px 9px">✕</button>`}
  </div>`).join("");
}

async function showInvestigation(){
  showTab("entity");
  const s = invStore(), inv = s.invs[s.current];
  const box = $("#entityview");
  delete box.dataset.vendorStem;
  box.innerHTML = `<div style="max-width:880px;margin:0 auto">
    <p style="margin:4px 0 12px">${routeBackHTML("#money")}</p>
    <div class="panel" style="padding:22px 24px">
      <div class="ftype" style="margin-bottom:6px">${t("inv_ws_heading")}</div>
      <h2 style="margin:0"><input type="text" id="invname" aria-label="${t("inv_name_aria")}" data-i18n-aria="inv_name_aria" value="${inv.name.replace(/"/g,"&quot;")}" style="font:800 22px/1.2 var(--font-display);border:none;background:transparent;padding:0;width:100%"></h2>
      <div class="rmeta2">${t("inv_pinned_meta",{n:inv.items.length, s:inv.items.length===1?"":"s", date:inv.created})}</div>
      <div class="timeline" style="margin-top:14px" id="invitems">
        ${inv.items.length ? invItemsHtml(inv.items,false) : `<div class="empty">${t("inv_empty")}</div>`}
      </div>
      <div class="actions" style="margin-top:16px">
        <button class="act primary" type="button" id="invshare">${t("inv_share_btn")}</button>
        <button class="act" type="button" id="invcsv">${t("inv_export_csv")}</button>
        <button class="act" type="button" id="invjson">${t("inv_export_json")}</button>
        <button class="act" type="button" id="invprint">${t("inv_print_btn")}</button>
        <button class="act" type="button" id="invclear" style="color:var(--rose)">${t("inv_clear_btn")}</button>
      </div>
      <div id="invmsg" class="muted" role="status" style="margin-top:10px;font:13px/1.5 ui-sans-serif,system-ui,sans-serif"></div>
      <div class="note">${t("inv_footer_note_html")}</div>
    </div></div>`;
  $("#invname").addEventListener("change", ()=>{ const s2=invStore(); s2.invs[s2.current].name=$("#invname").value.slice(0,80)||t("inv_default_name"); invSave(s2); });
  box.querySelectorAll(".invnote").forEach(inp=>inp.addEventListener("change", ()=>{
    const s2=invStore(); s2.invs[s2.current].items[+inp.dataset.idx].note=inp.value.slice(0,1000); invSave(s2);
  }));
  box.querySelectorAll(".invdel").forEach(b=>b.addEventListener("click", ()=>{
    const s2=invStore(); s2.invs[s2.current].items.splice(+b.dataset.idx,1); invSave(s2); showInvestigation();
  }));
  $("#invcsv").addEventListener("click", async ()=>{
    await ensureCrolExports();
    invDownload("investigation.csv", invCsv(invStore().invs[s.current]), "text/csv;charset=utf-8");
  });
  $("#invjson").addEventListener("click", ()=>invDownload("investigation.json", JSON.stringify(invStore().invs[s.current],null,2), "application/json"));
  $("#invprint").addEventListener("click", ()=>window.print());
  $("#invclear").addEventListener("click", ()=>{ const s2=invStore(); s2.invs[s2.current].items=[]; invSave(s2); showInvestigation(); });
  $("#invshare").addEventListener("click", async ()=>{
    const msg=$("#invmsg"), cur=invStore().invs[s.current];
    if(!cur.items.length){ msg.textContent=t("inv_pin_first"); return; }
    if(!API){ msg.textContent=t("inv_share_needs_backend"); return; }
    msg.innerHTML=`<span class="loading"></span> ${t("inv_uploading")}`;
    try{
      const r=await workerFetch("/inv",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:cur.name, items:cur.items})});
      const j=await r.json();
      if(j.ok){
        const url=location.origin+location.pathname+"#investigation/shared/"+j.id;
        msg.innerHTML=`${t("inv_readonly_link",{n:j.ttlDays})} <a href="${url}">${url}</a> <button class="act" type="button" style="padding:5px 9px" onclick="copyText('${url}', this)">${t("inv_copy_btn")}</button>`;
      } else msg.textContent = j.reason==="rate-limited" ? t("inv_too_many_shares") : t("inv_share_failed");
    }catch(e){ msg.textContent=t("cant_reach_server"); }
  });
  announce(t("inv_ws_heading"));
}

async function showSharedInv(id){
  showTab("entity");
  const box = $("#entityview");
  delete box.dataset.vendorStem;
  box.innerHTML = `<div class="empty"><span class="loading"></span> ${t("inv_fetching_shared")}</div>`;
  let j=null;
  try{ const r=await workerFetch("/inv/"+encodeURIComponent(id), null, 12000); if(r.ok) j=await r.json(); }catch(e){}
  if(!j || !j.items){ box.innerHTML=`<div class="empty">${t("inv_shared_missing_html")} ${routeBackHTML("#investigation")}</div>`; return; }
  box.innerHTML = `<div style="max-width:880px;margin:0 auto">
    <p style="margin:4px 0 12px">${routeBackHTML("#investigation")}</p>
    <div class="panel route-item" tabindex="-1" style="padding:22px 24px">
      <div class="ftype" style="margin-bottom:6px">${t("inv_shared_heading",{date:j.sharedAt||"—"})}</div>
      <h2 class="rolename">${String(j.name||`Investigation ${id}`).replace(/[<>&]/g,"")}</h2>
      <div class="timeline" style="margin-top:14px">${invItemsHtml(j.items,true)}</div>
      <div class="actions" style="margin-top:16px"><button class="act primary" type="button" id="invimport">${t("inv_import_btn")}</button></div>
    </div></div>`;
  $("#invimport").addEventListener("click", ()=>{
    const s=invStore(), inv=s.invs[s.current];
    j.items.forEach(p=>{ if(!inv.items.some(i=>i.t===p.t&&i.id===p.id)) inv.items.push({...p, added:p.added||new Date().toISOString().slice(0,10)}); });
    invSave(s); location.hash="#investigation";
  });
  focusItemRouteTarget(box.querySelector(".route-item"));
  applyActiveHistoryRouteScroll();
}

/* ===================== MATTER TIMELINE (#matter/<pin>) =====================
   One procurement matter as a phase-grouped chronology: City Record notices sharing the
   PIN plus Checkbook registration/paid-to-date. Phase grouping reuses the same
   procurement ontology as the notice lifecycle (solicitation → selection → award/
   registration → payments) and the land/ZAP phase-spine presentation shape (#326).
   Cross-section stitching (hearings) isn't in the data — only ~8 of 10.5K hearing rows
   carry a PIN. Pure model: site/matter_phase_spine.mjs. */
let matterPhaseSpineToolsPromise = null;
function ensureMatterPhaseSpineTools(){
  if(!matterPhaseSpineToolsPromise){
    matterPhaseSpineToolsPromise = import("../matter_phase_spine.mjs").catch(() => null);
  }
  return matterPhaseSpineToolsPromise;
}

function matterPhaseLabel(phase){
  if(!phase) return "—";
  if(phase.label_key) return t(phase.label_key);
  if(typeof phase === "string"){
    const meta = {
      solicitation: "matter_phase_solicitation",
      selection: "matter_phase_selection",
      award_registration: "matter_phase_award_registration",
      payments: "matter_phase_payments",
    };
    return meta[phase] ? t(meta[phase]) : phase;
  }
  return phase.short || "—";
}

function matterMilestoneTitle(m){
  if(!m) return "—";
  if(m.kind === "payment" || m.stage === "payment"){
    const spent = m.spent_to_date != null ? m.spent_to_date : 0;
    const current = m.current_amount != null ? m.current_amount : null;
    return `${t("lifecycle_dollars_paid_lbl")}: ${money(spent) || "$0"}${current != null ? ` ${t("matter_phase_of")} ${money(current) || "—"}` : ""}`;
  }
  if(m.kind === "registered" || m.stage === "registered"){
    if(m.status === "unmatched") return t("lifecycle_stage_registered");
    return `${t("lifecycle_stage_registered")}${m.contract_id ? ` — ${m.contract_id}` : ""}`;
  }
  const type = m.notice_type || m.stage || "Notice";
  const title = m.title && m.title !== type ? m.title : "";
  return title ? `${type} — ${title}` : type;
}

function matterMilestoneMeta(m){
  if(!m) return "";
  if(m.kind === "payment"){
    const term = (m.start_date || m.end_date)
      ? `${fdate(m.start_date) || "—"} → ${fdate(m.end_date) || "—"}`
      : "";
    return term;
  }
  if(m.kind === "registered"){
    if(m.status === "unmatched") return "";
    return `${t("lifecycle_dollars_committed_lbl")} ${money(m.current_amount) || "—"}`;
  }
  const bits = [];
  if(m.renewal_linked && m.pin) bits.push(t("matter_renewal_linked",{pin:escUiHtml(m.pin)}));
  if(m.contract_amount != null) bits.push(money(m.contract_amount) || "");
  if(m.vendor_name) bits.push("→ " + cleanText(m.vendor_name));
  if(m.due_date){
    bits.push(isRollingDeadline(m.due_date) ? t("rolling_deadline_tag") : t("matter_responses_due",{date:fdate(m.due_date)}));
  }
  return bits.filter(Boolean).join(" · ");
}

function matterPhaseAggregateHTML(agg, phaseId, idx){
  if(!agg) return "";
  if(agg.count === 1){
    const m = agg.members[0] || {};
    const title = matterMilestoneTitle(m);
    const meta = matterMilestoneMeta(m);
    const noticeLink = m.request_id
      ? pivotA("#notice/" + encodeURIComponent(m.request_id), cleanText(m.title) || m.request_id)
      : "";
    return `<div class="matter-phase-row">
      <div class="matter-phase-row-title" lang="en" dir="ltr">${m.request_id && m.kind === "notice"
        ? `<b>${escUiHtml(m.notice_type || "Notice")}</b> — ${noticeLink}`
        : escUiHtml(title)}</div>
      <div class="matter-phase-row-meta">${agg.first ? fdate(agg.first) : (m.kind === "payment" ? t("matter_today") : "—")}${meta ? ` · ${meta}` : ""}</div>
    </div>`;
  }
  const listId = `matter-agg-${phaseId}-${idx}`;
  return `<div class="matter-phase-agg">
    <div class="matter-phase-agg-title" lang="en" dir="ltr">${escUiHtml(agg.title)}<span class="matter-phase-count">×${agg.count}</span></div>
    <div class="matter-phase-agg-meta">${agg.first && agg.last
      ? t("matter_phase_aggregate_range",{first:fdate(agg.first),last:fdate(agg.last)})
      : (agg.first ? fdate(agg.first) : "—")}</div>
    <button type="button" class="matter-phase-toggle" data-matter-dates="${listId}" aria-expanded="false">${t("matter_phase_show_dates",{n:String(agg.count)})}</button>
    <ul class="matter-phase-dates" id="${listId}">
      ${(agg.members || []).map(m => {
        const link = m.request_id
          ? pivotA("#notice/" + encodeURIComponent(m.request_id), fdate(m.date) || m.request_id)
          : (m.date ? fdate(m.date) : "—");
        return `<li>${link}${m.vendor_name ? ` · ${escUiHtml(cleanText(m.vendor_name))}` : ""}</li>`;
      }).join("")}
    </ul>
  </div>`;
}

function matterPhasePanelHTML(phase){
  if(!phase) return "";
  if(phase.state === "future" && !phase.event_count) return "";
  if(phase.state === "passed" && !phase.event_count) return "";
  const open = phase.state === "current" ? " open" : "";
  const stateWord = phase.state === "current"
    ? t("matter_phase_current")
    : phase.state === "passed"
      ? t("matter_phase_done")
      : t("matter_phase_future");
  let summary = "";
  if(phase.event_count){
    const parts = [
      t("matter_phase_milestones_count",{n:String(phase.event_count)}),
      phase.first && phase.last && phase.first !== phase.last
        ? t("matter_phase_aggregate_range",{first:fdate(phase.first),last:fdate(phase.last)})
        : (phase.first ? fdate(phase.first) : ""),
    ].filter(Boolean);
    summary = parts.join(" · ");
  } else {
    summary = t("matter_phase_empty");
  }
  const body = (phase.aggregates || []).map((a, idx) => matterPhaseAggregateHTML(a, phase.id, idx)).join("")
    || `<div class="matter-phase-row"><div class="matter-phase-row-meta">${t("matter_phase_empty")}</div></div>`;
  return `<details class="matter-phase${phase.state === "current" ? " current-phase" : ""}"${open} id="matter-phase-${escUiHtml(phase.id)}" data-matter-phase-panel="${escUiHtml(phase.id)}">
    <summary>
      <span class="matter-phase-name">${escUiHtml(matterPhaseLabel(phase))}</span>
      <span class="matter-phase-state">${escUiHtml(stateWord)}</span>
      <span class="matter-phase-summary">${escUiHtml(summary)}</span>
    </summary>
    <div class="matter-phase-body">${body}</div>
  </details>`;
}

function matterPhaseStepperHTML(view){
  if(!view || !view.phases || !view.phases.length) return "";
  const items = view.phases.map((p, i) => {
    const cls = p.state === "current" ? "current" : p.state === "passed" ? "passed" : "future";
    const aria = p.state === "current" ? ` aria-current="step"` : "";
    const arrow = i < view.phases.length - 1
      ? `<span class="lc-step-arrow" aria-hidden="true">→</span>`
      : "";
    return `<li><button type="button" class="lc-step ${cls}" data-matter-phase="${escUiHtml(p.id)}"${aria} title="${escUiHtml(matterPhaseLabel(p))}">${escUiHtml(p.short || matterPhaseLabel(p))}</button>${arrow}</li>`;
  }).join("");
  return `<ol class="lc-stepper matter-phase-stepper" aria-label="${escUiHtml(t("matter_phase_heading"))}">${items}</ol>`;
}

function matterPhaseActionHTML(view){
  const cur = view && view.current;
  if(!cur) return "";
  const key = cur.action_key || "matter_phase_action_respond";
  if(key === "matter_phase_action_follow_money" && view.checkbook){
    const href = checkbookSearchUrl(view.checkbook);
    return t("matter_phase_action_follow_money",{
      href: escUiHtml(href),
      link: `<a href="${escUiHtml(href)}" ${EXT_ATTRS}>${t("lifecycle_source_checkbook")}${extSR()}</a>`
    });
  }
  if(key === "matter_phase_action_respond" && view.action_notice_id){
    return t("matter_phase_action_respond_html",{
      href: "#notice/" + encodeURIComponent(view.action_notice_id)
    });
  }
  if(key === "matter_phase_action_track_award" && view.latest_notice_id){
    return t("matter_phase_action_track_award_html",{
      href: "#notice/" + encodeURIComponent(view.latest_notice_id)
    });
  }
  return t(key);
}

function matterChronoRowHTML(m){
  const date = m.date ? fdate(m.date) : t("matter_today");
  let label = "";
  if(m.kind === "notice" && m.request_id){
    label = `<b>${escUiHtml(m.notice_type || "Notice")}</b> — ${pivotA("#notice/"+encodeURIComponent(m.request_id), noticeDisplayTitle({title:m.title,request_id:m.request_id}))}`;
  } else {
    label = `<b>${escUiHtml(matterMilestoneTitle(m))}</b>`;
  }
  const extra = matterMilestoneMeta(m);
  return `<div class="tl"><span class="tldate">${date}</span>
    <span class="tlreason" style="font-weight:400">${label}</span>
    ${extra ? `<span class="rmeta" style="margin:0">${extra}</span>` : ""}</div>`;
}

function matterPhaseTimelineHTML(view){
  if(!view) return "";
  const cur = view.current || {};
  const phaseName = matterPhaseLabel({label_key: cur.label_key});
  let detail = cur.milestone_label || "";
  if(cur.milestone_label === "paid_to_date") detail = t("lifecycle_dollars_paid_lbl");
  else if(cur.milestone_label === "registered") detail = t("lifecycle_stage_registered");
  // Always-visible status bits so Award / Registered / Paid scan without opening history.
  const chrono = view.chronological || [];
  const statusBits = [];
  if(chrono.some(m => m.stage === "award" || m.notice_type === "Award")) statusBits.push(t("lifecycle_stage_award"));
  if(view.has_registration || chrono.some(m => m.stage === "registered" && m.status !== "unmatched")){
    statusBits.push(t("lifecycle_stage_registered"));
  }
  if(chrono.some(m => m.stage === "payment")) statusBits.push(t("lifecycle_dollars_paid_lbl"));
  const statusLine = statusBits.length
    ? `<p class="matter-phase-now-detail" lang="en" dir="ltr">${statusBits.map(s => escUiHtml(s)).join(" · ")}</p>`
    : "";
  const actionHTML = matterPhaseActionHTML(view);
  const lead = `<div class="matter-phase-lead">
    <div class="matter-phase-now-label">${t("matter_phase_now_label")}</div>
    <p class="matter-phase-now-phase">${escUiHtml(phaseName)}</p>
    <p class="matter-phase-now-detail" lang="en" dir="ltr">${escUiHtml(detail || "—")}${cur.since ? ` · ${t("matter_phase_since",{date:fdate(cur.since)})}` : ""}</p>
    ${statusLine}
    ${actionHTML ? `<p class="matter-phase-action">${actionHTML}</p>` : ""}
    ${view.next ? `<p class="matter-phase-next">${t("matter_phase_next_html",{phase:escUiHtml(matterPhaseLabel(view.next))})}</p>` : ""}
  </div>`;
  const stepper = matterPhaseStepperHTML(view);
  const currentPanel = (view.phases || []).filter(p => p.state === "current")
    .map(matterPhasePanelHTML).join("");
  const historyPanels = (view.phases || []).filter(p => p.state === "passed")
    .map(matterPhasePanelHTML).filter(Boolean).join("");
  const historyWrap = historyPanels
    ? `<details class="matter-phase-history"><summary>${t("matter_phase_show_history")}</summary>${historyPanels}</details>`
    : "";
  const chronoRows = (view.chronological || []).map(matterChronoRowHTML).join("");
  const how = `<details class="inline-disclose lc-how">
    <summary>${t("matter_phase_show_all")}</summary>
    <div class="timeline matter-phase-chrono">${chronoRows}</div>
  </details>
  <details class="inline-disclose lc-how">
    <summary>${t("matter_phase_how_summary")}</summary>
    <div class="inline-disclose-body">${t("matter_phase_how_html")}</div>
  </details>`;
  return `${lead}${stepper}${currentPanel}${historyWrap}${how}`;
}

/** Flat fallback if phase module fails to load — still one Checkbook link when known. */
function matterTimelineHTMLFlat(rows, pin, regDetail, lifecycle){
  const items = rows.map(r => ({
    date: r.start_date,
    label: `<b>${r.type_of_notice_description||"Notice"}</b> — ${pivotA("#notice/"+encodeURIComponent(r.request_id), noticeDisplayTitle(r))}`,
    extra: [r.pin && r.pin !== pin ? t("matter_renewal_linked",{pin:escUiHtml(r.pin)}) : null,
            money(r.contract_amount), r.vendor_name?"→ "+pivotA(vendorHref(r.vendor_name), cleanText(r.vendor_name)):null,
            r.due_date?(isRollingDeadline(r.due_date)?t("rolling_deadline_tag"):t("matter_responses_due",{date:fdate(r.due_date)})):null].filter(Boolean).join(" · ")
  }));
  if(regDetail && regDetail.registration_date){
    items.push({
      date: regDetail.registration_date,
      label: `<b>${t("lifecycle_stage_registered")}</b> — <code>${escUiHtml(regDetail.contract_id||"")}</code> (${t("lifecycle_source_checkbook")})`,
      extra: `${t("lifecycle_dollars_committed_lbl")} ${money(regDetail.current_amount)||"—"}`
    });
  }
  items.sort((a,b)=>(a.date||"9999").localeCompare(b.date||"9999"));
  if(regDetail){
    const spent = regDetail.spent_to_date != null ? regDetail.spent_to_date : 0;
    const current = regDetail.current_amount != null ? regDetail.current_amount : 0;
    items.push({
      date: null,
      label: `<b>${t("lifecycle_dollars_paid_lbl")}: ${money(spent)||"$0"}</b> of ${money(current)||"—"}`,
      extra: `${fdate(regDetail.start_date)||"—"} → ${fdate(regDetail.end_date)||"—"}`
    });
  }
  return `<div class="timeline" style="margin-top:14px">
    ${items.map(it=>`<div class="tl"><span class="tldate">${it.date?fdate(it.date):t("matter_today")}</span>
      <span class="tlreason" style="font-weight:400">${it.label}</span>
      ${it.extra?`<span class="rmeta" style="margin:0">${it.extra}</span>`:""}</div>`).join("")}
  </div>`;
}

function bindMatterPhaseUI(root){
  if(!root || root.dataset.matterPhaseBound === "1") return;
  root.dataset.matterPhaseBound = "1";
  root.addEventListener("click", (ev) => {
    const step = ev.target.closest?.("[data-matter-phase]");
    if(step && root.contains(step)){
      const id = step.getAttribute("data-matter-phase");
      const panel = root.querySelector(`[data-matter-phase-panel="${CSS.escape(id)}"]`);
      if(panel){
        const hist = panel.closest?.(".matter-phase-history");
        if(hist) hist.open = true;
        panel.open = true;
        try{ panel.scrollIntoView({block:"nearest", behavior:"smooth"}); }catch(_){}
      }
      return;
    }
    const tog = ev.target.closest?.("[data-matter-dates]");
    if(tog && root.contains(tog)){
      const listId = tog.getAttribute("data-matter-dates");
      const list = listId ? root.querySelector("#" + CSS.escape(listId)) : null;
      if(list){
        const open = list.classList.toggle("show");
        tog.setAttribute("aria-expanded", open ? "true" : "false");
        tog.textContent = open
          ? t("matter_phase_hide_dates")
          : t("matter_phase_show_dates",{n:String(list.children.length)});
      }
    }
  });
}

async function showMatter(pin){
  const renderGeneration=(globalThis.__entityRouteGeneration||0)+1;
  globalThis.__entityRouteGeneration=renderGeneration;
  const isCurrentRender=()=>globalThis.__entityRouteGeneration===renderGeneration;
  const routeKeyAtStart=globalThis.routeFocusKey?.()||location.hash||`${location.pathname}${location.search}`;
  const safe = String(pin).replace(/[<>&]/g,"");
  showTab("entity");
  const box = $("#entityview");
  delete box.dataset.vendorStem;
  box.innerHTML = `<div class="empty"><span class="loading"></span> ${t("matter_loading",{pin:safe})}</div>`;
  await globalThis.ensureMoneyHistory?.();
  await globalThis.ensureRules?.();
  if(!isCurrentRender()) return;
  const phaseToolsP = ensureMatterPhaseSpineTools();
  let rows = [];
  try{
    rows = await soda({"$select":SELECT,"$where":`pin='${String(pin).replace(/'/g,"''")}'`,"$order":"start_date ASC","$limit":"60"}, 15000);
  }catch(e){}
  if(!isCurrentRender()) return;
  // Whichever renewal-suffixed PIN a link used to reach this page, widen to the same base+agency
  // prefix match loadChain() uses, so the matter page shows the same combined history regardless
  // of which specific suffix (…R001, …R002, …) got the reader here.
  const matterBase = pinBase(pin);
  if(matterBase && rows.length){
    const matterAgency = rows[0].agency_name;
    try{
      const more = await soda({"$select":SELECT,
        "$where":`pin LIKE '${matterBase.replace(/'/g,"''")}%' AND agency_name='${matterAgency.replace(/'/g,"''")}'`,
        "$order":"start_date ASC","$limit":"60"}, 15000);
      const seen = new Set(rows.map(x=>x.request_id));
      more.forEach(x=>{ if(!seen.has(x.request_id)){ rows.push(x); seen.add(x.request_id); } });
      if(!isCurrentRender()) return;
    }catch(e){}
  }
  if(!rows.length){
    box.innerHTML = `<div class="empty">${t("matter_empty",{pin:safe})} ${routeBackHTML("#money")}</div>`;
    applyActiveHistoryRouteScroll();
    return;
  }
  rows.sort((a,b)=>(a.start_date||"").localeCompare(b.start_date||"") ||
    (STAGE_RANK[a.type_of_notice_description]??9)-(STAGE_RANK[b.type_of_notice_description]??9));
  const agency = rows[rows.length-1].agency_name || rows[0].agency_name || "";
  const vendor = rows.map(r=>r.vendor_name).filter(Boolean).pop() || "";
  // Precompute-first: pull registration/payment from the edge-materialized lifecycle for
  // the newest notice on this PIN, not a live Checkbook proxy call from the browser.
  let lifecycle = null;
  try{
    const latestId = rows[rows.length-1].request_id;
    const resp = await workerFetch("/contract-lifecycle?id=" + encodeURIComponent(latestId), null, 8000);
    if(resp && resp.ok) lifecycle = await resp.json();
  }catch(e){}
  if(!isCurrentRender()) return;
  const reg = lifecycle && Array.isArray(lifecycle.timeline)
    ? lifecycle.timeline.find(e => e.stage === "registered" && e.status === "matched")
    : null;
  const regDetail = reg && reg.detail ? reg.detail : null;
  const phaseTools = await phaseToolsP;
  if(!isCurrentRender()) return;
  let view = null;
  if(phaseTools && typeof phaseTools.buildMatterPhaseView === "function"){
    view = phaseTools.buildMatterPhaseView(rows, { pin, regDetail, lifecycle });
  }
  const bodyHTML = view
    ? `<div class="timeline matter-phase-timeline" style="margin-top:14px">${matterPhaseTimelineHTML(view)}</div>`
    : matterTimelineHTMLFlat(rows, pin, regDetail, lifecycle);
  const checkbookHref = view && view.checkbook
    ? checkbookSearchUrl(view.checkbook)
    : (regDetail ? checkbookSearchUrl({
        contractId: regDetail.contract_id,
        pin,
        agid: regDetail.agid || regDetail.checkbook_agid,
        documentCode: regDetail.document_code || regDetail.doctype,
        detailUrl: regDetail.checkbook_detail_url,
      }) : null);
  const latestNoticeId = (view && view.latest_notice_id) || rows[rows.length-1].request_id;
  const eventCount = view ? view.event_count : rows.length + (regDetail ? 2 : 0);
  const link = location.origin + location.pathname + "#matter/" + encodeURIComponent(pin);
  box.innerHTML = `<div style="max-width:880px;margin:0 auto">
    <p style="margin:4px 0 12px">${routeBackHTML("#money")}</p>
    <div class="panel route-item" tabindex="-1" style="padding:22px 24px">
      <div class="ftype" style="margin-bottom:6px">${t("matter_heading_html",{pin:`<code>${safe}</code>`})}</div>
      <h2 class="rolename" lang="en" dir="ltr">${agency?pivotA(agencyHref(agency), agencyWho(agency)):""}${vendor?` × ${pivotA(vendorHref(vendor), cleanText(vendor))}`:""}</h2>
      ${bodyHTML}
      <div class="actions" style="margin-top:16px">
        <button class="act primary" type="button" id="ecopy">${t("copy_link_btn")}</button>
        ${qrButtonHTML("eqr","act")}
        ${pinBtn("matter", pin, t("meta_matter",{pin:safe}), [agency, vendor?cleanText(vendor):null].filter(Boolean).join(" × "))}
        <a class="act" href="${REQ_URL(latestNoticeId)}" ${EXT_ATTRS}>${t("matter_latest_city_record")}${extSR()}</a>
        ${checkbookHref ? `<a class="act" href="${escUiHtml(checkbookHref)}" ${EXT_ATTRS}>${t("matter_open_checkbook")}${extSR()}</a>` : ""}
      </div>
      <div class="note">${t("matter_spine_note")}</div>
    </div></div>`;
  $("#ecopy").addEventListener("click", ()=>copyText(link, $("#ecopy")));
  bindQRShare($("#eqr"), link);
  bindMatterPhaseUI(box.querySelector(".matter-phase-timeline") || box);
  announce(t("meta_matter_timeline_announce",{n:eventCount}));
  if(isCurrentRender() && (globalThis.routeFocusKey?.()||location.hash||`${location.pathname}${location.search}`)===routeKeyAtStart){
    focusItemRouteTarget(box.querySelector(".route-item"));
    applyActiveHistoryRouteScroll();
  }
}

// Publish live bindings for neighboring modules and legacy inline handlers.
globalThis.INVKEY = INVKEY;
globalThis.INV_HREF = INV_HREF;
globalThis.PINTYPE_KEY = PINTYPE_KEY;
globalThis.bindMatterPhaseUI = bindMatterPhaseUI;
globalThis.ensureMatterPhaseSpineTools = ensureMatterPhaseSpineTools;
globalThis.invCsv = invCsv;
globalThis.invDefaultStore = invDefaultStore;
globalThis.invDownload = invDownload;
globalThis.invItemHref = invItemHref;
globalThis.invItemKey = invItemKey;
globalThis.invItemsHtml = invItemsHtml;
globalThis.invMergeItems = invMergeItems;
globalThis.invMergeStores = invMergeStores;
globalThis.invPullAndMerge = invPullAndMerge;
globalThis.invPushServer = invPushServer;
globalThis.invSave = invSave;
globalThis.invScheduleServerSave = invScheduleServerSave;
globalThis.invStore = invStore;
globalThis.matterChronoRowHTML = matterChronoRowHTML;
globalThis.matterMilestoneMeta = matterMilestoneMeta;
globalThis.matterMilestoneTitle = matterMilestoneTitle;
globalThis.matterPhaseActionHTML = matterPhaseActionHTML;
globalThis.matterPhaseAggregateHTML = matterPhaseAggregateHTML;
globalThis.matterPhaseLabel = matterPhaseLabel;
globalThis.matterPhasePanelHTML = matterPhasePanelHTML;
globalThis.matterPhaseStepperHTML = matterPhaseStepperHTML;
globalThis.matterPhaseTimelineHTML = matterPhaseTimelineHTML;
globalThis.matterTimelineHTMLFlat = matterTimelineHTMLFlat;
globalThis.pinBtn = pinBtn;
globalThis.showInvestigation = showInvestigation;
globalThis.showMatter = showMatter;
globalThis.showSharedInv = showSharedInv;
Object.defineProperty(globalThis, "invServerHydrated", { configurable: true, get: () => invServerHydrated, set: value => { invServerHydrated = value; } });
Object.defineProperty(globalThis, "invSessionRecognized", { configurable: true, get: () => invSessionRecognized, set: value => { invSessionRecognized = value; } });
Object.defineProperty(globalThis, "invSyncTimer", { configurable: true, get: () => invSyncTimer, set: value => { invSyncTimer = value; } });
Object.defineProperty(globalThis, "matterPhaseSpineToolsPromise", { configurable: true, get: () => matterPhaseSpineToolsPromise, set: value => { matterPhaseSpineToolsPromise = value; } });
