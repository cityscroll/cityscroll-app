# Compact guide articles

The audited baseline is the rendered guide at revision 67adff8bb8331df0cdfd3be1ee380815206f0b0e.
The baseline was recorded before editing; [the retained counts](compact-article-baseline.json)
cover all articles present at that revision.

The editorial scope is the existing three tutorials, eight how-tos, four explanations
and three reference pages. An additional budget-request how-to was already published
at the audited revision. Its body is preserved; it shares the shorter article header.
No article was added or removed.

## Word counts

Measured with `guideWordCounts` in [the counter](../../../tools/guide_word_counts.mjs).
Words are Unicode letter/number runs with internal apostrophes or hyphens kept together.
Main path includes the outcome, former reader question, article notices and visible body;
it excludes title, type, review date, navigation, related/source lists and URL destinations.
Total body counts the rendered article body, including headings, lists, tables and any
disclosure contents. There are no disclosures in these revised procedures: reductions
come from deleting or shortening prose, not hiding it.

| Article | Type | Main before | Main after | Body before | Body after | Main reduction |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| [What a public record tells you](https://cityscroll.org/guide/understand/what-a-public-record-tells-you/) | explanation | 1097 | 1047 | 1074 | 1032 | 4.6% |
| [How records are connected](https://cityscroll.org/guide/understand/how-records-are-connected/) | explanation | 588 | 548 | 559 | 528 | 6.8% |
| [What dates and blanks mean](https://cityscroll.org/guide/understand/dates-and-missing-information/) | explanation | 663 | 627 | 631 | 606 | 5.4% |
| [Flags and historical patterns](https://cityscroll.org/guide/understand/flags-and-historical-patterns/) | explanation | 736 | 701 | 701 | 678 | 4.8% |
| [Find and narrow records](https://cityscroll.org/guide/how-to/find-and-narrow-records/) | how-to | 1056 | 334 | 1021 | 320 | 68.4% |
| [Follow a search and manage your updates](https://cityscroll.org/guide/how-to/follow-a-search/) | how-to | 1051 | 399 | 1015 | 384 | 62.0% |
| [Follow a Community Board](https://cityscroll.org/guide/how-to/follow-a-community-board/) | how-to | 1094 | 337 | 1068 | 322 | 69.2% |
| [Put dates in your calendar](https://cityscroll.org/guide/how-to/put-dates-in-your-calendar/) | how-to | 1128 | 387 | 1095 | 369 | 65.7% |
| [Read a land-use project's next step and documents](https://cityscroll.org/guide/how-to/read-a-land-use-projects-next-step/) | how-to | 990 | 360 | 958 | 349 | 63.6% |
| [Check the evidence behind a connection](https://cityscroll.org/guide/how-to/check-the-evidence-behind-a-connection/) | how-to | 804 | 288 | 771 | 277 | 64.2% |
| [Look at records as of a day](https://cityscroll.org/guide/how-to/look-at-records-as-of-a-day/) | how-to | 848 | 288 | 803 | 275 | 66.0% |
| [Collect records, add notes, and export them](https://cityscroll.org/guide/how-to/collect-records-and-export-them/) | how-to | 1027 | 363 | 987 | 349 | 64.7% |
| [Read a budget request and the answer to it](https://cityscroll.org/guide/how-to/read-a-budget-request-and-the-answer/) | how-to | 1546 | 1530 | 1503 | 1503 | 1.0% |
| [Glossary](https://cityscroll.org/guide/reference/glossary/) | reference | 945 | 880 | 921 | 861 | 6.9% |
| [Controls and what they give you](https://cityscroll.org/guide/reference/controls-and-outputs/) | reference | 1214 | 1121 | 1185 | 1108 | 7.7% |
| [Where the records come from](https://cityscroll.org/guide/reference/sources-and-coverage/) | reference | 759 | 702 | 732 | 684 | 7.5% |
| [Explore housing across city records](https://cityscroll.org/guide/start/explore-housing-across-city-records/) | tutorial | 1061 | 344 | 1029 | 328 | 67.6% |
| [Trace a notice to the duty behind it](https://cityscroll.org/guide/start/trace-a-notice-to-the-duty-behind-it/) | tutorial | 1035 | 322 | 992 | 308 | 68.9% |
| [Trace an award and keep the trail](https://cityscroll.org/guide/start/trace-an-award-and-keep-the-trail/) | tutorial | 1063 | 444 | 1017 | 426 | 58.2% |

## Why the removed text is unnecessary

- All eleven procedures now begin with one outcome and an executable step. Setup remains
  in place; repeated purpose paragraphs, checkpoint restatements and closing recaps were
  deleted. Their information remains in the action and its adjacent result.
- The board picker explains borough-qualified identity and the Council distinction in
  place. District-matching mechanics were deleted from the procedure. The consequential
  difference between the watch preview and the wider district view remains at Preview matches.
- The calendar procedure keeps both paths, the conditions revealing each control, the app
  actions and the external confirmation limit. Repeated introductions to the two paths
  were deleted. No refresh-time promise is needed to complete the task.
- Search and housing retain grouping, an agency, a rule, source checking and a repeatable
  URL. The housing procedure now distinguishes proposed and final rules. Filter directions
  name Search, More filters and Affected area as the Meetings interface actually does.
- Duty and connection procedures retain source checks, named relation labels and the
  publication-versus-compliance distinction. Repeated institutional framing was deleted;
  optional background remains with the existing connection explanation.
- The award tutorial names the connection sequence and requires checking both steps before
  copying. Its prepared example is explicitly a reference, not proof of a successful click path.
- As-of retains apply, later records, copy/reopen and clear. Date semantics remain beside
  Apply and in the existing dates explanation; its misleading historical-snapshot wording
  was corrected.
- Collections retain pin, notes, reload, exports, print, share and clear. The sharing step
  states that notes leave the device and become accessible to anyone holding the link.
  Repeated storage summaries were deleted; the controls reference's conflicting claim that
  pins never travel across devices was corrected.
- All seven supporting articles were reviewed. Redundant introductions and editorial
  commentary were shortened; definitions, source tables, canonical formula links and
  consequential distinctions remain. No background article was added to absorb repetition.

## Control and route checks

Labels were checked against the existing product owners: Following view and preferences,
Meetings and Land controls in the application document, calendar subscription view,
connection evidence view, and the English investigation labels. The existing mandate
record family was missing from the closed destination inventory used by the guide builder.
Adding it permits an actual mandate document link; a focused test retains rejection of
missing identifiers, extra path segments and unsupported route families.

## Rendered evidence and limits

[Capture manifest](compact-articles/capture-manifest.json) records routes, viewports,
revision, data vintage, assertions and image hashes. Image files remain outside tracked
content. The capture checks static guide rendering, accessibility, links and navigation;
it does not certify live account mutations or prove a reader-created award trail.
Illustrations, translation parity and the integrated product journey remain separate work.
Editorial review dates were not advanced by a rebuild or a source-label check.
