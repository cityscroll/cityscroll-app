import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const i18nSrc = readFileSync(join(ROOT, "..", "site", "i18n.js"), "utf8");
const indexSrc = readFileSync(join(ROOT, "..", "site", "index.html"), "utf8");
const windowStub = { LANG: "en", LANG_META: { en: { intlDate: "en-US" } } };
const en = new Function(
  "window",
  i18nSrc + "\nreturn window.STRINGS.en;"
)(windowStub);

function loadLang(lang) {
  const path = join(ROOT, "..", "site", "i18n", "lang", `${lang}.js`);
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

// Site-owner-approved Land methodology note (verbatim ceiling).
const methodology =
  "Rezoning data comes from NYC's Zoning Application Portal (ZAP) via NYC Open Data, which the city refreshes about monthly. A change on the live ZAP site can take weeks to appear here. Lot outlines use the same tax-lot (BBL) → MapPLUTO join ZAP Search describes. When lots cannot be matched, the map is approximate — confirm on ZoLa.";

const methodologyLocalized = {
  es: "Los datos de rezonificación provienen del Portal de Solicitudes de Zonificación (ZAP) de NYC a través de NYC Open Data, que la ciudad actualiza aproximadamente cada mes. Un cambio en el sitio ZAP en vivo puede tardar semanas en aparecer aquí. Los contornos de lotes usan el mismo emparejamiento de lote fiscal (BBL) → MapPLUTO que describe ZAP Search. Cuando no se pueden emparejar lotes, el mapa es aproximado — confirme en ZoLa.",
  "zh-Hans": "重划数据来自纽约市的分区申请门户（ZAP），经由 NYC Open Data 提供，城市大约每月更新一次。实时 ZAP 网站上的更改可能需要数周才能在此处显示。地块轮廓使用与 ZAP Search 相同的税地（BBL）→ MapPLUTO 匹配方式。无法匹配地块时，地图仅为近似 — 请在 ZoLa 上确认。",
  ru: "Данные по изменению зонирования поступают из Портала заявок на зонирование (ZAP) Нью-Йорка через NYC Open Data, который город обновляет примерно ежемесячно. Изменение на живом сайте ZAP может появиться здесь через несколько недель. Контуры участков используют то же сопоставление налогового участка (BBL) → MapPLUTO, что описывает ZAP Search. Если участки сопоставить нельзя, карта приблизительная — уточните на ZoLa.",
  bn: "পুনঃজোনিং তথ্য NYC-এর Zoning Application Portal (ZAP) থেকে NYC Open Data-এর মাধ্যমে আসে, যা শহরটি প্রায় মাসিক হালনাগাদ করে। লাইভ ZAP সাইটের পরিবর্তন এখানে আসতে কয়েক সপ্তাহ সময় নিতে পারে। লট সীমারেখা ZAP Search-এ বর্ণিত একই ট্যাক্স-লট (BBL) → MapPLUTO যোগ ব্যবহার করে। লট মিল না হলে মানচিত্র আনুমানিক — ZoLa-তে নিশ্চিত করুন।",
  ht: "Done rezonaj yo soti nan Pòtal Aplikasyon Zonaj (ZAP) NYC atravè NYC Open Data, ke vil la rafrechi apeprè chak mwa. Yon chanjman sou sit ZAP aktyèl la ka pran plizyè semèn pou parèt isit la. Kontou lot yo itilize menm rantre lot taks (BBL) → MapPLUTO ZAP Search dekri. Lè lot yo pa ka matche, kat la apwoksimatif — konfime sou ZoLa.",
  ko: "재개발(Rezoning) 데이터는 NYC의 구역 신청 포털(ZAP)에서 NYC Open Data를 통해 제공되며, 도시는 대략 매월 갱신합니다. 실시간 ZAP 사이트의 변경은 여기에서 반영되기까지 몇 주가 걸릴 수 있습니다. 부지 윤곽은 ZAP Search가 설명하는 것과 같은 세금 부지(BBL) → MapPLUTO 연결을 사용하며, 부지를 맞출 수 없으면 지도는 근사치입니다 — ZoLa에서 확인하세요.",
  fr: "Les données de révision de zonage proviennent du portail de demandes de zonage (ZAP) de NYC via NYC Open Data, que la ville met à jour environ chaque mois. Une modification sur le site ZAP en direct peut prendre plusieurs semaines pour apparaître ici. Les contours de parcelles utilisent la même jointure lot fiscal (BBL) → MapPLUTO que décrit ZAP Search. Lorsque les parcelles ne peuvent pas être appariées, la carte est approximative — confirmez sur ZoLa.",
  pl: "Dane dotyczące zmian przeznaczenia pochodzą z Portalu Wniosków o Zagospodarowanie (ZAP) NYC przez NYC Open Data. Miasto aktualizuje go mniej więcej co miesiąc. Zmiana na żywym serwisie ZAP może pojawić się tutaj dopiero po kilku tygodniach. Obrysy działek używają tego samego połączenia działki podatkowej (BBL) → MapPLUTO, które opisuje ZAP Search. Gdy działek nie da się dopasować, mapa jest przybliżona — potwierdź na ZoLa.",
  ar: "تأتي بيانات إعادة تقسيم المناطق من بوابة طلبات التقسيم (ZAP) في مدينة نيويورك عبر NYC Open Data، والتي تُحدّثها المدينة نحو شهريًا. قد يستغرق ظهور أي تغيير على موقع ZAP المباشر هنا عدة أسابيع. تستخدم حدود القطع نفس ربط قطعة الضريبة (BBL) → MapPLUTO الذي يصفه ZAP Search. عندما يتعذر مطابقة القطع، تكون الخريطة تقريبية — أكّد على ZoLa.",
  ur: "ریزوننگ کا ڈیٹا NYC کے Zoning Application Portal (ZAP) سے NYC Open Data کے ذریعے آتا ہے، جسے شہر تقریباً ماہانہ تازہ کرتا ہے۔ لائیو ZAP سائٹ پر تبدیلی یہاں ظاہر ہونے میں ہفتے لگا سکتی ہے۔ پلاٹ کی حدود وہی ٹیکس-لاٹ (BBL) → MapPLUTO جوڑ استعمال کرتی ہیں جو ZAP Search بیان کرتا ہے۔ جب پلاٹ نہیں مل سکتیں تو نقشہ تخمینی ہے — ZoLa پر تصدیق کریں۔",
};

test("English land banner copy updated for no-distance fallback", () => {
  assert.equal(en.banner_none_nearest, "No rezoning on this block. In <b>{area}</b>:");
  assert.equal(en.banner_none_active_nearest, "No active rezoning on this block. Recent rezonings in <b>{area}</b>:");
  assert.equal(en.banner_none_lot, "No rezoning filed on this lot ({label}). Recent rezonings in <b>{area}</b>:");
});

for (const lang of shippingLangs) {
  test(`Land methodology note ships for ${lang}`, () => {
    assert.equal(langCopies[lang].banner_none_nearest, "No rezoning on this block. In <b>{area}</b>:", `${lang}.banner_none_nearest`);
    assert.equal(langCopies[lang].banner_none_active_nearest, "No active rezoning on this block. Recent rezonings in <b>{area}</b>:", `${lang}.banner_none_active_nearest`);
    assert.equal(langCopies[lang].banner_none_lot, "No rezoning filed on this lot ({label}). Recent rezonings in <b>{area}</b>:", `${lang}.banner_none_lot`);
    assert.equal(langCopies[lang].zap_explainer_html, methodologyLocalized[lang], `${lang}.zap_explainer_html`);
    assert.ok(langCopies[lang].zap_project_index_html.includes("<b>"), `${lang}.zap_project_index_html`);
    assert.ok(
      !langCopies[lang].zap_project_index_html.includes(methodologyLocalized[lang]),
      `${lang}: project-index must not fork methodology`
    );
  });
}

test("English land methodology is the approved note verbatim", () => {
  assert.equal(en.zap_explainer_html, methodology, "en.zap_explainer_html");
  assert.ok(en.zap_project_index_html.includes("ZAP indexes by"), "en.zap_project_index_html");
  assert.ok(
    !en.zap_project_index_html.includes("refreshes about monthly"),
    "project-index must not duplicate methodology"
  );
});

test("successful Land list reuses zap_explainer_html (no forked methodology copy)", () => {
  assert.match(indexSrc, /id="land-methodology"\s*>\$\{t\("zap_explainer_html"\)\}/);
  assert.match(
    indexSrc,
    /t\("zap_project_index_html"\)\s*\} \$\{t\("zap_explainer_html"\)\}/
  );
  // Methodology key appears for the success note and the empty-state composition only —
  // not a second independent English string literal in index.html.
  const methodologyLiterals = indexSrc.match(/refreshes about monthly/g) || [];
  assert.equal(methodologyLiterals.length, 0, "do not hardcode methodology in index.html");
});
