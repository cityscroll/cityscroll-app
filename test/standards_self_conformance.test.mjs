import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const about = readFileSync(new URL("../site/about.html", import.meta.url), "utf8");
const standards = readFileSync(new URL("../site/standards.html", import.meta.url), "utf8");

function accessibilitySection() {
  const match = about.match(
    /<h2 id="accessibility"[\s\S]*?(?=<h2[^>]*data-i18n="about_h_content")/
  );
  assert.ok(match, "about.html must include the folded accessibility section");
  return match[0];
}

test("About states CityScroll's current accessibility target", () => {
  const section = accessibilitySection();
  assert.match(section, /CityScroll targets <b>WCAG 2\.2 Level AA<\/b> today/);
  assert.match(section, /Automated checks cover every public page/);
  assert.doesNotMatch(section, /WCAG 2\.1|certified|conforms/i);
});

test("retired Standards document redirects to the folded About section", () => {
  assert.match(standards, /data-destination="about\.html#accessibility"/);
  assert.match(standards, /<link rel="canonical" href="https:\/\/cityscroll\.org\/about\.html#accessibility">/);
  assert.doesNotMatch(standards, /langJoinBody|timelineList|selfConformance|pending human review/i);
});
