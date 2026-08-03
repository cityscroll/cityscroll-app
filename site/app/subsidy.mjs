/* ===================== SUBSIDY LIFECYCLE (SUB-001) =====================
   NYCIDA/Build NYC stages on the notice detail where users actually look. Consumes
   GET /subsidy-lifecycle?id= — edge-materialized, no live EDC fetch from the client.
   Phase-group presentation (Money-collapse): lead with current stage + action, compact
   stepper of all five ontology stages, detail only for material stages, empty future
   stages collapse into one "not yet reached" indicator. Pure model:
   site/subsidy_phase_spine.mjs. */
let subsidyPhaseSpineToolsPromise = null;
function ensureSubsidyPhaseSpineTools(){
  if(!subsidyPhaseSpineToolsPromise){
    subsidyPhaseSpineToolsPromise = import("../subsidy_phase_spine.mjs").catch(() => null);
  }
  return subsidyPhaseSpineToolsPromise;
}

function isSubsidyEligibleNotice(r){
  const agency = String(r.agency_name || "").toLowerCase();
  if(/industrial development|build nyc|nycida|economic development corporation/.test(agency)) return true;
  const title = String(r.short_title || "");
  return /\b(IDA|NYCIDA|Build NYC|tax-?exempt bond|industrial development)\b/i.test(title);
}

function subsidyStageLabel(stage){
  if(stage === "application") return t("subsidy_stage_application");
  if(stage === "hearing") return t("subsidy_stage_hearing");
  if(stage === "board_decision") return t("subsidy_stage_board_decision");
  if(stage === "closing") return t("subsidy_stage_closing");
  if(stage === "compliance") return t("subsidy_stage_compliance");
  return stage;
}

// Hand-synced lag table with worker/src/lib/subsidy_lifecycle.mjs SUBSIDY_STAGE_EXPECT_LAG_DAYS.
// Three honest gap states: too_soon / not_published / unavailable (fetch only).
const SUBSIDY_STAGE_EXPECT_LAG_DAYS = {board_decision:60, closing:180, compliance:400, project_record:90};
function subsidyLagWeeks(stage){
  const days = SUBSIDY_STAGE_EXPECT_LAG_DAYS[stage] != null
    ? SUBSIDY_STAGE_EXPECT_LAG_DAYS[stage]
    : SUBSIDY_STAGE_EXPECT_LAG_DAYS.project_record;
  return Math.max(1, Math.round(days / 7));
}
function subsidyDaysSince(iso, asOf){
  const start = String(iso || "").slice(0, 10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(start)) return null;
  const a = Date.UTC(+start.slice(0,4), +start.slice(5,7)-1, +start.slice(8,10));
  const end = asOf instanceof Date ? asOf : new Date(asOf || Date.now());
  if(Number.isNaN(end.valueOf())) return null;
  const b = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  return Math.floor((b - a) / 86400000);
}
function subsidyGapKindClient(stage, anchorDate, matched){
  if(matched) return null;
  const days = subsidyDaysSince(anchorDate);
  if(days == null) return "not_published";
  const lag = SUBSIDY_STAGE_EXPECT_LAG_DAYS[stage] != null
    ? SUBSIDY_STAGE_EXPECT_LAG_DAYS[stage]
    : SUBSIDY_STAGE_EXPECT_LAG_DAYS.project_record;
  return days < lag ? "too_soon" : "not_published";
}
function subsidyAnchorFromNotice(notice, data){
  const hearing = (data && data.timeline || []).find(e => e && e.stage === "hearing" && e.date);
  if(hearing && hearing.date) return String(hearing.date).slice(0,10);
  if(data && data.join && data.join.anchor_date) return String(data.join.anchor_date).slice(0,10);
  const ev = notice && (notice.event_date || notice.start_date);
  return ev ? String(ev).slice(0,10) : null;
}

/** Matched-stage detail card only. Unmatched/future stages return "" (Money-collapse). */
function subsidyStageHTML(entry, anchorDate, opts){
  opts = opts || {};
  const feedStatus = opts.feedStatus;
  // Collapse: never emit a verbose gap card for empty future / unmatched stages.
  // Those surface as stepper chips + one aggregate "not yet reached" indicator.
  if(!entry || entry.status !== "matched"){
    if(opts.forceDetail){
      // Disclosure-only substance for feed-down class-(a) honesty (not primary chrome).
      let kind = entry.gap_kind || subsidyGapKindClient(entry.stage, anchorDate, false);
      if(feedStatus === "unavailable" && kind === "not_published") kind = "not_yet_ingested";
      const label = subsidyStageLabel(entry.stage);
      let detailHTML = "";
      if(kind === "too_soon"){
        detailHTML = `<div class="lc-norecord">${t("subsidy_stage_too_soon_html",{
          stage: label,
          date: fdate(anchorDate) || "—",
          weeks: String(subsidyLagWeeks(entry.stage))
        })}</div>`;
      } else if(kind === "not_yet_ingested" || kind === "unavailable"){
        detailHTML = `<div class="lc-norecord" data-subsidy-gap="${escUiHtml(kind)}">${t("subsidy_stage_unmatched_html",{
          stage: label,
          source: `<span lang="en" dir="ltr">${t("subsidy_source_build_nyc")}</span>`
        })}</div>`;
      } else {
        detailHTML = `<div class="lc-norecord" data-subsidy-gap="not_published">${t("subsidy_stage_not_published_html",{
          stage: label,
          source: `<span lang="en" dir="ltr">${t("subsidy_source_build_nyc")}</span>`
        })}</div>`;
      }
      return `<div class="stage"><div class="box unmatched">
        <div class="stage-name">${label}</div>
        ${detailHTML}
      </div></div>`;
    }
    return "";
  }
  const label = subsidyStageLabel(entry.stage);
  const dateHTML = entry.date ? `<div class="when">${fdate(entry.date)}</div>` : `<div class="when">—</div>`;
  const action = entry.official_action ? `<div class="lc-pct">${t("subsidy_action_html",{action:escUiHtml(String(entry.official_action).replace(/_/g," "))})}</div>` : "";
  const outcome = entry.outcome && entry.outcome !== "unknown"
    ? `<div class="lc-pct">${t("subsidy_outcome_html",{outcome:escUiHtml(entry.outcome)})}</div>`
    : `<div class="lc-norecord">${t("subsidy_outcome_unknown_html")}</div>`;
  const amt = entry.detail && entry.detail.amount != null ? `<div class="amt">${money(entry.detail.amount)}</div>` : "";
  const detailHTML = amt + action + outcome;
  let link = "";
  if(opts.showSourceLink !== false && entry.source && entry.source.status === "matched" && entry.source.url){
    link = `<a class="view" href="${escUiHtml(entry.source.url)}" ${EXT_ATTRS}>${t("subsidy_source_build_nyc")}${extSR()}</a>`;
  }
  const curCls = opts.isCurrent ? " current-stage" : "";
  return `<div class="stage"><div class="box matched${curCls}">
    <div class="stage-name">${label}</div>
    ${dateHTML}
    ${detailHTML}
    ${link}
  </div></div>`;
}

function subsidyPhaseLabel(phase){
  if(!phase) return "—";
  if(phase.label_key) return t(phase.label_key);
  if(typeof phase === "string") return subsidyStageLabel(phase);
  return phase.short || "—";
}

function subsidyPhaseActionHTML(view){
  const cur = view && view.current;
  if(!cur) return "";
  const key = cur.action_key || "subsidy_phase_action_application";
  return t(key);
}

function subsidyPhaseStepperHTML(view){
  if(!view || !view.phases || !view.phases.length) return "";
  const items = view.phases.map((p, i) => {
    const cls = p.state === "current" ? "current" : p.state === "passed" ? "passed" : "future";
    const aria = p.state === "current" ? ` aria-current="step"` : "";
    const arrow = i < view.phases.length - 1
      ? `<span class="lc-step-arrow" aria-hidden="true">→</span>`
      : "";
    return `<li><button type="button" class="lc-step ${cls}" data-subsidy-phase="${escUiHtml(p.id)}"${aria} title="${escUiHtml(subsidyPhaseLabel(p))}">${escUiHtml(p.short || subsidyPhaseLabel(p))}</button>${arrow}</li>`;
  }).join("");
  return `<ol class="lc-stepper subsidy-phase-stepper" aria-label="${escUiHtml(t("subsidy_lifecycle_heading"))}">${items}</ol>`;
}

function subsidyPhaseNotYetHTML(view){
  if(!view || !view.future_empty_count) return "";
  const labels = (view.future_empty_phase_ids || []).map(id => subsidyStageLabel(id)).filter(Boolean);
  if(!labels.length) return "";
  const list = labels.length === 1
    ? labels[0]
    : labels.slice(0, -1).join(", ") + " " + t("subsidy_phase_and") + " " + labels[labels.length - 1];
  return `<div class="subsidy-phase-not-yet" data-subsidy-not-yet="${view.future_empty_count}">${t("subsidy_phase_not_yet_reached_html",{
    stages: escUiHtml(list),
    n: String(view.future_empty_count)
  })}</div>`;
}

function subsidyPhasePanelHTML(phase, anchorDate, opts){
  if(!phase) return "";
  if(phase.state === "future" && !phase.event_count) return "";
  if(phase.state === "passed" && !phase.event_count) return "";
  const open = phase.state === "current" ? " open" : "";
  const stateWord = phase.state === "current"
    ? t("subsidy_phase_current")
    : phase.state === "passed"
      ? t("subsidy_phase_done")
      : t("subsidy_phase_future");
  let summary = "";
  if(phase.event_count && phase.first){
    summary = phase.first && phase.last && phase.first !== phase.last
      ? t("subsidy_phase_aggregate_range", { first: fdate(phase.first), last: fdate(phase.last) })
      : fdate(phase.first);
  } else if(phase.event_count){
    summary = t("subsidy_phase_milestones_count", { n: String(phase.event_count) });
  } else {
    summary = t("subsidy_phase_empty");
  }
  let body = "";
  const entries = (phase.milestones || []).map(m => m.entry).filter(Boolean);
  let stages = "";
  entries.forEach((entry, idx) => {
    const html = subsidyStageHTML(entry, anchorDate, {
      feedStatus: opts && opts.feedStatus,
      isCurrent: phase.state === "current",
      showSourceLink: phase.state === "current",
    });
    if(html){
      stages += html;
      if(idx < entries.length - 1) stages += '<div class="connector">→</div>';
    }
  });
  if(stages) body = `<div class="lc-stage-detail"><div class="chain">${stages}</div></div>`;
  if(!body) body = `<div class="lc-phase-summary">${t("subsidy_phase_empty")}</div>`;
  return `<details class="lc-phase${phase.state === "current" ? " current-phase" : ""}"${open} id="subsidy-phase-${escUiHtml(phase.id)}" data-subsidy-phase-panel="${escUiHtml(phase.id)}">
    <summary>
      <span class="lc-phase-name">${escUiHtml(subsidyPhaseLabel(phase))}</span>
      <span class="lc-phase-state">${escUiHtml(stateWord)}</span>
      <span class="lc-phase-summary">${escUiHtml(summary)}</span>
    </summary>
    <div class="lc-phase-body">${body}</div>
  </details>`;
}

/** Short matched place for lead chrome (never a hearing-body dump). */
function subsidyPlaceDisplay(place){
  if(!place || place.status !== "matched") return null;
  let addr = cleanText(place.address || "");
  if(!addr && Array.isArray(place.addresses) && place.addresses[0]){
    addr = cleanText(place.addresses[0]);
  }
  if(!addr && Array.isArray(place.boroughs) && place.boroughs.length){
    addr = place.boroughs.filter(Boolean).join(", ");
  }
  if(!addr) return null;
  if(/SUPPLEMENTAL NOTICE|will hold a public hearing/i.test(addr)) return null;
  if(addr.length > 120){
    const cut = addr.slice(0, 120);
    const m = cut.match(/^(.+?),\s*(?:New York|NY)\b/i)
      || cut.match(/^(.+?)(?:\s+to be used|\s+[—–-]|\s*\()/i);
    addr = m ? cleanText(m[1]) : cleanText(cut.replace(/\s+\S*$/, "")) || cut.slice(0, 100);
    if(addr.length >= 118) addr = addr.slice(0, 117) + "…";
  }
  return addr || null;
}

/**
 * Preferred matched project/development cost from the money object (by field stamp
 * or scalar totals). Avoids depending on an internal slot key name in this layer.
 */
function subsidyPreferredCostSlot(money){
  if(!money || typeof money !== "object") return null;
  for(const v of Object.values(money)){
    if(!v || typeof v !== "object") continue;
    if(v.status !== "matched" || v.value == null) continue;
    if(v.field === "total_project_cost" || v.field === "total_development_cost") return v;
  }
  if(money.total_project_cost != null && Number.isFinite(+money.total_project_cost)){
    return { status: "matched", value: +money.total_project_cost, field: "total_project_cost", source: null };
  }
  if(money.total_development_cost != null && Number.isFinite(+money.total_development_cost)){
    return { status: "matched", value: +money.total_development_cost, field: "total_development_cost", source: null };
  }
  return null;
}

/**
 * First-paint kinetic facts: matched project cost + short place.
 * Visible in the lead — never only under a closed fields disclosure.
 */
function subsidyMatchedFactsHTML(data){
  if(!data || !(data.join && data.join.matched)) return "";
  const parts = [];
  const cityRecordHearing = data.join.method === "city-record-hearing";
  const slot = subsidyPreferredCostSlot(data.money);
  if(slot && slot.value != null){
    let field = t("subsidy_money_total_project_cost_lbl");
    if(slot.field === "total_development_cost") field = t("subsidy_money_total_development_cost_lbl");
    else if(slot.field === "total_project_cost") field = t("subsidy_money_total_project_cost_lbl");
    const fromHearing = slot.source === "city-record-hearing" || cityRecordHearing;
    parts.push(`<p class="lc-phase-fact" data-subsidy-matched-money="1">${t(fromHearing ? "subsidy_money_matched_city_record_html" : "subsidy_money_matched_html",{
      field,
      amount: lifecycleMoney(slot.value)
    })}</p>`);
  }
  const place = subsidyPlaceDisplay(data.place);
  if(place){
    parts.push(`<p class="lc-phase-fact" data-subsidy-matched-place="1" lang="en" dir="ltr">${t("subsidy_place_matched_html",{
      address: escUiHtml(place)
    })}</p>`);
  }
  if(!parts.length) return "";
  return `<div class="lc-phase-facts" data-subsidy-matched-facts="1">${parts.join("")}</div>`;
}

function subsidyPhaseTimelineHTML(view, data, notice){
  if(!view) return "";
  const join = data.join || {};
  const anchor = subsidyAnchorFromNotice(notice, data);
  const feedStatus = join.feed_status || null;
  const cur = view.current || {};
  const phaseName = subsidyPhaseLabel({ label_key: cur.label_key });
  const actionHTML = subsidyPhaseActionHTML(view);
  // Kinetic money/place first in the lead; feed-down is secondary chrome elsewhere.
  const matchedFacts = subsidyMatchedFactsHTML(data);
  const lead = `<div class="lc-phase-lead" data-subsidy-phase-lead="1">
    <div class="lc-phase-now-label">${t("subsidy_phase_now_label")}</div>
    <p class="lc-phase-now-phase">${escUiHtml(phaseName)}</p>
    <p class="lc-phase-now-detail" lang="en" dir="ltr">${escUiHtml(cur.milestone_label || subsidyStageLabel(cur.stage) || "—")}${cur.since ? ` · ${t("subsidy_phase_since", { date: fdate(cur.since) })}` : ""}</p>
    ${matchedFacts}
    ${actionHTML ? `<p class="lc-phase-action">${actionHTML}</p>` : ""}
    ${view.next ? `<p class="lc-phase-next">${t("subsidy_phase_next_html", { phase: escUiHtml(subsidyPhaseLabel(view.next)) })}</p>` : ""}
  </div>`;
  const stepper = subsidyPhaseStepperHTML(view);
  const notYet = subsidyPhaseNotYetHTML(view);
  const currentPanel = (view.phases || []).filter(p => p.state === "current")
    .map(p => subsidyPhasePanelHTML(p, anchor, { feedStatus })).join("");
  const historyPanels = (view.phases || []).filter(p => p.state === "passed")
    .map(p => subsidyPhasePanelHTML(p, anchor, { feedStatus })).filter(Boolean).join("");
  const historyWrap = historyPanels
    ? `<details class="lc-phase-history"><summary>${t("subsidy_phase_show_history")}</summary>${historyPanels}</details>`
    : "";

  // Substance for empty future gaps (class-a/b copy) lives under disclosure — not N cards.
  const futureEmpty = (view.phases || []).filter(p => p.state === "future" && !p.event_count);
  let futureDetail = "";
  if(futureEmpty.length){
    futureDetail = futureEmpty.map(p => {
      const entry = p.entry || { stage: p.id, status: "unmatched", gap_kind: p.gap_kind };
      return subsidyStageHTML(entry, anchor, { feedStatus, forceDetail: true });
    }).filter(Boolean).join("");
  }
  const stagesDisclosure = futureDetail
    ? `<details class="inline-disclose lc-how" data-subsidy-future-gaps="1"><summary>${t("subsidy_phase_show_future_gaps")}</summary><div class="inline-disclose-body"><div class="chain">${futureDetail}</div></div></details>`
    : "";

  return `${lead}${stepper}${notYet}${currentPanel}${historyWrap}${stagesDisclosure}`;
}

function bindSubsidyPhaseUI(root){
  if(!root || root.dataset.subsidyPhaseBound === "1") return;
  root.dataset.subsidyPhaseBound = "1";
  root.addEventListener("click", (ev) => {
    const step = ev.target.closest?.("[data-subsidy-phase]");
    if(step && root.contains(step)){
      const id = step.getAttribute("data-subsidy-phase");
      const panel = root.querySelector(`[data-subsidy-phase-panel="${CSS.escape(id)}"]`);
      if(panel){
        const hist = panel.closest?.(".lc-phase-history");
        if(hist) hist.open = true;
        panel.open = true;
        try{ panel.scrollIntoView({ behavior: "smooth", block: "nearest" }); }catch(_e){}
      }
    }
  });
}

/** Flat Money-collapse fallback when the pure phase module fails to load. */
function subsidyLifecycleHTMLFlat(data, notice){
  if(!data) return "";
  const join = data.join || {};
  const anchor = subsidyAnchorFromNotice(notice, data);
  const feedStatus = join.feed_status || null;
  const tl = Array.isArray(data.timeline) ? data.timeline : [];
  const STAGE_ORDER = {application:0, hearing:1, board_decision:2, closing:3, compliance:4};
  let currentKey = data.stage || null;
  for(const e of tl){
    if(e && e.status === "matched") currentKey = e.stage;
  }
  // Compact stepper of ontology stages (real stages kept).
  const order = ["application","hearing","board_decision","closing","compliance"];
  const byStage = Object.fromEntries(tl.filter(e => e && e.stage).map(e => [e.stage, e]));
  const stepperItems = order.map((id, i) => {
    const e = byStage[id];
    let cls = "future";
    if(id === currentKey) cls = "current";
    else if(e && e.status === "matched") cls = "passed";
    else if(currentKey && (STAGE_ORDER[id] ?? 99) < (STAGE_ORDER[currentKey] ?? -1)) cls = "passed";
    const aria = id === currentKey ? ` aria-current="step"` : "";
    const arrow = i < order.length - 1 ? `<span class="lc-step-arrow" aria-hidden="true">→</span>` : "";
    return `<li><span class="lc-step ${cls}"${aria}>${subsidyStageLabel(id)}</span>${arrow}</li>`;
  }).join("");
  const stepper = join.matched
    ? `<ol class="lc-stepper subsidy-phase-stepper" aria-label="${escUiHtml(t("subsidy_lifecycle_heading"))}">${stepperItems}</ol>`
    : "";

  // Detail cards only for matched stages; one outbound link on current.
  let stages = "";
  if(join.matched && data.source_status !== "unavailable"){
    const matched = tl.filter(e => e && e.status === "matched");
    matched.forEach((entry, idx) => {
      stages += subsidyStageHTML(entry, anchor, {
        feedStatus,
        isCurrent: entry.stage === currentKey,
        showSourceLink: entry.stage === currentKey,
      });
      if(idx < matched.length - 1) stages += '<div class="connector">→</div>';
    });
  }

  const futureEmpty = order.filter(id => {
    if(currentKey && (STAGE_ORDER[id] ?? 0) <= (STAGE_ORDER[currentKey] ?? -1)) return false;
    const e = byStage[id];
    return !e || e.status !== "matched";
  });
  let notYet = "";
  if(join.matched && futureEmpty.length){
    const labels = futureEmpty.map(subsidyStageLabel);
    const list = labels.length === 1
      ? labels[0]
      : labels.slice(0, -1).join(", ") + " " + t("subsidy_phase_and") + " " + labels[labels.length - 1];
    notYet = `<div class="subsidy-phase-not-yet" data-subsidy-not-yet="${futureEmpty.length}">${t("subsidy_phase_not_yet_reached_html",{
      stages: escUiHtml(list),
      n: String(futureEmpty.length)
    })}</div>`;
  }

  // Future gap substance behind disclosure (class-a/b honesty preserved, not N primary cards).
  let futureDisclosure = "";
  if(join.matched && futureEmpty.length){
    const detail = futureEmpty.map(id => {
      const entry = byStage[id] || { stage: id, status: "unmatched" };
      return subsidyStageHTML(entry, anchor, { feedStatus, forceDetail: true });
    }).filter(Boolean).join("");
    if(detail){
      futureDisclosure = `<details class="inline-disclose lc-how" data-subsidy-future-gaps="1"><summary>${t("subsidy_phase_show_future_gaps")}</summary><div class="inline-disclose-body"><div class="chain">${detail}</div></div></details>`;
    }
  }

  const curLabel = subsidyStageLabel(currentKey || data.stage || "");
  const matchedFacts = subsidyMatchedFactsHTML(data);
  const lead = join.matched
    ? `<div class="lc-phase-lead" data-subsidy-phase-lead="1">
      <div class="lc-phase-now-label">${t("subsidy_phase_now_label")}</div>
      <p class="lc-phase-now-phase">${escUiHtml(curLabel)}</p>
      ${matchedFacts}
      <p class="lc-phase-action">${t("subsidy_phase_action_" + (currentKey === "board_decision" ? "board" : currentKey === "application" ? "application" : currentKey === "hearing" ? "hearing" : currentKey === "closing" ? "closing" : currentKey === "compliance" ? "compliance" : "application"))}</p>
    </div>`
    : "";

  return { lead, stepper, notYet, stages, futureDisclosure };
}

function subsidyJoinAndFieldChrome(data, notice){
  if(!data) return { joinNote: "", feedNote: "", fieldGaps: "", howHTML: "" };
  const join = data.join || {};
  const anchor = subsidyAnchorFromNotice(notice, data);
  const feedStatus = join.feed_status || null;

  let joinNote = "";
  if(data.source_status === "unavailable"){
    joinNote = t("subsidy_source_unavailable_html",{source:`<span lang="en" dir="ltr">${t("subsidy_source_build_nyc")}</span>`});
  } else if(join.matched === false){
    const kind = join.gap_kind || subsidyGapKindClient("project_record", anchor, false);
    if(kind === "too_soon"){
      joinNote = t("subsidy_join_too_soon_html",{
        date: fdate(anchor) || "—",
        weeks: String(subsidyLagWeeks("project_record")),
        title: escUiHtml(cleanText(notice.short_title) || notice.request_id || "")
      });
    } else {
      joinNote = t("subsidy_unmatched_html",{
        reason: escUiHtml(join.reason || t("subsidy_unmatched_default_reason")),
        title: escUiHtml(cleanText(notice.short_title) || notice.request_id || "")
      });
    }
  } else if(join.matched){
    const proj = data.project || {};
    // Matched join only — feed-down is secondary chrome (feedNote), not the headline.
    joinNote = t("subsidy_matched_html",{
      project: escUiHtml(proj.name || proj.id || "—"),
      company: escUiHtml((data.company && data.company.value) || proj.company || "—"),
      stage: subsidyStageLabel(data.stage || "")
    });
  }

  const cityRecordHearing = join.method === "city-record-hearing";
  const feedUnavailable = join.feed_status === "unavailable";
  const moneyGapClassA = cityRecordHearing || feedUnavailable;
  // Only unmatched/gap field rows go here. Matched money + place live in the lead
  // (subsidyMatchedFactsHTML) so they are never buried under a closed disclosure.
  let fieldGaps = "";
  if(join.matched){
    if(data.company && data.company.status !== "matched"){
      fieldGaps += moneyGapClassA
        ? `<div class="lc-norecord">${t("subsidy_company_not_yet_ingested_html",{source:`<span lang="en" dir="ltr">${t("subsidy_source_build_nyc")}</span>`})}</div>`
        : `<div class="lc-norecord">${t("subsidy_company_unknown_html")}</div>`;
    }
    if(data.place && data.place.status !== "matched"){
      fieldGaps += moneyGapClassA
        ? `<div class="lc-norecord">${t("subsidy_place_not_yet_ingested_html",{source:`<span lang="en" dir="ltr">${t("subsidy_source_build_nyc")}</span>`})}</div>`
        : `<div class="lc-norecord">${t("subsidy_place_unknown_html")}</div>`;
    }
    if(data.money){
      // Gap only when no matched project/development cost is present on money.
      const costSlot = subsidyPreferredCostSlot(data.money);
      if(!costSlot){
        const field = t("subsidy_money_total_project_cost_lbl");
        fieldGaps += moneyGapClassA
          ? `<div class="lc-norecord">${t("subsidy_money_not_yet_ingested_html",{
              field,
              source:`<span lang="en" dir="ltr">${t("subsidy_source_build_nyc")}</span>`
            })}</div>`
          : `<div class="lc-norecord">${t("subsidy_money_unknown_html",{field})}</div>`;
      }
      // Matched requested benefit is still rare — surface it if present; gaps stay quiet
      // under feed-down (class-a) so we don't invent "city does not publish" noise.
      if(data.money.requested_benefit && data.money.requested_benefit.status === "matched" && data.money.requested_benefit.value != null){
        fieldGaps += `<div class="lc-detail">${t("subsidy_money_matched_html",{
          field: t("subsidy_money_requested_lbl"),
          amount: lifecycleMoney(data.money.requested_benefit.value)
        })}</div>`;
      } else if(data.money.requested_benefit && data.money.requested_benefit.status !== "matched"){
        if(!moneyGapClassA){
          fieldGaps += `<div class="lc-norecord">${t("subsidy_money_unknown_html",{field:t("subsidy_money_requested_lbl")})}</div>`;
        }
      }
    }
  }

  let feedNote = "";
  if(join.matched && feedUnavailable){
    feedNote = t("subsidy_feed_unavailable_html",{
      source:`<span lang="en" dir="ltr">${t("subsidy_source_build_nyc")}</span>`
    });
  }

  const howBody = t("subsidy_provenance_note_html",{
    source:`<a href="https://edc.nyc/about-nycedc/financial-public-documents-recordings" ${EXT_ATTRS}>${t("subsidy_source_build_nyc")}${extSR()}</a>`
  });
  const howHTML = join.matched
    ? `<details class="inline-disclose lc-how"><summary>${t("subsidy_phase_how_summary")}</summary><div class="inline-disclose-body">${howBody}</div></details>`
    : `<div class="note">${howBody}</div>`;

  // Remaining field gaps only (matched money/place are already in the lead).
  const fieldsWrap = fieldGaps
    ? (join.matched
      ? `<details class="inline-disclose lc-how" data-subsidy-field-gaps="1"><summary>${t("subsidy_phase_show_fields")}</summary><div class="inline-disclose-body">${fieldGaps}</div></details>`
      : fieldGaps)
    : "";

  return { joinNote, feedNote, fieldGaps: fieldsWrap, howHTML };
}

function subsidyLifecycleHTML(data, notice, phaseTools){
  if(!data) return "";
  const chrome = subsidyJoinAndFieldChrome(data, notice);
  const join = data.join || {};

  let body = "";
  if(join.matched && data.source_status !== "unavailable"){
    if(phaseTools && typeof phaseTools.buildSubsidyPhaseView === "function"){
      const view = phaseTools.buildSubsidyPhaseView(data, { notice });
      body = subsidyPhaseTimelineHTML(view, data, notice);
    } else {
      const flat = subsidyLifecycleHTMLFlat(data, notice);
      body = `${flat.lead}${flat.stepper}${flat.notYet}${flat.stages ? `<div class="chain">${flat.stages}</div>` : ""}${flat.futureDisclosure}`;
    }
  } else if(join.matched){
    // Source fully unavailable but join carried hearing-derived facts — still surface them.
    body = subsidyMatchedFactsHTML(data);
  }

  // Lead = kinetic facts; feed-down is secondary (after timeline, not the headline).
  return `<div class="chain-h">${t("subsidy_lifecycle_heading")}</div>
    ${chrome.joinNote?`<div class="note" data-subsidy-join-note="1">${chrome.joinNote}</div>`:""}
    ${body}
    ${chrome.feedNote?`<div class="note lc-secondary" data-subsidy-feed-secondary="1">${chrome.feedNote}</div>`:""}
    ${chrome.fieldGaps}
    ${chrome.howHTML}`;
}

async function loadSubsidyLifecycle(r, el){
  if(!el || !r.request_id || !isSubsidyEligibleNotice(r)) return;
  const phaseToolsP = ensureSubsidyPhaseSpineTools();
  let data = null;
  try{
    const resp = await workerFetch("/subsidy-lifecycle?id=" + encodeURIComponent(r.request_id), null, 8000);
    if(resp && resp.ok) data = await resp.json();
  }catch(e){}
  if(!document.contains(el)) return;
  if(!data || data.ok === false){
    // Specific gap even when the endpoint cannot resolve a notice row.
    el.innerHTML = `<div class="chain-h">${t("subsidy_lifecycle_heading")}</div>
      <div class="note">${t("subsidy_unmatched_html",{
        reason: escUiHtml(t("subsidy_unmatched_default_reason")),
        title: escUiHtml(cleanText(r.short_title) || r.request_id || "")
      })}</div>`;
    return;
  }
  const phaseTools = await phaseToolsP;
  if(!document.contains(el)) return;
  el.innerHTML = subsidyLifecycleHTML(data, r, phaseTools);
  bindSubsidyPhaseUI(el);
}

// Publish live bindings for neighboring modules and legacy inline handlers.
globalThis.SUBSIDY_STAGE_EXPECT_LAG_DAYS = SUBSIDY_STAGE_EXPECT_LAG_DAYS;
globalThis.bindSubsidyPhaseUI = bindSubsidyPhaseUI;
globalThis.ensureSubsidyPhaseSpineTools = ensureSubsidyPhaseSpineTools;
globalThis.isSubsidyEligibleNotice = isSubsidyEligibleNotice;
globalThis.loadSubsidyLifecycle = loadSubsidyLifecycle;
globalThis.subsidyAnchorFromNotice = subsidyAnchorFromNotice;
globalThis.subsidyDaysSince = subsidyDaysSince;
globalThis.subsidyGapKindClient = subsidyGapKindClient;
globalThis.subsidyJoinAndFieldChrome = subsidyJoinAndFieldChrome;
globalThis.subsidyLagWeeks = subsidyLagWeeks;
globalThis.subsidyLifecycleHTML = subsidyLifecycleHTML;
globalThis.subsidyLifecycleHTMLFlat = subsidyLifecycleHTMLFlat;
globalThis.subsidyMatchedFactsHTML = subsidyMatchedFactsHTML;
globalThis.subsidyPhaseActionHTML = subsidyPhaseActionHTML;
globalThis.subsidyPhaseLabel = subsidyPhaseLabel;
globalThis.subsidyPhaseNotYetHTML = subsidyPhaseNotYetHTML;
globalThis.subsidyPhasePanelHTML = subsidyPhasePanelHTML;
globalThis.subsidyPhaseStepperHTML = subsidyPhaseStepperHTML;
globalThis.subsidyPhaseTimelineHTML = subsidyPhaseTimelineHTML;
globalThis.subsidyPlaceDisplay = subsidyPlaceDisplay;
globalThis.subsidyPreferredCostSlot = subsidyPreferredCostSlot;
globalThis.subsidyStageHTML = subsidyStageHTML;
globalThis.subsidyStageLabel = subsidyStageLabel;
Object.defineProperty(globalThis, "subsidyPhaseSpineToolsPromise", { configurable: true, get: () => subsidyPhaseSpineToolsPromise, set: value => { subsidyPhaseSpineToolsPromise = value; } });
