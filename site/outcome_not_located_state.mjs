/**
 * PHC-07 — renders an outcome this product could not locate as its own visible
 * state, distinct both from an outcome recorded as no action taken and from a
 * matched decision.
 *
 * The problem this exists to solve: for non-Council proceedings the committed
 * lookup (site/data/non_council_outcome_lookup.json) currently matches no
 * notices at all, so site/non_council_outcome_panel.mjs renders nothing. An
 * empty rendering of a promised field is indistinguishable from a real
 * negative, which makes "we have not found this" read as "the body did
 * nothing" — the most misleading available reading of missing data.
 *
 * Three states, each with its own markup, heading and copy:
 *  - `matched_decision`   — the receipt-backed exact source join AND an explicit
 *                           approved/rejected/held disposition. Delegates to the
 *                           existing decision panel; this module adds no join
 *                           logic of its own and cannot widen that gate.
 *  - `recorded_no_action` — the same exact source join AND an explicit
 *                           `no_action` disposition. A real, sourced negative.
 *  - `not_located`        — everything else. Says so, and offers the one
 *                           follow-up the product can actually deliver.
 *
 * Two boundaries are load-bearing:
 *
 * A minutes link is not a disposition. When the source join holds but records
 * no explicit disposition, the minutes stay readable and the state stays
 * `not_located` — reading material, never a decision.
 *
 * Publication age is not evidence of a hearing. A record whose date is missing
 * never advances to `held` because its notice is old; `held` is a disposition
 * this product reads from a source, never one it derives from the calendar.
 */

import { officialSourceLink } from "./affordance_grammar.mjs";
import { communityBoardPageHref, resolvedCommunityBoardId } from "./community_board_links.mjs";
import { BP_LINKS } from "./non_council_hearing_spine.mjs";
import {
  NON_COUNCIL_DECISION_ACTIONS,
  buildOfficialBoardMeetingJoin,
  gateNonCouncilOutcomeRow,
  loadNonCouncilOutcomeLookup,
  nonCouncilOutcomePanelHTML,
} from "./non_council_outcome_panel.mjs";

export const OUTCOME_STATE_SCHEMA = "cityscroll.outcome_not_located_state.v1";

/** The three states a non-Council outcome can be in. There is no fourth. */
export const OUTCOME_STATES = Object.freeze({
  MATCHED_DECISION: "matched_decision",
  RECORDED_NO_ACTION: "recorded_no_action",
  NOT_LOCATED: "not_located",
});

/** The one explicit disposition that means the body took no action. */
export const NO_ACTION_DISPOSITION = "no_action";

const CITY_RECORD_SOURCE_LABEL = "published community board and borough president records, joined to City Record notices";

/**
 * What the notice itself proves about the hearing.
 *
 * `start_date` is read only to report when the notice was published. It is
 * deliberately not an input to any disposition: an old notice with no event
 * date proves that the notice is old, never that a hearing was held.
 */
export function hearingEvidenceFromNotice(notice = {}) {
  return Object.freeze({
    hearing_date: isoDate(notice?.event_date),
    published_on: isoDate(notice?.start_date),
    // No disposition is ever derived here. `held` arrives from a source or not at all.
    derived_disposition: null,
  });
}

/**
 * The one follow-up path this product can actually deliver for an unmatched
 * record: the community board's own page, or the borough president's official
 * site. A record that resolves to neither gets no follow action at all rather
 * than a generic directory standing in for a body we could not name.
 */
export function bodyFollowUp(notice = {}) {
  const identity = [text(notice?.agency_name), text(notice?.short_title)];
  // A borough named anywhere in the record is a hint for board identity, not a
  // body in its own right: "Bronx Community Board 3" is a board, not the Bronx
  // Borough President.
  const boroughHint = text(notice?.borough)
    || boroughLabel(identity.join(" "))
    || null;
  const boardId = resolvedCommunityBoardId(
    notice?.body_id || notice?.community_board_id,
    { borough: boroughHint },
  ) || resolvedCommunityBoardId(identity, { borough: boroughHint });
  const boardHref = boardId ? communityBoardPageHref(boardId) : null;
  if (boardHref) {
    return Object.freeze({
      kind: "community_board",
      board_id: boardId,
      href: boardHref,
      external: false,
      borough: null,
    });
  }

  // A community-board record whose board could not be resolved gets no follow
  // action at all. Routing it to the borough president would send the reader to
  // a different body than the one that heard the matter.
  if (COMMUNITY_BOARD_SHAPED.test(identity.join(" "))) return null;

  const borough = BP_LINKS.find((row) => row.re.test(`${identity.join(" ")} ${text(notice?.borough)}`));
  if (borough) {
    return Object.freeze({
      kind: "borough",
      board_id: null,
      href: borough.url,
      external: true,
      borough: borough.label.replace(/\s+Borough President$/, ""),
    });
  }
  return null;
}

const COMMUNITY_BOARD_SHAPED = /\bcommunity\s+board\b|\bCB\s*\d{1,2}\b/i;

function boroughLabel(value) {
  const row = BP_LINKS.find((entry) => entry.re.test(text(value)));
  return row ? row.label.replace(/\s+Borough President$/, "") : null;
}

/**
 * Minutes that can be read but mint nothing. Returned only when the receipt-backed
 * source join itself holds; a bare URL on an unjoined row is not offered.
 */
function readableMinutes(payload, requestId) {
  const id = text(requestId);
  const row = id ? payload?.notices?.[id] : null;
  if (!row || text(row.request_id) !== id) return null;
  const joinView = buildOfficialBoardMeetingJoin({
    ...row,
    source_join: row.source_join || row.board_source_join,
  });
  return joinView
    ? Object.freeze({ label: joinView.label, url: joinView.source_url })
    : null;
}

/** Source and last-checked date for the method disclosure (A6). */
export function outcomeCoverageDisclosure(payload) {
  return Object.freeze({
    source: CITY_RECORD_SOURCE_LABEL,
    last_checked: isoDate(payload?.generated_at),
    scope: text(payload?.coverage?.scope) || null,
  });
}

/**
 * Classify one notice's outcome into exactly one of the three states.
 *
 * `matched_decision` and `recorded_no_action` both require the same gate the
 * decision panel uses — the exact source join plus an explicit disposition.
 * Everything short of that is `not_located`, which is a statement about this
 * product's coverage and never about what the body did.
 */
export function projectOutcomeState(payload, requestId, notice = {}) {
  const gated = gateNonCouncilOutcomeRow(payload, requestId);
  const disclosure = outcomeCoverageDisclosure(payload);
  const hearing = hearingEvidenceFromNotice(notice);
  const base = {
    schema: OUTCOME_STATE_SCHEMA,
    request_id: text(requestId) || null,
    disclosure,
    hearing,
  };

  if (gated && NON_COUNCIL_DECISION_ACTIONS.includes(gated.action)) {
    return Object.freeze({
      ...base,
      state: OUTCOME_STATES.MATCHED_DECISION,
      decision: gated,
      follow_up: null,
      readable_minutes: null,
    });
  }

  if (gated && gated.action === NO_ACTION_DISPOSITION) {
    return Object.freeze({
      ...base,
      state: OUTCOME_STATES.RECORDED_NO_ACTION,
      decision: null,
      follow_up: null,
      readable_minutes: Object.freeze({
        label: gated.meeting_label,
        url: gated.minutes_url,
      }),
      body_name: gated.body_name,
      board_id: gated.board_id,
      meeting_date: gated.meeting_date,
    });
  }

  // Everything else, including a join that held but recorded no explicit
  // disposition. The minutes stay readable; no decision is minted from them.
  return Object.freeze({
    ...base,
    state: OUTCOME_STATES.NOT_LOCATED,
    decision: null,
    follow_up: bodyFollowUp(notice),
    readable_minutes: gated
      ? Object.freeze({ label: gated.meeting_label, url: gated.minutes_url })
      : readableMinutes(payload, requestId),
  });
}

/**
 * Render whichever of the three states applies. A matched decision is handed
 * back to the existing panel unchanged, so all three states leave this one
 * function and are visibly distinguishable at their single mount point.
 */
export function renderOutcomeState(payload, requestId, notice = {}, opts = {}) {
  const view = projectOutcomeState(payload, requestId, notice);
  if (view.state === OUTCOME_STATES.MATCHED_DECISION) {
    return nonCouncilOutcomePanelHTML(payload, requestId, opts);
  }

  const t = localizedT(opts.lang);
  const esc = typeof opts.esc === "function" ? opts.esc : defaultEsc;
  const date = typeof opts.date === "function" ? opts.date : defaultDate;
  const isNoAction = view.state === OUTCOME_STATES.RECORDED_NO_ACTION;

  const heading = isNoAction ? t("onl_no_action_heading") : t("onl_not_located_heading");
  const body = isNoAction ? t("onl_no_action_body") : t("onl_not_located_body");

  const meetingRow = isNoAction && view.meeting_date
    ? `<div class="notice-fact-row" data-field="meeting-date">
        <div class="stage-name">${esc(t("onl_meeting_lbl"))}</div>
        <div><time datetime="${esc(view.meeting_date)}">${esc(date(view.meeting_date))}</time></div>
      </div>`
    : "";

  // A readable minutes link, never a decision. On the not-located state it is
  // labelled as reading material and explicitly says it records no disposition.
  const minutes = view.readable_minutes
    ? `<div class="notice-fact-row" data-field="readable-minutes" data-mints-decision="0">
        <div class="stage-name">${esc(t("onl_minutes_read_lbl"))}</div>
        <div>${officialSourceLink({
          href: view.readable_minutes.url,
          label: t("onl_minutes_read_link"),
          className: "view meeting-source-link",
          escape: esc,
        })}${isNoAction ? "" : `<p class="note">${esc(t("onl_minutes_no_disposition"))}</p>`}</div>
      </div>`
    : "";

  const followUp = view.follow_up
    ? `<div class="notice-fact-row" data-field="follow-body" data-follow-kind="${esc(view.follow_up.kind)}">
        <div class="stage-name">${esc(t("onl_follow_lbl"))}</div>
        <div><a class="view" href="${esc(view.follow_up.href)}"${view.follow_up.external ? ' rel="noopener noreferrer"' : ""}>${esc(
          view.follow_up.kind === "borough"
            ? t("onl_follow_borough", { borough: view.follow_up.borough })
            : t("onl_follow_board"),
        )}</a>
        <p class="note">${esc(t("onl_follow_note"))}</p></div>
      </div>`
    : "";

  const checked = view.disclosure.last_checked
    ? date(view.disclosure.last_checked)
    : t("onl_method_unchecked");

  return `<section class="notice-fact-detail outcome-state outcome-state--${esc(view.state)}" data-outcome-state="${esc(view.state)}" aria-label="${esc(heading)}">
    <div class="chain-h">${esc(heading)}</div>
    <div class="notice-fact-list">
      <article class="notice-fact-item">
        <p class="outcome-state-body">${esc(body)}</p>
        ${meetingRow}
        ${minutes}
        ${followUp}
      </article>
    </div>
    <details class="inline-disclose lc-how">
      <summary>${esc(t("onl_method_summary"))}</summary>
      <div class="inline-disclose-body">${esc(t("onl_method_body", {
        source: view.disclosure.source,
        checked,
      }))}</div>
    </details>
  </section>`;
}

/** Fetch the committed lookup once and render the applicable state. */
export async function loadOutcomeState(requestId, notice = {}, opts = {}) {
  return renderOutcomeState(await loadNonCouncilOutcomeLookup(), requestId, notice, opts);
}

function text(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function isoDate(value) {
  const date = text(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
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
    onl_not_located_heading: "Outcome not found",
    onl_not_located_body: "We could not find a published record of what this body decided. That is a gap in what has been collected, not evidence that the body took no action.",
    onl_no_action_heading: "Recorded: no action taken",
    onl_no_action_body: "The published record of this meeting states that the body took no action on this item.",
    onl_meeting_lbl: "Board meeting",
    onl_minutes_read_lbl: "Published minutes",
    onl_minutes_read_link: "Read the published minutes",
    onl_minutes_no_disposition: "These minutes can be read, but they record no decision on this item, so none is shown here.",
    onl_follow_lbl: "Next step",
    onl_follow_board: "Follow this community board",
    onl_follow_borough: "Follow the {borough} Borough President",
    onl_follow_note: "Following the body is what this product can offer here. It has no feed of this body's decisions.",
    onl_method_summary: "How this was checked",
    onl_method_body: "Source: {source}. Last checked {checked}.",
    onl_method_unchecked: "not recorded",
  },
  es: {
    onl_not_located_heading: "No se encontró el resultado", onl_not_located_body: "No pudimos encontrar un registro publicado de lo que decidió este organismo. Es una laguna en lo recopilado, no una prueba de que el organismo no actuara.", onl_no_action_heading: "Registrado: no se tomó ninguna medida", onl_no_action_body: "El acta publicada de esta reunión indica que el organismo no tomó ninguna medida sobre este asunto.", onl_meeting_lbl: "Reunión de la junta", onl_minutes_read_lbl: "Acta publicada", onl_minutes_read_link: "Leer el acta publicada", onl_minutes_no_disposition: "Esta acta se puede leer, pero no registra ninguna decisión sobre este asunto, así que no se muestra ninguna.", onl_follow_lbl: "Siguiente paso", onl_follow_board: "Seguir a esta junta comunitaria", onl_follow_borough: "Seguir al Presidente del Condado de {borough}", onl_follow_note: "Seguir al organismo es lo que este producto puede ofrecer aquí. No dispone de un canal de decisiones de este organismo.", onl_method_summary: "Cómo se comprobó", onl_method_body: "Fuente: {source}. Última comprobación: {checked}.", onl_method_unchecked: "no registrada",
  },
  "zh-Hans": {
    onl_not_located_heading: "未找到结果", onl_not_located_body: "我们未能找到该机构决定内容的公开记录。这是已收集资料的缺口，并非该机构未采取行动的证据。", onl_no_action_heading: "记录在案：未采取行动", onl_no_action_body: "本次会议的公开记录写明该机构未就此事项采取行动。", onl_meeting_lbl: "委员会会议", onl_minutes_read_lbl: "已公布会议记录", onl_minutes_read_link: "阅读已公布的会议记录", onl_minutes_no_disposition: "该会议记录可供阅读，但其中没有关于此事项的决定，因此这里不显示任何决定。", onl_follow_lbl: "下一步", onl_follow_board: "关注该社区委员会", onl_follow_borough: "关注{borough}区长", onl_follow_note: "关注该机构是本产品在此处能够提供的功能。本产品没有该机构的决定信息源。", onl_method_summary: "核查方式", onl_method_body: "来源：{source}。最近核查：{checked}。", onl_method_unchecked: "未记录",
  },
  ru: {
    onl_not_located_heading: "Решение не найдено", onl_not_located_body: "Нам не удалось найти опубликованную запись о том, что решил этот орган. Это пробел в собранных данных, а не доказательство того, что орган не действовал.", onl_no_action_heading: "Зафиксировано: мер не принято", onl_no_action_body: "В опубликованном протоколе этого заседания указано, что орган не принял мер по данному вопросу.", onl_meeting_lbl: "Заседание совета", onl_minutes_read_lbl: "Опубликованный протокол", onl_minutes_read_link: "Прочитать опубликованный протокол", onl_minutes_no_disposition: "Этот протокол можно прочитать, но в нём нет решения по данному вопросу, поэтому оно здесь не показано.", onl_follow_lbl: "Следующий шаг", onl_follow_board: "Следить за этим общественным советом", onl_follow_borough: "Следить за президентом района {borough}", onl_follow_note: "Следить за органом — это то, что продукт здесь может предложить. Ленты решений этого органа у него нет.", onl_method_summary: "Как это проверялось", onl_method_body: "Источник: {source}. Последняя проверка: {checked}.", onl_method_unchecked: "не зафиксирована",
  },
  bn: {
    onl_not_located_heading: "ফলাফল পাওয়া যায়নি", onl_not_located_body: "এই সংস্থাটি কী সিদ্ধান্ত নিয়েছে তার প্রকাশিত নথি আমরা খুঁজে পাইনি। এটি সংগৃহীত তথ্যের ঘাটতি, সংস্থাটি কোনো ব্যবস্থা নেয়নি তার প্রমাণ নয়।", onl_no_action_heading: "নথিভুক্ত: কোনো ব্যবস্থা নেওয়া হয়নি", onl_no_action_body: "এই সভার প্রকাশিত নথিতে বলা হয়েছে যে সংস্থাটি এই বিষয়ে কোনো ব্যবস্থা নেয়নি।", onl_meeting_lbl: "বোর্ড সভা", onl_minutes_read_lbl: "প্রকাশিত কার্যবিবরণী", onl_minutes_read_link: "প্রকাশিত কার্যবিবরণী পড়ুন", onl_minutes_no_disposition: "এই কার্যবিবরণী পড়া যায়, তবে এতে এই বিষয়ে কোনো সিদ্ধান্ত নেই, তাই এখানে কোনোটি দেখানো হয়নি।", onl_follow_lbl: "পরবর্তী পদক্ষেপ", onl_follow_board: "এই কমিউনিটি বোর্ড অনুসরণ করুন", onl_follow_borough: "{borough} বরো প্রেসিডেন্টকে অনুসরণ করুন", onl_follow_note: "সংস্থাটিকে অনুসরণ করাই এখানে এই পণ্যটি দিতে পারে। এই সংস্থার সিদ্ধান্তের কোনো ফিড এর নেই।", onl_method_summary: "কীভাবে যাচাই করা হয়েছে", onl_method_body: "উৎস: {source}। সর্বশেষ যাচাই: {checked}।", onl_method_unchecked: "নথিভুক্ত নয়",
  },
  ht: {
    onl_not_located_heading: "Nou pa jwenn rezilta a", onl_not_located_body: "Nou pa t kapab jwenn yon dosye pibliye sou sa enstitisyon sa a deside. Se yon twou nan sa ki ranmase, se pa yon prèv enstitisyon an pa t aji.", onl_no_action_heading: "Anrejistre: pa gen aksyon ki pran", onl_no_action_body: "Dosye pibliye reyinyon sa a di enstitisyon an pa t pran okenn aksyon sou dosye sa a.", onl_meeting_lbl: "Reyinyon konsèy la", onl_minutes_read_lbl: "Pwosè vèbal pibliye", onl_minutes_read_link: "Li pwosè vèbal pibliye a", onl_minutes_no_disposition: "Ou ka li pwosè vèbal sa a, men li pa anrejistre okenn desizyon sou dosye sa a, kidonk nou pa montre youn isit la.", onl_follow_lbl: "Pwochen etap", onl_follow_board: "Swiv konsèy kominotè sa a", onl_follow_borough: "Swiv Prezidan Bòwo {borough} an", onl_follow_note: "Swiv enstitisyon an se sa pwodwi sa a ka ofri isit la. Li pa gen okenn sous desizyon enstitisyon sa a.", onl_method_summary: "Kijan nou tcheke sa", onl_method_body: "Sous: {source}. Dènye tchèk: {checked}.", onl_method_unchecked: "pa anrejistre",
  },
  ko: {
    onl_not_located_heading: "결과를 찾지 못했습니다", onl_not_located_body: "이 기관이 무엇을 결정했는지에 대한 공개 기록을 찾지 못했습니다. 이는 수집된 자료의 공백이며, 기관이 조치를 취하지 않았다는 증거가 아닙니다.", onl_no_action_heading: "기록됨: 조치 없음", onl_no_action_body: "이 회의의 공개 기록에 따르면 기관은 이 안건에 대해 아무런 조치도 취하지 않았습니다.", onl_meeting_lbl: "보드 회의", onl_minutes_read_lbl: "공개된 회의록", onl_minutes_read_link: "공개된 회의록 읽기", onl_minutes_no_disposition: "이 회의록은 읽을 수 있지만 이 안건에 대한 결정이 기록되어 있지 않아 여기에 표시하지 않습니다.", onl_follow_lbl: "다음 단계", onl_follow_board: "이 커뮤니티 보드 팔로우하기", onl_follow_borough: "{borough} 자치구청장 팔로우하기", onl_follow_note: "이 기관을 팔로우하는 것이 여기서 이 제품이 제공할 수 있는 기능입니다. 이 기관의 결정 피드는 없습니다.", onl_method_summary: "확인 방법", onl_method_body: "출처: {source}. 마지막 확인: {checked}.", onl_method_unchecked: "기록 없음",
  },
  fr: {
    onl_not_located_heading: "Résultat introuvable", onl_not_located_body: "Nous n'avons pas trouvé de trace publiée de ce que cet organisme a décidé. C'est une lacune dans ce qui a été collecté, et non la preuve que l'organisme n'a rien fait.", onl_no_action_heading: "Consigné : aucune mesure prise", onl_no_action_body: "Le procès-verbal publié de cette réunion indique que l'organisme n'a pris aucune mesure sur ce dossier.", onl_meeting_lbl: "Réunion du conseil", onl_minutes_read_lbl: "Procès-verbal publié", onl_minutes_read_link: "Lire le procès-verbal publié", onl_minutes_no_disposition: "Ce procès-verbal peut être consulté, mais il ne consigne aucune décision sur ce dossier ; aucune n'est donc affichée ici.", onl_follow_lbl: "Prochaine étape", onl_follow_board: "Suivre ce conseil communautaire", onl_follow_borough: "Suivre le président de l'arrondissement de {borough}", onl_follow_note: "Suivre l'organisme est ce que ce produit peut offrir ici. Il ne dispose d'aucun flux des décisions de cet organisme.", onl_method_summary: "Comment cela a été vérifié", onl_method_body: "Source : {source}. Dernière vérification : {checked}.", onl_method_unchecked: "non consignée",
  },
  pl: {
    onl_not_located_heading: "Nie znaleziono rozstrzygnięcia", onl_not_located_body: "Nie udało się znaleźć opublikowanego zapisu tego, co postanowił ten organ. To luka w zebranych danych, a nie dowód, że organ nic nie zrobił.", onl_no_action_heading: "Odnotowano: nie podjęto działań", onl_no_action_body: "Opublikowany protokół tego posiedzenia stwierdza, że organ nie podjął żadnych działań w tej sprawie.", onl_meeting_lbl: "Posiedzenie rady", onl_minutes_read_lbl: "Opublikowany protokół", onl_minutes_read_link: "Przeczytaj opublikowany protokół", onl_minutes_no_disposition: "Ten protokół można przeczytać, ale nie zawiera decyzji w tej sprawie, więc żadnej tu nie pokazujemy.", onl_follow_lbl: "Następny krok", onl_follow_board: "Obserwuj tę radę społeczności", onl_follow_borough: "Obserwuj prezydenta dzielnicy {borough}", onl_follow_note: "Obserwowanie organu to wszystko, co ten produkt może tu zaoferować. Nie ma kanału decyzji tego organu.", onl_method_summary: "Jak to sprawdzono", onl_method_body: "Źródło: {source}. Ostatnie sprawdzenie: {checked}.", onl_method_unchecked: "nieodnotowane",
  },
  ar: {
    onl_not_located_heading: "لم يُعثر على النتيجة", onl_not_located_body: "لم نتمكن من العثور على سجل منشور لما قرره هذا الجهاز. هذه ثغرة فيما تم جمعه، وليست دليلاً على أن الجهاز لم يتخذ أي إجراء.", onl_no_action_heading: "مسجَّل: لم يُتخذ أي إجراء", onl_no_action_body: "ينص المحضر المنشور لهذا الاجتماع على أن الجهاز لم يتخذ أي إجراء بشأن هذا البند.", onl_meeting_lbl: "اجتماع المجلس", onl_minutes_read_lbl: "المحضر المنشور", onl_minutes_read_link: "اقرأ المحضر المنشور", onl_minutes_no_disposition: "يمكن قراءة هذا المحضر، لكنه لا يسجّل أي قرار بشأن هذا البند، لذا لا يُعرض أي قرار هنا.", onl_follow_lbl: "الخطوة التالية", onl_follow_board: "تابِع مجلس المجتمع المحلي هذا", onl_follow_borough: "تابِع رئيس بلدية {borough}", onl_follow_note: "متابعة الجهاز هي ما يمكن أن يقدمه هذا المنتج هنا. ولا تتوفر لديه تغذية بقرارات هذا الجهاز.", onl_method_summary: "كيف جرى التحقق", onl_method_body: "المصدر: {source}. آخر تحقق: {checked}.", onl_method_unchecked: "غير مسجَّل",
  },
  ur: {
    onl_not_located_heading: "نتیجہ نہیں ملا", onl_not_located_body: "ہمیں اس ادارے کے فیصلے کا کوئی شائع شدہ ریکارڈ نہیں مل سکا۔ یہ جمع کی گئی معلومات کا خلا ہے، اس بات کا ثبوت نہیں کہ ادارے نے کوئی کارروائی نہیں کی۔", onl_no_action_heading: "ریکارڈ شدہ: کوئی کارروائی نہیں ہوئی", onl_no_action_body: "اس اجلاس کی شائع شدہ کارروائی میں درج ہے کہ ادارے نے اس معاملے پر کوئی کارروائی نہیں کی۔", onl_meeting_lbl: "بورڈ اجلاس", onl_minutes_read_lbl: "شائع شدہ کارروائی", onl_minutes_read_link: "شائع شدہ کارروائی پڑھیں", onl_minutes_no_disposition: "یہ کارروائی پڑھی جا سکتی ہے، لیکن اس میں اس معاملے پر کوئی فیصلہ درج نہیں، اس لیے یہاں کوئی نہیں دکھایا گیا۔", onl_follow_lbl: "اگلا قدم", onl_follow_board: "اس کمیونٹی بورڈ کو فالو کریں", onl_follow_borough: "{borough} بورو پریزیڈنٹ کو فالو کریں", onl_follow_note: "ادارے کو فالو کرنا وہی ہے جو یہ پروڈکٹ یہاں پیش کر سکتا ہے۔ اس کے پاس اس ادارے کے فیصلوں کی کوئی فیڈ نہیں۔", onl_method_summary: "یہ کیسے جانچا گیا", onl_method_body: "ماخذ: {source}۔ آخری جانچ: {checked}۔", onl_method_unchecked: "ریکارڈ نہیں",
  },
};

function localizedT(lang) {
  const values = STRINGS[lang] || STRINGS.en;
  return (key, vars = {}) => String(values[key] || STRINGS.en[key] || key)
    .replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? "");
}
