/**
 * "Land use projects in this district" on a Community Board document.
 *
 * A resident on a board page can already reach the board's proceedings, its
 * committees, its people and a geographic pivot into the map. What the page did
 * not do was name the land use applications recorded in the board's own
 * district, so finding them meant leaving the board and rebuilding a geographic
 * search somewhere else.
 *
 * This read model answers that from one materialized artifact
 * (`site/data/community_board_district_projects.json`, written by
 * `tools/build_community_board_district_projects.mjs` over the projection in
 * `warehouse/lib/community_board_district_projects.mjs`). No page reads the
 * publisher, and every board reads the same population.
 *
 * The section is a location statement and says so in its own copy: a project
 * recorded in the district is not a project this board heard, recommended,
 * assigned to a committee or owns. Projects keep their published titles,
 * applicant labels and recorded statuses exactly as the source carries them,
 * and two projects that read alike are never merged.
 *
 * A board with no recorded project renders nothing at all. A board whose list
 * could not be read renders a stated failure with the published source still
 * reachable, so "we could not load this" never arrives looking like "there is
 * nothing here".
 */

import { renderNodeSection } from "./civic_document_chrome.mjs";
import { landProjectPath } from "./land_project_route.mjs";

export const COMMUNITY_BOARD_DISTRICT_PROJECTS_VIEW_SCHEMA = "cityscroll.community_board_district_projects_view.v1";
export const COMMUNITY_BOARD_DISTRICT_PROJECTS_ANCHOR = "district-land-projects";
/**
 * The overflow disclosure is addressed by its own fragment rather than held in
 * a `<details>` element, because the expansion has to survive the reader
 * leaving for a project and pressing Back. A browser restores the URL and the
 * scroll offset of a history entry; it does not restore an element's open
 * state. Putting the expansion in the URL is therefore the only way to make
 * Back return the reader to the list as they left it, and it keeps the control
 * a plain same-page link: no script, no new tab, no subscription.
 */
export const COMMUNITY_BOARD_DISTRICT_PROJECTS_OVERFLOW_ANCHOR = "district-land-projects-more";

/**
 * How many projects the section shows before the rest move behind an exact,
 * native disclosure. The board document's own resident bound
 * (COMMUNITY_BOARD_RESIDENT_DOCUMENT_LIMIT) is the ceiling on rendered rows;
 * this smaller number is what keeps the list a short answer rather than a
 * second page of records inside the first.
 */
export const COMMUNITY_BOARD_DISTRICT_PROJECT_VISIBLE_LIMIT = 8;

export const COMMUNITY_BOARD_DISTRICT_PROJECT_STATES = Object.freeze({
  AVAILABLE: "available",
  UNAVAILABLE: "unavailable",
});

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
const BODY_ID = /^[a-z]+(?:-[a-z]+)*-cb-\d{2}$/;
const DISTRICT_ID = /^[XKMQR]\d{2}$/;

/**
 * The Intl locale each shipping language formats dates in. Haitian Creole has
 * no CLDR locale of its own and uses fr-HT; Arabic and Urdu pin Western digits
 * with the `-u-nu-latn` extension, matching the site's own language metadata.
 */
const DATE_LOCALES = Object.freeze({
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

const RTL_LANGS = new Set(["ar", "ur"]);

function clean(value, max = 300) {
  return String(value ?? "")
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function esc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function isoDay(value) {
  const day = clean(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

function formatDay(value, lang) {
  const day = isoDay(value);
  if (!day) return null;
  const parsed = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return day;
  try {
    return new Intl.DateTimeFormat(DATE_LOCALES[lang] || DATE_LOCALES.en, {
      month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
    }).format(parsed);
  } catch (_error) {
    return day;
  }
}

/**
 * The board's own projects, or a stated failure, or nothing.
 *
 * `null` means this board has no recorded project and the document should carry
 * no section for it. It never means the list was empty because a read failed:
 * that is the `unavailable` state, which is a rendered sentence.
 */
export function communityBoardDistrictProjectsForBoard(lookup, bodyId) {
  const board = clean(bodyId, 80);
  if (!BODY_ID.test(board)) return null;

  const failure = lookup?.error || lookup?.unavailable_reason || null;
  const source = {
    publisher: clean(lookup?.source?.publisher, 200) || null,
    source_url: clean(lookup?.source?.source_url, 400) || null,
    observed_on: clean(lookup?.source?.observed_on, 40) || null,
    dataset_id: clean(lookup?.source?.dataset_id, 40) || null,
  };

  if (failure) {
    return Object.freeze({
      schema: COMMUNITY_BOARD_DISTRICT_PROJECTS_VIEW_SCHEMA,
      state: COMMUNITY_BOARD_DISTRICT_PROJECT_STATES.UNAVAILABLE,
      body_id: board,
      district_id: null,
      projects: Object.freeze([]),
      project_count: 0,
      visible_count: 0,
      overflow_count: 0,
      source: Object.freeze(source),
    });
  }

  const entry = lookup?.boards?.[board];
  const rows = Array.isArray(entry?.projects) ? entry.projects : [];
  const district = clean(entry?.district_id, 10).toUpperCase();
  if (!rows.length || !DISTRICT_ID.test(district)) return null;

  const seen = new Set();
  const projects = [];
  for (const row of rows) {
    const projectId = clean(row?.project_id, 40);
    const href = landProjectPath(projectId);
    // A row whose identifier cannot address the canonical project route is not
    // advertised as a link the site cannot answer.
    if (!projectId || !href || seen.has(projectId)) continue;
    seen.add(projectId);
    projects.push(Object.freeze({
      project_id: projectId,
      title: clean(row?.project_name, 300) || projectId,
      href,
      applicant: clean(row?.primary_applicant, 200) || null,
      public_status: clean(row?.public_status, 120) || null,
      status_recorded_on: isoDay(row?.status_recorded_on),
    }));
  }
  if (!projects.length) return null;

  const visible = Math.min(projects.length, COMMUNITY_BOARD_DISTRICT_PROJECT_VISIBLE_LIMIT);
  return Object.freeze({
    schema: COMMUNITY_BOARD_DISTRICT_PROJECTS_VIEW_SCHEMA,
    state: COMMUNITY_BOARD_DISTRICT_PROJECT_STATES.AVAILABLE,
    body_id: board,
    district_id: district,
    projects: Object.freeze(projects),
    project_count: projects.length,
    visible_count: visible,
    overflow_count: projects.length - visible,
    source: Object.freeze(source),
  });
}

const STRINGS = {
  en: {
    cbdp_heading: "Land use projects in this district",
    cbdp_lede_one: "One land use project is recorded in community district {district}.",
    cbdp_lede: "{count} land use projects are recorded in community district {district}.",
    cbdp_boundary: "This is where each application is recorded. It does not mean this board held a hearing on it, made a recommendation about it, assigned it to a committee, or has any role in it.",
    cbdp_status: "Recorded status: {status}",
    cbdp_status_absent: "The source records no status for this project.",
    cbdp_step_recorded: "Last step recorded {date}",
    cbdp_applicant: "Applicant on the application: {applicant}",
    cbdp_overflow_one: "Show the 1 other project in this district",
    cbdp_overflow: "Show the other {count} projects in this district",
    cbdp_overflow_close: "Show fewer projects",
    cbdp_source: "Source: {publisher}. Observed {date}.",
    cbdp_source_undated: "Source: {publisher}.",
    cbdp_source_link: "Open the published project source",
    cbdp_unavailable: "This district's project list could not be loaded, so none is shown here. That is a failure to read the list, not a district with no projects.",
    cbdp_unavailable_retry: "Reload this page to try again, or read the projects at the published source.",
  },
  es: {
    cbdp_heading: "Proyectos de uso del suelo en este distrito",
    cbdp_lede_one: "Hay un proyecto de uso del suelo registrado en el distrito comunitario {district}.",
    cbdp_lede: "Hay {count} proyectos de uso del suelo registrados en el distrito comunitario {district}.",
    cbdp_boundary: "Aquí es donde se registra cada solicitud. No significa que esta junta haya celebrado una audiencia al respecto, haya emitido una recomendación, la haya asignado a un comité ni tenga función alguna en ella.",
    cbdp_status: "Estado registrado: {status}",
    cbdp_status_absent: "La fuente no registra ningún estado para este proyecto.",
    cbdp_step_recorded: "Último paso registrado el {date}",
    cbdp_applicant: "Solicitante en la solicitud: {applicant}",
    cbdp_overflow_one: "Mostrar el otro proyecto de este distrito",
    cbdp_overflow: "Mostrar los otros {count} proyectos de este distrito",
    cbdp_overflow_close: "Mostrar menos proyectos",
    cbdp_source: "Fuente: {publisher}. Consultada el {date}.",
    cbdp_source_undated: "Fuente: {publisher}.",
    cbdp_source_link: "Abrir la fuente publicada de proyectos",
    cbdp_unavailable: "No se pudo cargar la lista de proyectos de este distrito, así que no se muestra ninguno. Es un fallo al leer la lista, no un distrito sin proyectos.",
    cbdp_unavailable_retry: "Vuelva a cargar esta página para intentarlo de nuevo, o consulte los proyectos en la fuente publicada.",
  },
  "zh-Hans": {
    cbdp_heading: "本辖区内的土地使用项目",
    cbdp_lede_one: "社区辖区 {district} 内记录有 1 个土地使用项目。",
    cbdp_lede: "社区辖区 {district} 内记录有 {count} 个土地使用项目。",
    cbdp_boundary: "这里显示的是每份申请登记的位置，并不表示本委员会曾就该项目举行听证、提出建议、将其分配给某个小组委员会，或在其中担任任何角色。",
    cbdp_status: "记录状态：{status}",
    cbdp_status_absent: "来源未记录该项目的状态。",
    cbdp_step_recorded: "最近一步记录于 {date}",
    cbdp_applicant: "申请书上的申请人：{applicant}",
    cbdp_overflow_one: "显示本辖区的另外 1 个项目",
    cbdp_overflow: "显示本辖区的另外 {count} 个项目",
    cbdp_overflow_close: "显示较少项目",
    cbdp_source: "来源：{publisher}。查看于 {date}。",
    cbdp_source_undated: "来源：{publisher}。",
    cbdp_source_link: "打开已公布的项目来源",
    cbdp_unavailable: "本辖区的项目清单无法载入，因此此处未显示任何项目。这是读取清单失败，而不是该辖区没有项目。",
    cbdp_unavailable_retry: "请重新载入本页重试，或前往已公布的来源查看项目。",
  },
  ru: {
    cbdp_heading: "Проекты землепользования в этом округе",
    cbdp_lede_one: "В общественном округе {district} зарегистрирован один проект землепользования.",
    cbdp_lede: "В общественном округе {district} зарегистрировано проектов землепользования: {count}.",
    cbdp_boundary: "Здесь показано, где зарегистрирована каждая заявка. Это не значит, что совет проводил по ней слушание, выносил рекомендацию, передавал её в комитет или имеет к ней какое-либо отношение.",
    cbdp_status: "Зафиксированный статус: {status}",
    cbdp_status_absent: "Источник не фиксирует статус этого проекта.",
    cbdp_step_recorded: "Последний шаг зафиксирован {date}",
    cbdp_applicant: "Заявитель по заявке: {applicant}",
    cbdp_overflow_one: "Показать ещё один проект в этом округе",
    cbdp_overflow: "Показать остальные проекты в этом округе: {count}",
    cbdp_overflow_close: "Показать меньше проектов",
    cbdp_source: "Источник: {publisher}. Проверено {date}.",
    cbdp_source_undated: "Источник: {publisher}.",
    cbdp_source_link: "Открыть опубликованный источник проектов",
    cbdp_unavailable: "Список проектов этого округа не удалось загрузить, поэтому он здесь не показан. Это сбой чтения списка, а не округ без проектов.",
    cbdp_unavailable_retry: "Перезагрузите страницу, чтобы повторить попытку, или посмотрите проекты в опубликованном источнике.",
  },
  bn: {
    cbdp_heading: "এই ডিস্ট্রিক্টের ভূমি ব্যবহার প্রকল্প",
    cbdp_lede_one: "কমিউনিটি ডিস্ট্রিক্ট {district}-এ একটি ভূমি ব্যবহার প্রকল্প নথিভুক্ত আছে।",
    cbdp_lede: "কমিউনিটি ডিস্ট্রিক্ট {district}-এ {count}টি ভূমি ব্যবহার প্রকল্প নথিভুক্ত আছে।",
    cbdp_boundary: "এখানে দেখানো হয়েছে প্রতিটি আবেদন কোথায় নথিভুক্ত। এর মানে এই নয় যে এই বোর্ড সেটি নিয়ে শুনানি করেছে, সুপারিশ দিয়েছে, কোনো কমিটিতে পাঠিয়েছে বা এতে বোর্ডের কোনো ভূমিকা আছে।",
    cbdp_status: "নথিভুক্ত অবস্থা: {status}",
    cbdp_status_absent: "উৎসে এই প্রকল্পের কোনো অবস্থা নথিভুক্ত নেই।",
    cbdp_step_recorded: "সর্বশেষ ধাপ নথিভুক্ত {date}",
    cbdp_applicant: "আবেদনপত্রে আবেদনকারী: {applicant}",
    cbdp_overflow_one: "এই ডিস্ট্রিক্টের অন্য ১টি প্রকল্প দেখুন",
    cbdp_overflow: "এই ডিস্ট্রিক্টের অন্য {count}টি প্রকল্প দেখুন",
    cbdp_overflow_close: "কম প্রকল্প দেখান",
    cbdp_source: "উৎস: {publisher}। দেখা হয়েছে {date}।",
    cbdp_source_undated: "উৎস: {publisher}।",
    cbdp_source_link: "প্রকাশিত প্রকল্প উৎস খুলুন",
    cbdp_unavailable: "এই ডিস্ট্রিক্টের প্রকল্প তালিকা লোড করা যায়নি, তাই এখানে কিছু দেখানো হয়নি। এটি তালিকা পড়তে ব্যর্থতা, প্রকল্পহীন ডিস্ট্রিক্ট নয়।",
    cbdp_unavailable_retry: "আবার চেষ্টা করতে এই পাতাটি রিলোড করুন, অথবা প্রকাশিত উৎসে প্রকল্পগুলি দেখুন।",
  },
  ht: {
    cbdp_heading: "Pwojè itilizasyon tè nan distri sa a",
    cbdp_lede_one: "Gen yon pwojè itilizasyon tè ki anrejistre nan distri kominotè {district}.",
    cbdp_lede: "Gen {count} pwojè itilizasyon tè ki anrejistre nan distri kominotè {district}.",
    cbdp_boundary: "Se la chak demann anrejistre. Sa pa vle di konsèy sa a te fè yon odyans sou li, te bay yon rekòmandasyon, te voye l nan yon komite, oswa gen okenn wòl ladan l.",
    cbdp_status: "Eta anrejistre: {status}",
    cbdp_status_absent: "Sous la pa anrejistre okenn eta pou pwojè sa a.",
    cbdp_step_recorded: "Dènye etap anrejistre {date}",
    cbdp_applicant: "Moun ki fè demann nan: {applicant}",
    cbdp_overflow_one: "Montre lòt pwojè a nan distri sa a",
    cbdp_overflow: "Montre lòt {count} pwojè yo nan distri sa a",
    cbdp_overflow_close: "Montre mwens pwojè",
    cbdp_source: "Sous: {publisher}. Gade {date}.",
    cbdp_source_undated: "Sous: {publisher}.",
    cbdp_source_link: "Louvri sous pwojè pibliye a",
    cbdp_unavailable: "Nou pa t kapab chaje lis pwojè distri sa a, kidonk nou pa montre okenn isit la. Se yon echèk pou li lis la, se pa yon distri ki pa gen pwojè.",
    cbdp_unavailable_retry: "Rechaje paj sa a pou eseye ankò, oswa li pwojè yo nan sous pibliye a.",
  },
  ko: {
    cbdp_heading: "이 지구의 토지 이용 프로젝트",
    cbdp_lede_one: "커뮤니티 지구 {district}에 토지 이용 프로젝트 1건이 기록되어 있습니다.",
    cbdp_lede: "커뮤니티 지구 {district}에 토지 이용 프로젝트 {count}건이 기록되어 있습니다.",
    cbdp_boundary: "각 신청이 기록된 위치를 보여 줄 뿐입니다. 이 보드가 해당 프로젝트에 대해 공청회를 열었거나, 권고를 냈거나, 위원회에 배정했거나, 어떤 역할을 맡았다는 뜻이 아닙니다.",
    cbdp_status: "기록된 상태: {status}",
    cbdp_status_absent: "출처에 이 프로젝트의 상태가 기록되어 있지 않습니다.",
    cbdp_step_recorded: "최근 단계 기록일 {date}",
    cbdp_applicant: "신청서상의 신청인: {applicant}",
    cbdp_overflow_one: "이 지구의 다른 프로젝트 1건 보기",
    cbdp_overflow: "이 지구의 다른 프로젝트 {count}건 보기",
    cbdp_overflow_close: "프로젝트 적게 보기",
    cbdp_source: "출처: {publisher}. 확인일 {date}.",
    cbdp_source_undated: "출처: {publisher}.",
    cbdp_source_link: "공개된 프로젝트 출처 열기",
    cbdp_unavailable: "이 지구의 프로젝트 목록을 불러오지 못해 아무것도 표시하지 않았습니다. 목록을 읽지 못한 것이며, 프로젝트가 없는 지구라는 뜻이 아닙니다.",
    cbdp_unavailable_retry: "이 페이지를 다시 불러오거나, 공개된 출처에서 프로젝트를 확인하세요.",
  },
  fr: {
    cbdp_heading: "Projets d'aménagement dans ce district",
    cbdp_lede_one: "Un projet d'aménagement est enregistré dans le district communautaire {district}.",
    cbdp_lede: "{count} projets d'aménagement sont enregistrés dans le district communautaire {district}.",
    cbdp_boundary: "Il s'agit du lieu où chaque demande est enregistrée. Cela ne signifie pas que ce conseil a tenu une audience à son sujet, a émis une recommandation, l'a confiée à un comité ou y joue un rôle quelconque.",
    cbdp_status: "Statut consigné : {status}",
    cbdp_status_absent: "La source ne consigne aucun statut pour ce projet.",
    cbdp_step_recorded: "Dernière étape consignée le {date}",
    cbdp_applicant: "Demandeur figurant sur la demande : {applicant}",
    cbdp_overflow_one: "Afficher l'autre projet de ce district",
    cbdp_overflow: "Afficher les {count} autres projets de ce district",
    cbdp_overflow_close: "Afficher moins de projets",
    cbdp_source: "Source : {publisher}. Consultée le {date}.",
    cbdp_source_undated: "Source : {publisher}.",
    cbdp_source_link: "Ouvrir la source publiée des projets",
    cbdp_unavailable: "La liste des projets de ce district n'a pas pu être chargée ; aucun n'est donc affiché ici. C'est un échec de lecture de la liste, et non un district sans projets.",
    cbdp_unavailable_retry: "Rechargez cette page pour réessayer, ou consultez les projets à la source publiée.",
  },
  pl: {
    cbdp_heading: "Projekty zagospodarowania terenu w tym okręgu",
    cbdp_lede_one: "W okręgu społecznym {district} zarejestrowano jeden projekt zagospodarowania terenu.",
    cbdp_lede: "W okręgu społecznym {district} zarejestrowano projekty zagospodarowania terenu w liczbie {count}.",
    cbdp_boundary: "To miejsce, w którym zarejestrowano każdy wniosek. Nie oznacza to, że ta rada przeprowadziła w tej sprawie wysłuchanie, wydała rekomendację, przekazała ją komisji ani że pełni w niej jakąkolwiek rolę.",
    cbdp_status: "Odnotowany status: {status}",
    cbdp_status_absent: "Źródło nie odnotowuje statusu tego projektu.",
    cbdp_step_recorded: "Ostatni krok odnotowano {date}",
    cbdp_applicant: "Wnioskodawca we wniosku: {applicant}",
    cbdp_overflow_one: "Pokaż jeszcze jeden projekt w tym okręgu",
    cbdp_overflow: "Pokaż pozostałe projekty w tym okręgu: {count}",
    cbdp_overflow_close: "Pokaż mniej projektów",
    cbdp_source: "Źródło: {publisher}. Sprawdzono {date}.",
    cbdp_source_undated: "Źródło: {publisher}.",
    cbdp_source_link: "Otwórz opublikowane źródło projektów",
    cbdp_unavailable: "Nie udało się wczytać listy projektów tego okręgu, więc żaden nie jest tu pokazany. To błąd odczytu listy, a nie okręg bez projektów.",
    cbdp_unavailable_retry: "Odśwież tę stronę, aby spróbować ponownie, lub przeczytaj projekty w opublikowanym źródle.",
  },
  ar: {
    cbdp_heading: "مشاريع استخدام الأراضي في هذه الدائرة",
    cbdp_lede_one: "يوجد مشروع واحد لاستخدام الأراضي مسجَّل في الدائرة المجتمعية {district}.",
    cbdp_lede: "يوجد {count} من مشاريع استخدام الأراضي مسجَّلة في الدائرة المجتمعية {district}.",
    cbdp_boundary: "هذا هو المكان الذي سُجِّل فيه كل طلب. ولا يعني ذلك أن هذا المجلس عقد جلسة استماع بشأنه، أو قدَّم توصية، أو أحاله إلى لجنة، أو أن له أي دور فيه.",
    cbdp_status: "الحالة المسجَّلة: {status}",
    cbdp_status_absent: "لا يسجّل المصدر أي حالة لهذا المشروع.",
    cbdp_step_recorded: "آخر خطوة مسجَّلة في {date}",
    cbdp_applicant: "مقدّم الطلب المذكور في الطلب: {applicant}",
    cbdp_overflow_one: "عرض المشروع الآخر في هذه الدائرة",
    cbdp_overflow: "عرض المشاريع الأخرى في هذه الدائرة: {count}",
    cbdp_overflow_close: "عرض عدد أقل من المشاريع",
    cbdp_source: "المصدر: {publisher}. جرى الاطلاع عليه في {date}.",
    cbdp_source_undated: "المصدر: {publisher}.",
    cbdp_source_link: "افتح مصدر المشاريع المنشور",
    cbdp_unavailable: "تعذّر تحميل قائمة مشاريع هذه الدائرة، لذا لا يُعرض أي مشروع هنا. هذا إخفاق في قراءة القائمة، وليس دائرة بلا مشاريع.",
    cbdp_unavailable_retry: "أعد تحميل هذه الصفحة للمحاولة مرة أخرى، أو اطّلع على المشاريع في المصدر المنشور.",
  },
  ur: {
    cbdp_heading: "اس ڈسٹرکٹ میں زمین کے استعمال کے منصوبے",
    cbdp_lede_one: "کمیونٹی ڈسٹرکٹ {district} میں زمین کے استعمال کا ایک منصوبہ ریکارڈ ہے۔",
    cbdp_lede: "کمیونٹی ڈسٹرکٹ {district} میں زمین کے استعمال کے {count} منصوبے ریکارڈ ہیں۔",
    cbdp_boundary: "یہ وہ جگہ ہے جہاں ہر درخواست ریکارڈ ہوتی ہے۔ اس کا مطلب یہ نہیں کہ اس بورڈ نے اس پر سماعت کی، سفارش دی، اسے کسی کمیٹی کے سپرد کیا، یا اس میں اس کا کوئی کردار ہے۔",
    cbdp_status: "ریکارڈ شدہ حیثیت: {status}",
    cbdp_status_absent: "ماخذ اس منصوبے کی کوئی حیثیت ریکارڈ نہیں کرتا۔",
    cbdp_step_recorded: "آخری مرحلہ {date} کو ریکارڈ ہوا",
    cbdp_applicant: "درخواست پر درخواست گزار: {applicant}",
    cbdp_overflow_one: "اس ڈسٹرکٹ کا ایک اور منصوبہ دکھائیں",
    cbdp_overflow: "اس ڈسٹرکٹ کے باقی {count} منصوبے دکھائیں",
    cbdp_overflow_close: "کم منصوبے دکھائیں",
    cbdp_source: "ماخذ: {publisher}۔ {date} کو دیکھا گیا۔",
    cbdp_source_undated: "ماخذ: {publisher}۔",
    cbdp_source_link: "شائع شدہ منصوبہ ماخذ کھولیں",
    cbdp_unavailable: "اس ڈسٹرکٹ کے منصوبوں کی فہرست لوڈ نہیں ہو سکی، اس لیے یہاں کوئی نہیں دکھایا گیا۔ یہ فہرست پڑھنے کی ناکامی ہے، ایسا ڈسٹرکٹ نہیں جس میں کوئی منصوبہ نہ ہو۔",
    cbdp_unavailable_retry: "دوبارہ کوشش کے لیے یہ صفحہ ری لوڈ کریں، یا شائع شدہ ماخذ پر منصوبے پڑھیں۔",
  },
};

function localizedT(lang) {
  const values = STRINGS[lang] || STRINGS.en;
  return (key, vars = {}) => String(values[key] || STRINGS.en[key] || key)
    .replace(/\{(\w+)\}/g, (_, name) => (vars[name] ?? ""));
}

/** Publisher text keeps its own language and direction inside a translated page. */
function sourceText(value) {
  return `<span lang="en" dir="ltr">${esc(value)}</span>`;
}

/**
 * A translated sentence with one publisher value inside it.
 *
 * The value is placed through a private-use sentinel rather than by trimming
 * the end of the sentence, so a language that puts the value first, last or in
 * the middle all render correctly and the publisher's own text keeps its
 * bidi isolation.
 */
const VALUE_SENTINEL = "\ue000";

function sentenceWithSourceValue(t, key, name, value) {
  return esc(t(key, { [name]: VALUE_SENTINEL })).replace(VALUE_SENTINEL, sourceText(value));
}

function projectMarkup(project, t, lang) {
  const facts = [];
  if (project.public_status) {
    facts.push(`<span class="board-district-project-status">${sentenceWithSourceValue(t, "cbdp_status", "status", project.public_status)}</span>`);
  } else {
    facts.push(`<span class="board-district-project-status">${esc(t("cbdp_status_absent"))}</span>`);
  }
  const recorded = formatDay(project.status_recorded_on, lang);
  if (recorded) facts.push(`<span class="board-district-project-recorded">${esc(t("cbdp_step_recorded", { date: recorded }))}</span>`);
  if (project.applicant) {
    facts.push(`<span class="board-district-project-applicant">${sentenceWithSourceValue(t, "cbdp_applicant", "applicant", project.applicant)}</span>`);
  }
  return `<li class="node-record board-district-project" data-project-id="${esc(project.project_id)}"${project.public_status ? ` data-project-status="${esc(project.public_status)}"` : ""}>`
    + `<div class="node-record-main"><a class="ui-constellation-link board-district-project-link" href="${esc(project.href)}"><strong lang="en" dir="ltr">${esc(project.title)}</strong></a> <span class="board-district-project-id" lang="en" dir="ltr">${esc(project.project_id)}</span></div>`
    + `<span class="muted node-muted">${facts.join(" · ")}</span>`
    + `</li>`;
}

function sourceMarkup(view, t, lang) {
  const parts = [];
  if (view.source?.publisher) {
    const observed = formatDay(String(view.source.observed_on || "").slice(0, 10), lang);
    parts.push(observed
      ? esc(t("cbdp_source", { publisher: VALUE_SENTINEL, date: observed })).replace(VALUE_SENTINEL, sourceText(view.source.publisher))
      : sentenceWithSourceValue(t, "cbdp_source_undated", "publisher", view.source.publisher));
  }
  if (view.source?.source_url) {
    parts.push(`<a class="ui-constellation-link board-district-project-source" href="${esc(view.source.source_url)}">${esc(t("cbdp_source_link"))}</a>`);
  }
  if (!parts.length) return "";
  return `<p class="muted node-muted board-district-projects-source">${parts.join(" ")}</p>`;
}

/**
 * The section markup, or "" when this board has nothing to show.
 *
 * Every link is a plain anchor to the site's canonical project route, so a
 * modified click, a middle click and the browser's own history all behave the
 * way they do anywhere else, and the overflow disclosure is a native
 * `<details>` that inspects in place without navigating or subscribing.
 */
export function renderCommunityBoardDistrictProjectsSection(view, options = {}) {
  if (!view || view.schema !== COMMUNITY_BOARD_DISTRICT_PROJECTS_VIEW_SCHEMA) return "";
  const lang = STRINGS[options.lang] ? options.lang : "en";
  const t = localizedT(lang);
  const langAttrs = lang === "en" ? {} : { lang, dir: RTL_LANGS.has(lang) ? "rtl" : "ltr" };

  if (view.state === COMMUNITY_BOARD_DISTRICT_PROJECT_STATES.UNAVAILABLE) {
    return renderNodeSection({
      heading: t("cbdp_heading"),
      headingId: `${COMMUNITY_BOARD_DISTRICT_PROJECTS_ANCHOR}-heading`,
      exportClass: "object_district_projects",
      extraClass: "node-card civic-object-section board-district-projects",
      attrs: {
        id: COMMUNITY_BOARD_DISTRICT_PROJECTS_ANCHOR,
        "data-community-board-district-projects": "1",
        "data-district-projects-state": COMMUNITY_BOARD_DISTRICT_PROJECT_STATES.UNAVAILABLE,
        ...langAttrs,
      },
      body: `<p class="node-lede">${esc(t("cbdp_unavailable"))}</p>`
        + `<p class="muted node-muted">${esc(t("cbdp_unavailable_retry"))}</p>`
        + sourceMarkup(view, t, lang),
    });
  }

  const visible = view.projects.slice(0, view.visible_count);
  const overflow = view.projects.slice(view.visible_count);
  const lede = view.project_count === 1
    ? t("cbdp_lede_one", { district: view.district_id })
    : t("cbdp_lede", { count: String(view.project_count), district: view.district_id });
  const overflowLabel = overflow.length === 1
    ? t("cbdp_overflow_one")
    : t("cbdp_overflow", { count: String(overflow.length) });
  const overflowMarkup = overflow.length
    ? `<div class="board-district-projects-overflow" id="${COMMUNITY_BOARD_DISTRICT_PROJECTS_OVERFLOW_ANCHOR}" data-district-projects-overflow="${esc(String(overflow.length))}">`
      + `<a class="ui-constellation-link board-district-projects-more" href="#${COMMUNITY_BOARD_DISTRICT_PROJECTS_OVERFLOW_ANCHOR}">${esc(overflowLabel)}</a>`
      + `<ul class="node-record-list board-district-projects-list board-district-projects-overflow-list">${overflow.map((project) => projectMarkup(project, t, lang)).join("")}</ul>`
      + `<a class="ui-constellation-link board-district-projects-less" href="#${COMMUNITY_BOARD_DISTRICT_PROJECTS_ANCHOR}">${esc(t("cbdp_overflow_close"))}</a>`
      + `</div>`
    : "";

  return renderNodeSection({
    heading: t("cbdp_heading"),
    headingId: `${COMMUNITY_BOARD_DISTRICT_PROJECTS_ANCHOR}-heading`,
    exportClass: "object_district_projects",
    extraClass: "node-card civic-object-section board-district-projects",
    attrs: {
      id: COMMUNITY_BOARD_DISTRICT_PROJECTS_ANCHOR,
      "data-community-board-district-projects": "1",
      "data-district-projects-state": COMMUNITY_BOARD_DISTRICT_PROJECT_STATES.AVAILABLE,
      "data-district-id": view.district_id,
      "data-project-count": String(view.project_count),
      ...langAttrs,
    },
    body: `<p class="node-lede">${esc(lede)}</p>`
      + `<p class="muted node-muted board-district-projects-boundary">${esc(t("cbdp_boundary"))}</p>`
      + `<ul class="node-record-list board-district-projects-list">${visible.map((project) => projectMarkup(project, t, lang)).join("")}</ul>`
      + overflowMarkup
      + sourceMarkup(view, t, lang),
  });
}

export { STRINGS as COMMUNITY_BOARD_DISTRICT_PROJECT_STRINGS };
