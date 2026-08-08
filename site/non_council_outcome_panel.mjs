import { officialSourceLink } from "./affordance_grammar.mjs";

// Receipt-backed community-board decision panel for non-Council meeting notices.
// The committed lookup may remain empty. Rendering requires the artifact-level
// receipt gate plus the collector's exact body/date/matter-token join.

export const NON_COUNCIL_OUTCOME_LOOKUP_SCHEMA = "cityscroll.non_council_outcome_lookup.v1";
export const NON_COUNCIL_OUTCOME_PANEL_SCHEMA = "cityscroll.non_council_outcome_panel.v1";

let outcomeLookupPromise = null;

export function loadNonCouncilOutcomeLookup(fetchImpl = globalThis.fetch) {
  if (!outcomeLookupPromise) {
    outcomeLookupPromise = Promise.resolve(fetchImpl("data/non_council_outcome_lookup.json", {
      cache: "no-cache",
      credentials: "omit",
    }))
      .then((response) => (response?.ok ? response.json() : null))
      .catch(() => null);
  }
  return outcomeLookupPromise;
}

export function resetNonCouncilOutcomeLookupCache() {
  outcomeLookupPromise = null;
}

export async function loadNonCouncilOutcomePanel(requestId, opts = {}) {
  return nonCouncilOutcomePanelHTML(await loadNonCouncilOutcomeLookup(), requestId, opts);
}

export function buildNonCouncilOutcomePanelView(payload, requestId) {
  const id = clean(requestId);
  const row = id ? payload?.notices?.[id] : null;
  if (
    payload?.schema !== NON_COUNCIL_OUTCOME_LOOKUP_SCHEMA
    || payload?.coverage?.join_bridge_enabled !== true
    || payload?.coverage?.honest_absent !== true
    || !row
    || clean(row.request_id) !== id
  ) return emptyView();

  const join = row.join || {};
  const outcome = row.outcome || {};
  const meetingDate = isoDate(row.meeting_date);
  const minutesUrl = safeHttpsUrl(row.provenance?.document_url);
  if (
    join.method !== "exact_body_date_matter_tokens"
    || clean(join.body_id) !== clean(row.body_id)
    || !meetingDate
    || isoDate(join.event_date) !== meetingDate
    || !clean(join.matter_token)
    || row.provenance?.text_status !== "ok"
    || outcome.explicit !== true
    || !["approved", "rejected", "held"].includes(clean(outcome.action))
    || !minutesUrl
  ) return emptyView();

  return {
    schema: NON_COUNCIL_OUTCOME_PANEL_SCHEMA,
    show: true,
    request_id: id,
    body_name: bodyName(row),
    meeting_date: meetingDate,
    action: clean(outcome.action),
    tally: validTally(outcome.tally),
    minutes_url: minutesUrl,
  };
}

export function nonCouncilOutcomePanelHTML(payloadOrView, requestId, opts = {}) {
  const view = payloadOrView?.schema === NON_COUNCIL_OUTCOME_PANEL_SCHEMA
    ? payloadOrView
    : buildNonCouncilOutcomePanelView(payloadOrView, requestId);
  if (!view.show) return "";

  const t = localizedT(opts.lang);
  const esc = typeof opts.esc === "function" ? opts.esc : defaultEsc;
  const date = typeof opts.date === "function" ? opts.date : defaultDate;
  const action = t(`non_council_outcome_action_${view.action}`);
  const tally = view.tally
    ? `<div class="notice-fact-row" data-field="published-vote">
        <div class="stage-name">${esc(t("non_council_outcome_vote_lbl"))}</div>
        <div>${esc(t("non_council_outcome_vote_tally", {
          yes: String(view.tally.yes),
          no: String(view.tally.no),
          abstain: String(view.tally.abstain),
        }))}</div>
      </div>`
    : "";

  return `<section class="notice-fact-detail" data-non-council-outcome-panel="1" aria-label="${esc(t("non_council_outcome_heading"))}">
    <div class="chain-h">${esc(t("non_council_outcome_heading"))}</div>
    <div class="notice-fact-list">
      <article class="notice-fact-item">
        <h3 lang="en" dir="ltr">${esc(view.body_name)}</h3>
        <div class="notice-fact-row" data-field="decision">
          <div class="stage-name">${esc(t("non_council_outcome_decision_lbl"))}</div>
          <div>${esc(action)}</div>
        </div>
        <div class="notice-fact-row" data-field="meeting-date">
          <div class="stage-name">${esc(t("non_council_outcome_date_lbl"))}</div>
          <time datetime="${esc(view.meeting_date)}">${esc(date(view.meeting_date))}</time>
        </div>
        ${tally}
        ${officialSourceLink({ href: view.minutes_url, label: t("non_council_outcome_minutes_link"), className: "view meeting-source-link", escape: esc })}
      </article>
    </div>
  </section>`;
}

function emptyView() {
  return { schema: NON_COUNCIL_OUTCOME_PANEL_SCHEMA, show: false };
}

function bodyName(row) {
  const explicit = clean(row.body_name);
  if (explicit) return explicit;
  const district = clean(row.body_id)?.match(/-cb-(\d{1,2})$/)?.[1];
  const borough = clean(row.borough);
  if (borough && district) return `${borough} Community Board ${Number(district)}`;
  return "Community Board";
}

function validTally(value) {
  if (!value || ![value.yes, value.no, value.abstain].every(nonnegativeInteger)) return null;
  return { yes: Number(value.yes), no: Number(value.no), abstain: Number(value.abstain) };
}

function nonnegativeInteger(value) {
  return value != null && value !== "" && Number.isInteger(Number(value)) && Number(value) >= 0;
}

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim() || null;
}

function isoDate(value) {
  const date = clean(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(date || "") ? date : null;
}

function safeHttpsUrl(value) {
  const text = clean(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function defaultEsc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function defaultDate(value) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

const STRINGS = {
  en: {
    non_council_outcome_heading: "Community board decision",
    non_council_outcome_decision_lbl: "Decision",
    non_council_outcome_date_lbl: "Board meeting",
    non_council_outcome_vote_lbl: "Published vote",
    non_council_outcome_vote_tally: "{yes} yes · {no} no · {abstain} abstain",
    non_council_outcome_action_approved: "Approved",
    non_council_outcome_action_rejected: "Rejected",
    non_council_outcome_action_held: "Held",
    non_council_outcome_minutes_link: "Official minutes",
    non_council_outcome_how_summary: "Where this decision comes from",
    non_council_outcome_provenance: "Published community board minutes joined to this City Record meeting by the exact board, meeting date, and matter identifier.",
  },
  es: {
    non_council_outcome_heading: "Decisión de la junta comunitaria", non_council_outcome_decision_lbl: "Decisión", non_council_outcome_date_lbl: "Reunión de la junta", non_council_outcome_vote_lbl: "Votación publicada", non_council_outcome_vote_tally: "{yes} a favor · {no} en contra · {abstain} abstenciones", non_council_outcome_action_approved: "Aprobado", non_council_outcome_action_rejected: "Rechazado", non_council_outcome_action_held: "Aplazado", non_council_outcome_minutes_link: "Acta oficial", non_council_outcome_how_summary: "De dónde proviene esta decisión", non_council_outcome_provenance: "Actas publicadas de la junta comunitaria vinculadas a esta reunión del City Record por la junta, la fecha de reunión y el identificador del asunto exactos.",
  },
  "zh-Hans": {
    non_council_outcome_heading: "社区委员会决定", non_council_outcome_decision_lbl: "决定", non_council_outcome_date_lbl: "委员会会议", non_council_outcome_vote_lbl: "已公布表决", non_council_outcome_vote_tally: "{yes} 票赞成 · {no} 票反对 · {abstain} 票弃权", non_council_outcome_action_approved: "已批准", non_council_outcome_action_rejected: "已否决", non_council_outcome_action_held: "暂缓", non_council_outcome_minutes_link: "官方会议记录", non_council_outcome_how_summary: "此决定的来源", non_council_outcome_provenance: "已公布的社区委员会会议记录按完全一致的委员会、会议日期和事项标识符与本 City Record 会议关联。",
  },
  ru: {
    non_council_outcome_heading: "Решение общественного совета", non_council_outcome_decision_lbl: "Решение", non_council_outcome_date_lbl: "Заседание совета", non_council_outcome_vote_lbl: "Опубликованное голосование", non_council_outcome_vote_tally: "{yes} за · {no} против · {abstain} воздержались", non_council_outcome_action_approved: "Одобрено", non_council_outcome_action_rejected: "Отклонено", non_council_outcome_action_held: "Отложено", non_council_outcome_minutes_link: "Официальный протокол", non_council_outcome_how_summary: "Источник этого решения", non_council_outcome_provenance: "Опубликованный протокол общественного совета связан с этим заседанием City Record по точному совпадению совета, даты заседания и идентификатора вопроса.",
  },
  bn: {
    non_council_outcome_heading: "কমিউনিটি বোর্ডের সিদ্ধান্ত", non_council_outcome_decision_lbl: "সিদ্ধান্ত", non_council_outcome_date_lbl: "বোর্ড সভা", non_council_outcome_vote_lbl: "প্রকাশিত ভোট", non_council_outcome_vote_tally: "{yes} পক্ষে · {no} বিপক্ষে · {abstain} বিরত", non_council_outcome_action_approved: "অনুমোদিত", non_council_outcome_action_rejected: "প্রত্যাখ্যাত", non_council_outcome_action_held: "স্থগিত", non_council_outcome_minutes_link: "সরকারি কার্যবিবরণী", non_council_outcome_how_summary: "এই সিদ্ধান্তের উৎস", non_council_outcome_provenance: "প্রকাশিত কমিউনিটি বোর্ডের কার্যবিবরণী সঠিক বোর্ড, সভার তারিখ ও বিষয় শনাক্তকারী দিয়ে এই City Record সভার সঙ্গে যুক্ত করা হয়েছে।",
  },
  ht: {
    non_council_outcome_heading: "Desizyon konsèy kominotè a", non_council_outcome_decision_lbl: "Desizyon", non_council_outcome_date_lbl: "Reyinyon konsèy la", non_council_outcome_vote_lbl: "Vòt ki pibliye", non_council_outcome_vote_tally: "{yes} wi · {no} non · {abstain} abstansyon", non_council_outcome_action_approved: "Apwouve", non_council_outcome_action_rejected: "Rejte", non_council_outcome_action_held: "Ranvwaye", non_council_outcome_minutes_link: "Pwosè vèbal ofisyèl", non_council_outcome_how_summary: "Sous desizyon sa a", non_council_outcome_provenance: "Pwosè vèbal konsèy kominotè ki pibliye a konekte ak reyinyon City Record sa a grasa menm konsèy la, menm dat reyinyon an ak menm idantifyan dosye a.",
  },
  ko: {
    non_council_outcome_heading: "커뮤니티 보드 결정", non_council_outcome_decision_lbl: "결정", non_council_outcome_date_lbl: "보드 회의", non_council_outcome_vote_lbl: "공개된 표결", non_council_outcome_vote_tally: "찬성 {yes} · 반대 {no} · 기권 {abstain}", non_council_outcome_action_approved: "승인됨", non_council_outcome_action_rejected: "부결됨", non_council_outcome_action_held: "보류됨", non_council_outcome_minutes_link: "공식 회의록", non_council_outcome_how_summary: "이 결정의 출처", non_council_outcome_provenance: "공개된 커뮤니티 보드 회의록을 보드, 회의 날짜 및 안건 식별자의 정확한 일치로 이 City Record 회의와 연결했습니다.",
  },
  fr: {
    non_council_outcome_heading: "Décision du conseil communautaire", non_council_outcome_decision_lbl: "Décision", non_council_outcome_date_lbl: "Réunion du conseil", non_council_outcome_vote_lbl: "Vote publié", non_council_outcome_vote_tally: "{yes} pour · {no} contre · {abstain} abstentions", non_council_outcome_action_approved: "Approuvé", non_council_outcome_action_rejected: "Rejeté", non_council_outcome_action_held: "Reporté", non_council_outcome_minutes_link: "Procès-verbal officiel", non_council_outcome_how_summary: "Source de cette décision", non_council_outcome_provenance: "Le procès-verbal publié du conseil communautaire est relié à cette réunion du City Record par la correspondance exacte du conseil, de la date de réunion et de l’identifiant du dossier.",
  },
  pl: {
    non_council_outcome_heading: "Decyzja rady społeczności", non_council_outcome_decision_lbl: "Decyzja", non_council_outcome_date_lbl: "Posiedzenie rady", non_council_outcome_vote_lbl: "Opublikowane głosowanie", non_council_outcome_vote_tally: "{yes} za · {no} przeciw · {abstain} wstrzymujących się", non_council_outcome_action_approved: "Zatwierdzono", non_council_outcome_action_rejected: "Odrzucono", non_council_outcome_action_held: "Odroczono", non_council_outcome_minutes_link: "Oficjalny protokół", non_council_outcome_how_summary: "Źródło tej decyzji", non_council_outcome_provenance: "Opublikowany protokół rady społeczności połączono z tym posiedzeniem City Record na podstawie dokładnej zgodności rady, daty posiedzenia i identyfikatora sprawy.",
  },
  ar: {
    non_council_outcome_heading: "قرار مجلس المجتمع المحلي", non_council_outcome_decision_lbl: "القرار", non_council_outcome_date_lbl: "اجتماع المجلس", non_council_outcome_vote_lbl: "التصويت المنشور", non_council_outcome_vote_tally: "{yes} نعم · {no} لا · {abstain} امتناع", non_council_outcome_action_approved: "تمت الموافقة", non_council_outcome_action_rejected: "تم الرفض", non_council_outcome_action_held: "تم التأجيل", non_council_outcome_minutes_link: "المحضر الرسمي", non_council_outcome_how_summary: "مصدر هذا القرار", non_council_outcome_provenance: "رُبط محضر مجلس المجتمع المحلي المنشور باجتماع City Record هذا من خلال التطابق الدقيق للمجلس وتاريخ الاجتماع ومعرّف المسألة.",
  },
  ur: {
    non_council_outcome_heading: "کمیونٹی بورڈ کا فیصلہ", non_council_outcome_decision_lbl: "فیصلہ", non_council_outcome_date_lbl: "بورڈ اجلاس", non_council_outcome_vote_lbl: "شائع شدہ ووٹ", non_council_outcome_vote_tally: "{yes} حق میں · {no} مخالفت میں · {abstain} رائے سے گریز", non_council_outcome_action_approved: "منظور", non_council_outcome_action_rejected: "مسترد", non_council_outcome_action_held: "ملتوی", non_council_outcome_minutes_link: "سرکاری کارروائی", non_council_outcome_how_summary: "اس فیصلے کا ماخذ", non_council_outcome_provenance: "شائع شدہ کمیونٹی بورڈ کی کارروائی کو عین بورڈ، اجلاس کی تاریخ اور معاملے کے شناخت کنندہ کے ذریعے اس City Record اجلاس سے جوڑا گیا ہے۔",
  },
};

function localizedT(lang) {
  const values = STRINGS[lang] || STRINGS.en;
  return (key, vars = {}) => String(values[key] || STRINGS.en[key] || key)
    .replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? "");
}
