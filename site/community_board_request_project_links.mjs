/**
 * "The capital project this request names" -- the reviewed link from one
 * community board budget request to a capital project record the city already
 * publishes.
 *
 * Some published answers name a project outright: "the agency in partnership
 * with DDC will be reconstructing the SBS BX 6 route under capital project
 * HWX100SBC". Some boards name one in their own submission. Until now a reader
 * standing on the request could not see what that project is, how big it is,
 * which agencies hold it, or when anyone last looked at it, even though
 * CityScroll retains all of that.
 *
 * This module renders the reviewed relation and nothing else. It never matches
 * anything: the relation is materialized once, from committed inputs, by
 * `tools/build_community_board_request_project_links.mjs` over the projection in
 * `warehouse/lib/community_board_request_project_links.mjs`. There is no
 * browser-side join, no resemblance scoring and no request to a publisher at
 * read time.
 *
 * What it will not do:
 *
 *   - it never presents a link as fulfilment. A request naming a project, or an
 *     answer naming one, is a reference between two records. The block says so
 *     in the reader's own language, and where the published answer states a
 *     difference of scope it quotes that answer rather than paraphrasing it.
 *   - it never puts the request's date and the project's on one clock. The
 *     answer carries its publication date; the project's phase, budget,
 *     recorded spending and forecast each carry the capital record they came
 *     from. A project whose most recent retained record is older than the
 *     latest release says that too.
 *   - it never turns a project's budget into a figure about this request, or a
 *     project forecast into a promise to this board.
 *   - it renders nothing at all when a request has no reviewed link, so an
 *     absent relation never becomes an empty panel or a "no project found"
 *     claim.
 *
 * Every destination is a plain anchor: the agencies that manage and sponsor the
 * project, and the city's own published record. Nothing here needs scripting.
 */

export const REQUEST_PROJECT_LINKS_VIEW_SCHEMA = "cityscroll.community_board_request_project_links_view.v1";

/** The materialization this reading accepts, and the relation inside it. */
export const REQUEST_PROJECT_LINKS_ARTIFACT_SCHEMA = "cityscroll.community_board_request_project_links.v1";
export const REQUEST_PROJECT_LINK_RELATION = "budget_request_names_capital_project_code";

/** The class every rendered block carries, so one selector finds it anywhere. */
export const REQUEST_PROJECT_LINK_CLASS = "board-request-project";

const REQUEST_PROJECT_LOCALES = Object.freeze({
  en: "en-US",
  es: "es",
  fr: "fr",
  ht: "fr-HT",
  ru: "ru",
  bn: "bn",
  "zh-Hans": "zh-Hans",
  ko: "ko",
  ar: "ar-u-nu-latn",
  ur: "ur-u-nu-latn",
  pl: "pl",
});

const REQUEST_PROJECT_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
const REQUEST_PROJECT_SENTINEL = "\ue000";
const REQUEST_PROJECT_TEXT_LIMIT = 4000;
const REQUEST_PROJECT_CODE = /^[A-Z0-9][A-Z0-9-]{2,29}$/;
const REQUEST_PROJECT_AGENCY_HREF = /^\/agencies\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/;
const REQUEST_PROJECT_SOURCE_URL = /^https:\/\/[a-z0-9.-]+\/[^\s"']*$/i;

function requestProjectLinkClean(value, max = 400) {
  return String(value ?? "")
    .replace(REQUEST_PROJECT_CONTROL_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function requestProjectLinkEsc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;", "'": "&#39;",
  }[char]));
}

/** Publisher wording, isolated as the language and direction it was written in. */
function requestProjectLinkSourceText(value) {
  return `<span lang="en" dir="ltr">${requestProjectLinkEsc(value)}</span>`;
}

/**
 * A translated sentence with published values inside it.
 *
 * Values are placed through private-use sentinels rather than by concatenation,
 * so a language that puts a value first, last or in the middle all render
 * correctly and the publisher's own text keeps its bidi isolation.
 */
function requestProjectLinkSentence(t, key, values = {}, sourceValues = {}) {
  const names = Object.keys(sourceValues);
  const marked = {};
  names.forEach((name, index) => {
    marked[name] = `${REQUEST_PROJECT_SENTINEL}${index}${REQUEST_PROJECT_SENTINEL}`;
  });
  let text = requestProjectLinkEsc(t(key, { ...values, ...marked }));
  names.forEach((name, index) => {
    text = text.replace(
      `${REQUEST_PROJECT_SENTINEL}${index}${REQUEST_PROJECT_SENTINEL}`,
      requestProjectLinkSourceText(sourceValues[name]),
    );
  });
  return text;
}

function requestProjectLinkIsoDay(value) {
  const text = requestProjectLinkClean(value, 40);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

export function requestProjectLinkFormatDay(value, lang) {
  const day = requestProjectLinkIsoDay(value);
  if (!day) return null;
  const parsed = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return day;
  try {
    return new Intl.DateTimeFormat(REQUEST_PROJECT_LOCALES[lang] || REQUEST_PROJECT_LOCALES.en, {
      month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
    }).format(parsed);
  } catch (_error) {
    return day;
  }
}

/** "202605" becomes the month the capital record was reported for, in the reader's language. */
export function requestProjectLinkFormatPeriod(value, lang) {
  const match = /^(\d{4})(0[1-9]|1[0-2])$/.exec(requestProjectLinkClean(value, 12));
  if (!match) return null;
  const parsed = new Date(`${match[1]}-${match[2]}-01T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return `${match[1]}-${match[2]}`;
  try {
    return new Intl.DateTimeFormat(REQUEST_PROJECT_LOCALES[lang] || REQUEST_PROJECT_LOCALES.en, {
      month: "long", year: "numeric", timeZone: "UTC",
    }).format(parsed);
  } catch (_error) {
    return `${match[1]}-${match[2]}`;
  }
}

/**
 * Whole dollars. Cents on a multi-million capital budget are noise rather than
 * precision, and the published record keeps them either way.
 */
export function requestProjectLinkFormatAmount(value, lang) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  try {
    return new Intl.NumberFormat(REQUEST_PROJECT_LOCALES[lang] || REQUEST_PROJECT_LOCALES.en, {
      style: "currency", currency: "USD", maximumFractionDigits: 0,
    }).format(Math.round(amount));
  } catch (_error) {
    return `$${Math.round(amount)}`;
  }
}

function requestProjectLinkAccepted(artifact) {
  return Boolean(
    artifact
    && artifact.schema === REQUEST_PROJECT_LINKS_ARTIFACT_SCHEMA
    && artifact.relation === REQUEST_PROJECT_LINK_RELATION
    && artifact.policy?.candidates_remain_unlinked_until_reviewed === true
    && artifact.policy?.name_similarity_is_not_a_relation === true
    && artifact.policy?.relation_is_not_fulfilment === true
    && Array.isArray(artifact.relations),
  );
}

function requestProjectLinkAgency(row) {
  const href = requestProjectLinkClean(row?.href, 200);
  const name = requestProjectLinkClean(row?.name, 200);
  if (!name || !REQUEST_PROJECT_AGENCY_HREF.test(href)) return null;
  return Object.freeze({ href, name });
}

/**
 * One reviewed link, as the row renders it.
 *
 * The passage shown is the latest servable publication that carries it, so a
 * reference an agency added between two publications is dated by the
 * publication that added it rather than by the first one the request appeared
 * in.
 */
function requestProjectLinkView(relation) {
  const project = relation?.capital_project || {};
  const evidence = relation?.evidence || {};
  const code = requestProjectLinkClean(evidence.project_code, 40).toUpperCase();
  if (!REQUEST_PROJECT_CODE.test(code)) return null;
  const passages = Array.isArray(evidence.passages) ? evidence.passages : [];
  const reviewedIn = requestProjectLinkClean(evidence.reviewed_named_in, 40);
  const named = passages.filter((row) => requestProjectLinkClean(row?.named_in, 40) === reviewedIn);
  const passage = named[named.length - 1] || passages[passages.length - 1] || null;
  if (!passage) return null;
  const spelling = requestProjectLinkClean(passage.published_spelling, 60);
  const difference = relation?.review?.scope_difference_quote || null;
  const observation = project.observation || {};
  const sourceUrl = requestProjectLinkClean(project.landing_url || project.source_url, 400);
  return Object.freeze({
    project_code: code,
    managing_agency: requestProjectLinkClean(evidence.managing_agency, 20).toUpperCase() || null,
    named_in: reviewedIn === "board_submission" ? "board_submission" : "response",
    publication_date: requestProjectLinkIsoDay(passage.publication_date),
    passage: requestProjectLinkClean(passage.passage, REQUEST_PROJECT_TEXT_LIMIT) || null,
    // Worth a sentence only when the two differ: a passage that spells the code
    // exactly as the city publishes it needs no explanation.
    published_spelling: spelling && spelling.toUpperCase() !== code ? spelling : null,
    project_name: requestProjectLinkClean(project.project_name, 400) || null,
    project_scope: requestProjectLinkClean(project.project_scope, REQUEST_PROJECT_TEXT_LIMIT) || null,
    current_phase: requestProjectLinkClean(project.current_phase, 120) || null,
    project_budget: Number.isFinite(Number(project.project_budget)) ? Number(project.project_budget) : null,
    recorded_project_spending: Number.isFinite(Number(project.recorded_project_spending))
      ? Number(project.recorded_project_spending)
      : null,
    project_forecast_completion: requestProjectLinkIsoDay(project.project_forecast_completion),
    reporting_period: requestProjectLinkClean(observation.reporting_period, 12) || null,
    financial_data_date: requestProjectLinkIsoDay(observation.financial_data_date),
    agency_data_date: requestProjectLinkIsoDay(observation.agency_data_date),
    latest_retained_release: requestProjectLinkClean(observation.latest_retained_release, 12) || null,
    from_latest_retained_release: observation.from_latest_retained_release === true,
    also_published_under: Object.freeze(
      (Array.isArray(project.also_published_under_managing_agencies)
        ? project.also_published_under_managing_agencies
        : []).map((value) => requestProjectLinkClean(value, 20).toUpperCase()).filter(Boolean),
    ),
    managing: requestProjectLinkAgency(project.agencies?.managing),
    sponsoring: Object.freeze(
      (Array.isArray(project.agencies?.sponsoring) ? project.agencies.sponsoring : [])
        .map(requestProjectLinkAgency)
        .filter(Boolean),
    ),
    source_url: REQUEST_PROJECT_SOURCE_URL.test(sourceUrl) ? sourceUrl : null,
    difference_quote: difference ? requestProjectLinkClean(difference.quote, REQUEST_PROJECT_TEXT_LIMIT) || null : null,
    difference_publication_date: difference ? requestProjectLinkIsoDay(difference.publication_date) : null,
  });
}

/**
 * The reviewed links this reading will render, keyed by board and the
 * publisher's full tracking code.
 *
 * A materialization this module does not recognise, or one that is missing
 * altogether, produces an empty index: a request then renders exactly as it did
 * before, which is the correct outcome for a relation that is optional by
 * construction.
 */
export function communityBoardRequestProjectLinkIndex(artifact) {
  const byRequest = new Map();
  if (!requestProjectLinkAccepted(artifact)) {
    return Object.freeze({
      schema: REQUEST_PROJECT_LINKS_VIEW_SCHEMA,
      available: false,
      relation_count: 0,
      request_count: 0,
      forRequest: () => null,
    });
  }
  for (const relation of artifact.relations) {
    if (relation?.relation !== REQUEST_PROJECT_LINK_RELATION) continue;
    const boardId = requestProjectLinkClean(relation.request?.board_id, 80);
    const trackingCode = requestProjectLinkClean(relation.request?.tracking_code, 20).toUpperCase();
    if (!boardId || !trackingCode) continue;
    const view = requestProjectLinkView(relation);
    if (!view) continue;
    const key = `${boardId}|${trackingCode}`;
    // A request naming two projects keeps both, in code order: choosing one to
    // stand for the request would be an editorial claim about which matters.
    const held = byRequest.get(key) || [];
    held.push(view);
    held.sort((left, right) => left.project_code.localeCompare(right.project_code));
    byRequest.set(key, held);
  }
  return Object.freeze({
    schema: REQUEST_PROJECT_LINKS_VIEW_SCHEMA,
    available: true,
    relation_count: [...byRequest.values()].reduce((total, rows) => total + rows.length, 0),
    request_count: byRequest.size,
    forRequest(boardId, trackingCode) {
      const key = `${requestProjectLinkClean(boardId, 80)}|${requestProjectLinkClean(trackingCode, 20).toUpperCase()}`;
      const held = byRequest.get(key);
      return held ? Object.freeze(held.slice()) : null;
    },
  });
}

const REQUEST_PROJECT_STRINGS = {
  en: {
    crpl_heading: "Capital project this request names",
    crpl_named_response: "Named in the answer published {date}.",
    crpl_named_submission: "Named in the board's own submission. The published answer does not name it.",
    crpl_spelling: "The passage spells it {spelling}. The city publishes the project as {code}.",
    crpl_passage_label: "Published wording:",
    crpl_scope: "Project scope, as the city published it: {scope}",
    crpl_phase: "Phase {phase}, from the capital record for {period}.",
    crpl_figures: "Project budget {budget}, recorded project spending {spend}, from the capital record dated {date}.",
    crpl_forecast: "Project forecast completion {completion}, from the capital record dated {date}.",
    crpl_stale: "This is the most recent capital record retained for this project, and it is older than {period}, the latest release this site holds.",
    crpl_difference_label: "What the published answer says about this:",
    crpl_boundary: "The request and the project are separate records with separate dates. Naming a project is not funding, a commitment, delivery, or a statement that this request is inside that project's scope.",
    crpl_managing: "Managed by {agency}",
    crpl_sponsoring: "Sponsored by {agency}",
    crpl_source_link: "Open the published capital project record",
    crpl_also_published: "The same code is also published under {agencies}, which is a different record.",
  },
  es: {
    crpl_heading: "Proyecto de capital que nombra esta solicitud",
    crpl_named_response: "Nombrado en la respuesta publicada el {date}.",
    crpl_named_submission: "Nombrado en la propia presentación de la junta. La respuesta publicada no lo nombra.",
    crpl_spelling: "El pasaje lo escribe {spelling}. La ciudad publica el proyecto como {code}.",
    crpl_passage_label: "Texto publicado:",
    crpl_scope: "Alcance del proyecto, tal como lo publicó la ciudad: {scope}",
    crpl_phase: "Fase {phase}, según el registro de capital de {period}.",
    crpl_figures: "Presupuesto del proyecto {budget}, gasto registrado del proyecto {spend}, según el registro de capital con fecha {date}.",
    crpl_forecast: "Finalización prevista del proyecto {completion}, según el registro de capital con fecha {date}.",
    crpl_stale: "Este es el registro de capital más reciente que se conserva para este proyecto y es anterior a {period}, la última publicación que tiene este sitio.",
    crpl_difference_label: "Lo que dice la respuesta publicada al respecto:",
    crpl_boundary: "La solicitud y el proyecto son registros distintos con fechas distintas. Nombrar un proyecto no es financiamiento, ni un compromiso, ni una entrega, ni una declaración de que esta solicitud esté dentro del alcance de ese proyecto.",
    crpl_managing: "Gestionado por {agency}",
    crpl_sponsoring: "Patrocinado por {agency}",
    crpl_source_link: "Abrir el registro publicado del proyecto de capital",
    crpl_also_published: "El mismo código también se publica bajo {agencies}, que es un registro distinto.",
  },
  fr: {
    crpl_heading: "Projet d'investissement nommé par cette demande",
    crpl_named_response: "Nommé dans la réponse publiée le {date}.",
    crpl_named_submission: "Nommé dans le dossier soumis par le conseil. La réponse publiée ne le nomme pas.",
    crpl_spelling: "Le passage l'écrit {spelling}. La ville publie le projet sous le code {code}.",
    crpl_passage_label: "Texte publié :",
    crpl_scope: "Portée du projet, telle que publiée par la ville : {scope}",
    crpl_phase: "Phase {phase}, d'après le relevé d'investissement de {period}.",
    crpl_figures: "Budget du projet {budget}, dépenses enregistrées du projet {spend}, d'après le relevé d'investissement daté du {date}.",
    crpl_forecast: "Achèvement prévu du projet {completion}, d'après le relevé d'investissement daté du {date}.",
    crpl_stale: "C'est le relevé d'investissement le plus récent conservé pour ce projet, et il est antérieur à {period}, la dernière publication détenue par ce site.",
    crpl_difference_label: "Ce que dit la réponse publiée à ce sujet :",
    crpl_boundary: "La demande et le projet sont des enregistrements distincts avec des dates distinctes. Nommer un projet n'est ni un financement, ni un engagement, ni une réalisation, ni une déclaration que cette demande relève de la portée de ce projet.",
    crpl_managing: "Géré par {agency}",
    crpl_sponsoring: "Parrainé par {agency}",
    crpl_source_link: "Ouvrir le relevé publié du projet d'investissement",
    crpl_also_published: "Le même code est aussi publié sous {agencies}, ce qui constitue un enregistrement différent.",
  },
  ht: {
    crpl_heading: "Pwojè kapital demann sa a site",
    crpl_named_response: "Site nan repons ki pibliye {date} a.",
    crpl_named_submission: "Site nan dokiman konsèy la voye a. Repons ki pibliye a pa site li.",
    crpl_spelling: "Pasaj la ekri li {spelling}. Vil la pibliye pwojè a kòm {code}.",
    crpl_passage_label: "Tèks ki pibliye:",
    crpl_scope: "Sijè pwojè a, jan vil la pibliye l: {scope}",
    crpl_phase: "Faz {phase}, dapre dosye kapital {period} an.",
    crpl_figures: "Bidjè pwojè a {budget}, depans pwojè a ki anrejistre {spend}, dapre dosye kapital ki date {date}.",
    crpl_forecast: "Dat previzyon pou fini pwojè a {completion}, dapre dosye kapital ki date {date}.",
    crpl_stale: "Sa se dosye kapital ki pi resan yo kenbe pou pwojè sa a, e li pi ansyen pase {period}, dènye piblikasyon sit sa a genyen.",
    crpl_difference_label: "Sa repons ki pibliye a di sou sa:",
    crpl_boundary: "Demann lan ak pwojè a se de dosye separe ki gen dat pa yo. Site yon pwojè pa vle di lajan, se pa yon angajman, se pa yon livrezon, e li pa vle di demann sa a antre nan sijè pwojè a.",
    crpl_managing: "Jere pa {agency}",
    crpl_sponsoring: "Patwone pa {agency}",
    crpl_source_link: "Louvri dosye pwojè kapital ki pibliye a",
    crpl_also_published: "Menm kòd la pibliye tou anba {agencies}, ki se yon lòt dosye.",
  },
  ru: {
    crpl_heading: "Капитальный проект, который называет эта заявка",
    crpl_named_response: "Назван в ответе, опубликованном {date}.",
    crpl_named_submission: "Назван в собственной заявке совета. В опубликованном ответе он не назван.",
    crpl_spelling: "В тексте он записан как {spelling}. Город публикует проект под кодом {code}.",
    crpl_passage_label: "Опубликованный текст:",
    crpl_scope: "Состав работ по проекту, как его опубликовал город: {scope}",
    crpl_phase: "Стадия {phase}, по капитальной записи за {period}.",
    crpl_figures: "Бюджет проекта {budget}, учтённые расходы по проекту {spend}, по капитальной записи от {date}.",
    crpl_forecast: "Прогнозируемое завершение проекта {completion}, по капитальной записи от {date}.",
    crpl_stale: "Это самая свежая капитальная запись, сохранённая для этого проекта, и она старше {period} — последней публикации, которая есть на этом сайте.",
    crpl_difference_label: "Что говорит об этом опубликованный ответ:",
    crpl_boundary: "Заявка и проект — отдельные записи со своими датами. Упоминание проекта не является финансированием, обязательством, выполнением или утверждением, что эта заявка входит в состав работ по проекту.",
    crpl_managing: "Ведёт {agency}",
    crpl_sponsoring: "Заказчик — {agency}",
    crpl_source_link: "Открыть опубликованную запись о капитальном проекте",
    crpl_also_published: "Тот же код публикуется и под {agencies} — это другая запись.",
  },
  bn: {
    crpl_heading: "এই অনুরোধে উল্লেখ করা মূলধন প্রকল্প",
    crpl_named_response: "{date} তারিখে প্রকাশিত উত্তরে উল্লেখ করা হয়েছে।",
    crpl_named_submission: "বোর্ডের নিজের জমা দেওয়া বিবরণে উল্লেখ করা হয়েছে। প্রকাশিত উত্তরে এটি উল্লেখ নেই।",
    crpl_spelling: "অংশটিতে এটি {spelling} হিসেবে লেখা আছে। শহর প্রকল্পটি {code} হিসেবে প্রকাশ করে।",
    crpl_passage_label: "প্রকাশিত বয়ান:",
    crpl_scope: "শহর যেভাবে প্রকাশ করেছে, প্রকল্পের পরিধি: {scope}",
    crpl_phase: "পর্যায় {phase}, {period}-এর মূলধন নথি অনুসারে।",
    crpl_figures: "প্রকল্পের বাজেট {budget}, নথিভুক্ত প্রকল্প ব্যয় {spend}, {date} তারিখের মূলধন নথি অনুসারে।",
    crpl_forecast: "প্রকল্প শেষ হওয়ার পূর্বাভাস {completion}, {date} তারিখের মূলধন নথি অনুসারে।",
    crpl_stale: "এই প্রকল্পের জন্য রাখা সবচেয়ে সাম্প্রতিক মূলধন নথি এটিই, এবং এটি {period}-এর চেয়ে পুরনো, যা এই সাইটে থাকা সর্বশেষ প্রকাশনা।",
    crpl_difference_label: "এ বিষয়ে প্রকাশিত উত্তর যা বলে:",
    crpl_boundary: "অনুরোধ ও প্রকল্প আলাদা নথি, নিজস্ব তারিখসহ। কোনো প্রকল্পের নাম উল্লেখ করা অর্থায়ন নয়, প্রতিশ্রুতি নয়, সরবরাহ নয়, এবং এই অনুরোধ ওই প্রকল্পের পরিধির ভেতরে আছে এমন বক্তব্যও নয়।",
    crpl_managing: "পরিচালনায় {agency}",
    crpl_sponsoring: "পৃষ্ঠপোষকতায় {agency}",
    crpl_source_link: "প্রকাশিত মূলধন প্রকল্পের নথি খুলুন",
    crpl_also_published: "একই কোড {agencies}-এর অধীনেও প্রকাশিত, যা একটি ভিন্ন নথি।",
  },
  "zh-Hans": {
    crpl_heading: "本申请提到的资本项目",
    crpl_named_response: "在{date}公布的答复中提到。",
    crpl_named_submission: "在委员会自己的申请材料中提到。公布的答复没有提到它。",
    crpl_spelling: "该段落写作 {spelling}。市政府公布的项目编号为 {code}。",
    crpl_passage_label: "公布的原文：",
    crpl_scope: "市政府公布的项目范围：{scope}",
    crpl_phase: "阶段为{phase}，依据{period}的资本记录。",
    crpl_figures: "项目预算 {budget}，已记录的项目支出 {spend}，依据日期为{date}的资本记录。",
    crpl_forecast: "项目预计完工时间为{completion}，依据日期为{date}的资本记录。",
    crpl_stale: "这是本站为该项目保留的最新资本记录，它早于本站持有的最新一期{period}。",
    crpl_difference_label: "公布的答复对此的说法：",
    crpl_boundary: "申请与项目是各有日期的两份独立记录。提到某个项目并不等于拨款、承诺或交付，也不表示该申请属于该项目的范围。",
    crpl_managing: "由{agency}管理",
    crpl_sponsoring: "由{agency}发起",
    crpl_source_link: "打开公布的资本项目记录",
    crpl_also_published: "同一编号也在{agencies}名下公布，那是另一份记录。",
  },
  ko: {
    crpl_heading: "이 요청이 언급한 자본 사업",
    crpl_named_response: "{date}에 공개된 답변에서 언급되었습니다.",
    crpl_named_submission: "위원회가 제출한 내용에서 언급되었습니다. 공개된 답변은 이를 언급하지 않습니다.",
    crpl_spelling: "해당 구절은 {spelling}(으)로 적고 있습니다. 시는 이 사업을 {code}(으)로 공개합니다.",
    crpl_passage_label: "공개된 문구:",
    crpl_scope: "시가 공개한 사업 범위: {scope}",
    crpl_phase: "단계는 {phase}이며, {period} 자본 기록에 따릅니다.",
    crpl_figures: "사업 예산 {budget}, 기록된 사업 지출 {spend}, {date}자 자본 기록에 따릅니다.",
    crpl_forecast: "사업 완료 예상 시점은 {completion}이며, {date}자 자본 기록에 따릅니다.",
    crpl_stale: "이 사업에 대해 보관된 가장 최근 자본 기록이며, 이 사이트가 보유한 최신 공개분인 {period}보다 오래되었습니다.",
    crpl_difference_label: "이에 대해 공개된 답변이 말하는 내용:",
    crpl_boundary: "요청과 사업은 각자의 날짜를 가진 별개의 기록입니다. 사업을 언급한다고 해서 예산 배정, 약속, 이행이 되는 것이 아니며, 이 요청이 그 사업의 범위 안에 있다는 뜻도 아닙니다.",
    crpl_managing: "{agency} 관리",
    crpl_sponsoring: "{agency} 발주",
    crpl_source_link: "공개된 자본 사업 기록 열기",
    crpl_also_published: "같은 코드가 {agencies} 아래에도 공개되어 있으며, 그것은 다른 기록입니다.",
  },
  ar: {
    crpl_heading: "المشروع الرأسمالي الذي يسميه هذا الطلب",
    crpl_named_response: "ورد اسمه في الرد المنشور بتاريخ {date}.",
    crpl_named_submission: "ورد اسمه في طلب المجلس نفسه. أما الرد المنشور فلا يذكره.",
    crpl_spelling: "يكتبه النص {spelling}. وتنشر المدينة المشروع بالرمز {code}.",
    crpl_passage_label: "النص المنشور:",
    crpl_scope: "نطاق المشروع كما نشرته المدينة: {scope}",
    crpl_phase: "المرحلة {phase}، بحسب السجل الرأسمالي لـ {period}.",
    crpl_figures: "ميزانية المشروع {budget}، والإنفاق المسجل على المشروع {spend}، بحسب السجل الرأسمالي المؤرخ {date}.",
    crpl_forecast: "الإنجاز المتوقع للمشروع {completion}، بحسب السجل الرأسمالي المؤرخ {date}.",
    crpl_stale: "هذا أحدث سجل رأسمالي محفوظ لهذا المشروع، وهو أقدم من {period}، وهي آخر نشرة يحتفظ بها هذا الموقع.",
    crpl_difference_label: "ما يقوله الرد المنشور في هذا الشأن:",
    crpl_boundary: "الطلب والمشروع سجلان منفصلان لكل منهما تواريخه. وذكر مشروع ليس تمويلًا ولا التزامًا ولا تنفيذًا، وليس إقرارًا بأن هذا الطلب يقع ضمن نطاق ذلك المشروع.",
    crpl_managing: "تديره {agency}",
    crpl_sponsoring: "ترعاه {agency}",
    crpl_source_link: "فتح سجل المشروع الرأسمالي المنشور",
    crpl_also_published: "الرمز نفسه منشور أيضًا تحت {agencies}، وهو سجل مختلف.",
  },
  ur: {
    crpl_heading: "اس درخواست میں مذکور کیپیٹل منصوبہ",
    crpl_named_response: "{date} کو شائع ہونے والے جواب میں اس کا نام آیا ہے۔",
    crpl_named_submission: "بورڈ کی اپنی درخواست میں اس کا نام آیا ہے۔ شائع شدہ جواب میں اس کا ذکر نہیں۔",
    crpl_spelling: "اقتباس میں اسے {spelling} لکھا گیا ہے۔ شہر اس منصوبے کو {code} کے طور پر شائع کرتا ہے۔",
    crpl_passage_label: "شائع شدہ عبارت:",
    crpl_scope: "منصوبے کا دائرہ کار، جیسا شہر نے شائع کیا: {scope}",
    crpl_phase: "مرحلہ {phase}، {period} کے کیپیٹل ریکارڈ کے مطابق۔",
    crpl_figures: "منصوبے کا بجٹ {budget}، ریکارڈ شدہ اخراجات {spend}، {date} کے کیپیٹل ریکارڈ کے مطابق۔",
    crpl_forecast: "منصوبے کی متوقع تکمیل {completion}، {date} کے کیپیٹل ریکارڈ کے مطابق۔",
    crpl_stale: "اس منصوبے کے لیے محفوظ تازہ ترین کیپیٹل ریکارڈ یہی ہے، اور یہ {period} سے پرانا ہے جو اس سائٹ کے پاس موجود آخری اشاعت ہے۔",
    crpl_difference_label: "شائع شدہ جواب اس بارے میں کیا کہتا ہے:",
    crpl_boundary: "درخواست اور منصوبہ الگ الگ ریکارڈ ہیں جن کی اپنی تاریخیں ہیں۔ کسی منصوبے کا نام لینا نہ فنڈنگ ہے، نہ وعدہ، نہ تکمیل، اور نہ ہی یہ کہ یہ درخواست اس منصوبے کے دائرہ کار میں شامل ہے۔",
    crpl_managing: "انتظام {agency}",
    crpl_sponsoring: "سرپرستی {agency}",
    crpl_source_link: "شائع شدہ کیپیٹل منصوبے کا ریکارڈ کھولیں",
    crpl_also_published: "یہی کوڈ {agencies} کے تحت بھی شائع ہوتا ہے، جو ایک مختلف ریکارڈ ہے۔",
  },
  pl: {
    crpl_heading: "Projekt inwestycyjny wskazany w tym wniosku",
    crpl_named_response: "Wskazany w odpowiedzi opublikowanej {date}.",
    crpl_named_submission: "Wskazany we własnym wniosku rady. Opublikowana odpowiedź go nie wymienia.",
    crpl_spelling: "W cytowanym fragmencie zapisano go jako {spelling}. Miasto publikuje projekt pod kodem {code}.",
    crpl_passage_label: "Opublikowane brzmienie:",
    crpl_scope: "Zakres projektu w brzmieniu opublikowanym przez miasto: {scope}",
    crpl_phase: "Faza {phase}, według zapisu inwestycyjnego za {period}.",
    crpl_figures: "Budżet projektu {budget}, zaksięgowane wydatki projektu {spend}, według zapisu inwestycyjnego z {date}.",
    crpl_forecast: "Prognozowane zakończenie projektu {completion}, według zapisu inwestycyjnego z {date}.",
    crpl_stale: "To najnowszy zachowany zapis inwestycyjny tego projektu i jest starszy niż {period}, czyli ostatnia publikacja, którą ma ten serwis.",
    crpl_difference_label: "Co mówi o tym opublikowana odpowiedź:",
    crpl_boundary: "Wniosek i projekt to odrębne zapisy z własnymi datami. Wskazanie projektu nie jest finansowaniem, zobowiązaniem, realizacją ani stwierdzeniem, że ten wniosek mieści się w zakresie tego projektu.",
    crpl_managing: "Prowadzi {agency}",
    crpl_sponsoring: "Zleca {agency}",
    crpl_source_link: "Otwórz opublikowany zapis projektu inwestycyjnego",
    crpl_also_published: "Ten sam kod publikowany jest też pod {agencies}, co jest innym zapisem.",
  },
};


function requestProjectLinkT(lang) {
  const values = REQUEST_PROJECT_STRINGS[lang] || REQUEST_PROJECT_STRINGS.en;
  return (key, vars = {}) => String(values[key] || REQUEST_PROJECT_STRINGS.en[key] || key)
    .replace(/\{(\w+)\}/g, (_, name) => (vars[name] ?? ""));
}

/**
 * The dated capital observations, one statement each.
 *
 * Phase, money and forecast are three separate readings taken from the same
 * capital record, and each says which record it came from. A record older than
 * the latest release the site holds says that on its own line rather than
 * quietly passing as current.
 */
function requestProjectLinkObservations(link, t, lang) {
  const period = requestProjectLinkFormatPeriod(link.reporting_period, lang);
  const financialDay = requestProjectLinkFormatDay(link.financial_data_date, lang) || period;
  const agencyDay = requestProjectLinkFormatDay(link.agency_data_date, lang) || period;
  const budget = requestProjectLinkFormatAmount(link.project_budget, lang);
  const spend = requestProjectLinkFormatAmount(link.recorded_project_spending, lang);
  const forecast = requestProjectLinkFormatDay(link.project_forecast_completion, lang);
  const rows = [];
  if (link.current_phase && period) {
    rows.push(requestProjectLinkSentence(t, "crpl_phase", { period }, { phase: link.current_phase }));
  }
  if (budget && spend && financialDay) {
    rows.push(requestProjectLinkEsc(t("crpl_figures", { budget, spend, date: financialDay })));
  }
  if (forecast && agencyDay) {
    rows.push(requestProjectLinkEsc(t("crpl_forecast", { completion: forecast, date: agencyDay })));
  }
  if (!link.from_latest_retained_release) {
    const latest = requestProjectLinkFormatPeriod(link.latest_retained_release, lang);
    if (latest) rows.push(requestProjectLinkEsc(t("crpl_stale", { period: latest })));
  }
  if (link.also_published_under.length) {
    rows.push(requestProjectLinkSentence(t, "crpl_also_published", {}, {
      agencies: link.also_published_under.join(", "),
    }));
  }
  return rows;
}

/**
 * Where the reader can go from here.
 *
 * Real destinations only: the agencies that hold the project, each on its own
 * CityScroll page, and the city's published record. An agency this site
 * publishes no page for contributes no link rather than a dead one, and an
 * absent destination removes a line instead of leaving an empty control.
 */
function requestProjectLinkActions(link, t) {
  const actions = [];
  const anchor = (href, label) => `<a class="ui-constellation-link ${REQUEST_PROJECT_LINK_CLASS}-action"`
    + ` href="${requestProjectLinkEsc(href)}">${label}</a>`;
  if (link.managing) {
    actions.push(anchor(link.managing.href, requestProjectLinkSentence(t, "crpl_managing", {}, { agency: link.managing.name })));
  }
  for (const sponsor of link.sponsoring) {
    actions.push(anchor(sponsor.href, requestProjectLinkSentence(t, "crpl_sponsoring", {}, { agency: sponsor.name })));
  }
  if (link.source_url) {
    actions.push(anchor(link.source_url, requestProjectLinkEsc(t("crpl_source_link"))));
  }
  return actions;
}

/**
 * One reviewed link, rendered inside the request it belongs to.
 *
 * Everything a reader needs is written into the block: the passage that names
 * the project, the project's own record with each figure's date, the published
 * answer's own words where they qualify the reference, and the boundary the
 * whole reading rests on. Nothing is fetched and nothing is deferred, so this
 * reads identically with scripting off.
 */
export function renderRequestProjectLink(link, { lang = "en" } = {}) {
  if (!link || !link.project_code) return "";
  const t = requestProjectLinkT(lang);
  const parts = [];
  parts.push(`<p class="muted node-muted ${REQUEST_PROJECT_LINK_CLASS}-heading">${requestProjectLinkEsc(t("crpl_heading"))}</p>`);

  const name = link.project_name
    ? `<strong class="${REQUEST_PROJECT_LINK_CLASS}-name" lang="en" dir="ltr">${requestProjectLinkEsc(link.project_name)}</strong> `
    : "";
  parts.push(`<p class="${REQUEST_PROJECT_LINK_CLASS}-identity">${name}`
    + `<span class="${REQUEST_PROJECT_LINK_CLASS}-code" lang="en" dir="ltr">${requestProjectLinkEsc(link.project_code)}</span></p>`);

  const day = requestProjectLinkFormatDay(link.publication_date, lang);
  const named = link.named_in === "response" && day
    ? t("crpl_named_response", { date: day })
    : t("crpl_named_submission");
  parts.push(`<p class="muted node-muted ${REQUEST_PROJECT_LINK_CLASS}-named">${requestProjectLinkEsc(named)}</p>`);

  if (link.passage) {
    parts.push(`<p class="${REQUEST_PROJECT_LINK_CLASS}-passage">${requestProjectLinkEsc(t("crpl_passage_label"))} `
      + `${requestProjectLinkSourceText(link.passage)}</p>`);
  }
  if (link.published_spelling) {
    parts.push(`<p class="muted node-muted ${REQUEST_PROJECT_LINK_CLASS}-spelling">${
      requestProjectLinkSentence(t, "crpl_spelling", {}, { spelling: link.published_spelling, code: link.project_code })
    }</p>`);
  }
  if (link.project_scope) {
    parts.push(`<p class="${REQUEST_PROJECT_LINK_CLASS}-scope">${
      requestProjectLinkSentence(t, "crpl_scope", {}, { scope: link.project_scope })
    }</p>`);
  }

  const observations = requestProjectLinkObservations(link, t, lang);
  if (observations.length) {
    parts.push(`<ul class="${REQUEST_PROJECT_LINK_CLASS}-observations">${
      observations.map((row) => `<li class="${REQUEST_PROJECT_LINK_CLASS}-observation">${row}</li>`).join("")
    }</ul>`);
  }

  if (link.difference_quote) {
    parts.push(`<p class="${REQUEST_PROJECT_LINK_CLASS}-difference">${requestProjectLinkEsc(t("crpl_difference_label"))} `
      + `${requestProjectLinkSourceText(link.difference_quote)}</p>`);
  }

  parts.push(`<p class="muted node-muted ${REQUEST_PROJECT_LINK_CLASS}-boundary">${requestProjectLinkEsc(t("crpl_boundary"))}</p>`);

  const actions = requestProjectLinkActions(link, t);
  if (actions.length) {
    parts.push(`<p class="${REQUEST_PROJECT_LINK_CLASS}-actions">${actions.join(" ")}</p>`);
  }

  return `<div class="${REQUEST_PROJECT_LINK_CLASS}"`
    + ` data-project-code="${requestProjectLinkEsc(link.project_code)}"`
    + ` data-managing-agency="${requestProjectLinkEsc(link.managing_agency || "")}"`
    + ` data-named-in="${requestProjectLinkEsc(link.named_in)}">${parts.join("")}</div>`;
}

/** Every reviewed link one request carries, or "" when it carries none. */
export function renderRequestProjectLinks(links, options = {}) {
  if (!Array.isArray(links) || !links.length) return "";
  return links.map((link) => renderRequestProjectLink(link, options)).join("");
}

export { REQUEST_PROJECT_STRINGS };
