import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

import {
  FEEDBACK_MESSAGE_MAX_LENGTH,
  FEEDBACK_MESSAGE_MIN_LENGTH,
  PAST_TASK_GUIDANCE_PROMPTS,
  feedbackPayload,
  feedbackValidationError,
  pastTaskGuidanceDefaultOpen,
} from "../site/contextual_ux_feedback_prompt.mjs";

const ABOUT_HTML_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "site", "about.html");
const aboutHtml = readFileSync(ABOUT_HTML_PATH, "utf8");

function cardSection(html) {
  const start = html.indexOf('<div class="card">');
  const end = html.indexOf('<h2 id="accessibility"', start);
  assert.ok(start !== -1 && end !== -1 && end > start, "feedback card section must be present");
  return html.slice(start, end);
}

/* ---- pure module: validation is unchanged by the guidance panel's presence ---- */

test("feedbackValidationError rejects a too-short message, same threshold as before", () => {
  assert.equal(FEEDBACK_MESSAGE_MIN_LENGTH, 10);
  assert.equal(feedbackValidationError("short", ""), "about_err_short");
  assert.equal(feedbackValidationError("a".repeat(9), ""), "about_err_short");
  assert.equal(feedbackValidationError("a".repeat(10), ""), null);
});

test("feedbackValidationError rejects a message over the existing 2,000-character limit", () => {
  assert.equal(FEEDBACK_MESSAGE_MAX_LENGTH, 2000);
  assert.equal(feedbackValidationError("a".repeat(2000), ""), null);
  assert.equal(feedbackValidationError("a".repeat(2001), ""), "about_err_long");
});

test("feedbackValidationError rejects a malformed optional email but accepts a blank one", () => {
  assert.equal(feedbackValidationError("a valid message here", ""), null);
  assert.equal(feedbackValidationError("a valid message here", "not-an-email"), "about_err_bademail");
  assert.equal(feedbackValidationError("a valid message here", "reader@example.com"), null);
});

test("feedbackValidationError trims whitespace the same way the form always has", () => {
  assert.equal(feedbackValidationError("   short   ", ""), "about_err_short");
  assert.equal(feedbackValidationError(`  ${"a".repeat(10)}  `, "  reader@example.com  "), null);
});

test("feedbackPayload is exactly {category, message, email} — guidance never adds a field", () => {
  const payload = feedbackPayload("bug", "  it broke  ", "  reader@example.com  ");
  assert.deepEqual(payload, { category: "bug", message: "it broke", email: "reader@example.com" });
  assert.deepEqual(Object.keys(payload).sort(), ["category", "email", "message"]);
});

test("feedbackPayload tolerates missing category/email without inventing values", () => {
  assert.deepEqual(feedbackPayload(undefined, "a message here", undefined), {
    category: "",
    message: "a message here",
    email: "",
  });
});

/* ---- the guidance content model: a fixed set of three, collapsed by default ---- */

test("past-task guidance is exactly task, breakdown, and workaround — no more, no fewer", () => {
  assert.deepEqual(PAST_TASK_GUIDANCE_PROMPTS.map((p) => p.id), ["task", "breakdown", "workaround"]);
});

test("the guidance disclosure defaults to closed", () => {
  assert.equal(pastTaskGuidanceDefaultOpen(), false);
});

/* ---- the real about.html: guidance disclosure, one message field, unchanged wiring ---- */

test("the feedback card contains exactly one message field", () => {
  const card = cardSection(aboutHtml);
  const textareaCount = (card.match(/<textarea\b/g) || []).length;
  assert.equal(textareaCount, 1, "guidance must not introduce a second editable message field");
  const inputCount = (card.match(/<input\b/g) || []).length;
  assert.equal(inputCount, 2, "only the pre-existing hidden category field and optional email field remain");
});

test("the past-task guidance is a collapsed <details>, not open by default", () => {
  const card = cardSection(aboutHtml);
  const match = card.match(/<details class="past-task-guidance" id="fbpasttask"[^>]*>/);
  assert.ok(match, "expected a collapsed past-task-guidance <details> beside the message field");
  assert.ok(!/\bopen\b/.test(match[0]), "guidance must not render pre-expanded");
});

test("the guidance covers the actual task, the breakdown, and the workaround", () => {
  const card = cardSection(aboutHtml);
  for (const prompt of PAST_TASK_GUIDANCE_PROMPTS) {
    assert.ok(card.includes(prompt.i18nKey), `expected guidance content for "${prompt.id}" (${prompt.i18nKey})`);
  }
});

test("the guidance sits ahead of the message textarea, inside the same card", () => {
  const card = cardSection(aboutHtml);
  const detailsIndex = card.indexOf('id="fbpasttask"');
  const textareaIndex = card.indexOf("<textarea");
  assert.ok(detailsIndex !== -1 && textareaIndex !== -1 && detailsIndex < textareaIndex);
});

test("general feedback categories and the object-level correction path stay untouched", () => {
  const card = cardSection(aboutHtml);
  assert.ok(card.includes('data-cat="bug"'));
  assert.ok(card.includes('data-cat="feature"'));
  assert.ok(card.includes('data-cat="general"'));
});

test("the guidance <details> has no click handler or script wiring of its own", () => {
  const scriptMatch = aboutHtml.match(/<script type="module">([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, "expected the feedback page script");
  const script = scriptMatch[1];
  assert.ok(!script.includes("fbpasttask"), "the native <details> disclosure needs no JS reference at all");
  const addEventListenerCalls = script.match(/addEventListener\(/g) || [];
  assert.equal(addEventListenerCalls.length, 2, "only the category chips and the Send button are wired");
});

test("only the Send button's click handler reaches the network; nothing runs on page load or on toggling guidance", () => {
  const scriptMatch = aboutHtml.match(/<script type="module">([\s\S]*?)<\/script>/);
  const script = scriptMatch[1];
  const fetchCallSites = script.match(/await workerFetch\(/g) || [];
  assert.equal(fetchCallSites.length, 1, "exactly one network call site, inside sendFeedback()");
  const sendFeedbackBody = script.slice(script.indexOf("async function sendFeedback"), script.indexOf("$(\"#fbsend\").addEventListener"));
  assert.ok(sendFeedbackBody.includes("workerFetch("), "the network call lives inside sendFeedback, gated by explicit Send");
});

test("validation, payload construction, and the 2,000-character limit are shared with the tested module", () => {
  const scriptMatch = aboutHtml.match(/<script type="module">([\s\S]*?)<\/script>/);
  const script = scriptMatch[1];
  assert.ok(script.includes('import { feedbackValidationError, feedbackPayload } from "./contextual_ux_feedback_prompt.mjs"'));
  assert.ok(script.includes("feedbackValidationError(message, email)"));
  assert.ok(script.includes("feedbackPayload(category,message,email)"));
  assert.ok(aboutHtml.includes('maxlength="2000"'), "the existing 2,000-character limit is unchanged");
  assert.ok(script.includes('"/feedback"'), "the existing endpoint is unchanged");
});
