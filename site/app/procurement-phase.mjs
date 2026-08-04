/* ===================== PROCUREMENT PHASE SPINE (phase-group / dedupe / aggregate) =====
   Pure model: site/procurement_phase_spine.mjs (same shape as land_phase_spine).
   When the module loads, lifecycleTimelineHTML phase-groups milestones; flat stepper is
   the fallback only if the import fails. */
let procurementPhaseSpineToolsPromise = null;
function ensureProcurementPhaseSpineTools(){
  if(!procurementPhaseSpineToolsPromise){
    procurementPhaseSpineToolsPromise = import("../procurement_phase_spine.mjs").catch(() => null);
  }
  return procurementPhaseSpineToolsPromise;
}

/* Human Services award → registration dwell strip (precompute-first).
   Pure model: site/award_registration_dwell_view.mjs; payload from the
   award_registration_dwell materialization
   (lookup: site/data/award_registration_dwell_lookup.json). */
let awardRegDwellViewPromise = null;
let awardRegDwellLookupPromise = null;
function ensureAwardRegDwellView(){
  if(!awardRegDwellViewPromise){
    awardRegDwellViewPromise = import("../award_registration_dwell_view.mjs").catch(() => null);
  }
  return awardRegDwellViewPromise;
}
function loadAwardRegDwellLookup(){
  if(!awardRegDwellLookupPromise){
    awardRegDwellLookupPromise = fetch("./data/award_registration_dwell_lookup.json", {
      credentials: "omit",
      cache: "no-cache",
    })
      .then((r) => (r && r.ok ? r.json() : null))
      .catch(() => null);
  }
  return awardRegDwellLookupPromise;
}
function awardRegistrationDwellHTML(formatted){
  if(!formatted || !formatted.line) return "";
  const daysAttr = formatted.dwell_days != null && Number.isFinite(formatted.dwell_days)
    ? ` data-dwell-days="${escUiHtml(String(formatted.dwell_days))}"`
    : "";
  const frame = formatted.frame
    ? `<p class="award-reg-dwell-frame">${formatted.frame}</p>`
    : "";
  return `<div class="award-reg-dwell" data-reg-dwell-status="${escUiHtml(formatted.status||"")}"${daysAttr} role="status" aria-label="${escUiHtml(t("award_reg_dwell_aria"))}">
    <p class="award-reg-dwell-line">${formatted.line}</p>
    ${frame}
  </div>`;
}
/** Mount the dwell strip on Human Services award notices only. Clean absence otherwise. */
async function loadAwardRegistrationDwell(r, el){
  if(!el || !r) return;
  try{
    const view = await ensureAwardRegDwellView();
    if(!view || typeof view.isHumanServicesAwardNotice !== "function"){
      if(document.contains(el)) el.innerHTML = "";
      return;
    }
    if(!view.isHumanServicesAwardNotice(r)){
      if(document.contains(el)) el.innerHTML = "";
      return;
    }
    const [lookup, tools] = await Promise.all([
      loadAwardRegDwellLookup(),
      ensureAwardRegDwellView(),
    ]);
    if(!document.contains(el)) return;
    if(!tools || !lookup){
      el.innerHTML = "";
      return;
    }
    const strip = tools.buildAwardRegistrationDwellStrip(r, lookup);
    if(!strip){
      el.innerHTML = "";
      return;
    }
    // Honesty: never paint unknown as 0 / instant.
    if(strip.status === "unknown" && strip.dwell_days != null){
      el.innerHTML = "";
      return;
    }
    const formatted = tools.formatAwardRegistrationDwellStrip(strip, t);
    el.innerHTML = awardRegistrationDwellHTML(formatted);
  }catch(_e){
    if(document.contains(el)) el.innerHTML = "";
  }
}

function lifecyclePhaseLabel(phase){
  if(!phase) return "—";
  if(phase.label_key) return t(phase.label_key);
  if(typeof phase === "string"){
    const meta = {
      solicitation: "lifecycle_phase_solicitation",
      selection: "lifecycle_phase_selection",
      award_registration: "lifecycle_phase_award_registration",
      payments: "lifecycle_phase_payments",
    };
    return meta[phase] ? t(meta[phase]) : phase;
  }
  return phase.short || "—";
}

function lifecyclePhaseActionHTML(view, notice){
  const cur = view && view.current;
  if(!cur) return "";
  const key = cur.action_key || "lifecycle_phase_action_respond";
  if(key === "lifecycle_phase_action_follow_money"){
    return t(key, { href: lifecycleDollarsFocusHref(notice && notice.request_id) });
  }
  return t(key);
}

function lifecyclePhaseAggregateHTML(agg){
  if(!agg) return "";
  if(agg.count <= 1) return "";
  const range = agg.first && agg.last && agg.first !== agg.last
    ? t("lifecycle_phase_aggregate_range", { first: fdate(agg.first), last: fdate(agg.last) })
    : (agg.first ? fdate(agg.first) : "");
  return `<div class="lc-phase-agg">
    <div class="lc-phase-agg-title" lang="en" dir="ltr">${escUiHtml(agg.title)}<span class="lc-phase-count">×${agg.count}</span></div>
    <div class="lc-phase-agg-meta">${range || "—"}</div>
  </div>`;
}

function lifecyclePhasePanelHTML(phase, raw, notice, currentKey){
  if(!phase) return "";
  // Future empty phases: chip only (no empty panel clutter).
  if(phase.state === "future" && !phase.event_count) return "";
  // Passed empty: omit.
  if(phase.state === "passed" && !phase.event_count) return "";

  const open = phase.state === "current" ? " open" : "";
  const stateWord = phase.state === "current"
    ? t("lifecycle_phase_current")
    : phase.state === "passed"
      ? t("lifecycle_phase_done")
      : t("lifecycle_phase_future");
  let summary = "";
  if(phase.event_count){
    const parts = [
      t("lifecycle_phase_milestones_count", { n: String(phase.event_count) }),
      phase.first && phase.last && phase.first !== phase.last
        ? t("lifecycle_phase_aggregate_range", { first: fdate(phase.first), last: fdate(phase.last) })
        : (phase.first ? fdate(phase.first) : ""),
    ].filter(Boolean);
    summary = parts.join(" · ");
  } else {
    summary = t("lifecycle_phase_empty");
  }

  // Material milestones as stage cards; one outbound source link on the phase's chosen stage
  // (dedupe across Checkbook/City Record/PASSPort families within the phase).
  let body = "";
  const multiAggs = (phase.aggregates || []).filter(a => a.count >= 2);
  if(multiAggs.length){
    body += multiAggs.map(lifecyclePhaseAggregateHTML).join("");
  }
  const entries = (phase.milestones || []).map(m => m.entry).filter(Boolean);
  let stages = "";
  entries.forEach((entry, idx) => {
    const isPhaseLink = phase.state === "current" && entry.stage === phase.phase_link_stage;
    const html = lifecycleStageHTML(entry, raw, notice, {
      currentKey,
      isCurrent: entry.stage === currentKey,
      showSourceLink: isPhaseLink,
    });
    if(html){
      stages += html;
      if(idx < entries.length - 1) stages += '<div class="connector">→</div>';
    }
  });
  if(stages) body += `<div class="lc-stage-detail"><div class="chain">${stages}</div></div>`;
  if(!body) body = `<div class="lc-phase-summary">${t("lifecycle_phase_empty")}</div>`;

  return `<details class="lc-phase${phase.state === "current" ? " current-phase" : ""}"${open} id="lc-phase-${escUiHtml(phase.id)}" data-lc-phase-panel="${escUiHtml(phase.id)}">
    <summary>
      <span class="lc-phase-name">${escUiHtml(lifecyclePhaseLabel(phase))}</span>
      <span class="lc-phase-state">${escUiHtml(stateWord)}</span>
      <span class="lc-phase-summary">${escUiHtml(summary)}</span>
    </summary>
    <div class="lc-phase-body">${body}</div>
  </details>`;
}

function lifecyclePhaseStepperHTML(view){
  if(!view || !view.phases || !view.phases.length) return "";
  const items = view.phases.map((p, i) => {
    const cls = p.state === "current" ? "current" : p.state === "passed" ? "passed" : "future";
    const aria = p.state === "current" ? ` aria-current="step"` : "";
    const arrow = i < view.phases.length - 1
      ? `<span class="lc-step-arrow" aria-hidden="true">→</span>`
      : "";
    return `<li><button type="button" class="lc-step ${cls}" data-lc-phase="${escUiHtml(p.id)}"${aria} title="${escUiHtml(lifecyclePhaseLabel(p))}">${escUiHtml(p.short || lifecyclePhaseLabel(p))}</button>${arrow}</li>`;
  }).join("");
  return `<ol class="lc-stepper lc-phase-stepper" aria-label="${escUiHtml(t("lifecycle_heading"))}">${items}</ol>`;
}

function lifecyclePhaseTimelineHTML(view, data, notice){
  if(!view) return "";
  const raw = data.timeline || [];
  const currentKey = view.current && view.current.stage;
  const noPin = view.no_pin;

  const cur = view.current || {};
  const phaseName = lifecyclePhaseLabel({ label_key: cur.label_key });
  const actionHTML = lifecyclePhaseActionHTML(view, notice);
  const lead = noPin ? "" : `<div class="lc-phase-lead">
    <div class="lc-phase-now-label">${t("lifecycle_phase_now_label")}</div>
    <p class="lc-phase-now-phase">${escUiHtml(phaseName)}</p>
    <p class="lc-phase-now-detail" lang="en" dir="ltr">${escUiHtml(cur.milestone_label || lifecycleStageLabel(cur.stage) || "—")}${cur.since ? ` · ${t("lifecycle_phase_since", { date: fdate(cur.since) })}` : ""}</p>
    ${actionHTML ? `<p class="lc-phase-action">${actionHTML}</p>` : ""}
    ${view.next ? `<p class="lc-phase-next">${t("lifecycle_phase_next_html", { phase: escUiHtml(lifecyclePhaseLabel(view.next)) })}</p>` : ""}
  </div>`;

  const stepper = noPin ? "" : lifecyclePhaseStepperHTML(view);

  // Current phase first (open); earlier phases collapsed under "Earlier phases" disclosure.
  const currentPanel = (view.phases || []).filter(p => p.state === "current")
    .map(p => lifecyclePhasePanelHTML(p, raw, notice, currentKey)).join("");
  const historyPanels = (view.phases || []).filter(p => p.state === "passed")
    .map(p => lifecyclePhasePanelHTML(p, raw, notice, currentKey)).filter(Boolean).join("");
  // Future phases with planned material (rare) still expand below.
  const futurePanels = (view.phases || []).filter(p => p.state === "future" && p.event_count)
    .map(p => lifecyclePhasePanelHTML(p, raw, notice, currentKey)).join("");
  const historyWrap = historyPanels
    ? `<details class="lc-phase-history"><summary>${t("lifecycle_phase_show_history")}</summary>${historyPanels}</details>`
    : "";

  let amendmentsHTML = "";
  if(data.amendments && data.amendments.length){
    amendmentsHTML = data.amendments.map(a =>
      `<div class="note warn">${t("lifecycle_amendment_note_html",{
        original:lifecycleMoney(a.original_amount),
        current:lifecycleMoney(a.current_amount),
        delta:lifecycleMoney(Math.abs(a.delta))
      })}</div>`
    ).join("");
  }

  const howBody = noPin
    ? t("lifecycle_no_pin_note_html")
    : t("lifecycle_provenance_note_html",{
        city_record:`<span lang="en" dir="ltr">${t("lifecycle_source_city_record")}</span>`,
        checkbook:`<span lang="en" dir="ltr">${t("lifecycle_source_checkbook")}</span>`,
        passport:`<span lang="en" dir="ltr">${t("lifecycle_source_passport")}</span>`,
        pin:`<code>${escUiHtml(data.pin)}</code>`
      });
  const howHTML = noPin
    ? `<div class="note">${howBody}</div>`
    : `<details class="inline-disclose lc-how"><summary>${t("lifecycle_how_summary")}</summary><div class="inline-disclose-body">${howBody}</div></details>`;

  if(noPin && !currentPanel && !historyPanels){
    return `<div class="chain-h">${t("lifecycle_heading")}</div>
      <div class="note">${howBody}</div>`;
  }

  let rfxHTML = "";
  const rfx = data.rfx_detail;
  if(rfx && rfx.status === "matched" && rfx.detail){
    const d = rfx.detail;
    rfxHTML = `<div class="note" style="margin-top:8px"><b>${t("lifecycle_rfx_heading")}</b>
      ${d.procurement_name ? ` · <span lang="en" dir="ltr">${escUiHtml(d.procurement_name)}</span>` : ""}
      ${d.due_date ? ` · ${t("lifecycle_rfx_due_html",{date:fdate(d.due_date) || escUiHtml(d.due_date)})}` : ""}
      ${d.rfx_status ? ` · ${t("lifecycle_rfx_status_html",{status:escUiHtml(d.rfx_status)})}` : ""}
      ${d.procurement_method ? ` · ${t("lifecycle_rfx_method_html",{method:escUiHtml(d.procurement_method)})}` : ""}
      · <a class="view" href="${rfx.portal || PASSPORT_RFX_URL}" ${EXT_ATTRS}>${t("lifecycle_source_passport")}${extSR()}</a>
    </div>`;
  }

  const ocpHTML = lifecycleOcpAwardHTML(data);

  return `<div class="chain-h">${t("lifecycle_heading")}</div>
    ${lead}
    ${stepper}
    ${currentPanel}
    ${futurePanels}
    ${historyWrap}
    ${amendmentsHTML}
    ${rfxHTML}
    ${ocpHTML}
    ${howHTML}`;
}

function bindProcurementPhaseUI(root){
  if(!root || root.dataset.lcPhaseBound === "1") return;
  root.dataset.lcPhaseBound = "1";
  root.addEventListener("click", (ev) => {
    const step = ev.target.closest?.("[data-lc-phase]");
    if(step && root.contains(step)){
      const id = step.getAttribute("data-lc-phase");
      const panel = root.querySelector(`[data-lc-phase-panel="${CSS.escape(id)}"]`);
      if(panel){
        // Opening a historical phase panel: expand the history disclosure first.
        const hist = panel.closest?.(".lc-phase-history");
        if(hist) hist.open = true;
        panel.open = true;
        try{ panel.scrollIntoView({ behavior: "smooth", block: "nearest" }); }catch(_e){}
      }
    }
  });
}

// Flat fallback (pre-phase-group stepper + detail cards) when the pure module fails to load.
function lifecycleTimelineHTMLFlat(data, notice){
  const raw = data.timeline || [];
  if(!raw.length) return "";

  const noPin = !data.pin || data.pin_strategy === "none";
  const tl = noPin
    ? raw.filter(e => e.source === "city-record" || e.stage === "solicitation" || e.stage === "award")
    : raw.filter(e => lifecyclePublicStatus(e, raw) !== "not_applicable");

  const currentKey = lifecycleCurrentStageKey(raw);
  const stepper = noPin ? "" : lifecycleStepperHTML(tl, raw, currentKey);

  let stages = "";
  const expanded = tl.map(e => ({
    entry: e,
    html: lifecycleStageHTML(e, raw, notice, {
      currentKey,
      isCurrent: e.stage === currentKey,
      showSourceLink: e.stage === currentKey,
    }),
  })).filter(x => x.html);
  expanded.forEach((x, idx) => {
    stages += x.html;
    if(idx < expanded.length - 1) stages += '<div class="connector">→</div>';
  });

  let amendmentsHTML = "";
  if(data.amendments && data.amendments.length){
    amendmentsHTML = data.amendments.map(a =>
      `<div class="note warn">${t("lifecycle_amendment_note_html",{
        original:lifecycleMoney(a.original_amount),
        current:lifecycleMoney(a.current_amount),
        delta:lifecycleMoney(Math.abs(a.delta))
      })}</div>`
    ).join("");
  }

  const howBody = noPin
    ? t("lifecycle_no_pin_note_html")
    : t("lifecycle_provenance_note_html",{
        city_record:`<span lang="en" dir="ltr">${t("lifecycle_source_city_record")}</span>`,
        checkbook:`<span lang="en" dir="ltr">${t("lifecycle_source_checkbook")}</span>`,
        passport:`<span lang="en" dir="ltr">${t("lifecycle_source_passport")}</span>`,
        pin:`<code>${escUiHtml(data.pin)}</code>`
      });
  const howHTML = noPin
    ? `<div class="note">${howBody}</div>`
    : `<details class="inline-disclose lc-how"><summary>${t("lifecycle_how_summary")}</summary><div class="inline-disclose-body">${howBody}</div></details>`;

  if(noPin && !stages){
    return `<div class="chain-h">${t("lifecycle_heading")}</div>
      <div class="note">${howBody}</div>`;
  }

  let rfxHTML = "";
  const rfx = data.rfx_detail;
  if(rfx && rfx.status === "matched" && rfx.detail){
    const d = rfx.detail;
    rfxHTML = `<div class="note" style="margin-top:8px"><b>${t("lifecycle_rfx_heading")}</b>
      ${d.procurement_name ? ` · <span lang="en" dir="ltr">${escUiHtml(d.procurement_name)}</span>` : ""}
      ${d.due_date ? ` · ${t("lifecycle_rfx_due_html",{date:fdate(d.due_date) || escUiHtml(d.due_date)})}` : ""}
      ${d.rfx_status ? ` · ${t("lifecycle_rfx_status_html",{status:escUiHtml(d.rfx_status)})}` : ""}
      ${d.procurement_method ? ` · ${t("lifecycle_rfx_method_html",{method:escUiHtml(d.procurement_method)})}` : ""}
      · <a class="view" href="${rfx.portal || PASSPORT_RFX_URL}" ${EXT_ATTRS}>${t("lifecycle_source_passport")}${extSR()}</a>
    </div>`;
  }

  const ocpHTML = lifecycleOcpAwardHTML(data);

  return `<div class="chain-h">${t("lifecycle_heading")}</div>
    ${stepper}
    ${stages ? `<div class="lc-stage-detail"><div class="chain">${stages}</div></div>` : ""}
    ${amendmentsHTML}
    ${rfxHTML}
    ${ocpHTML}
    ${howHTML}`;
}

function lifecycleTimelineHTML(data, notice, phaseTools){
  const raw = data.timeline || [];
  if(!raw.length) return "";
  if(phaseTools && typeof phaseTools.buildProcurementPhaseView === "function"){
    const view = phaseTools.buildProcurementPhaseView(data, { notice });
    return lifecyclePhaseTimelineHTML(view, data, notice);
  }
  return lifecycleTimelineHTMLFlat(data, notice);
}

// Registration / payment detail drawn from the same precomputed lifecycle timeline — no
// live Checkbook proxy from the client (precompute-first). Specific per-slot gaps use the
// established "no record found" register. Never the transient "Could not reach" wording.
function lifecycleDollarsHTML(data, notice){
  if(!data || !Array.isArray(data.timeline)) return "";
  if(!data.pin || data.pin_strategy === "none") return ""; // no-PIN: lifecycle note is enough
  const reg = data.timeline.find(e => e.stage === "registered") || null;
  const pay = data.timeline.find(e => e.stage === "payment") || null;
  if(!reg && !pay) return "";

  if(reg && reg.status === "matched" && reg.detail){
    const d = reg.detail;
    // Same resolver as the payments card — panels must never disagree on paid-to-date.
    const resolved = lifecycleResolvedPayment(d, pay && pay.detail);
    const payState = resolved.state;
    const spent = resolved.spent;
    const current = d.current_amount != null ? d.current_amount : 0;
    const original = d.original_amount != null ? d.original_amount : 0;
    const pct = (spent != null && current > 0) ? Math.min(100, Math.round((spent / current) * 100)) : null;
    const amended = original > 0 && Math.abs(current - original) > 1;
    // Entity-resolution match (stem + truncation/token overlap) — warn only on genuine mismatch.
    const sameVendor = !notice.vendor_name || !d.vendor || vendorNamesMatch(d.vendor, notice.vendor_name);
    const vendorMismatch = notice.vendor_name && d.vendor && !sameVendor;
    const displayDiffers = notice.vendor_name && d.vendor && sameVendor
      && cleanText(d.vendor).toLowerCase() !== cleanText(notice.vendor_name).toLowerCase();
    const payPublic = pay ? lifecyclePublicStatus(pay, data.timeline) : "";
    // Dollars owns paid-to-date detail. Never re-emit payments gap copy here when the
    // registration join already supplies Paid to date (one owner; gap only if join absent).
    const payNote = pay && payPublic === "matched" && pay.detail && pay.detail.total_payments != null
      ? t("lifecycle_dollars_payments_html",{
          count: tn("lifecycle_payments_count", pay.detail.total_payments || 0),
          latest: pay.detail.latest_payment_amount != null
            ? t("lifecycle_latest_payment_html",{amount:lifecycleMoney(pay.detail.latest_payment_amount),date:fdate(pay.detail.latest_payment_date)})
            : ""
        })
      : "";
    const contractLink = checkbookSearchUrl({
      contractId: d.contract_id,
      pin: data.pin || notice.pin,
      vendor: d.vendor || notice.vendor_name,
      agid: d.agid || d.checkbook_agid,
      documentCode: d.document_code || d.doctype,
      detailUrl: d.checkbook_detail_url,
    });
    const contractIdHtml = d.contract_id
      ? `<a href="${contractLink}" ${EXT_ATTRS}><code>${escUiHtml(d.contract_id)}</code>${extSR()}</a>`
      : `<code>—</code>`;
    const vendorNote = vendorMismatch
      ? `<div class="note warn" style="margin-top:10px">${t("lifecycle_dollars_vendor_mismatch_html",{checkbook:escUiHtml(cleanText(d.vendor)),notice:escUiHtml(cleanText(notice.vendor_name))})}</div>`
      : displayDiffers
        ? `<div class="note" style="margin-top:10px">${t("lifecycle_dollars_vendor_variant_html",{checkbook:escUiHtml(cleanText(d.vendor)),notice:escUiHtml(cleanText(notice.vendor_name))})}</div>`
        : "";
    const paidDd = payState === "unavailable"
      ? `<dd>${t("lifecycle_dollars_paid_unavailable_html")}</dd>`
      : `<dd><b>${lifecycleMoney(spent)}</b>${pct != null ? ` (${pct}%)` : ""}<div class="lbar" style="max-width:220px;margin-top:5px"><span style="width:${pct || 0}%"></span></div></dd>`;
    const lagNote = (payState === "verified_zero" || (payState !== "unavailable" && spent === 0))
      ? `<div class="note" style="margin-top:10px">${t("lifecycle_payment_zero_lag_html")}</div>`
      : "";
    const ceilingNote = lifecycleCommittedUnderrun(spent, current, d.end_date)
      ? `<div class="note" style="margin-top:10px">${t("lifecycle_committed_ceiling_note_html")}</div>`
      : "";
    return `<div class="apply" id="${LIFECYCLE_DOLLARS_ANCHOR}" style="margin-top:14px" tabindex="-1"><h3>${t("lifecycle_dollars_heading")}</h3><div class="body">
      <dl>
        <dt>${t("lifecycle_dollars_contract_lbl")}</dt><dd>${contractIdHtml} · ${t("lifecycle_dollars_registered_on_html",{date:d.registration_date?fdate(d.registration_date):"—"})}</dd>
        <dt>${t("lifecycle_dollars_committed_lbl")}</dt><dd><b>${lifecycleMoney(current)}</b>${amended?` <span class="tag soon">${t("lifecycle_amended_from_html",{original:lifecycleMoney(original)})}</span>`:""}</dd>
        <dt>${t("lifecycle_dollars_paid_lbl")}</dt>${paidDd}
        <dt>${t("lifecycle_dollars_term_lbl")}</dt><dd>${fdate(d.start_date)||"—"} → ${fdate(d.end_date)||"—"}</dd>
        ${d.mwbe?`<dt>${t("lifecycle_dollars_mwbe_lbl")}</dt><dd>${escUiHtml(d.mwbe)}</dd>`:""}
      </dl>
      ${vendorNote}
      ${payNote?`<div class="note" style="margin-top:10px">${payNote}</div>`:""}
      ${lagNote}
      ${ceilingNote}
      <div class="pnote">${t("lifecycle_dollars_provenance_html",{
        link:`<a href="${contractLink}" ${EXT_ATTRS}>${t("lifecycle_source_checkbook")}${extSR()}</a>`,
        pin:`<code>${escUiHtml(data.pin||notice.pin||"")}</code>`
      })}</div>
    </div></div>`;
  }

  // Registration not matched — taxonomy gap only (never transient "could not reach").
  const regPublic = reg ? lifecyclePublicStatus(reg, data.timeline) : "";
  const regNote = !reg ? ""
    : regPublic === "unmatched"
      ? t("lifecycle_unmatched_registered_html",{source:`<span lang="en" dir="ltr">${t("lifecycle_source_checkbook_registered")}</span>`})
      : regPublic === "ambiguous"
        ? t("lifecycle_ambiguous_html")
        : "";
  if(!regNote) return "";
  const fallbackCheckbook = checkbookSearchUrl({
    pin: data.pin || notice.pin,
    vendor: notice.vendor_name,
  });
  return `<div class="note" style="margin-top:12px"><b>${t("lifecycle_dollars_heading")}</b> ${regNote}
    <a href="${fallbackCheckbook}" ${EXT_ATTRS}>${t("lifecycle_source_checkbook")}${extSR()}</a></div>`;
}


/* ===================== M/WBE SOLICITATION CHIPS (payload surface) =====================
   Pure models: site/mwbe_goal_surface.mjs (+ site/solicitation_procurement_method.mjs).
   Consumes structured_facts.procurement_method or extracts from the notice body.
   Award sub-outreach is site/sub_outreach.mjs (separate, mounted by paintSubOutreach). */

let mwbeGoalSurfaceToolsPromise = null;
function ensureMwbeGoalSurfaceTools(){
  if(!mwbeGoalSurfaceToolsPromise){
    mwbeGoalSurfaceToolsPromise = import("../mwbe_goal_surface.mjs").catch(() => null);
  }
  return mwbeGoalSurfaceToolsPromise;
}

function mwbeChipSpanHTML(chip){
  if(!chip || !chip.i18n_key) return "";
  const label = chip.i18n_params ? t(chip.i18n_key, chip.i18n_params) : t(chip.i18n_key);
  const tone = chip.tone || "method";
  return `<span class="tag ${escUiHtml(tone)}">${escUiHtml(label)}</span>`;
}

function solicitationMwbeDetailHTML(view){
  if(!view || !view.show) return "";
  const chips = (view.chips || []).map(mwbeChipSpanHTML).filter(Boolean).join("");
  const chipRow = chips
    ? `<div class="mwbe-chiprow" data-mwbe-sol-chips="1">${chips}</div>`
    : "";
  let goalBlock = "";
  if(view.section_6_129?.present){
    const pct = view.section_6_129.goal_percent;
    goalBlock = pct != null && Number.isFinite(Number(pct))
      ? `<div class="lc-pct"><b>${t("mwbe_sol_goal_lbl")}:</b> ${t("mwbe_sol_goal_pct_html",{pct:String(pct)})}</div>`
      : `<div class="lc-pct"><b>${t("mwbe_sol_goal_lbl")}:</b> ${t("mwbe_sol_goal_cite_only_html")}</div>`;
  }
  let floorBlock = "";
  if(view.floor && view.floor.days != null){
    const floorChip = view.chips?.find((c) => c.kind === "response_floor");
    const floorLabel = floorChip
      ? (floorChip.i18n_params ? t(floorChip.i18n_key, floorChip.i18n_params) : t(floorChip.i18n_key))
      : `${view.floor.days} ${view.floor.day_unit || "days"}`;
    floorBlock = `<div class="lc-pct"><b>${t("mwbe_sol_floor_lbl")}:</b> ${escUiHtml(floorLabel)}
      ${view.floor.rule_cite ? `<div class="note muted">${t("mwbe_sol_floor_cite_html",{cite:escUiHtml(view.floor.rule_cite)})}</div>` : ""}
    </div>`;
  }
  const how = `<details class="inline-disclose lc-how"><summary>${t("lifecycle_how_summary")}</summary><div class="inline-disclose-body">${t("mwbe_sol_provenance_html")}</div></details>`;
  return `<section class="mwbe-sol-detail apply" data-mwbe-sol-detail="1" aria-label="${escUiHtml(t("mwbe_sol_heading"))}">
    <h3 class="chain-h" style="margin-top:0">${t("mwbe_sol_heading")}</h3>
    <p class="note" style="margin:0 0 8px">${t("mwbe_sol_persona_html")}</p>
    ${chipRow}
    ${goalBlock}
    ${floorBlock}
    ${how}
  </section>`;
}

async function loadSolicitationMwbe(r, el){
  if(!el || !r) return;
  const type = String(r.type_of_notice_description || "");
  if(!/solicitation/i.test(type)){
    el.innerHTML = "";
    return;
  }
  const tools = await ensureMwbeGoalSurfaceTools();
  if(!document.contains(el)) return;
  if(!tools || typeof tools.buildSolicitationMwbeView !== "function"){
    el.innerHTML = "";
    return;
  }
  const view = tools.buildSolicitationMwbeView(r);
  el.innerHTML = view ? solicitationMwbeDetailHTML(view) : "";
}


// Prime-win sub-outreach card: pure helpers in site/sub_outreach.mjs.
// Consumes lifecycle.award_prime_goal only; never invents goal % or apology empties.
let subOutreachToolsPromise = null;
function ensureSubOutreachTools(){
  if(!subOutreachToolsPromise){
    subOutreachToolsPromise = import("../sub_outreach.mjs").catch(() => null);
  }
  return subOutreachToolsPromise;
}

/**
 * Paint the sub-outreach surface from award_prime_goal. Empty string when
 * nothing allowlisted exists — including when goal_percent is not_published.
 * @param {object} r notice row
 * @param {object|null} data /contract-lifecycle payload
 * @param {HTMLElement|null|undefined} subEl
 */
async function paintSubOutreach(r, data, subEl){
  if(!subEl) return;
  if(!document.contains(subEl)) return;
  // Clear first so prior notice paint never lingers on wrong-universe routes.
  subEl.innerHTML = "";
  if(!data || !data.award_prime_goal) return;
  if(!/^(Award|Intent to Award|Intent to Negotiate|Vendor List)$/.test(r.type_of_notice_description||"")){
    // Still allow registration-matched solicitations when the side-car is eligible
    // and stamps an open_candidate window or prime facts.
    if(String(r.type_of_notice_description||"") !== "Solicitation") return;
  }
  const tools = await ensureSubOutreachTools();
  if(!tools || typeof tools.subOutreachHTML !== "function") return;
  if(!document.contains(subEl)) return;
  const moneyFn = typeof lifecycleMoney === "function"
    ? (n) => lifecycleMoney(n)
    : (typeof money === "function" ? money : undefined);
  const html = tools.subOutreachHTML(data.award_prime_goal, {
    t,
    esc: typeof escUiHtml === "function" ? escUiHtml : undefined,
    money: moneyFn,
  });
  // Final empty-state axe: refuse apology copy even if a future helper drifts.
  if(html && typeof tools.detectSubOutreachApologyCopy === "function"){
    if(tools.detectSubOutreachApologyCopy(html).length) {
      subEl.innerHTML = "";
      return;
    }
  }
  subEl.innerHTML = html || "";
}

// Fetches the precomputed lifecycle from the worker and renders the timeline + dollars
// panel. Fail-soft on network: says nothing rather than inventing a gap. The read model is
// fully precomputed server-side (worker/src/checkbook_lifecycle.mjs) — no live upstream.
// Category gate first: non-procurement notices never fetch or paint contract modules.
// Optional subOutreachEl: prime-win sub-outreach card (award_prime_goal side-car).
async function loadLifecycle(r, el, dollarsEl, actionsEl, subOutreachEl){
  const subEl = subOutreachEl
    || (typeof document !== "undefined" && (document.getElementById("nsuboutreach") || document.getElementById("dsuboutreach")))
    || null;
  if((!el && !dollarsEl && !subEl) || !r.request_id) return;
  if(!isContractLifecycleEligible(r)){
    if(el) el.innerHTML = "";
    if(dollarsEl) dollarsEl.innerHTML = "";
    if(subEl) subEl.innerHTML = "";
    return;
  }
  let data = null;
  try{
    const resp = await workerFetch("/contract-lifecycle?id=" + encodeURIComponent(r.request_id), null, 8000);
    if(resp && resp.ok) data = await resp.json();
  }catch(e){}
  if(el && !document.contains(el)) return;
  if(dollarsEl && !document.contains(dollarsEl)) return;
  if(!data){
    // No PIN → explicit class-(b) gap on the lifecycle slot for procurement notices.
    if(el && /^(Solicitation|Award|Intent to Award|Intent to Negotiate|Vendor List)$/.test(r.type_of_notice_description||"") && !usablePin(r.pin)){
      el.innerHTML = `<div class="chain-h">${t("lifecycle_heading")}</div><div class="note">${t("lifecycle_no_pin_note_html")}</div>`;
    }
    // Network / total failure: say nothing — never "Could not reach" as a data gap.
    if(subEl) subEl.innerHTML = "";
    return;
  }
  if(data.ok === false && !Array.isArray(data.timeline)){
    // Unresolvable precompute without a timeline: fail soft (no transient-error card).
    if(subEl) subEl.innerHTML = "";
    return;
  }
  if(actionsEl && document.contains(actionsEl)) paintNoticeActionRail(actionsEl,r,null,data);
  if(el && Array.isArray(data.timeline) && data.timeline.length){
    const phaseTools = await ensureProcurementPhaseSpineTools();
    if(el && !document.contains(el)) return;
    el.innerHTML = lifecycleTimelineHTML(data, r, phaseTools);
    bindProcurementPhaseUI(el);
  }
  if(dollarsEl && /^(Award|Intent to Award|Intent to Negotiate|Vendor List)$/.test(r.type_of_notice_description||"")){
    dollarsEl.innerHTML = lifecycleDollarsHTML(data, r);
  }
  // Sub-outreach rides the same precomputed lifecycle; paint only allowlisted facts.
  if(subEl){
    await ensureSubOutreachTools();
    await paintSubOutreach(r, data, subEl);
  }
  // Honor #notice/<id>?focus=follow-the-dollars after the panel is in the DOM.
  scrollToLifecycleFocus();
}

// Publish live bindings for neighboring modules and legacy inline handlers.
globalThis.bindProcurementPhaseUI = bindProcurementPhaseUI;
globalThis.ensureProcurementPhaseSpineTools = ensureProcurementPhaseSpineTools;
globalThis.ensureSubOutreachTools = ensureSubOutreachTools;
globalThis.paintSubOutreach = paintSubOutreach;
globalThis.lifecycleDollarsHTML = lifecycleDollarsHTML;
globalThis.lifecyclePhaseActionHTML = lifecyclePhaseActionHTML;
globalThis.lifecyclePhaseAggregateHTML = lifecyclePhaseAggregateHTML;
globalThis.lifecyclePhaseLabel = lifecyclePhaseLabel;
globalThis.lifecyclePhasePanelHTML = lifecyclePhasePanelHTML;
globalThis.lifecyclePhaseStepperHTML = lifecyclePhaseStepperHTML;
globalThis.lifecyclePhaseTimelineHTML = lifecyclePhaseTimelineHTML;
globalThis.lifecycleTimelineHTML = lifecycleTimelineHTML;
globalThis.lifecycleTimelineHTMLFlat = lifecycleTimelineHTMLFlat;
globalThis.loadLifecycle = loadLifecycle;
globalThis.loadAwardRegistrationDwell = loadAwardRegistrationDwell;
globalThis.awardRegistrationDwellHTML = awardRegistrationDwellHTML;
globalThis.loadSolicitationMwbe = loadSolicitationMwbe;
globalThis.solicitationMwbeDetailHTML = solicitationMwbeDetailHTML;
globalThis.ensureMwbeGoalSurfaceTools = ensureMwbeGoalSurfaceTools;
Object.defineProperty(globalThis, "procurementPhaseSpineToolsPromise", { configurable: true, get: () => procurementPhaseSpineToolsPromise, set: value => { procurementPhaseSpineToolsPromise = value; } });
Object.defineProperty(globalThis, "subOutreachToolsPromise", { configurable: true, get: () => subOutreachToolsPromise, set: value => { subOutreachToolsPromise = value; } });
