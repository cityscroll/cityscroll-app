# Contributing

Start with [MISSION.md](MISSION.md) — it's short, and it's the tiebreaker for every design
argument. Consequential choices are recorded in [docs/decisions/](docs/decisions/); read those
before proposing to reverse one (then propose away — that's what the log is for).

## The working agreement

These rules built the project and they're not aspirational — every shipped feature follows them:

1. **Tests first on worker changes.** Anything under `worker/` gets its logic in a pure
   `worker/src/lib/*.mjs` module with `node --test` coverage *before* the route is wired.
   The suite must be green before deploy.
2. **Browser verification before every push.** Site changes are driven in real headless Chromium
   (`test/functional/run.sh`, Playwright) — a feature isn't shipped until the harness has clicked
   it. The harness has caught a real bug in nearly every wave; trust it.
3. **Docs land in the same session as the change.** A feature that ships updates `README.md`,
   gets a `changelog.html` entry (plain-language "For you" line first), and — if it changed a
   route or a defense — the worker README's table. No "docs later."
4. **Live probes after deploy.** After `wrangler deploy`, hit the changed routes on
   `api.crol-list.org` and confirm real behavior (this caught a production DNS incident within
   minutes once — see the changelog).
5. **Honest failure.** If something can't be verified, say so where the next person will look —
   don't stamp it shipped.

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
- **Adapting this to another city** — very welcome; open an issue and we'll help you find the
  seams (the SODA queries and the lens definitions are the city-specific parts).

## Security

See [SECURITY.md](SECURITY.md) for the threat model and how to report a vulnerability.
