// Pins worker/src/translate.mjs — D1-cached informal notice translation.
//
//   node --test test/translate.test.mjs   (from worker/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { getOrTranslate, handleTranslate } from "../src/translate.mjs";
import { sourceHash, translateNoticeFields } from "../src/lib/translate_notice.mjs";
import { noticeSourceText } from "../src/lib/translate_invariants.mjs";
import { overActorLimit } from "../src/lib/meter.mjs";

const NOTICE = {
  request_id: "20220314107",
  start_date: "2022-03-18",
  agency: "Housing Preservation and Development",
  type_of_notice: "Award",
  short_title: "IMMEDIATE EMERGENCY DEMOLITION OF 28 W 130th St, MANHATTAN",
  pin: "80622E0016001",
  contract_amount: 550000,
  description: "Emergency demolition at 28 W 130th St. Contract amount $550,000. Due 2022-04-01.",
  other_info: null,
  due_date: "2022-04-01",
};

function fakeDB(seed = {}) {
  const notices = seed.notices || {};
  const cache = seed.cache || {};
  return {
    _notices: notices,
    _cache: cache,
    prepare(sql) {
      return {
        _sql: sql,
        _args: [],
        bind(...args) { this._args = args; return this; },
        async first() {
          if (/FROM notices/.test(this._sql)) {
            const n = notices[this._args[0]];
            if (!n) return null;
            return {
              request_id: n.request_id,
              start_date: n.start_date,
              agency_name: n.agency,
              type_of_notice_description: n.type_of_notice,
              short_title: n.short_title,
              pin: n.pin,
              contract_amount: n.contract_amount,
              vendor_name: n.vendor_name || null,
              due_date: n.due_date || null,
              additional_description_1: n.description,
              other_info_1: n.other_info,
            };
          }
          if (/FROM notice_translations/.test(this._sql)) {
            const key = `${this._args[0]}::${this._args[1]}`;
            return cache[key] || null;
          }
          return null;
        },
        async run() {
          if (/INSERT OR REPLACE INTO notice_translations/.test(this._sql)) {
            const [request_id, lang, source_hash, payload, computed_at] = this._args;
            cache[`${request_id}::${lang}`] = { request_id, lang, source_hash, payload, computed_at };
          }
          return { success: true };
        },
      };
    },
  };
}

function kvStore(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    async get(k) { return map.has(k) ? map.get(k) : null; },
    async put(k, v) { map.set(k, v); },
    _map: map,
  };
}

test("translateNoticeFields: requests and reads a structured translation tool response", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({
        content: [{
          type: "tool_use",
          name: "return_translation",
          input: {
            title: "DEMOLICIÓN INMEDIATA DE EMERGENCIA DE 28 W 130th St, MANHATTAN",
            description: "Demolición de emergencia en 28 W 130th St. Monto del contrato $550,000. Vence 2022-04-01.",
          },
        }],
      }),
    };
  };
  try {
    const result = await translateNoticeFields(
      { ANTHROPIC_API_KEY: "test-key" },
      "es",
      NOTICE,
    );
    assert.equal(requestBody.tool_choice.type, "tool");
    assert.equal(requestBody.tool_choice.name, "return_translation");
    assert.equal(requestBody.tools[0].input_schema.additionalProperties, false);
    assert.match(result.title, /DEMOLICIÓN/);
    assert.match(result.description, /\$550,000/);
    assert.equal(result.model, "claude-haiku-4-5");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("translateNoticeFields: malformed model content fails closed without parsing free-form text", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      content: [{
        type: "text",
        text: "{\"title\":\"looks structured\",\"description\":\"but is not a tool response\"}",
      }],
    }),
  });
  try {
    const result = await translateNoticeFields(
      { ANTHROPIC_API_KEY: "test-key" },
      "es",
      NOTICE,
    );
    assert.deepEqual(result, { degraded: true, reason: "no-tool" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getOrTranslate: serves D1 cache without calling the model", async () => {
  const rowShape = {
    request_id: NOTICE.request_id,
    short_title: NOTICE.short_title,
    additional_description_1: NOTICE.description,
  };
  const hash = await sourceHash(noticeSourceText(rowShape));
  const payload = {
    ok: true,
    title: "DEMOLICIÓN DE EMERGENCIA — 28 W 130th St $550,000 80622E0016001 20220314107 Housing Preservation and Development 2022-04-01 2022-03-18",
    description: "Demolición en 28 W 130th St. $550,000. Due 2022-04-01. PIN 80622E0016001. 20220314107. Housing Preservation and Development.",
    model: "test-model",
    lang: "es",
    request_id: NOTICE.request_id,
  };
  const db = fakeDB({
    notices: { [NOTICE.request_id]: NOTICE },
    cache: {
      [`${NOTICE.request_id}::es`]: {
        source_hash: hash,
        payload: JSON.stringify(payload),
        computed_at: "2026-07-30T00:00:00.000Z",
      },
    },
  });

  let fetchCalls = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalls++; throw new Error("should not fetch"); };
  const meter = kvStore();
  try {
    const result = await getOrTranslate({ DB: db, NL_METER: meter }, NOTICE.request_id, "es", "203.0.113.10");
    assert.equal(result.ok, true);
    assert.equal(result.cached, true);
    assert.equal(result.title, payload.title);
    assert.equal(fetchCalls, 0);
    assert.equal(meter._map.size, 0);
  } finally {
    globalThis.fetch = orig;
  }
});

test("getOrTranslate: unknown notice → not-found, no cache write", async () => {
  const db = fakeDB({ notices: {} });
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify([]), { status: 200 });
  try {
    const result = await getOrTranslate({ DB: db, NL_METER: kvStore() }, "99999999999", "es");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "not-found");
    assert.equal(Object.keys(db._cache).length, 0);
  } finally {
    globalThis.fetch = orig;
  }
});

test("getOrTranslate: over daily cap fails closed on miss", async () => {
  const day = new Date().toISOString().slice(0, 10);
  const db = fakeDB({ notices: { [NOTICE.request_id]: NOTICE } });
  const meter = kvStore({ [`m:translate:${day}`]: "150" });
  const result = await getOrTranslate(
    { DB: db, NL_METER: meter, TRANSLATE_MAX_CALLS_PER_DAY: "150" },
    NOTICE.request_id,
    "es",
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "daily-cap");
});

test("getOrTranslate: per-IP cap fails closed before a new model call", async () => {
  const ip = "203.0.113.10";
  const db = fakeDB({ notices: { [NOTICE.request_id]: NOTICE } });
  const meter = kvStore();
  assert.equal(await overActorLimit(meter, "translate", ip, 1), false);
  const originalFetch = globalThis.fetch;
  let modelCalls = 0;
  globalThis.fetch = async () => { modelCalls++; throw new Error("model must not run"); };
  try {
    const result = await getOrTranslate(
      { DB: db, NL_METER: meter, TRANSLATE_MAX_PER_IP_DAY: "1", ANTHROPIC_API_KEY: "test-key" },
      NOTICE.request_id,
      "es",
      ip,
    );
    assert.deepEqual(result, { ok: false, reason: "ip-cap" });
    assert.equal(modelCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getOrTranslate: meter failure fails closed without a new model call", async () => {
  const db = fakeDB({ notices: { [NOTICE.request_id]: NOTICE } });
  const brokenMeter = {
    async get() { throw new Error("meter unavailable"); },
    async put() { throw new Error("meter unavailable"); },
  };
  const originalFetch = globalThis.fetch;
  let modelCalls = 0;
  globalThis.fetch = async () => { modelCalls++; throw new Error("model must not run"); };
  try {
    const result = await getOrTranslate(
      { DB: db, NL_METER: brokenMeter, ANTHROPIC_API_KEY: "test-key" },
      NOTICE.request_id,
      "es",
      "203.0.113.10",
    );
    assert.deepEqual(result, { ok: false, reason: "ip-cap" });
    assert.equal(modelCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleTranslate: rejects bad id and bad lang", async () => {
  const env = { DB: fakeDB(), NL_METER: kvStore() };
  const badId = await handleTranslate(
    new Request("https://api.cityscroll.org/translate/!!", { method: "GET", headers: { origin: "https://cityscroll.org" } }),
    env,
    "/translate/!!",
    {},
  );
  assert.equal(badId.status, 400);
  const body1 = await badId.json();
  assert.equal(body1.reason, "bad-id");

  const badLang = await handleTranslate(
    new Request("https://api.cityscroll.org/translate/20220314107?lang=de", {
      method: "GET",
      headers: { origin: "https://cityscroll.org" },
    }),
    env,
    "/translate/20220314107",
    {},
  );
  assert.equal(badLang.status, 400);
  const body2 = await badLang.json();
  assert.equal(body2.reason, "bad-lang");
});

test("handleTranslate: OPTIONS preflight", async () => {
  const res = await handleTranslate(
    new Request("https://api.cityscroll.org/translate/20220314107?lang=es", {
      method: "OPTIONS",
      headers: { origin: "https://cityscroll.org" },
    }),
    { DB: fakeDB(), NL_METER: kvStore() },
    "/translate/20220314107",
    {},
  );
  assert.equal(res.status, 204);
});

test("handleTranslate: serves cached translation with unofficial label", async () => {
  const rowShape = {
    request_id: NOTICE.request_id,
    short_title: NOTICE.short_title,
    additional_description_1: NOTICE.description,
  };
  const hash = await sourceHash(noticeSourceText(rowShape));
  // Payload must itself pass invariants so a real miss path would accept it; here we only
  // exercise the cache-hit path.
  const payload = {
    ok: true,
    title: "DEMOLICIÓN 28 W 130th St $550,000 PIN 80622E0016001 20220314107 Housing Preservation and Development 2022-04-01 2022-03-18",
    description: "Demolición en 28 W 130th St. Monto $550,000. Vence 2022-04-01. Housing Preservation and Development. PIN 80622E0016001. ID 20220314107.",
    model: "test-model",
    lang: "es",
    request_id: NOTICE.request_id,
  };
  const db = fakeDB({
    notices: { [NOTICE.request_id]: NOTICE },
    cache: {
      [`${NOTICE.request_id}::es`]: {
        source_hash: hash,
        payload: JSON.stringify(payload),
        computed_at: "2026-07-30T00:00:00.000Z",
      },
    },
  });
  const res = await handleTranslate(
    new Request("https://api.cityscroll.org/translate/20220314107?lang=es", {
      method: "GET",
      headers: { origin: "https://cityscroll.org" },
    }),
    { DB: db, NL_METER: kvStore() },
    "/translate/20220314107",
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.label, "unofficial_translation");
  assert.equal(body.lang, "es");
  assert.equal(body.cached, true);
  assert.match(res.headers.get("Cache-Control") || "", /max-age/);
});
