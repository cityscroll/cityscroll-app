/**
 * Browser boot for the opt-in capability-compare pilot page.
 * Default off: without the beta flag the page explains how to enable it and
 * does not run the comparison. Pursuit notes and watches are never touched.
 */

import {
  CAPABILITY_COMPARE_BETA_SLUG,
  applyCapabilityProfileToSearchParams,
  buildCapabilityJourney,
  profileFromFormValues,
  renderCapabilityJourneyHtml,
  resolveInitialCapabilityProfile,
  writeCapabilityProfileToStorage,
} from "../procurement_capability_journey.mjs";

const CORPUS_URL = new URL("../data/procurement_capability_compare_corpus.json", import.meta.url);

function sessionStore() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function persistProfile(profile) {
  writeCapabilityProfileToStorage(sessionStore(), profile);
  try {
    const url = new URL(location.href);
    applyCapabilityProfileToSearchParams(url.searchParams, profile);
    if (!url.searchParams.get("beta")) {
      url.searchParams.set("beta", CAPABILITY_COMPARE_BETA_SLUG);
    }
    history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // History/URL sync is best-effort; sessionStorage is the Back remount source.
  }
}

function flagIsOn() {
  if (globalThis.CROL_BETA_FLAG === CAPABILITY_COMPARE_BETA_SLUG) return true;
  if (document.documentElement?.dataset?.betaFlag === CAPABILITY_COMPARE_BETA_SLUG) return true;
  const params = new URLSearchParams(location.search);
  return params.get("beta") === CAPABILITY_COMPARE_BETA_SLUG;
}

function mountOffState(root) {
  const section = document.createElement("section");
  section.className = "capability-journey";
  section.dataset.capabilityJourneyOff = "";

  const title = document.createElement("h1");
  title.textContent = t("capability_compare_title");

  const deck = document.createElement("p");
  deck.textContent = t("capability_compare_off_deck");

  const turnOn = document.createElement("p");
  const turnOnLink = document.createElement("a");
  turnOnLink.href = `?beta=${CAPABILITY_COMPARE_BETA_SLUG}`;
  turnOnLink.textContent = t("capability_compare_turn_on");
  turnOn.append(turnOnLink, document.createTextNode(t("capability_compare_turn_on_suffix")));

  const back = document.createElement("p");
  const backLink = document.createElement("a");
  backLink.href = "/browse/contracts/";
  backLink.textContent = t("capability_compare_back");
  back.append(backLink);

  section.append(title, deck, turnOn, back);
  root.replaceChildren(section);
}

async function loadCorpus() {
  const response = await fetch(CORPUS_URL, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (!payload || !Array.isArray(payload.records)) {
    throw new Error("corpus missing records");
  }
  return payload.records;
}

function bindForm(root, state, redraw) {
  const form = root.querySelector("[data-capability-profile-form]");
  if (!form) return;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    state.profile = profileFromFormValues({
      capability_keywords: data.get("capability_keywords"),
      jet_vac_truck: data.get("jet_vac_truck"),
      landscaping: data.get("landscaping"),
    });
    persistProfile(state.profile);
    redraw();
  });
  const retry = root.querySelector("[data-capability-retry]");
  if (retry) {
    retry.addEventListener("click", () => {
      state.loadError = null;
      void refreshRecords(state, redraw);
    });
  }
}

async function refreshRecords(state, redraw) {
  try {
    state.records = await loadCorpus();
    state.loadError = null;
  } catch (error) {
    state.loadError = error?.message || String(error);
    // Preserve profile; do not clear prior successful records on retry failure
    // only when we never had any — leave records as last good or empty.
    if (!Array.isArray(state.records)) state.records = [];
  }
  redraw();
}

function paint(root, state) {
  const journey = buildCapabilityJourney({
    profile: state.profile,
    records: state.loadError ? [] : state.records,
    loadError: state.loadError,
  });
  root.innerHTML = renderCapabilityJourneyHtml(journey, {
    headingId: "capability-compare-heading",
  });
  // Replace the journey h2 with an h1 for the standalone page landmark.
  const heading = root.querySelector("#capability-compare-heading");
  if (heading && heading.tagName === "H2") {
    const h1 = document.createElement("h1");
    h1.id = heading.id;
    h1.textContent = heading.textContent;
    heading.replaceWith(h1);
  }
  bindForm(root, state, () => paint(root, state));
}

export async function bootCapabilityCompare(root = document.getElementById("capability-compare-root")) {
  if (!root) return { active: false };
  if (!flagIsOn()) {
    mountOffState(root);
    return { active: false };
  }
  const searchParams = new URLSearchParams(location.search);
  const profile = resolveInitialCapabilityProfile({
    searchParams,
    storage: sessionStore(),
  });
  // Mirror the resolved profile into sessionStorage so a later Back remount
  // still restores when the URL was stripped of profile fields.
  writeCapabilityProfileToStorage(sessionStore(), profile);
  const state = {
    profile,
    records: [],
    loadError: null,
  };
  await refreshRecords(state, () => paint(root, state));
  return { active: true, state };
}

if (typeof document !== "undefined") {
  const start = () => {
    void bootCapabilityCompare();
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
  document.addEventListener("crol:beta-flag-ready", start);
}
