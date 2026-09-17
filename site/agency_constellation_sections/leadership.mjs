/**
 * "Who leads this agency?" on the agency profile itself.
 *
 * Leadership is already published through the entity dossier and relationship
 * capabilities. Residents open the agency page, so the same retained officer
 * statement is rendered here — including an explicit not-recorded answer when
 * the registered datasets name nobody.
 */

import {
  AGENCY_PAGE_LEADERSHIP_STYLE,
  renderAgencyPageLeadership,
  resolveAgencyPageLeadership,
} from "../agency_page_leadership.mjs";

export const leadershipSection = Object.freeze({
  id: "leadership",
  order: 2,
  // Written into the document rather than deferred with relationship sections.
  // A resident opening an agency page must see who leads it with scripting off,
  // and must see a stated absence rather than a missing section.
  static: true,
  render(view) {
    const constellation = view?.displayView || view?.view || view;
    return renderAgencyPageLeadership(resolveAgencyPageLeadership(constellation));
  },
  styleOrder: 2,
  style: AGENCY_PAGE_LEADERSHIP_STYLE,
});
