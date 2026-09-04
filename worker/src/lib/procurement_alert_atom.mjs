// Worker re-export of the shared procurement alert atom module (email + site preview).
// Source of truth: site/procurement_alert_atom.mjs
export {
  PROCUREMENT_ALERT_TITLE_BUDGET,
  PROCUREMENT_ALERT_SUBJECT_BUDGET,
  PROCUREMENT_ALERT_BODY_STEPS,
  escapeSubjectText,
  escapeSubjectHtml,
  recognizableTitle,
  agencyAbbreviation,
  buildProcurementAlertAtom,
  selectLeadProcurementAtom,
  procurementAlertSubjectSegment,
  procurementAlertSubject,
  buildProcurementAlertBodySections,
} from "../../../site/procurement_alert_atom.mjs";
