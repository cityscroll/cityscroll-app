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

### Browse — six lenses

Browse holds the six source lenses — each with its full filters, exports, and record details:

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

Cross-category agency constellations (first iteration) gather one agency across contracts, meetings, rules, and staffing exams — same parcel-style “records by source” shape. Demo: [Parks and Recreation](https://cityscroll.org/agencies/parks-and-recreation/) (`agency:id:parks-and-recreation`), with per-category Browse scopes and a City Record entity follow.

### Honest about missing data

Empty lifecycle slots say **which kind of gap** they are: not yet joined from a public
source, or not published by the city at all — never a blank “unknown.” The
[API page](https://cityscroll.org/api.html) links the public delivery surfaces and
describes what feeds are live and how they are used. External data products that need
complete City Record source rows can follow the
[bulk and incremental corpus access guide](docs/city-record-corpus-access.md).
