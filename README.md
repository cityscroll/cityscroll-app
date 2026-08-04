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

## Capabilities

CityScroll links the same real-world object — a contract, a rezoning, an agency — across the
separate city systems that each publish a piece of it, and pairs that link with a concrete next
step: respond to a solicitation, testify at a hearing, follow a payment, track a process, or set
an alert. The examples below point at shipping product URLs on
[cityscroll.org](https://cityscroll.org/).

### 1. Cross-domain civic intelligence — one agency across money, land, rules, and meetings

Agency profiles are more than a City Record notice list. A linked-object panel groups
**contracts and awards, rezonings and tax-lot projects, rulemakings, and hearings** for the
same agency — each object named, dated when known, and stamped with source provenance so you
can see *why* it is linked. District context, vendor links, and meeting outcomes stay connected
when the source graph has enough confidence.

This is the product’s clearest “one real-world organization, every domain it touches”
surface — the scatter of Open Data portals does not offer it.

**Live example:** [Parks and Recreation](https://cityscroll.org/#agency/Parks%20and%20Recreation)
(agency profile with multi-domain linked objects when the materialization covers that agency).

Related: pivot from any notice to the [vendor](https://cityscroll.org/#vendor/Community%20Mediation%20Services%2C%20Inc.)
or agency named on it; notice pages also treat notice ↔ PIN ↔ registered contract as linked
objects so the procurement story stays one object, not four browser tabs.

### 2. Next steps extracted — not “see the official notice”

When something is actionable, CityScroll leads with **what to do**, parsed from the ingested
notice and joined portals:

*   **Open solicitations** open with a **“What can I do now?”** rail: due date, method,
    contacts, package/submit URL when the body publishes one, and a PASSPort RFx deep link
    when the EPIN joins — never a vague “use the response instructions in the notice.”
*   **Public hearings** open with **how to participate**: venue, online join when published,
    testimony email and cutoff when the body states them, and contact lines — not an empty
    “no online link” dead end when the notice already printed the steps.

**Live examples:**

*   [Bus transportation for DHS shelter clients](https://cityscroll.org/#notice/20260629024)
    (solicitation rail + PASSPort RFx when joined)
*   [Parks concession hearing with participation steps](https://cityscroll.org/#notice/20260716022)

Browse more open RFPs: [Money · open solicitations closing this week](https://cityscroll.org/#money?mode=open&closing=week)

### 3. Phase-grouped timelines and predictions — dense civic histories with explicit uncertainty

Long paper trails collapse onto **canonical phase walls** instead of a flat milestone dump:

*   **Money:** Solicitation → Selection → Award and registration → Payments, with repeated
    links deduped and verbatim-repeated milestones aggregated. Action-first on the current
    phase; earlier phases under disclosure.
*   **Land (ULURP-oriented):** pre-application through community board, Borough President,
    City Planning Commission, Council, and mayoral/appeals — over a ZAP + City Record event spine.
*   **PIN matter pages:** every City Record stage that shares the identifier, plus Checkbook
    registration and paid-to-date, under the same procurement phases so multi-year renewals
    read as one contract story.
*   **Predictions:** statutory and lifecycle predictions are shown with method and confidence
    labels (for example, ULURP statutory clocks and contract-renewal forecasts), never as certain
    outcomes.

**Live examples:**

*   [Award paper trail with payments](https://cityscroll.org/#notice/20240723114)
    (`?focus=follow-the-dollars` jumps to paid-to-date)
*   [Recent award side-car + vendor links](https://cityscroll.org/#notice/20260724018)
*   [21st Avenue bridge engineering · PIN `84124P0003001`](https://cityscroll.org/#matter/84124P0003001)
*   [Timbale Terrace rezoning (`2022M0258`)](https://cityscroll.org/#land/2022M0258)

[![A procurement timeline joining City Record, Checkbook NYC, PASSPort, and OCP on one notice page](docs/readme/procurement-lifecycle.png)](https://cityscroll.org/#notice/20260724018)

### 4. Follow the money across systems that don’t link to each other

A single notice joins the **City Record** announcement, **Checkbook NYC** registration and
paid-to-date, **PASSPort** contract detail when present, and **OCP** award corroboration —
every source named. When publishers disagree on amount or date, **both values stay visible**
as labeled assertions, not a silently chosen “winner.”

**Live example:** [Award with registration + payments joined](https://cityscroll.org/#notice/20240723114)

### 5. Entity-linked vendors and agencies — one object across every mention

Vendor profiles resolve name variants (punctuation, casing, legal suffixes), total awards
across agencies, list every notice that names the firm, and attach **Doing Business Search**
identity when the organization stem matches. That is the money-side counterpart to
cross-domain agency intelligence: identity first, then every published trail.

**Live example:** [Community Mediation Services](https://cityscroll.org/#vendor/Community%20Mediation%20Services%2C%20Inc.)
(~$184M across 50 awards and six agencies; four published name variants).

[![Vendor profile resolving four name variants, $184M across 50 awards and six agencies](docs/readme/vendor-profile.png)](https://cityscroll.org/#vendor/Community%20Mediation%20Services%2C%20Inc.)

### 6. District-aware maps and filters — same decision context by place

District boundaries come from committed geometry layers, then every matching domain view applies
the same place filters without repeated live geocoding:

*   **Land and property:** district-first discovery for ULURP, disposition, and map-based route
    entry points.
*   **Meetings and alerts:** hearing and notice workflows can stay in the same district slice as you
    navigate between timeline, alert, and profile routes.
*   **Map-first workflow:** address search, neighborhood filters, and BBL-driven views stay in one
    source-of-truth location frame.

### 7. Hearings that answer “what was decided?”

Council hearing notices join **Legistar** agenda trees: matters, actions, votes, and
attachments on a matter-centric outcomes view. Non-Council hearings keep the process spine
the city actually publishes (notice → hearing) and name real landings for outcomes when no
citywide machine feed exists — never a fake vote.

**Live example:** [Council hearing with matched agenda → matter → vote spine](https://cityscroll.org/#notice/20260706036)

### 8. Rules comment windows while they are still open

Agency Rules notices carry a lifecycle spine enriched from the **NYC Rules** feed: proposal,
hearing, comment close, adoption, and effective dates — with official comment links when the
feed joins. Same “do something while the window is open” posture as solicitations and hearings.

**Live example:** [FHV / taxi parking rules · comment window](https://cityscroll.org/#notice/20260714029)

### 9. Morning digests when something you care about appears

Describe a watch in plain English (or build one on the Alerts tab), confirm via double
opt-in, and receive a morning email when new matches appear — in your chosen language.
Accounts with multiple watches get **one consolidated rollup**; preference-center edits take
effect on the next daily run.

*   [Build an alert](https://cityscroll.org/#alerts)
*   [Multi-watch rollup (demo surface)](https://cityscroll.org/#alerts?view=rollup)

[![Procurement search showing open solicitations across multiple agencies](docs/readme/money-search.png)](https://cityscroll.org/#money)

### Honest about missing data

Empty lifecycle slots say **which kind of gap** they are: not yet joined from a public
source, or not published by the city at all — never a blank “unknown.” The
[API page](https://cityscroll.org/api.html) links the public delivery surfaces and
describes what feeds are live and how they are used.

[![API and feed surfaces](docs/readme/data-page.png)](https://cityscroll.org/api.html)
