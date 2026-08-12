# CityScroll

CityScroll searches New York City's public-record notices — City Record Online plus joined
city data, more than 1 million entries from 2003 to the present — across contracts, zoning,
property, staffing, meetings, and rules. It links related records that describe the same
real-world procurement, rezoning, or agency across those separate city systems, and it can
send an email alert when new notices match a saved search.

*   **Use it:** [cityscroll.org](https://cityscroll.org/)
*   **About:** [cityscroll.org/about.html](https://cityscroll.org/about.html)
*   **System Stats:** [cityscroll.org/stats.html](https://cityscroll.org/stats.html)

![CityScroll homepage — contracts, staffing, zoning, property, meetings, and rules, all in one place](docs/readme/homepage.png)

[**Open it →**](https://cityscroll.org/)

---

## Examples

The stops below mirror the live site's primary navigation. Each opens a real scope on
[cityscroll.org](https://cityscroll.org/).

### Now — start with the clock

Now separates deadlines from events. Act-by dates for bids, applications, and comments sit in
one lane; upcoming hearings, meetings, and auctions in another — so what needs attention is
never buried in a flat list.

Open [Now](https://cityscroll.org/now/), or a [live bid deadline](https://cityscroll.org/notices/20260624023).

### Near you — add a place

The map is a facet, not a detour. Topic, keyword, borough, neighborhood, and language stay
attached whether results show as a list or on the map, so changing views never means starting
over.

Open [Near you](https://cityscroll.org/near-you/), or the same scope as a
[Property auction list in Brooklyn near Canarsie](https://cityscroll.org/near-you/?v=0&lens=property&q=auction&boro=Brooklyn&neighborhood=Canarsie&lang=es).

### Following — save the scope

Following is the control center for saved scopes: exact terms, a live preview, and the email
schedule in one place. A watch can start in Browse, Now, or Near you and land here unchanged;
accounts with several watches get one consolidated morning email.

Open [Following](https://cityscroll.org/following/), or a
[Council District 33 weekly brief](https://cityscroll.org/following/?lens=district&filter=%7B%22councilDistrict%22%3A%2233%22%7D&freq=weekly).

### Browse — six civic domains

Browse groups city work into six civic domains. Each one has its own filters, exports, and record details:

[Contracts](https://cityscroll.org/browse/) · [Staffing](https://cityscroll.org/browse/staffing/) · [Zoning](https://cityscroll.org/browse/zoning/) · [Property](https://cityscroll.org/browse/property/) · [Rules](https://cityscroll.org/browse/rules/) · [Meetings](https://cityscroll.org/browse/meetings/)

Record pages lead with plain meaning, a concrete next step, and a process timeline before the
full source text. Open a [live Property notice](https://cityscroll.org/notices/20260526003) —
plain-language summary, action panel, and disposition timeline on one page (also in
[Spanish](https://cityscroll.org/notices/20260526003?lang=es)).

### One scope, three views

The same filters travel between surfaces without re-entering anything. Try Property + auction +
Brooklyn + Canarsie in [Browse](https://cityscroll.org/browse/property/?q=auction&boro=Brooklyn&neighborhood=Canarsie),
[Near you](https://cityscroll.org/near-you/?v=0&lens=property&q=auction&boro=Brooklyn&neighborhood=Canarsie&lang=es),
and [Following](https://cityscroll.org/following/?lens=property&filter=%7B%22keywords%22%3A%5B%22auction%22%5D%2C%22borough%22%3A%22Brooklyn%22%2C%22neighborhood%22%3A%22Canarsie%22%7D&lang=es).

### Compose a trail

The links on a record can be combined instead of starting a new search. Try an [HPD contract scope](https://cityscroll.org/browse/contracts/?facet=%7B%22entity_refs_all%22%3A%5B%22agency%3Aid%3Ahousing-preservation-and-development%22%5D%7D), a [Timbale Terrace project constellation](https://cityscroll.org/browse/contracts/?facet=%7B%22entity_refs_all%22%3A%5B%22agency%3Aid%3Ahousing-preservation-and-development%22%2C%22project%3A2022M0258%22%5D%7D), or [follow that HPD scope](https://cityscroll.org/following/?lens=money&filter=%7B%22entity_refs_all%22%3A%5B%22agency%3Aid%3Ahousing-preservation-and-development%22%5D%7D). Each link keeps the typed connection in the URL so the next view can use it.

Cross-category agency constellations gather one agency across contracts, meetings, rules, statutory mandates, and staffing exams — same parcel-style “connected records by civic process” shape. Demo: [Parks and Recreation](https://cityscroll.org/agencies/parks-and-recreation/) (`agency:id:parks-and-recreation`), with per-category Browse scopes, statutory mandates (agency → duty → deadline → recurrence with source-law links), and free watches for public notices or mandate deadlines (optional deliverable type / deadline window). Agency renames densify from the OTI roster’s former names plus a small reviewed residual map so one constellation route stays stable when the city’s spelling changes.

### From notices to a civic graph

CityScroll is organized around the thing a record is about, not just the system that published it. Typed `◆` constellation links let you pivot among agencies, vendors, projects, parcels, and officials. The public entity graph connects related records across money, land, property, rules, meetings, people, and franchise data without merging the underlying publisher records.

The graph includes exact-key joins for authority keys, contract IDs, BBLs, and ULURP/project identifiers, plus measured relation links for statutory mandates to rules, meetings, contracts, and land-use actions. Every published connection carries provenance. Candidates that do not clear the relation’s precision gate remain evidence-only and are not presented as a fact. Mandate-to-entity edges are mandate-specific when a reliable join exists; where per-mandate coverage is sparse, the page keeps honest agency-wide Browse scopes rather than inventing per-duty connections.

The **Civic Graph** registry (`ontology/registry.v0.json`) is the backstage catalog of civic objects, links, and actions with grounding labels (`built` / `partial` / `gap`). A multi-dimension evaluation harness scores coverage and emits ranked enrichment cards when metrics show a real gap — engineering infrastructure, not a public product surface. Overview: [`docs/civic-graph.md`](docs/civic-graph.md).

### Officials, votes, and influence

Council member identity is a **person hub**: Open Data Council Members (`uvw5-9znb`) binds `council_member_id` to Legistar `PersonId`, so an official profile can carry district/term, retained roll-call votes, and measured influence edges. Demo: [official 7801](https://cityscroll.org/#official/7801) (recent votes) or the same id scoped to a hearing via `?notice=` / `?event=`.

When Legistar publishes `VotePersonId` / `VotePersonName` rows, meeting outcomes keep person-level roll call (`roll_call`); when rows lack identity, the UI stays `tally_only` and does not invent names. Lobby targets (City Clerk eLobbyist) and campaign-finance recipients (CFB contributions) join only on exact unique person-name keys after usefulness and precision gates clear — partial coverage is labeled, not padded.

### Follow the dollars

Procurement notices that join a registered Checkbook contract can show paid-to-date and individual payment rows on the lifecycle timeline and the notice **Follow the dollars** panel. Spending is joined by `contract_id` after the Contracts-domain seed (Checkbook Spending rejects PIN filters). Payment retention is population-backed and gate-measured; empty or unmatched stages stay classed as not-yet-shown or not-published rather than a confident zero.

Planning context for identifier-bearing MOCS Local Law 63 / Local Law 1 plan rows can attach when a receipt-backed plan→PASSPort prefix join clears the same usefulness/precision bars; capital-dashboard bridges remain stopped.

### The Civic Time Ledger

Entity pages can be read **as of** a date using the record’s valid or publication time. The resulting URL is shareable, and missing system-history clocks stay missing rather than being inferred from when CityScroll built its data. Try the [Parks and Recreation constellation](https://cityscroll.org/agencies/parks-and-recreation/) and add `?as_of=2024-06-01`.

### Attachments count

When a notice’s useful details live in a DOCX or text-layer PDF, CityScroll can extract the attachment text and tables, add that content to notice search, and show it in a collapsed detail section with attachment provenance. Image-only PDFs and unsupported formats remain explicit gaps.

### Honest about missing data

Empty lifecycle slots say **which kind of gap** they are: not yet joined from a public
source, or not published by the city at all — never a blank “unknown.” The
[API page](https://cityscroll.org/api.html) links the public delivery surfaces and
describes what feeds are live and how they are used. The generated source register is
[`docs/data-sources.md`](docs/data-sources.md) (from `site/data/source_contracts.json`).
External data products that need complete City Record source rows can follow the
[bulk and incremental corpus access guide](docs/city-record-corpus-access.md).

City Record is one input to this work, not the destination of every path. The reader surface
starts with civic entities, places, questions, and actions; source details remain available as
evidence when they help explain a connection.
