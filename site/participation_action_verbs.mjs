/**
 * PHC-03 — verb-by-verb binding from PHC-00's evidence-gated participation
 * modes to the specific action a reader can actually take.
 *
 * site/consequence_projection.mjs already computes `participation_modes`
 * with independent, per-mode evidence (site/consequence_projection.mjs's
 * participationSignals()): a recognized video-conference join URL for
 * `join_remote`, a published venue address for `attend_in_person`, a
 * broadcast/livestream URL for `watch`, a published testimony-signup URL for
 * `register_to_testify`, and a testimony email or open comment channel for
 * `submit_written`. This module adds no new signal and infers nothing beyond
 * that evidence — it only turns the mode the projection already proved into
 * the verb a reader sees, one action per mode. A recognized attendee
 * destination becomes "Join remotely"; nothing weaker becomes that same
 * verb. A broadcast-only destination stays "Watch" rather than being
 * silently dropped or promoted. Written testimony renders as its own action
 * even when attendance itself is never evidenced, and a hearing with both
 * physical and remote evidence gets one action per mode rather than one
 * verb replacing the other.
 */

import { PARTICIPATION_MODES } from "./consequence_projection.mjs";

export const PARTICIPATION_ACTION_VERBS = Object.freeze({
  watch: "Watch",
  attend_in_person: "Attend in person",
  join_remote: "Join remotely",
  register_to_testify: "Register to testify",
  submit_written: "Submit written testimony",
});

// Evidence bases whose source_url is itself the destination for that action
// (a join URL, a livestream URL, a signup URL, an open comment channel).
// A basis outside this set (a venue address, or an email cited only by the
// notice page) still proves the mode, but its evidence source_url is the
// notice page itself, not a channel-specific destination — rendering that
// as the action's link would misattribute the notice as the action target.
const LINKABLE_EVIDENCE_BASES = Object.freeze(new Set([
  "recognized_video_conference_join_url",
  "published_livestream_url",
  "published_testimony_signup",
  "open_comment_submission_channel",
  "published_comment_channel",
]));

function evidenceForMode(projection, mode) {
  const evidence = Array.isArray(projection?.evidence) ? projection.evidence : [];
  return evidence.find((entry) => entry?.field === `participation_modes:${mode}`) || null;
}

/**
 * One action per participation mode the projection itself evidenced, in the
 * projection's own mode order. Never collapses two modes into one action,
 * never upgrades a weaker mode's evidence into a stronger verb, and never
 * invents a destination: a mode without its own evidence entry is skipped
 * rather than rendered with a guessed basis, and `href` is exactly that
 * evidence entry's `source_url` (which may be null).
 */
export function participationActionVerbs(projection) {
  const modes = Array.isArray(projection?.participation_modes) ? projection.participation_modes : [];
  const actions = [];
  const seen = new Set();
  for (const mode of modes) {
    if (seen.has(mode) || !PARTICIPATION_MODES.includes(mode)) continue;
    seen.add(mode);
    const evidence = evidenceForMode(projection, mode);
    if (!evidence) continue;
    actions.push({
      mode,
      verb: PARTICIPATION_ACTION_VERBS[mode] || mode,
      href: evidence.source_url || null,
      linkable: LINKABLE_EVIDENCE_BASES.has(evidence.basis),
      basis: evidence.basis,
    });
  }
  return actions;
}
