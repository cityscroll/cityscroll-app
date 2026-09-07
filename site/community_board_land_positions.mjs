/**
 * "Positions this board recorded on land use projects" on a Community Board
 * document.
 *
 * CityScroll already holds, for each retained land use project, the review
 * bodies that submitted a recommendation on it. That relation is published
 * project-first, so it could only be read by standing on a project and looking
 * outward. A resident standing on their own board — the far more common place
 * to start — had no way to ask what this board has actually said about the
 * applications in front of it.
 *
 * This read model answers that from one materialized artifact
 * (`site/data/community_board_land_positions.json`, written by
 * `tools/build_community_board_land_positions.mjs` over the reverse index in
 * `warehouse/lib/community_board_land_positions.mjs`). No page reads the
 * publisher, and every board reads the same population.
 *
 * Two affordances per row, with two different meanings, following the same
 * grammar the rendered documents already use for calendar events:
 *
 *  - the project title is a real anchor to that project's own page. It works
 *    with scripting off, under a modified click and through the context menu,
 *    because nothing here intercepts it.
 *  - a sibling native button element inspects the recorded position in place.
 *    It opens nothing but a bounded summary of one record: no navigation, no
 *    subscription, no request of any kind. It stays invisible until the boot
 *    module marks the section ready, so a reader without scripting is never
 *    offered an affordance that would not work for them, and the same facts are
 *    already written into the row for them to read.
 *
 * The copy is bounded by what the source actually holds. A board position is
 * advisory and the section says so; a recorded tally is the vote on the board's
 * recommendation motion and is never relabelled as support for the development;
 * a waiver keeps its own meaning rather than being read as either side; and two
 * rows that share a date and a tally are two applications, never one meeting.
 *
 * Three states, kept apart on purpose: a board with recorded positions, a board
 * this source records none for — said as a statement about the source, never as
 * a claim that the board has never voted — and a list that could not be read.
 */

import { renderNodeSection } from "./civic_document_chrome.mjs";
import { landProjectPath } from "./land_project_route.mjs";

export const COMMUNITY_BOARD_LAND_POSITIONS_VIEW_SCHEMA = "cityscroll.community_board_land_positions_view.v1";
export const COMMUNITY_BOARD_LAND_POSITIONS_ANCHOR = "board-land-positions";

/**
 * The version marker carried in the inspect payload. The schema identity above
 * names this module for its callers; the attribute payload carries only this
 * short integer, so no schema vocabulary reaches a resident-facing document.
 */
export const COMMUNITY_BOARD_LAND_POSITION_PAYLOAD_VERSION = 1;

export const COMMUNITY_BOARD_LAND_POSITIONS_ATTRIBUTE = "data-board-land-position";
export const COMMUNITY_BOARD_LAND_POSITIONS_LABELS_ATTRIBUTE = "data-board-land-position-labels";
export const COMMUNITY_BOARD_LAND_POSITIONS_READY_ATTRIBUTE = "data-board-land-positions-ready";
export const COMMUNITY_BOARD_LAND_POSITION_DIALOG_ID = "board-land-position-inspect";
export const COMMUNITY_BOARD_LAND_POSITION_TITLE_ID = "board-land-position-inspect-title";

/**
 * How many positions the section lists before the rest move behind an exact
 * disclosure addressed by the page's own fragment. A browser restores a history
 * entry's URL and scroll offset but not an element's open state, so putting the
 * expansion in the URL is what lets a reader open the rest of the list, follow a
 * project, and come back to the list as they left it — with no script involved.
 */
export const COMMUNITY_BOARD_LAND_POSITION_VISIBLE_LIMIT = 6;
export const COMMUNITY_BOARD_LAND_POSITIONS_OVERFLOW_ANCHOR = "board-land-positions-more";

export const COMMUNITY_BOARD_LAND_POSITION_STATES = Object.freeze({
  AVAILABLE: "available",
  NONE_RECORDED: "none_recorded",
  UNAVAILABLE: "unavailable",
});

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
const BODY_ID = /^[a-z]+(?:-[a-z]+)*-cb-\d{2}$/;

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

function formatCount(value, lang) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value ?? "");
  try {
    return new Intl.NumberFormat(DATE_LOCALES[lang] || DATE_LOCALES.en).format(number);
  } catch (_error) {
    return String(number);
  }
}

function wholeNumber(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function normalizeTally(tally) {
  const votesFor = wholeNumber(tally?.votes_for);
  const against = wholeNumber(tally?.votes_against);
  const abstain = wholeNumber(tally?.votes_abstain);
  const recorded = votesFor !== null || against !== null || abstain !== null;
  return { recorded, votes_for: votesFor, votes_against: against, votes_abstain: abstain };
}

function normalizeCompanion(row) {
  const position = clean(row?.position, 120);
  const representing = clean(row?.representing, 80);
  if (!position || !representing) return null;
  return Object.freeze({
    representing,
    position,
    recorded_on: isoDay(row?.recorded_on),
  });
}

/**
 * The board's own recorded positions, a stated absence, or a stated failure.
 *
 * Never `null` for a board this site publishes: a board with nothing recorded
 * gets a sentence about the source, because silence and "the source holds
 * nothing here" are different answers and only one of them is true.
 */
export function communityBoardLandPositionsForBoard(lookup, bodyId) {
  const board = clean(bodyId, 80);
  if (!BODY_ID.test(board)) return null;

  const source = {
    publisher: clean(lookup?.source?.publisher, 200) || null,
    source_url: clean(lookup?.source?.source_url, 400) || null,
    observed_on: clean(lookup?.source?.observed_on, 40) || null,
    dataset_id: clean(lookup?.source?.dataset_id, 40) || null,
  };
  const base = {
    schema: COMMUNITY_BOARD_LAND_POSITIONS_VIEW_SCHEMA,
    body_id: board,
    positions: Object.freeze([]),
    position_count: 0,
    project_count: 0,
    recorded_date_count: 0,
    visible_count: 0,
    overflow_count: 0,
    retained_project_count: 0,
    source: Object.freeze(source),
  };

  const failure = lookup?.error || lookup?.unavailable_reason || null;
  if (failure) {
    return Object.freeze({ ...base, state: COMMUNITY_BOARD_LAND_POSITION_STATES.UNAVAILABLE });
  }

  const retained = wholeNumber(lookup?.counts?.retained_projects) ?? 0;
  const entry = lookup?.boards?.[board];
  const rows = Array.isArray(entry?.positions) ? entry.positions : [];

  const seen = new Set();
  const positions = [];
  for (const row of rows) {
    const projectId = clean(row?.project_id, 40);
    const href = landProjectPath(projectId);
    const position = clean(row?.position, 120);
    const recordedOn = isoDay(row?.recorded_on);
    // A row that cannot address the canonical project route, or that carries no
    // position or no recorded date, is not advertised as a record this site can
    // show. The artifact already counts those separately.
    if (!projectId || !href || !position || !recordedOn) continue;
    // One board holds one recorded position per source record. Two applications
    // are never folded together, so the identity is the source record and the
    // project together, never the date or the tally.
    const key = `${clean(row?.source_record_id, 80)}|${projectId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    positions.push(Object.freeze({
      project_id: projectId,
      title: clean(row?.project_name, 300) || projectId,
      href,
      portal_url: clean(row?.project_portal_url, 400) || null,
      position,
      position_class: clean(row?.position_class, 40) || "unreviewed",
      recorded_on: recordedOn,
      recorded_tally: Object.freeze(normalizeTally(row?.recorded_tally)),
      project_public_status: clean(row?.project_public_status, 120) || null,
      source_record_id: clean(row?.source_record_id, 80) || null,
      other_positions: Object.freeze(
        (Array.isArray(row?.other_positions) ? row.other_positions : [])
          .map(normalizeCompanion)
          .filter(Boolean),
      ),
    }));
  }

  if (!positions.length) {
    return Object.freeze({
      ...base,
      state: COMMUNITY_BOARD_LAND_POSITION_STATES.NONE_RECORDED,
      retained_project_count: retained,
    });
  }

  const visible = Math.min(positions.length, COMMUNITY_BOARD_LAND_POSITION_VISIBLE_LIMIT);
  return Object.freeze({
    ...base,
    state: COMMUNITY_BOARD_LAND_POSITION_STATES.AVAILABLE,
    positions: Object.freeze(positions),
    position_count: positions.length,
    project_count: new Set(positions.map((row) => row.project_id)).size,
    recorded_date_count: new Set(positions.map((row) => row.recorded_on)).size,
    visible_count: visible,
    overflow_count: positions.length - visible,
    retained_project_count: retained,
  });
}

const STRINGS = {
  en: {
    cblp_heading: "Positions this board recorded on land use projects",
    cblp_lede_one: "The city's zoning application records hold one dated position this board submitted on a land use project.",
    cblp_lede: "The city's zoning application records hold {count} dated positions this board submitted, on {projects} land use projects.",
    cblp_advisory: "A community board's position on a land use application is advisory. The board holds a public hearing and votes on a recommendation; the City Planning Commission, and the City Council where the review reaches it, are the bodies that decide.",
    cblp_tally_boundary: "A recorded tally is the vote on the board's recommendation motion. It is not a count of members for or against the development.",
    cblp_row_boundary: "Each row is one position on one application. Applications recorded on the same day keep separate rows, separate source records and separate project pages, and this list counts positions.",
    cblp_position: "Position recorded: {position}",
    cblp_recorded_on: "Voted {date}",
    cblp_tally_lead: "Recorded tally on the recommendation:",
    cblp_tally_for: "{count} in favor",
    cblp_tally_against: "{count} against",
    cblp_tally_abstain: "{count} abstaining",
    cblp_tally_absent: "The source records no vote tally for this position.",
    cblp_waiver: "Waiving a recommendation ends this board's review step without a favorable or unfavorable position. It is not support and it is not opposition.",
    cblp_project_status: "Project status recorded: {status}",
    cblp_project_status_absent: "The source records no status for this project.",
    cblp_inspect: "Inspect",
    cblp_inspect_label: "Inspect the position recorded on {title}",
    cblp_close: "Close",
    cblp_dialog_kicker: "Recorded position",
    cblp_open_project: "Open this project",
    cblp_portal_link: "Open the published project record",
    cblp_other_heading: "Also recorded on this application",
    cblp_other_undated: "The source records no vote date for this position.",
    cblp_other_none: "The source records no other body's position on this application.",
    cblp_record_id: "Source record: {id}",
    cblp_source: "Source: {publisher}. Observed {date}.",
    cblp_source_undated: "Source: {publisher}.",
    cblp_source_link: "Open the published project source",
    cblp_overflow_one: "Show the 1 other recorded position",
    cblp_overflow: "Show the other {count} recorded positions",
    cblp_overflow_close: "Show fewer recorded positions",
    cblp_empty_one: "This source records no position submitted by this board on the one land use project this site retains from it. That is what the source holds; it is not a record that this board has never voted on an application.",
    cblp_empty: "This source records no position submitted by this board on the {count} land use projects this site retains from it. That is what the source holds; it is not a record that this board has never voted on an application.",
    cblp_unavailable: "This board's recorded positions could not be loaded, so none are shown here. That is a failure to read them, not a board with no recorded positions.",
    cblp_unavailable_retry: "Reload this page to try again, or read the projects at the published source.",
  },
  es: {
    cblp_heading: "Posiciones que esta junta registró sobre proyectos de uso del suelo",
    cblp_lede_one: "Los registros municipales de solicitudes de zonificación contienen una posición fechada que esta junta presentó sobre un proyecto de uso del suelo.",
    cblp_lede: "Los registros municipales de solicitudes de zonificación contienen {count} posiciones fechadas presentadas por esta junta, sobre {projects} proyectos de uso del suelo.",
    cblp_advisory: "La posición de una junta comunitaria sobre una solicitud de uso del suelo es consultiva. La junta celebra una audiencia pública y vota una recomendación; la Comisión de Planificación Urbana y, cuando la revisión llega hasta él, el Concejo Municipal son los órganos que deciden.",
    cblp_tally_boundary: "El recuento registrado es la votación sobre la moción de recomendación de la junta. No es un conteo de miembros a favor o en contra del desarrollo.",
    cblp_row_boundary: "Cada fila es una posición sobre una solicitud. Las solicitudes registradas el mismo día conservan filas distintas, registros de origen distintos y páginas de proyecto distintas, y esta lista cuenta posiciones.",
    cblp_position: "Posición registrada: {position}",
    cblp_recorded_on: "Votada el {date}",
    cblp_tally_lead: "Recuento registrado de la recomendación:",
    cblp_tally_for: "{count} a favor",
    cblp_tally_against: "{count} en contra",
    cblp_tally_abstain: "{count} en abstención",
    cblp_tally_absent: "La fuente no registra ningún recuento de votos para esta posición.",
    cblp_waiver: "Renunciar a la recomendación concluye el paso de revisión de esta junta sin una posición favorable ni desfavorable. No es apoyo y no es oposición.",
    cblp_project_status: "Estado registrado del proyecto: {status}",
    cblp_project_status_absent: "La fuente no registra ningún estado para este proyecto.",
    cblp_inspect: "Examinar",
    cblp_inspect_label: "Examinar la posición registrada sobre {title}",
    cblp_close: "Cerrar",
    cblp_dialog_kicker: "Posición registrada",
    cblp_open_project: "Abrir este proyecto",
    cblp_portal_link: "Abrir el expediente publicado del proyecto",
    cblp_other_heading: "También registrado en esta solicitud",
    cblp_other_undated: "La fuente no registra ninguna fecha de votación para esta posición.",
    cblp_other_none: "La fuente no registra la posición de ningún otro órgano sobre esta solicitud.",
    cblp_record_id: "Registro de origen: {id}",
    cblp_source: "Fuente: {publisher}. Consultada el {date}.",
    cblp_source_undated: "Fuente: {publisher}.",
    cblp_source_link: "Abrir la fuente publicada de proyectos",
    cblp_overflow_one: "Mostrar la otra posición registrada",
    cblp_overflow: "Mostrar las otras {count} posiciones registradas",
    cblp_overflow_close: "Mostrar menos posiciones registradas",
    cblp_empty_one: "Esta fuente no registra ninguna posición presentada por esta junta sobre el único proyecto de uso del suelo que este sitio conserva de ella. Eso es lo que contiene la fuente; no es constancia de que esta junta nunca haya votado sobre una solicitud.",
    cblp_empty: "Esta fuente no registra ninguna posición presentada por esta junta sobre los {count} proyectos de uso del suelo que este sitio conserva de ella. Eso es lo que contiene la fuente; no es constancia de que esta junta nunca haya votado sobre una solicitud.",
    cblp_unavailable: "No se pudieron cargar las posiciones registradas de esta junta, así que no se muestra ninguna. Es un fallo al leerlas, no una junta sin posiciones registradas.",
    cblp_unavailable_retry: "Vuelva a cargar esta página para intentarlo de nuevo, o consulte los proyectos en la fuente publicada.",
  },
  "zh-Hans": {
    cblp_heading: "本委员会就土地使用项目登记的立场",
    cblp_lede_one: "市政土地使用申请记录中，登记有本委员会就一个土地使用项目提交的一项注明日期的立场。",
    cblp_lede: "市政土地使用申请记录中，登记有本委员会提交的 {count} 项注明日期的立场，涉及 {projects} 个土地使用项目。",
    cblp_advisory: "社区委员会对土地使用申请的立场属于咨询性质。委员会举行公开听证并就一项建议进行表决；作出决定的是城市规划委员会，以及在审查程序到达时的市议会。",
    cblp_tally_boundary: "登记的票数是对委员会建议动议的表决结果，并不是支持或反对该开发项目的成员人数。",
    cblp_row_boundary: "每一行是就一份申请登记的一项立场。同一天登记的申请各自保留独立的行、独立的来源记录和独立的项目页面，本列表统计的是立场。",
    cblp_position: "登记立场：{position}",
    cblp_recorded_on: "表决于 {date}",
    cblp_tally_lead: "建议动议的登记票数：",
    cblp_tally_for: "赞成 {count} 票",
    cblp_tally_against: "反对 {count} 票",
    cblp_tally_abstain: "弃权 {count} 票",
    cblp_tally_absent: "来源未登记该立场的表决票数。",
    cblp_waiver: "放弃提出建议即结束本委员会的审查步骤，不形成赞成或反对的立场。这既不是支持，也不是反对。",
    cblp_project_status: "登记的项目状态：{status}",
    cblp_project_status_absent: "来源未登记该项目的状态。",
    cblp_inspect: "查看详情",
    cblp_inspect_label: "查看就 {title} 登记的立场",
    cblp_close: "关闭",
    cblp_dialog_kicker: "登记的立场",
    cblp_open_project: "打开该项目",
    cblp_portal_link: "打开已公布的项目记录",
    cblp_other_heading: "该申请上的其他登记立场",
    cblp_other_undated: "来源未登记该立场的表决日期。",
    cblp_other_none: "来源未登记其他机构就该申请的立场。",
    cblp_record_id: "来源记录：{id}",
    cblp_source: "来源：{publisher}。查看于 {date}。",
    cblp_source_undated: "来源：{publisher}。",
    cblp_source_link: "打开已公布的项目来源",
    cblp_overflow_one: "显示另外 1 项登记的立场",
    cblp_overflow: "显示另外 {count} 项登记的立场",
    cblp_overflow_close: "显示较少的登记立场",
    cblp_empty_one: "该来源未登记本委员会就本网站从中保留的这 1 个土地使用项目提交的任何立场。这只是该来源所含的内容，并不表示本委员会从未就申请进行过表决。",
    cblp_empty: "该来源未登记本委员会就本网站从中保留的 {count} 个土地使用项目提交的任何立场。这只是该来源所含的内容，并不表示本委员会从未就申请进行过表决。",
    cblp_unavailable: "本委员会的登记立场无法载入，因此此处未显示任何立场。这是读取失败，而不是该委员会没有登记立场。",
    cblp_unavailable_retry: "请重新载入本页重试，或前往已公布的来源查看项目。",
  },
  ru: {
    cblp_heading: "Позиции, которые этот совет зафиксировал по проектам землепользования",
    cblp_lede_one: "В городских записях заявок по зонированию есть одна датированная позиция, поданная этим советом по проекту землепользования.",
    cblp_lede: "В городских записях заявок по зонированию есть датированных позиций, поданных этим советом: {count} — по проектам землепользования: {projects}.",
    cblp_advisory: "Позиция общественного совета по заявке на землепользование носит рекомендательный характер. Совет проводит публичные слушания и голосует за рекомендацию; решение принимают Комиссия городского планирования и, если рассмотрение доходит до него, Городской совет.",
    cblp_tally_boundary: "Зафиксированный подсчёт — это голосование по предложению совета о рекомендации. Это не число членов за или против застройки.",
    cblp_row_boundary: "Каждая строка — одна позиция по одной заявке. Заявки, зафиксированные в один день, сохраняют отдельные строки, отдельные записи источника и отдельные страницы проектов, и этот список считает позиции.",
    cblp_position: "Зафиксированная позиция: {position}",
    cblp_recorded_on: "Голосование {date}",
    cblp_tally_lead: "Зафиксированный подсчёт по рекомендации:",
    cblp_tally_for: "за — {count}",
    cblp_tally_against: "против — {count}",
    cblp_tally_abstain: "воздержались — {count}",
    cblp_tally_absent: "Источник не фиксирует подсчёт голосов для этой позиции.",
    cblp_waiver: "Отказ от рекомендации завершает этап рассмотрения этим советом без благоприятной или неблагоприятной позиции. Это не поддержка и не возражение.",
    cblp_project_status: "Зафиксированный статус проекта: {status}",
    cblp_project_status_absent: "Источник не фиксирует статус этого проекта.",
    cblp_inspect: "Посмотреть",
    cblp_inspect_label: "Посмотреть позицию, зафиксированную по проекту {title}",
    cblp_close: "Закрыть",
    cblp_dialog_kicker: "Зафиксированная позиция",
    cblp_open_project: "Открыть этот проект",
    cblp_portal_link: "Открыть опубликованную запись о проекте",
    cblp_other_heading: "Также зафиксировано по этой заявке",
    cblp_other_undated: "Источник не фиксирует дату голосования для этой позиции.",
    cblp_other_none: "Источник не фиксирует позицию какого-либо другого органа по этой заявке.",
    cblp_record_id: "Запись источника: {id}",
    cblp_source: "Источник: {publisher}. Проверено {date}.",
    cblp_source_undated: "Источник: {publisher}.",
    cblp_source_link: "Открыть опубликованный источник проектов",
    cblp_overflow_one: "Показать ещё одну зафиксированную позицию",
    cblp_overflow: "Показать остальные зафиксированные позиции: {count}",
    cblp_overflow_close: "Показать меньше зафиксированных позиций",
    cblp_empty_one: "Этот источник не фиксирует ни одной позиции, поданной этим советом по единственному проекту землепользования, который этот сайт из него сохраняет. Это содержимое источника, а не свидетельство того, что совет никогда не голосовал по заявке.",
    cblp_empty: "Этот источник не фиксирует ни одной позиции, поданной этим советом по проектам землепользования, которые этот сайт из него сохраняет ({count}). Это содержимое источника, а не свидетельство того, что совет никогда не голосовал по заявке.",
    cblp_unavailable: "Зафиксированные позиции этого совета не удалось загрузить, поэтому они здесь не показаны. Это сбой чтения, а не совет без зафиксированных позиций.",
    cblp_unavailable_retry: "Перезагрузите страницу, чтобы повторить попытку, или посмотрите проекты в опубликованном источнике.",
  },
  bn: {
    cblp_heading: "এই বোর্ড ভূমি ব্যবহার প্রকল্পে যে অবস্থান নথিভুক্ত করেছে",
    cblp_lede_one: "শহরের জোনিং আবেদন নথিতে এই বোর্ডের জমা দেওয়া একটি তারিখযুক্ত অবস্থান একটি ভূমি ব্যবহার প্রকল্পে রয়েছে।",
    cblp_lede: "শহরের জোনিং আবেদন নথিতে এই বোর্ডের জমা দেওয়া {count}টি তারিখযুক্ত অবস্থান রয়েছে, {projects}টি ভূমি ব্যবহার প্রকল্পে।",
    cblp_advisory: "ভূমি ব্যবহারের আবেদনে কমিউনিটি বোর্ডের অবস্থান পরামর্শমূলক। বোর্ড প্রকাশ্য শুনানি করে এবং একটি সুপারিশে ভোট দেয়; সিদ্ধান্ত নেয় সিটি প্ল্যানিং কমিশন এবং, পর্যালোচনা সেখানে পৌঁছালে, সিটি কাউন্সিল।",
    cblp_tally_boundary: "নথিভুক্ত ভোটসংখ্যা বোর্ডের সুপারিশ প্রস্তাবের উপর ভোট। এটি উন্নয়নের পক্ষে বা বিপক্ষে সদস্যদের গণনা নয়।",
    cblp_row_boundary: "প্রতিটি সারি একটি আবেদনের উপর একটি অবস্থান। একই দিনে নথিভুক্ত আবেদনগুলি আলাদা সারি, আলাদা উৎস নথি ও আলাদা প্রকল্প পাতা ধরে রাখে, এবং এই তালিকা অবস্থান গোনে।",
    cblp_position: "নথিভুক্ত অবস্থান: {position}",
    cblp_recorded_on: "ভোট হয়েছে {date}",
    cblp_tally_lead: "সুপারিশে নথিভুক্ত ভোটসংখ্যা:",
    cblp_tally_for: "পক্ষে {count}",
    cblp_tally_against: "বিপক্ষে {count}",
    cblp_tally_abstain: "ভোটদানে বিরত {count}",
    cblp_tally_absent: "উৎসে এই অবস্থানের কোনো ভোটসংখ্যা নথিভুক্ত নেই।",
    cblp_waiver: "সুপারিশ থেকে অব্যাহতি নিলে এই বোর্ডের পর্যালোচনা ধাপ অনুকূল বা প্রতিকূল অবস্থান ছাড়াই শেষ হয়। এটি সমর্থনও নয়, বিরোধিতাও নয়।",
    cblp_project_status: "নথিভুক্ত প্রকল্প অবস্থা: {status}",
    cblp_project_status_absent: "উৎসে এই প্রকল্পের কোনো অবস্থা নথিভুক্ত নেই।",
    cblp_inspect: "বিস্তারিত দেখুন",
    cblp_inspect_label: "{title}-এ নথিভুক্ত অবস্থান দেখুন",
    cblp_close: "বন্ধ করুন",
    cblp_dialog_kicker: "নথিভুক্ত অবস্থান",
    cblp_open_project: "এই প্রকল্প খুলুন",
    cblp_portal_link: "প্রকাশিত প্রকল্প নথি খুলুন",
    cblp_other_heading: "এই আবেদনে আরও যা নথিভুক্ত",
    cblp_other_undated: "উৎসে এই অবস্থানের কোনো ভোটের তারিখ নথিভুক্ত নেই।",
    cblp_other_none: "উৎসে এই আবেদনে অন্য কোনো সংস্থার অবস্থান নথিভুক্ত নেই।",
    cblp_record_id: "উৎস নথি: {id}",
    cblp_source: "উৎস: {publisher}। দেখা হয়েছে {date}।",
    cblp_source_undated: "উৎস: {publisher}।",
    cblp_source_link: "প্রকাশিত প্রকল্প উৎস খুলুন",
    cblp_overflow_one: "আরও ১টি নথিভুক্ত অবস্থান দেখুন",
    cblp_overflow: "আরও {count}টি নথিভুক্ত অবস্থান দেখুন",
    cblp_overflow_close: "কম নথিভুক্ত অবস্থান দেখান",
    cblp_empty_one: "এই সাইট এই উৎস থেকে যে ১টি ভূমি ব্যবহার প্রকল্প রাখে, তাতে এই বোর্ডের জমা দেওয়া কোনো অবস্থান এই উৎসে নথিভুক্ত নেই। এটি উৎসে যা আছে তা-ই; এই বোর্ড কখনো কোনো আবেদনে ভোট দেয়নি, এমন নথি নয়।",
    cblp_empty: "এই সাইট এই উৎস থেকে যে {count}টি ভূমি ব্যবহার প্রকল্প রাখে, তাতে এই বোর্ডের জমা দেওয়া কোনো অবস্থান এই উৎসে নথিভুক্ত নেই। এটি উৎসে যা আছে তা-ই; এই বোর্ড কখনো কোনো আবেদনে ভোট দেয়নি, এমন নথি নয়।",
    cblp_unavailable: "এই বোর্ডের নথিভুক্ত অবস্থানগুলি লোড করা যায়নি, তাই এখানে কিছু দেখানো হয়নি। এটি পড়তে ব্যর্থতা, নথিভুক্ত অবস্থানহীন বোর্ড নয়।",
    cblp_unavailable_retry: "আবার চেষ্টা করতে এই পাতাটি রিলোড করুন, অথবা প্রকাশিত উৎসে প্রকল্পগুলি দেখুন।",
  },
  ht: {
    cblp_heading: "Pozisyon konsèy sa a anrejistre sou pwojè itilizasyon tè",
    cblp_lede_one: "Dosye demann zonaj vil la gen yon pozisyon ak dat konsèy sa a te soumèt sou yon pwojè itilizasyon tè.",
    cblp_lede: "Dosye demann zonaj vil la gen {count} pozisyon ak dat konsèy sa a te soumèt, sou {projects} pwojè itilizasyon tè.",
    cblp_advisory: "Pozisyon yon konsèy kominotè sou yon demann itilizasyon tè se yon konsèy. Konsèy la fè yon odyans piblik epi li vote sou yon rekòmandasyon; se Komisyon Planifikasyon Vil la, ak Konsèy Minisipal la lè revizyon an rive la, ki deside.",
    cblp_tally_boundary: "Kontaj ki anrejistre a se vòt la sou mosyon rekòmandasyon konsèy la. Se pa yon kontaj manm ki pou oswa kont devlopman an.",
    cblp_row_boundary: "Chak liy se yon pozisyon sou yon demann. Demann ki anrejistre menm jou a kenbe liy separe, dosye sous separe ak paj pwojè separe, epi lis sa a konte pozisyon.",
    cblp_position: "Pozisyon anrejistre: {position}",
    cblp_recorded_on: "Vote {date}",
    cblp_tally_lead: "Kontaj anrejistre sou rekòmandasyon an:",
    cblp_tally_for: "{count} pou",
    cblp_tally_against: "{count} kont",
    cblp_tally_abstain: "{count} absten",
    cblp_tally_absent: "Sous la pa anrejistre okenn kontaj vòt pou pozisyon sa a.",
    cblp_waiver: "Lè yon konsèy renonse ak rekòmandasyon li, sa fini etap revizyon li san yon pozisyon favorab oswa defavorab. Se pa sipò e se pa opozisyon.",
    cblp_project_status: "Eta pwojè anrejistre: {status}",
    cblp_project_status_absent: "Sous la pa anrejistre okenn eta pou pwojè sa a.",
    cblp_inspect: "Egzamine",
    cblp_inspect_label: "Egzamine pozisyon ki anrejistre sou {title}",
    cblp_close: "Fèmen",
    cblp_dialog_kicker: "Pozisyon anrejistre",
    cblp_open_project: "Louvri pwojè sa a",
    cblp_portal_link: "Louvri dosye pwojè a ki pibliye",
    cblp_other_heading: "Anrejistre tou sou demann sa a",
    cblp_other_undated: "Sous la pa anrejistre okenn dat vòt pou pozisyon sa a.",
    cblp_other_none: "Sous la pa anrejistre pozisyon okenn lòt enstitisyon sou demann sa a.",
    cblp_record_id: "Dosye sous: {id}",
    cblp_source: "Sous: {publisher}. Gade {date}.",
    cblp_source_undated: "Sous: {publisher}.",
    cblp_source_link: "Louvri sous pwojè pibliye a",
    cblp_overflow_one: "Montre lòt pozisyon anrejistre a",
    cblp_overflow: "Montre lòt {count} pozisyon anrejistre yo",
    cblp_overflow_close: "Montre mwens pozisyon anrejistre",
    cblp_empty_one: "Sous sa a pa anrejistre okenn pozisyon konsèy sa a te soumèt sou sèl pwojè itilizasyon tè sit sa a kenbe nan li. Se sa sous la gen; se pa yon dosye ki di konsèy sa a pa janm vote sou yon demann.",
    cblp_empty: "Sous sa a pa anrejistre okenn pozisyon konsèy sa a te soumèt sou {count} pwojè itilizasyon tè sit sa a kenbe nan li. Se sa sous la gen; se pa yon dosye ki di konsèy sa a pa janm vote sou yon demann.",
    cblp_unavailable: "Nou pa t kapab chaje pozisyon anrejistre konsèy sa a, kidonk nou pa montre okenn isit la. Se yon echèk pou li yo, se pa yon konsèy ki pa gen pozisyon anrejistre.",
    cblp_unavailable_retry: "Rechaje paj sa a pou eseye ankò, oswa li pwojè yo nan sous pibliye a.",
  },
  ko: {
    cblp_heading: "이 보드가 토지 이용 프로젝트에 기록한 입장",
    cblp_lede_one: "시 조닝 신청 기록에는 이 보드가 토지 이용 프로젝트에 제출한 날짜가 있는 입장 1건이 있습니다.",
    cblp_lede: "시 조닝 신청 기록에는 이 보드가 제출한 날짜가 있는 입장 {count}건이 토지 이용 프로젝트 {projects}건에 대해 있습니다.",
    cblp_advisory: "토지 이용 신청에 대한 커뮤니티 보드의 입장은 자문입니다. 보드는 공청회를 열고 권고안을 표결하며, 결정하는 기관은 도시계획위원회와, 심사가 그곳까지 이르는 경우 시의회입니다.",
    cblp_tally_boundary: "기록된 표결 수는 보드의 권고 동의안에 대한 표결입니다. 개발에 찬성하거나 반대하는 위원 수가 아닙니다.",
    cblp_row_boundary: "각 행은 하나의 신청에 대한 하나의 입장입니다. 같은 날 기록된 신청은 각각 별도의 행, 별도의 출처 기록, 별도의 프로젝트 페이지를 유지하며, 이 목록은 입장을 셉니다.",
    cblp_position: "기록된 입장: {position}",
    cblp_recorded_on: "표결일 {date}",
    cblp_tally_lead: "권고안에 기록된 표결 수:",
    cblp_tally_for: "찬성 {count}",
    cblp_tally_against: "반대 {count}",
    cblp_tally_abstain: "기권 {count}",
    cblp_tally_absent: "출처에 이 입장의 표결 수가 기록되어 있지 않습니다.",
    cblp_waiver: "권고를 유보하면 이 보드의 심사 단계는 찬성도 반대도 아닌 상태로 종료됩니다. 지지도 아니고 반대도 아닙니다.",
    cblp_project_status: "기록된 프로젝트 상태: {status}",
    cblp_project_status_absent: "출처에 이 프로젝트의 상태가 기록되어 있지 않습니다.",
    cblp_inspect: "자세히 보기",
    cblp_inspect_label: "{title}에 기록된 입장 자세히 보기",
    cblp_close: "닫기",
    cblp_dialog_kicker: "기록된 입장",
    cblp_open_project: "이 프로젝트 열기",
    cblp_portal_link: "공개된 프로젝트 기록 열기",
    cblp_other_heading: "이 신청에 함께 기록된 입장",
    cblp_other_undated: "출처에 이 입장의 표결일이 기록되어 있지 않습니다.",
    cblp_other_none: "출처에 이 신청에 대한 다른 기관의 입장이 기록되어 있지 않습니다.",
    cblp_record_id: "출처 기록: {id}",
    cblp_source: "출처: {publisher}. 확인일 {date}.",
    cblp_source_undated: "출처: {publisher}.",
    cblp_source_link: "공개된 프로젝트 출처 열기",
    cblp_overflow_one: "기록된 다른 입장 1건 보기",
    cblp_overflow: "기록된 다른 입장 {count}건 보기",
    cblp_overflow_close: "기록된 입장 적게 보기",
    cblp_empty_one: "이 출처에는 이 사이트가 이 출처에서 보유한 토지 이용 프로젝트 1건에 대해 이 보드가 제출한 입장이 기록되어 있지 않습니다. 이는 출처가 담고 있는 내용일 뿐이며, 이 보드가 신청에 표결한 적이 없다는 기록은 아닙니다.",
    cblp_empty: "이 출처에는 이 사이트가 이 출처에서 보유한 토지 이용 프로젝트 {count}건에 대해 이 보드가 제출한 입장이 기록되어 있지 않습니다. 이는 출처가 담고 있는 내용일 뿐이며, 이 보드가 신청에 표결한 적이 없다는 기록은 아닙니다.",
    cblp_unavailable: "이 보드의 기록된 입장을 불러오지 못해 아무것도 표시하지 않았습니다. 읽지 못한 것이며, 기록된 입장이 없는 보드라는 뜻이 아닙니다.",
    cblp_unavailable_retry: "이 페이지를 다시 불러오거나, 공개된 출처에서 프로젝트를 확인하세요.",
  },
  fr: {
    cblp_heading: "Positions que ce conseil a consignées sur des projets d'aménagement",
    cblp_lede_one: "Les dossiers municipaux de demandes de zonage contiennent une position datée que ce conseil a soumise sur un projet d'aménagement.",
    cblp_lede: "Les dossiers municipaux de demandes de zonage contiennent {count} positions datées soumises par ce conseil, sur {projects} projets d'aménagement.",
    cblp_advisory: "La position d'un conseil de quartier sur une demande d'aménagement est consultative. Le conseil tient une audience publique et vote une recommandation ; ce sont la Commission d'urbanisme et, lorsque l'examen y parvient, le Conseil municipal qui décident.",
    cblp_tally_boundary: "Le décompte consigné est le vote sur la motion de recommandation du conseil. Ce n'est pas un décompte des membres favorables ou défavorables au projet immobilier.",
    cblp_row_boundary: "Chaque ligne est une position sur une demande. Les demandes consignées le même jour conservent des lignes distinctes, des enregistrements source distincts et des pages de projet distinctes, et cette liste compte des positions.",
    cblp_position: "Position consignée : {position}",
    cblp_recorded_on: "Votée le {date}",
    cblp_tally_lead: "Décompte consigné sur la recommandation :",
    cblp_tally_for: "{count} pour",
    cblp_tally_against: "{count} contre",
    cblp_tally_abstain: "{count} abstention(s)",
    cblp_tally_absent: "La source ne consigne aucun décompte des voix pour cette position.",
    cblp_waiver: "Renoncer à la recommandation clôt l'étape d'examen de ce conseil sans position favorable ni défavorable. Ce n'est ni un soutien ni une opposition.",
    cblp_project_status: "Statut consigné du projet : {status}",
    cblp_project_status_absent: "La source ne consigne aucun statut pour ce projet.",
    cblp_inspect: "Examiner",
    cblp_inspect_label: "Examiner la position consignée sur {title}",
    cblp_close: "Fermer",
    cblp_dialog_kicker: "Position consignée",
    cblp_open_project: "Ouvrir ce projet",
    cblp_portal_link: "Ouvrir le dossier publié du projet",
    cblp_other_heading: "Également consigné sur cette demande",
    cblp_other_undated: "La source ne consigne aucune date de vote pour cette position.",
    cblp_other_none: "La source ne consigne la position d'aucun autre organe sur cette demande.",
    cblp_record_id: "Enregistrement source : {id}",
    cblp_source: "Source : {publisher}. Consultée le {date}.",
    cblp_source_undated: "Source : {publisher}.",
    cblp_source_link: "Ouvrir la source publiée des projets",
    cblp_overflow_one: "Afficher l'autre position consignée",
    cblp_overflow: "Afficher les {count} autres positions consignées",
    cblp_overflow_close: "Afficher moins de positions consignées",
    cblp_empty_one: "Cette source ne consigne aucune position soumise par ce conseil sur l'unique projet d'aménagement que ce site en conserve. C'est ce que contient la source ; ce n'est pas la preuve que ce conseil n'a jamais voté sur une demande.",
    cblp_empty: "Cette source ne consigne aucune position soumise par ce conseil sur les {count} projets d'aménagement que ce site en conserve. C'est ce que contient la source ; ce n'est pas la preuve que ce conseil n'a jamais voté sur une demande.",
    cblp_unavailable: "Les positions consignées de ce conseil n'ont pas pu être chargées ; aucune n'est donc affichée ici. C'est un échec de lecture, et non un conseil sans position consignée.",
    cblp_unavailable_retry: "Rechargez cette page pour réessayer, ou consultez les projets à la source publiée.",
  },
  pl: {
    cblp_heading: "Stanowiska, które ta rada odnotowała wobec projektów zagospodarowania terenu",
    cblp_lede_one: "Miejskie rejestry wniosków planistycznych zawierają jedno datowane stanowisko złożone przez tę radę wobec projektu zagospodarowania terenu.",
    cblp_lede: "Miejskie rejestry wniosków planistycznych zawierają datowane stanowiska złożone przez tę radę w liczbie {count}, wobec projektów zagospodarowania terenu w liczbie {projects}.",
    cblp_advisory: "Stanowisko rady osiedla wobec wniosku planistycznego ma charakter doradczy. Rada przeprowadza wysłuchanie publiczne i głosuje nad rekomendacją; decydują Komisja Planowania Miasta oraz, gdy postępowanie do niej dotrze, Rada Miasta.",
    cblp_tally_boundary: "Odnotowany wynik głosowania dotyczy wniosku rady o rekomendację. Nie jest to liczba członków popierających inwestycję lub jej przeciwnych.",
    cblp_row_boundary: "Każdy wiersz to jedno stanowisko wobec jednego wniosku. Wnioski odnotowane tego samego dnia zachowują osobne wiersze, osobne rekordy źródłowe i osobne strony projektów, a ta lista liczy stanowiska.",
    cblp_position: "Odnotowane stanowisko: {position}",
    cblp_recorded_on: "Głosowano {date}",
    cblp_tally_lead: "Odnotowany wynik głosowania nad rekomendacją:",
    cblp_tally_for: "za: {count}",
    cblp_tally_against: "przeciw: {count}",
    cblp_tally_abstain: "wstrzymało się: {count}",
    cblp_tally_absent: "Źródło nie odnotowuje wyniku głosowania dla tego stanowiska.",
    cblp_waiver: "Odstąpienie od rekomendacji kończy etap opiniowania przez tę radę bez stanowiska pozytywnego ani negatywnego. To nie jest poparcie ani sprzeciw.",
    cblp_project_status: "Odnotowany status projektu: {status}",
    cblp_project_status_absent: "Źródło nie odnotowuje statusu tego projektu.",
    cblp_inspect: "Zobacz szczegóły",
    cblp_inspect_label: "Zobacz stanowisko odnotowane wobec: {title}",
    cblp_close: "Zamknij",
    cblp_dialog_kicker: "Odnotowane stanowisko",
    cblp_open_project: "Otwórz ten projekt",
    cblp_portal_link: "Otwórz opublikowany rekord projektu",
    cblp_other_heading: "Odnotowane także wobec tego wniosku",
    cblp_other_undated: "Źródło nie odnotowuje daty głosowania dla tego stanowiska.",
    cblp_other_none: "Źródło nie odnotowuje stanowiska żadnego innego organu wobec tego wniosku.",
    cblp_record_id: "Rekord źródłowy: {id}",
    cblp_source: "Źródło: {publisher}. Sprawdzono {date}.",
    cblp_source_undated: "Źródło: {publisher}.",
    cblp_source_link: "Otwórz opublikowane źródło projektów",
    cblp_overflow_one: "Pokaż jeszcze jedno odnotowane stanowisko",
    cblp_overflow: "Pokaż pozostałe odnotowane stanowiska: {count}",
    cblp_overflow_close: "Pokaż mniej odnotowanych stanowisk",
    cblp_empty_one: "To źródło nie odnotowuje żadnego stanowiska złożonego przez tę radę wobec jedynego projektu zagospodarowania terenu, który ta witryna z niego zachowuje. Tyle zawiera źródło; nie jest to zapis, że rada nigdy nie głosowała nad wnioskiem.",
    cblp_empty: "To źródło nie odnotowuje żadnego stanowiska złożonego przez tę radę wobec projektów zagospodarowania terenu, które ta witryna z niego zachowuje ({count}). Tyle zawiera źródło; nie jest to zapis, że rada nigdy nie głosowała nad wnioskiem.",
    cblp_unavailable: "Nie udało się wczytać odnotowanych stanowisk tej rady, więc żadne nie są tu pokazane. To błąd odczytu, a nie rada bez odnotowanych stanowisk.",
    cblp_unavailable_retry: "Odśwież tę stronę, aby spróbować ponownie, lub przeczytaj projekty w opublikowanym źródle.",
  },
  ar: {
    cblp_heading: "المواقف التي سجّلها هذا المجلس بشأن مشاريع استخدام الأراضي",
    cblp_lede_one: "تتضمّن سجلات طلبات تقسيم المناطق في المدينة موقفًا واحدًا مؤرَّخًا قدَّمه هذا المجلس بشأن مشروع لاستخدام الأراضي.",
    cblp_lede: "تتضمّن سجلات طلبات تقسيم المناطق في المدينة {count} من المواقف المؤرَّخة التي قدَّمها هذا المجلس، بشأن {projects} من مشاريع استخدام الأراضي.",
    cblp_advisory: "موقف المجلس المجتمعي من طلب استخدام الأراضي موقف استشاري. يعقد المجلس جلسة استماع علنية ويصوّت على توصية؛ أما الجهتان اللتان تقرّران فهما لجنة تخطيط المدينة، ومجلس المدينة عندما تصل المراجعة إليه.",
    cblp_tally_boundary: "عدد الأصوات المسجَّل هو التصويت على اقتراح توصية المجلس. وهو ليس عددًا للأعضاء المؤيدين للمشروع العمراني أو المعارضين له.",
    cblp_row_boundary: "كل صف هو موقف واحد من طلب واحد. الطلبات المسجَّلة في اليوم نفسه تحتفظ بصفوف منفصلة وسجلات مصدر منفصلة وصفحات مشاريع منفصلة، وهذه القائمة تعدّ المواقف.",
    cblp_position: "الموقف المسجَّل: {position}",
    cblp_recorded_on: "جرى التصويت في {date}",
    cblp_tally_lead: "عدد الأصوات المسجَّل على التوصية:",
    cblp_tally_for: "{count} مؤيد",
    cblp_tally_against: "{count} معارض",
    cblp_tally_abstain: "{count} ممتنع",
    cblp_tally_absent: "لا يسجّل المصدر أي عدد أصوات لهذا الموقف.",
    cblp_waiver: "التنازل عن التوصية ينهي خطوة المراجعة لدى هذا المجلس دون موقف مؤيِّد أو معارض. وهو ليس تأييدًا وليس معارضة.",
    cblp_project_status: "حالة المشروع المسجَّلة: {status}",
    cblp_project_status_absent: "لا يسجّل المصدر أي حالة لهذا المشروع.",
    cblp_inspect: "استعراض",
    cblp_inspect_label: "استعراض الموقف المسجَّل بشأن {title}",
    cblp_close: "إغلاق",
    cblp_dialog_kicker: "موقف مسجَّل",
    cblp_open_project: "افتح هذا المشروع",
    cblp_portal_link: "افتح سجل المشروع المنشور",
    cblp_other_heading: "مسجَّل أيضًا على هذا الطلب",
    cblp_other_undated: "لا يسجّل المصدر أي تاريخ تصويت لهذا الموقف.",
    cblp_other_none: "لا يسجّل المصدر موقف أي جهة أخرى بشأن هذا الطلب.",
    cblp_record_id: "سجل المصدر: {id}",
    cblp_source: "المصدر: {publisher}. جرى الاطلاع عليه في {date}.",
    cblp_source_undated: "المصدر: {publisher}.",
    cblp_source_link: "افتح مصدر المشاريع المنشور",
    cblp_overflow_one: "عرض الموقف المسجَّل الآخر",
    cblp_overflow: "عرض المواقف المسجَّلة الأخرى: {count}",
    cblp_overflow_close: "عرض عدد أقل من المواقف المسجَّلة",
    cblp_empty_one: "لا يسجّل هذا المصدر أي موقف قدَّمه هذا المجلس بشأن مشروع استخدام الأراضي الوحيد الذي يحتفظ به هذا الموقع منه. هذا ما يحتويه المصدر؛ وليس دليلًا على أن هذا المجلس لم يصوّت قط على طلب.",
    cblp_empty: "لا يسجّل هذا المصدر أي موقف قدَّمه هذا المجلس بشأن مشاريع استخدام الأراضي التي يحتفظ بها هذا الموقع منه وعددها {count}. هذا ما يحتويه المصدر؛ وليس دليلًا على أن هذا المجلس لم يصوّت قط على طلب.",
    cblp_unavailable: "تعذّر تحميل المواقف المسجَّلة لهذا المجلس، لذا لا يُعرض أي منها هنا. هذا إخفاق في قراءتها، وليس مجلسًا بلا مواقف مسجَّلة.",
    cblp_unavailable_retry: "أعد تحميل هذه الصفحة للمحاولة مرة أخرى، أو اطّلع على المشاريع في المصدر المنشور.",
  },
  ur: {
    cblp_heading: "اس بورڈ نے زمین کے استعمال کے منصوبوں پر جو مؤقف ریکارڈ کیا",
    cblp_lede_one: "شہر کے زوننگ درخواست ریکارڈ میں اس بورڈ کا زمین کے استعمال کے ایک منصوبے پر جمع کرایا گیا ایک تاریخ شدہ مؤقف موجود ہے۔",
    cblp_lede: "شہر کے زوننگ درخواست ریکارڈ میں اس بورڈ کے جمع کرائے گئے {count} تاریخ شدہ مؤقف موجود ہیں، جو {projects} منصوبوں سے متعلق ہیں۔",
    cblp_advisory: "زمین کے استعمال کی درخواست پر کمیونٹی بورڈ کا مؤقف مشاورتی ہوتا ہے۔ بورڈ عوامی سماعت کرتا ہے اور ایک سفارش پر ووٹ دیتا ہے؛ فیصلہ سٹی پلاننگ کمیشن اور، جہاں جائزہ وہاں تک پہنچے، سٹی کونسل کرتی ہے۔",
    cblp_tally_boundary: "ریکارڈ شدہ گنتی بورڈ کی سفارشی تحریک پر ووٹ ہے۔ یہ ترقیاتی منصوبے کے حق یا مخالفت میں اراکین کی گنتی نہیں۔",
    cblp_row_boundary: "ہر سطر ایک درخواست پر ایک مؤقف ہے۔ ایک ہی دن ریکارڈ ہونے والی درخواستیں الگ سطریں، الگ ماخذ ریکارڈ اور الگ منصوبہ صفحات برقرار رکھتی ہیں، اور یہ فہرست مؤقف گنتی ہے۔",
    cblp_position: "ریکارڈ شدہ مؤقف: {position}",
    cblp_recorded_on: "{date} کو ووٹ ہوا",
    cblp_tally_lead: "سفارش پر ریکارڈ شدہ گنتی:",
    cblp_tally_for: "حق میں {count}",
    cblp_tally_against: "مخالفت میں {count}",
    cblp_tally_abstain: "غیر حاضر رائے {count}",
    cblp_tally_absent: "ماخذ اس مؤقف کے لیے کوئی ووٹ گنتی ریکارڈ نہیں کرتا۔",
    cblp_waiver: "سفارش سے دستبرداری اس بورڈ کے جائزے کا مرحلہ حق یا مخالفت میں مؤقف کے بغیر ختم کر دیتی ہے۔ یہ نہ حمایت ہے نہ مخالفت۔",
    cblp_project_status: "ریکارڈ شدہ منصوبہ حیثیت: {status}",
    cblp_project_status_absent: "ماخذ اس منصوبے کی کوئی حیثیت ریکارڈ نہیں کرتا۔",
    cblp_inspect: "تفصیل دیکھیں",
    cblp_inspect_label: "{title} پر ریکارڈ شدہ مؤقف دیکھیں",
    cblp_close: "بند کریں",
    cblp_dialog_kicker: "ریکارڈ شدہ مؤقف",
    cblp_open_project: "یہ منصوبہ کھولیں",
    cblp_portal_link: "شائع شدہ منصوبہ ریکارڈ کھولیں",
    cblp_other_heading: "اس درخواست پر مزید ریکارڈ شدہ",
    cblp_other_undated: "ماخذ اس مؤقف کے لیے کوئی ووٹ کی تاریخ ریکارڈ نہیں کرتا۔",
    cblp_other_none: "ماخذ اس درخواست پر کسی اور ادارے کا مؤقف ریکارڈ نہیں کرتا۔",
    cblp_record_id: "ماخذ ریکارڈ: {id}",
    cblp_source: "ماخذ: {publisher}۔ {date} کو دیکھا گیا۔",
    cblp_source_undated: "ماخذ: {publisher}۔",
    cblp_source_link: "شائع شدہ منصوبہ ماخذ کھولیں",
    cblp_overflow_one: "ایک اور ریکارڈ شدہ مؤقف دکھائیں",
    cblp_overflow: "باقی {count} ریکارڈ شدہ مؤقف دکھائیں",
    cblp_overflow_close: "کم ریکارڈ شدہ مؤقف دکھائیں",
    cblp_empty_one: "یہ سائٹ اس ماخذ سے جو ایک منصوبہ رکھتی ہے، اس پر اس بورڈ کا جمع کرایا ہوا کوئی مؤقف اس ماخذ میں ریکارڈ نہیں۔ ماخذ میں یہی موجود ہے؛ یہ ریکارڈ نہیں کہ اس بورڈ نے کبھی کسی درخواست پر ووٹ نہیں دیا۔",
    cblp_empty: "یہ سائٹ اس ماخذ سے جو {count} منصوبے رکھتی ہے، ان پر اس بورڈ کا جمع کرایا ہوا کوئی مؤقف اس ماخذ میں ریکارڈ نہیں۔ ماخذ میں یہی موجود ہے؛ یہ ریکارڈ نہیں کہ اس بورڈ نے کبھی کسی درخواست پر ووٹ نہیں دیا۔",
    cblp_unavailable: "اس بورڈ کے ریکارڈ شدہ مؤقف لوڈ نہیں ہو سکے، اس لیے یہاں کوئی نہیں دکھایا گیا۔ یہ پڑھنے کی ناکامی ہے، ایسا بورڈ نہیں جس کا کوئی ریکارڈ شدہ مؤقف نہ ہو۔",
    cblp_unavailable_retry: "دوبارہ کوشش کے لیے یہ صفحہ ری لوڈ کریں، یا شائع شدہ ماخذ پر منصوبے پڑھیں۔",
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
 * the middle all render correctly and the publisher's own text keeps its bidi
 * isolation.
 */
const VALUE_SENTINEL = "\ue000";

function sentenceWithSourceValue(t, key, name, value) {
  return esc(t(key, { [name]: VALUE_SENTINEL })).replace(VALUE_SENTINEL, sourceText(value));
}

/**
 * The recorded tally as one sentence built from the components the source
 * actually recorded. A component the publisher left empty is absent from the
 * sentence rather than rendered as a zero.
 */
function tallySentence(tally, t, lang) {
  if (!tally?.recorded) return t("cblp_tally_absent");
  const parts = [];
  if (tally.votes_for !== null) parts.push(t("cblp_tally_for", { count: formatCount(tally.votes_for, lang) }));
  if (tally.votes_against !== null) parts.push(t("cblp_tally_against", { count: formatCount(tally.votes_against, lang) }));
  if (tally.votes_abstain !== null) parts.push(t("cblp_tally_abstain", { count: formatCount(tally.votes_abstain, lang) }));
  if (!parts.length) return t("cblp_tally_absent");
  return `${t("cblp_tally_lead")} ${parts.join(", ")}`;
}

function positionFacts(position, t, lang) {
  const facts = [];
  facts.push({
    className: "board-land-position-value",
    html: sentenceWithSourceValue(t, "cblp_position", "position", position.position),
    text: t("cblp_position", { position: position.position }),
  });
  const day = formatDay(position.recorded_on, lang);
  if (day) {
    facts.push({
      className: "board-land-position-date",
      html: esc(t("cblp_recorded_on", { date: day })),
      text: t("cblp_recorded_on", { date: day }),
    });
  }
  const tally = tallySentence(position.recorded_tally, t, lang);
  facts.push({ className: "board-land-position-tally", html: esc(tally), text: tally });
  return facts;
}

/**
 * The bounded fact set the inspect control carries.
 *
 * Every string is already rendered in the reader's language, so the browser
 * behaviour that paints it needs no translation table, no formatter and no
 * knowledge of this module's vocabulary — it paints text it is handed.
 */
export function communityBoardLandPositionPayload(position, t, lang) {
  const facts = positionFacts(position, t, lang).map((fact) => fact.text);
  facts.push(position.project_public_status
    ? t("cblp_project_status", { status: position.project_public_status })
    : t("cblp_project_status_absent"));
  const notes = [t("cblp_advisory"), t("cblp_tally_boundary")];
  if (position.position_class === "waiver") notes.unshift(t("cblp_waiver"));
  const others = position.other_positions.map((row) => ({
    term: row.representing,
    value: row.position,
    note: row.recorded_on ? t("cblp_recorded_on", { date: formatDay(row.recorded_on, lang) }) : t("cblp_other_undated"),
  }));
  return {
    v: COMMUNITY_BOARD_LAND_POSITION_PAYLOAD_VERSION,
    id: position.project_id,
    title: position.title,
    href: position.href,
    ...(position.portal_url ? { portal: position.portal_url } : {}),
    facts,
    notes,
    others,
    ...(others.length ? {} : { others_none: t("cblp_other_none") }),
    ...(position.source_record_id ? { record: t("cblp_record_id", { id: position.source_record_id }) } : {}),
  };
}

function positionMarkup(position, t, lang) {
  const facts = positionFacts(position, t, lang);
  const payload = JSON.stringify(communityBoardLandPositionPayload(position, t, lang));
  const inspectLabel = t("cblp_inspect_label", { title: position.title });
  const waiver = position.position_class === "waiver"
    ? `<span class="muted node-muted board-land-position-waiver">${esc(t("cblp_waiver"))}</span>`
    : "";
  return `<li class="node-record board-land-position" data-project-id="${esc(position.project_id)}"`
    + ` data-position-class="${esc(position.position_class)}" data-recorded-on="${esc(position.recorded_on)}">`
    + `<div class="node-record-main">`
    + `<a class="ui-constellation-link board-land-position-link" href="${esc(position.href)}">`
    + `<strong lang="en" dir="ltr">${esc(position.title)}</strong></a> `
    + `<span class="board-land-position-id" lang="en" dir="ltr">${esc(position.project_id)}</span>`
    + `<button class="board-land-position-inspect" type="button"`
    + ` ${COMMUNITY_BOARD_LAND_POSITIONS_ATTRIBUTE}="${esc(payload)}"`
    + ` data-board-land-position-id="${esc(position.project_id)}"`
    + ` aria-label="${esc(inspectLabel)}">${esc(t("cblp_inspect"))}</button>`
    + `</div>`
    + `<span class="muted node-muted">${facts.map((fact) => `<span class="${fact.className}">${fact.html}</span>`).join(" · ")}</span>`
    + waiver
    + `</li>`;
}

function sourceMarkup(view, t, lang) {
  const parts = [];
  if (view.source?.publisher) {
    const observed = formatDay(String(view.source.observed_on || "").slice(0, 10), lang);
    parts.push(observed
      ? esc(t("cblp_source", { publisher: VALUE_SENTINEL, date: observed })).replace(VALUE_SENTINEL, sourceText(view.source.publisher))
      : sentenceWithSourceValue(t, "cblp_source_undated", "publisher", view.source.publisher));
  }
  if (view.source?.source_url) {
    parts.push(`<a class="ui-constellation-link board-land-position-source" href="${esc(view.source.source_url)}">${esc(t("cblp_source_link"))}</a>`);
  }
  if (!parts.length) return "";
  return `<p class="muted node-muted board-land-positions-source">${parts.join(" ")}</p>`;
}

function sectionAttrs(view, langAttrs, extra = {}) {
  return {
    id: COMMUNITY_BOARD_LAND_POSITIONS_ANCHOR,
    "data-community-board-land-positions": "1",
    "data-land-positions-state": view.state,
    ...extra,
    ...langAttrs,
  };
}

/**
 * The section markup, or "" when there is no board to render.
 *
 * Every destination is a plain anchor to the site's canonical project route, so
 * a modified click, a middle click and the browser's own history behave the way
 * they do anywhere else. The inspect control is a native button beside that
 * anchor, never inside it, and it is hidden until the boot module marks the
 * section ready.
 */
export function renderCommunityBoardLandPositionsSection(view, options = {}) {
  if (!view || view.schema !== COMMUNITY_BOARD_LAND_POSITIONS_VIEW_SCHEMA) return "";
  const lang = STRINGS[options.lang] ? options.lang : "en";
  const t = localizedT(lang);
  const langAttrs = lang === "en" ? {} : { lang, dir: RTL_LANGS.has(lang) ? "rtl" : "ltr" };
  const heading = t("cblp_heading");
  const headingId = `${COMMUNITY_BOARD_LAND_POSITIONS_ANCHOR}-heading`;
  const common = {
    heading,
    headingId,
    exportClass: "object_land_positions",
    extraClass: "node-card civic-object-section board-land-positions",
  };

  if (view.state === COMMUNITY_BOARD_LAND_POSITION_STATES.UNAVAILABLE) {
    return renderNodeSection({
      ...common,
      attrs: sectionAttrs(view, langAttrs),
      body: `<p class="node-lede">${esc(t("cblp_unavailable"))}</p>`
        + `<p class="muted node-muted">${esc(t("cblp_unavailable_retry"))}</p>`
        + sourceMarkup(view, t, lang),
    });
  }

  if (view.state === COMMUNITY_BOARD_LAND_POSITION_STATES.NONE_RECORDED) {
    const empty = view.retained_project_count === 1
      ? t("cblp_empty_one")
      : t("cblp_empty", { count: formatCount(view.retained_project_count, lang) });
    return renderNodeSection({
      ...common,
      attrs: sectionAttrs(view, langAttrs, { "data-retained-project-count": String(view.retained_project_count) }),
      body: `<p class="node-lede">${esc(empty)}</p>`
        + `<p class="muted node-muted board-land-positions-advisory">${esc(t("cblp_advisory"))}</p>`
        + sourceMarkup(view, t, lang),
    });
  }

  const visible = view.positions.slice(0, view.visible_count);
  const overflow = view.positions.slice(view.visible_count);
  const lede = view.position_count === 1
    ? t("cblp_lede_one")
    : t("cblp_lede", {
      count: formatCount(view.position_count, lang),
      projects: formatCount(view.project_count, lang),
    });
  const overflowLabel = overflow.length === 1
    ? t("cblp_overflow_one")
    : t("cblp_overflow", { count: formatCount(overflow.length, lang) });
  const overflowMarkup = overflow.length
    ? `<div class="board-land-positions-overflow" id="${COMMUNITY_BOARD_LAND_POSITIONS_OVERFLOW_ANCHOR}" data-land-positions-overflow="${esc(String(overflow.length))}">`
      + `<a class="ui-constellation-link board-land-positions-more" href="#${COMMUNITY_BOARD_LAND_POSITIONS_OVERFLOW_ANCHOR}">${esc(overflowLabel)}</a>`
      + `<ul class="node-record-list board-land-positions-list board-land-positions-overflow-list">${overflow.map((row) => positionMarkup(row, t, lang)).join("")}</ul>`
      + `<a class="ui-constellation-link board-land-positions-less" href="#${COMMUNITY_BOARD_LAND_POSITIONS_ANCHOR}">${esc(t("cblp_overflow_close"))}</a>`
      + `</div>`
    : "";
  // The row boundary is stated only where it can actually be misread: when the
  // board carries more recorded positions than the dates they were recorded on.
  const rowBoundary = view.position_count > view.recorded_date_count
    ? `<p class="muted node-muted board-land-positions-row-boundary">${esc(t("cblp_row_boundary"))}</p>`
    : "";
  const labels = JSON.stringify({
    close: t("cblp_close"),
    kicker: t("cblp_dialog_kicker"),
    open: t("cblp_open_project"),
    portal: t("cblp_portal_link"),
    others: t("cblp_other_heading"),
  });

  return renderNodeSection({
    ...common,
    attrs: sectionAttrs(view, langAttrs, {
      "data-position-count": String(view.position_count),
      "data-project-count": String(view.project_count),
      "data-recorded-date-count": String(view.recorded_date_count),
      [COMMUNITY_BOARD_LAND_POSITIONS_LABELS_ATTRIBUTE]: labels,
    }),
    body: `<p class="node-lede">${esc(lede)}</p>`
      + `<p class="muted node-muted board-land-positions-advisory">${esc(t("cblp_advisory"))}</p>`
      + `<p class="muted node-muted board-land-positions-tally-boundary">${esc(t("cblp_tally_boundary"))}</p>`
      + rowBoundary
      + `<ul class="node-record-list board-land-positions-list">${visible.map((row) => positionMarkup(row, t, lang)).join("")}</ul>`
      + overflowMarkup
      + sourceMarkup(view, t, lang),
  });
}

export { STRINGS as COMMUNITY_BOARD_LAND_POSITION_STRINGS };
