import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CASE_SPECS,
  ENROLLMENT_REUSE,
  FS05_PREREQUISITE_SCHEMA,
  INBOUND_BODY_CHAR_LIMIT,
  MAILTO_HREF_CHAR_LIMIT,
  MAILTO_SUBSCRIBE_LATER_SCHEMA,
  PRIMARY_JOURNEY_FILES,
  PRIVACY_COPY_ENABLED,
  SUBSCRIBE_ADDRESS_KEY,
  SUBSCRIBE_ADDRESS_SOURCE,
  buildMailtoSubscribeLaterReceipt,
  encodeReviewedSentenceMailto,
  evaluateMailtoSubscribeLater,
  evaluatePrerequisiteAxis,
  findSubscribeMailtoAddresses,
  loadConfiguredSubscribeAddress,
  projectPublicMailtoSurface,
  specifiedCases,
  validateMailtoSubscribeLaterReceipt,
} from "../site/mailto_subscribe_later.mjs";
import {
  buildFollowingViewModel,
  composeWatchRuleSentence,
  renderFollowingDocument,
} from "../site/following_view.mjs";
import { build } from "../tools/build_mailto_subscribe_later.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const templates = JSON.parse(readFileSync(join(ROOT, "site/data/watch_templates.json"), "utf8"));
const prerequisite = JSON.parse(
  readFileSync(join(ROOT, "docs/evidence/mailto-subscribe-later/fs05-prerequisite.json"), "utf8"),
);
const committed = JSON.parse(
  readFileSync(join(ROOT, "docs/evidence/mailto-subscribe-later/receipt.json"), "utf8"),
);

const SENTENCE = composeWatchRuleSentence("meetings", {
  keywords: ["curb"],
  agency: "Transportation",
  borough: "Queens",
});
const CONFIGURED = loadConfiguredSubscribeAddress(
  readFileSync(join(ROOT, "worker/wrangler.toml"), "utf8"),
);
const encodeOpts = { subscribeAddress: CONFIGURED, configuredSubscribeAddress: CONFIGURED };

function provenPrerequisite(observedAt = "2026-08-29T00:00:00.000Z") {
  return {
    schema: FS05_PREREQUISITE_SCHEMA,
    version: 1,
    observed_at: observedAt,
    subscribe_address_source: SUBSCRIBE_ADDRESS_SOURCE,
    subscribe_address_key: SUBSCRIBE_ADDRESS_KEY,
    axes: Object.fromEntries([
      "routing",
      "delivery_ownership",
      "reply_handling",
      "composer_behavior",
    ].map((id) => [id, {
      status: "proven",
      evidence_id: `fs05-${id}-fixture`,
      observed_at: observedAt,
      reason: "synthetic fixture; not retained production proof",
    }])),
  };
}

test("committed FS-05 record is incomplete and does not prove the later experiment", () => {
  assert.equal(prerequisite.schema, FS05_PREREQUISITE_SCHEMA);
  const experiment = evaluateMailtoSubscribeLater(prerequisite, { now: prerequisite.observed_at });
  assert.equal(experiment.enabled, false);
  assert.equal(experiment.state, "disabled_prerequisites_unproven");
  assert.ok(experiment.stop_reasons.includes("routing:incomplete"));
  assert.ok(experiment.stop_reasons.includes("delivery_ownership:absent"));
  assert.ok(experiment.stop_reasons.includes("reply_handling:incomplete"));
  assert.ok(experiment.stop_reasons.includes("composer_behavior:absent"));
});

test("absent, incomplete, and stale FS-05 evidence keep the experiment disabled", () => {
  assert.equal(evaluateMailtoSubscribeLater(null).enabled, false);
  assert.equal(evaluatePrerequisiteAxis(null).status, "absent");
  assert.equal(evaluatePrerequisiteAxis({ status: "incomplete" }).status, "incomplete");
  assert.equal(
    evaluatePrerequisiteAxis({
      status: "proven",
      evidence_id: "fs05-routing-old",
      observed_at: "2026-01-01T00:00:00.000Z",
    }, { now: "2026-08-29T00:00:00.000Z" }).status,
    "stale",
  );
  assert.equal(
    evaluatePrerequisiteAxis({
      status: "proven",
      observed_at: "2026-08-29T00:00:00.000Z",
    }).status,
    "incomplete",
  );
  const staleBundle = provenPrerequisite("2026-01-01T00:00:00.000Z");
  const stale = evaluateMailtoSubscribeLater(staleBundle, { now: "2026-08-29T00:00:00.000Z" });
  assert.equal(stale.enabled, false);
  assert.ok(stale.stop_reasons.every((reason) => reason.endsWith(":stale")));
});

test("synthetic complete FS-05 evidence enables measurement without becoming a default or fallback", () => {
  const experiment = evaluateMailtoSubscribeLater(provenPrerequisite(), {
    now: "2026-08-29T00:00:00.000Z",
  });
  assert.equal(experiment.enabled, true);
  const explicit = projectPublicMailtoSurface({
    experiment,
    sentence: SENTENCE,
    ...encodeOpts,
    role: "explicit_measurement",
  });
  assert.equal(explicit.presented, true);
  assert.equal(explicit.default, false);
  assert.equal(explicit.fallback, false);
  assert.equal(explicit.auto_enroll, false);
  assert.equal(explicit.privacy_copy, PRIVACY_COPY_ENABLED);
  assert.ok(explicit.href.startsWith(`mailto:${CONFIGURED}?`));

  for (const role of ["default", "fallback"]) {
    const blocked = projectPublicMailtoSurface({ experiment, sentence: SENTENCE, ...encodeOpts, role });
    assert.equal(blocked.presented, false);
    assert.equal(blocked.href, null);
    assert.equal(blocked.reason, "mailto_is_not_a_default_or_fallback");
  }
});

test("disabled experiment never presents mailto UI, privacy copy, or auto-enrollment", () => {
  const experiment = evaluateMailtoSubscribeLater(prerequisite, { now: prerequisite.observed_at });
  const surface = projectPublicMailtoSurface({ experiment, sentence: SENTENCE });
  assert.equal(surface.presented, false);
  assert.equal(surface.href, null);
  assert.equal(surface.privacy_copy, null);
  assert.equal(surface.auto_enroll, false);
  assert.equal(surface.default, false);
  assert.equal(surface.fallback, false);
});

test("encoder writes the reviewed sentence only to the configured subscribe address", () => {
  assert.equal(CONFIGURED.startsWith("subscribe@"), true);
  const encoded = encodeReviewedSentenceMailto({ sentence: SENTENCE, ...encodeOpts });
  assert.equal(encoded.ok, true);
  assert.equal(encoded.destination, CONFIGURED);
  const url = new URL(encoded.href);
  assert.equal(url.protocol, "mailto:");
  assert.equal(url.pathname, CONFIGURED);
  assert.equal(url.searchParams.get("body"), SENTENCE);
  assert.equal(url.searchParams.get("subject"), "CityScroll watch");
  assert.equal(url.searchParams.get("bcc"), null);
  assert.equal(url.searchParams.get("cc"), null);
  assert.equal(encodeReviewedSentenceMailto({ sentence: SENTENCE, ...encodeOpts }).href, encoded.href);
});

test("encoder rejects unreviewed destinations, injection, and oversized content", () => {
  assert.equal(
    encodeReviewedSentenceMailto({
      sentence: SENTENCE,
      subscribeAddress: "other@example.com",
      configuredSubscribeAddress: CONFIGURED,
    }).reason,
    "unreviewed_destination",
  );
  assert.equal(
    encodeReviewedSentenceMailto({ sentence: "Notify me\nBcc: other@example.com", ...encodeOpts }).reason,
    "header_injection",
  );
  assert.equal(
    encodeReviewedSentenceMailto({ sentence: SENTENCE, subject: "Watch\r\nBcc: other@example.com", ...encodeOpts }).reason,
    "header_injection",
  );
  assert.equal(
    encodeReviewedSentenceMailto({ sentence: "n".repeat(INBOUND_BODY_CHAR_LIMIT + 1), ...encodeOpts }).reason,
    "oversized_body",
  );
  assert.equal(
    encodeReviewedSentenceMailto({ sentence: "n".repeat(MAILTO_HREF_CHAR_LIMIT), ...encodeOpts }).reason,
    "oversized_href",
  );
  assert.equal(encodeReviewedSentenceMailto({ sentence: "   ", ...encodeOpts }).reason, "empty_sentence");
});

test("specified device, routing, reply, cap, loop, and privacy cases stay unmeasured while disabled", () => {
  const cases = specifiedCases(false);
  assert.deepEqual(Object.keys(cases), CASE_SPECS.map((spec) => spec.id));
  for (const spec of CASE_SPECS) {
    assert.equal(cases[spec.id].specified, true);
    assert.equal(cases[spec.id].measured, false);
    assert.equal(cases[spec.id].result, "not_run");
    assert.equal(cases[spec.id].required_behavior, spec.required_behavior);
  }
});

test("loop guard and inbound enrollment reuse stay on the shared inbound path", () => {
  const inbound = readFileSync(join(ROOT, "worker/src/inbound.mjs"), "utf8");
  const subscribe = readFileSync(join(ROOT, "worker/src/subscribe.mjs"), "utf8");
  assert.equal(ENROLLMENT_REUSE.parser, "worker/src/inbound.mjs#pickLens");
  assert.equal(ENROLLMENT_REUSE.enroll, "worker/src/subscribe.mjs#enrollAndWelcome");
  assert.equal(ENROLLMENT_REUSE.source, "inbound_email");
  assert.equal(ENROLLMENT_REUSE.opt_in, "single_opt_in");
  assert.equal(ENROLLMENT_REUSE.actor_cap_per_day, 5);
  assert.equal(ENROLLMENT_REUSE.surface_cap_env, "INBOUND_MAX_PER_DAY");
  assert.match(inbound, /export function shouldIgnore/);
  assert.match(inbound, /enrollAndWelcome\(env, sub, \{ source: "inbound_email" \}\)/);
  assert.match(inbound, /const MAX_BODY = 2000/);
  assert.match(inbound, /overActorLimit\(env\.SUBS, "inbound", from, 5\)/);
  assert.match(inbound, /INBOUND_MAX_PER_DAY/);
  // The loop guard ignores our own senders — including owned sending subdomains — via isSelfOriginEmail.
  assert.match(inbound, /isSelfOriginEmail\(f\)/);
  assert.match(subscribe, /Shared immediate-enrollment transaction for web, inbound email, and MCP surfaces/);
  assert.doesNotMatch(inbound, /double opt-in|confirmation link/i);
});

test("primary Following and home journey stay preview-first form-first without subscribe mailto", () => {
  const requested = renderFollowingDocument(buildFollowingViewModel({
    lens: "meetings",
    filter: { keywords: ["curb"], borough: "Queens", agency: "Transportation" },
    requested: true,
    frequency: "daily",
    matchCount: 7,
  }, templates));
  const fresh = renderFollowingDocument(buildFollowingViewModel({}, templates));
  for (const html of [requested, fresh]) {
    assert.equal(findSubscribeMailtoAddresses(html).length, 0);
    assert.doesNotMatch(html, /mailto:subscribe@/i);
    assert.doesNotMatch(html, /Click it to start the watch|We send one link first|double opt-in/i);
  }
  assert.match(requested, /method="post"[^>]+action="https:\/\/api\.cityscroll\.org\/subscribe"/);
  assert.match(requested, /name="email"/);
  assert.match(requested, /Create this watch/);
  assert.match(fresh, /Preview matches/);

  for (const relative of PRIMARY_JOURNEY_FILES) {
    const source = readFileSync(join(ROOT, relative), "utf8");
    assert.equal(findSubscribeMailtoAddresses(source).length, 0, relative);
  }
  const home = readFileSync(join(ROOT, "site/index.html"), "utf8");
  assert.match(home, /href="\/following\/\?onboarding=1"[^>]*id="homeCtaTopics"/);
  assert.doesNotMatch(home, /id="homeCtaEmail"|id="homeCtaForm"/);
});

test("committed receipt records the measured stop and leaks no extra addresses or credentials", () => {
  const built = build();
  assert.deepEqual(built, committed);
  const validation = validateMailtoSubscribeLaterReceipt(committed);
  assert.equal(validation.ok, true, validation.errors.join("; "));
  assert.equal(committed.enabled, false);
  assert.equal(committed.experiment_state, "disabled_prerequisites_unproven");
  assert.equal(committed.removable_harness_shipped, false);
  assert.equal(committed.auto_enrollment, false);
  assert.equal(committed.email_sent, false);
  assert.equal(committed.dns_altered, false);
  assert.equal(committed.deliverability_claimed, false);
  assert.equal(committed.ui.presented, false);
  assert.equal(committed.measured_stop.reason, "fs05_routing_delivery_reply_and_composer_prerequisites_unproven");
  assert.equal(committed.subscribe_address_source, SUBSCRIBE_ADDRESS_SOURCE);
  assert.equal(committed.subscribe_address_key, SUBSCRIBE_ADDRESS_KEY);
  const legacyHost = ["crol", "-", "list"].join("");
  assert.doesNotMatch(JSON.stringify(committed), new RegExp(legacyHost, "i"));
  assert.doesNotMatch(JSON.stringify(committed), /TOKEN_SECRET|RESEND_API_KEY|ADMIN_KEY|Bearer /);
  assert.equal(committed.schema, MAILTO_SUBSCRIBE_LATER_SCHEMA);
});

test("receipt builder refuses to enable even if a synthetic FS-05 bundle is supplied", () => {
  const receipt = buildMailtoSubscribeLaterReceipt({
    prerequisite: provenPrerequisite(),
    primaryJourneyHits: [],
    now: "2026-08-29T00:00:00.000Z",
  });
  assert.equal(receipt.enabled, false);
  assert.equal(receipt.removable_harness_shipped, false);
  assert.equal(validateMailtoSubscribeLaterReceipt(receipt).ok, true);
});
