import { createHash } from "node:crypto";

export const PUBLISHED_WALLS_VERSION = "published_walls_candidates_v1";
export const TITLE_CODE_REVIEW_THRESHOLD = 0.8;
export const MINUTES_REVIEW_THRESHOLD = 0.7;

const TITLE_FEATURES = ["title_text", "agency_cooccurrence", "salary_overlap", "temporal_consistency", "sibling_schedule"];
const MINUTES_FEATURES = ["body_match", "date_proximity", "body_text", "address_bbl", "applicant_name", "docket_fragment"];
const DEFAULT_MU = Object.fromEntries([
  ...TITLE_FEATURES.map((name) => [name, { m: 0.85, u: 0.08 }]),
  ...MINUTES_FEATURES.map((name) => [name, { m: 0.85, u: 0.08 }]),
]);

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const lower = (value) => clean(value).toLowerCase();
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, Number(value) || 0));
const round = (value, places = 4) => Number(Number(value || 0).toFixed(places));
const asArray = (value) => Array.isArray(value) ? value : value == null ? [] : [value];

export function normalizeText(value) {
  return lower(value)
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(nyc|city|department|agency|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(value) {
  return new Set(normalizeText(value).split(" ").filter((token) => token.length > 1));
}

export function tokenSimilarity(left, right) {
  const a = tokenize(left);
  const b = tokenize(right);
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  return (2 * intersection) / (a.size + b.size);
}

function featureWeight(m, u, agreement) {
  const safeM = clamp(m, 0.001, 0.999);
  const safeU = clamp(u, 0.001, 0.999);
  return round(Math.log2(agreement ? safeM / safeU : (1 - safeM) / (1 - safeU)), 6);
}

function evidence(feature, state, value, detail, mu = DEFAULT_MU[feature]) {
  const agreement = state === "agreement";
  return {
    feature,
    state,
    agreement: agreement ? true : state === "disagreement" ? false : null,
    value: value ?? null,
    detail: detail || null,
    m_probability: mu?.m ?? null,
    u_probability: mu?.u ?? null,
    weight: agreement || state === "disagreement" ? featureWeight(mu?.m ?? 0.85, mu?.u ?? 0.08, agreement) : 0,
  };
}

function scoreEvidence(items) {
  const raw = items.reduce((sum, item) => sum + Number(item.weight || 0), 0);
  const agreements = items.filter((item) => item.agreement === true).length;
  const available = items.filter((item) => item.state !== "unavailable").length;
  // A tanh scale keeps one feature informative without presenting it as certainty;
  // several independent agreements can move a pair into the review band.
  const score = clamp(0.5 + 0.5 * Math.tanh(raw / 4));
  return { raw_score: round(raw, 6), score: round(score), agreements, available_features: available };
}

function stableBucket(value, buckets = 5) {
  const digest = createHash("sha256").update(String(value)).digest();
  return digest[0] % buckets;
}

function isoDate(value) {
  const match = clean(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] || null;
}

function yearOf(value) {
  const date = isoDate(value);
  return date ? Number(date.slice(0, 4)) : null;
}

function daysBetween(left, right) {
  const a = Date.parse(`${isoDate(left) || ""}T00:00:00Z`);
  const b = Date.parse(`${isoDate(right) || ""}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.abs(a - b) / 86400000 : null;
}

function numeric(value) {
  const n = Number(String(value ?? "").replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function salaryRange(row) {
  const min = numeric(row?.salary_min ?? row?.base_min ?? row?.salaryMin);
  const max = numeric(row?.salary_max ?? row?.base_max ?? row?.salaryMax ?? min);
  return min == null && max == null ? null : { min: min ?? max, max: max ?? min };
}

function rangesOverlap(left, right) {
  if (!left || !right) return null;
  const width = Math.max(left.max, right.max) - Math.min(left.min, right.min);
  const overlap = Math.max(0, Math.min(left.max, right.max) - Math.max(left.min, right.min));
  return width === 0 ? 1 : overlap / width;
}

function codeOf(row) {
  return clean(row?.title_code ?? row?.titleCode ?? row?.appointmentTitleCode).toUpperCase();
}

function codeFromAppointment(row) {
  const direct = codeOf(row);
  if (direct) return direct;
  const match = clean(row?.additional_description_1).match(/(?:^|;)\s*Title Code:\s*([^;]+)/i);
  return clean(match?.[1]).toUpperCase();
}

function agencyOf(row) {
  return clean(row?.agency_name ?? row?.agency ?? row?.agencyName);
}

export function buildTitleCodeCatalog(crosswalk = []) {
  return crosswalk
    .map((row) => {
      const code = codeOf(row);
      const names = [...new Set([row.official_title, row.payroll_title].map(clean).filter(Boolean))];
      return {
        title_code: code,
        official_names: names,
        official_title: names[0] || null,
        salary_range: salaryRange(row),
        source: row.name_source || "title_crosswalk",
      };
    })
    .filter((row) => row.title_code && row.official_names.length)
    .sort((a, b) => a.title_code.localeCompare(b.title_code));
}

export function buildTitleCodeContext({ historyRecords = [], annualScheduleRows = [], appointmentRows = [] } = {}) {
  const codePeriods = new Map();
  const codeAgencies = new Map();
  const codeScheduleKeys = new Map();
  const addPeriod = (code, start, end) => {
    if (!code) return;
    const row = codePeriods.get(code) || { starts: [], ends: [] };
    if (isoDate(start)) row.starts.push(isoDate(start));
    if (isoDate(end)) row.ends.push(isoDate(end));
    codePeriods.set(code, row);
  };
  const addSchedule = (code, row) => {
    if (!code) return;
    const date = isoDate(row?.application_start ?? row?.application_period_start ?? row?.start_date);
    if (!date) return;
    const key = `${date.slice(0, 7)}:${yearOf(date)}`;
    const values = codeScheduleKeys.get(code) || new Set();
    values.add(key);
    codeScheduleKeys.set(code, values);
  };
  for (const row of historyRecords) {
    const code = codeOf(row);
    addPeriod(code, row.application_start, row.application_close);
    addSchedule(code, row);
  }
  for (const row of annualScheduleRows) {
    const code = codeOf(row);
    addPeriod(code, row.application_period_start, row.application_period_end_date);
    addSchedule(code, row);
  }
  for (const row of appointmentRows) {
    const code = codeFromAppointment(row);
    const agency = agencyOf(row);
    if (!code || !agency) continue;
    const values = codeAgencies.get(code) || new Set();
    values.add(normalizeText(agency));
    codeAgencies.set(code, values);
  }
  const periods = Object.fromEntries([...codePeriods].map(([code, row]) => [code, {
    start: row.starts.sort()[0] || null,
    end: row.ends.sort().at(-1) || null,
  }]));
  return {
    code_periods: periods,
    code_agencies: Object.fromEntries([...codeAgencies].map(([code, values]) => [code, [...values].sort()])),
    code_schedule_keys: Object.fromEntries([...codeScheduleKeys].map(([code, values]) => [code, [...values].sort()])),
  };
}

function temporalState(exam, candidate, context, mu) {
  const period = context.code_periods?.[candidate.title_code];
  const date = isoDate(exam.application_start ?? exam.application_period_start ?? exam.start_date);
  if (!period || !date || !period.start) return evidence("temporal_consistency", "unavailable", null, "No active period or exam start date was published.", mu);
  const before = period.start && date < period.start;
  const after = period.end && date > period.end;
  return evidence("temporal_consistency", before || after ? "disagreement" : "agreement", !before && !after,
    `${date} within observed ${period.start}..${period.end || "open"}`, mu);
}

function siblingState(exam, candidate, context, mu) {
  const date = isoDate(exam.application_start ?? exam.application_period_start ?? exam.start_date);
  if (!date) return evidence("sibling_schedule", "unavailable", null, "No schedule date was published.", mu);
  const key = `${date.slice(0, 7)}:${yearOf(date)}`;
  const siblings = context.code_schedule_keys?.[candidate.title_code] || [];
  return evidence("sibling_schedule", siblings.includes(key) ? "agreement" : "disagreement", siblings.includes(key),
    siblings.includes(key) ? `Code appears in the ${key} schedule window.` : `Code not observed in the ${key} schedule window.`, mu);
}

export function buildTitleCodeEvidence(exam, candidate, context = {}, mu = DEFAULT_MU) {
  const titleSimilarity = Math.max(...candidate.official_names.map((name) => tokenSimilarity(exam.exam_title ?? exam.title, name)), 0);
  const title = evidence("title_text", titleSimilarity >= 0.5 ? "agreement" : "disagreement", round(titleSimilarity),
    `Best official-name token similarity ${round(titleSimilarity)}.`, mu.title_text);
  const examAgency = normalizeText(agencyOf(exam));
  const agencies = context.code_agencies?.[candidate.title_code] || [];
  const agencyAgreement = examAgency && agencies.length ? agencies.some((value) => value === examAgency || value.includes(examAgency) || examAgency.includes(value)) : null;
  const agency = evidence("agency_cooccurrence", agencyAgreement == null ? "unavailable" : agencyAgreement ? "agreement" : "disagreement", agencyAgreement,
    agencyAgreement == null ? "Exam history has no agency field to compare." : `${agencies.length} agency co-occurrence value(s) checked.`, mu.agency_cooccurrence);
  const overlap = rangesOverlap(salaryRange(exam), candidate.salary_range);
  const salary = evidence("salary_overlap", overlap == null ? "unavailable" : overlap >= 0.5 ? "agreement" : "disagreement", overlap,
    overlap == null ? "Exam or crosswalk salary range unavailable." : `Salary-range overlap ${round(overlap)}.`, mu.salary_overlap);
  const items = [title, agency, salary, temporalState(exam, candidate, context, mu.temporal_consistency), siblingState(exam, candidate, context, mu.sibling_schedule)];
  return { features: items, ...scoreEvidence(items) };
}

export function scoreTitleCodePair(exam, candidate, context = {}, weights = DEFAULT_MU) {
  const scored = buildTitleCodeEvidence(exam, candidate, context, weights);
  return {
    pair_id: `exam:${clean(exam.exam_number)}::title-code:${candidate.title_code}`,
    left: { exam_number: clean(exam.exam_number), exam_title: clean(exam.exam_title ?? exam.title) },
    right: { title_code: candidate.title_code, official_names: candidate.official_names },
    score: scored.score,
    raw_score: scored.raw_score,
    evidence: scored.features,
    agreements: scored.agreements,
    available_features: scored.available_features,
    candidate_status: "candidate",
    operative_link_authorized: false,
    review_status: "pending",
    review_decision: null,
  };
}

export function generateTitleCodeCandidates(exams = [], catalog = [], context = {}, {
  maxCandidates = 8,
  weights = DEFAULT_MU,
  reviewThreshold = TITLE_CODE_REVIEW_THRESHOLD,
} = {}) {
  return exams.flatMap((exam) => {
    const scored = catalog.map((candidate) => scoreTitleCodePair(exam, candidate, context, weights))
      .sort((a, b) => b.score - a.score || a.pair_id.localeCompare(b.pair_id));
    return scored.slice(0, maxCandidates).map((row, rank) => ({
      ...row,
      rank: rank + 1,
      review_eligible: row.score >= reviewThreshold && row.agreements >= 2,
    }));
  });
}

function splitGold(rows, holdoutBucket = 5) {
  return {
    train: rows.filter((row) => stableBucket(row.exam_number, holdoutBucket) !== 0),
    holdout: rows.filter((row) => stableBucket(row.exam_number, holdoutBucket) === 0),
  };
}

function empiricalWeights(positives, negatives) {
  const weights = {};
  for (const feature of TITLE_FEATURES) {
    const positiveAgreement = positives.filter((row) => row.features.find((f) => f.feature === feature)?.agreement === true).length;
    const negativeAgreement = negatives.filter((row) => row.features.find((f) => f.feature === feature)?.agreement === true).length;
    const m = (positiveAgreement + 1) / (positives.length + 2);
    const u = (negativeAgreement + 1) / (negatives.length + 2);
    weights[feature] = { m: round(m), u: round(u) };
  }
  return weights;
}

export function calibrateTitleCodeScorer(goldRows = [], catalog = [], context = {}) {
  const split = splitGold(goldRows);
  const trainByCode = new Set(split.train.map(codeOf));
  const trainPairs = split.train.map((row) => {
    const candidate = catalog.find((item) => item.title_code === codeOf(row));
    return candidate ? buildTitleCodeEvidence(row, candidate, context) : null;
  }).filter(Boolean);
  const negatives = split.train.map((row) => {
    const candidate = catalog.find((item) => item.title_code !== codeOf(row));
    return candidate ? buildTitleCodeEvidence(row, candidate, context) : null;
  }).filter(Boolean);
  const weights = empiricalWeights(trainPairs, negatives);
  const evaluated = split.holdout.map((row) => {
    const candidates = catalog.map((candidate) => scoreTitleCodePair(row, candidate, context, weights))
      .sort((a, b) => b.score - a.score || a.pair_id.localeCompare(b.pair_id));
    const target = codeOf(row);
    const top = candidates[0] || null;
    return { exam_number: clean(row.exam_number), target_code: target, top_code: top?.right.title_code || null, top_score: top?.score || 0, correct: top?.right.title_code === target, target_in_catalog: catalog.some((item) => item.title_code === target) };
  });
  const eligible = evaluated.filter((row) => row.target_in_catalog);
  const thresholdMetrics = [0.7, 0.8, 0.9].map((threshold) => {
    const above = eligible.filter((row) => row.top_score >= threshold);
    return { threshold, reviewed: above.length, correct: above.filter((row) => row.correct).length, precision: above.length ? round(above.filter((row) => row.correct).length / above.length) : null };
  });
  return {
    method: "fellegi_sunter_style_empirical_m_u",
    gold_pairs: goldRows.length,
    train_pairs: split.train.length,
    held_out_pairs: split.holdout.length,
    held_out_target_codes_in_catalog: eligible.length,
    held_out_top1_correct: eligible.filter((row) => row.correct).length,
    held_out_top1_precision: eligible.length ? round(eligible.filter((row) => row.correct).length / eligible.length) : null,
    feature_parameters: weights,
    threshold_metrics: thresholdMetrics,
    excluded_from_calibration: split.holdout.length - eligible.length,
    note: trainByCode.size ? "Gold code labels are used only to fit feature m/u rates and evaluate holdout precision; no confirmation is written." : "No usable gold labels were available.",
  };
}

export function summarizeScoreBands(rows = [], bands = [0, 0.5, 0.65, 0.8, 0.9]) {
  return bands.map((min, index) => {
    const max = bands[index + 1] ?? 1.0001;
    const inBand = rows.filter((row) => row.score >= min && row.score < max);
    return { min_inclusive: min, max_exclusive: max, pairs: inBand.length, left_entities: new Set(inBand.map((row) => row.left?.exam_number ?? row.left?.minutes_id)).size };
  });
}

export function measurePotentialLift({ baseline = 0, denominator = 0, rows = [], threshold, minAgreements = 2, leftKey = "exam_number" } = {}) {
  const eligible = rows.filter((row) => row.score >= threshold && row.agreements >= minAgreements);
  const leftEntities = new Set(eligible.map((row) => row.left?.[leftKey]).filter(Boolean));
  const ifConfirmed = baseline + leftEntities.size;
  return {
    threshold,
    minimum_agreements: minAgreements,
    eligible_pairs: eligible.length,
    eligible_left_entities: leftEntities.size,
    baseline_confirmed: baseline,
    denominator,
    if_confirmed_count: ifConfirmed,
    if_confirmed_coverage: denominator ? round(ifConfirmed / denominator) : 0,
    note: "Potential only: candidates are not confirmations and are not used by operative joins.",
  };
}

export function extractDocketFragments(value) {
  return [...new Set(clean(value).toUpperCase().match(/(?:[CNM]\s*)?\d{6}\s*[A-Z]{2,4}/g)?.map((token) => token.replace(/\s+/g, "")) || [])];
}

function extractBbls(value) {
  return [...new Set(clean(value).match(/\b\d{10}\b/g) || [])];
}

function textFields(row) {
  return [row?.title, row?.short_title, row?.body, row?.extracted_text, row?.text, row?.description, ...asArray(row?.matter_tokens)].filter(Boolean).join(" ");
}

function nameFields(row) {
  return [row?.applicant_name, ...asArray(row?.applicant_names), row?.applicant, row?.primary_applicant].filter(Boolean).join(" ");
}

export function buildMinutesEvidence(minutes, notice, mu = DEFAULT_MU) {
  const body = clean(minutes?.body_id) && clean(notice?.body_id) ? clean(minutes.body_id) === clean(notice.body_id) : null;
  const dateDistance = daysBetween(minutes?.meeting_date ?? minutes?.event_date, notice?.event_date ?? notice?.meeting_date);
  const dateAgreement = dateDistance == null ? null : dateDistance <= 1;
  const minutesText = textFields(minutes);
  const noticeText = textFields(notice);
  const bodySimilarity = minutesText && noticeText ? tokenSimilarity(minutesText, noticeText) : null;
  const minutesBbl = extractBbls(`${minutesText} ${minutes?.address || ""}`);
  const noticeBbl = extractBbls(`${noticeText} ${notice?.address || ""}`);
  const bblOverlap = minutesBbl.length && noticeBbl.length ? minutesBbl.some((bbl) => noticeBbl.includes(bbl)) : null;
  const addressSimilarity = minutes?.address && notice?.address ? tokenSimilarity(minutes.address, notice.address) : null;
  const addressAgreement = bblOverlap === true || (addressSimilarity != null && addressSimilarity >= 0.6) ? true : bblOverlap === false || addressSimilarity != null ? false : null;
  const minutesNames = nameFields(minutes);
  const noticeNames = nameFields(notice);
  const applicantSimilarity = minutesNames && noticeNames ? tokenSimilarity(minutesNames, noticeNames) : null;
  const minutesDockets = [...new Set([...extractDocketFragments(minutesText), ...asArray(minutes?.matter_tokens).map((token) => clean(token).toUpperCase())])];
  const noticeDockets = [...new Set([...extractDocketFragments(noticeText), ...asArray(notice?.matter_tokens).map((token) => clean(token).toUpperCase())])];
  const docketAgreement = minutesDockets.length && noticeDockets.length ? minutesDockets.some((token) => noticeDockets.includes(token.replace(/^C(?=\d)/, "")) || noticeDockets.includes(token)) : null;
  const features = [
    evidence("body_match", body == null ? "unavailable" : body ? "agreement" : "disagreement", body, body == null ? "One side has no publisher body identifier." : "Exact publisher body identifier comparison.", mu.body_match),
    evidence("date_proximity", dateDistance == null ? "unavailable" : dateAgreement ? "agreement" : dateDistance <= 14 ? "disagreement" : "disagreement", dateDistance, dateDistance == null ? "Meeting or notice date unavailable." : `${round(dateDistance, 2)} day(s) apart.`, mu.date_proximity),
    evidence("body_text", bodySimilarity == null ? "unavailable" : bodySimilarity >= 0.2 ? "agreement" : "disagreement", bodySimilarity, bodySimilarity == null ? "No text on one side." : `Text token similarity ${round(bodySimilarity)}.`, mu.body_text),
    evidence("address_bbl", addressAgreement == null ? "unavailable" : addressAgreement ? "agreement" : "disagreement", bblOverlap ?? addressSimilarity, addressAgreement == null ? "No shared address or BBL evidence published." : bblOverlap ? "Exact BBL overlap." : `Address similarity ${round(addressSimilarity)}.`, mu.address_bbl),
    evidence("applicant_name", applicantSimilarity == null ? "unavailable" : applicantSimilarity >= 0.6 ? "agreement" : "disagreement", applicantSimilarity, applicantSimilarity == null ? "No applicant name on both sides." : `Applicant-name similarity ${round(applicantSimilarity)}.`, mu.applicant_name),
    evidence("docket_fragment", docketAgreement == null ? "unavailable" : docketAgreement ? "agreement" : "disagreement", docketAgreement, docketAgreement == null ? "No docket fragments on both sides." : "Exact normalized docket fragment comparison.", mu.docket_fragment),
  ];
  return { features, ...scoreEvidence(features) };
}

export function scoreMinutesPair(minutes, notice, weights = DEFAULT_MU) {
  const scored = buildMinutesEvidence(minutes, notice, weights);
  const minutesId = clean(minutes?.minutes_id ?? minutes?.document_id ?? minutes?.id);
  const noticeId = clean(notice?.request_id ?? notice?.notice_id ?? notice?.id);
  return {
    pair_id: `minutes:${minutesId}::notice:${noticeId}`,
    left: { minutes_id: minutesId, body_id: clean(minutes?.body_id), meeting_date: isoDate(minutes?.meeting_date ?? minutes?.event_date) },
    right: { notice_id: noticeId, body_id: clean(notice?.body_id), event_date: isoDate(notice?.event_date ?? notice?.meeting_date) },
    score: scored.score,
    raw_score: scored.raw_score,
    evidence: scored.features,
    agreements: scored.agreements,
    available_features: scored.available_features,
    candidate_status: "candidate",
    operative_link_authorized: false,
    review_status: "pending",
    review_decision: null,
  };
}

export function generateMinutesCandidates(minutes = [], notices = [], { maxCandidates = 10, weights = DEFAULT_MU, reviewThreshold = MINUTES_REVIEW_THRESHOLD } = {}) {
  return minutes.flatMap((minute) => {
    const candidates = notices.filter((notice) => {
      const bodyMatch = clean(minute?.body_id) && clean(notice?.body_id) && clean(minute.body_id) === clean(notice.body_id);
      const dateDistance = daysBetween(minute?.meeting_date ?? minute?.event_date, notice?.event_date ?? notice?.meeting_date);
      const dockets = extractDocketFragments(`${textFields(minute)} ${textFields(notice)}`);
      return bodyMatch || (dateDistance != null && dateDistance <= 45) || dockets.length > 0;
    }).map((notice) => scoreMinutesPair(minute, notice, weights))
      .sort((a, b) => b.score - a.score || a.pair_id.localeCompare(b.pair_id));
    return candidates.slice(0, maxCandidates).map((row, rank) => ({
      ...row,
      rank: rank + 1,
      review_eligible: row.score >= reviewThreshold && row.agreements >= 3,
    }));
  });
}

export function calibrateMinutesScorer(goldPairs = [], minutes = [], notices = []) {
  const positives = [];
  const negatives = [];
  const labels = new Map(goldPairs.map((pair) => [pair.pair_id, pair.label]));
  for (const minute of minutes) {
    for (const notice of notices) {
      const pair = scoreMinutesPair(minute, notice);
      const label = labels.get(pair.pair_id);
      if (label === "true_positive") positives.push(pair);
      else if (label === "true_reject") negatives.push(pair);
    }
  }
  const weights = {};
  for (const feature of MINUTES_FEATURES) {
    const m = (positives.filter((row) => row.evidence.find((f) => f.feature === feature)?.agreement === true).length + 1) / (positives.length + 2);
    const u = (negatives.filter((row) => row.evidence.find((f) => f.feature === feature)?.agreement === true).length + 1) / (negatives.length + 2);
    weights[feature] = { m: round(m), u: round(u) };
  }
  const evaluated = [...new Set(goldPairs.map((row) => row.pair_id))].map((pairId) => {
    const [left, right] = pairId.replace(/^minutes:/, "").split("::notice:");
    const minute = minutes.find((row) => clean(row.minutes_id ?? row.document_id ?? row.id) === left);
    const notice = notices.find((row) => clean(row.request_id ?? row.notice_id ?? row.id) === right);
    const scored = minute && notice ? scoreMinutesPair(minute, notice, weights) : null;
    return scored ? { pair_id: pairId, label: labels.get(pairId), score: scored.score, agreements: scored.agreements } : null;
  }).filter(Boolean);
  const proposed = evaluated.filter((row) => row.score >= MINUTES_REVIEW_THRESHOLD && row.agreements >= 3);
  return {
    method: "fellegi_sunter_style_empirical_m_u",
    confirmed_pairs: positives.length,
    hand_reviewed_rejects: negatives.length,
    feature_parameters: weights,
    held_out_note: "Two confirmed fixture joins are retained as the calibration gold; the published wall has no confirmed joins. Review labels are not operative links.",
    proposed_review_pairs: proposed.length,
    proposed_precision_on_labeled_fixture: proposed.length ? round(proposed.filter((row) => row.label === "true_positive").length / proposed.length) : null,
  };
}

export function emptyReviewedRegistry(kind, observedOn) {
  return {
    schema_version: 1,
    registry_kind: kind,
    observed_on: observedOn,
    status: "review_only",
    confirmations: [],
    rejections: [],
    pending: [],
    review_batches: [],
    operative_links_enabled: false,
    policy: "Only a later explicit review may add a confirmation; candidate scores never authorize a public fact or operative link.",
  };
}
