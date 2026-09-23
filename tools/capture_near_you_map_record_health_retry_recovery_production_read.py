#!/usr/bin/env python3
"""Production read-back: Near You record retry succeeds after a recoverable failure.

Induces a deferred-record read failure on the served origin, presses the plain-
language retry control after restoring the live deferred route, and records the
recovered deferred content plus neighborhood identity that stayed intact.

Augments docs/evidence/near-you-map-record-health/ without removing the existing
preservation/failure specimens. Commits textual receipts only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "docs/evidence/near-you-map-record-health"
MANIFEST = OUT_DIR / "capture-manifest.json"
PRODUCTION = OUT_DIR / "production-read.json"
READBACK = OUT_DIR / "read-back.json"
SCRATCH = Path(os.environ.get("FM_TASK_SCRATCH") or "/tmp") / "near-you-map-record-health-retry-recovery"

PRODUCTION_HOSTS = frozenset({"cityscroll.org", "www.cityscroll.org"})
ARTIFACT_MANIFEST_PATH = "/artifact-manifest.json"
ARTIFACT_UA = "cityscroll-near-you-map-record-health-retry-recovery-capture/1"
DEFAULT_BASE = "https://cityscroll.org/"
PUBLIC_ALIAS = "c42128caee453"
SCHEMA = "cityscroll.near_you_map_record_health_production_read.v1"
PRODUCER_PATH = "docs/evidence/near-you-map-record-health/read-back.json"

VIEWPORTS = (
    ("desktop", 1440, 900),
    ("mobile", 390, 844),
)

# Same Greenpoint filtered route as the committed failure specimens so recovery
# presses the control those reads already observed as offered.
RECOVERY_SPECIMEN = {
    "id": "BK0101",
    "label": "Greenpoint",
    "route": (
        "/near-you/?geo=nta2020%3ABK0101&surface=map&lens=meetings"
        "&agency=Transportation&q=curb&compare=council_district"
    ),
}


def normalize_base(base: str) -> str:
    return base.rstrip("/") + "/"


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def resolve_base() -> str:
    raw = (os.environ.get("CROL_BASE") or DEFAULT_BASE).strip()
    base = normalize_base(raw)
    host = (urllib.parse.urlparse(base).hostname or "").lower()
    if host not in PRODUCTION_HOSTS:
        raise RuntimeError(f"production read-back requires a cityscroll.org base, got {base}")
    return base


def read_artifact_manifest(base: str) -> dict:
    url = f"{normalize_base(base).rstrip('/')}{ARTIFACT_MANIFEST_PATH}"
    request = urllib.request.Request(
        url,
        headers={"User-Agent": ARTIFACT_UA, "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            payload = json.load(response)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as error:
        raise RuntimeError(f"deployed build revision unavailable at {url}: {error}") from error
    if not isinstance(payload, dict):
        raise RuntimeError(f"artifact-manifest at {url} is not an object")
    return payload


def deployed_revision(manifest: dict) -> str:
    sha = manifest.get("source_commit_sha")
    if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise RuntimeError("artifact-manifest lacks a 40-hex source_commit_sha")
    return sha


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Sorted keys + literal Unicode keep the committed receipt byte-stable and
    # preserve observed copy characters (for example curly apostrophes) without
    # host-dependent \\u escapes.
    path.write_text(
        json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def query_map(url: str) -> dict[str, str]:
    return dict(parse_qsl(urlsplit(url).query, keep_blank_values=True))


def capture_retry_recovery(page, base: str, width: int, height: int, rev: str) -> dict:
    specimen = RECOVERY_SPECIMEN
    route = specimen["route"]
    page.set_viewport_size({"width": width, "height": height})
    page.route(
        "**/near-you/deferred.json*",
        lambda r: r.fulfill(
            status=200,
            content_type="application/json",
            body='{"schema":"cityscroll.near_you_deferred.v1","results_html":null}',
        ),
    )
    page.goto(f"{base.rstrip('/')}{route}", wait_until="domcontentloaded", timeout=60000)
    page.locator("[data-near-you-root]").wait_for(timeout=30000)
    page.locator('[data-near-deferred-state="error"]').first.wait_for(timeout=20000)

    before = page.evaluate(
        """() => {
          const root = document.querySelector('[data-near-you-root]');
          const retry = document.querySelector('[data-near-recovery="retry"]');
          return {
            heading: document.querySelector('.near-hero h1')?.textContent?.trim() || null,
            deferred_state: root?.dataset.nearDeferredState || null,
            retry_present: Boolean(retry),
            retry_label: retry?.textContent?.trim() || null,
            geometry_vintage_present: /Map boundaries:\\s*26B/.test(root?.innerText || ''),
          };
        }"""
    )
    if before["heading"] != specimen["label"]:
        raise AssertionError(f"before heading {before['heading']!r} != {specimen['label']!r}")
    if before["deferred_state"] != "error":
        raise AssertionError(f"expected deferred error before retry, got {before['deferred_state']!r}")
    if not before["retry_present"]:
        raise AssertionError("retry control missing before recovery press")

    page.unroute("**/near-you/deferred.json*")
    retry = page.locator('[data-near-recovery="retry"]').last
    retry.click()

    try:
        page.locator('[data-near-you-root][data-near-deferred-state="ready"]').wait_for(timeout=30000)
    except Exception as error:  # noqa: BLE001
        root_state = page.locator("[data-near-you-root]").get_attribute("data-near-deferred-state")
        raise RuntimeError(
            "retry did not recover to a ready deferred read on production "
            f"(deferred_state={root_state!r}): {error}"
        ) from error

    after = page.evaluate(
        """() => {
          const root = document.querySelector('[data-near-you-root]');
          const results = document.querySelector('.near-results');
          const empty = results?.querySelector('.near-empty');
          const heading = results?.querySelector('#near-results-heading');
          const vintage = /Map boundaries:\\s*(\\S+)/.exec(root?.innerText || '');
          return {
            heading: document.querySelector('.near-hero h1')?.textContent?.trim() || null,
            deferred_state: root?.dataset.nearDeferredState || null,
            data_state: root?.dataset.nearDataState || null,
            retry_present: Boolean(document.querySelector('[data-near-recovery="retry"]')),
            results_heading: heading?.textContent?.trim() || null,
            recovered_copy: empty?.textContent?.trim() || null,
            results_count: results?.dataset.resultsCount || null,
            geometry_vintage: vintage ? vintage[1] : null,
          };
        }"""
    )
    if after["deferred_state"] != "ready":
        raise RuntimeError(
            "retry pressed but deferred read did not recover "
            f"(deferred_state={after['deferred_state']!r})"
        )
    if after["heading"] != specimen["label"]:
        raise AssertionError(
            f"neighborhood identity lost after retry: {after['heading']!r} != {specimen['label']!r}"
        )
    if not after["results_heading"]:
        raise RuntimeError("recovered deferred read missing results heading")
    if after["retry_present"]:
        raise RuntimeError("retry control still present after recovered deferred read")

    after_q = query_map(page.url)
    for key, expected in (
        ("lens", "meetings"),
        ("agency", "Transportation"),
        ("q", "curb"),
        ("compare", "council_district"),
    ):
        if after_q.get(key) != expected:
            raise AssertionError(f"retry dropped {key}: {after_q.get(key)!r}")
    geo = after_q.get("geo")
    if geo not in {f"nta2020:{specimen['id']}", f"geography:nta2020:{specimen['id']}"}:
        raise AssertionError(f"retry lost place geo={geo!r}")

    digest = sha256_text(
        json.dumps(
            {
                "before": before,
                "after": {
                    "heading": after["heading"],
                    "deferred_state": after["deferred_state"],
                    "results_heading": after["results_heading"],
                    "recovered_copy": after["recovered_copy"],
                    "results_count": after["results_count"],
                    "geometry_vintage": after["geometry_vintage"],
                },
                "geo": geo,
            },
            sort_keys=True,
            separators=(",", ":"),
        )
    )
    SCRATCH.mkdir(parents=True, exist_ok=True)
    page.screenshot(
        path=str(SCRATCH / f"retry-recovery-{specimen['id']}-{width}x{height}.png"),
        full_page=True,
    )

    viewport_name = "mobile" if width < 800 else "desktop"
    return {
        "source": "headless-playwright-production-served-site",
        "name": f"production-record-retry-recovery-{specimen['id']}-{viewport_name}",
        "route": route,
        "viewport": {"width": width, "height": height},
        "data_vintage": "nta2020 26B",
        "assertion": (
            f"{specimen['label']} recovers from an induced deferred-record failure after "
            "pressing Try again; neighborhood identity and boundary context stay intact "
            "while deferred content leaves the error state."
        ),
        "sha256": digest,
        "file": None,
        "revision": rev,
        "served_values": {
            "before": {
                "heading": before["heading"],
                "deferred_state": before["deferred_state"],
                "retry_present": before["retry_present"],
                "retry_label": before["retry_label"],
                "geometry_vintage_present": before["geometry_vintage_present"],
            },
            "action": {
                "control": "data-near-recovery=retry",
                "retry_pressed": True,
                "method": "click",
                "label": before["retry_label"],
            },
            "after": {
                "heading": after["heading"],
                "deferred_state": after["deferred_state"],
                "data_state": after["data_state"],
                "retry_present": after["retry_present"],
                "results_heading": after["results_heading"],
                "recovered_copy": after["recovered_copy"],
                "results_count": after["results_count"],
                "geometry_vintage": after["geometry_vintage"],
            },
            "neighborhood_context_intact": True,
            "retry_preserved": {
                "lens": after_q.get("lens"),
                "agency": after_q.get("agency"),
                "q": after_q.get("q"),
                "compare": after_q.get("compare"),
                "geo": geo,
            },
        },
    }


def existing_preservation_reads(existing: dict) -> list[dict]:
    reads = existing.get("reads") or existing.get("captures") or []
    preserved = []
    for row in reads:
        name = row.get("name") or ""
        if "retry-recovery" in name:
            continue
        preserved.append(row)
    return preserved


def build_receipt(
    *,
    base: str,
    artifact: dict,
    rev: str,
    observed_at: str,
    preservation_reads: list[dict],
    recovery_reads: list[dict],
) -> dict:
    generated_at = artifact.get("generated_at")
    return {
        "schema": SCHEMA,
        "public_alias": PUBLIC_ALIAS,
        "observed_at": observed_at,
        "evidence_class": "deployed-production-read-back",
        "origin": normalize_base(base).rstrip("/"),
        "deployment": {
            "manifest_url": f"{normalize_base(base).rstrip('/')}{ARTIFACT_MANIFEST_PATH}",
            "revision": rev,
            "generated_at": generated_at,
            "deployment_at": artifact.get("deployment_at") or generated_at,
            "manifest_sha256": sha256_text(json.dumps(artifact, sort_keys=True)),
        },
        "capture": {
            "tool": "tools/capture_near_you_map_record_health_retry_recovery_production_read.py",
            "browser": "chromium",
            "viewports": [{"name": n, "width": w, "height": h} for n, w, h in VIEWPORTS],
            "screenshot_binaries_committed": False,
            "recovery_method": (
                "Fulfill deferred.json with results_html null to induce a recoverable "
                "record-read failure, unroute, press data-near-recovery=retry, and wait "
                "for data-near-deferred-state=ready on the live deferred response."
            ),
        },
        "producer": {
            "path": PRODUCER_PATH,
            "schema": SCHEMA,
            "letters": ["A3"],
        },
        "letters": {
            "A3": {
                "clause": "retry_succeeds_after_recoverable_read_failure",
                "route": RECOVERY_SPECIMEN["route"],
                "reads": recovery_reads,
            }
        },
        "preservation_reads": preservation_reads,
        "reads": preservation_reads + recovery_reads,
        "summary": {
            "preservation_specimen_count": 3,
            "preservation_capture_count": len(preservation_reads),
            "recovery_capture_count": len(recovery_reads),
            "capture_count": len(preservation_reads) + len(recovery_reads),
        },
    }


def build_manifest(receipt: dict) -> dict:
    rev = receipt["deployment"]["revision"]
    captures = []
    for row in receipt.get("preservation_reads") or []:
        captures.append(row)
    for row in receipt["letters"]["A3"]["reads"]:
        captures.append(row)
    return {
        "schema": "cityscroll.render_capture_manifest.v1",
        "feature": "near-you-map-record-health",
        "public_alias": PUBLIC_ALIAS,
        "surface": "Near You map and record health",
        "base": normalize_base(receipt["origin"]),
        "condition": (
            f"Production base {normalize_base(receipt['origin'])} after deployment; "
            "no image binary is committed."
        ),
        "capture_mode": "headless-playwright-production-served-site",
        "revision_format": "served artifact-manifest source_commit_sha",
        "revision": rev,
        "repository_revision": rev,
        "grounded_at": rev,
        "data_vintage": "nta2020 26B",
        "image_binaries_committed": False,
        "image_policy": (
            "Screenshots may exist under the local task scratch directory; "
            "only this manifest is committed."
        ),
        "note": (
            "Production desktop/mobile record-failure preservation reads plus "
            "pressed-retry recovery observations; textual hashes only."
        ),
        "producer": receipt["producer"],
        "captures": captures,
    }


def validate(receipt: dict) -> None:
    if receipt.get("schema") != SCHEMA:
        raise AssertionError(f"unexpected schema {receipt.get('schema')}")
    if receipt.get("public_alias") != PUBLIC_ALIAS:
        raise AssertionError("public_alias mismatch")
    deployment = receipt.get("deployment") or {}
    if not re.fullmatch(r"[0-9a-f]{40}", deployment.get("revision") or ""):
        raise AssertionError("deployment.revision must be a 40-hex served SHA")
    producer = receipt.get("producer") or {}
    if producer.get("path") != PRODUCER_PATH:
        raise AssertionError("producer path mismatch")
    if producer.get("letters") != ["A3"]:
        raise AssertionError("producer letters mismatch")
    a3 = ((receipt.get("letters") or {}).get("A3") or {})
    if a3.get("clause") != "retry_succeeds_after_recoverable_read_failure":
        raise AssertionError("A3 clause mismatch")
    reads = a3.get("reads") or []
    if len(reads) < 1:
        raise AssertionError("A3 recovery reads missing")
    for row in reads:
        values = row.get("served_values") or {}
        before = values.get("before") or {}
        action = values.get("action") or {}
        after = values.get("after") or {}
        if before.get("deferred_state") != "error":
            raise AssertionError("A3 before deferred_state must be error")
        if action.get("retry_pressed") is not True:
            raise AssertionError("A3 action must record retry_pressed")
        if after.get("deferred_state") != "ready":
            raise AssertionError("A3 after deferred_state must be ready")
        if not after.get("results_heading"):
            raise AssertionError("A3 after must record recovered results_heading")
        if after.get("heading") != before.get("heading"):
            raise AssertionError("A3 neighborhood heading must stay intact")
        if values.get("neighborhood_context_intact") is not True:
            raise AssertionError("A3 must record neighborhood_context_intact")
        # Recorded values only — never require a pass verdict field.
        if "result" in after or "pass" in after:
            raise AssertionError("A3 recovered values must not carry a pass verdict")


def assert_canonical_json(path: Path) -> None:
    raw = path.read_text(encoding="utf-8")
    data = json.loads(raw)
    canonical = json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    if raw != canonical:
        raise AssertionError(f"{path.relative_to(ROOT)} is not canonical sorted-key JSON")


def check() -> None:
    receipt = load_json(READBACK)
    validate(receipt)
    assert_canonical_json(READBACK)
    production = load_json(PRODUCTION)
    if production.get("schema") != SCHEMA:
        raise AssertionError("production-read schema mismatch")
    if production.get("producer", {}).get("letters") != ["A3"]:
        raise AssertionError("production-read producer letters mismatch")
    if not ((production.get("letters") or {}).get("A3") or {}).get("reads"):
        raise AssertionError("production-read missing A3 recovery reads")
    assert_canonical_json(PRODUCTION)
    manifest = load_json(MANIFEST)
    if manifest.get("public_alias") != PUBLIC_ALIAS:
        raise AssertionError("capture-manifest public_alias mismatch")
    if manifest.get("producer", {}).get("letters") != ["A3"]:
        raise AssertionError("capture-manifest producer letters mismatch")
    assert_canonical_json(MANIFEST)
    recovery_names = {row["name"] for row in receipt["letters"]["A3"]["reads"]}
    manifest_names = {row.get("name") for row in manifest.get("captures") or []}
    if not recovery_names.issubset(manifest_names):
        raise AssertionError("capture-manifest missing recovery captures")
    preservation = receipt.get("preservation_reads") or []
    if len(preservation) < 6:
        raise AssertionError("preservation failure specimens must remain present")
    print(f"near-you-map-record-health retry-recovery check passed: {READBACK.relative_to(ROOT)}")


def capture() -> dict:
    base = resolve_base()
    artifact = read_artifact_manifest(base)
    rev = deployed_revision(artifact)
    observed_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    print(f"production base={base} revision={rev}", flush=True)

    existing: dict = {}
    if PRODUCTION.exists():
        existing = load_json(PRODUCTION)
    elif READBACK.exists():
        existing = load_json(READBACK)
    preservation_reads = existing_preservation_reads(existing)
    if len(preservation_reads) < 6:
        raise RuntimeError(
            "refusing to write recovery without the committed preservation failure specimens"
        )

    recovery_reads: list[dict] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(user_agent="Mozilla/5.0 (compatible; CityScrollCapture/1.0)")
        page = context.new_page()
        for name, width, height in VIEWPORTS:
            print(f"retry-recovery {RECOVERY_SPECIMEN['id']} {name}", flush=True)
            recovery_reads.append(capture_retry_recovery(page, base, width, height, rev))
        browser.close()

    return build_receipt(
        base=base,
        artifact=artifact,
        rev=rev,
        observed_at=observed_at,
        preservation_reads=preservation_reads,
        recovery_reads=recovery_reads,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        check()
        return 0
    receipt = capture()
    write_json(READBACK, receipt)
    write_json(PRODUCTION, receipt)
    write_json(MANIFEST, build_manifest(receipt))
    print(f"wrote {READBACK.relative_to(ROOT)}", flush=True)
    print(f"wrote {PRODUCTION.relative_to(ROOT)}", flush=True)
    print(f"wrote {MANIFEST.relative_to(ROOT)}", flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(exc, file=sys.stderr)
        raise
