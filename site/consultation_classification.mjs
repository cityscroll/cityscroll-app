export const CONSULTATION_CLASSIFICATION_SCHEMA = "cityscroll.consultation_classification.v1";

export function classifyConsultationCandidate(candidate = {}) {
  const text = `${candidate.title || ""} ${candidate.description || ""}`.toLowerCase();
  if (/signup|sign up|notify|future survey/.test(text)) return { kind: "not_consultation", reason: "notification_signup" };
  if (/application|intake|adu/.test(text)) return { kind: "not_consultation", reason: "program_application" };
  if (/completed engagement|community report/.test(text)) return { kind: "not_consultation", reason: "completed_engagement" };
  if (/hearing|meeting|testimony/.test(text)) return { kind: "meeting", reason: "formal_meeting" };
  if (candidate.accepted === false || candidate.readable === true && candidate.accepted == null) return { kind: "consultation", reason: "readable_acceptance_unconfirmed" };
  return { kind: "consultation", reason: "organizer_invitation" };
}

export function isOpenConsultation(candidate) {
  return classifyConsultationCandidate(candidate).kind === "consultation" && candidate.deadline?.value !== null && candidate.open_now === true;
}
