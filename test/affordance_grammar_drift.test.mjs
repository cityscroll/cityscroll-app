import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  copyObjectCardCanonicalUrl,
  constellationLink,
  externalActionLink,
  filterChip,
  installObjectCardCopyLinks,
  objectCardInteractionProjection,
  officialSourceLink,
  renderObjectCardActionRail,
  renderObjectCardPrimitives,
  staticFact,
} from "../site/affordance_grammar.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(ROOT, path), "utf8");

test("shared primitives emit the complete four-class grammar", () => {
  const constellation = constellationLink({ href: "/agencies/example/", label: "Example" });
  assert.match(constellation, /^<a class="ui-constellation-link"/);
  assert.match(constellation, /<span aria-hidden="true">◆<\/span>/);
  assert.doesNotMatch(constellation, /target=/);

  const source = officialSourceLink({ href: "https://example.gov/record", label: "Official record" });
  assert.match(source, /target="_blank" rel="noopener noreferrer"/);
  assert.match(source, /<span aria-hidden="true">↗<\/span>/);

  const chip = filterChip({ label: "Open", count: 3, pressed: true, attributes: { "data-filter-href": "#money" } });
  assert.match(chip, /^<button type="button" class="ui-filter-chip" aria-pressed="true"/);
  assert.match(chip, /data-filter-href="#money"/);
  assert.match(chip, /<span class="ct">3<\/span>/);
  assert.doesNotMatch(chip, /\shref=/);
  assert.doesNotMatch(chip, /aria-current=/);

  const fact = staticFact({ label: "Unresolved agency" });
  assert.match(fact, /^<span class="ui-static-fact">/);
  assert.doesNotMatch(fact, /href=|cursor:pointer|text-decoration/);
});

test("filter chips keep a non-collapsible gap between label and count", () => {
  // Render-only bug: label text and .ct were adjacent inside display:flex with no gap,
  // so "Vehicles" + "1" painted as "Vehicles1". Spacing must come from CSS flex gap /
  // margin on .ct — not a collapsible whitespace text node between them.
  const brand = read("site/brand.css");
  assert.match(brand, /\.ui-filter-chip\.ui-filter-chip\{[^}]*\bgap\s*:\s*[^;}]+/, "ui-filter-chip declares flex gap");
  const chip = filterChip({ label: "Vehicles", count: 1 });
  assert.match(chip, /Vehicles<span class="ct">1<\/span>/);
  assert.doesNotMatch(chip, /Vehicles\s+<span class="ct">/, "spacing is CSS-owned, not a fragile text node");
});

test("scope rails do not regress into navigational links styled as chips", () => {
  const files = [
    "site/index.html",
    "site/following/index.html",
    "site/borough_scope_links.mjs",
    "site/following_view.mjs",
    "site/property_disposition_facets_ui.mjs",
    "site/app/property.mjs",
    "site/app/entities.mjs",
    "site/app/people.mjs",
  ];
  for (const file of files) {
    const source = read(file);
    assert.doesNotMatch(source, /<a\b[^>]*class="[^"]*\bchip\b[^\"]*"[^>]*href=/, `${file}: chip links are not filter controls`);
    assert.doesNotMatch(source, /href=[^>]+class="[^"]*\bchip\b/, `${file}: chip links are not filter controls`);
  }
});

test("static fallback scope controls are buttons with pressed state and destinations", () => {
  const index = read("site/index.html");
  for (const marker of ["data-money-mode", "data-money-location-basis", "data-money-temporal"]) {
    assert.match(index, new RegExp(`[^>]*${marker}[^>]*aria-pressed="(?:true|false)"`), `${marker} has aria-pressed`);
  }
  assert.match(index, /id="land-attendance-rail"><button[^>]*aria-pressed="true"/);
  assert.match(index, /id="rules-agency-rail"><button[^>]*aria-pressed="true"/);
  assert.doesNotMatch(index, /<a\b[^>]*(?:data-money-mode|data-money-location-basis|data-money-temporal)/);
});

test("object-card projection keeps title, copy, relation, and handoff semantics behind one contract", () => {
  const projection = objectCardInteractionProjection({
    target: { href: "/notices/20260815001", label: "School food services" },
    relations: [
      { label: "Department of Education", href: "/agencies/education/", verified: true },
      { label: "Unresolved vendor", href: "/vendors/guess/", verified: false },
    ],
    external_handoffs: [
      { label: "Official record", href: "https://example.gov/record", kind: "official_source" },
    ],
    kinetic_actions: [
      { label: "Respond", href: "https://example.gov/respond", kind: "respond", context_ready: true },
      { label: "Open notice", href: "/notices/20260815001", kind: "navigation", context_ready: true },
      { label: "Apply", href: "https://example.gov/apply", kind: "apply", context_ready: false },
    ],
  });

  assert.equal(projection.target.href, "/notices/20260815001");
  assert.equal(projection.copy_target, "https://cityscroll.org/notices/20260815001");
  assert.deepEqual(projection.kinetic_actions.map((action) => action.label), ["Respond"]);

  const html = renderObjectCardPrimitives(projection);
  assert.match(html, /^<div class="ui-object-card-interactions"/);
  assert.match(html, /class="ui-constellation-link ui-object-card-title"[^>]*href="\/notices\/20260815001"[^>]*><span aria-hidden="true">◆<\/span>School food services/);
  assert.match(html, /<button type="button" class="ui-object-card-copy"[^>]*data-object-card-copy="https:\/\/cityscroll\.org\/notices\/20260815001"[^>]*aria-live="polite"[^>]*>Copy link<\/button>/);
  assert.match(html, /◆<\/span>Department of Education/);
  assert.match(html, /class="ui-static-fact ui-object-card-relation-unresolved">Unresolved vendor<\/span>/);
  assert.doesNotMatch(html, /href="\/vendors\/guess\/"/);
  assert.match(html, /Official record<span aria-hidden="true">↗<\/span>/);
  assert.doesNotMatch(html, /<a[^>]*class="ui-object-card-interactions"/, "the card interaction wrapper is never a whole-row anchor");
});

test("external actions show the visible handoff glyph and preserve protocol-appropriate navigation", () => {
  const http = externalActionLink({ href: "https://example.gov/apply", label: "Apply in OASys", primary: true });
  assert.match(http, /class="ui-external-action primary"/);
  assert.match(http, /target="_blank" rel="noopener noreferrer"/);
  assert.match(http, /Apply in OASys<span aria-hidden="true">↗<\/span><span class="sr-only"> \(opens in new tab\)<\/span>/);

  const email = externalActionLink({ href: "mailto:help@example.gov", label: "Email the contact" });
  assert.match(email, /Email the contact<span aria-hidden="true">↗<\/span>/);
  assert.doesNotMatch(email, /target="_blank"/);

  const internal = externalActionLink({ href: "/notices/1", label: "Open notice" });
  assert.doesNotMatch(internal, /↗|target="_blank"/);
});

test("action rail heading is gated by context-ready kinetic actions or a source-backed guide", () => {
  const navigationOnly = objectCardInteractionProjection({
    target: { href: "/notices/1", label: "Notice" },
    kinetic_actions: [{ label: "Open notice", href: "/notices/1", kind: "navigation", context_ready: true }],
  });
  assert.equal(renderObjectCardActionRail(navigationOnly), "");

  const guided = objectCardInteractionProjection({
    target: { href: "/meetings/meeting%3Aboard%3A1", label: "Board meeting" },
    guide: { html: "<p>Join by the published meeting link.</p>", context_ready: true, source_backed: true },
  });
  assert.match(renderObjectCardActionRail(guided), /<h3>What can I do now\?<\/h3>/);
  assert.match(renderObjectCardActionRail(guided), /Join by the published meeting link/);
});

test("Copy link writes the canonical target and announces the exact success state", async () => {
  const writes = [];
  const button = {
    dataset: { objectCardCopy: "https://cityscroll.org/notices/20260815001" },
    textContent: "Copy link",
    setAttribute(name, value) { this[name] = value; },
  };
  const copied = await copyObjectCardCanonicalUrl(button, {
    writeText: async (value) => writes.push(value),
  });
  assert.equal(copied, true);
  assert.deepEqual(writes, ["https://cityscroll.org/notices/20260815001"]);
  assert.equal(button.textContent, "Copied ✓");
  assert.equal(button["aria-live"], "polite");

  const delegatedWrites = [];
  const delegatedButton = {
    dataset: { objectCardCopy: "https://cityscroll.org/notices/20260815002" },
    textContent: "Copy link",
    setAttribute() {},
  };
  let click;
  const root = {
    addEventListener(type, listener) { if (type === "click") click = listener; },
    contains(candidate) { return candidate === delegatedButton; },
  };
  installObjectCardCopyLinks(root, { writeText: async (value) => delegatedWrites.push(value) });
  click({ target: { closest: () => delegatedButton } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(delegatedWrites, ["https://cityscroll.org/notices/20260815002"]);
  assert.equal(delegatedButton.textContent, "Copied ✓");
});

test("shared external-action colors clear WCAG AA normal-text contrast", () => {
  const brand = read("site/brand.css");
  assert.match(brand, /--cs-brand-navy:\s*#1b3a8f/);
  assert.match(brand, /--cs-white:\s*#ffffff/);
  assert.match(brand, /--ui-external-action-bg:\s*var\(--cs-brand-navy\)/);
  assert.match(brand, /--ui-external-action-fg:\s*var\(--cs-white\)/);
  assert.match(brand, /\.ui-external-action\.ui-external-action[^}]*background:\s*var\(--ui-external-action-bg\)[^}]*color:\s*var\(--ui-external-action-fg\)/s);

  const channel = (hex) => {
    const value = Number.parseInt(hex, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (hex) => {
    const value = hex.replace("#", "").padEnd(6, hex.replace("#", ""));
    return 0.2126 * channel(value.slice(0, 2)) + 0.7152 * channel(value.slice(2, 4)) + 0.0722 * channel(value.slice(4, 6));
  };
  const ratio = (luminance("#fff") + 0.05) / (luminance("#1b3a8f") + 0.05);
  assert.ok(ratio >= 4.5, `expected at least 4.5:1, received ${ratio.toFixed(2)}:1`);
});

test("core installs the shared copy behavior and publishes the external-action renderer", () => {
  const core = read("site/app/core.mjs");
  assert.match(core, /installObjectCardCopyLinks\(document/);
  assert.match(core, /globalThis\.externalActionLink\s*=/);
});
