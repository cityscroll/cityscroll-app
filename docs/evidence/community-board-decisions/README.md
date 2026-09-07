# Decisions read from a board's own published documents

A board's minutes were already reachable. Reading them was still on the resident:
a set of minutes records committee votes, amendments, referral motions that
failed, and omnibus votes taken on everything except a named item, and picking
the wrong one turns a public record into misinformation. This record holds the
served evidence for the section that publishes the decision instead — the
board's own operative words with the tally that belongs to them.

Regenerate with:

```sh
node tools/build_community_board_resolution_pilot.mjs
node tools/build_community_board_constellation_documents.mjs
tools/prepare_functional_site.sh
python3 tools/capture_community_board_decisions_evidence.py
```

The capture writes [`capture-manifest.json`](capture-manifest.json) and exits
non-zero if a violation appears inside the section. No image binary is committed:
each entry carries the route, the viewport, the repository revision, the data
vintage, the assertion, and the sha256 of both the capture and the rendered
section.

## What is published, and what is not

The reading is bounded to four documents that were opened one at a time:
Manhattan Community Board 3's May 2026 full-board minutes and its July 2026 vote
sheet, and Brooklyn Community Board 15's May 26 and June 30 2026 general board
minutes. Every candidate found in them is retained. Two are published.

- **A bicycle lane on St. Marks Place.** Manhattan Community Board 3 supported a
  continuous five-foot lane from Third Avenue to Avenue A and the removal of a
  parking lane on the north side between 2nd and 3rd Avenues, 34–1–0 with none
  present and not voting. The same meeting recorded five other tallies. Three of
  them are the ones a nearest-match reading would take: a referral motion on
  another item that failed 3–28–2, an amendment to another item that passed
  32–2–1, and an omnibus vote that passed 35–0–0 *excluding* items 2, 3 and 4.
  The page shows all five beside the decision and says why none of them is it.
- **A Board of Standards and Appeals case at 730 Avenue S.** Brooklyn Community
  Board 15's zoning committee voted 10–0–0 and the full board voted 29–0–0 on
  case 154-90-BZII, a lobby enclosure added to an existing variance. Both stages
  are shown; neither replaces the other. The case stays in the Board of Standards
  and Appeals family, so the page states that no ULURP timetable applies. A
  question about impact glass, answered by saying the material was not yet chosen,
  is retained as discussion and never rendered as an adopted condition.

Twenty-three candidates are held, each with the reason. Nine come from the July
vote sheet, which states a month and no meeting day: nothing from it is published,
because no event identity is guessed for a document that does not carry one. One
is held because the board's own agenda and its own resolution spell the address
three ways — 106 Bayard Street, 75 Baxter Street and 103 Bayard Street — and
choosing among them would publish a building the source never agreed on. Held
candidates never enter `site/`; they are read only through the operator key at
`/admin/board-resolution-review`.

Nothing here claims what the city did afterwards. A board position is a board
position.

## What the captures show

Each of the two boards is read back at 390×844 and 1440×900, three ways: loaded,
with JavaScript disabled, and with the stylesheet failing to load. A reader on
any of those gets the decision, every tally, the quoted passage and a real link
to the published document, because the passage and the excluded tallies are in
the served markup and the stylesheet only collapses them.

The journey is walked on the narrow viewport: focus the inspect control from the
keyboard, press Enter, press Escape, leave for another page, press the browser's
own Back, and find the expansion, the fragment and the scroll offset where they
were left; then dismiss, and land back on the decision rather than somewhere
else. That is why the expansion is addressed by a fragment rather than held in a
`<details>` element — a browser restores a history entry's URL and scroll offset,
not an element's open state.

A board outside the four documents is captured too. It renders no section at all,
rather than an empty one that would read as "this board decided nothing".

The translated renders are recorded separately, from the module that produces the
section, because the board documents are built in English. Every shipping
language is checked for resolved copy, a declared language and direction, and
publisher text — the case number, the authority, the quoted passage — that stayed
in the language it was published in and kept its own direction inside a
right-to-left page.

## One violation that is not this section's

Whole-page axe reports `definition-list` on every board page, including boards
outside this reading that carry no decisions section. It comes from the money
card's `dl.community-board-money-metrics` and predates this work. The manifest
keeps it, attributed, rather than filtering it out of sight; the capture gates
only on violations inside the decisions section.
