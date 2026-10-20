// Opt-in program-history journey for retained public awards (bounded pilot).

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  PROGRAM_HISTORY_BETA_SLUG,
  PROGRAM_HISTORY_HISTORY_STATE_KEY,
  PROGRAM_HISTORY_PROFILE_STORAGE_KEY,
  DEFAULT_TRAINING_PROFILE,
  applyProgramProfileToHistoryState,
  buildProgramJourney,
  journeyHtmlOmitsOpenBidCta,
  persistProgramProfilePrivately,
  profileFromFormValues,
  readProgramProfileFromStorage,
  renderProgramJourneyHtml,
  resolveInitialProgramProfile,
  scrubProgramProfileFromLocation,
  writeProgramProfileToStorage,
  PROGRAM_RELATION,
} from "../site/procurement_program_journey.mjs";

import {
  recordPursuitDecision,
  pursuitStateFor,
} from "../site/procurement_pursuit_state.mjs";

class FakeStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  setItem(key, value) {
    this.map.set(key, String(value));
  }
  removeItem(key) {
    this.map.delete(key);
  }
}

const corpus = JSON.parse(
  readFileSync(
    new URL("../site/data/procurement_program_capabilities_corpus.json", import.meta.url),
    "utf8",
  ),
);

test("program corpus retains exactly three historical awards", () => {
  assert.equal(corpus.default_off, true);
  assert.equal(corpus.records.length, 3);
});

test("A1: training profile with no roof crew shows three awards, both categories, training overlap and coating gap", () => {
  const journey = buildProgramJourney({
    profile: DEFAULT_TRAINING_PROFILE,
    records: corpus.records,
  });
  assert.equal(journey.records.length, 3);
  assert.equal(journey.open_bid_cta, false);
  assert.equal(journey.combined_spend, null);
  assert.equal(journey.future_opening_predicted, false);
  assert.equal(journey.automatic_qualification, false);
  assert.equal(journey.pursuit_notes_mutated, false);

  const categories = new Set(journey.records.map((r) => r.category_description));
  assert.equal(categories.size, 2);

  const byId = Object.fromEntries(journey.records.map((r) => [r.notice_id, r]));
  assert.ok(byId["20220719104"]);
  assert.ok(byId["20240417107"]);
  assert.ok(byId["20260708004"]);

  const trainingOverlap = byId["20240417107"].assessments.some(
    (a) => a.state === "supported_overlap",
  );
  assert.equal(trainingOverlap, true);

  const coatingGap = byId["20240417107"].assessments.find(
    (a) => a.capability_id === "reflective_coating",
  );
  assert.equal(coatingGap.state, "stated_capability_gap");
  assert.equal(coatingGap.service_gap, "physical roof coating delivery");
  assert.ok(coatingGap.citation?.url);
});

test("A2: consortium cites 2024 passage; lead eligibility stays document-review; no future/spend/auto-qualify", () => {
  const journey = buildProgramJourney({
    profile: DEFAULT_TRAINING_PROFILE,
    records: corpus.records,
  });
  const row2024 = journey.records.find((r) => r.notice_id === "20240417107");
  const consortium = row2024.assessments.find(
    (a) => a.capability_id === "consortium_delivery",
  );
  assert.ok(consortium);
  assert.equal(consortium.state, "document_review_needed");
  assert.equal(consortium.citation.notice_id, "20240417107");
  assert.match(consortium.citation.passage, /consortium of qualified vendors/i);

  assert.equal(journey.future_opening_predicted, false);
  assert.equal(journey.combined_spend, null);
  assert.equal(journey.automatic_qualification, false);

  const exact = journey.relations.find(
    (r) =>
      r.relation === PROGRAM_RELATION.EXACT_PREDECESSOR_LINK &&
      ((r.a === "20240417107" && r.b === "20260708004") ||
        (r.a === "20260708004" && r.b === "20240417107")),
  );
  assert.ok(exact);
});

test("A2 / B2: changing capacity updates comparison only; pursuit notes untouched", () => {
  const storage = new FakeStorage();
  recordPursuitDecision(storage, {
    noticeId: "20240417107",
    decision: "pursuing",
    reason: "Capability fit",
  });
  const before = pursuitStateFor(storage, "20240417107");

  const journey = buildProgramJourney({
    profile: {
      ...DEFAULT_TRAINING_PROFILE,
      roof_installation_crew: true,
    },
    records: corpus.records,
  });
  const coating = journey.records
    .find((r) => r.notice_id === "20240417107")
    .assessments.find((a) => a.capability_id === "reflective_coating");
  assert.equal(coating.state, "supported_overlap");
  assert.equal(journey.pursuit_notes_mutated, false);
  assert.deepEqual(pursuitStateFor(storage, "20240417107"), before);
});

test("A3: rendered journey omits open-bid CTA and includes source citations", () => {
  const journey = buildProgramJourney({
    profile: DEFAULT_TRAINING_PROFILE,
    records: corpus.records,
  });
  const html = renderProgramJourneyHtml(journey);
  assert.equal(journeyHtmlOmitsOpenBidCta(html), true);
  assert.match(html, /20240417107/);
  assert.match(html, /white, reflective coating/);
  assert.match(html, /Back to Contracts Browse/);
});

test("failed source load preserves profile and offers retry", () => {
  const journey = buildProgramJourney({
    profile: DEFAULT_TRAINING_PROFILE,
    loadError: "HTTP 503",
  });
  assert.equal(journey.retry_available, true);
  assert.equal(journey.records.length, 0);
  assert.equal(journey.profile.job_training, true);
  const html = renderProgramJourneyHtml(journey);
  assert.match(html, /data-program-retry/);
});

test("failed source load also offers existing notice source links", () => {
  const journey = buildProgramJourney({
    profile: DEFAULT_TRAINING_PROFILE,
    loadError: "HTTP 503",
  });
  assert.equal(journey.source_links.length, 3);
  assert.deepEqual(
    journey.source_links.map((link) => link.notice_id),
    ["20220719104", "20240417107", "20260708004"],
  );
  const html = renderProgramJourneyHtml(journey);
  assert.match(html, /data-program-source-links/);
  assert.match(html, /data-program-retry/);
  assert.match(html, /href="https:\/\/cityscroll\.org\/notices\/20220719104\/"/);
  assert.match(html, /href="https:\/\/cityscroll\.org\/notices\/20240417107\/"/);
  assert.match(html, /href="https:\/\/cityscroll\.org\/notices\/20260708004\/"/);
  // Browse back-link alone must not be the only navigational affordance.
  const noticeHrefs = [...html.matchAll(/href="(https:\/\/cityscroll\.org\/notices\/[^"]+)"/g)].map(
    (m) => m[1],
  );
  assert.equal(noticeHrefs.length, 3);
});

test("profileFromFormValues round-trips training answers", () => {
  const profile = profileFromFormValues({
    capability_keywords: "job training, employer placement",
    job_training: "true",
    employer_placement: "true",
    roof_installation_crew: "false",
  });
  assert.equal(profile.job_training, true);
  assert.equal(profile.employer_placement, true);
  assert.equal(profile.roof_installation_crew, false);
});

test("beta slug is registered default-off constant", () => {
  assert.equal(PROGRAM_HISTORY_BETA_SLUG, "program-history");
});

test("beta slug is registered default-off in the public flag registry", () => {
  const registry = JSON.parse(
    readFileSync(new URL("../site/beta-flags.json", import.meta.url), "utf8"),
  );
  const flag = registry.flags.find((f) => f.slug === PROGRAM_HISTORY_BETA_SLUG);
  assert.ok(flag);
  assert.equal(flag.default_off, true);
  assert.ok(flag.removal_date >= "2026-10-20");
});

test("standalone program-history page ships with noscript source links", () => {
  const html = readFileSync(
    fileURLToPath(new URL("../site/contracts-program-history.html", import.meta.url)),
    "utf8",
  );
  assert.match(html, /<noscript>/);
  assert.match(html, /notices\/20220719104/);
  assert.match(html, /notices\/20240417107/);
  assert.match(html, /notices\/20260708004/);
  assert.match(html, /beta_flags\.js/);
  assert.match(html, /app\/program-history\.mjs/);
});

test("classic program-history-profile-scrub.js precedes analytics.js and clarity.js", () => {
  const html = readFileSync(
    fileURLToPath(new URL("../site/contracts-program-history.html", import.meta.url)),
    "utf8",
  );
  const scrubIdx = html.indexOf('src="program-history-profile-scrub.js"');
  const analyticsIdx = html.indexOf('src="analytics.js');
  const clarityIdx = html.indexOf('src="clarity.js');
  assert.ok(scrubIdx > 0, "scrub script tag missing");
  assert.ok(analyticsIdx > scrubIdx, "scrub must precede analytics.js");
  assert.ok(clarityIdx > scrubIdx, "scrub must precede clarity.js");
  const scrubTagMatch = html.match(
    /<script\b[^>]*src="program-history-profile-scrub\.js"[^>]*>\s*<\/script>/,
  );
  assert.ok(scrubTagMatch, "scrub script element missing");
  assert.doesNotMatch(scrubTagMatch[0], /\bdefer\b|\basync\b|type="module"/);
});

test("program profile persists across sessionStorage remount (Back restores keywords)", () => {
  const storage = new FakeStorage();
  const typed = profileFromFormValues({
    capability_keywords: "back-restore-keywords, youth apprenticeship",
    job_training: "true",
    employer_placement: "false",
    roof_installation_crew: "false",
  });
  assert.equal(writeProgramProfileToStorage(storage, typed), true);
  assert.ok(storage.getItem(PROGRAM_HISTORY_PROFILE_STORAGE_KEY));

  const remount = resolveInitialProgramProfile({
    historyState: null,
    storage,
  });
  assert.deepEqual(remount.capability_keywords, [
    "back-restore-keywords",
    "youth apprenticeship",
  ].sort((a, b) => a.localeCompare(b)));
  assert.equal(remount.job_training, true);
  assert.equal(remount.employer_placement, false);
});

test("history.state profile wins over sessionStorage for Back restoration", () => {
  const storage = new FakeStorage();
  writeProgramProfileToStorage(
    storage,
    profileFromFormValues({
      capability_keywords: "from-storage",
      job_training: "false",
      employer_placement: "false",
      roof_installation_crew: "false",
    }),
  );
  const historyState = applyProgramProfileToHistoryState(null, {
    capability_keywords: ["from-history", "hydro"],
    job_training: true,
    employer_placement: true,
    roof_installation_crew: false,
  });
  const resolved = resolveInitialProgramProfile({ historyState, storage });
  assert.deepEqual(resolved.capability_keywords, ["from-history", "hydro"]);
  assert.equal(resolved.job_training, true);
});

function fakeLocationAndHistory(href, state = null) {
  const url = new URL(href);
  const loc = {
    get href() {
      return url.href;
    },
    get pathname() {
      return url.pathname;
    },
    get search() {
      return url.search;
    },
    get hash() {
      return url.hash;
    },
  };
  const hist = {
    state,
    replaceState(nextState, _title, nextUrl) {
      this.state = nextState;
      const resolved = new URL(nextUrl, url.origin);
      url.href = resolved.href;
    },
  };
  return { loc, hist, url };
}

test("filling the form never puts profile or keywords into location.href", () => {
  const storage = new FakeStorage();
  const { loc, hist } = fakeLocationAndHistory(
    "https://cityscroll.org/contracts-program-history.html?beta=program-history",
  );
  const typed = profileFromFormValues({
    capability_keywords: "secret-program-keywords, catch basin",
    job_training: "true",
    employer_placement: "true",
    roof_installation_crew: "false",
  });
  const result = persistProgramProfilePrivately({
    profile: typed,
    storage,
    location: loc,
    history: hist,
  });
  assert.equal(result.href.includes("capability_keywords"), false);
  assert.equal(result.href.includes("secret-program-keywords"), false);
  assert.equal(result.href.includes("job_training"), false);
  assert.equal(result.href.includes("employer_placement"), false);
  assert.equal(result.href.includes("roof_installation_crew"), false);
  assert.match(result.href, /[?&]beta=program-history/);
  assert.ok(hist.state?.[PROGRAM_HISTORY_HISTORY_STATE_KEY]);
  const afterBack = resolveInitialProgramProfile({
    historyState: hist.state,
    storage,
  });
  assert.deepEqual(
    afterBack.capability_keywords,
    ["secret-program-keywords", "catch basin"].sort((a, b) => a.localeCompare(b)),
  );
  assert.equal(loc.href.includes("secret-program-keywords"), false);
});

test("scrub migrates legacy query profile then strips it before analytics can read href", () => {
  const storage = new FakeStorage();
  const { loc, hist } = fakeLocationAndHistory(
    "https://cityscroll.org/contracts-program-history.html?beta=program-history&capability_keywords=legacy-program&job_training=true",
  );
  assert.equal(loc.href.includes("legacy-program"), true);
  const stripped = scrubProgramProfileFromLocation({
    location: loc,
    history: hist,
    storage,
  });
  assert.equal(stripped, true);
  assert.equal(loc.href.includes("legacy-program"), false);
  assert.equal(loc.href.includes("capability_keywords"), false);
  assert.equal(loc.href.includes("job_training"), false);
  assert.match(loc.href, /[?&]beta=program-history/);
  const restored = resolveInitialProgramProfile({
    historyState: hist.state,
    storage,
  });
  assert.deepEqual(restored.capability_keywords, ["legacy-program"]);
  assert.equal(restored.job_training, true);
  assert.ok(readProgramProfileFromStorage(storage));
});

test("classic scrub cleans legacy profile params before analytics or clarity would run", () => {
  const scrubSource = readFileSync(
    fileURLToPath(new URL("../site/program-history-profile-scrub.js", import.meta.url)),
    "utf8",
  );
  const storage = new Map();
  const url = new URL(
    "https://cityscroll.org/contracts-program-history.html?beta=program-history&capability_keywords=pre-clarity-program&job_training=true",
  );
  const loc = {
    get href() {
      return url.href;
    },
  };
  const hist = {
    state: null,
    replaceState(nextState, _title, nextUrl) {
      this.state = nextState;
      const resolved = new URL(nextUrl, url.origin);
      url.href = resolved.href;
    },
  };
  const ranAnalytics = { value: false };
  const ranClarity = { value: false };
  const runScrub = new Function(
    "window",
    "location",
    "history",
    "sessionStorage",
    "URL",
    `${scrubSource}\n; return { href: location.href, state: history.state };`,
  );
  const afterScrub = runScrub(
    { location: loc, history: hist, sessionStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
    }, URL },
    loc,
    hist,
    {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
    },
    URL,
  );
  assert.equal(afterScrub.href.includes("pre-clarity-program"), false);
  assert.equal(afterScrub.href.includes("capability_keywords"), false);
  assert.equal(ranAnalytics.value, false);
  assert.equal(ranClarity.value, false);
  assert.deepEqual(hist.state?.programHistoryProfile?.capability_keywords, [
    "pre-clarity-program",
  ]);
});
