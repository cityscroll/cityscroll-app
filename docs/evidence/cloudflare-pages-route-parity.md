# Cloudflare Pages route parity report

Parallel-serving evidence: the Cloudflare Pages host is compared against
the live production site for every path in the public route inventory.
DNS is unchanged in this phase; GitHub Pages remains the production origin.

- Compared at: 2026-07-30T03:50:33.066Z
- Reference (live): https://cityscroll.org
- Candidate (Pages): https://cityscroll.pages.dev
- Inventory size: 9
- Overall: PASS

## Routes

| Path | Ref status | Cand status | Marker | Parity |
| --- | ---: | ---: | --- | --- |
| `/` | 200 | 200 | ok | pass |
| `/about.html` | 200 | 200 | ok | pass |
| `/api.html` | 200 | 200 | ok | pass |
| `/changelog.html` | 200 | 200 | ok | pass |
| `/data.html` | 200 | 200 | ok | pass |
| `/standards.html` | 200 | 200 | ok | pass |
| `/stats.html` | 200 | 200 | ok | pass |
| `/robots.txt` | 200 | 200 | ok | pass |
| `/sitemap.xml` | 200 | 200 | ok | pass |

## Result

Every inventory route returned HTTP 200 with the expected content marker
on both hosts. Status codes matched path-for-path.

## Probe detail

### Reference

- `/` status=200 ok=true chain=200
- `/about.html` status=200 ok=true chain=200
- `/api.html` status=200 ok=true chain=200
- `/changelog.html` status=200 ok=true chain=200
- `/data.html` status=200 ok=true chain=200
- `/standards.html` status=200 ok=true chain=200
- `/stats.html` status=200 ok=true chain=200
- `/robots.txt` status=200 ok=true chain=200
- `/sitemap.xml` status=200 ok=true chain=200

### Candidate

- `/` status=200 ok=true chain=200
- `/about.html` status=200 ok=true chain=308 → /about?_smoke=1785383432479 | 200
- `/api.html` status=200 ok=true chain=308 → /api?_smoke=1785383432479 | 200
- `/changelog.html` status=200 ok=true chain=308 → /changelog?_smoke=1785383432479 | 200
- `/data.html` status=200 ok=true chain=308 → /data?_smoke=1785383432479 | 200
- `/standards.html` status=200 ok=true chain=308 → /standards?_smoke=1785383432479 | 200
- `/stats.html` status=200 ok=true chain=308 → /stats?_smoke=1785383432479 | 200
- `/robots.txt` status=200 ok=true chain=200
- `/sitemap.xml` status=200 ok=true chain=200
