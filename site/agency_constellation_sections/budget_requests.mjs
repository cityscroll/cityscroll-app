/**
 * "Community board budget requests this agency answers" on an agency profile.
 *
 * An agency page already says what the institution buys, who works there and
 * what it is obliged to publish. It did not say what the city's 59 community
 * districts have formally asked it for, or what answer it gave them — which is
 * the one thing a resident arriving from their own board most wants to check.
 *
 * The reading is the same one the board pages use
 * (`site/community_board_budget_requests.mjs`), over the same retained
 * register, so the two surfaces cannot disagree about which requests exist.
 * The agency side states the whole population and lists every board that asked;
 * it hands off to each board's own page for that board's full list, in that
 * board's own priority order, rather than re-ranking other people's requests
 * into an order the publisher does not hold.
 */

import { renderAgencyBudgetRequestsSection } from "../community_board_budget_requests.mjs";

export const budgetRequestsSection = Object.freeze({
  id: "budget-requests",
  order: 46,
  // Written into the document rather than fetched with the other relationship
  // sections. Two reasons, and both matter here. A resident who arrives from
  // their own board must be able to read what the agency answered with
  // scripting off, the way they can on the board page. And this reading is
  // large: leaving it in the deferred fragment would push every district's
  // requests into the committed relationship artifacts of every agency that
  // answers one.
  static: true,
  render: (view) => renderAgencyBudgetRequestsSection(
    view.displayView?.budget_requests || view.view?.budget_requests || null,
  ),
});
