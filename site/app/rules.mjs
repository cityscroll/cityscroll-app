/* ===== Rules explorer: process-stage rail + multi-notice rulemaking collapse.
   Pure model: site/rules_explorer.mjs (same list-ontology pattern as property_explorer).
   Detail timeline remains site/rules_phase_spine.mjs. ===== */
let rulesAll=[], rulesViewCache=null, rulesProcessSel="all";
let rulesExplorerToolsPromise=null;
function rulesExplorerTools(){
  if(!rulesExplorerToolsPromise){
    rulesExplorerToolsPromise=import("../rules_explorer.mjs").catch(()=>null);
  }
  return rulesExplorerToolsPromise;
}
const RULES_PHASE_IDS=["proposal","public_process","adoption","effective"];
const RULE_COMMENT_FACT_KEY="comment-deadline";
const RULE_HEARING_FACT_KEY="hearing-date";
const RULES_PHASE_LABEL_KEYS={
  proposal:"rule_phase_proposal",
  public_process:"rule_phase_public_process",
  adoption:"rule_phase_adoption",
  effective:"rule_phase_effective",
};
function rulesProcessPhaseLabel(phase){
  if(!phase) return t("rule_stage_unstaged");
  return RULES_PHASE_LABEL_KEYS[phase]?t(RULES_PHASE_LABEL_KEYS[phase]):phase;
}
function rulesExplorerCardHTML(entry, terms){
  const r=entry.primary;
  if(!r) return "";
  const processStage=entry.process_stage;
  const processLabel=rulesProcessPhaseLabel(processStage);
  const fineStage=entry.fine_stage||null;
  const title=entry.title||cleanText(r.short_title)||"";
  const mev=matchEvidence(title, matchText(r), terms);
  const noticeHref=`#notice/${encodeURIComponent(r.request_id)}`;
  const agency=entry.agency||r.agency_name||"";
  const scopeHtml=excerptHtml(entry.excerpt||r.additional_description_1,200);
  const chainChip=entry.notice_count>1
    ? `<span class="tag asset">${escUiHtml(t("rules_chain_notice_count",{n:String(entry.notice_count)}))}</span>`
    : "";
  const processLine=`<div class="rules-process-line">
    <span class="tag open" data-card-fact="stage:${escUiHtml(processStage||"unstaged")}">${escUiHtml(processLabel)}</span>
    ${chainChip}
    ${agency?`<span class="tag place">${pivotA(agencyHref(agency), agency)}</span>`:`<span class="tag place">${escUiHtml(t("rules_list_no_agency"))}</span>`}
  </div>`;
  // Next-action lead: concrete comment / hearing when data supports it; honest open-notice otherwise.
  const actionKey=entry.action_key||"rule_action_open_notice";
  let actionLeadText=t(actionKey);
  if(actionKey==="rule_action_comment" && entry.comment_by_date){
    actionLeadText=t("rule_comment_btn",{date:ruleDateLabel(entry.comment_by_date)});
  } else if(actionKey==="rule_action_attend_hearing" && entry.hearing_date){
    actionLeadText=t("rule_action_attend_hearing_dated",{date:ruleDateLabel(entry.hearing_date)});
  }
  const primaryFact=actionKey==="rule_action_comment"&&entry.comment_by_date
    ? `${RULE_COMMENT_FACT_KEY}:${entry.comment_by_date}`
    : actionKey==="rule_action_attend_hearing"&&entry.hearing_date
      ? `${RULE_HEARING_FACT_KEY}:${entry.hearing_date}`
      : "";
  const primaryFactAttr=primaryFact?` data-card-fact="${escUiHtml(primaryFact)}"`:"";
  // Primary kinetic destination: comment portal while open; else official rule page; else notice.
  // Separate template branches so link_targets can classify each href expression (never mix
  // in-app #notice with external NYC Rules into one ${escUiHtml(primaryHref)} slot).
  const wantCommentPrimary=fineStage==="comment-open" && !!(entry.comment_url||entry.rule_url);
  const wantRulePrimary=!wantCommentPrimary && !!entry.rule_url && (
    fineStage==="hearing"
    || processStage==="public_process"
    || fineStage==="adopted"
    || fineStage==="effective"
    || processStage==="adoption"
    || processStage==="effective"
    || processStage==="proposal"
  );
  let acts="";
  if(wantCommentPrimary && entry.comment_url){
    acts=`<a class="act primary"${primaryFactAttr} href="${escUiHtml(entry.comment_url)}" ${EXT_ATTRS}>${escUiHtml(actionLeadText)}${extSR()}</a>`;
  } else if(wantCommentPrimary && entry.rule_url){
    acts=`<a class="act primary"${primaryFactAttr} href="${escUiHtml(entry.rule_url)}" ${EXT_ATTRS}>${escUiHtml(actionLeadText)}${extSR()}</a>`;
  } else if(wantRulePrimary){
    acts=`<a class="act primary"${primaryFactAttr} href="${escUiHtml(entry.rule_url)}" ${EXT_ATTRS}>${escUiHtml(actionLeadText)}${extSR()}</a>`;
  } else {
    acts=`<a class="act primary"${primaryFactAttr} href="${noticeHref}">${escUiHtml(actionLeadText)}</a>`;
  }
  const primaryAction=acts;
  const secondaryActions=[`<a class="act" href="${REQ_URL(r.request_id)}" ${EXT_ATTRS}>${t("city_record_link")}${extSR()}</a>`];
  if(agency) secondaryActions.push(`<a class="act" href="${agencyHref(agency)}">${t("rules_action_agency_profile")}</a>`);
  // Secondary official rule page when primary was the comment portal (not already the rule URL).
  if(entry.rule_url && !(wantRulePrimary || (wantCommentPrimary && !entry.comment_url))){
    secondaryActions.push(`<a class="act" href="${escUiHtml(entry.rule_url)}" ${EXT_ATTRS}>${t("rule_event_official_source")}${extSR()}</a>`);
  }
  secondaryActions.push(`<button class="act" type="button" data-link="${r.request_id}">${t("copy_link_btn")}</button>`);
  const ev=r.event_date;
  if(ev) secondaryActions.push(`<button class="act" type="button" data-ev="rules:${r.request_id}">${t("add_date_btn",{date:fdt(ev)})}</button>`);
  // Sibling notices for multi-notice rulemakings (entity links across City Record rows).
  let siblingsHtml="";
  if(entry.kind==="rulemaking" && (entry.sibling_notices||[]).length>1){
    const chips=(entry.sibling_notices||[]).slice(0,6).map(sib=>{
      const id=sib.request_id;
      if(!id) return "";
      const roleLabel=sib.role_label_key?t(sib.role_label_key):(sib.role||"");
      const href=`#notice/${encodeURIComponent(id)}`;
      const selfMark=sib.is_self?` aria-current="true"`:"";
      return `<a href="${href}"${selfMark}>${escUiHtml(roleLabel||id)}</a>`;
    }).filter(Boolean).join(" · ");
    if(chips) siblingsHtml=`<div class="rules-siblings">${t("rules_siblings_label")}: ${chips}</div>`;
  }
  return `<div class="fcard rules-fcard" data-request-id="${escUiHtml(r.request_id||"")}" data-rulemaking-kind="${escUiHtml(entry.kind||"notice")}" data-process-stage="${escUiHtml(processStage||"unstaged")}">
      <div class="ftype">${r.type_of_notice_description||""}${agency?" · "+pivotA(agencyHref(agency), agency):""}${ev?` · <b style="color:var(--ink)">${fdt(ev)}</b>${eventTag(ev)}`:""}</div>
      ${processLine}
      <div class="ftitle"><a href="${noticeHref}">${title ? digTitleHTML(title, mev) : t("untitled")}</a></div>
      ${siblingsHtml}
      ${rulePlaceChips(r._ruleLocation)}
      ${scopeHtml?`<div class="fscope">${scopeHtml}</div>`:""}
      ${digEvidenceHTML(mev)}
      <div class="factions">${compactCardActions(primaryAction, secondaryActions)}</div>
    </div>`;
}
let rulesActionBandToolsPromise=null;
function rulesActionBandTools(){
  if(!rulesActionBandToolsPromise){
    rulesActionBandToolsPromise=import("../rules_action_bands.mjs").catch(()=>null);
  }
  return rulesActionBandToolsPromise;
}

function rulesProcessControlHTML(model){
  if(!model) return "";
  const button=(item,cls)=>`<button type="button" class="${cls}${item.pressed?" on":""}" data-rules-process="${escUiHtml(item.id)}" aria-pressed="${item.pressed?"true":"false"}">${escUiHtml(t(item.label_key))}<span class="ct">${item.count}</span></button>`;
  const lifecycle=model.lifecycle.map((item,index)=>`<li>${button(item,["lc-step","rules-stage-filter"].join(" "))}${index<model.lifecycle.length-1?'<span class="lc-step-arrow" aria-hidden="true">→</span>':""}</li>`).join("");
  return `<div class="rules-stage-control">
    ${button(model.all,["chip","rules-stage-all"].join(" "))}
    <ol class="lc-stepper rules-stage-lifecycle">${lifecycle}</ol>
    ${model.unstaged?`<span class="rules-stage-divider" aria-hidden="true">·</span>${button(model.unstaged,["chip","rules-stage-unmatched"].join(" "))}`:""}
  </div>`;
}

async function renderRulesExplorer(){
  const tools=await rulesExplorerTools();
  const bandTools=await rulesActionBandTools();
  const processRail=$("#rulesprocessrail");
  const agency=$("#rulesagency")?.value||"";
  const kw=($("#ruleskw")?.value||"").trim();
  let entries=[];
  if(tools && tools.buildRulesExplorerEntries){
    entries=tools.buildRulesExplorerEntries(rulesAll, rulesViewCache);
    const rulesPlace=$("#rulesboro")?.value||"";
    entries=tools.filterRulesExplorerEntries(entries,{
      process: rulesProcessSel,
      agency: agency||null,
      keyword: kw||null,
      borough: rulesPlace && rulesPlace!=="citywide" ? rulesPlace : null,
      locationScope: rulesPlace==="citywide" ? "citywide" : null,
      matchText,
    });
    const base=tools.buildRulesExplorerEntries(rulesAll, rulesViewCache);
    const pc=tools.countRulesProcessStages(base);
    if(processRail){
      const model=tools.rulesProcessControlModel
        ? tools.rulesProcessControlModel(pc,rulesProcessSel)
        : null;
      processRail.innerHTML=rulesProcessControlHTML(model);
      processRail.querySelectorAll("[data-rules-process]").forEach(b=>b.addEventListener("click",()=>{
        rulesProcessSel=b.dataset.rulesProcess;
        renderRulesExplorer();
        updateHash();
        renderSearchComponents("rules");
      }));
    }
  } else {
    // Fallback: flat notice list if the explorer module fails to load.
    if(processRail) processRail.innerHTML="";
    entries=rulesAll
      .filter(r=>(!agency||r.agency_name===agency)
        && (!kw||matchText(r).toLowerCase().includes(kw.toLowerCase())))
      .map(r=>({
        kind:"notice",
        primary:r,
        members:[r],
        notice_count:1,
        process_stage:null,
        process_filter:"unstaged",
        fine_stage:r._ruleStage?.stage||null,
        action_key:"rule_action_open_notice",
        agency:r.agency_name||null,
        title:cleanText(r.short_title),
        matched_phases:[],
        rule_url:r._ruleStage?.nyc_rules?.url||null,
        comment_url:r._ruleStage?.nyc_rules?.comment_url||null,
        comment_by_date:r._ruleStage?.nyc_rules?.comment_by_date||null,
        hearing_date:r._ruleStage?.nyc_rules?.hearing_date||null,
        sibling_notices:[],
      }));
  }

  announce(t("rules_entries_announce",{n:entries.length}));
  setExportBandVisibility(entries.length, "rules-export-band", "rules-export-overflow");
  const feedEl=$("#rulesfeed");
  if(!feedEl) return;
  const terms=kw?[kw]:[];
  const visibleRows=entries.map(e=>e.primary).filter(Boolean);
  feedVisible.rules=visibleRows;
  // Keep feedRows populated for ICS / copy handlers.
  feedRows.rules={};
  for(const e of entries){
    for(const m of e.members||[e.primary]){
      if(m?.request_id) feedRows.rules[m.request_id]=m;
    }
  }
  if(!entries.length){
    feedEl.innerHTML='<div class="empty">' + t("nothing_found_feed") + '</div>';
    return;
  }
  // Action-banded grouping: comment open / hearing / adopted / other — not date-only buckets.
  let html="";
  if(bandTools && typeof bandTools.groupEntriesByActionBand==="function"){
    const groups=bandTools.groupEntriesByActionBand(entries,{ now: todayISO() });
    for(const g of groups){
      const label=typeof bandTools.rulesActionBandLabel==="function"
        ? bandTools.rulesActionBandLabel({
            band_id:g.band_id,
            days_left:g.days_left,
            hearing_date:g.hearing_date,
            effective_date:g.effective_date,
          }, (key, vars)=>t(key, vars))
        : t(g.label_key);
      html+=`<div class="rules-action-band" data-band="${escUiHtml(g.band_id)}" role="heading" aria-level="3">${escUiHtml(label)}<span class="band-count">${escUiHtml(t("rule_band_count",{n:String(g.count)}))}</span></div>`;
      html+=g.entries.map(e=>rulesExplorerCardHTML(e, terms)).join("");
    }
  } else {
    html=entries.map(e=>rulesExplorerCardHTML(e, terms)).join("");
  }
  feedEl.innerHTML=html;
  feedEl.querySelectorAll("[data-link]").forEach(b=>b.addEventListener("click",()=>copyText(noticeLink(b.dataset.link), b)));
  feedEl.querySelectorAll("[data-ev]").forEach(b=>b.addEventListener("click",()=>{ const i=b.dataset.ev.indexOf(":"); downloadEventICS(feedRows[b.dataset.ev.slice(0,i)][b.dataset.ev.slice(i+1)]); }));
}

// Rule-lifecycle status chip for the Rules lens. Consumes the precomputed stage from the
// /rules read model (r._ruleStage, joined by request_id in loadSection). Comment-open is
// the actionable moment: it reuses the site's hot/soon/open urgency ladder and links the
// official comment page; settled stages read as quiet ink (color is reserved for what
// needs acting on). Returns "" when there is no stage — the row still shows as a City
// Record notice, never a hollow chip.
const RULE_STAGE_CFG = {
  "proposed":       { key: "rule_stage_proposed",       cls: "asset",  dateField: null },
  "comment-open":   { key: "rule_stage_comment_open",   cls: "urgency",dateField: "comment_by_date" },
  "comment-closed": { key: "rule_stage_comment_closed", cls: "closed", dateField: null },
  "hearing":        { key: "rule_stage_hearing",        cls: "open",   dateField: "hearing_date" },
  "adopted":        { key: "rule_stage_adopted",        cls: "asset",  dateField: "adoption_published_at" },
  "effective":      { key: "rule_stage_effective",      cls: "asset",  dateField: "effective_date" },
  "unknown":        { key: "rule_stage_unknown",        cls: "closed", dateField: null },
};
// The read model classifies stage at materialization time; correct the single most
// time-sensitive case (comment-open whose deadline has actually passed) against the user's
// clock so the chip and the comment action never invite a comment on a closed period.
function ruleDisplayStage(rec){
  if(rec && rec.stage==="comment-open" && rec.nyc_rules && rec.nyc_rules.comment_by_date
     && daysLeft(rec.nyc_rules.comment_by_date) < 0) return "comment-closed";
  return rec ? rec.stage : null;
}
function ruleDateLabel(value){
  if(!value) return "";
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value)) return fdt(value);
  const _lm=(window.LANG_META||{})[window.LANG||"en"];
  const _loc=_lm?_lm.intlDate:"en-US";
  return new Date(`${value}T12:00:00Z`).toLocaleDateString(_loc,{year:"numeric",month:"long",day:"numeric",timeZone:"UTC"});
}
function ruleStageChip(rec){
  if(!rec) return "";
  const stage=ruleDisplayStage(rec);
  const cfg=RULE_STAGE_CFG[stage] || RULE_STAGE_CFG.unknown;
  const nr=rec.nyc_rules||null;
  let cls=cfg.cls;
  if(cls==="urgency"){
    const dl=nr?daysLeft(nr[cfg.dateField]):null;
    cls=(dl!==null && dl>=0 && dl<=3)?"hot":(dl!==null && dl>=0 && dl<=14)?"soon":"open";
  }
  const dateVal=(cfg.dateField && nr && nr[cfg.dateField])?nr[cfg.dateField]:null;
  const label=dateVal?t(cfg.key,{date:ruleDateLabel(dateVal)}):t(cfg.key);
  // Official page: comment page while comments are open, the rule/adoption record otherwise.
  const href=nr?(stage==="comment-open"?(nr.comment_url||nr.url||null):(nr.url||null)):null;
  return href
    ? `<a class="tag ${cls}" href="${escUiHtml(href)}" ${EXT_ATTRS}>${label}${extSR()}</a>`
    : `<span class="tag ${cls}">${label}</span>`;
}
// Primary call-to-action for comment-open rules: links the official comment page with the
// deadline up front. Mirrors the site's contextual action-button emphasis (join_online etc.).
function ruleCommentAction(rec){
  if(ruleDisplayStage(rec)!=="comment-open") return "";
  const nr=rec && rec.nyc_rules;
  if(!nr || !nr.comment_by_date) return "";
  const href=nr.comment_url||nr.url;
  if(!href) return "";
  const factKey=["comment","deadline"].join("-");
  return `<a class="act" data-card-fact="${factKey}:${escUiHtml(String(nr.comment_by_date).slice(0,10))}" href="${escUiHtml(href)}" ${EXT_ATTRS}>${t("rule_comment_btn",{date:ruleDateLabel(nr.comment_by_date)})}${extSR()}</a>`;
}

const RULES_PUBLIC_URL="https://rules.cityofnewyork.us/";
const RULE_EVENT_CFG={
  "proposal_published":{label:"rule_event_proposal",dateLabel:"rule_event_published_on_html"},
  "public_hearing":{label:"rule_event_hearing",dateLabel:"rule_event_scheduled_for_html"},
  "comment_close":{label:"rule_event_comment_close",dateLabel:"rule_event_due_on_html"},
  "adoption":{label:"rule_event_adoption",dateLabel:"rule_event_recorded_on_html"},
  "effective":{label:"rule_event_effective",dateLabel:"rule_event_starts_on_html"},
};

/* Rules phase spine (proposal → public process → adoption → effective). Pure model:
   site/rules_phase_spine.mjs — same lead → stepper → panels shape as land/procurement. */
let rulesPhaseSpineToolsPromise=null;
function ensureRulesPhaseSpineTools(){
  if(!rulesPhaseSpineToolsPromise){
    rulesPhaseSpineToolsPromise=import("../rules_phase_spine.mjs").catch(()=>null);
  }
  return rulesPhaseSpineToolsPromise;
}

function rulePhaseLabel(phase){
  if(!phase) return "—";
  if(phase.label_key) return t(phase.label_key);
  if(typeof phase==="string"){
    const meta={
      proposal:"rule_phase_proposal",
      public_process:"rule_phase_public_process",
      adoption:"rule_phase_adoption",
      effective:"rule_phase_effective"
    };
    return meta[phase]?t(meta[phase]):phase;
  }
  return phase.short || "—";
}

function ruleEventCardHTML(type, event, rec, opts){
  const cfg=RULE_EVENT_CFG[type];
  if(!cfg) return "";
  opts=opts||{};
  const nr=rec&&rec.nyc_rules;
  if(!event){
    const linked=!!nr || opts.joined;
    const gap=linked
      ? t("rule_event_not_published_html",{event:t(cfg.label)})
      : t("rule_event_not_yet_ingested_html",{event:t(cfg.label),source:`<span lang="en" dir="ltr">${t("rule_source_nyc_rules")}</span>`});
    return `<div class="stage"><div class="box ${linked?"unmatched":"unknown"}">
      <div class="stage-name">${t(cfg.label)}</div>
      <div class="lc-norecord">${gap}</div>
    </div></div>`;
  }
  const eventDate=event.valid_at||event.published_at;
  const scheduled=event.status==="scheduled";
  const boxClass=scheduled?"matched":"passed";
  // One outbound source family per phase: only the designated phase link renders.
  // Hrefs use ${escUiHtml(official)} / ${escUiHtml(href)} so link_targets classifies them external.
  const showSource=opts.showSourceLink!==false;
  const fromNr=nr?(type==="comment_close"?(nr.comment_url||nr.url):nr.url):null;
  const official=fromNr||opts.phaseSourceUrl||null;
  const sourceLink=showSource&&official
    ? `<a class="view" href="${escUiHtml(official)}" ${EXT_ATTRS}>${t("rule_event_official_source")}${extSR()}</a>`
    : "";
  const href=nr?(nr.comment_url||nr.url):official;
  const commentAction=type==="comment_close"&&scheduled&&href
    ? `<a class="act primary" href="${escUiHtml(href)}" ${EXT_ATTRS}>${t("rule_comment_btn",{date:ruleDateLabel(event.valid_at)})}${extSR()}</a>`
    : "";
  const calendarAction=type==="comment_close"
    ? `<button class="act" type="button" data-rule-event="comment_close">${t("add_date_btn",{date:ruleDateLabel(event.valid_at)})}</button>`
    : "";
  return `<div class="stage"><div class="box ${boxClass}">
    <div class="stage-name">${t(cfg.label)}</div>
    <div class="when">${eventDate?t(cfg.dateLabel,{date:ruleDateLabel(eventDate)}):"—"}</div>
    ${sourceLink}
    ${commentAction||calendarAction?`<div class="actions" style="margin:6px 0 0">${commentAction}${calendarAction}</div>`:""}
  </div></div>`;
}

function rulePhaseAggregateHTML(agg){
  if(!agg || agg.count<=1) return "";
  const title=agg.label_key?t(agg.label_key):escUiHtml(agg.title||"—");
  const range=agg.first&&agg.last&&agg.first!==agg.last
    ? t("rule_phase_aggregate_range",{first:ruleDateLabel(agg.first),last:ruleDateLabel(agg.last)})
    : (agg.first?ruleDateLabel(agg.first):"");
  return `<div class="lc-phase-agg">
    <div class="lc-phase-agg-title">${title}<span class="lc-phase-count">×${agg.count}</span></div>
    <div class="lc-phase-agg-meta">${range||"—"}</div>
  </div>`;
}

function rulePhasePanelHTML(phase, rec, view){
  if(!phase) return "";
  // Future empty phases: stepper chips only (no gap-card clutter).
  if(phase.state==="future" && !phase.event_count) return "";
  // Passed empty: omit (later stages already mark progress).
  if(phase.state==="passed" && !phase.event_count) return "";

  const open=phase.state==="current"?" open":"";
  const stateWord=phase.state==="current"
    ? t("rule_phase_current")
    : phase.state==="passed"
      ? t("rule_phase_done")
      : t("rule_phase_future");
  let summary="";
  if(phase.event_count){
    const parts=[
      t("rule_phase_milestones_count",{n:String(phase.event_count)}),
      phase.first&&phase.last&&phase.first!==phase.last
        ? t("rule_phase_aggregate_range",{first:ruleDateLabel(phase.first),last:ruleDateLabel(phase.last)})
        : (phase.first?ruleDateLabel(phase.first):""),
    ].filter(Boolean);
    summary=parts.join(" · ");
  }else{
    summary=t("rule_phase_empty");
  }

  let body="";
  const multiAggs=(phase.aggregates||[]).filter(a=>a.count>=2);
  if(multiAggs.length) body+=multiAggs.map(rulePhaseAggregateHTML).join("");

  // Material events as stage cards; one source link on the whole phase (deduped).
  const material=phase.events||[];
  let stages="";
  material.forEach((event, idx)=>{
    const isLink=phase.state==="current" && idx===material.length-1;
    const html=ruleEventCardHTML(event.event_type, event, rec, {
      showSourceLink:isLink,
      phaseSourceUrl:phase.source_url||view.official_url,
      joined:view.joined
    });
    if(html){
      stages+=html;
      if(idx<material.length-1) stages+='<div class="connector">→</div>';
    }
  });
  // Current phase with missing event types: show class-(a)/(b) gap slots so readers
  // still see which official dates have not been published (not invented stages).
  if(phase.state==="current" && (phase.missing_types||[]).length){
    (phase.missing_types||[]).forEach(type=>{
      const gap=ruleEventCardHTML(type, null, rec, {joined:view.joined, showSourceLink:false});
      if(gap){
        if(stages) stages+='<div class="connector">→</div>';
        stages+=gap;
      }
    });
  }
  if(stages) body+=`<div class="lc-stage-detail"><div class="chain rule-chain rule-phase-cards">${stages}</div></div>`;
  if(!body) body=`<div class="lc-phase-summary">${t("rule_phase_empty")}</div>`;

  return `<details class="lc-phase${phase.state==="current"?" current-phase":""}"${open} id="rule-phase-${escUiHtml(phase.id)}" data-rule-phase-panel="${escUiHtml(phase.id)}">
    <summary>
      <span class="lc-phase-name">${escUiHtml(rulePhaseLabel(phase))}</span>
      <span class="lc-phase-state">${escUiHtml(stateWord)}</span>
      <span class="lc-phase-summary">${escUiHtml(summary)}</span>
    </summary>
    <div class="lc-phase-body">${body}</div>
  </details>`;
}

function rulePhaseStepperHTML(view){
  if(!view || !view.phases || !view.phases.length) return "";
  const items=view.phases.map((p,i)=>{
    const cls=p.state==="current"?"current":p.state==="passed"?"passed":"future";
    const aria=p.state==="current"?` aria-current="step"`:"";
    const arrow=i<view.phases.length-1
      ? `<span class="lc-step-arrow" aria-hidden="true">→</span>`
      : "";
    return `<li><button type="button" class="lc-step ${cls}" data-rule-phase="${escUiHtml(p.id)}"${aria} title="${escUiHtml(rulePhaseLabel(p))}">${escUiHtml(p.short||rulePhaseLabel(p))}</button>${arrow}</li>`;
  }).join("");
  return `<ol class="lc-stepper lc-phase-stepper rule-phase-stepper" aria-label="${escUiHtml(t("rule_lifecycle_heading"))}">${items}</ol>`;
}

function rulePhaseLeadHTML(view, rec){
  if(!view || !view.current) return "";
  const cur=view.current;
  const phaseName=rulePhaseLabel({label_key:cur.label_key});
  const milestone=cur.milestone_label_key?t(cur.milestone_label_key):(cur.milestone_event_type||"—");
  let actionHTML="";
  const nr=rec&&rec.nyc_rules;
  if(cur.lead_action==="comment" && (view.comment_url||nr?.comment_url||nr?.url)){
    const href=view.comment_url||nr.comment_url||nr.url;
    const date=cur.since||nr?.comment_by_date;
    actionHTML=`<a class="act primary" href="${escUiHtml(href)}" ${EXT_ATTRS}>${t("rule_comment_btn",{date:ruleDateLabel(date)})}${extSR()}</a>`
      + (date?` <button class="act" type="button" data-rule-event="comment_close">${t("add_date_btn",{date:ruleDateLabel(date)})}</button>`:"");
  }else if(cur.lead_action==="hearing" && (view.official_url||nr?.url)){
    const official=view.official_url||nr.url;
    actionHTML=`<a class="act" href="${escUiHtml(official)}" ${EXT_ATTRS}>${t("rule_phase_action_attend_hearing")}${extSR()}</a>`;
  }else if(view.official_url||nr?.url){
    const official=view.official_url||nr.url;
    actionHTML=`<a class="act" href="${escUiHtml(official)}" ${EXT_ATTRS}>${t("rule_event_official_source")}${extSR()}</a>`;
  }else{
    actionHTML=t(cur.action_key||"rule_phase_action_proposal");
  }
  return `<div class="lc-phase-lead rule-spine-lead">
    <div class="lc-phase-now-label">${t("rule_phase_now_label")}</div>
    <p class="lc-phase-now-phase">${escUiHtml(phaseName)}</p>
    <p class="lc-phase-now-detail">${escUiHtml(milestone)}${cur.since?` · ${t("rule_phase_since",{date:ruleDateLabel(cur.since)})}`:""}</p>
    ${actionHTML?`<p class="lc-phase-action">${actionHTML}</p>`:""}
    ${view.next?`<p class="lc-phase-next">${t("rule_phase_next_html",{phase:escUiHtml(rulePhaseLabel(view.next))})}</p>`:""}
  </div>`;
}

function ruleSiblingRoleLabel(sib){
  if(!sib) return "";
  if(sib.role_label_key) return t(sib.role_label_key);
  const role=String(sib.role||"");
  if(role==="proposal") return t("rule_sibling_role_proposal");
  if(role==="hearing") return t("rule_sibling_role_hearing");
  if(role==="adoption") return t("rule_sibling_role_adoption");
  return t("rule_sibling_role_notice");
}

/** Sibling City Record notices for one high-confidence multi-notice rulemaking. */
function ruleSiblingsHTML(view){
  if(!view || !view.multi_notice || !(view.sibling_notices||[]).length) return "";
  const items=(view.sibling_notices||[]).filter(s=>s&&s.request_id).map(sib=>{
    const role=escUiHtml(ruleSiblingRoleLabel(sib));
    const date=sib.notice_date?ruleDateLabel(sib.notice_date):(sib.event_date?ruleDateLabel(sib.event_date):"");
    const title=sib.title?escUiHtml(cleanText(sib.title)):escUiHtml(sib.request_id);
    const selfMark=sib.is_self?` <span class="muted">(${t("rule_sibling_this_notice")})</span>`:"";
    const href=`#notice/${encodeURIComponent(sib.request_id)}`;
    return `<li class="rule-sibling${sib.is_self?" is-self":""}">
      <a href="${href}">${title}</a>
      <span class="rule-sibling-meta">${role}${date?` · ${escUiHtml(date)}`:""}${selfMark}</span>
    </li>`;
  }).join("");
  if(!items) return "";
  const n=String(view.notice_count||view.sibling_notices.length);
  return `<div class="rule-siblings" data-rule-siblings="1" role="group" aria-label="${escUiHtml(t("rule_siblings_heading"))}">
    <div class="rule-siblings-h">${t("rule_siblings_heading")}</div>
    <p class="rule-siblings-lead note">${t("rule_siblings_count",{n})}</p>
    <ul class="rule-siblings-list">${items}</ul>
  </div>`;
}

function ruleAdoptionEstimateHTML(estimate){
  if(!estimate||!estimate.pattern_line) return "";
  const chip=`<span class="tag renewal">${escUiHtml(t("cadence_estimate_tag"))}</span>`;
  let window="";
  if(estimate.predicted_window&&estimate.pattern?.projection==="per_matter"){
    const w=estimate.predicted_window;
    if(w.p10&&w.p50&&w.p90){
      window=`<p class="rule-adoption-estimate-window">${escUiHtml(t("rule_adoption_estimate_window",{p10:w.p10,p50:w.p50,p90:w.p90}))}</p>`;
    }
  }
  return `<div class="rule-adoption-estimate" data-rule-adoption-estimate="1" data-ghost="1" role="note">
    <p class="rule-adoption-estimate-line">${escUiHtml(estimate.pattern_line)} ${chip}</p>
    ${window}
  </div>`;
}

function ruleEventSpineHTMLPhase(view, rec){
  if(!view) return "";
  const lead=rulePhaseLeadHTML(view, rec);
  const siblings=ruleSiblingsHTML(view);
  const stepper=rulePhaseStepperHTML(view);
  const estimate=ruleAdoptionEstimateHTML(view.adoption_lag_estimate||null);
  const currentPanel=(view.phases||[]).filter(p=>p.state==="current")
    .map(p=>rulePhasePanelHTML(p, rec, view)).join("");
  const historyPanels=(view.phases||[]).filter(p=>p.state==="passed")
    .map(p=>rulePhasePanelHTML(p, rec, view)).filter(Boolean).join("");
  const futurePanels=(view.phases||[]).filter(p=>p.state==="future"&&p.event_count)
    .map(p=>rulePhasePanelHTML(p, rec, view)).join("");
  const historyWrap=historyPanels
    ? `<details class="lc-phase-history"><summary>${t("rule_phase_show_history")}</summary>${historyPanels}</details>`
    : "";
  const joined=view.joined;
  const official=joined?(view.official_url||RULES_PUBLIC_URL):RULES_PUBLIC_URL;
  const provenance=joined
    ? t("rule_event_provenance_html",{source:`<a href="${escUiHtml(official)}" ${EXT_ATTRS}><span lang="en" dir="ltr">${t("rule_source_nyc_rules")}</span>${extSR()}</a>`})
    : t("rule_event_join_gap_html",{source:`<a href="${RULES_PUBLIC_URL}" ${EXT_ATTRS}><span lang="en" dir="ltr">${t("rule_source_nyc_rules")}</span>${extSR()}</a>`});
  const howBody=view.multi_notice?t("rule_phase_how_multi_html"):t("rule_phase_how_html");
  const how=`<details class="inline-disclose lc-how"><summary>${t("rule_phase_how_summary")}</summary><div class="inline-disclose-body">${howBody}</div></details>`;
  // Ghost estimate sits after comment_close context (stepper + current public-process
  // panel), before future adoption phase panels — never as an event card/dot.
  return `<div class="chain-h">${t("rule_lifecycle_heading")}</div>
    ${lead}
    ${siblings}
    ${stepper}
    ${currentPanel}
    ${estimate}
    ${futurePanels}
    ${historyWrap}
    ${how}
    <div class="note">${provenance}</div>`;
}

/** Flat fallback if the phase module fails to load — still renders all five event cards. */
function ruleEventSpineHTMLFlat(rec){
  const events=new Map((rec&&Array.isArray(rec.events)?rec.events:[]).map(event=>[event.event_type,event]));
  const types=Object.keys(RULE_EVENT_CFG);
  const cards=types.map(type=>ruleEventCardHTML(type,events.get(type)||null,rec,{showSourceLink:true,joined:!!(rec&&rec.nyc_rules)}));
  const joined=!!(rec&&rec.nyc_rules);
  const official=joined?(rec.nyc_rules.url||RULES_PUBLIC_URL):RULES_PUBLIC_URL;
  const provenance=joined
    ? t("rule_event_provenance_html",{source:`<a href="${escUiHtml(official)}" ${EXT_ATTRS}><span lang="en" dir="ltr">${t("rule_source_nyc_rules")}</span>${extSR()}</a>`})
    : t("rule_event_join_gap_html",{source:`<a href="${RULES_PUBLIC_URL}" ${EXT_ATTRS}><span lang="en" dir="ltr">${t("rule_source_nyc_rules")}</span>${extSR()}</a>`});
  return `<div class="chain-h">${t("rule_lifecycle_heading")}</div>
    <div class="chain rule-chain">${cards.join('<div class="connector">→</div>')}</div>
    <div class="note">${provenance}</div>`;
}

let rulesAdoptionLagModelPromise=null;
function loadRulesAdoptionLagModel(){
  if(!rulesAdoptionLagModelPromise){
    rulesAdoptionLagModelPromise=fetch("./data/rules_adoption_lag_model.json")
      .then(r=>r.ok?r.json():null)
      .catch(()=>null);
  }
  return rulesAdoptionLagModelPromise;
}

function ruleEventSpineHTML(rec, phaseTools, recordsById, adoptionModel){
  if(phaseTools && typeof phaseTools.buildRulesPhaseView==="function"){
    let view=phaseTools.buildRulesPhaseView(rec||{},{recordsById:recordsById||null});
    // Prefer stitched record for nyc_rules / stage when multi-notice merge ran.
    const paintRec=(view&&view.stitched&&phaseTools.stitchRulemakingRecord)
      ? phaseTools.stitchRulemakingRecord(rec||{}, recordsById||null)
      : rec;
    if(adoptionModel && typeof phaseTools.attachAdoptionLagEstimate==="function"){
      view=phaseTools.attachAdoptionLagEstimate(view, paintRec||rec, adoptionModel);
    }else if(adoptionModel && window.__rulesAdoptionLagAttach){
      view=window.__rulesAdoptionLagAttach(view, paintRec||rec, adoptionModel);
    }
    return ruleEventSpineHTMLPhase(view, paintRec||rec);
  }
  return ruleEventSpineHTMLFlat(rec);
}

function bindRulesPhaseUI(root){
  if(!root || root.dataset.rulePhaseBound==="1") return;
  root.dataset.rulePhaseBound="1";
  root.addEventListener("click",(ev)=>{
    const step=ev.target.closest?.("[data-rule-phase]");
    if(step && root.contains(step)){
      const id=step.getAttribute("data-rule-phase");
      const panel=root.querySelector(`[data-rule-phase-panel="${CSS.escape(id)}"]`);
      if(panel){
        const hist=panel.closest?.(".lc-phase-history");
        if(hist) hist.open=true;
        panel.open=true;
        try{ panel.scrollIntoView({behavior:"smooth",block:"nearest"}); }catch(_e){}
      }
    }
  });
}

function ruleEventICS(r,event){
  if(!r||!event||!/^\d{4}-\d{2}-\d{2}$/.test(event.valid_at||"")) return null;
  const start=event.valid_at.replace(/-/g,"");
  const endDate=new Date(`${event.valid_at}T00:00:00Z`);
  endDate.setUTCDate(endDate.getUTCDate()+1);
  const end=endDate.toISOString().slice(0,10).replace(/-/g,"");
  const esc=s=>String(s||"").replace(/([,;\\])/g,"\\$1").replace(/\n/g,"\\n");
  return ["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//CityScroll//EN","CALSCALE:GREGORIAN","METHOD:PUBLISH",
    "BEGIN:VEVENT",`UID:rule-comment-close-${r.request_id}@cityscroll.org`,`DTSTAMP:${new Date().toISOString().replace(/[-:]/g,"").replace(/\.\d{3}/,"")}`,
    `DTSTART;VALUE=DATE:${start}`,`DTEND;VALUE=DATE:${end}`,
    `SUMMARY:${esc(t("rule_event_calendar_title",{title:cleanText(r.short_title)}))}`,
    `DESCRIPTION:${esc(`${r.agency_name||""} · ${noticeLink(r.request_id)}`)}`,
    "BEGIN:VALARM","TRIGGER:-P1D","ACTION:DISPLAY",`DESCRIPTION:${esc(t("rule_event_calendar_reminder"))}`,"END:VALARM",
    "END:VEVENT","END:VCALENDAR"].join("\r\n");
}

function downloadRuleEventICS(r,event){
  const ics=ruleEventICS(r,event); if(!ics) return;
  const blob=new Blob([ics],{type:"text/calendar;charset=utf-8"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob);
  a.download=`rule-comment-deadline-${r.request_id}.ics`; document.body.appendChild(a); a.click(); a.remove();
}

let rulesParticipationToolsPromise=null;
function rulesParticipationTools(){
  if(!rulesParticipationToolsPromise){
    rulesParticipationToolsPromise=import("../rules_participation.mjs").catch(()=>null);
  }
  return rulesParticipationToolsPromise;
}
let rulesMemberBlurbToolsPromise=null;
function rulesMemberBlurbTools(){
  if(!rulesMemberBlurbToolsPromise){
    rulesMemberBlurbToolsPromise=import("../rules_member_blurb.mjs").catch(()=>null);
  }
  return rulesMemberBlurbToolsPromise;
}

/**
 * Disclosure: official comment channel + what makes a comment count + neutral scaffold.
 * Only when the comment window is open.
 */
function ruleParticipationHTML(path){
  if(!path || !path.open) return "";
  const deadline=path.comment_by_date
    ? (path.days_left!=null && path.days_left>=0
      ? t("rule_part_deadline_line",{date:ruleDateLabel(path.comment_by_date),n:String(path.days_left)})
      : t("rule_part_deadline_line",{date:ruleDateLabel(path.comment_by_date),n:"—"}))
    : t("rule_part_deadline_line_undated");
  const channel=path.submit_url
    ? `<p><a class="act primary" href="${escUiHtml(path.submit_url)}" ${EXT_ATTRS}>${escUiHtml(t("rule_part_channel_cta"))}${extSR()}</a>
        <span class="muted" style="margin-inline-start:8px">${escUiHtml(t(path.channel_label_key||"rule_part_channel_nyc_rules"))}</span></p>`
    : `<p class="muted">${escUiHtml(t("rule_guide_fallback_step"))}</p>`;
  const counts=(path.counts_keys||[]).map(k=>`<li>${escUiHtml(t(k))}</li>`).join("");
  const fields=(path.scaffold||[]).map(f=>`
    <div class="rule-scaffold-field">
      <label for="rule-scaffold-${escUiHtml(f.id)}">${escUiHtml(t(f.label_key))}</label>
      <textarea id="rule-scaffold-${escUiHtml(f.id)}" data-scaffold-field="${escUiHtml(f.id)}" placeholder="${escUiHtml(t(f.placeholder_key))}" rows="2"></textarea>
    </div>`).join("");
  return `<details class="rule-participation" data-rule-participation="1" open>
    <summary>${escUiHtml(t("rule_part_summary"))}</summary>
    <div class="rule-participation-body">
      <p><b>${escUiHtml(t("rule_part_channel_heading"))}</b> — ${escUiHtml(deadline)}</p>
      ${channel}
      <p><b>${escUiHtml(t("rule_part_counts_heading"))}</b></p>
      <ol>${counts}</ol>
      <p><b>${escUiHtml(t("rule_part_scaffold_heading"))}</b></p>
      <p class="muted">${escUiHtml(t("rule_part_scaffold_lead"))}</p>
      <div class="rule-scaffold-fields" data-rule-scaffold="1">${fields}</div>
      <p class="muted" style="margin-top:8px">${escUiHtml(t("rule_part_scaffold_draft_label"))}</p>
      <pre class="rule-scaffold-draft" data-scaffold-draft="" tabindex="0"></pre>
      <button type="button" class="act" data-scaffold-copy="1">${escUiHtml(t("rule_part_scaffold_copy"))}</button>
    </div>
  </details>`;
}

function ruleMemberBlurbHTML(blurb){
  if(!blurb || !blurb.text) return "";
  return `<details class="rule-member-blurb" data-rule-member-blurb="1">
    <summary>${escUiHtml(t("rule_member_blurb_summary"))}</summary>
    <div class="rule-member-blurb-body">
      <p class="muted">${escUiHtml(t("rule_member_blurb_lead"))}</p>
      <div class="rule-member-blurb-text" data-member-blurb-text="">${escUiHtml(blurb.text)}</div>
      <button type="button" class="act" data-member-blurb-copy="1">${escUiHtml(t("rule_member_blurb_copy"))}</button>
    </div>
  </details>`;
}

function bindRuleParticipationUI(root, path, assembleFn){
  if(!root || !path) return;
  const draftEl=root.querySelector("[data-scaffold-draft]");
  const fields=[...root.querySelectorAll("[data-scaffold-field]")];
  const refresh=()=>{
    if(!draftEl || typeof assembleFn!=="function") return;
    const values={};
    for(const ta of fields) values[ta.dataset.scaffoldField]=ta.value;
    draftEl.textContent=assembleFn(path, values);
  };
  fields.forEach(ta=>ta.addEventListener("input", refresh));
  refresh();
  const copyBtn=root.querySelector("[data-scaffold-copy]");
  if(copyBtn && draftEl){
    copyBtn.addEventListener("click",()=>{
      copyText(draftEl.textContent||"", copyBtn);
      copyBtn.textContent=t("rule_part_scaffold_copied");
      setTimeout(()=>{ copyBtn.textContent=t("rule_part_scaffold_copy"); }, 1600);
    });
  }
}

function bindRuleMemberBlurbUI(root, blurb){
  if(!root || !blurb?.text) return;
  const btn=root.querySelector("[data-member-blurb-copy]");
  if(!btn) return;
  btn.addEventListener("click",()=>{
    copyText(blurb.text, btn);
    btn.textContent=t("rule_member_blurb_copied");
    setTimeout(()=>{ btn.textContent=t("rule_member_blurb_copy"); }, 1600);
  });
}

async function loadRuleLifecycle(r,el){
  if(!el||!r||r.section_name!=="Agency Rules") return;
  let rulesView=null;
  let stageMap=new Map();
  let rec=null;
  try{
    rulesView=await loadRulesView();
    stageMap=buildRulesStageMap(rulesView);
    rec=stageMap.get(r.request_id)||null;
  }catch(e){}
  if(!document.contains(el)) return;
  // A successful read model with no join is a class-(a) gap; a failed read stays fail-soft.
  if(!rec){
    if(!rulesView) return;
    rec={request_id:r.request_id,stage:"unknown",nyc_rules:null,events:[],join:{matched:false},related_notices:[],rulemaking_join:{matched:false}};
  }
  const phaseTools=await ensureRulesPhaseSpineTools();
  if(!document.contains(el)) return;
  // High-confidence multi-notice stitch: merge sibling events via related_notices
  // + stage map so proposal/hearing/adoption show as one lifecycle (not three cards).
  let adoptionModel=null;
  try{
    const lagMod=await import("../rules_adoption_lag_view.mjs").catch(()=>null);
    if(lagMod?.attachAdoptionLagEstimate){
      window.__rulesAdoptionLagAttach=lagMod.attachAdoptionLagEstimate;
    }
    adoptionModel=await loadRulesAdoptionLagModel();
  }catch(_e){}
  if(!document.contains(el)) return;

  // Prefer stitched record for open-window + blurb facts.
  let paintRec=rec;
  if(phaseTools && typeof phaseTools.stitchRulemakingRecord==="function"){
    const stitched=phaseTools.stitchRulemakingRecord(rec, stageMap);
    if(stitched) paintRec=stitched;
  }

  const partTools=await rulesParticipationTools();
  const blurbTools=await rulesMemberBlurbTools();
  if(!document.contains(el)) return;

  let participationPath=null;
  let assembleScaffold=null;
  if(partTools?.buildRulesParticipationPath){
    participationPath=partTools.buildRulesParticipationPath(paintRec, r, { now: todayISO() });
    assembleScaffold=partTools.assembleScaffoldDraft;
  }
  let memberBlurb=null;
  if(blurbTools?.buildMemberBlurb){
    memberBlurb=blurbTools.buildMemberBlurb(r, paintRec, {
      now: todayISO(),
      siteBase: (typeof location!=="undefined" && location.origin) ? location.origin : "https://cityscroll.org",
    });
  }

  const spine=ruleEventSpineHTML(rec, phaseTools, stageMap, adoptionModel);
  const partHtml=ruleParticipationHTML(participationPath);
  const blurbHtml=ruleMemberBlurbHTML(memberBlurb);
  // Participation + member blurb lead the lifecycle so act-now is first; spine remains below.
  el.innerHTML=`${partHtml}${blurbHtml}${spine}`;
  bindRulesPhaseUI(el);
  if(participationPath) bindRuleParticipationUI(el, participationPath, assembleScaffold);
  if(memberBlurb) bindRuleMemberBlurbUI(el, memberBlurb);
  // Comment deadline may come from a sibling’s NYC Rules join after stitch.
  let commentEvent=(rec.events||[]).find(event=>event.event_type==="comment_close");
  if(!commentEvent && phaseTools && typeof phaseTools.stitchRulemakingRecord==="function"){
    const stitched=phaseTools.stitchRulemakingRecord(rec, stageMap);
    commentEvent=(stitched?.events||[]).find(event=>event.event_type==="comment_close");
  }
  el.querySelectorAll("[data-rule-event]").forEach(button=>button.addEventListener("click",()=>downloadRuleEventICS(r,commentEvent)));
}

async function loadSectionAgencies(key){
  const sel=$("#"+key+"agency"); if(!sel) return;
  try{
    const sectionWhere=key==="meetings"
      ? "(section_name='Public Hearings and Meetings' OR (section_name='Agency Rules' AND type_of_notice_description='Public Hearings' AND event_date IS NOT NULL))"
      : `section_name='${SECTIONS[key].section}'`;
    const rows=await soda({"$select":"agency_name","$where":`${sectionWhere} AND agency_name IS NOT NULL`,"$group":"agency_name","$order":"agency_name","$limit":"200"});
    const cur=sel.value;
    sel.innerHTML=`<option value="">${t("all_agencies")}</option>`+rows.map(r=>`<option>${r.agency_name}</option>`).join("");
    if(cur) forceSelect("#"+key+"agency", cur);
  }catch(e){}
}

// feedCardHTML: one Property/Rules/Meetings feed card. mev ("match evidence", named apart from
// r.event_date's own `ev` local below to avoid shadowing it) reuses the same matchEvidence()/
// digTitleHTML()/digEvidenceHTML() the Alerts-page ask preview and every other lens list share.
function feedCardHTML(key, r, terms){
  const cfg=SECTIONS[key];
  const ev=r.event_date, propertyAddress=key==="property"&&r._location?.addresses?.[0]?.label;
  const addr=propertyAddress||(cfg.showAddr&&goodAddr(r.street_address_1)?cleanText(r.street_address_1):"");
  // excerptHtml owns decode→truncate→escape; raw slice of cleanText left entities double-escaped
  // when a later path escaped again, and could cut inside "&ldquo;".
  const scopeHtml=excerptHtml(r.additional_description_1,200);
  const title=cleanText(r.short_title), mev=matchEvidence(title, matchText(r), terms);
  const noticeHref=`#notice/${encodeURIComponent(r.request_id)}`;
  // Comment-open is the actionable moment: lead with the official comment-page CTA so the
  // primary action sits first in the row (matches the hearing-card join/participation lead).
  const ruleAct=key==="rules"?ruleCommentAction(r._ruleStage):"";
  // Primary in-app action first (Open notice), then the external City Record citation.
  let acts=(ruleAct?ruleAct:"")+`<a class="act" href="${noticeHref}">${t("open_notice_btn")}</a>`+`<a class="act" href="${REQ_URL(r.request_id)}" ${EXT_ATTRS}>${t("city_record_link")}${extSR()}</a>`;
  acts+=`<button class="act" type="button" data-link="${r.request_id}">${t("copy_link_btn")}</button>`;
  if(ev) acts+=`<button class="act" type="button" data-ev="${key}:${r.request_id}">${t("add_date_btn",{date:fdt(ev)})}</button>`;
  const geometry=key==="property"&&r._location?.geometry;
  const taxLot=key==="property"&&r._location?.tax_lots?.[0];
  // A located site without a street address can still map when it carries a
  // borough + Block/Lot (Google Maps geocodes "Block 644 Lot 1 Manhattan").
  const blockLotQuery=geometry?"":(taxLot&&r._location?.boroughs?.length?`${taxLot.label}, ${r._location.boroughs[0]}, New York NY`:"");
  const mapQuery=geometry?`${geometry.latitude},${geometry.longitude}`:addr?`${addr} New York NY`:blockLotQuery;
  if(mapQuery) acts+=`<a class="act" href="https://www.google.com/maps/search/${encodeURIComponent(mapQuery)}" ${EXT_ATTRS}>${t("map_link")}${extSR()}</a>`;
  if(addr && key==="property") acts+=`<button class="act" type="button" data-demo="${r.request_id}">${t("still_standing_btn")}</button>`;
  const pbadges = key==="property" && (r._asset || r._badge)
    ? `<div class="property-commercial-lead" data-commercial-glance="1">${r._asset?`<span class="tag asset">${ASSET_LABEL[r._asset]?t(ASSET_LABEL[r._asset]):""}</span>`:""}${r._badge?`<span class="tag amt">${r._badge}</span>`:""}</div>` : "";
  const rstage=key==="rules"&&!ruleAct?ruleStageChip(r._ruleStage):"";
  const rbadges=rstage?`<div>${rstage}</div>`:"";
  return `<div class="fcard">
      <div class="ftype">${r.type_of_notice_description||""}${r.agency_name?" · "+pivotA(agencyHref(r.agency_name), r.agency_name):""}${ev?` · <b style="color:var(--ink)">${fdt(ev)}</b>${eventTag(ev)}`:""}</div>
      ${pbadges}
      ${rbadges}
      <div class="ftitle"><a href="${noticeHref}">${title ? digTitleHTML(title, mev) : t("untitled")}</a></div>
      ${key==="property"?propertyPlaceChips(r._location):addr?`<div class="faddr">${addr}</div>`:""}
      ${key==="rules"?rulePlaceChips(r._ruleLocation):""}
      ${scopeHtml?`<div class="fscope">${scopeHtml}</div>`:""}
      ${digEvidenceHTML(mev)}
      <div class="factions">${acts}</div>
    </div>`;
}
function renderFeed(key, rows){
  const el=$("#"+key+"feed");
  feedVisible[key]=rows;
  if(!rows.length){ el.innerHTML='<div class="empty">' + t("nothing_found_feed") + '</div>'; return; }
  const kwEl=$("#"+key+"kw"), kw=kwEl?kwEl.value.trim():"", terms=kw?[kw]:[];
  el.innerHTML=rows.map(r=>feedCardHTML(key,r,terms)).join("");
  el.querySelectorAll("[data-link]").forEach(b=>b.addEventListener("click",()=>copyText(noticeLink(b.dataset.link), b)));
  el.querySelectorAll("[data-ev]").forEach(b=>b.addEventListener("click",()=>{ const i=b.dataset.ev.indexOf(":"); downloadEventICS(feedRows[b.dataset.ev.slice(0,i)][b.dataset.ev.slice(i+1)]); }));
  el.querySelectorAll("[data-demo]").forEach(b=>b.addEventListener("click",()=>checkDemolition(feedRows.property[b.dataset.demo], b)));
}

async function checkDemolition(r, btn){
  const address=r?._location?.addresses?.[0]?.label||r?.street_address_1;
  if(!r||!address) return;
  btn.textContent=t("checking_dob"); btn.disabled=true;
  const geo=await geocode(cleanText(address)+" New York NY");
  if(!geo||!geo.bbl||!/^\d{10}$/.test(geo.bbl)){ btn.textContent=t("lot_not_resolved"); btn.disabled=false; return; }
  const boro={"1":"MANHATTAN","2":"BRONX","3":"BROOKLYN","4":"QUEENS","5":"STATEN ISLAND"}[geo.bbl[0]]||"";
  const blkIn=`'${String(parseInt(geo.bbl.slice(1,6),10))}','${geo.bbl.slice(1,6)}'`;
  const lot4=geo.bbl.slice(6,10), lotIn=`'${String(parseInt(lot4,10))}','${lot4.padStart(5,"0")}','${lot4}'`;
  let hit=null;
  try{ const n=await api("https://data.cityofnewyork.us/resource/w9ak-ipjd.json",{"$select":"filing_status,job_type","$where":`borough='${boro}' AND block in(${blkIn}) AND lot in(${lotIn}) AND upper(job_type) like '%DEMOLITION%'`,"$limit":"1"}); if(n&&n[0]) hit={status:n[0].filing_status||n[0].job_type,src:"DOB NOW"}; }catch(e){}
  if(!hit){ try{ const l=await api("https://data.cityofnewyork.us/resource/ic3t-wcy2.json",{"$select":"job_status_descrp,latest_action_date","$where":`borough='${boro}' AND block in(${blkIn}) AND lot in(${lotIn}) AND job_type='DM'`,"$order":"latest_action_date DESC","$limit":"1"}); if(l&&l[0]) hit={status:l[0].job_status_descrp,date:(l[0].latest_action_date||"").slice(0,10),src:"DOB"}; }catch(e){} }
  const span=document.createElement("span"); span.className="act demoresult";
  span.innerHTML = hit ? `${t("demolition_status_html",{status:cleanText(hit.status)})}${hit.date?` (${hit.date})`:""} <span class="muted">· ${hit.src}</span>` : t("no_demo_permit");
  btn.replaceWith(span);
}

async function downloadEventICS(r){
  if(!r||!r.event_date) return;
  const isHearing=!!(r.venue||r.participation||r.section_name==="Public Hearings and Meetings"||r.source_section==="Public Hearings and Meetings"||/hearing/i.test(r.type_of_notice_description||r.notice_type||""));
  if(isHearing){
    const {hearingCalendarICS}=await import("../hearing_attend_pack.mjs");
    const source=r.official_notice_url||r.source_url||(r.request_id?REQ_URL(r.request_id):null);
    const hearingICS=hearingCalendarICS({...r,source_url:source});
    if(!hearingICS) return;
    const hearingBlob=new Blob([hearingICS],{type:"text/calendar;charset=utf-8"});
    const hearingLink=document.createElement("a");
    hearingLink.href=URL.createObjectURL(hearingBlob);
    hearingLink.download=`hearing-${r.request_id||"event"}.ics`;
    document.body.appendChild(hearingLink); hearingLink.click(); hearingLink.remove();
    setTimeout(()=>URL.revokeObjectURL(hearingLink.href),0);
    return;
  }
  const d=new Date(r.event_date), pad=n=>String(n).padStart(2,"0");
  const fl=dt=>`${dt.getFullYear()}${pad(dt.getMonth()+1)}${pad(dt.getDate())}T${pad(dt.getHours())}${pad(dt.getMinutes())}00`;
  const esc=s=>String(s||"").replace(/([,;\\])/g,"\\$1").replace(/\n/g,"\\n");
  const ics=["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//CityScroll//EN","CALSCALE:GREGORIAN","METHOD:PUBLISH",
    "BEGIN:VEVENT","UID:"+r.request_id+"@crol-list","DTSTAMP:"+fl(new Date()),"DTSTART:"+fl(d),"DTEND:"+fl(d),
    "SUMMARY:"+esc(cleanText(r.short_title)),
    "DESCRIPTION:"+esc(`${r.agency_name||""}${goodAddr(r.street_address_1)?" · "+cleanText(r.street_address_1):""} · ${REQ_URL(r.request_id)}`),
    "BEGIN:VALARM","TRIGGER:-P1D","ACTION:DISPLAY","DESCRIPTION:Tomorrow","END:VALARM",
    "END:VEVENT","END:VCALENDAR"].join("\r\n");
  const blob=new Blob([ics],{type:"text/calendar;charset=utf-8"}); const a=document.createElement("a");
  a.href=URL.createObjectURL(blob); a.download=`crol-${r.request_id}.ics`; document.body.appendChild(a); a.click(); a.remove();
}

// Publish live bindings for neighboring modules and legacy inline handlers.
globalThis.RULES_PHASE_IDS = RULES_PHASE_IDS;
globalThis.RULES_PHASE_LABEL_KEYS = RULES_PHASE_LABEL_KEYS;
globalThis.RULES_PUBLIC_URL = RULES_PUBLIC_URL;
globalThis.RULE_EVENT_CFG = RULE_EVENT_CFG;
globalThis.RULE_STAGE_CFG = RULE_STAGE_CFG;
globalThis.bindRulesPhaseUI = bindRulesPhaseUI;
globalThis.checkDemolition = checkDemolition;
globalThis.downloadEventICS = downloadEventICS;
globalThis.downloadRuleEventICS = downloadRuleEventICS;
globalThis.ensureRulesPhaseSpineTools = ensureRulesPhaseSpineTools;
globalThis.feedCardHTML = feedCardHTML;
globalThis.loadRuleLifecycle = loadRuleLifecycle;
globalThis.loadRulesAdoptionLagModel = loadRulesAdoptionLagModel;
globalThis.loadSectionAgencies = loadSectionAgencies;
globalThis.renderFeed = renderFeed;
globalThis.renderRulesExplorer = renderRulesExplorer;
globalThis.ruleParticipationHTML = ruleParticipationHTML;
globalThis.ruleMemberBlurbHTML = ruleMemberBlurbHTML;
globalThis.bindRuleParticipationUI = bindRuleParticipationUI;
globalThis.bindRuleMemberBlurbUI = bindRuleMemberBlurbUI;
globalThis.ruleAdoptionEstimateHTML = ruleAdoptionEstimateHTML;
globalThis.ruleCommentAction = ruleCommentAction;
globalThis.ruleDateLabel = ruleDateLabel;
globalThis.ruleDisplayStage = ruleDisplayStage;
globalThis.ruleEventCardHTML = ruleEventCardHTML;
globalThis.ruleEventICS = ruleEventICS;
globalThis.ruleEventSpineHTML = ruleEventSpineHTML;
globalThis.ruleEventSpineHTMLFlat = ruleEventSpineHTMLFlat;
globalThis.ruleEventSpineHTMLPhase = ruleEventSpineHTMLPhase;
globalThis.rulePhaseAggregateHTML = rulePhaseAggregateHTML;
globalThis.rulePhaseLabel = rulePhaseLabel;
globalThis.rulePhaseLeadHTML = rulePhaseLeadHTML;
globalThis.rulePhasePanelHTML = rulePhasePanelHTML;
globalThis.rulePhaseStepperHTML = rulePhaseStepperHTML;
globalThis.ruleSiblingRoleLabel = ruleSiblingRoleLabel;
globalThis.ruleSiblingsHTML = ruleSiblingsHTML;
globalThis.ruleStageChip = ruleStageChip;
globalThis.rulesExplorerCardHTML = rulesExplorerCardHTML;
globalThis.rulesExplorerTools = rulesExplorerTools;
globalThis.rulesProcessControlHTML = rulesProcessControlHTML;
globalThis.rulesProcessPhaseLabel = rulesProcessPhaseLabel;
Object.defineProperty(globalThis, "rulesAdoptionLagModelPromise", { configurable: true, get: () => rulesAdoptionLagModelPromise, set: value => { rulesAdoptionLagModelPromise = value; } });
Object.defineProperty(globalThis, "rulesAll", { configurable: true, get: () => rulesAll, set: value => { rulesAll = value; } });
Object.defineProperty(globalThis, "rulesExplorerToolsPromise", { configurable: true, get: () => rulesExplorerToolsPromise, set: value => { rulesExplorerToolsPromise = value; } });
Object.defineProperty(globalThis, "rulesPhaseSpineToolsPromise", { configurable: true, get: () => rulesPhaseSpineToolsPromise, set: value => { rulesPhaseSpineToolsPromise = value; } });
Object.defineProperty(globalThis, "rulesProcessSel", { configurable: true, get: () => rulesProcessSel, set: value => { rulesProcessSel = value; } });
Object.defineProperty(globalThis, "rulesViewCache", { configurable: true, get: () => rulesViewCache, set: value => { rulesViewCache = value; } });
