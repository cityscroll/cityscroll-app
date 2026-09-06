---
id: R2
type: reference
title: Controls and what they give you
page_title: Controls and outputs · CityScroll
url: /guide/reference/controls-and-outputs/
reader_question: What can this control do, and what do I get back?
purpose: Every control a reader can operate on CityScroll, what it changes, and what you are left holding afterwards.
description: What each control on CityScroll does when you use it — searching, filtering, following, calendars, links and exports — and what state you are left in.
last_reviewed: 2026-09-06
return_to_task: Browse public records by type | /browse/
related:
  - Glossary of terms used in this guide | /guide/reference/glossary/
  - Where the records come from | /guide/reference/sources-and-coverage/
  - What dates and blanks mean | /guide/understand/dates-and-missing-information/
sources:
  - CityScroll public endpoints and upstream data | /api.html
---

## What this page covers

The controls a reader operates, and the state each one leaves you in. Feeds, endpoints and the
parameters a program can send stay with [the API page](/api.html), which is their owner; this page is
about what is on the screen.

Some of these controls need JavaScript, because the surface they sit on assembles its results in your
browser. Where that is so, it is said in the row.

## Finding records

| Control | What it does | What you are left with |
| --- | --- | --- |
| Search | Searches the records for your words | A results page grouped by kind of record, with your words in the address |
| The result groups | Splits results into Contracts, People + organizations, Land, Rules, Meetings and Exams, each with its own count | The kind of record is visible before you open anything |
| Why it matched | Marks each result as a title match, a summary match, or a match in the body of the record | For a body match, the passage itself, quoted from the record |
| Scope | Limits a search to one kind of record instead of all of them | A narrower search, kept in the address |
| Recent searches | Lists what you have searched for, with a way to clear it | A list kept in this browser only |
| Browse | Opens one kind of record on its own page, without searching | A listing you can filter |
| Filters and More filters | Narrow a listing by the things that listing has — a keyword, an agency, a place, a stage, a date window, an amount | A narrower listing, kept in the address |
| Follow this search | Takes you to Following with the watch builder open | Nothing is started. The watch is still yours to preview and confirm |
| Export CSV, Export Excel and Print | Take the listing you are looking at with you | A file or a printable page of the listing as filtered |

Which filters a listing offers depends on what that kind of record has: an amount belongs to
contracts, a stage to meetings. The listing itself is the authority on its own filters.

Search and the browse listings assemble results in your browser and need JavaScript. Individual
record pages, and every page of this guide, do not.

## Following a topic

| Control | What it does | What you are left with |
| --- | --- | --- |
| Create a watch | The tab where a watch is built, from a topic and a place | Nothing is started. Choosing a topic or a place does not start a watch |
| More topics | Opens the rest of the topics, including staffing and exams, mandates, and a weekly City Council District watch | The same unstarted watch, on a different topic |
| Narrow it down | Adds a keyword, an agency, a City Council District, or a Community Board | A narrower watch, still unstarted |
| Choose a Community Board watch | Takes a borough and then a board number, in that order | A watch identified by both, because a board number alone names several boards |
| Preview matches | Shows the records this watch would match, with a summary of what the watch is | Nothing is saved and no email is sent. A preview is not a subscription |
| Email frequency | Daily when there are matches, or a weekly digest that sends on Monday | Which of the two you chose |
| Create watch | Starts the watch, using the email address you type | A running watch. No account is created |
| Your watches | Where existing watches are reached | A note that you open a CityScroll email to get to them, because there is no account to sign in to |

Nothing on CityScroll subscribes you to anything as a side effect of reading. Starting a watch is
always this last control, with your own email address typed into it.

## Dates and calendars

| Control | What it does | What you are left with |
| --- | --- | --- |
| Act by | Separates deadlines you can still act on from the events that follow them | A reading of which dates are yours to meet |
| Subscribe to calendar | Offers a subscription for what you are looking at | A panel with two ways to take it into your own calendar |
| Open calendar subscription | Hands the feed to the calendar your device has | Your calendar app takes over |
| Copy subscription URL | Copies the address to paste into a calendar that asks for one | An address on your clipboard |

Two limits are worth knowing. **Subscribe to calendar** appears only where what you are looking at
has dated events a calendar could hold; on a listing with no such dates it is not offered, and that
is the honest answer rather than an empty feed. And once the address has reached your calendar app,
CityScroll cannot
tell whether your calendar kept the subscription or how often it refreshes — that is a setting in
your calendar, and some of them take hours to show a change.

## Keeping and sharing what you found

| Control | What it does | What you are left with |
| --- | --- | --- |
| The address bar | Holds your search, filters, chosen day and inspected connection | A link that rebuilds the same view later, against whatever is published by then |
| How this connection was made | Opens the basis for a connection, the relation it asserts, and its official source | The connection stays in the address, so the link carries it |
| Copy link to this connection | Copies the address with that one connection already inspected | An address on your clipboard |
| Copy link | Copies the address of the record you are on | An address on your clipboard |
| The source link | Opens the city's own published copy. It is named for where it goes, such as City Record notice | The city's page, in a new tab |
| Print or save PDF, and Download JSON | Take one record with you | A file of that record as it stands |
| As of day | Keeps only records dated on or before the day you pick, with Apply and Clear | A dated view, shareable by its address |

## Collecting records

| Control | What it does | What you are left with |
| --- | --- | --- |
| Pin | Adds the record you are on to your investigation | A collection held in this browser only |
| Note | Adds your own note to a pinned record | A note held in this browser only |
| Export .csv and Export .json | Download what you have collected | A file on your device, each item carrying its link and the date you pinned it |
| Print dossier | Prepares the collection for printing | A printable page |
| Share read-only link | Uploads a read-only snapshot and gives you a link to it | A link anyone you send it to can open, which expires |
| Freeze research package | Preserves a question and its evidence as a fixed version | A versioned package that stays as it was, even after newer records arrive |
| Clear all | Empties the investigation | An empty collection. What was in it was on this device |

The difference between these is where the records are. Pinning and notes live in the browser you used
and travel to no other device. An export is a file you now hold. A shared link is a copy that has left
your browser and that anyone with the link can read. A frozen package is a fixed version that does
not follow later data.
