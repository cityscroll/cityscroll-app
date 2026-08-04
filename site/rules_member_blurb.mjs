/**
 * Forwardable member blurb for association secretaries.
 *
 * Weaves notice-specific facts (what changes, who is affected, deadline, action)
 * into a naturally pasteable paragraph — not a generic shell — plus a short
 * participation prompt.
 *
 * Pure: no DOM, no fetch.
 */

import { daysUntil } from "./rules_action_bands.mjs";
import { extractCommentFacts, hasOpenCommentWindow } from "./rules_participation.mjs";

export const RULES_MEMBER_BLURB_SCHEMA_VERSION = 1;

/**
 * Build a forwardable member-newsletter blurb for one rule notice.
 *
 * @param {object|null} noticeRow — City Record notice
 * @param {object|null} rec — /rules materialization (stage, nyc_rules, events)
 * @param {{ now?: string|Date|null, siteBase?: string }} [opts]
 * @returns {{ text: string, schema_version: number, fields: object }|null}
 */
export function buildMemberBlurb(noticeRow, rec = null, opts = {}) {
  const title = clean(
    noticeRow?.short_title
    || noticeRow?.title
    || rec?.title
    || rec?.short_title
    || rec?.city_record?.short_title,
  );
  if (!title) return null;

  const agency = clean(
    noticeRow?.agency_name
    || rec?.agency
    || rec?.agency_name
    || rec?.city_record?.agency_name,
  ) || "a city agency";

  const facts = extractCommentFacts({
    ...(rec || {}),
    nyc_rules: rec?.nyc_rules || noticeRow?._ruleStage?.nyc_rules,
    stage: rec?.stage || noticeRow?._ruleStage?.stage,
    agency_name: agency,
    short_title: title,
  });

  const requestId = clean(noticeRow?.request_id || rec?.request_id);
  const siteBase = (opts.siteBase || "https://cityscroll.org").replace(/\/+$/, "");
  const noticeUrl = requestId ? `${siteBase}/#notice/${requestId}` : null;
  const type = clean(noticeRow?.type_of_notice_description);
  const bodyBit = excerptChange(noticeRow, rec);
  const whoAffected = whoIsAffected(agency, title, bodyBit);
  const stage = facts.stage_comment_open
    ? "comment-open"
    : normalizeLooseStage(rec?.stage || noticeRow?._ruleStage?.stage);

  const daysLeft = facts.comment_by_date
    ? daysUntil(facts.comment_by_date, opts.now || null)
    : null;
  const open = hasOpenCommentWindow(
    { ...facts, stage: stage === "comment-open" ? "comment-open" : stage, nyc_rules: { comment_by_date: facts.comment_by_date, comment_url: facts.comment_url, url: facts.rule_url } },
    opts,
  );

  // Weave specifics into a natural paragraph (anti-sterile).
  const bits = [];
  const titleDisplay = /[.!?]$/.test(title) ? title : `${title}.`;
  bits.push(`${agency} just posted “${titleDisplay.replace(/\.$/, "")}.”`);

  if (bodyBit) {
    bits.push(bodyBit);
  } else if (type) {
    bits.push(`It is listed as a ${type.toLowerCase()} notice.`);
  }

  bits.push(whoAffected);

  let actionLine = "";
  if (open && facts.comment_by_date) {
    const dayWord = daysLeft === 0
      ? "today"
      : daysLeft === 1
        ? "tomorrow"
        : daysLeft != null && daysLeft > 1
          ? `in ${daysLeft} days`
          : null;
    const deadlineHuman = humanDate(facts.comment_by_date);
    if (dayWord) {
      actionLine = `Public comments are open through ${deadlineHuman} (${dayWord}).`;
    } else {
      actionLine = `Public comments are open through ${deadlineHuman}.`;
    }
  } else if (facts.hearing_date && daysUntil(facts.hearing_date, opts.now) >= 0) {
    actionLine = `A public hearing is scheduled for ${humanDate(facts.hearing_date)}.`;
  } else if (stage === "adopted" || stage === "effective") {
    const eff = isoDate(rec?.nyc_rules?.effective_date || noticeRow?._ruleStage?.nyc_rules?.effective_date);
    actionLine = eff
      ? `The rule has been adopted and is set to take effect ${humanDate(eff)}.`
      : "The rule has been adopted.";
  } else if (type && /adopt/i.test(type)) {
    actionLine = "This notice records an adoption — check the official text for the effective date.";
  } else {
    actionLine = "Review the official notice for deadlines and next steps.";
  }
  bits.push(actionLine);

  // Participation prompt (short, human, not a shell).
  let prompt = "";
  if (open) {
    const channel = facts.comment_url || facts.rule_url;
    if (channel) {
      prompt = `If this affects your members, consider submitting a short public comment at ${channel} before the deadline. A useful comment names who you are, how the rule hits your operation, and what you ask the agency to consider.`;
    } else {
      prompt = "If this affects your members, consider submitting a short public comment before the deadline. A useful comment names who you are, how the rule hits your operation, and what you ask the agency to consider.";
    }
  } else if (facts.hearing_date && daysUntil(facts.hearing_date, opts.now) >= 0) {
    prompt = "If this hearing matters to your members, share the date and any testimony instructions from the official notice.";
  } else {
    prompt = "Forward this to members who track this agency so they can review the official text.";
  }
  bits.push(prompt);

  if (noticeUrl) {
    bits.push(`Read the notice: ${noticeUrl}`);
  }

  const text = bits.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();

  return {
    schema_version: RULES_MEMBER_BLURB_SCHEMA_VERSION,
    text,
    fields: {
      title,
      agency,
      request_id: requestId,
      comment_by_date: facts.comment_by_date,
      hearing_date: facts.hearing_date,
      comment_url: facts.comment_url,
      rule_url: facts.rule_url,
      open_comment: open,
      days_left: daysLeft,
      notice_url: noticeUrl,
      change_excerpt: bodyBit,
    },
  };
}

/**
 * Pull a short "what changes" clause from title/body without inventing policy.
 * @param {object|null} noticeRow
 * @param {object|null} rec
 */
function excerptChange(noticeRow, rec) {
  const body = clean(
    noticeRow?.additional_description_1
    || rec?.city_record?.additional_description_1
    || "",
  );
  const title = clean(noticeRow?.short_title || rec?.title || "") || "";

  // Prefer body: first sentence-ish clause that looks descriptive.
  if (body) {
    let clip = body;
    // Drop common boilerplate openers.
    clip = clip.replace(/^(notice of (?:public hearing and )?opportunity to comment[:\s-]*)/i, "");
    clip = clip.replace(/^(please take notice that\s*)/i, "");
    const sentence = clip.split(/(?<=[.!?])\s+/)[0] || clip;
    let out = sentence.trim();
    if (out.length > 220) out = `${out.slice(0, 217).trim()}…`;
    if (out.length >= 40) {
      // Ensure it reads as a sentence about the change.
      if (!/[.!?]$/.test(out)) out = `${out}.`;
      return out;
    }
  }

  // Title-only: rephrase lightly when it already names the subject.
  if (/relating to|regarding|amend|require|prohibit|establish/i.test(title)) {
    return `It ${title.replace(/^(notice of (?:adoption|proposed rule making|public hearing)[:\s-]*)/i, "").replace(/\.$/, "")}.`
      .replace(/\s+/g, " ")
      .replace(/^It\s+It/i, "It");
  }
  return null;
}

/**
 * Who is affected — grounded in agency + title cues, never invented populations.
 */
function whoIsAffected(agency, title, bodyBit) {
  const hay = `${agency} ${title} ${bodyBit || ""}`.toLowerCase();
  if (/taxi|limousine|for-hire|fhv|medallion|tlc/.test(hay)) {
    return "It is most relevant to for-hire vehicle licensees, fleets, and driver associations.";
  }
  if (/restaurant|food service|food-service|health code|dohmh|health and mental/.test(hay)
    && /food|restaurant|sanit|permit|grade/.test(hay)) {
    return "It is most relevant to restaurant and food-service operators.";
  }
  if (/child care|daycare|day care|early childhood|children's services|acs/.test(hay)) {
    return "It is most relevant to child-care providers and early-childhood programs.";
  }
  if (/building|sidewalk shed|scaffold|construction|dob\b/.test(hay)
    || agency === "Buildings") {
    return "It is most relevant to contractors, property managers, and construction trades working under Buildings rules.";
  }
  if (/sanitation|dsny|container|waste|recycl/.test(hay)) {
    return "It is most relevant to building owners, managers, and businesses that handle waste and recycling.";
  }
  return `It is most relevant to organizations and members who work with ${agency}.`;
}

function normalizeLooseStage(stage) {
  if (!stage) return null;
  const s = String(stage).trim().toLowerCase();
  return s || null;
}

function humanDate(iso) {
  const day = isoDate(iso);
  if (!day) return String(iso || "");
  const d = new Date(`${day}T12:00:00Z`);
  if (!Number.isFinite(d.getTime())) return day;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

function clean(value) {
  if (value == null) return null;
  const s = String(value).replace(/\s+/g, " ").trim();
  return s || null;
}

function isoDate(value) {
  if (!value) return null;
  const s = String(value);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}
