---
id: R3
type: reference
title: Where the records come from
page_title: Sources and coverage · CityScroll
url: /guide/reference/sources-and-coverage/
reader_question: Where does this come from, and what is covered?
purpose: Who published each record, what CityScroll adds to it, what each date means, and what a source can and cannot answer.
description: Where CityScroll's records come from, what it adds to them, what each date means, and how to tell an empty answer from a source that could not be read.
last_reviewed: 2026-11-25
return_to_task: Browse public records by type | /browse/
related:
  - What a public record tells you | /guide/understand/what-a-public-record-tells-you/
  - What dates and blanks mean | /guide/understand/dates-and-missing-information/
  - Check the evidence behind a connection | /guide/how-to/check-the-evidence-behind-a-connection/
  - Read a budget request and the answer to it | /guide/how-to/read-a-budget-request-and-the-answer/
  - Glossary of terms used in this guide | /guide/reference/glossary/
  - CityScroll public endpoints and upstream data | /api.html
sources:
  - The City Record Online, published by the City of New York | https://a856-cityrecord.nyc.gov/
  - City Record Online on NYC Open Data | https://data.cityofnewyork.us/City-Government/City-Record-Online/dg92-zbpx
  - Register of Community Board Budget Requests, published by the New York City Office of Management and Budget | https://data.cityofnewyork.us/d/vn4m-mk4t
  - PASSPort public solicitations, published by the Mayor's Office of Contract Services | https://passport.cityofnewyork.us/page.aspx/en/rfp/request_browse_public
  - The full source ledger CityScroll publishes | https://github.com/cityscroll/cityscroll-app/blob/main/docs/data-sources.md
---

CityScroll brings together New York City notices and other public records. It also links and
summarizes records so you can follow a topic across agencies. Open the source on a record to see what
the publisher released and when.

## What are you looking for? {#what-are-you-looking-for}

None of these needs an account. Where a step asks for more, the table says so.

| You want to | Go to | What it asks of you |
| --- | --- | --- |
| Search or browse records | [Search](/search/) by topic, place or agency, or [Browse](/browse/) one type of record at a time | Nothing. Your recent searches are kept in this browser only |
| Follow a topic or place | [Following](/following/) to preview matching records, or [Near you](/near-you/) for meetings around an address | Previewing is free and saves nothing. Saving a watch asks for an email address, because updates arrive by email |
| Read about the underlying data | [Stats](/stats.html) for what is served and how far back it goes, [API and feeds](/api.html) for machine-readable access, and [the source ledger](https://github.com/cityscroll/cityscroll-app/blob/main/docs/data-sources.md) for every source | Nothing |
| Find open contracting opportunities | [Browse contracts](/browse/contracts/), which opens on solicitations still accepting responses, then the city's own [PASSPort public solicitations](https://passport.cityofnewyork.us/page.aspx/en/rfp/request_browse_public) | Reading needs no vendor account. Responding happens with the agency named on the solicitation, most often in PASSPort, which needs a vendor account |

## Three kinds of text on a page {#three-kinds-of-text}

A page can hold three different kinds of text, and each is labeled so you can tell them apart.

| What you are reading | Who wrote it | How to recognize it |
| --- | --- | --- |
| The public record | The agency or other official publisher | It names the publisher and links to the published copy, for example “Source: New York City Office of Management and Budget” followed by a link to the register |
| A CityScroll connection or interpretation | CityScroll | Links between records, plain-language summaries, and notes such as “This answer reads differently from the one published May 12, 2026.” Each is worked out from the published records beside it |
| Sample material | CityScroll, for practice | It is marked as a demo or an example, such as the Demo view in WinCityWork. It is never a public record |

CityScroll does not write records. A summary, a change note or a match is CityScroll's reading of the
publisher's text, and the publisher's own words stay on the page next to it.

## Check the source behind a record {#check-the-source}

- **Who published it.** Every record names its publisher and links back to the copy they released.
  That link is the authority. If the two ever disagree, the publisher's copy is the one to trust.
- **Why two records are linked.** A connection is a claim CityScroll makes. Open its evidence to see
  the identifier or the published wording it rests on, and how strong a match it is. See
  [Check the evidence behind a connection](/guide/how-to/check-the-evidence-behind-a-connection/).
- **Whether a pattern holds.** A flag about the past counts earlier published records. Open the
  records it counted at their source before you rely on it. See
  [Flags and historical patterns](/guide/understand/flags-and-historical-patterns/).
- **Answers from an assistant.** [Ask with AI](/use-with-ai/) lets your own assistant search
  CityScroll's public records. What the assistant writes is its own text, not CityScroll's and not
  the publisher's, so open the record it cites.

## Four dates that mean different things {#four-dates}

| The date | What it tells you | Where you see it |
| --- | --- | --- |
| Publication date | When the publisher released this version of the record | Beside the record, for example “Published June 30, 2026” |
| Record date | Something that happens inside the record: a hearing, a deadline, an award | In the record's own fields, such as “Response deadline” |
| Check date | When CityScroll last read the source | In the source line, for example “Read November 24, 2026” |
| Latest available record | The newest record the publisher has released so far | The most recent publication date in a list |

A recent check date beside an old publication date means CityScroll has read the source lately and
the publisher's newest release is that old one. For more on dates, see
[What dates and blanks mean](/guide/understand/dates-and-missing-information/).

## How often the sources change {#how-often}

Some publishers release as things happen, and some release on a cycle. That difference is the
commonest reason something the city has already done has not reached this site yet, so it is worth
knowing which kind of source you are reading. This table counts only sources whose records you can
reach on CityScroll. Sources used only behind the scenes are left out.

::: source-coverage

The [source ledger](https://github.com/cityscroll/cityscroll-app/blob/main/docs/data-sources.md)
lists every source by name, including the ones left out above. Its Status column uses four words.
`live` means the source must keep its expected fields and stay within its freshness limit.
`build-time` means a saved copy is built into the site and carries the date it was taken.
`manual` means a person re-checks the publisher's page. `disabled` means it is not being read for
the site now and stays listed so the gap is visible.

## What coverage means {#what-coverage-means}

Coverage is not one number, and CityScroll does not offer one. It varies by source, and there are
four different ways a source can be working perfectly and still not answer your question.

| The case | What it means for what you see |
| --- | --- |
| The source is complete but narrow | The City Record covers what the city publishes in The City Record. Things the city does elsewhere are not in it |
| The source is read but not joined | The record is here and the record that would connect it to what you are reading is not, so the connection is absent although both ends exist |
| The source is closed | The publisher has stopped adding to it. It stays because it is the record of its period |
| The source is paused | It is not currently being read. It stays listed rather than quietly disappearing, so a stopped feed cannot be mistaken for a subject with nothing in it |

A missing link is not a missing record. When no connection appears, search the publisher's own
dataset before concluding that no official record exists. A blank field means the publisher left it
blank. It is not a zero and not a “no”.

## What is not covered {#not-covered}

- **Anything the city has not published.** Where a decision was made and no public record of it was
  released, you will not find it here. That absence tells you about publication and nothing about
  the decision.
- **Anything published in a form that cannot be joined.** A document released only as a scan, or with
  no identifier tying it to anything else, may be published and still unreachable from a record you
  are reading.
- **Anything private.** Records about identifiable individuals, such as exam scores or applicant
  details, are not published by the city as open data and are not here.

## When a source could not be read, and when there is nothing {#unavailable-or-empty}

A source that could not be reached is a different thing from a source with nothing to say, and the
site keeps them apart. A page that could not load its records says so. Reload to try again, or open
the official source. Treat it as a fact about today's read, not about the city.

A genuinely empty answer says it is empty. Even then it describes the copies CityScroll holds, so
the publisher's own dataset is the place to confirm it.

## A budget request is not a contracting opportunity {#worked-example}

This example uses the New York City Office of Management and Budget's
[Register of Community Board Budget Requests](https://data.cityofnewyork.us/d/vn4m-mk4t), as checked
on November 25, 2026.

1. Open [Bronx Community Board 1](/community-boards/bronx-cb-01/) and find **Budget requests this
   district made to city agencies**. Under **Choose an agency**, choose
   [Department of Education](/community-boards/bronx-cb-01/#board-budget-requests-education).
2. Find [request 101202708C](/community-boards/bronx-cb-01/#budget-request-101202708c), for fiscal
   year 2027. The board asked for a library and media room at PS 5, and for entrance cameras and
   School Safety Agents. This is the board's request.
3. Read the answers below it. Both, published May 12, 2026 and June 30, 2026, say “Agency supports
   but cannot accommodate” and add that funding is not available. This is the agency's published response.
   CityScroll notes that the second answer reads the same as the first.
4. Check the source line at the foot of the section. It names the publisher and the day CityScroll
   last read the register, and links to the published register, where tracking code 101202708C
   shows the same request and answers.

A request and its response are a dated signal of what a board asked for and what an agency said
about it. They are not funding and not a contract. Whether the city is buying anything is a separate
question, answered by a solicitation record: look at the solicitations still accepting responses on
[Browse contracts](/browse/contracts/), or search
[PASSPort public solicitations](https://passport.cityofnewyork.us/page.aspx/en/rfp/request_browse_public).
Finding nothing there means no matching solicitation is open today, not that the request was
refused.
