# Contributing

Start with [MISSION.md](MISSION.md) — it's short, and it's the tiebreaker for every design
argument.

## How this project is governed

CROL-List is built by a small team with maintainer governance — the code is public because
transparency builds trust in a civic tool, not because development is crowd-sourced. In
practice:

- **Write access is by invitation.** The maintainers review and merge everything; changes to
  the worker's paid or sending routes, or to anything MISSION.md constrains, always get a
  second maintainer's eyes.
- **Issues are the front door** for everyone else — bug reports, use cases ("as a vendor I
  need to…"), UX feedback, and data corrections steer the roadmap more than code does.
- **Unsolicited PRs** are welcome for small, verifiable fixes; open an issue first for
  anything larger so we can agree on the shape before you spend the time.
- **Standards are enforced by CI**, not by convention: unit suites on every PR, and an
  accessibility gate (axe) in the functional harness. What the checks require is the floor,
  not the ceiling.

## The working agreement

These rules built the project and they're not aspirational — every shipped feature follows them:

1. **Tests first on worker changes.** Anything under `worker/` gets its logic in a pure
   `worker/src/lib/*.mjs` module with `node --test` coverage *before* the route is wired.
   The suite must be green before deploy.
2. **Browser verification before every push.** Site changes are driven in real headless Chromium
   (`test/functional/run.sh`, Playwright) — a feature isn't shipped until the harness has clicked
   it. The harness has caught a real bug in nearly every wave; trust it.
3. **Docs land in the same session as the change.** A feature that ships updates `README.md`
   and, if it changed a route or a defense, the worker README's table. No "docs later." The
   `changelog.html` entry is automatic (see below) — write the marker section, don't hand-edit
   the page.
4. **Live probes after deploy.** After `wrangler deploy`, hit the changed routes on
   `api.crol-list.org` and confirm real behavior (this caught a production DNS incident within
   minutes once — see the changelog).
5. **Honest failure.** If something can't be verified, say so where the next person will look —
   don't stamp it shipped.
6. **AI-drafted copy gets a human editor.** Site copy is substantially drafted with an AI
   assistant (Claude); a human reviews it before it publishes, same as any other contribution.
   about.html's "About our content" section carries this disclosure to readers too (NYC Web
   Content Style Guide, GenAI tools) — `test/standards/genai_disclosure.py` gates its presence.

## Changelog entries

`changelog.html`'s "Recent updates" list is generated, not hand-edited. If your PR changes
something a visitor would notice, add a one-line `## What this means for you` section to the
PR body — plain language, present tense, no code names or internal jargon. A merge-triggered
workflow (`.github/workflows/update-changelog.yml`) extracts that line and regenerates the
page automatically. No marker section means no entry — that's the intended way to keep
plumbing/CI/refactor PRs off the page, not an oversight to fix.

## Running things

```bash
# site (static — any server works)
python3 -m http.server 8000            # then open http://localhost:8000

# site tests
node --test                             # unit: pure functions extracted from index.html
test/functional/run.sh                  # browser harness (needs: pip install playwright && playwright install chromium)

# worker
cd worker && node --test                # unit suite
cd worker && npx wrangler deploy        # deploy (needs Cloudflare auth)
```

## Where contributions land

- **Use cases, UX feedback, testing** — open an issue describing the real-world task ("as a
  vendor I need to…"). These steer the roadmap more than code does.
- **Docs, outreach, research** — the About/api pages, the changelog's plain-language lines, and
  anything that helps the right people find the tool.
- **Code** — the site is one dependency-free `index.html` (inline CSS, vanilla JS, no build
  step); the backend is one Cloudflare Worker under `worker/`. Keep both boring: no frameworks,
  no build steps, graceful degradation everywhere.
- **Adapting this to another city** — fork it; the SODA queries and the lens definitions are
  the city-specific parts. Open an issue if you get stuck and we'll point you at the seams
  (as time permits — your fork is your project).

## Security

See [SECURITY.md](SECURITY.md) for the threat model and how to report a vulnerability.

## Geography of index.html

The site is deliberately one dependency-free file (~3,000 lines). It reads top to bottom:

| Lines (approx) | Region |
|---|---|
| 1–279 | All CSS — design tokens in `:root` (use `var(--muted)` etc., never hardcoded grays) |
| 280–607 | Static markup: masthead, lens tabs, each lens's controls and empty containers |
| 608–~800 | JS foundations: `$` helpers, SODA query builders, the read-side cache |
| ~800–1690 | The Money lens: `loadAgencies`, facets, entity chains, Checkbook joins, maps loader |
| ~1690–2040 | Other lenses: `loadSection` (rules/meetings/property), land/ZAP |
| ~2040–2300 | Today's Edition + cross-lens rendering helpers |
| ~2300–2980 | Notice detail rendering, workspace (pins/notes, localStorage), feeds/share |
| ~2980–end | The subscription quiz and boot sequence |

To find a lens's code, search for its container id (e.g. `#minwrap`, `#fbchips`) or its
loader (`loadSection`, `loadToday`). Unit-testable logic gets *extracted* to plain functions
(see `test/unit.test.mjs`) rather than tested through the DOM.
