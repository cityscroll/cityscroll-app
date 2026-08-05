function isMeetingOutcomesEligible(r){
  const section = r.section_name || "";
  if(section === "Public Hearings and Meetings") return true;
  if(section === "Agency Rules" && r.type_of_notice_description === "Public Hearings") return true;
  return false;
}

function isCityCouncilNotice(r){
  const agency = String(r && r.agency_name || "").trim();
  if(!agency) return false;
  return /\bcity council\b/i.test(agency);
}

function matterDetailUrl(matterId){
  const id = String(matterId == null ? "" : matterId).trim();
  if(!/^\d+$/.test(id)) return null;
  return "https://nyc.legistar.com/Gateway.aspx?M=L&ID=" + encodeURIComponent(id);
}

function nonCouncilBodyLinks(notice){
  const CB_URL = "https://www.nyc.gov/site/cau/community-boards/community-boards.page";
  const BP_LINKS = [
    { re: /\bmanhattan\b/i, url: "https://www.manhattanbp.nyc.gov/", label: "Manhattan Borough President" },
    { re: /\bbrooklyn\b/i, url: "https://www.brooklynbp.nyc.gov/", label: "Brooklyn Borough President" },
    { re: /\bbronx\b/i, url: "https://bronxboropres.nyc.gov/", label: "Bronx Borough President" },
    { re: /\bqueens\b/i, url: "https://queensbp.nyc.gov/", label: "Queens Borough President" },
    { re: /\bstaten island\b|\brichmond\b/i, url: "https://www.statenislandusa.com/", label: "Staten Island Borough President" },
  ];
  const agency = String(notice && notice.agency_name || "").trim();
  const links = [];
  for(const row of BP_LINKS){
    if(row.re.test(agency)){
      links.push({ url: row.url, label: row.label });
      break;
    }
  }
  links.push({ url: CB_URL, label: "NYC community boards" });
  if(links.length === 1){
    links.unshift({ url: "https://bronxboropres.nyc.gov/", label: "Borough president websites" });
  }
  return links;
}

function nonCouncilWhereHTML(notice){
  return nonCouncilBodyLinks(notice).map(l =>
    `<a class="view" href="${escUiHtml(l.url)}" ${EXT_ATTRS}><span lang="en" dir="ltr">${escUiHtml(l.label)}</span>${extSR()}</a>`
  ).join(" · ");
}

function nonCouncilStageLabel(kind){
  if(kind==="notice_published") return t("non_council_stage_notice_published");
  if(kind==="hearing") return t("non_council_stage_hearing");
  if(kind==="outcome") return t("non_council_stage_outcome");
  if(kind==="minutes") return t("non_council_stage_minutes");
  return kind || "—";
}

function nonCouncilHearingOutcomesHTML(notice){
  const pub = notice && notice.start_date ? String(notice.start_date).slice(0,10) : "";
  const hearing = notice && notice.event_date ? String(notice.event_date).slice(0,10) : "";
  const title = cleanText(notice && notice.short_title) || (notice && notice.request_id) || "—";
  const stages = [
    { kind: "notice_published", matched: Boolean(pub), when: pub, title },
    { kind: "hearing", matched: Boolean(hearing), when: hearing, title },
  ].filter(stage=>stage.matched);
  if(!stages.length) return "";
  const chain=stages.map(stage=>`<div class="stage"><div class="box matched">
        <div class="stage-name">${nonCouncilStageLabel(stage.kind)}</div>
        <div class="when">${escUiHtml(stage.when ? fdate(stage.when) : "—")}</div>
        ${stage.title?`<div class="lc-pct" lang="en" dir="ltr">${escUiHtml(stage.title)}</div>`:""}
      </div></div>`).join('<div class="connector" aria-hidden="true">→</div>');
  return `<section class="non-council-spine" data-non-council-spine="1" aria-label="${escUiHtml(t("meeting_outcomes_heading_non_council"))}">
    <div class="chain-h">${t("meeting_outcomes_heading_non_council")}</div>
    <div class="note">${t("non_council_spine_join_html",{
      title: escUiHtml(title),
      agency: escUiHtml(cleanText(notice && notice.agency_name) || "—")
    })}</div>
    <div class="chain">${chain}</div>
  </section>`;
}

function meetingOutcomeBucket(text){
  const s = String(text || "").toLowerCase();
  if(!s) return "other";
  if(/\b(approved|adopted|confirm(ed)?|favorably|pass(ed)?)\b/.test(s)) return "approved";
  if(/\bre-?refer|\breferred\b/.test(s)) return "referred";
  if(/\b(hearing held|held by|deferred|laid over|postponed|tabled|hearing on)\b/.test(s)) return "held";
  return "other";
}

function meetingMatterShortTitle(entry){
  const matter = String(entry.title || "").replace(/\.\s*$/, "").trim();
  const landmarks = matter.match(/^Landmarks,\s*(.+)$/i);
  if(landmarks){
    const core = landmarks[1].replace(/\s*\([^)]+\)\s*$/, "").trim();
    if(core) return core;
  }
  if(matter && matter.length <= 100) return matter;
  if(matter) return matter.slice(0, 97) + "...";
  const agenda = String(entry.agendaTitle || "");
  const paren = agenda.match(/\(([^)]{5,90})\)/);
  if(paren) return paren[1].trim();
  if(agenda.length > 100) return agenda.slice(0, 97) + "...";
  return agenda || "—";
}

function collapseMeetingAgenda(items){
  const byKey = new Map();
  let procedural = 0;
  let actionRows = 0;
  for(const item of (Array.isArray(items) ? items : [])){
    const agendaTitle = item.title || item.body_text || "";
    const agendaNumber = item.agenda_number || "";
    const list = Array.isArray(item.matters) && item.matters.length ? item.matters : [null];
    for(const matter of list){
      if(!matter || !matter.matter_id){
        procedural += 1;
        continue;
      }
      actionRows += 1;
      const key = String(matter.matter_file || matter.matter_id);
      let entry = byKey.get(key);
      if(!entry){
        entry = {
          matter_id: matter.matter_id,
          matter_file: matter.matter_file || "",
          matter_url: matter.matter_url || matterDetailUrl(matter.matter_id) || "",
          title: matter.title || "",
          agendaTitle,
          agendaNumber,
          status: matter.status || "",
          actions: [],
          documents: [],
          finalVotes: [],
          finalOutcome: "",
          finalPassed: ""
        };
        byKey.set(key, entry);
      }
      if((agendaTitle || "").length > (entry.agendaTitle || "").length) entry.agendaTitle = agendaTitle;
      if(agendaNumber && !entry.agendaNumber) entry.agendaNumber = agendaNumber;
      if(matter.title) entry.title = matter.title;
      if(matter.status) entry.status = matter.status;
      if(!entry.matter_url){
        entry.matter_url = matter.matter_url || matterDetailUrl(matter.matter_id) || "";
      }
      const outcome = matter.outcome || matter.passed || matter.status || "";
      if(outcome) entry.actions.push(outcome);
      if(matter.outcome) entry.finalOutcome = matter.outcome;
      if(matter.passed) entry.finalPassed = matter.passed;
      if(Array.isArray(matter.votes) && matter.votes.length) entry.finalVotes = matter.votes;
      for(const doc of (Array.isArray(matter.documents) ? matter.documents : [])){
        if(doc && doc.url && !entry.documents.some(x => x && x.url === doc.url)) entry.documents.push(doc);
      }
    }
  }
  return { matters: Array.from(byKey.values()), procedural, actionRows };
}

function officialIdFromPerson(p){
  if(!p || typeof p !== "object") return "";
  const raw = (p.official && p.official.id) || p.person_id || "";
  const s = String(raw || "").trim();
  if(!s) return "";
  return s.startsWith("official:") ? s.slice("official:".length) : s;
}

function officialHref(personId, ctx){
  const id = String(personId || "").trim();
  if(!id) return "";
  if(globalThis.CrolEntityPivots){
    return globalThis.CrolEntityPivots.entityHref({
      ref: globalThis.CrolEntityPivots.entityRouteRef("official", id),
      label: id,
    }, ctx || {});
  }
  const q = new URLSearchParams();
  if(ctx && ctx.eventId) q.set("event", String(ctx.eventId));
  if(ctx && ctx.noticeId) q.set("notice", String(ctx.noticeId));
  const qs = q.toString();
  return `#official/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`;
}

function collectRollCallPeople(votes){
  if(!Array.isArray(votes) || !votes.length) return [];
  const out = [];
  const seen = new Set();
  for(const v of votes){
    if(!v || v.vote_identity === "tally_only") continue;
    const people = Array.isArray(v.by_person) ? v.by_person : [];
    for(const p of people){
      const id = officialIdFromPerson(p);
      const name = (p.official && p.official.display_name) || p.person_name || "";
      if(!id || !name) continue;
      const key = id + "\0" + (p.vote_bucket || p.vote_value || "");
      if(seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

function meetingRollCallChipHTML(votes, ctx){
  const people = collectRollCallPeople(votes);
  if(!people.length) return "";
  const n = people.length;
  const show = people.slice(0, 4);
  const more = n - show.length;
  const names = show.map(p => {
    const id = officialIdFromPerson(p);
    const name = (p.official && p.official.display_name) || p.person_name || id;
    const officialLink = officialHref(id, ctx);
    const label = escUiHtml(name);
    const typed = globalThis.CrolEntityPivots?.entityChipHTML({
      ref: globalThis.CrolEntityPivots.entityRouteRef("official", id),
      label: name,
      link_confidence: "strong",
      relation: "votes_as_official",
    }, { ...(ctx || {}), className: "meeting-official-link" });
    return typed
      ? `<span data-official-id="${escUiHtml(id)}" lang="en" dir="ltr">${typed}</span>`
      : officialLink
      ? `<a class="meeting-official-link" href="${escUiHtml(officialLink)}" data-official-id="${escUiHtml(id)}" lang="en" dir="ltr">${label}</a>`
      : `<span lang="en" dir="ltr" data-official-id="${escUiHtml(id)}">${label}</span>`;
  }).join(", ");
  const moreHTML = more > 0
    ? ` <span class="meeting-roll-call-more">${t("meeting_outcomes_roll_call_more",{n:String(more)})}</span>`
    : "";
  return `<div class="meeting-roll-call-chip" data-official-votes data-official-count="${n}" data-vote-identity="roll_call">
    <span class="meeting-roll-call-chip-lbl">${t("meeting_outcomes_roll_call_lbl")}</span>
    <span class="meeting-roll-call-names">${t("meeting_outcomes_roll_call_chip_html",{
      n: String(n),
      names: names + moreHTML
    })}</span>
  </div>`;
}

function meetingRollCallTableHTML(people, ctx){
  if(!Array.isArray(people) || !people.length) return "";
  const rows = people.map(p => {
    const id = officialIdFromPerson(p);
    const name = (p.official && p.official.display_name) || p.person_name || p.person_id || "—";
    const vote = p.vote_bucket || p.vote_value || "—";
    const officialLink = officialHref(id, ctx);
    const typed = globalThis.CrolEntityPivots?.entityChipHTML({
      ref: globalThis.CrolEntityPivots.entityRouteRef("official", id),
      label: name,
      link_confidence: "strong",
      relation: "votes_as_official",
    }, { ...(ctx || {}), className: "meeting-official-link" });
    const nameHTML = typed
      || (officialLink
      ? `<a class="meeting-official-link" href="${escUiHtml(officialLink)}" data-official-id="${escUiHtml(id)}">${escUiHtml(name)}</a>`
      : escUiHtml(name));
    return `<tr data-official-id="${escUiHtml(id)}" data-vote-bucket="${escUiHtml(String(p.vote_bucket || ""))}">
      <th scope="row" lang="en" dir="ltr" class="meeting-roll-call-person">${nameHTML}</th>
      <td lang="en" dir="ltr">${escUiHtml(String(vote))}</td>
    </tr>`;
  }).join("");
  return `<table class="meeting-roll-call-table" data-official-votes data-official-count="${people.length}">
    <caption class="meeting-roll-call-caption">${t("meeting_outcomes_roll_call_lbl")}</caption>
    <thead>
      <tr>
        <th scope="col">${t("meeting_outcomes_roll_call_member_col")}</th>
        <th scope="col">${t("meeting_outcomes_roll_call_vote_col")}</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function meetingVotesHTML(votes, ctx){
  if(!Array.isArray(votes) || !votes.length) return "";
  return votes.map(v => {
    const c = v.counts || {};
    const aye = Number(c.aye) || 0;
    const nay = Number(c.nay) || 0;
    const people = (v && v.vote_identity === "tally_only")
      ? []
      : (Array.isArray(v.by_person) ? v.by_person : []);
    const meaningful = people.length > 0 || aye > 0 || nay > 0;
    let html = "";
    if(meaningful){
      html += `<div class="lc-pct">${t("meeting_outcomes_vote_html",{
        result: escUiHtml(v.result || "—"),
        aye: String(c.aye != null ? c.aye : "—"),
        nay: String(c.nay != null ? c.nay : "—")
      })}</div>`;
    }
    if(people.length){
      html += `<div class="meeting-roll-call" data-official-votes data-official-count="${people.length}">${meetingRollCallTableHTML(people, ctx)}</div>`;
    }
    return html;
  }).join("");
}

let meetingPhaseSpineToolsPromise=null;
function ensureMeetingPhaseSpineTools(){
  if(!meetingPhaseSpineToolsPromise){
    meetingPhaseSpineToolsPromise=import("../meeting_phase_spine.mjs").catch(()=>null);
  }
  return meetingPhaseSpineToolsPromise;
}

function meetingPhaseLabel(phase){
  if(!phase) return "—";
  if(phase.label_key) return t(phase.label_key);
  if(typeof phase==="string"){
    const meta={
      agenda:"meeting_phase_agenda",
      matter:"meeting_phase_matter",
      decision:"meeting_phase_decision",
      record:"meeting_phase_record"
    };
    return meta[phase]?t(meta[phase]):phase;
  }
  return phase.short || "—";
}

function meetingPhaseGapHTML(phase){
  return "";
}

function meetingPhasePanelHTML(phase, view, voteCtx){
  if(!phase) return "";
  const open=phase.state==="current"?" open":"";
  const stateWord=phase.state==="current"?t("meeting_phase_current")
    :phase.state==="passed"?t("meeting_phase_done")
    :t("meeting_phase_future");
  let summary="";
  if(phase.state==="future" && !phase.matched) return "";
  if(phase.id==="decision"){
    const label=phase.action_name||phase.vote_result||"";
    const multi=(phase.aggregates||[]).filter(a=>a.count>=2);
    const multiNote=multi.length
      ? multi.map(a=>`${a.title} ×${a.count}`).join(" · ")
      : "";
    summary=[label, multiNote].filter(Boolean).join(" · ");
  }else if(phase.id==="record"){
    const n=(phase.documents||[]).length;
    summary=n?t("meeting_phase_docs_count",{n:String(n)}):"";
  }else if(phase.id==="matter"){
    summary=phase.matter_file||phase.matter_title||"";
  }else if(phase.id==="agenda"){
    summary=phase.agenda_title||(phase.agenda_number?("#"+phase.agenda_number):"");
  }

  let body="";
  if(phase.id==="decision"){
    if(phase.action_name){
      body+=`<div class="lc-pct" lang="en" dir="ltr">${t("meeting_outcomes_outcome_html",{
        outcome:escUiHtml(phase.action_name)
      })}</div>`;
    }
    const multi=(phase.aggregates||[]).filter(a=>a.count>=2);
    if(multi.length){
      body+=multi.map(a=>`<p class="meeting-phase-agg" lang="en" dir="ltr">${escUiHtml(a.title)} ×${a.count}</p>`).join("");
    }
    if(phase.voice_vote){
      body+=`<div class="lc-pct">${t("meeting_phase_voice_vote_html")}</div>`;
    }else{
      const votes=Array.isArray(phase.votes)&&phase.votes.length
        ? phase.votes
        : (phase.counts||phase.vote_result
          ? [{result:phase.vote_result,counts:phase.counts,by_person:phase.by_person||[]}]
          : []);
      const voteHTML=meetingVotesHTML(votes, voteCtx);
      if(voteHTML) body+=voteHTML;
    }
  }else if(phase.id==="record"){
    const docs=phase.documents||[];
    if(docs.length){
      body=`<div class="meeting-phase-docs">${docs.slice(0,8).map(d=>
        `<a class="view" href="${escUiHtml(d.url)}" ${EXT_ATTRS}>${escUiHtml(d.name||d.document_id||t("meeting_outcomes_document_lbl"))}${extSR()}</a>`
      ).join("")}</div>`;
    }
  }else if(phase.id==="matter"){
    const bits=[];
    if(phase.matter_title) bits.push(`<div lang="en" dir="ltr">${escUiHtml(phase.matter_title)}</div>`);
    if(phase.matter_status) bits.push(`<div class="lc-pct" lang="en" dir="ltr">${escUiHtml(phase.matter_status)}</div>`);
    if(phase.matter_url||(phase.matched&&view.official_url)){
      const href=phase.matter_url||view.official_url;
      bits.push(`<a class="view" href="${escUiHtml(href)}" ${EXT_ATTRS}>${t("meeting_phase_open_legislation")}${extSR()}</a>`);
    }
    body=bits.join("");
  }else if(phase.id==="agenda"){
    const bits=[];
    if(phase.agenda_number) bits.push(`<div class="lc-pct">#${escUiHtml(phase.agenda_number)}</div>`);
    if(phase.agenda_title) bits.push(`<div lang="en" dir="ltr">${escUiHtml(phase.agenda_title)}</div>`);
    body=bits.join("");
  }
  if(!body) return "";

  return `<details class="lc-phase${phase.state==="current"?" current-phase":""}"${open} id="meeting-phase-${escUiHtml((view.matter_id||"x")+"-"+phase.id)}" data-meeting-phase-panel="${escUiHtml(phase.id)}">
    <summary>
      <span class="lc-phase-name">${escUiHtml(meetingPhaseLabel(phase))}</span>
      <span class="lc-phase-state">${escUiHtml(stateWord)}</span>
      <span class="lc-phase-summary" lang="en" dir="ltr">${escUiHtml(summary)}</span>
    </summary>
    <div class="lc-phase-body">${body}</div>
  </details>`;
}

function meetingPhaseStepperHTML(view){
  if(!view || !view.phases || !view.phases.length) return "";
  const items=view.phases.map((p,i)=>{
    const cls=p.state==="current"?"current":p.state==="passed"?"passed":"future";
    const aria=p.state==="current"?` aria-current="step"`:"";
    const arrow=i<view.phases.length-1
      ? `<span class="lc-step-arrow" aria-hidden="true">→</span>`
      : "";
    return `<li><button type="button" class="lc-step ${cls}" data-meeting-phase="${escUiHtml(p.id)}"${aria} title="${escUiHtml(meetingPhaseLabel(p))}">${escUiHtml(p.short||meetingPhaseLabel(p))}</button>${arrow}</li>`;
  }).join("");
  return `<ol class="lc-stepper lc-phase-stepper meeting-phase-stepper" aria-label="${escUiHtml(t("meeting_phase_timeline_lbl"))}">${items}</ol>`;
}

function meetingPhaseLeadHTML(view){
  if(!view || !view.current) return "";
  const cur=view.current;
  const phaseName=meetingPhaseLabel({label_key:cur.label_key});
  let actionHTML="";
  if(cur.lead_action==="open_legislation" && view.official_url){
    actionHTML=`<a class="act primary" href="${escUiHtml(view.official_url)}" ${EXT_ATTRS}>${t("meeting_phase_open_legislation")}${extSR()}</a>`;
  }else if(cur.lead_action==="view_tally"){
    actionHTML=`<span class="lc-phase-action-text">${t("meeting_phase_action_decision")}</span>`;
  }else if(cur.lead_action==="view_outcome"){
    actionHTML=`<span class="lc-phase-action-text">${t("meeting_phase_action_decision")}</span>`;
  }else if(cur.lead_action==="view_docs"){
    actionHTML=`<span class="lc-phase-action-text">${t("meeting_phase_action_record")}</span>`;
  }else if(cur.lead_action==="read_agenda"){
    actionHTML=`<span class="lc-phase-action-text">${t("meeting_phase_action_agenda")}</span>`;
  }else if(view.official_url){
    actionHTML=`<a class="act" href="${escUiHtml(view.official_url)}" ${EXT_ATTRS}>${t("meeting_phase_open_legislation")}${extSR()}</a>`;
  }
  const milestone=cur.milestone_label
    ? `<p class="lc-phase-now-detail" lang="en" dir="ltr">${escUiHtml(cur.milestone_label)}</p>`
    : "";
  return `<div class="lc-phase-lead meeting-spine-lead">
    <div class="lc-phase-now-label">${t("meeting_phase_now_label")}</div>
    <p class="lc-phase-now-phase">${escUiHtml(phaseName)}</p>
    ${milestone}
    ${actionHTML?`<p class="lc-phase-action">${actionHTML}</p>`:""}
    ${view.next?`<p class="lc-phase-next">${t("meeting_phase_next_html",{phase:escUiHtml(meetingPhaseLabel(view.next))})}</p>`:""}
  </div>`;
}

function meetingMatterPhaseHTML(view, voteCtx){
  if(!view || view.empty) return "";
  const lead=meetingPhaseLeadHTML(view);
  const stepper=meetingPhaseStepperHTML(view);
  const currentPanel=(view.phases||[]).filter(p=>p.state==="current")
    .map(p=>meetingPhasePanelHTML(p, view, voteCtx)).join("");
  const historyPanels=(view.phases||[]).filter(p=>p.state==="passed")
    .map(p=>meetingPhasePanelHTML(p, view, voteCtx)).filter(Boolean).join("");
  const futurePanels=(view.phases||[]).filter(p=>p.state==="future"&&p.matched)
    .map(p=>meetingPhasePanelHTML(p, view, voteCtx)).join("");
  const historyWrap=historyPanels
    ? `<details class="lc-phase-history"><summary>${t("meeting_phase_show_history")}</summary>${historyPanels}</details>`
    : "";
  return `<div class="meeting-matter-phase" data-meeting-matter-phase data-matter-id="${escUiHtml(view.matter_id||"")}">
    ${lead}
    ${stepper}
    ${currentPanel}
    ${futurePanels}
    ${historyWrap}
  </div>`;
}

function bindMeetingPhaseUI(root){
  if(!root || root.dataset.meetingPhaseBound==="1") return;
  root.dataset.meetingPhaseBound="1";
  root.addEventListener("click",(ev)=>{
    const step=ev.target.closest?.("[data-meeting-phase]");
    if(!step || !root.contains(step)) return;
    const matterRoot=step.closest?.("[data-meeting-matter-phase]")||root;
    const id=step.getAttribute("data-meeting-phase");
    const panel=matterRoot.querySelector(`[data-meeting-phase-panel="${CSS.escape(id)}"]`);
    if(panel){
      const hist=panel.closest?.(".lc-phase-history");
      if(hist) hist.open=true;
      panel.open=true;
      try{ panel.scrollIntoView({behavior:"smooth",block:"nearest"}); }catch(_e){}
    }
  });
}

function meetingOutcomesHTML(record, notice, phaseTools){
  if(!record) return "";
  const join = record.join || {};
  if(!join.matched) return "";
  const event = record.council_event || {};
  const items = Array.isArray(record.agenda_items) ? record.agenda_items : [];
  const eventDocs = Array.isArray(event.documents) ? event.documents : [];
  const collapsed = collapseMeetingAgenda(items);
  const matters = collapsed.matters;
  const usePhase = phaseTools && typeof phaseTools.buildPhaseViewForMatter === "function";
  const voteCtx = {
    eventId: event.event_id || null,
    noticeId: record.request_id || (notice && notice.request_id) || null,
  };

  let approved = 0, held = 0, referred = 0, other = 0;
  for(const entry of matters){
    const label = entry.finalOutcome || entry.finalPassed || entry.status || (entry.actions[entry.actions.length - 1] || "");
    if(!label) continue;
    const bucket = meetingOutcomeBucket(label);
    if(bucket === "approved") approved += 1;
    else if(bucket === "held") held += 1;
    else if(bucket === "referred") referred += 1;
    else other += 1;
  }

  const chips = [];
  if(approved > 0) chips.push(`<span class="meeting-chip meeting-chip--ok"><strong>${approved}</strong> ${t("meeting_outcomes_chip_approved")}</span>`);
  if(held > 0) chips.push(`<span class="meeting-chip meeting-chip--mid"><strong>${held}</strong> ${t("meeting_outcomes_chip_held")}</span>`);
  if(referred > 0) chips.push(`<span class="meeting-chip"><strong>${referred}</strong> ${t("meeting_outcomes_chip_referred")}</span>`);
  if(other > 0) chips.push(`<span class="meeting-chip"><strong>${other}</strong> ${t("meeting_outcomes_chip_other")}</span>`);
  if(matters.length) chips.push(`<span class="meeting-chip"><strong>${matters.length}</strong> ${t("meeting_outcomes_chip_matters")}${collapsed.actionRows > matters.length ? ` · <strong>${collapsed.actionRows}</strong> ${t("meeting_outcomes_chip_actions_collapsed")}` : ""}</span>`);
  if(collapsed.procedural > 0){
    chips.push(`<span class="meeting-chip"><strong>${collapsed.procedural}</strong> ${t("meeting_outcomes_chip_procedural_hidden")}</span>`);
  }

  const eventDocHTML = eventDocs.length
    ? `<div class="meeting-event-docs"><span class="meeting-docs-lbl">${t("meeting_outcomes_docs_lbl")}</span>${eventDocs.map(d =>
        `<a class="view" href="${escUiHtml(d.url)}" ${EXT_ATTRS}>${escUiHtml(d.name || d.document_id || t("meeting_outcomes_document_lbl"))}${extSR()}</a>`
      ).join("")}</div>`
    : "";

  let listHTML = "";
  for(const entry of matters){
    const finalLabel = entry.finalOutcome || entry.finalPassed || entry.status || (entry.actions[entry.actions.length - 1] || "");
    const bucket = finalLabel?meetingOutcomeBucket(finalLabel):"";
    const badgeKey = bucket === "approved" ? "meeting_outcomes_badge_approved"
      : bucket === "held" ? "meeting_outcomes_badge_held"
      : bucket === "referred" ? "meeting_outcomes_badge_referred"
      : "meeting_outcomes_badge_other";
    const shortTitle = meetingMatterShortTitle(entry);
    const fileLine = entry.matter_file || entry.matter_id || "";
    const matterHref = entry.matter_url || matterDetailUrl(entry.matter_id) || "";
    const fileHTML = matterHref&&fileLine
      ? `<a class="meeting-file meeting-matter-link" lang="en" dir="ltr" href="${escUiHtml(matterHref)}" ${EXT_ATTRS} data-matter-id="${escUiHtml(entry.matter_id || "")}">${escUiHtml(fileLine)}${extSR()}</a>`
      : (fileLine?`<div class="meeting-file" lang="en" dir="ltr">${escUiHtml(fileLine)}</div>`:"");
    const subBits = [];
    if(entry.agendaNumber) subBits.push("#" + entry.agendaNumber);
    if(entry.title && entry.title !== shortTitle) subBits.push(entry.title);
    else if(entry.status && entry.status !== finalLabel) subBits.push(entry.status);

    let phaseHTML = "";
    if(usePhase){
      const view = phaseTools.buildPhaseViewForMatter(entry, record);
      phaseHTML = meetingMatterPhaseHTML(view, voteCtx);
    }

    let voteHTML = meetingVotesHTML(entry.finalVotes, voteCtx);
    if(!voteHTML){
      if(finalLabel){
        voteHTML = `<div class="lc-pct">${t("meeting_outcomes_outcome_html",{
          outcome: escUiHtml(finalLabel)
        })}</div>`;
      }
    }

    const rollCallChip = meetingRollCallChipHTML(entry.finalVotes, voteCtx);

    const history = entry.actions.length
      ? `<dt>${t("meeting_outcomes_action_history_lbl")}</dt>
         <dd><ol class="meeting-actions">${entry.actions.map(a => `<li lang="en" dir="ltr">${escUiHtml(a)}</li>`).join("")}</ol></dd>`
      : "";
    const matterDocs = entry.documents.length
      ? `<dt>${t("meeting_outcomes_attachments_lbl")}</dt>
         <dd class="meeting-matter-docs">${entry.documents.slice(0, 6).map(d =>
           `<a class="view" href="${escUiHtml(d.url)}" ${EXT_ATTRS}>${escUiHtml(d.name || d.document_id || t("meeting_outcomes_document_lbl"))}${extSR()}</a>`
         ).join("")}</dd>`
      : "";
    const agendaText = entry.agendaTitle && entry.agendaTitle !== shortTitle && entry.agendaTitle !== entry.title
      ? `<dt>${t("meeting_outcomes_agenda_text_lbl")}</dt><dd lang="en" dir="ltr">${escUiHtml(entry.agendaTitle)}</dd>`
      : "";

    const detailsSummary = usePhase
      ? t("meeting_outcomes_details_summary_phase")
      : t("meeting_outcomes_details_summary");

    const finalOutcomeDetail=finalLabel
      ? `<dt>${t("meeting_outcomes_final_outcome_lbl")}</dt><dd lang="en" dir="ltr">${escUiHtml(finalLabel)}</dd>`
      : "";
    const matterTitle=entry.title||entry.matter_id||"";
    const matterTitleDetail=matterTitle
      ? `<dt>${t("meeting_outcomes_matter_title_lbl")}</dt><dd lang="en" dir="ltr">${escUiHtml(matterTitle)}</dd>`
      : "";
    const voteDetail=voteHTML
      ? `<dt>${t("meeting_outcomes_outcome_lbl")}</dt><dd>${voteHTML}</dd>`
      : "";
    const detailRows=`${finalOutcomeDetail}${history}${matterTitleDetail}${agendaText}${voteDetail}${matterDocs}`;
    const details=detailRows
      ? `<details class="meeting-more"><summary>${detailsSummary}</summary><div class="meeting-detail"><dl>${detailRows}</dl></div></details>`
      : "";

    listHTML += `<li class="meeting-matter" data-meeting-spine data-meeting-matter data-outcome-bucket="${bucket}">
      <div class="meeting-matter-main">
        <div>
          ${fileHTML}
          <p class="meeting-title" lang="en" dir="ltr">${escUiHtml(shortTitle)}</p>
          ${subBits.length ? `<p class="meeting-sub" lang="en" dir="ltr">${escUiHtml(subBits.join(" · "))}</p>` : ""}
          ${rollCallChip}
        </div>
        ${bucket?`<span class="meeting-badge meeting-badge--${bucket}">${t(badgeKey)}</span>`:""}
      </div>
      ${phaseHTML}
      ${details}
    </li>`;
  }

  if(listHTML){
    listHTML = `<ol class="meeting-agenda">${listHTML}</ol>`;
  }

  const eventName=event.body_name||event.title||event.event_id||"";
  const eventDate=event.start_time ? fdate(String(event.start_time).slice(0,10)) : (event.event_date || "");
  const eventLink = event.event_url&&eventName
    ? `<a class="view" href="${escUiHtml(event.event_url)}" ${EXT_ATTRS}>${escUiHtml(eventName)}${extSR()}</a>`
    : escUiHtml(eventName);
  const matchedNote=eventLink&&eventDate
    ? `<div class="note">${t("meeting_outcomes_matched_html",{event:eventLink,date:eventDate})}</div>`
    : "";
  const how = usePhase
    ? `<details class="inline-disclose lc-how"><summary>${t("meeting_phase_how_summary")}</summary><div class="inline-disclose-body">${t("meeting_phase_how_html")}</div></details>`
    : "";
  return `<div class="chain-h">${t("meeting_outcomes_heading")}</div>
    ${matchedNote}
    ${chips.length?`<div class="meeting-summary" role="group" aria-label="${escUiHtml(t("meeting_outcomes_summary_lbl"))}">${chips.join("")}</div>`:""}
    ${eventDocHTML}
    ${listHTML}
    ${how}
    <div class="note">${t("meeting_outcomes_provenance_html")}</div>`;
}

async function loadMeetingOutcomes(r, el){
  if(!el || !r.request_id) return;
  const eligible = isMeetingOutcomesEligible(r);
  const nonCouncil = r.section_name === "Public Hearings and Meetings" && !isCityCouncilNotice(r);
  const panelHTMLPromise = nonCouncil
    ? import("../non_council_outcome_panel.mjs").then((tools) => tools.loadNonCouncilOutcomePanel(r.request_id, {
        lang: window.LANG, esc: escUiHtml, date: fdate, externalSuffixHTML: extSR,
      })).catch(() => "")
    : Promise.resolve("");
  let data = null;
  try{
    const resp = await workerFetch("/meeting-outcomes?id=" + encodeURIComponent(r.request_id), null, 8000);
    if(resp && resp.ok) data = await resp.json();
  }catch(e){}
  const panelHTML = await panelHTMLPromise;
  if(!document.contains(el)) return;
  if(!data || data.ok === false || !data.record){
    if(panelHTML) el.insertAdjacentHTML("beforeend",panelHTML);
    return;
  }
  if(!eligible && !(data.record.join && data.record.join.matched)) return;
  const phaseTools = await ensureMeetingPhaseSpineTools();
  if(!document.contains(el)) return;
  const liveHTML=meetingOutcomesHTML(data.record, r, phaseTools);
  if(liveHTML || panelHTML) el.innerHTML = [liveHTML, panelHTML].filter(Boolean).join("");
  bindMeetingPhaseUI(el);
}

globalThis.bindMeetingPhaseUI = bindMeetingPhaseUI;
globalThis.collapseMeetingAgenda = collapseMeetingAgenda;
globalThis.collectRollCallPeople = collectRollCallPeople;
globalThis.ensureMeetingPhaseSpineTools = ensureMeetingPhaseSpineTools;
globalThis.isCityCouncilNotice = isCityCouncilNotice;
globalThis.isMeetingOutcomesEligible = isMeetingOutcomesEligible;
globalThis.loadMeetingOutcomes = loadMeetingOutcomes;
globalThis.matterDetailUrl = matterDetailUrl;
globalThis.meetingMatterPhaseHTML = meetingMatterPhaseHTML;
globalThis.meetingMatterShortTitle = meetingMatterShortTitle;
globalThis.meetingOutcomeBucket = meetingOutcomeBucket;
globalThis.meetingOutcomesHTML = meetingOutcomesHTML;
globalThis.meetingPhaseGapHTML = meetingPhaseGapHTML;
globalThis.meetingPhaseLabel = meetingPhaseLabel;
globalThis.meetingPhaseLeadHTML = meetingPhaseLeadHTML;
globalThis.meetingPhasePanelHTML = meetingPhasePanelHTML;
globalThis.meetingPhaseStepperHTML = meetingPhaseStepperHTML;
globalThis.meetingRollCallChipHTML = meetingRollCallChipHTML;
globalThis.meetingRollCallTableHTML = meetingRollCallTableHTML;
globalThis.meetingVotesHTML = meetingVotesHTML;
globalThis.nonCouncilBodyLinks = nonCouncilBodyLinks;
globalThis.nonCouncilHearingOutcomesHTML = nonCouncilHearingOutcomesHTML;
globalThis.nonCouncilStageLabel = nonCouncilStageLabel;
globalThis.nonCouncilWhereHTML = nonCouncilWhereHTML;
globalThis.officialHref = officialHref;
globalThis.officialIdFromPerson = officialIdFromPerson;
Object.defineProperty(globalThis, "meetingPhaseSpineToolsPromise", { configurable: true, get: () => meetingPhaseSpineToolsPromise, set: value => { meetingPhaseSpineToolsPromise = value; } });
