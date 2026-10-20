/**
 * Browser boot for the opt-in program-history pilot page.
 * Default off: without the beta flag the page explains how to enable it.
 * Pursuit notes and watches are never touched.
 */

import {
  PROGRAM_HISTORY_BETA_SLUG,
  DEFAULT_TRAINING_PROFILE,
  buildProgramJourney,
  profileFromFormValues,
  renderProgramJourneyHtml,
} from "../procurement_program_journey.mjs";

const CORPUS_URL = new URL(
  "../data/procurement_program_capabilities_corpus.json",
  import.meta.url,
);

function flagIsOn() {
  if (globalThis.CROL_BETA_FLAG === PROGRAM_HISTORY_BETA_SLUG) return true;
  if (document.documentElement?.dataset?.betaFlag === PROGRAM_HISTORY_BETA_SLUG) {
    return true;
  }
  const params = new URLSearchParams(location.search);
  return params.get("beta") === PROGRAM_HISTORY_BETA_SLUG;
}

function mountOffState(root) {
  const section = document.createElement("section");
  section.className = "program-journey";
  section.dataset.programJourneyOff = "";

  const title = document.createElement("h1");
  title.textContent = t("program_history_title");

  const deck = document.createElement("p");
  deck.textContent = t("program_history_off_deck");

  const turnOn = document.createElement("p");
  const turnOnLink = document.createElement("a");
  turnOnLink.href = `?beta=${PROGRAM_HISTORY_BETA_SLUG}`;
  turnOnLink.textContent = t("program_history_turn_on");
  turnOn.append(turnOnLink, document.createTextNode(t("program_history_turn_on_suffix")));

  const back = document.createElement("p");
  const backLink = document.createElement("a");
  backLink.href = "/browse/contracts/";
  backLink.textContent = t("program_history_back");
  back.append(backLink);

  section.append(title, deck, turnOn, back);
  root.replaceChildren(section);
}

async function loadCorpus() {
  const response = await fetch(CORPUS_URL, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload || !Array.isArray(payload.records)) {
    throw new Error("corpus missing records");
  }
  return payload.records;
}

function bindForm(root, state, redraw) {
  const form = root.querySelector("[data-program-profile-form]");
  if (!form) return;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    state.profile = profileFromFormValues({
      capability_keywords: data.get("capability_keywords"),
      job_training: data.get("job_training"),
      employer_placement: data.get("employer_placement"),
      roof_installation_crew: data.get("roof_installation_crew"),
    });
    redraw();
  });
  const retry = root.querySelector("[data-program-retry]");
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
    if (!Array.isArray(state.records)) state.records = [];
  }
  redraw();
}

function paint(root, state) {
  const journey = buildProgramJourney({
    profile: state.profile,
    records: state.loadError ? [] : state.records,
    loadError: state.loadError,
  });
  root.innerHTML = renderProgramJourneyHtml(journey, {
    headingId: "program-history-heading",
  });
  const heading = root.querySelector("#program-history-heading");
  if (heading && heading.tagName === "H2") {
    const h1 = document.createElement("h1");
    h1.id = heading.id;
    h1.textContent = heading.textContent;
    heading.replaceWith(h1);
  }
  bindForm(root, state, () => paint(root, state));
}

export async function bootProgramHistory(
  root = document.getElementById("program-history-root"),
) {
  if (!root) return { active: false };
  if (!flagIsOn()) {
    mountOffState(root);
    return { active: false };
  }
  const state = {
    profile: { ...DEFAULT_TRAINING_PROFILE },
    records: [],
    loadError: null,
  };
  await refreshRecords(state, () => paint(root, state));
  return { active: true, state };
}

if (typeof document !== "undefined") {
  const start = () => {
    void bootProgramHistory();
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
  document.addEventListener("crol:beta-flag-ready", start);
}
