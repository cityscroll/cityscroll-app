import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BLOOMINGDALE_URLS, CB14_URLS, CONSULTATION_PILOT_SEEDS,
  decodeFormstackResponse, parseCb14BudgetPage, parseGoogleFormHtml,
} from "../site/consultation_publisher_adapters.mjs";

test("the frozen pilot has six records", () => assert.equal(CONSULTATION_PILOT_SEEDS.length, 6));

test("CB14 keeps annual rounds, aliases, offline form, and historical deadline", () => {
  const page = parseCb14BudgetPage(`<h1>FY2028 budget recommendations</h1><p>September 4, 2026</p><iframe data-src="${CB14_URLS.form}&embedded=true"></iframe><a href="${CB14_URLS.shortlinks[0]}">form</a>`);
  assert.equal(page.round, "FY2028");
  assert.deepEqual(page.deadline, { value: "2026-09-04", precision: "day" });
  assert.equal(page.iframe_url, `${CB14_URLS.form}&embedded=true`);
  assert.ok(page.aliases.includes(CB14_URLS.shortlinks[0]));
  const seed = CONSULTATION_PILOT_SEEDS.find((item) => item.id === "cb14-community-budget-fy2028");
  assert.equal(seed.archive_round.round, "FY2027");
  assert.equal(seed.channels.find((channel) => channel.kind === "offline_pdf").url, CB14_URLS.pdf);
});

test("Google shortlinks and iframe point to one canonical form", () => {
  const html = `href="${CB14_URLS.form}&embedded=true"`;
  assert.equal(parseGoogleFormHtml(html).canonical_url, CB14_URLS.form.split("?")[0]);
});

test("Formstack JSON is decoded without evaluating script and keeps languages distinct", () => {
  const result = decodeFormstackResponse(`<script>FSForm.render({"formResponse":{"id":6220403,"fields":[{"label":"English"}]}})</script>`);
  assert.equal(result.readable, true);
  assert.equal(result.accepted, true);
  assert.equal(result.payload.id, 6220403);
  const seed = CONSULTATION_PILOT_SEEDS.find((item) => item.id === "bloomingdale-library-and-housing");
  assert.deepEqual(seed.channels.map((channel) => channel.language), ["en", "es"]);
  assert.equal(seed.organizer_link, BLOOMINGDALE_URLS.reviewed_link);
  assert.equal(seed.organizer_refresh.http_status, 403);
});

test("A2: a blocked organizer refresh is never treated as a successful acquisition", () => {
  const seed = CONSULTATION_PILOT_SEEDS.find((item) => item.id === "bloomingdale-library-and-housing");
  assert.deepEqual(
    { status: seed.organizer_refresh.status, http_status: seed.organizer_refresh.http_status },
    { status: "failed", http_status: 403 },
  );
});

test("A4: aliases, language channels, and an unavailable deadline remain fixture-visible", () => {
  const page = parseCb14BudgetPage([
    `<a href="${CB14_URLS.shortlinks[0]}">English form</a>`,
    `<a href="${CB14_URLS.shortlinks[1]}">Spanish form</a>`,
    `<iframe data-src="${CB14_URLS.form}&embedded=true"></iframe>`,
  ].join(""));
  const seed = CONSULTATION_PILOT_SEEDS.find((item) => item.id === "bloomingdale-library-and-housing");

  assert.deepEqual(
    {
      shortlinks: CB14_URLS.shortlinks.map((url) => page.aliases.includes(url)),
      canonical_form: parseGoogleFormHtml(`<a href="${CB14_URLS.form}">form</a>`).canonical_url,
      languages: seed.channels.map((channel) => channel.language),
      one_consultation: CONSULTATION_PILOT_SEEDS.filter((item) => item.id === "bloomingdale-library-and-housing").length,
      deadline: seed.deadline,
    },
    {
      shortlinks: [true, true],
      canonical_form: CB14_URLS.form.split("?")[0],
      languages: ["en", "es"],
      one_consultation: 1,
      deadline: null,
    },
  );
});
