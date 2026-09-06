# The public guide

The guide at `/guide/` is where a reader learns to use CityScroll: guided practice,
directions for a task they already have, background on what a record means, and
details to look up while working. Readers see four sections named **Start here**,
**How to…**, **Understand**, and **Reference**.

The bounded plan behind it — which articles exist, which example each is taught
with, and how those examples were verified — is in
[`evidence/public-user-guide/`](evidence/public-user-guide/).

## Where the parts live

| Path | What it owns |
| --- | --- |
| `site/guide/_home.md` | The guide home: its orientation, the description under each of the four sections, and the note about language and review dates. |
| `site/guide/_articles/*.md` | One file per article. |
| `site/guide_article_source.mjs` | The source format: front matter, the Markdown subset, and the validation that rejects a malformed article. |
| `site/guide_source_coverage.mjs` | The one table a reference page shows that is derived rather than written, read out of the source registry. |
| `site/guide_view.mjs` | The rendered documents, built on the shared civic-document chrome. |
| `site/guide_contextual_links.mjs` | The one help link each product control group may show, and the `/guide/` path the shared mast and footer use. |
| `site/guide.css` | The few rules `civic-documents.css` does not already cover. |
| `tools/build_guide_documents.mjs` | The builder. Writes `site/guide/**/index.html`; `--check` fails when a document is stale. |
| `test/guide_documents.test.mjs` | The reader-facing contracts. |
| `test/standards/guide_content.py` | Points the site's own metadata, link-text and heading gates at the guide pages. |
| `tools/capture_guide_release.py` | Drives the reader's journey and records the usability evidence as a manifest. |
| `tools/capture_guide_how_to_walkthroughs.py` | Walks the everyday how-tos to the product route each one names and back, and records that the run changed nothing. Usability belongs to the runner above; this answers whether the journey arrives. |
| `tools/capture_guide_product_access.py` | Home → Guide → example → explanation → product at 390px and 1440px, plus About anchors and Following's help link. |

The shared document mast and footer (`site/civic_document_chrome.mjs`) include
Guide next to Now, Near you, Following, and Browse. Following, the calendar
handoff, connection evidence, the as-of control, and an empty investigation each
offer one of those contextual links — never a second help system, and never a
URL that carries a watch or session credential.

Article sources sit under underscore-prefixed directories, which the public-site
payload walker already skips, so the Markdown is tracked and reviewable without
becoming a published route. The rendered documents are tracked, like the Following
document, so a prose change shows its rendered result in the diff.

## Adding an article

1. Write `site/guide/_articles/<slug>.md`. Copy the front matter from an existing
   article; every field in it appears on the page.
2. Check the article against the live site, then write today's date into
   `last_reviewed`.
3. Register the new route in `tools/pages_route_parity.mjs`, `site/sitemap.xml`,
   `test/standards/canonical_domain.py` and `test/functional/11_accessibility.py`.
   The performance registry already covers `/guide/{section}/{article}` as a
   template and needs nothing per article.
4. Run `node tools/build_guide_documents.mjs`, then
   `node --test test/guide_documents.test.mjs`,
   `python3 test/standards/guide_content.py` and
   `python3 tools/capture_guide_release.py`. The capture asks the builder which
   articles exist, so a new one is covered the moment it is written; add an entry
   to that tool's authored route table to say what this page in particular must
   contain, which is worth more than the derived floor it falls back to.
5. Commit the source and the rendered document together.

The build fails rather than guesses. An unknown article type, a `last_reviewed`
that is not a plain date, a `url` outside the section its type belongs to, a
description outside the length the page-metadata gate allows, a link that resolves
to neither a served route nor a recognized record-document family, or a Markdown
construct the subset does not have — each stops the build and names the file.

A link to one civic record is checked for its shape, not its existence: those
documents are materialized at deploy time from rolling publisher data, so
requiring one to be present would make the build depend on a record still being
in the publisher's window. That a particular record is live is proved by loading
it, and those loads are recorded in
[`evidence/public-user-guide/worked-example-verification.md`](evidence/public-user-guide/worked-example-verification.md).

Within a section, articles are listed in the order their ids give, so a section
reads in the order it was meant to be read rather than alphabetically.

## Two constructs for reference pages

A reference article is scanned rather than read in lines, so the subset carries two
things a tutorial has no use for.

A **table** is written the ordinary way, and must have a header row, a `---` divider,
and a heading above it:

    ## Identifiers

    | Identifier | What it identifies |
    | --- | --- |
    | PIN | One procurement |

The heading is not decoration. The table renders inside a region that can scroll
sideways on a narrow screen, and a region that scrolls has to be reachable from the
keyboard and has to say what it is — the heading is what it says. A table with no
heading above it fails the build rather than reaching a reader as an unnamed box.

A **generated table** is placed with one line:

    ::: source-coverage

That is how a reference page shows something an owner already knows without a second
copy of it being typed here. The builder supplies the named tables; an unknown name
fails the build. There is one today, `source-coverage`, derived from
`site/data/source_contracts.json`. The rule for adding another is the same rule as
everything else here: the guide gets the meaning, the owner keeps the value. If the
number would go stale, generate it; if it would not, write it.

## Four dates that are not the same date

The guide keeps these apart on purpose, and an article says only the second one:

- **Modified** — when the source file last changed. Git owns this.
- **Last reviewed** — when an editor last read the article against the live site and
  confirmed it still describes what happens. Written by hand into the article source.
  Nothing in the build reads a clock, so rebuilding unchanged sources never moves it.
- **Example verified** — when a specific worked example was last loaded and observed.
  Recorded with the example, in
  [`evidence/public-user-guide/example-selection-records.md`](evidence/public-user-guide/example-selection-records.md).
- **Data vintage** — how current the civic records themselves are. Owned by the
  source contracts and shown on the record surfaces, never restated in guide prose.

A machine can tell you a referenced route changed. It cannot tell you the sentence
about it is now wrong, so a review date only ever moves when a person moves it.

## Writing a how-to

A how-to answers a task the reader already has, so it is shaped by the task
rather than by the product:

- Open with the task, then what the reader needs before starting, then a link to
  the real place they start from. End with the state they can observe when they
  are done.
- Name a control with the words on the screen, and say where a control only
  appears under a condition. A step that tells a reader to press something they
  cannot see is worse than no step.
- Say what an action commits them to at the moment they take it. Where two
  similar controls carry different commitments — a preview and a saved watch, one
  event and a continuing subscription — the difference is the article's job.
- Cover the empty and unknown cases in the article, not in a separate page. An
  empty result, an unrecognized session and an unpublished date are ordinary
  outcomes, and a guide that only describes the happy path is wrong most days.
- Claim nothing about a system CityScroll cannot see. It cannot tell whether
  another calendar kept a subscription, and the article says so.

## Writing

- One reader question per article. If it needs two, it is two articles.
- Use the words on the screen. A reader should never need to know what the code
  calls a thing.
- Say what the reader should be able to see, rather than showing a screenshot of it.
  A checkpoint stays true at any zoom level, in a screen reader, and after a redesign
  that a screenshot would survive only as a lie. It is also why the guide commits no
  images.
- Never promise a number of results. Records roll; the shape of the answer is the
  lesson.
- If a step needs an interactive product surface, say so at that step. The article
  itself keeps working without script.
