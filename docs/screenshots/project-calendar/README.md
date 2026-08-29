# Project calendar evidence

The `before-*` captures show the project route without the project-calendar actions. The
`after-*` captures show the same route with `Follow project` and `Subscribe to project calendar`.
`backstage://cityscroll-evidence/objects/sha256/32/32c2498a62be17860198df094e9bc89c694b3297fee36d782a0a26cef72a22ca.webp` shows the fixture subscription imported into a calendar-client view;
the two entries come from distinct connected processes and retain their process/source labels.

Regenerate with:

```sh
python3 tools/capture_project_calendar.py
```
