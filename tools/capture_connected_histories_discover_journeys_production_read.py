#!/usr/bin/env python3
"""Production census of documented-history discover journeys.

Reads the served origin, pins a landed default-branch commit, brackets the
run with Pages artifact-manifest revisions, and counts journeys attempted
versus journeys satisfied across the fixed six-case dossier and three named
profiles. The retained observation carries denominators so a measured zero is
distinct from an absent measurement. It never records a self-asserted pass
verdict.

  python3 tools/capture_connected_histories_discover_journeys_production_read.py \
    --production --landed-commit <40-hex> --write

  python3 tools/capture_connected_histories_discover_journeys_production_read.py --check
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
from typing import Callable

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from deployed_capture_ancestor import (  # noqa: E402
    DEFAULT_BRANCH_REF,
    PAGE_ARTIFACT_MANIFEST,
    CaptureAncestorError,
    DeployPendingError,
    ServedDataMissingError,
    WrongPinError,
    require_served_page_revision_contains_delivery,
    resolve_landed_ancestor,
    served_page_revision,
)
from repository_revision import resolve_repository_revision  # noqa: E402

DEFAULT_BASE = "https://cityscroll.org"
PRODUCTION_HOSTS = frozenset({"cityscroll.org", "www.cityscroll.org"})
USER_AGENT = "cityscroll-discover-journeys-production-read/1"
RECEIPT_HEADERS = (
    "Date",
    "CF-Ray",
    "CF-Cache-Status",
    "Age",
    "ETag",
    "Last-Modified",
    "Content-Type",
)
DATA_PATHS = (
    "/data/connected_history_relations.json",
    "/data/connected_history_time.json",
    "/data/connected_history_roles.json",
)
CASES = (
    ("coyle", "2025-54-A", "Coyle Street BSA cases"),
    ("franklin-avenue", "960 Franklin Avenue", "Franklin Avenue application history"),
    ("kingsbridge-armory", "Kingsbridge Armory", "Kingsbridge Armory proposal history"),
    ("sixth-avenue", "Sixth Avenue", "Sixth Avenue corridor history"),
    ("thirty-first-avenue", "31st Avenue", "31st Avenue corridor history"),
    ("lighthouse-point", "Lighthouse Point", "Lighthouse Point component history"),
)
PROFILES = (
    ("desktop-keyboard", 1440, 900, False),
    ("narrow-touch", 390, 844, True),
    ("no-javascript", 1440, 900, False),
)
NO_JS_LINK_NAMES = {
    "coyle": "Coyle Street BSA cases",
    "franklin-avenue": "Franklin Avenue applications",
    "kingsbridge-armory": "Kingsbridge Armory proposals",
    "sixth-avenue": "Sixth Avenue corridor",
    "thirty-first-avenue": "31st Avenue corridor",
    "lighthouse-point": "Lighthouse Point components",
}
SCHEMA = "cityscroll.connected_histories_discover_journeys.v1"
PROVENANCE_SCHEMA = "cityscroll.production_provenance.v1"
OUT_PATH = ROOT / "docs/evidence/connected-histories/discover-journeys-readback.json"
PUBLIC_ALIAS = "cf369ad9238fe"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")


class ServedRevisionChangedError(CaptureAncestorError):
    """The served Pages revision moved between the start and end of a read."""


class RequestReceiptError(CaptureAncestorError):
    """A served request lacks its own edge receipt."""


class ObservationValidationError(ValueError):
    """Retained observation failed a structural or provenance check."""


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def utc_now_precise() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_text(value: str) -> str:
    return sha256_bytes(value.encode("utf-8"))


def route_for(query: str) -> str:
    encoded = urllib.parse.quote_plus(query)
    return f"/search/?q={encoded}&source_scope=all#connected-history"


def require_production_base(base: str) -> str:
    normalized = base.rstrip("/") + "/"
    host = (urllib.parse.urlparse(normalized).hostname or "").lower()
    if host not in PRODUCTION_HOSTS:
        raise SystemExit(f"production capture requires cityscroll.org, got {base}")
    return normalized.rstrip("/")


def http_get(url: str) -> dict:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/json, text/html;q=0.8",
            "Cache-Control": "no-cache",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            # Keep the email-message header map: lookups are case-insensitive
            # (Cloudflare may emit CF-RAY rather than CF-Ray).
            return {
                "status": int(response.status),
                "headers": response.headers,
                "body": response.read(),
            }
    except urllib.error.HTTPError as error:
        return {
            "status": int(error.code),
            "headers": error.headers,
            "body": error.read() if hasattr(error, "read") else b"",
        }


def require_json_content_type(url: str, headers: dict, body: bytes) -> None:
    content_type = str(headers.get("Content-Type") or headers.get("content-type") or "")
    if "application/json" not in content_type.lower():
        preview = body[:80].decode("utf-8", errors="replace")
        raise ServedDataMissingError(
            f"served history materialization absent at {url}: content-type {content_type!r} body={preview!r}"
        )


def require_distinct_receipts(receipts: list[dict]) -> None:
    rays = [receipt.get("edge_ray") for receipt in receipts]
    if any(not isinstance(ray, str) or not ray.strip() for ray in rays):
        raise RequestReceiptError("served request is missing its own edge ray receipt")
    if len(set(rays)) != len(rays):
        raise RequestReceiptError("served request edge ray receipts are not distinct")


def require_census_counts(census: dict) -> tuple[int, int]:
    if not isinstance(census, dict):
        raise ObservationValidationError("census is absent rather than a counted observation")
    if "journeys_attempted" not in census:
        raise ObservationValidationError(
            "census.journeys_attempted is absent rather than zero; absence is refused"
        )
    if "journeys_satisfied" not in census:
        raise ObservationValidationError(
            "census.journeys_satisfied is absent rather than zero; absence is refused"
        )
    attempted = census["journeys_attempted"]
    satisfied = census["journeys_satisfied"]
    if type(attempted) is not int or attempted < 0:
        raise ObservationValidationError("census.journeys_attempted must be a non-negative integer")
    if type(satisfied) is not int or satisfied < 0:
        raise ObservationValidationError("census.journeys_satisfied must be a non-negative integer")
    if satisfied > attempted:
        raise ObservationValidationError(
            f"census.journeys_satisfied ({satisfied}) exceeds journeys_attempted ({attempted})"
        )
    return attempted, satisfied


def refuse_synthetic_provenance(payload: dict) -> None:
    provenance = payload.get("provenance")
    if not isinstance(provenance, dict):
        raise ObservationValidationError(
            "production provenance not retained (fixture-built files cannot certify production)"
        )
    bad_markers = ("fixture", "rehearsal", "synthetic", "isolated", "simulation")
    blob = json.dumps(provenance, sort_keys=True).lower()
    for marker in bad_markers:
        if marker in blob and provenance.get("evidence_class") != "live-production-read":
            raise ObservationValidationError(
                "fixture/rehearsal/synthetic provenance cannot prove a production gate"
            )
        if provenance.get(marker) is True:
            raise ObservationValidationError(
                "fixture/rehearsal/synthetic provenance cannot prove a production gate"
            )
    if provenance.get("schema") != PROVENANCE_SCHEMA:
        raise ObservationValidationError(
            f"provenance.schema must be {PROVENANCE_SCHEMA!r}"
        )
    if provenance.get("evidence_class") != "live-production-read":
        raise ObservationValidationError(
            "production provenance not retained (fixture-built files cannot certify production)"
        )
    if provenance.get("isolated") is not False:
        raise ObservationValidationError(
            "fixture/rehearsal/synthetic provenance cannot prove a production gate"
        )
    if provenance.get("environment") != "production":
        raise ObservationValidationError(
            "production provenance not retained (fixture-built files cannot certify production)"
        )


def validate_observation(payload: dict) -> dict:
    if not isinstance(payload, dict):
        raise ObservationValidationError("observation must be an object")
    if payload.get("schema") != SCHEMA:
        raise ObservationValidationError(f"schema must be {SCHEMA!r}")
    for key in ("observed_at", "origin", "served_revision", "required_landed_commit"):
        value = payload.get(key)
        if not isinstance(value, str) or not value.strip():
            raise ObservationValidationError(f"{key} is required")
    if not SHA_RE.fullmatch(str(payload["served_revision"])):
        raise ObservationValidationError("served_revision must be a 40-hex commit")
    if not SHA_RE.fullmatch(str(payload["required_landed_commit"])):
        raise ObservationValidationError("required_landed_commit must be a 40-hex commit")
    refuse_synthetic_provenance(payload)
    attempted, satisfied = require_census_counts(payload.get("census") or {})
    journeys = payload.get("journeys")
    if not isinstance(journeys, list):
        raise ObservationValidationError("journeys list is required")
    if len(journeys) != attempted:
        raise ObservationValidationError(
            f"journeys length {len(journeys)} does not match journeys_attempted {attempted}"
        )
    derived_satisfied = sum(1 for row in journeys if isinstance(row, dict) and row.get("satisfied") is True)
    if derived_satisfied != satisfied:
        raise ObservationValidationError(
            f"census.journeys_satisfied {satisfied} does not match journey rows ({derived_satisfied})"
        )
    if "result" in payload or "verdict" in payload or "passed" in payload:
        raise ObservationValidationError(
            "observation must not carry a self-asserted verdict field"
        )
    return {
        "journeys_attempted": attempted,
        "journeys_satisfied": satisfied,
        "served_revision": payload["served_revision"],
        "observed_at": payload["observed_at"],
    }


def observe_scripted_journey(page, family_id: str, query: str) -> dict:
    panel = page.locator("[data-connected-history]")
    page.wait_for_function(
        """family => {
          const node = document.querySelector('[data-connected-history]');
          return node
            && node.dataset.connectedHistoryState === 'ready'
            && node.dataset.connectedHistoryFamily === family;
        }""",
        arg=family_id,
        timeout=45_000,
    )
    event_count = panel.locator(".connected-history-event").count()
    identities = panel.locator(".connected-history-identities").inner_text()
    measured = page.evaluate(
        """() => ({
          width: window.innerWidth,
          height: window.innerHeight,
          query: new URLSearchParams(location.search).get('q'),
          state: document.querySelector('[data-connected-history]')?.dataset.connectedHistoryState || null,
          family: document.querySelector('[data-connected-history]')?.dataset.connectedHistoryFamily || null,
        })"""
    )
    satisfied = (
        measured.get("state") == "ready"
        and measured.get("family") == family_id
        and measured.get("query") == query
        and event_count > 0
        and identities.count("·") >= 1
    )
    return {
        "satisfied": bool(satisfied),
        "runtime": measured,
        "event_count": event_count,
        "identity_separators": identities.count("·"),
    }


def observe_no_javascript_journey(page, family_id: str, query: str) -> dict:
    fallback = page.locator("noscript .connected-history")
    fallback.wait_for(state="visible", timeout=30_000)
    link = fallback.get_by_role("link", name=NO_JS_LINK_NAMES[family_id])
    href = link.get_attribute("href")
    measured = page.evaluate(
        """() => ({
          width: window.innerWidth,
          height: window.innerHeight,
          query: new URLSearchParams(location.search).get('q'),
          route: `${location.pathname}${location.search}${location.hash}`,
        })"""
    )
    satisfied = bool(href) and measured.get("query") == query
    return {
        "satisfied": bool(satisfied),
        "runtime": measured,
        "official_source_href": href,
    }


def run_browser_journeys(base: str) -> list[dict]:
    from playwright.sync_api import sync_playwright

    observations: list[dict] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for profile_name, width, height, has_touch in PROFILES:
                for family_id, query, title in CASES:
                    route = route_for(query)
                    java_script_enabled = profile_name != "no-javascript"
                    context = browser.new_context(
                        viewport={"width": width, "height": height},
                        has_touch=has_touch,
                        java_script_enabled=java_script_enabled,
                    )
                    page = context.new_page()
                    try:
                        response = page.goto(
                            f"{base}{route}",
                            wait_until="domcontentloaded",
                            timeout=60_000,
                        )
                        if response is None or response.status != 200:
                            status = None if response is None else response.status
                            raise ServedDataMissingError(
                                f"served journey route unavailable at {base}{route} (HTTP {status})"
                            )
                        if java_script_enabled:
                            detail = observe_scripted_journey(page, family_id, query)
                        else:
                            detail = observe_no_javascript_journey(page, family_id, query)
                        observations.append({
                            "family_id": family_id,
                            "title": title,
                            "query": query,
                            "profile": profile_name,
                            "route": route,
                            "viewport": {"width": width, "height": height, "has_touch": has_touch},
                            "satisfied": detail["satisfied"],
                            "runtime": detail.get("runtime"),
                            "observation": {
                                key: value
                                for key, value in detail.items()
                                if key not in {"satisfied", "runtime"}
                            },
                        })
                    finally:
                        page.close()
                        context.close()
        finally:
            browser.close()
    return observations


def production_read(
    base: str,
    landed_commit: str,
    *,
    get: Callable[[str], dict] = http_get,
    journey_runner: Callable[[str], list[dict]] | None = None,
    cwd: Path = ROOT,
    main_ref: str = DEFAULT_BRANCH_REF,
    repository_revision: str | None = None,
    observed_at: str | None = None,
) -> dict:
    """Count discover journeys against the served origin with fail-closed pins."""

    receipts: list[dict] = []

    def fetch(request_name: str, path: str, *, accept_html: bool = False) -> tuple[str, dict]:
        url = urllib.parse.urljoin(base.rstrip("/") + "/", path.lstrip("/"))
        try:
            response = get(url)
        except (OSError, urllib.error.URLError) as error:
            raise ServedDataMissingError(f"served resource absent at {url}: {error}") from error
        headers = response["headers"]
        receipts.append({
            "request": request_name,
            "url": url,
            "http_status": response["status"],
            "observed_at": utc_now_precise(),
            "edge_ray": headers.get("CF-Ray"),
            "sha256": sha256_bytes(response["body"] or b""),
            "bytes": len(response["body"] or b""),
            "headers": {
                key: headers.get(key)
                for key in RECEIPT_HEADERS
                if headers.get(key) is not None
            },
        })
        if not accept_html:
            require_json_content_type(url, headers, response["body"] or b"")
            if response["status"] != 200:
                raise ServedDataMissingError(
                    f"served history materialization missing at {url} (HTTP {response['status']})"
                )
        return url, response
    def served_manifest(request_name: str):
        def fetch_json(_url: str) -> dict:
            url, response = fetch(request_name, PAGE_ARTIFACT_MANIFEST)
            try:
                manifest = json.loads((response["body"] or b"").decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise DeployPendingError(f"served page artifact-manifest is not JSON: {url}") from error
            if response["status"] != 200 or not isinstance(manifest, dict):
                raise DeployPendingError(
                    f"served page artifact-manifest unavailable: {url} (HTTP {response['status']})"
                )
            return manifest

        return fetch_json

    required = resolve_landed_ancestor(landed_commit, cwd=cwd, main_ref=main_ref)
    served_revision = require_served_page_revision_contains_delivery(
        base,
        required,
        cwd=cwd,
        main_ref=main_ref,
        fetch_json=served_manifest("served_revision_start"),
    )

    data_vintages: dict[str, str | None] = {}
    for path in DATA_PATHS:
        url, response = fetch(f"history_data:{path}", path)
        try:
            payload = json.loads((response["body"] or b"").decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ServedDataMissingError(f"served history body is not valid JSON at {url}") from error
        if not isinstance(payload, dict):
            raise ServedDataMissingError(f"served history materialization is not an object at {url}")
        vintage = None
        for key in ("generated_at", "as_of", "vintage"):
            if isinstance(payload.get(key), str):
                vintage = payload[key]
                break
        data_vintages[path] = vintage

    runner = journey_runner or run_browser_journeys
    journeys = runner(base.rstrip("/"))
    if not isinstance(journeys, list):
        raise ServedDataMissingError("journey runner did not return a list of observations")
    expected = len(CASES) * len(PROFILES)
    if len(journeys) != expected:
        raise ServedDataMissingError(
            f"discover-journey census is incomplete: {len(journeys)} journeys, expected {expected}"
        )
    for row in journeys:
        if not isinstance(row, dict) or "satisfied" not in row:
            raise ServedDataMissingError("journey observation missing satisfied boolean")
        if row.get("satisfied") is not True and row.get("satisfied") is not False:
            raise ServedDataMissingError("journey satisfied must be a boolean, never absent")

    served_revision_after = served_page_revision(base, fetch_json=served_manifest("served_revision_end"))
    if served_revision_after != served_revision:
        raise ServedRevisionChangedError(
            f"served revision changed during the production read: {served_revision} -> {served_revision_after}"
        )
    require_distinct_receipts(receipts)

    attempted = len(journeys)
    satisfied = sum(1 for row in journeys if row.get("satisfied") is True)
    revision = repository_revision or resolve_repository_revision(cwd, main_ref=main_ref)
    stamp = observed_at or utc_now()
    tool_path = "tools/capture_connected_histories_discover_journeys_production_read.py"
    # Hash the producer from this checkout (ROOT), not the throwaway git cwd
    # used by refusal harnesses to prove pin ancestry.
    tool_sha = sha256_bytes((ROOT / tool_path).read_bytes())
    observation = {
        "schema": SCHEMA,
        "observed_at": stamp,
        "origin": base.rstrip("/"),
        "public_alias": PUBLIC_ALIAS,
        "required_landed_commit": required,
        "served_revision": served_revision,
        "served_revision_after": served_revision_after,
        "repository_revision": revision,
        "revision_pin": {
            "state": "exact" if required == served_revision == served_revision_after else "descendant",
            "required_landed_commit": required,
            "served_revision_start": served_revision,
            "served_revision_end": served_revision_after,
        },
        "provenance": {
            "schema": PROVENANCE_SCHEMA,
            "evidence_class": "live-production-read",
            "isolated": False,
            "environment": "production",
            "source": base.rstrip("/"),
            "observer": {
                "tool": tool_path,
                "mode": "production",
            },
        },
        "measurement_provenance": {
            "revision": revision,
            "inputs": [
                {"path": tool_path, "sha256": tool_sha},
            ],
        },
        "data_vintage": data_vintages,
        "census": {
            "journeys_attempted": attempted,
            "journeys_satisfied": satisfied,
            "families": [family_id for family_id, _query, _title in CASES],
            "profiles": [name for name, _w, _h, _touch in PROFILES],
            "expected_journeys": expected,
        },
        "journeys": journeys,
        "request_receipts": receipts,
        "image_binaries_committed": False,
    }
    validate_observation(observation)
    return observation


def write_observation(observation: dict, path: Path = OUT_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"{json.dumps(observation, indent=2, sort_keys=False)}\n", encoding="utf-8")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--production", action="store_true")
    parser.add_argument("--landed-commit")
    parser.add_argument("--base-url", default=DEFAULT_BASE)
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--output", type=Path, default=OUT_PATH)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.check:
        payload = json.loads(args.output.read_text(encoding="utf-8"))
        summary = validate_observation(payload)
        print(
            "discover-journeys production read-back passed: "
            f"attempted={summary['journeys_attempted']} satisfied={summary['journeys_satisfied']} "
            f"served_revision={summary['served_revision']}"
        )
        return 0

    if not args.production:
        raise SystemExit("this producer only supports --production against the served origin")
    if not args.landed_commit:
        raise SystemExit("--production requires --landed-commit")

    base = require_production_base(args.base_url)
    observation = production_read(base, args.landed_commit)
    if args.write:
        write_observation(observation, args.output)
        print(
            f"wrote {args.output.relative_to(ROOT)} "
            f"attempted={observation['census']['journeys_attempted']} "
            f"satisfied={observation['census']['journeys_satisfied']} "
            f"served_revision={observation['served_revision']}"
        )
    else:
        print(json.dumps(observation, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except CaptureAncestorError as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(2) from error
    except ObservationValidationError as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(2) from error
