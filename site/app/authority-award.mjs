/* ===================== OFFICIAL AUTHORITY AWARD (RC-4) =====================
   Receipt-gated City Record -> NYS Authorities Budget Office award edges.
   Current unresolved notices stay silent; no candidate or below-threshold row is rendered. */
let aboAwardPayloadPromise = null;
let aboAwardPanelToolsPromise = null;

function isAboAuthorityNotice(r){
  if(!r || !r.request_id || typeof awardSourceFor !== "function") return false;
  const source = awardSourceFor(r.agency_name || "");
  return Boolean(source && source.kind === "abo");
}

function loadAboAwardPayload(){
  if(!aboAwardPayloadPromise){
    aboAwardPayloadPromise = fetch("data/abo_award_residual_lookup.json", {cache:"no-cache"})
      .then(resp => resp.ok ? resp.json() : null)
      .catch(() => null);
  }
  return aboAwardPayloadPromise;
}

function loadAboAwardPanelTools(){
  if(!aboAwardPanelToolsPromise){
    aboAwardPanelToolsPromise = import("../abo_award_panel.mjs").catch(() => null);
  }
  return aboAwardPanelToolsPromise;
}

function aboAwardPanelHTML(match, sourceUrl){
  if(!match || !sourceUrl) return "";
  return `<div class="chain-h">${t("external_awards_heading")}</div>
    <section class="lc-phase-lead" data-abo-award-panel="1" aria-label="${escUiHtml(t("lifecycle_stage_award"))}">
      <div class="lc-phase-now-label">${t("lifecycle_stage_award")} · ${t("external_awards_abo_source")}</div>
      <p class="lc-phase-now-phase" lang="en" dir="ltr">${escUiHtml(match.vendor)}</p>
      <div class="lc-phase-facts">
        <p class="lc-phase-fact"><b>${t("award_guide_amount_label")}:</b> ${lifecycleMoney(match.amount)}</p>
        <p class="lc-phase-fact" lang="en" dir="ltr"><b>${escUiHtml(match.authority)}</b> · ${fdate(match.award_date)}</p>
      </div>
      <a class="view" data-abo-award-source="1" href="${escUiHtml(sourceUrl)}" ${EXT_ATTRS}>${t("external_awards_abo_source")}${extSR()}</a>
    </section>`;
}

async function loadAboAuthorityAward(r, el){
  if(!el || !isAboAuthorityNotice(r)) return false;
  const [payload, tools] = await Promise.all([loadAboAwardPayload(), loadAboAwardPanelTools()]);
  if(!document.contains(el) || !payload || !tools) return false;
  const match = tools.releasedAboAward(payload, r.request_id);
  if(!match) return false;
  const sourceUrl = tools.aboAwardSourceUrl(match);
  if(!sourceUrl) return false;
  el.innerHTML = aboAwardPanelHTML(match, sourceUrl);
  return true;
}

globalThis.aboAwardPanelHTML = aboAwardPanelHTML;
globalThis.isAboAuthorityNotice = isAboAuthorityNotice;
globalThis.loadAboAuthorityAward = loadAboAuthorityAward;
Object.defineProperty(globalThis, "aboAwardPayloadPromise", { configurable:true, get:()=>aboAwardPayloadPromise, set:value=>{ aboAwardPayloadPromise=value; } });
Object.defineProperty(globalThis, "aboAwardPanelToolsPromise", { configurable:true, get:()=>aboAwardPanelToolsPromise, set:value=>{ aboAwardPanelToolsPromise=value; } });
