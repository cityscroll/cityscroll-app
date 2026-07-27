import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const i18nSrc = readFileSync(join(ROOT, "..", "i18n.js"), "utf8");
const windowStub = { LANG: "en", LANG_META: { en: { intlDate: "en-US" } } };
const en = new Function(
  "window",
  i18nSrc + "\nreturn window.STRINGS.en;"
)(windowStub);

function loadLang(lang) {
  const path = join(ROOT, "..", "i18n", "lang", `${lang}.js`);
  const langSrc = readFileSync(path, "utf8");
  const langWindow = { STRINGS: {} };
  const evaled = new Function(
    "window",
    "global",
    langSrc + `\nreturn window.STRINGS["${lang}"];`
  )(langWindow, { window: langWindow });
  return evaled;
}

const shippingLangs = ["es", "zh-Hans", "ru", "bn", "ht", "ko", "fr", "pl", "ar", "ur"];
const langCopies = Object.fromEntries(shippingLangs.map((lang) => [lang, loadLang(lang)]));

const freshness = "Rezoning data comes from NYC's own ZAP portal via NYC Open Data, which the city refreshes monthly — a change on the live ZAP site can take weeks to appear here.";
const freshnessLocalized = {
  es: "Los datos de rezonificación provienen del propio portal ZAP de NYC a través de NYC Open Data, que la ciudad actualiza mensualmente — un cambio en el sitio ZAP en vivo puede tardar semanas en aparecer aquí.",
  "zh-Hans": "重划数据来自纽约市自己的 ZAP 门户网站，通过 NYC Open Data 提供，城市每月都会更新——现场 ZAP 网站上的更改可能需要数周才能在此处显示。",
  ru: "Данные по зонированию поступают из собственного портала ZAP города Нью-Йорка через NYC Open Data, который город обновляет ежемесячно — изменение на живом сайте ZAP может появиться здесь через несколько недель.",
  bn: "NYC এর নিজস্ব ZAP পোর্টাল থেকে NYC Open Data এর মাধ্যমে ব্লক পুনঃজোনিং তথ্য আসে, যা শহরটি মাসিকভাবে হালনাগাদ করে — লাইভ ZAP সাইটের পরিবর্তন এখানে আসতে কয়েক সপ্তাহ সময় নিতে পারে।",
  ht: "Bòdone ZAP la soti nan pwòp pòtal ZAP NYC atravè NYC Open Data, ki vil la renouvle chak mwa — yon chanjman sou sit ZAP aktyèl la ka pran plizyè semèn pou parèt isit la.",
  ko: "재개발(Rezoning) 데이터는 NYC 자체 ZAP 포털에서 NYC Open Data를 통해 가져오며, 도시는 매월 갱신하므로 — 실시간 ZAP 사이트의 변경은 여기에서 반영되기까지 몇 주가 걸릴 수 있습니다.",
  fr: "Les données de révision de zonage proviennent du propre portail ZAP de NYC via NYC Open Data, que la ville met à jour chaque mois — une modification sur le site ZAP en direct peut prendre plusieurs semaines pour apparaître ici.",
  pl: "Dane dotyczące zmian przeznaczenia pochodzą z własnego portalu ZAP NYC przez NYC Open Data; miasto aktualizuje go co miesiąc — zmiana na żywym serwisie ZAP może pojawić się tutaj dopiero po kilku tygodniach.",
  ar: "تأتي بيانات إعادة تقسيم المناطق من بوابة ZAP الخاصة بمدينة نيويورك عبر NYC Open Data، والتي تُحدّثها المدينة شهريًا — قد يستغرق ظهور أي تغيير على موقع ZAP المباشر هنا عدة أسابيع.",
  ur: "ریزوننگ کا ڈیٹا NYC کے اپنے ZAP پورٹل سے NYC Open Data کے ذریعے آتا ہے، جسے شہر ہر ماہ تازہ کرتا ہے — لائیو ZAP سائٹ پر تبدیلی یہاں ظاہر ہونے میں ہفتے لگا سکتی ہے۔",
};

test("English land banner copy updated for no-distance fallback", () => {
  assert.equal(en.banner_none_nearest, "No rezoning on this block. In <b>{area}</b>:");
  assert.equal(en.banner_none_active_nearest, "No active rezoning on this block. Recent rezonings in <b>{area}</b>:");
  assert.equal(en.banner_none_lot, "No rezoning filed on this lot ({label}). Recent rezonings in <b>{area}</b>:");
});

for (const lang of shippingLangs) {
  test(`Land banner copy updated for ${lang}`, () => {
    assert.equal(langCopies[lang].banner_none_nearest, "No rezoning on this block. In <b>{area}</b>:", `${lang}.banner_none_nearest`);
    assert.equal(langCopies[lang].banner_none_active_nearest, "No active rezoning on this block. Recent rezonings in <b>{area}</b>:", `${lang}.banner_none_active_nearest`);
    assert.equal(langCopies[lang].banner_none_lot, "No rezoning filed on this lot ({label}). Recent rezonings in <b>{area}</b>:", `${lang}.banner_none_lot`);
    assert.ok(typeof freshnessLocalized[lang] === "string");
    assert.ok(langCopies[lang].zap_explainer_html.includes(freshnessLocalized[lang]), `${lang}.zap_explainer_html`);
  });
}

test("English land explainer includes approved freshness disclosure verbatim", () => {
  assert.ok(en.zap_explainer_html.includes(freshness), "en.zap_explainer_html");
});
