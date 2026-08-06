import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  outcomePromptContext,
  outcomePromptHTML,
  recordActionOpened,
  recordOutcomeDismissed,
  recordOutcomePrompted,
  recordOutcomeChoice,
} from "../site/action_outcome_prompt.mjs";
import { OUTCOME_ENUM, outcomeEvent } from "../worker/src/lib/action_registry.mjs";

const HANDOFF = Object.freeze({
  type: "official_application",
  delivery: "official_handoff",
  destination: "https://a0333-passportpublic.nyc.gov/rfx.html",
});

test("official kinetic handoffs use the registered outcome vocabulary without treating documents as actions", () => {
  assert.deepEqual(outcomePromptContext([HANDOFF], OUTCOME_ENUM), {
    trigger: "official_handoff",
    outcomes: ["submitted", "bid", "not_useful"],
  });
  assert.equal(outcomePromptContext([{
    type: "document",
    delivery: "official_handoff",
    destination: "https://a856-cityrecord.nyc.gov/RequestDetail/20260617050",
  }], OUTCOME_ENUM), null);
});

test("passed source-backed actions keep their original kind and do not manufacture participation", () => {
  const context = outcomePromptContext([{
    type: "document",
    delivery: "official_handoff",
    guide: {
      system: "property_reader_actions",
      mode: "historical",
      actions: [
        { kind: "review_documents", status: "historical" },
        { kind: "bid", status: "historical" },
      ],
    },
  }], OUTCOME_ENUM);
  assert.deepEqual(context, {
    trigger: "passed_action",
    outcomes: ["bid", "won", "not_useful"],
  });
  assert.equal(outcomePromptContext([{
    type: "document",
    delivery: "official_handoff",
    guide: {
      system: "property_reader_actions",
      mode: "historical",
      actions: [{ kind: "review_documents", status: "historical" }],
    },
  }], OUTCOME_ENUM), null);
});

test("an unavailable future handoff is not treated as a passed action", () => {
  const unavailable = {
    type: "attend",
    delivery: "unavailable",
    deadline: "2026-08-20T18:00:00.000Z",
  };
  assert.equal(outcomePromptContext([unavailable], OUTCOME_ENUM, { today: "2026-08-04" }), null);
  assert.deepEqual(outcomePromptContext([unavailable], OUTCOME_ENUM, { today: "2026-08-21" }), {
    trigger: "passed_action",
    outcomes: ["attended", "not_useful"],
  });
});

test("the optional prompt has bounded choices, no free text, and an explicit privacy boundary", () => {
  const t = (key) => ({
    outcome_prompt_heading: "Did you take part?",
    outcome_prompt_lead_handoff: "When you return, you can share what happened.",
    outcome_prompt_lead_passed: "If you took part before this closed, you can share what happened.",
    outcome_prompt_self_report: "This is your optional self-report, not an official result.",
    outcome_prompt_privacy: "CityScroll keeps only a 90-day aggregate count — no notice ID, account, or free text.",
    outcome_prompt_submitted: "I submitted",
    outcome_prompt_attended: "I attended",
    outcome_prompt_bid: "I placed a bid",
    outcome_prompt_won: "I won",
    outcome_prompt_not_useful: "This was not useful",
    outcome_prompt_not_now: "Not now",
  })[key] || key;
  const html = outcomePromptHTML({
    trigger: "official_handoff",
    outcomes: [...OUTCOME_ENUM],
  }, { t });
  assert.match(html, /data-action-outcome-prompt="official_handoff"/);
  assert.equal((html.match(/data-outcome-choice=/g) || []).length, OUTCOME_ENUM.length);
  assert.match(html, /90-day aggregate count/);
  assert.match(html, /not an official result/);
  assert.doesNotMatch(html, /<(?:input|textarea|select)\b/i);
});

test("completion and abandonment stay separate aggregate events", () => {
  const calls = [];
  const analytics = { record: (event, dimensions) => calls.push({ event, ...dimensions }) };
  const registry = { outcomeEvent };

  assert.equal(recordActionOpened({ analytics }), true);
  assert.equal(recordOutcomePrompted("official_handoff", { analytics }), true);
  assert.equal(recordOutcomeChoice("bid", { analytics, registry }), true);
  assert.equal(recordOutcomeChoice(null, { analytics, registry }), false);
  assert.equal(recordOutcomeDismissed("passed_action", { analytics }), true);
  assert.deepEqual(calls, [
    { event: "action_opened", detail: "official-handoff", surface: "home" },
    { event: "outcome_prompted", detail: "official-handoff", surface: "home" },
    { event: "outcome_recorded", detail: "bid", surface: "home" },
    { event: "outcome_dismissed", detail: "passed-action", surface: "home" },
  ]);
});

test("notice and land rails bind the shared optional prompt instead of collecting outcomes inline", () => {
  const source = readFileSync(new URL("../site/app/feed-actions.mjs", import.meta.url), "utf8");
  assert.match(source, /const ACTION_OUTCOME_PROMPT_ENABLED = false/);
  assert.doesNotMatch(source, /export const ACTION_OUTCOME_PROMPT_ENABLED/);
  assert.match(source, /import\("\.\.\/action_outcome_prompt\.mjs"\)/);
  assert.match(source, /bindActionOutcomePrompt/);
  assert.match(source, /data-action-outcome-slot/);
  assert.doesNotMatch(source, /outcome_recorded/);
});
