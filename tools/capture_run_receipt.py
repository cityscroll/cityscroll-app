"""Per-run capture receipt: prove a packet's rows came from THIS execution.

The screenshot host (catbox.moe) is content-addressed: identical bytes always
return the same file URL, so a deterministic page's screenshot keeps the same
hosted address across runs and even across packets. Neither the ``sha256``
digest nor the hosted ``screenshot_url`` can therefore distinguish a fresh run
of a deterministic page from a run that never executed - a stale manifest and a
freshly captured one carry byte-identical addresses.

A run receipt closes that gap. Every capture row carries evidence only this run
could have produced:

* the live upload HTTP exchange (request time, response status, returned URL);
* the per-request-varying served response headers observed while the page
  loaded (``Date``, ``CF-Ray``, and the served revision), where ``CF-Ray`` is a
  unique-per-request token the edge stamps on each live response; and
* the ``capture_run_id`` and a ``captured_at`` stamped inside a single run
  window, alongside the click observation the journey already required.

The manifest also records a host-behaviour demonstration performed inside the
same run - the same bytes uploaded twice (same URL) and a one-byte-altered copy
(different URL) - so a reader can see exactly why the four screenshot addresses
repeat: the host returns one address per distinct byte sequence.

:func:`validate_run_receipt` refuses any row lacking a receipt entry from this
run (a matching ``capture_run_id`` and timestamps inside the run window).
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

SHA1_RE = re.compile(r"^[0-9a-f]{40}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
CF_RAY_RE = re.compile(r"^[0-9a-f]{16}-[A-Z0-9]{2,4}$")
TIMESTAMP_FORMAT = "%Y-%m-%dT%H:%M:%SZ"


def _fail(message: str) -> "NoReturn":  # noqa: F821 - typing.NoReturn without import
    raise SystemExit(message)


def parse_timestamp(value: object, *, label: str) -> datetime:
    """Parse a ``YYYY-MM-DDTHH:MM:SSZ`` UTC stamp or refuse."""
    if not isinstance(value, str) or not value.strip():
        _fail(f"{label} is missing")
    try:
        parsed = datetime.strptime(value, TIMESTAMP_FORMAT)
    except ValueError:
        _fail(f"{label} is not a UTC {TIMESTAMP_FORMAT!r} timestamp: {value!r}")
    return parsed.replace(tzinfo=timezone.utc)


def _within(when: datetime, start: datetime, end: datetime, *, label: str) -> None:
    if when < start or when > end:
        _fail(
            f"{label} {when.strftime(TIMESTAMP_FORMAT)} falls outside the run window "
            f"[{start.strftime(TIMESTAMP_FORMAT)}, {end.strftime(TIMESTAMP_FORMAT)}]"
        )


def _require_https(value: object, *, label: str) -> str:
    if not isinstance(value, str) or not value.startswith("https://"):
        _fail(f"{label} must be an https URL, got {value!r}")
    return value


def _require_upload(exchange: object, *, label: str, run_start: datetime, run_end: datetime) -> dict:
    if not isinstance(exchange, dict):
        _fail(f"{label} upload exchange is missing")
    _require_https(exchange.get("returned_url"), label=f"{label} upload returned_url")
    status = exchange.get("http_status")
    if not isinstance(status, int):
        _fail(f"{label} upload http_status must be recorded as an integer, got {status!r}")
    requested = parse_timestamp(exchange.get("requested_at"), label=f"{label} upload requested_at")
    responded = parse_timestamp(exchange.get("responded_at"), label=f"{label} upload responded_at")
    if responded < requested:
        _fail(f"{label} upload responded_at precedes requested_at")
    _within(requested, run_start, run_end, label=f"{label} upload requested_at")
    _within(responded, run_start, run_end, label=f"{label} upload responded_at")
    return exchange


def validate_host_dedup_demonstration(demo: object) -> None:
    """Validate the in-run demonstration that the host deduplicates by content.

    Refuses unless the manifest records three real uploads from this run: the
    same bytes uploaded twice returning one URL, and a one-byte-altered copy
    returning a different URL.
    """
    if not isinstance(demo, dict):
        _fail("run_receipt.host_dedup_demonstration is missing")
    first = demo.get("first_upload")
    repeat = demo.get("repeat_same_bytes")
    altered = demo.get("altered_one_byte")
    for name, entry in (("first_upload", first), ("repeat_same_bytes", repeat), ("altered_one_byte", altered)):
        if not isinstance(entry, dict):
            _fail(f"run_receipt.host_dedup_demonstration.{name} is missing")
        _require_https(entry.get("returned_url"), label=f"host_dedup_demonstration.{name} returned_url")
        if not isinstance(entry.get("http_status"), int):
            _fail(f"host_dedup_demonstration.{name} http_status must be an integer")
        if not SHA256_RE.fullmatch(str(entry.get("sha256") or "")):
            _fail(f"host_dedup_demonstration.{name} sha256 must be a 64-hex digest")

    if first["sha256"] != repeat["sha256"]:
        _fail("host_dedup_demonstration: the repeat upload must carry the same sha256 as the first upload")
    if altered["sha256"] == first["sha256"]:
        _fail("host_dedup_demonstration: the altered upload must carry a different sha256")
    if first["returned_url"] != repeat["returned_url"]:
        _fail(
            "host_dedup_demonstration: identical bytes must return the same URL, but "
            f"{first['returned_url']} != {repeat['returned_url']}"
        )
    if altered["returned_url"] == first["returned_url"]:
        _fail(
            "host_dedup_demonstration: a one-byte-altered copy must return a different URL, but "
            f"both returned {first['returned_url']}"
        )
    if demo.get("same_bytes_returned_same_url") is not True:
        _fail("host_dedup_demonstration.same_bytes_returned_same_url must be true")
    if demo.get("altered_bytes_returned_different_url") is not True:
        _fail("host_dedup_demonstration.altered_bytes_returned_different_url must be true")


def validate_row_receipt(
    row: dict,
    *,
    run_id: str,
    run_start: datetime,
    run_end: datetime,
    manifest_revision: str | None,
) -> None:
    """Refuse a capture row that lacks a receipt entry from this run.

    A row without a ``run_receipt``, or one whose ``capture_run_id`` diverges
    from the manifest run, or whose timestamps fall outside the run window, is
    refused: a deterministic digest and hosted address cannot substitute for
    proof that this run executed against the live page and host.
    """
    name = row.get("name") or "<unnamed>"
    receipt = row.get("run_receipt")
    if not isinstance(receipt, dict):
        _fail(f"{name}: missing run_receipt; every row must carry evidence from this capture run")

    if receipt.get("capture_run_id") != run_id:
        _fail(
            f"{name}: run_receipt.capture_run_id {receipt.get('capture_run_id')!r} diverges "
            f"from the manifest run {run_id!r}"
        )

    captured = parse_timestamp(receipt.get("captured_at"), label=f"{name} run_receipt.captured_at")
    _within(captured, run_start, run_end, label=f"{name} run_receipt.captured_at")

    page_load = receipt.get("page_load")
    if not isinstance(page_load, dict):
        _fail(f"{name}: run_receipt.page_load is missing")
    _require_https(page_load.get("url"), label=f"{name} run_receipt.page_load.url")
    if page_load.get("http_status") != 200:
        _fail(f"{name}: run_receipt.page_load.http_status must be 200, got {page_load.get('http_status')!r}")
    headers = page_load.get("headers")
    if not isinstance(headers, dict):
        _fail(f"{name}: run_receipt.page_load.headers is missing")
    cf_ray = headers.get("cf-ray")
    if not isinstance(cf_ray, str) or not CF_RAY_RE.fullmatch(cf_ray):
        _fail(
            f"{name}: run_receipt.page_load.headers.cf-ray must be a per-request edge token "
            f"(e.g. 'a411c2946b416180-EWR'), got {cf_ray!r}"
        )
    if not isinstance(headers.get("date"), str) or not headers.get("date"):
        _fail(f"{name}: run_receipt.page_load.headers.date must record the served Date header")
    served_revision = page_load.get("served_revision")
    if not SHA1_RE.fullmatch(str(served_revision or "")):
        _fail(f"{name}: run_receipt.page_load.served_revision must be a 40-hex commit SHA, got {served_revision!r}")
    if manifest_revision and served_revision != manifest_revision:
        _fail(
            f"{name}: run_receipt.page_load.served_revision {served_revision} does not match "
            f"the manifest revision {manifest_revision}"
        )

    upload = _require_upload(
        receipt.get("upload"),
        label=name,
        run_start=run_start,
        run_end=run_end,
    )
    if row.get("screenshot_url") and upload.get("returned_url") != row.get("screenshot_url"):
        _fail(
            f"{name}: run_receipt.upload.returned_url {upload.get('returned_url')!r} does not match "
            f"the row screenshot_url {row.get('screenshot_url')!r}"
        )

    observation = receipt.get("click_observation")
    if not isinstance(observation, dict):
        _fail(f"{name}: run_receipt.click_observation is missing")
    if observation.get("navigation") != row.get("navigation"):
        _fail(
            f"{name}: run_receipt.click_observation.navigation {observation.get('navigation')!r} "
            f"disagrees with the row navigation {row.get('navigation')!r}"
        )


def validate_run_receipt(manifest: dict) -> None:
    """Refuse a manifest whose rows are not each backed by this run's receipt.

    Requires a top-level ``run_receipt`` (run window and host-dedup
    demonstration) and, for every capture row, a ``run_receipt`` entry tied to
    the same ``capture_run_id`` and stamped inside the run window.
    """
    run_id = manifest.get("capture_run_id")
    if not isinstance(run_id, str) or not run_id.strip():
        _fail("manifest missing capture_run_id for a single coherent run")

    receipt = manifest.get("run_receipt")
    if not isinstance(receipt, dict):
        _fail("manifest missing run_receipt; a deterministic page needs proof this run executed")
    if receipt.get("capture_run_id") != run_id:
        _fail(
            f"run_receipt.capture_run_id {receipt.get('capture_run_id')!r} diverges from the "
            f"manifest run {run_id!r}"
        )

    run_start = parse_timestamp(receipt.get("run_started_at"), label="run_receipt.run_started_at")
    run_end = parse_timestamp(receipt.get("run_finished_at"), label="run_receipt.run_finished_at")
    if run_end < run_start:
        _fail("run_receipt.run_finished_at precedes run_started_at")

    validate_host_dedup_demonstration(receipt.get("host_dedup_demonstration"))

    manifest_revision = manifest.get("revision")
    captures = manifest.get("captures") or []
    if not captures:
        _fail("manifest has no captures to back with a run receipt")
    for row in captures:
        if not isinstance(row, dict):
            _fail("capture row is not an object")
        validate_row_receipt(
            row,
            run_id=run_id,
            run_start=run_start,
            run_end=run_end,
            manifest_revision=str(manifest_revision) if manifest_revision else None,
        )
