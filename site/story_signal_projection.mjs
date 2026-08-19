/**
 * Private, materialized story-finding projection over admitted story signals.
 *
 * This module formats an already-published signal artifact. It never measures a
 * population, reads a source store, or selects a signal. Unsupported metric
 * families fail closed so new language requires a reviewed deterministic
 * template.
 */

import { alertsHref } from "./alerts_context_carry.mjs";
import {
  renderCivicDocumentAssets,
  renderCivicDocumentMast,
} from "./civic_document_chrome.mjs";

export const PRIVATE_STORY_SIGNAL_PROJECTION_SCHEMA = "cityscroll.private_story_signal_projection.v1";
export const PRIVATE_STORY_SIGNAL_PROJECTION_METHOD = "bounded_private_story_signal_projection_v1";
export const PRIVATE_STORY_SIGNAL_LIMIT = 12;

const STORY_SIGNAL_SCHEMA = "cityscroll.story_signal.v1";
const STORY_SIGNAL_READ_MODEL_SCHEMA = "cityscroll.story_signal_read_model.v1";

const MONTHS = Object.freeze([
  "Jan.", "Feb.", "March", "April", "May", "June",
  "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec.",
]);

const CARD_SLOP_PATTERNS = Object.freeze([
  ["backstage state", /\b(?:held_[a-z_]+|eligible|published)\b/i],
  ["debug field", /\b(?:join_coverage|join_rate|snapshot_sha|source_errors|gate_id|reason_codes|failed_predicates)\b/i],
  ["adjective theater", /\b(?:shocking|massive|surge|suspicious|scandal|wasteful|alarming)\b/i],
  ["significance theater", /\b(?:p[- ]?value|z[- ]?score|statistically significant|anomaly score|scandal meter)\b/i],
  ["disclaimer slop", /\b(?:for informational purposes only|not a substitute for|interpret with caution|data may be incomplete|does not necessarily|no guarantee)\b/i],
]);

function esc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function clean(value, max = 500) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function money(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

function ordinal(value) {
  if (!Number.isInteger(value) || value < 1) return null;
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${value}th`;
  return `${value}${value % 10 === 1 ? "st" : value % 10 === 2 ? "nd" : value % 10 === 3 ? "rd" : "th"}`;
}

function isoDay(value) {
  const day = clean(value, 20);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const parsed = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== day ? null : day;
}

function dateLabel(value) {
  const day = isoDay(value);
  if (!day) return null;
  const [year, month, date] = day.split("-").map(Number);
  return `${MONTHS[month - 1]} ${date}, ${year}`;
}

function safeHttps(value) {
  const href = clean(value, 500);
  try {
    const url = new URL(href);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function awardRankSentence(signal) {
  const amount = money(signal?.value);
  const rank = ordinal(signal?.comparison?.rank);
  const observed = signal?.comparison?.observed_count;
  const agency = clean(signal?.comparison?.population?.agency_name, 200);
  const start = dateLabel(signal?.comparison?.window?.start);
  const end = dateLabel(signal?.comparison?.window?.end);
  if (!amount || !rank || !Number.isInteger(observed) || observed < 1 || !agency || !start || !end) {
    return null;
  }
  return `This ${amount} award is ${rank}-largest among ${observed} ${agency} award rows observed in the OCP snapshot from ${start} through ${end}.`;
}

function cardFromSignal(signal) {
  if (signal?.schema !== STORY_SIGNAL_SCHEMA || signal?.metric?.id !== "award_amount_rank") return null;
  if (Object.hasOwn(signal, "state") || Object.hasOwn(signal, "backstage") || Object.hasOwn(signal, "public_signal")) {
    return null;
  }
  const signalId = clean(signal.signal_id, 500);
  const factId = clean(signal.fact_id, 500);
  if (!factId || signalId !== `story_signal:${factId}`) return null;
  const expectedSentence = awardRankSentence(signal);
  if (!expectedSentence || clean(signal.basis_sentence) !== expectedSentence) return null;

  const subjectId = clean(signal?.subject?.id, 120);
  const subjectLabel = clean(signal?.subject?.label, 300);
  const agencyId = clean(signal?.comparison?.population?.agency_id, 160);
  const agencyName = clean(signal?.comparison?.population?.agency_name, 200);
  const sourceHref = (Array.isArray(signal.evidence) ? signal.evidence : [])
    .map((item) => safeHttps(item?.href))
    .find(Boolean);
  const amount = money(signal.value);
  const rank = ordinal(signal.comparison.rank);
  const start = dateLabel(signal.comparison.window?.start);
  const end = dateLabel(signal.comparison.window?.end);
  if (!subjectId || !subjectLabel || !agencyId || !agencyName || !sourceHref || !amount || !rank || !start || !end) {
    return null;
  }

  const peerAnchor = `peer-${subjectId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  const noticeHref = `/notices/${encodeURIComponent(subjectId)}/`;
  const followHref = alertsHref({
    lens: "money",
    filter: { agency: agencyName, keywords: [], noticeType: "award" },
    digKind: "award",
    noticeId: subjectId,
    freq: "weekly",
  });

  return deepFreeze({
    signal_id: signalId,
    subject: { id: subjectId, label: subjectLabel },
    what_stands_out: expectedSentence,
    what_happened: `${subjectLabel} is a ${amount} award recorded for ${agencyName}.`,
    context: {
      agency_name: agencyName,
      agency_href: `/agencies/${encodeURIComponent(agencyId)}/`,
      peer_anchor: peerAnchor,
      peer_count: signal.comparison.observed_count,
      rank: signal.comparison.rank,
      rank_label: rank,
      window_start: start,
      window_end: end,
    },
    actions: [
      { id: "source", label: "Open source record", href: sourceHref, external: true },
      { id: "process", label: "Inspect process", href: noticeHref, external: false },
      { id: "peers", label: "View peer group", href: `#${peerAnchor}`, external: false },
      { id: "follow", label: "Follow similar awards", href: followHref, external: false },
      { id: "investigation", label: "Add to Investigation", href: `/#notice/${encodeURIComponent(subjectId)}`, external: false },
    ],
  });
}

/** Project only admitted, closed-template signals into a small deterministic feed. */
export function buildPrivateStorySignalProjection(readModel, { limit = PRIVATE_STORY_SIGNAL_LIMIT } = {}) {
  const boundedLimit = Math.max(0, Math.min(PRIVATE_STORY_SIGNAL_LIMIT, Number.isInteger(limit) ? limit : PRIVATE_STORY_SIGNAL_LIMIT));
  const signals = readModel?.schema === STORY_SIGNAL_READ_MODEL_SCHEMA && Array.isArray(readModel.signals)
    ? readModel.signals
    : [];
  const cards = signals
    .slice()
    .sort((left, right) => {
      const recency = clean(right?.generated_at, 80).localeCompare(clean(left?.generated_at, 80));
      return recency || clean(left?.signal_id).localeCompare(clean(right?.signal_id));
    })
    .map(cardFromSignal)
    .filter(Boolean)
    .slice(0, boundedLimit);
  return deepFreeze({
    schema: PRIVATE_STORY_SIGNAL_PROJECTION_SCHEMA,
    method: PRIVATE_STORY_SIGNAL_PROJECTION_METHOD,
    visibility: "private_experimental",
    generated_at: clean(readModel?.generated_at, 80) || null,
    limit: boundedLimit,
    cards,
  });
}

export function detectStorySignalCardSlop(html) {
  const text = String(html || "");
  return CARD_SLOP_PATTERNS
    .filter(([, pattern]) => pattern.test(text))
    .map(([label]) => label);
}

export function gateStorySignalCard(html) {
  const findings = detectStorySignalCardSlop(html);
  if (findings.length) throw new Error(`Story-signal card contains ${findings.join(", ")}`);
  return html;
}

function actionHtml(action) {
  const external = action.external ? ' target="_blank" rel="noopener noreferrer"' : "";
  const externalClass = action.external ? " ui-official-source-link" : "";
  const arrow = action.external ? '<span aria-hidden="true">↗</span>' : "";
  return `<a class="story-signal-action${externalClass}" data-story-action="${esc(action.id)}" href="${esc(action.href)}"${external}>${esc(action.label)}${arrow}</a>`;
}

export function renderStorySignalCard(card, index = 0) {
  if (!card) return "";
  const headingId = `story-signal-${index + 1}-heading`;
  const actions = card.actions.map(actionHtml).join("");
  const html = `<article class="story-signal-card" aria-labelledby="${headingId}" data-story-signal-card="1">
    <p class="story-signal-label">What stands out</p>
    <h2 id="${headingId}">${esc(card.what_stands_out)}</h2>
    <section aria-labelledby="${headingId}-happened">
      <h3 id="${headingId}-happened">What happened</h3>
      <p>${esc(card.what_happened)}</p>
    </section>
    <section aria-labelledby="${headingId}-context">
      <h3 id="${headingId}-context">Context</h3>
      <p><a class="ui-constellation-link" href="${esc(card.context.agency_href)}">${esc(card.context.agency_name)}</a> is the agency in this comparison.</p>
      <details class="story-signal-peers" id="${esc(card.context.peer_anchor)}">
        <summary>View peer group</summary>
        <dl>
          <div><dt>Compared records</dt><dd>${esc(card.context.peer_count)} ${esc(card.context.agency_name)} award rows</dd></div>
          <div><dt>Observed window</dt><dd>${esc(card.context.window_start)} through ${esc(card.context.window_end)}</dd></div>
          <div><dt>Position</dt><dd>${esc(card.context.rank_label)} by award amount</dd></div>
        </dl>
      </details>
    </section>
    <section aria-labelledby="${headingId}-next">
      <h3 id="${headingId}-next">Next</h3>
      <nav class="story-signal-actions" aria-label="Next steps for ${esc(card.subject.label)}">${actions}</nav>
    </section>
  </article>`;
  return gateStorySignalCard(html);
}

/** Render the private route entirely from the materialized projection. */
export function renderPrivateStorySignalPage(projection) {
  const cards = (projection?.schema === PRIVATE_STORY_SIGNAL_PROJECTION_SCHEMA && Array.isArray(projection.cards))
    ? projection.cards.map(renderStorySignalCard).join("\n")
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>Worth a look · CityScroll private experiment</title>
  <link rel="icon" href="/assets/brand/favicon.svg" type="image/svg+xml">
  <link rel="icon" href="/assets/brand/favicon-32.png" sizes="32x32" type="image/png">
  ${renderCivicDocumentAssets("/")}
  <link rel="stylesheet" href="story-signal-projection.css">
</head>
<body data-private-story-signal-projection="1">
  <a class="skip" href="#main">Skip to content</a>
  ${renderCivicDocumentMast()}
  <main id="main" class="story-signal-document">
    <header class="story-signal-hero">
      <p class="story-signal-kicker">Private experiment</p>
      <h1>Worth a look</h1>
      <p>A small set of precomputed record comparisons for story finding.</p>
    </header>
    <section class="story-signal-feed" aria-label="Worth-a-look signals">${cards}</section>
  </main>
</body>
</html>`;
}
