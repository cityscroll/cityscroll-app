import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../standards.html", import.meta.url), "utf8");

function selfConformanceSection() {
  const match = source.match(
    /<section id="selfConformance"[\s\S]*?<\/section>/
  );
  assert.ok(match, "standards.html must include the CROL-List self-conformance section");
  return match[0];
}

test("standards page states CROL-List's current and tracked accessibility targets", () => {
  const section = selfConformanceSection();

  assert.match(section, /CROL-List targets <b>WCAG 2\.1 Level AA<\/b> today/);
  assert.match(
    section,
    /tracking New York State's <b>WCAG 2\.2 Level AA<\/b> mandate for January 1, 2027/
  );
});

test("self-conformance section names each continuous observation", () => {
  const section = selfConformanceSection();

  assert.match(section, /axe[\s\S]*every pull request/i);
  assert.match(section, /Local Law 30[\s\S]*switcher[\s\S]*live/i);
  assert.match(section, /reading-level ratchet[\s\S]*every pull request/i);
});

test("self-conformance section does not make a certification claim", () => {
  const section = selfConformanceSection();
  const certificationClaims = /\b(?:compliant|certified|conforms)\b/i;

  assert.doesNotMatch(section, certificationClaims);
});
