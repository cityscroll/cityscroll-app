/**
 * Homepage email-updates entry into the existing Following watch journey.
 *
 * Public alias: c8f4cfa1b7a8d
 *
 * Verify: node --test test/home_email_entry.test.mjs
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  HOME_EMAIL_ENTRY_EXPLAIN,
  HOME_EMAIL_ENTRY_LABEL,
  HOME_FOLLOWING_ONBOARDING_HREF,
  homeFollowingEntryHref,
  isHomeFollowingOnboardingHref,
  renderHomeEmailEntryHtml,
} from "../site/home_following_entry.mjs";
import {
  buildFollowingViewModel,
  canonicalFollowingScope,
  renderFollowingDocument,
  watchFromFollowingParams,
} from "../site/following_view.mjs";
import { renderGeographyShellEntry } from "../site/geography_navigation_shell.mjs";
import {
  buildNearYouViewModel,
  renderNearYouDocument,
} from "../site/near_you_view.mjs";
import { scopeFromNearYouUrl } from "../site/near_you_scope_runtime.mjs";
import { mountDocument } from "./helpers/preview_dom.mjs";

const ROOT = process.cwd();
const EVIDENCE_DIR = join(ROOT, "docs/evidence/home-email-entry");
const MANIFEST_PATH = join(EVIDENCE_DIR, "capture-manifest.json");
const CAPTURE_TOOL = join(ROOT, "tools/capture_home_email_entry.py");
const PUBLIC_ALIAS = "c8f4cfa1b7a8d";
const CSS_SOURCE = readFileSync(join(ROOT, "site/civic-documents.css"), "utf8");
const MODULE_SOURCE = readFileSync(join(ROOT, "site/home_following_entry.mjs"), "utf8");

const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
const boundaries = readJson("site/data/district_boundaries.json");

function sha256(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}

function homepageHtml() {
  const view = buildNearYouViewModel(
    scopeFromNearYouUrl("https://cityscroll.org/"),
    null,
    boundaries,
    { dataState: "ready", geometryState: "ready" },
  );
  return renderNearYouDocument(view, { assetPrefix: "/" });
}

function entryOutsideSecondaryDetails(html) {
  const entryMatch = html.match(/<section class="near-geo-entry"[\s\S]*?<\/section>/);
  assert.ok(entryMatch, "Near You entry chrome must render");
  const entry = entryMatch[0];
  const emailIdx = entry.indexOf('data-home-email-entry');
  const detailsIdx = entry.indexOf('<details class="near-entry-secondary"');
  assert.ok(emailIdx > 0, "homepage email entry must be present");
  assert.ok(detailsIdx > 0, "secondary disclosure must remain");
  assert.ok(emailIdx < detailsIdx, "email entry must sit above the secondary disclosure");
  assert.match(
    entry,
    /data-home-email-entry-link[^>]*href="\/following\/\?onboarding=1"|href="\/following\/\?onboarding=1"[^>]*data-home-email-entry-link/,
  );
  assert.match(entry, new RegExp(HOME_EMAIL_ENTRY_LABEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(entry, /Choose a topic and place, preview matches/);
  return entry;
}

test("A1 [outcome] production homepage chrome exposes Get email updates above the fold", () => {
  const html = homepageHtml();
  const entry = entryOutsideSecondaryDetails(html);
  assert.match(entry, /<a class="near-home-email-entry-link"[^>]*data-home-email-entry-link/);
  assert.match(CSS_SOURCE, /\.near-home-email-entry-link\s*\{[^}]*min-height:\s*44px/);
  assert.match(CSS_SOURCE, /\.near-home-email-entry\s*\{/);
  assert.equal(HOME_EMAIL_ENTRY_LABEL, "Get email updates");
  assert.match(HOME_EMAIL_ENTRY_EXPLAIN, /does not enroll you/);
  // Keep the handoff in the primary controls row so the phone first-fold map
  // stays at or above the live smoke's 150px visible-height floor.
  assert.match(
    entry,
    /near-geo-primary-controls[\s\S]*data-home-email-entry[\s\S]*<\/div>/,
  );
  assert.match(CSS_SOURCE, /@media \(max-width:\s*480px\)\s*\{[\s\S]*\.near-home-email-entry-explain\s*\{[\s\S]*clip:\s*rect\(0,\s*0,\s*0,\s*0\)/);
  assert.match(CSS_SOURCE, /\.near-geo-primary-controls\s+\.near-home-email-entry\s*\{/);

  // The unselected Near You shell owns this handoff so near_you_view.mjs can
  // stay out of discovery-recovery measured inputs.
  const shell = renderGeographyShellEntry({});
  entryOutsideSecondaryDetails(`<main>${shell}</main>`);
  const explicit = renderGeographyShellEntry({
    emailUpdatesHtml: renderHomeEmailEntryHtml(),
  });
  entryOutsideSecondaryDetails(`<main>${explicit}</main>`);
});

test("A1 [outcome] the email-updates control is a keyboard-reachable link into Following", () => {
  const html = homepageHtml();
  const { doc, container } = mountDocument(html);
  const link = container.querySelector("[data-home-email-entry-link]")
    || doc.querySelector("[data-home-email-entry-link]");
  assert.ok(link, "Get email updates link must mount");
  assert.equal(String(link.tagName).toUpperCase(), "A");
  assert.equal(link.getAttribute("href"), HOME_FOLLOWING_ONBOARDING_HREF);
  assert.equal(String(link.textContent || "").trim(), HOME_EMAIL_ENTRY_LABEL);
  assert.equal(isHomeFollowingOnboardingHref(link.getAttribute("href")), true);
});

test("A2 [outcome] homepage → Following chooser → preview reaches email field and Create watch", () => {
  const home = homepageHtml();
  const href = home.match(
    /data-home-email-entry-link[^>]*href="([^"]+)"|href="([^"]+)"[^>]*data-home-email-entry-link/,
  );
  const resolvedHref = href?.[1] || href?.[2];
  assert.equal(resolvedHref, HOME_FOLLOWING_ONBOARDING_HREF);

  const onboarding = watchFromFollowingParams(
    new URL(resolvedHref, "https://cityscroll.org").searchParams,
  );
  assert.equal(onboarding.onboarding, true);
  assert.equal(onboarding.requested, false);
  const onboardingHtml = renderFollowingDocument(buildFollowingViewModel(onboarding));
  assert.match(onboardingHtml, /data-following-primary-choice="topic"/);
  assert.match(onboardingHtml, /data-following-primary-choice="place"/);
  assert.match(onboardingHtml, /Preview matches|data-following-primary-choice="preview"/);
  assert.doesNotMatch(onboardingHtml, /data-following-subscribe-form/);
  assert.doesNotMatch(onboardingHtml, /name="email"/);

  const topicHref = onboardingHtml.match(
    /data-following-scope-value="meetings"[^>]*data-filter-href="([^"]+)"/,
  )?.[1];
  assert.ok(topicHref, "Hearings and meetings topic must remain choosable");
  const topic = watchFromFollowingParams(
    new URL(topicHref.replaceAll("&amp;", "&"), "https://cityscroll.org").searchParams,
  );
  assert.equal(topic.requested, false);
  assert.equal(topic.lens, "meetings");

  const preview = watchFromFollowingParams(new URLSearchParams({
    lens: "meetings",
    boro: "Brooklyn",
    q: "board",
    freq: "weekly",
  }));
  assert.equal(preview.requested, true);
  assert.deepEqual(canonicalFollowingScope(preview), {
    lens: "meetings",
    filter: { borough: "Brooklyn", keywords: ["board"] },
  });
  const previewHtml = renderFollowingDocument(buildFollowingViewModel({
    ...preview,
    matchCount: 2,
    previewItems: [{
      id: "20260716009",
      title: "Brooklyn board hearing",
      url: "/browse/meetings/",
    }],
  }));
  assert.match(previewHtml, /data-following-journey="preview"/);
  assert.match(previewHtml, /data-following-subscribe-form/);
  assert.match(previewHtml, /name="email"/);
  assert.match(previewHtml, /Email address/);
  assert.match(previewHtml, /<button[^>]*>Create watch<\/button>/);
  assert.match(previewHtml, /action="https:\/\/api\.cityscroll\.org\/subscribe"/);
  assert.match(MODULE_SOURCE, /Never collects email|never enrolls|does not enroll/i);
  assert.match(readFileSync(join(ROOT, "site/app/following.mjs"), "utf8"), /signupTurnstileToken|turnstileToken/);
});

test("A2 [outcome] stubbed Create watch posts once to subscribe without inventing homepage enrollment", async () => {
  const preview = watchFromFollowingParams(new URLSearchParams({
    lens: "meetings",
    boro: "Brooklyn",
    q: "board",
    freq: "weekly",
  }));
  const previewHtml = renderFollowingDocument(buildFollowingViewModel({
    ...preview,
    matchCount: 1,
    previewItems: [{ id: "20260716009", title: "Board hearing", url: "/browse/meetings/" }],
  }));
  const { container: previewRoot } = mountDocument(previewHtml);
  const form = previewRoot.querySelector("[data-following-subscribe-form]");
  assert.ok(form, "protected email form must render after preview");
  const email = form.querySelector('input[type="email"][name="email"]');
  assert.ok(email, "labeled email field must exist");
  assert.match(previewHtml, /action="https:\/\/api\.cityscroll\.org\/subscribe"/);
  assert.match(previewHtml, /Create watch/);

  // Stubbed enrollment contract: the form is ready, but homepage navigation
  // never posts. Prove the homepage still has no email field or subscribe form.
  const { container: homeRoot } = mountDocument(homepageHtml());
  assert.equal(homeRoot.querySelector("[data-following-subscribe-form]"), null);
  assert.equal(homeRoot.querySelector("#homeCtaForm"), null);
  assert.equal(homeRoot.querySelector('input[type="email"]'), null);
  assert.match(readFileSync(join(ROOT, "site/app/following.mjs"), "utf8"), /signupTurnstileToken/);
});

test("A3 [boundary] opening the homepage link or preview never enrolls; invalid context falls back", () => {
  assert.equal(homeFollowingEntryHref(), HOME_FOLLOWING_ONBOARDING_HREF);
  assert.equal(homeFollowingEntryHref({ email: "reader@example.com" }), HOME_FOLLOWING_ONBOARDING_HREF);
  assert.equal(
    homeFollowingEntryHref({ lens: "not-a-lens", filter: { keywords: ["housing"] } }),
    HOME_FOLLOWING_ONBOARDING_HREF,
  );
  assert.doesNotMatch(renderHomeEmailEntryHtml({ href: "/following/?email=x@y.z" }), /email=/i);

  const home = homepageHtml();
  assert.doesNotMatch(home, /data-following-subscribe-form|id="homeCtaForm"|action="https:\/\/api\.cityscroll\.org\/subscribe"/);
  assert.doesNotMatch(home, /name="email"/);
  assert.match(
    home,
    /data-home-email-entry-link[^>]*href="\/following\/\?onboarding=1"|href="\/following\/\?onboarding=1"[^>]*data-home-email-entry-link/,
  );

  const onboardingHtml = renderFollowingDocument(buildFollowingViewModel(
    watchFromFollowingParams(new URL(HOME_FOLLOWING_ONBOARDING_HREF, "https://cityscroll.org").searchParams),
  ));
  assert.doesNotMatch(onboardingHtml, /data-following-subscribe-form/);
  // Onboarding may keep submit-ready copy in data-msg attributes for later use;
  // the page itself must not show a completed enrollment state.
  assert.doesNotMatch(onboardingHtml, /data-following-submit-status[^>]*>\s*You're subscribed/);
  assert.doesNotMatch(onboardingHtml, />Welcome sent to /);
  assert.equal(onboardingHtml.includes('data-following-subscribe-form'), false);
});

test("A4 [verification] focused source, no-JS href, capture manifest, and content hash stay honest", () => {
  const html = homepageHtml();
  const entry = entryOutsideSecondaryDetails(html);
  const contentHash = sha256(entry);
  assert.match(contentHash, /^[0-9a-f]{64}$/);

  // No-JavaScript: the plain anchor remains the navigation surface.
  assert.match(html, /href="\/following\/\?onboarding=1"[^>]*data-home-email-entry-link|data-home-email-entry-link[^>]*href="\/following\/\?onboarding=1"/);
  assert.doesNotMatch(MODULE_SOURCE, /window\.location|document\.write|eval\(/);

  assert.equal(existsSync(CAPTURE_TOOL), true, "capture tool must exist");
  const captureTool = readFileSync(CAPTURE_TOOL, "utf8");
  assert.match(captureTool, /1440/);
  assert.match(captureTool, /390/);
  assert.match(captureTool, /c8f4cfa1b7a8d/);
  assert.match(captureTool, /data-home-email-entry/);
  assert.match(captureTool, /Get email updates/);
  assert.match(captureTool, /image_binaries_committed/);
  assert.match(captureTool, /before|after/i);

  assert.equal(existsSync(MANIFEST_PATH), true, "capture manifest must be present");
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  assert.equal(manifest.schema, "cityscroll.render_capture_manifest.v1");
  assert.equal(manifest.feature, "home-email-entry");
  assert.equal(manifest.public_alias, PUBLIC_ALIAS);
  assert.equal(manifest.image_binaries_committed, false);
  assert.ok(Array.isArray(manifest.captures) && manifest.captures.length >= 4);
  for (const row of manifest.captures) {
    assert.match(String(row.route || ""), /^\/|^https:\/\/cityscroll\.org\/?$/);
    assert.ok(row.viewport?.width === 1440 || row.viewport?.width === 390, row.name);
    assert.match(
      String(row.assertion || ""),
      /Get email updates|email updates|above the fold|visible-height|smoke floor|primary controls/i,
    );
    assert.match(String(row.sha256 || ""), /^[0-9a-f]{64}$/);
    assert.equal(row.file, null);
  }
  const afterPhone = manifest.captures.find((row) => row.name === "after-phone");
  assert.ok(afterPhone, "after-phone capture row required");
  assert.ok(
    Number(afterPhone.metrics?.map_visible_height_px) >= 150,
    `after-phone map visible height must meet smoke floor: ${JSON.stringify(afterPhone.metrics)}`,
  );
  assert.ok(manifest.content_hash || manifest.entry_content_hash || manifest.captures.some((row) => row.content_hash));
});
