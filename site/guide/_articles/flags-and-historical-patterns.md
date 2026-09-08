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

## What each note counts {#what-each-note-counts}

- **⚑ Short ad window** — the days between when a notice is posted and when the answer is due. We flag it when it is 10 days or fewer and less than half the agency's own median. The median comes from that agency's last 200 notices. Short windows favor incumbents who already knew the work was coming.

- **⚑ Non-competitive method** — the notice says it will pick a vendor without a full contest. It may be a deal made through talks, a single chosen source, an urgent buy, or a test project. This can be fair at times. But it is always good to know.

- **⚑ Repeat awards** — the same vendor name shows up on 3 or more award notices at the same agency within 90 days. This can point to task orders under a blanket contract just as much as favoritism. The flag just counts them — you decide what it means.

- **Context strip** — how big an award is, shown as a percentile of that agency's awards in the last 12 months (shown only when the agency has 20 or more awards in that time). It also shows the vendor's share of the agency's award dollars in the same time. We use the exact published name. We do not merge name variants here.

- **Rules adoption lag** estimates the time from comments closing to adoption. The [rules adoption lag formula](https://github.com/cityscroll/cityscroll-app/blob/main/docs/formulas/rules-adoption-lag.md) owns its pools, unfinished-case treatment, and display rules. An estimate is never a confirmed date.

These notes use saved source snapshots. Opening a notice does not fetch fresh numbers from the publisher. Check the record's source date and coverage before relying on a comparison.

All of these read awards **as published**. Published award figures can run ahead of contract
registration and well ahead of what was actually paid, so a note built on them is describing
publications, not spending.

## Patterns from past records {#patterns-from-past-records}

Elsewhere on the site, past public records are used to give a sense of how long something has taken
before. These are descriptions of what has already happened, not forecasts, and legal deadlines
always take precedence over them.

## Eligible-list timing {#eligible-list-timing}

CityScroll compares past exams by exam number, from the filing deadline to list establishment. No applicant names, scores, or ranks are used. Small groups or weak test results reduce the display to the citywide median.

## Property sale timing {#property-sale-timing}

The public sample is small. Hearing notices rarely join to later auctions by lot number. The displayed comparison measures auction publication to the scheduled event, not hearing to sale. A real sale date replaces the pattern. See the [property timing formula](https://github.com/cityscroll/cityscroll-app/blob/main/docs/formulas/property-disposition-timing.md).

## Tax lien progression {#tax-lien-progression}

CityScroll shows how often liens at the same stage reached a past cycle's final sale list, not whether a property will be sold or foreclosed. Payment, payment plans, exemptions, corrections, or canceled sales can remove a lien. Weak evidence means group totals and the lot's current status only.

## Zoning case history {#zoning-case-history}

Past cases show time ranges and outcomes, not forecasts. Legal deadlines control. Groups start with the same action type and borough, widening below 20 cases. Long or unfinished cases are excluded from the time range.

## Applicant history {#applicant-history}

At least 20 approved, modified, or disapproved zoning outcomes are needed to show an applicant's history beside the overall rate. Weak name matches or test results mean descriptive history or no display. See the [applicant outcome formula](https://github.com/cityscroll/cityscroll-app/blob/main/docs/formulas/applicant-conditioned-ulurp-outcomes.md).

## How to read one

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
