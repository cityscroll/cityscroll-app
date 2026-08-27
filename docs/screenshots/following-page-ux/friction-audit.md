# Following flow friction audit

The anonymous click-through used the public `/following/` route at 390px and 1440px. It selected “Hearings and meetings,” opened the refinement controls, entered `curb` and `Transportation`, and refreshed the preview without submitting an email address.

Observed friction and the corresponding reduction:

- The homepage presented an email form, a second topic link, and a separate onboarding redirect. The email form is now one clear link into Following, where topic selection and the single opt-in submit live together.
- Following showed both a watch-identity sentence and the same sentence again in the criteria panel. The criteria panel now keeps the exact chips and count; the identity panel owns the plain-language rule.
- After a watch was already previewed, the action still said “Preview matches.” It now says “Update matches” for an existing scope so the action describes the next step.
- Refining keyword and agency fields changed the rule sentence, but the browser URL stayed on the prior scope. Refreshing or sharing at that point could lose the refinement. The enhancement now replaces the URL after a successful preview, while the no-JavaScript form path remains available.
- The create form said “We send one link first. Click it to start the watch,” which implied a confirmation step despite immediate single-opt-in enrollment. That instruction is removed.
- Delivery guidance repeated quiet-period, edit-timing, and unsubscribe details at the point of action. The action now keeps the short cadence expectation: daily sends when there are matches; weekly digest sends Monday.

The flow stops at the email field for the audit; no address is submitted and no account is used.
