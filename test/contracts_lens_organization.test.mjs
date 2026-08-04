import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const moneySource = readFileSync(new URL("../site/app/money-list.mjs", import.meta.url), "utf8");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  let depth = 0;
  let opened = false;
  for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    if (source[i] === "{") {
      depth += 1;
      opened = true;
    } else if (source[i] === "}" && opened && --depth === 0) {
      return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced function ${name}`);
}

const moneySection = html.slice(
  html.indexOf('<section id="tab-money"'),
  html.indexOf("<!-- ============ PEOPLE"),
);

test("Contracts follows the shared lens hierarchy with the answer and primary facet first", () => {
  const intro = moneySection.indexOf('id="money-domain-intro"');
  const naturalLanguage = moneySection.indexOf('class="nlbox money-nlbox"');
  const toolbar = moneySection.indexOf('class="lens-toolbar money-toolbar"');
  const primary = moneySection.indexOf('id="money-method-primary"');
  const resultbar = moneySection.indexOf('class="lens-resultbar"');
  const results = moneySection.indexOf('class="grid"');
  assert.ok(intro >= 0 && intro < naturalLanguage);
  assert.ok(naturalLanguage < toolbar && toolbar < primary);
  assert.ok(primary < resultbar && resultbar < results);
  assert.match(moneySection, /class="lens-method money-method"[\s\S]*?class="contract-example-list"/);
});

test("Contracts keeps keyword and method visible while secondary controls stay in one disclosure", () => {
  const disclosureStart = moneySection.indexOf('id="money-more-filters"');
  const disclosureEnd = moneySection.indexOf('</details>', disclosureStart);
  const disclosure = moneySection.slice(disclosureStart, disclosureEnd);
  assert.ok(moneySection.indexOf('id="kw"') < disclosureStart);
  for (const id of ["mode", "agency", "minamt", "closingweek"]) {
    assert.match(disclosure, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(disclosure, /id="sort"|id="methodfacet"/);
  assert.ok(moneySection.indexOf('id="methodfacet"') > disclosureEnd);
  assert.match(moneySection, /id="rescount"[\s\S]*?id="sort"/);
});

test("Contracts reserves token-based space for its asynchronous primary facet", () => {
  assert.match(moneySection, /class="nlbox money-nlbox"/);
  assert.match(moneySection, /class="money-method-slot"[\s\S]*?id="money-method-primary"/);
  assert.match(
    html,
    /\.money-nlbox\{min-height:calc\(var\(--space-8\) \* 2 \+ var\(--space-5\)\)\}[\s\S]*?\.money-method-slot\{min-height:calc\(var\(--space-8\) \+ var\(--space-5\) \+ var\(--space-1\)\)\}/,
  );
});

test("Contracts initial and zero-result detail states stay quiet", () => {
  assert.match(moneySection, /<div class="detail" id="detail" translate="no"><\/div>/);
  assert.doesNotMatch(moneySection, /pick_notice_empty/);
  const renderList = extractFunction(moneySource, "renderList");
  assert.match(renderList, /#detail/);
  assert.match(renderList, /selectedRFP=null/);
});

test("shared lens chrome consumes design-language tokens", () => {
  const start = html.indexOf(".lens-intro{");
  const end = html.indexOf("/* Small-multiples collapse", start);
  const css = html.slice(start, end);
  assert.match(css, /var\(--color-action\)/);
  assert.match(css, /var\(--color-surface\)/);
  assert.match(css, /var\(--space-3\)/);
  assert.match(css, /var\(--radius-md\)/);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(/i);
});

const { partitionMoneyRows } = new Function(
  `${extractFunction(moneySource, "moneyRowIsClosed")}
   ${extractFunction(moneySource, "partitionMoneyRows")}
   return { partitionMoneyRows };`,
)();

test("All RFPs keeps current deadlines first and preserves every counted row", () => {
  const rows = [
    { request_id: "closed-new", due_date: "2026-07-01" },
    { request_id: "later", due_date: "2026-09-10" },
    { request_id: "soon", due_date: "2026-08-05" },
    { request_id: "closed-old", due_date: "2025-12-01" },
  ];
  const sections = partitionMoneyRows(rows, "2026-08-03");
  assert.deepEqual(sections.current.map((item) => item.row.request_id), ["soon", "later"]);
  assert.deepEqual(sections.closed.map((item) => item.row.request_id), ["closed-new", "closed-old"]);
  assert.equal(sections.current.length + sections.closed.length, rows.length);
  assert.deepEqual(
    [...sections.current, ...sections.closed].map((item) => item.index).sort((a, b) => a - b),
    [0, 1, 2, 3],
  );
});

test("secondary-filter badge names active state and hides at the default", () => {
  const update = extractFunction(moneySource, "updateMoneyMoreFiltersState");
  assert.match(update, /mode!=="open"/);
  assert.match(update, /closingWeek/);
  assert.match(update, /property_filters_active/);
  assert.match(update, /badge\.hidden=active===0/);
});
