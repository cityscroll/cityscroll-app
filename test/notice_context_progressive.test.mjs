import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../site/app/notice-context.mjs", import.meta.url), "utf8");

function extractFn(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  let depth = 0;
  let seen = false;
  for (let index = source.indexOf("{", start); index < source.length; index += 1) {
    if (source[index] === "{") {
      depth += 1;
      seen = true;
    } else if (source[index] === "}" && --depth === 0 && seen) {
      return source.slice(start, index + 1);
    }
  }
  throw new Error(`unbalanced ${name}`);
}

function createElement() {
  let html = "";
  const element = {
    dataset: {},
    get innerHTML() { return html; },
    set innerHTML(value) { html = String(value); },
    querySelector(selector) {
      const slot = selector.match(/data-notice-context-slot="([^"]+)"/);
      const token = slot
        ? `<span data-notice-context-slot="${slot[1]}"></span>`
        : selector.includes("data-attachment-tables-host")
          ? `<div class="attachment-tables-host" data-attachment-tables-host="1"></div>`
          : null;
      if (!token || !html.includes(token)) return null;
      return {
        set outerHTML(value) {
          html = html.replace(token, String(value));
        },
      };
    },
    insertAdjacentHTML(_position, value) {
      html += String(value);
    },
  };
  return element;
}

function buildFill({ noticeFlags, awardContext, related, mandate, tables }) {
  const document = { contains: (node) => node?.dataset === elementDataset }; // replaced per call
  const sourceForFunction = [
    "const CONTEXT_SLOTS=[\"mandate\",\"related\",\"flags\",\"award\"];",
    "const noticeContextTimingMark=()=>{};",
    extractFn("contextSlotsHTML"),
    extractFn("contextSlot"),
    extractFn("contextReady"),
    extractFn("fillContext"),
    "return fillContext;",
  ].join("\n");
  let elementDataset;
  const elementDatasetRef = { get value() { return elementDataset; } };
  const fill = new Function(
    "attachmentChipHTML", "noticeFlags", "awardContext", "attachmentRelatedHTMLFor",
    "mandateBacklinksHTMLFor", "attachmentTablesHTMLFor", "attachmentTablesTools",
    "noticeContextReady", "runtimeRumSemanticMilestones", "document", sourceForFunction,
  )(
    () => '<div class="attachment-panel"><div class="attachment-tables-host" data-attachment-tables-host="1"></div></div>',
    noticeFlags,
    awardContext,
    related,
    mandate,
    tables,
    async () => ({ bindAttachmentTableSort() {} }),
    (_rum, { resultState }) => states.push(resultState),
    () => ({}),
    {
      contains(node) { return node?.dataset === elementDatasetRef.value; },
    },
  );
  return (record, element, settledWith) => {
    elementDataset = element.dataset;
    return fill(record, element, settledWith);
  };
}

let states;

test("Notice context reports its first card before deferred owners and settles with every enrichment", async () => {
  states = [];
  const deferred = (value, delay) => new Promise((resolve) => setTimeout(() => resolve(value), delay));
  const fill = buildFill({
    noticeFlags: async () => deferred([{ lvl: "soon", t: "flag" }], 20),
    awardContext: async () => deferred("<award>award context</award>", 30),
    related: async () => deferred("<related>related edge</related>", 40),
    mandate: async () => deferred("<mandate>mandate backlink</mandate>", 50),
    tables: async () => deferred("<table><tbody><tr><td>attachment table</td></tr></tbody></table>", 60),
  });
  const element = createElement();

  const pending = fill({ request_id: "notice-1" }, element);
  assert.deepEqual(states, ["content"]);
  assert.match(element.innerHTML, /attachment-panel/);
  assert.doesNotMatch(element.innerHTML, /award context|related edge|mandate backlink|attachment table/);
  assert.notEqual(element.dataset.noticeContextSettled, "true");

  await pending;
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal(element.dataset.noticeContextReady, "true");
  assert.equal(element.dataset.noticeContextSettled, "true");
  assert.deepEqual(states, ["content"]);
  assert.match(element.innerHTML, /mandate backlink/);
  assert.match(element.innerHTML, /related edge/);
  assert.match(element.innerHTML, /flag/);
  assert.match(element.innerHTML, /award context/);
  assert.match(element.innerHTML, /attachment table/);
});

test("Notice context can include late attachment hydration in the settled boundary", async () => {
  states = [];
  const fill = buildFill({
    noticeFlags: async () => [],
    awardContext: async () => "",
    related: async () => "",
    mandate: async () => "",
    tables: async () => "",
  });
  const element = createElement();
  let release;
  const attachmentHydration = new Promise((resolve) => { release = resolve; });
  fill({ request_id: "notice-2" }, element, [attachmentHydration]);
  assert.deepEqual(states, ["content"]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.notEqual(element.dataset.noticeContextSettled, "true");
  release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(element.dataset.noticeContextSettled, "true");
});
