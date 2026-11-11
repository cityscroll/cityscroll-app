// Guards against reintroducing blanket "no cookies / nobody tracked / no visitor
// profiles" promises into shipped dictionaries. Those two dormant keys no longer
// describe the product; the site owner has not written a replacement commitment,
// so the promise clauses are removed and nothing is added in their place.
//
// Nothing in this file is a legal review or legal advice.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHIPPING_LANGS = ["ar", "bn", "es", "fr", "ht", "ko", "pl", "ru", "ur", "zh-Hans"];

const STATS_AFTER = {
  en: "Site totals. See use by day.",
  ar: "أعداد نشاط مجمّعة نجمعها مباشرة.",
  bn: "নিজস্ব, সমষ্টিগত কার্যকলাপের হিসাব।",
  es: "Conteos agregados propios de actividad.",
  fr: "Comptages agrégés collectés directement.",
  ht: "Kantite aktivite total nou kolekte dirèkteman.",
  ko: "사이트가 직접 수집한 집계 활동 수치입니다.",
  pl: "Własne, zbiorcze liczniki aktywności.",
  ru: "Собственные агрегированные счётчики активности.",
  ur: "براہِ راست جمع کیے گئے مجموعی سرگرمی کے اعداد۔",
  "zh-Hans": "本站直接收集的汇总活动计数。",
};

const CHG_REMOVED_CLAUSES = [
  " — no accounts, no cookies, nobody tracked",
  " — بلا حسابات، بلا ملفات تعريف ارتباط، لا أحد يُتَبَّع",
  " — কোনো অ্যাকাউন্ট নেই, কোনো কুকি নেই, কেউ ট্র্যাক করা হয় না",
  " — sin cuentas, sin cookies, nadie es rastreado",
  " — aucun compte, aucun témoin, personne n'est suivi",
  " — pa gen kont, pa gen cookies, pèsonn pa swiv",
  " — 계정도, 쿠키도, 추적 대상도 없습니다",
  " — bez kont, bez plików cookie, nikt nie jest śledzony",
  " — без аккаунтов, без cookie, никто не отслеживается",
  " — کوئی اکاؤنٹس نہیں، کوئی کوکیز نہیں، کسی کو ٹریک نہیں کیا جاتا",
  "——没有账户、没有 Cookie、不追踪任何人",
];

const BLANKET = [
  /no cookies/i,
  /nobody tracked/i,
  /nobody is tracked/i,
  /no visitor profiles/i,
  /no accounts,/i,
  /no tracking/i,
  /no cookies?,? no/i,
];

const ALLOWLISTED_LINES = new Set([
  // Module header in the first-party aggregate collector; describes the collector, not a site promise.
  "site/analytics.js:1",
]);

const STALE_STATS_LINE_EN =
  '    stats_p_usage: "Site totals. See use by day. No cookies. No visitor profiles.",';

function loadEn() {
  const i18nSrc = readFileSync(join(ROOT, "site", "i18n.js"), "utf8");
  const windowStub = { LANG: "en", LANG_META: { en: { intlDate: "en-US" } } };
  return new Function("window", i18nSrc + "\nreturn window.STRINGS.en;")(windowStub);
}

function loadLang(lang) {
  const path = join(ROOT, "site", "i18n", "lang", `${lang}.js`);
  const langSrc = readFileSync(path, "utf8");
  const langWindow = { STRINGS: {} };
  return new Function(
    "window",
    "global",
    langSrc + `\nreturn window.STRINGS[${JSON.stringify(lang)}];`,
  )(langWindow, { window: langWindow });
}

function shippedTextFiles() {
  // Prefer working-tree files. A reduced checkout may omit sparse paths that are
  // still tracked; those paths are outside this change and are skipped when absent.
  return execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .filter(
      (f) =>
        (/^site\//.test(f) && !/^site\/(data|vendor|media)\//.test(f)) ||
        (/^worker\/src\//.test(f) && !/^worker\/src\/data\//.test(f)),
    )
    .filter((f) => /\.(html|js|mjs|md|txt|json|xml|svg|css)$/.test(f))
    .filter((f) => existsSync(join(ROOT, f)));
}

function blanketFindings(fileContents) {
  const findings = [];
  for (const [rel, text] of fileContents) {
    const lines = text.split("\n");
    lines.forEach((line, idx) => {
      const loc = `${rel}:${idx + 1}`;
      if (ALLOWLISTED_LINES.has(loc)) return;
      for (const re of BLANKET) {
        if (re.test(line)) findings.push(`${loc} ${re}`);
      }
    });
  }
  return findings;
}

test("stats_p_usage drops the blanket cookie/profile promise in every shipping dictionary", () => {
  const en = loadEn();
  assert.equal(en.stats_p_usage, STATS_AFTER.en);
  for (const lang of SHIPPING_LANGS) {
    const dict = loadLang(lang);
    assert.equal(
      dict.stats_p_usage,
      STATS_AFTER[lang],
      `${lang}.stats_p_usage must equal the pinned post-edit string`,
    );
  }
});

test("chg_0702b_foryou_html keeps the aggregate-counts note and drops the no-accounts clause", () => {
  const en = loadEn();
  assert.match(en.chg_0702b_foryou_html, /\(aggregate counts only\)\./);
  assert.match(en.chg_0702b_foryou_html, /never who clicked/);
  for (const clause of CHG_REMOVED_CLAUSES) {
    assert.equal(
      en.chg_0702b_foryou_html.includes(clause),
      false,
      `English changelog entry still contains removed clause ${JSON.stringify(clause)}`,
    );
  }
  for (const lang of SHIPPING_LANGS) {
    const dict = loadLang(lang);
    assert.equal(typeof dict.chg_0702b_foryou_html, "string");
    for (const clause of CHG_REMOVED_CLAUSES) {
      assert.equal(
        dict.chg_0702b_foryou_html.includes(clause),
        false,
        `${lang} changelog entry still contains removed clause ${JSON.stringify(clause)}`,
      );
    }
  }
});

test("shipped site/worker sources have no blanket privacy-promise lines outside the analytics allowlist", () => {
  const files = shippedTextFiles();
  const contents = files.map((f) => [f, readFileSync(join(ROOT, f), "utf8")]);
  const findings = blanketFindings(contents);
  assert.deepEqual(findings, [], `unexpected blanket-promise matches:\n${findings.join("\n")}`);
});

test("negative control: reinserting the old English stats_p_usage line is detected", () => {
  const files = shippedTextFiles();
  const contents = new Map(files.map((f) => [f, readFileSync(join(ROOT, f), "utf8")]));
  const i18n = contents.get("site/i18n.js");
  assert.ok(i18n, "site/i18n.js must be in the shipped set");
  const withLeftover = i18n.replace(
    '    stats_p_usage: "Site totals. See use by day.",',
    STALE_STATS_LINE_EN,
  );
  assert.notEqual(withLeftover, i18n, "post-edit stats_p_usage line must be present to reinsert against");
  contents.set("site/i18n.js", withLeftover);
  const findings = blanketFindings([...contents.entries()]);
  assert.ok(findings.length > 0, "reinserted stale English stats line must produce a finding");
});
