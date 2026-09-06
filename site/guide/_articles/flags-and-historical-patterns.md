---
id: E4
type: explanation
title: Flags and historical patterns
page_title: Flags and historical patterns · CityScroll
url: /guide/understand/flags-and-historical-patterns/
reader_question: What does this flag mean, and how far can I trust it?
purpose: What the computed notes on a record are, what they are not, and where the exact rule behind each one is written down.
description: Flags and past-pattern notes on CityScroll are statistical context, never findings. Here is what each one counts, and where its exact rule lives.
last_reviewed: 2026-09-06
return_to_task: Browse contracts and awards | /browse/contracts/
related:
  - What a public record tells you | /guide/understand/what-a-public-record-tells-you/
  - What dates and blanks mean | /guide/understand/dates-and-missing-information/
  - Flags and context, explained, on the About page | /about.html#context
sources:
  - Red flags in public procurement, Open Contracting Partnership | https://www.open-contracting.org/resources/red-flags-in-public-procurement-a-guide-to-using-data-to-detect-and-mitigate-risks/
  - Opentender integrity indicators | https://opentender.eu/
---

## A flag means "worth a closer look"

Some records carry computed notes beside what the city published — most of them on procurement
notices, and one on the rules timeline. Every one of them is statistical context, not a finding and
not an accusation. A flag says a record has a property worth noticing. It does not say anyone did anything wrong, and there is a fair explanation for each of them
— emergencies really do happen, some markets genuinely have few bidders, and name matching is never
perfect.

The method follows two published guides rather than a house theory of what looks suspicious: the Open
Contracting Partnership's
[red-flags guide](https://www.open-contracting.org/resources/red-flags-in-public-procurement-a-guide-to-using-data-to-detect-and-mitigate-risks/)
and [Opentender's](https://opentender.eu/) integrity indicators.

## What each note counts

The exact thresholds, pools and windows behind these live on the About page, in
[Flags and context, explained](/about.html#context). They are kept in one place on purpose: a
threshold repeated in two places is a threshold that will eventually disagree with itself. This is
what each note is about.

| The note | What it looks at | What it cannot tell you |
| --- | --- | --- |
| Short ad window | How long a notice was open compared with that agency's own usual practice | Whether the timing was justified. A short window can be entirely proper |
| Non-competitive method | That the notice itself says a vendor will be chosen without a full contest | Whether that method was the right one. Several of these are lawful and routine |
| Repeat awards | The same vendor name appearing on several award notices at one agency in a period | Whether they are separate decisions. Orders under one blanket contract count the same as anything else |
| Context strip | How large an award is against that agency's recent awards, and the vendor's share of them | Anything about merit. It uses published names exactly, and does not merge spellings |
| Rules adoption lag | How long comparable rules have taken from comments closing to adoption | When this rule will be adopted. It is labelled an estimate and is never a date |

All of these read awards **as published**. Published award figures can run ahead of contract
registration and well ahead of what was actually paid, so a note built on them is describing
publications, not spending.

## Patterns from past records

Elsewhere on the site, past public records are used to give a sense of how long something has taken
before. These are descriptions of what has already happened, not forecasts, and legal deadlines
always take precedence over them.

| The pattern | What it describes | Where its rule is written |
| --- | --- | --- |
| Civil-service eligible-list timing | How long a list has taken to be established after filing closed, from past exams | [Eligible-list timing](/about.html#staffing-list-establishment-formula) |
| Property sale timing | How long auctions have followed past hearing notices | [Property sale timing](/about.html#property-disposition-timing-formula) |
| Tax lien sale progression | How often liens at the same stage reached a past cycle's final sale list | [Tax lien progression](/about.html#tax-lien-sale-predictions) |
| Zoning case history | The usual time range and results for comparable past zoning cases | [What past zoning cases show](/about.html#zoning-base-rates) |
| Applicant history | An applicant's own past zoning results beside the overall rate | [Applicant history](/about.html#applicant-conditioned-ulurp) |

Each of these carries its own honesty conditions, and the pages say so where they apply: the eligible
list comparison uses no applicant names, scores or ranks; a real sale date always replaces the
property timing pattern; a lien can leave a list for many ordinary reasons, including simply being
paid; and where a group is too small or the evidence too weak, the site shows a wider group or
nothing rather than a confident-looking number built on very little.

## How to read one honestly

- **Treat it as a question, not an answer.** The useful next step after a flag is opening the record
  and its official source.
- **A pattern is not a prediction.** "Cases like this have usually taken this long" is a statement
  about past cases.
- **An estimate never becomes a deadline.** If an official date exists, it is the date.
- **Nothing here is an allegation.** These notes save you arithmetic. What they mean is yours to
  judge, from the record itself.

If you want the full arithmetic rather than the meaning, the formulas are published:
[the rules adoption lag](https://github.com/cityscroll/cityscroll-app/blob/main/docs/formulas/rules-adoption-lag.md),
[property disposition timing](https://github.com/cityscroll/cityscroll-app/blob/main/docs/formulas/property-disposition-timing.md),
[award registration dwell](https://github.com/cityscroll/cityscroll-app/blob/main/docs/formulas/award-registration-dwell.md),
and [applicant-conditioned zoning outcomes](https://github.com/cityscroll/cityscroll-app/blob/main/docs/formulas/applicant-conditioned-ulurp-outcomes.md).
