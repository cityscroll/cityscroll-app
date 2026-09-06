---
id: R3
type: reference
title: Where the records come from
page_title: Sources and coverage · CityScroll
url: /guide/reference/sources-and-coverage/
reader_question: Where does this come from, and what is covered?
purpose: Which publishers CityScroll reads, how current their records are, and what falls outside what it can show you.
description: CityScroll republishes what New York City already publishes. This is where those records come from, how current they are, and what is not covered.
last_reviewed: 2026-09-06
return_to_task: Browse public records by type | /browse/
related:
  - What dates and blanks mean | /guide/understand/dates-and-missing-information/
  - Glossary of terms used in this guide | /guide/reference/glossary/
  - CityScroll public endpoints and upstream data | /api.html
sources:
  - The City Record Online, published by the City of New York | https://a856-cityrecord.nyc.gov/
  - City Record Online on NYC Open Data | https://data.cityofnewyork.us/City-Government/City-Record-Online/dg92-zbpx
  - The full source ledger CityScroll publishes | https://github.com/cityscroll/cityscroll-app/blob/main/docs/data-sources.md
---

## Everything here was published by someone else

CityScroll holds no records of its own. Every record on it was published by a New York City agency,
a state body, or another official publisher, and every record keeps a link back to that published
copy. CityScroll is independent of city government and speaks for no agency.

The largest single source is [The City Record](https://a856-cityrecord.nyc.gov/), the city's own daily
publication of official notices, which is also
[released as open data](https://data.cityofnewyork.us/City-Government/City-Record-Online/dg92-zbpx).
Alongside it sit the city's contract, budget, payroll, buildings, planning, civil-service and property
datasets, and a few state publishers.

## How often the sources change

Some publishers release as things happen, and some release on a cycle. That difference is the
commonest reason something the city has already done has not reached this site yet, so it is worth
knowing which kind of source you are reading.

::: source-coverage

That table is generated from the source registry itself rather than typed here, so it cannot drift
away from what the site actually reads. The registry also carries what each source is used for and
how stale it is allowed to get before it is treated as a problem, and it is published in full as
[the source ledger](https://github.com/cityscroll/cityscroll-app/blob/main/docs/data-sources.md).

## What coverage means

Coverage is not one number, and CityScroll does not offer one. It varies by source, and there are
four different ways a source can be working perfectly and still not answer your question.

| The case | What it means for what you see |
| --- | --- |
| The source is complete but narrow | The City Record covers what the city publishes in The City Record. Things the city does elsewhere are not in it |
| The source is read but not joined | The record is here and the record that would connect it to what you are reading is not, so the connection is absent although both ends exist |
| The source is closed | The publisher has stopped adding to it. It stays because it is the record of its period |
| The source is paused | It is not currently being read. It stays listed rather than quietly disappearing, so a stopped feed cannot be mistaken for a subject with nothing in it |

For how much is here and what period it spans, [the stats page](/stats.html) is the place. For the
endpoints, feeds and upstream datasets, [the API page](/api.html) is.

## What is not covered

- **Anything the city has not published.** Where a decision was made and no public record of it was
  released, you will not find it here. That absence tells you about publication and nothing about
  the decision.
- **Anything published in a form that cannot be joined.** A document released only as a scan, or with
  no identifier tying it to anything else, may be published and still unreachable from a record you
  are reading.
- **Anything private.** Records about identifiable individuals — exam scores, applicant details — are
  not published by the city as open data and are not here.

## When a source is having a bad day

A source that could not be reached is a different thing from a source with nothing to say, and the
site keeps them apart. A page that could not load its records says so, and retrying or opening the
official source is the way through. Reading a temporary failure as an absence of records is the
mistake this distinction exists to prevent.

The same goes the other way. A record set that is genuinely empty says it is empty, rather than
showing an error and leaving you to guess.
