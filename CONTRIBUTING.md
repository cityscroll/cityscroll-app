# Contributing

Start with [MISSION.md](MISSION.md) — it's short, and it's the tiebreaker for every design
argument.

## How this project is governed

CityScroll is built by a small team with maintainer governance — the code is public because
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
1a. **New dual-implemented logic gets an inventory entry.** The static site and the worker can't
   share code, so some rules are implemented by hand on both sides — `docs/drift-inventory.md`
   is the committed list. If your change adds a new rule to one side that the other side needs
   to agree with, add an entry there and, if the rule is a pure function, a shared-fixture test
   under `test/contract/` (see that directory's existing tests for the pattern). This is what
   keeps a change like commit `3ff6825` — one side learns to strip embedded HTML, the other
   doesn't — from shipping unnoticed again.
2. **Browser verification before every push.** Site changes are driven in real headless Chromium
   (`test/functional/run.sh`, Playwright) — a feature isn't shipped until the harness has clicked
   it. The harness has caught a real bug in nearly every wave; trust it.
3. **Docs land in the same session as the change.** A feature that ships updates `README.md`
   and, if it changed a route or a defense, the worker README's table. No "docs later." The
   machine release-note entry is automatic (see below) — write the marker section, don't
   hand-edit the data contract.
4. **Live probes after deploy.** After `wrangler deploy`, hit the changed routes on
   `api.cityscroll.org` and confirm real behavior (this caught a production DNS incident within
   minutes once — see the changelog).
5. **Honest failure.** If something can't be verified, say so where the next person will look —
   don't stamp it shipped.
6. **AI-drafted copy gets a human editor.** Site copy is substantially drafted with an AI
   assistant (Claude); a human reviews it before it publishes, same as any other contribution.
   about.html's "About our content" section carries this disclosure to readers too (NYC Web
   Content Style Guide, GenAI tools) — `test/standards/genai_disclosure.py` gates its presence.

## Beta preview

Large interaction changes may opt into the public beta channel. Apply
`preview:beta` to a same-repository draft pull request to publish its stable
`pr-<number>.crol-list-beta.pages.dev` alias. A labeled pull request includes
that alias in its public body before it is marked ready.

Ready status does not deploy either stable or beta. Beta promotion remains a
separate, manually triggered exact-commit operation. See
[docs/beta-channel.md](docs/beta-channel.md) for deployment and rollback.

## Machine release-note entries

`site/changelog-data.json` is generated, not hand-edited, and curated for the team surface.
It records the handful of changes worth calling out rather than mirroring every merged PR.
Two things earn a PR an entry, both required:

1. A short user-impact section in the PR body — plain language, present tense, no code names
   or internal jargon. Canonical heading: `## What this means for you`. Accepted aliases
   (same section semantics): `## What readers see`, `## What users can now see`, and
   `## Changelog`.
2. The `changelog:major` label, applied when the change is genuinely significant to a
   visitor — a new feature, a new language, a meaningful fix to something visibly broken.
   Most PRs should NOT carry this label: a bug fix, an internal/tooling change, a wording
   tweak, or a refinement to something that already shipped is real work but not a release-note
   moment. If in doubt, leave it off — the PR history is still the complete record; the
   machine data is the curated highlights, not the log.

A merge-triggered workflow (`.github/workflows/update-changelog.yml`) checks for the label,
then extracts the marker line and publishes a data-only commit on the bot-owned branch. It
does not generate a public page or open a pull request. No label → no entry (intentional).
The label without an accepted
user-impact section fails the workflow closed — a silent green no-op is not allowed for an
explicitly major-labeled merge.

## Running things

### Content standards gates

Style-guide and companion content gates live in the reusable
[`civic-content-gates`](civic-content-gates/) package. House CI still invokes the stable
wrappers under `test/standards/` (for example `python3 test/standards/link_text.py`,
`python3 test/standards/reading_level.py --max-grade 7 about.html`). To run the whole
suite against `site/`:

```bash
PYTHONPATH=civic-content-gates python3 -m civic_content_gates run \
  --root site \
  --allowlist test/standards/nyc_copy_lint_allowlist.txt \
  --baseline site/reading-level-baseline.json

Before you open a PR, run:

```bash
./tools/preflight-required-checks.sh
```

This runs the local unit gates mirrored by CI's required checks.
```

```bash
# site (static — any server works)
python3 -m http.server 8000 --directory site  # then open http://localhost:8000

# site tests
node --test                             # unit: pure functions extracted from site/index.html
test/functional/run.sh                  # browser harness (needs: pip install playwright && playwright install chromium)

# worker
cd worker && node --test                # unit suite
cd worker && npx wrangler deploy        # deploy (needs Cloudflare auth)
```

## Where contributions land

- **Use cases, UX feedback, testing** — open an issue describing the real-world task ("as a
  vendor I need to…"). These steer the roadmap more than code does.
- **Docs, outreach, research** — the About/API pages, release-note lines, and
  anything that helps the right people find the tool.
- **Code** — the site is dependency-free static HTML plus browser-native ES modules under
  `site/app/` (vanilla JS, no build step); the backend is one Cloudflare Worker under `worker/`.
  Keep both boring: no frameworks, no build steps, graceful degradation everywhere.
- **Adapting this to another city** — fork it; the SODA queries and the lens definitions are
  the city-specific parts. Open an issue if you get stuck and we'll point you at the seams
  (as time permits — your fork is your project).

## Security

See [SECURITY.md](SECURITY.md) for the threat model and how to report a vulnerability.

## Geography of the main site

`site/index.html` owns CSS and static markup. `site/app/main.mjs` loads browser-native modules in
dependency order; the terse task-to-module index is [`docs/module-map.md`](docs/module-map.md).
Application modules stay below 100 KB so a focused change fits a short agent context. Unit-testable
logic is still extracted to plain functions through `test/helpers/site_source.mjs`; rendered parity
with the former inline-script shape is guarded by `test/functional/21_module_dom_equivalence.py`.
