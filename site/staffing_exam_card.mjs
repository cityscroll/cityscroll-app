/**
 * Shared presentation shell for civil-service exam cards.
 *
 * Staffing owns the card's data assembly and interactions; static object-family
 * documents can compose the same shell around build-time snapshot facts.
 */
export function renderStaffingExamCard({
  examNumber,
  examFormat = "",
  salaryBand = "",
  feeLevel = "",
  status,
  statusMarkup,
  openBandMarkup = "",
  noeMarkup = "",
  promotionMarkup = "",
  deadlineMarkup = "",
  countdownMarkup = "",
  titleMarkup,
  examNumberMarkup,
  titleFamilyMarkup = "",
  actionFactsMarkup = "",
  summaryMarkup = "",
  detailsMarkup = "",
  processMarkup = "",
  outcomesMarkup = "",
  utilizationMarkup = "",
  actionsMarkup = "",
  selected = false,
}) {
  const id = String(examNumber || "");
  const selectedClass = selected ? " selected route-item" : "";
  const selectedAttrs = selected ? ' tabindex="-1"' : "";
  return `<article class="career-card${selectedClass}" data-status="${status}" data-exam-format="${examFormat}" data-salary-band="${salaryBand}" data-fee-level="${feeLevel}" id="career-exam-${id}"${selectedAttrs}>
    <div class="career-deadline-lead">
      ${statusMarkup}${openBandMarkup}${noeMarkup}${promotionMarkup}
      <p class="career-deadline-primary">${deadlineMarkup}</p>
      ${countdownMarkup}
    </div>
    <div class="career-card-head">
      <p class="career-card-title">${titleMarkup}</p>
      <span class="career-exam-number">${examNumberMarkup}</span>
    </div>
    ${titleFamilyMarkup}
    ${actionFactsMarkup}
    ${summaryMarkup}
    ${detailsMarkup}
    ${processMarkup}
    ${outcomesMarkup}
    ${utilizationMarkup}
    <div class="actions">${actionsMarkup}</div>
  </article>`;
}

export function renderStaffingExamResultGroup({ id, label, cards }) {
  if (!cards) return "";
  return `<section class="career-result-group" data-career-group="${id}" aria-labelledby="career-group-${id}">
    <h3 id="career-group-${id}">${label}</h3>
    <div class="career-result-grid">${cards}</div>
  </section>`;
}
