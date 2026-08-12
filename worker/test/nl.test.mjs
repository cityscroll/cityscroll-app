// Unit tests for /nl's paraphrase robustness + fail-soft contract. No live network — the
// Anthropic call is mocked, so these run offline in `npm test`. Real paraphrase-tolerance
// (does Haiku actually understand "school deals" == "education contracts") can only be proven
// against the live model — see e2e/nl.mjs's committed paraphrase fixture set for that; this
// file characterizes the deterministic parts of the pipeline around it: sanitize() normalizes
// whatever the model returns the same way regardless of phrasing, filterConfidence() correctly
// tells a confidently-narrowed filter from a near-empty one, and the pre-existing fail-soft
// contract (empty text / bad lens / no key / non-ok response / missing tool_use) is unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleNl, parseLensFilter } from "../src/nl.mjs";
import { filterConfidence } from "../src/lib/filter.mjs";

function mockAnthropic(toolInput) {
  return async () => ({
    ok: true,
    json: async () => ({ content: [{ type: "tool_use", name: "build_filter", input: toolInput }] }),
  });
}

function kvStore(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    async get(k) { return map.has(k) ? map.get(k) : null; },
    async put(k, v) { map.set(k, String(v)); },
    _map: map,
  };
}

function nlRequest(ip = "203.0.113.10") {
  return new Request("https://api.cityscroll.org/nl", {
    method: "POST",
    headers: {
      origin: "https://cityscroll.org",
      "CF-Connecting-IP": ip,
      "content-type": "application/json",
    },
    body: JSON.stringify({ lens: "money", text: "education contracts over 200k" }),
  });
}

test("filterConfidence: canonical fixture's filter (keywords+minAmount+months) is high confidence", () => {
  const filter = { keywords: ["education"], agency: null, minAmount: 200000, maxAmount: null, category: null, months: 3, noticeType: null, excludeSpecial: false };
  assert.equal(filterConfidence("money", filter), "high");
});

test("filterConfidence: nothing extracted (before: a paraphrase the model barely parsed looked identical to a confident empty search) -> low", () => {
  const filter = { keywords: [], agency: null, minAmount: null, maxAmount: null, category: null, months: null, noticeType: null, excludeSpecial: false };
  assert.equal(filterConfidence("money", filter), "low");
});

test("filterConfidence: a single narrowing field is enough to count as high", () => {
  assert.equal(filterConfidence("land", { keywords: [], boro: "Brooklyn", status: null }), "high");
  assert.equal(filterConfidence("land", { keywords: [], boro: null, status: null }), "low");
});

test("parseLensFilter: mocked model output is sanitized and gets confidence:'high' — paraphrase fixture shape (education/$200k/3mo)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockAnthropic({ keywords: ["education"], minAmount: 200000, months: 3, agency: null, maxAmount: null, category: null, noticeType: null, excludeSpecial: false });
  try {
    const res = await parseLensFilter({ ANTHROPIC_API_KEY: "test-key" }, "money", "education contracts over 200k due in the next 3 months");
    assert.deepEqual(res.filter.keywords, ["education"]);
    assert.equal(res.filter.minAmount, 200000);
    assert.equal(res.filter.months, 3);
    assert.equal(res.confidence, "high");
    assert.equal(res.lens, "money");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("parseLensFilter: model returns a near-empty filter -> confidence:'low' (the signal the UI's interpretation echo keys on)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockAnthropic({ keywords: [], minAmount: null, months: null, agency: null, maxAmount: null, category: null, noticeType: null, excludeSpecial: false });
  try {
    const res = await parseLensFilter({ ANTHROPIC_API_KEY: "test-key" }, "money", "something vague");
    assert.equal(res.confidence, "low");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---- fail-soft contract, unchanged by this card (characterization) -----------------------

test("parseLensFilter: empty text -> degraded, no fetch attempted", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  try {
    const res = await parseLensFilter({ ANTHROPIC_API_KEY: "test-key" }, "money", "   ");
    assert.deepEqual(res, { degraded: true, reason: "empty" });
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("parseLensFilter: unknown lens -> degraded 'bad-lens'", async () => {
  const res = await parseLensFilter({ ANTHROPIC_API_KEY: "test-key" }, "not-a-lens", "anything");
  assert.deepEqual(res, { degraded: true, reason: "bad-lens" });
});

test("parseLensFilter: no API key configured -> degraded 'no-key'", async () => {
  const res = await parseLensFilter({}, "money", "anything");
  assert.deepEqual(res, { degraded: true, reason: "no-key" });
});

test("parseLensFilter: non-ok API response -> degraded with the status code", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 529 });
  try {
    const res = await parseLensFilter({ ANTHROPIC_API_KEY: "test-key" }, "money", "anything");
    assert.deepEqual(res, { degraded: true, reason: "api-529" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("parseLensFilter: response with no tool_use block -> degraded 'no-tool' (never throws)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ content: [{ type: "text", text: "sorry, I can't help with that" }] }) });
  try {
    const res = await parseLensFilter({ ANTHROPIC_API_KEY: "test-key" }, "money", "anything");
    assert.deepEqual(res, { degraded: true, reason: "no-tool" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleNl: per-IP cap returns the existing graceful degradation", async () => {
  const originalFetch = globalThis.fetch;
  let modelCalls = 0;
  globalThis.fetch = async () => {
    modelCalls++;
    return mockAnthropic({
      keywords: ["education"], minAmount: 200000, months: null, agency: null,
      maxAmount: null, category: null, noticeType: null, excludeSpecial: false,
    })();
  };
  try {
    const env = {
      ANTHROPIC_API_KEY: "test-key",
      NL_METER: kvStore(),
      NL_MAX_PER_IP_DAY: "1",
    };
    const first = await handleNl(nlRequest(), env);
    const second = await handleNl(nlRequest(), env);
    assert.equal(first.status, 200);
    assert.equal((await first.json()).degraded, undefined);
    assert.deepEqual(await second.json(), { degraded: true, reason: "ip-cap" });
    assert.equal(modelCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleNl: meter failure fails closed without a model call", async () => {
  const originalFetch = globalThis.fetch;
  let modelCalls = 0;
  globalThis.fetch = async () => { modelCalls++; throw new Error("model must not run"); };
  const brokenMeter = {
    async get() { throw new Error("meter unavailable"); },
    async put() { throw new Error("meter unavailable"); },
  };
  try {
    const res = await handleNl(nlRequest(), {
      ANTHROPIC_API_KEY: "test-key",
      NL_METER: brokenMeter,
      NL_MAX_PER_IP_DAY: "1",
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { degraded: true, reason: "ip-cap" });
    assert.equal(modelCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
