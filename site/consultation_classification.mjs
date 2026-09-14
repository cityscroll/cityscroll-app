import { CONSULTATION_PILOT_SEEDS } from "./consultation_publisher_adapters.mjs";

export const CONSULTATION_CLASSIFICATION_SCHEMA = "cityscroll.consultation_classification.v1";

export const NEGATIVE_CLASSIFICATION_FIXTURES = Object.freeze([
  { id: "mta-notification-signup", title: "MTA customer research signup", expected: "not_consultation", lifecycle: "signup" },
  { id: "hpd-plus-one-adu", title: "HPD Plus One ADU application intake", expected: "not_consultation", lifecycle: "application" },
  { id: "pacific-library-completed-engagement", title: "Pacific Library future completed engagement", expected: "not_consultation", lifecycle: "completed" },
  { id: "cb14-budget-hearing", title: "CB14 budget hearing", expected: "meeting", lifecycle: "scheduled" },
]);

export function classifyConsultationCandidate(candidate = {}) {
  const text = `${candidate.title || ""} ${candidate.description || ""}`.toLowerCase();
  if (/signup|sign up|notify|future survey/.test(text)) return { kind: "not_consultation", reason: "notification_signup" };
  if (/application|intake|adu/.test(text)) return { kind: "not_consultation", reason: "program_application" };
  if (/completed engagement|community report/.test(text)) return { kind: "not_consultation", reason: "completed_engagement" };
  if (/hearing|meeting|testimony/.test(text)) return { kind: "meeting", reason: "formal_meeting" };
  if (candidate.accepted === false || candidate.readable === true && candidate.accepted == null) return { kind: "consultation", reason: "readable_acceptance_unconfirmed" };
  return { kind: "consultation", reason: "organizer_invitation" };
}

export function classifyPilotFixtures() {
  return { schema: CONSULTATION_CLASSIFICATION_SCHEMA, positive_count: CONSULTATION_PILOT_SEEDS.length, negative_controls: NEGATIVE_CLASSIFICATION_FIXTURES.map((fixture) => ({ ...fixture, classification: classifyConsultationCandidate(fixture) })) };
}

export function isOpenConsultation(candidate) {
  return classifyConsultationCandidate(candidate).kind === "consultation" && candidate.deadline?.value !== null && candidate.open_now === true;
}
