#!/usr/bin/env python3
"""Production census of geographic discoverability across all 59 boards.

Reads the served coverage artifact, pins a landed default-branch commit,
brackets the run with Pages artifact-manifest revisions, and counts areas
attempted versus areas discoverable. A measured zero stays distinct from an
absent measurement. The observation never records a self-asserted pass verdict.

  python3 tools/capture_connected_histories_geographic_discoverability_production_read.py \
    --production --landed-commit <40-hex> --write

  python3 tools/capture_connected_histories_geographic_discoverability_production_read.py --check
"""

from __future__ import annotations

import argparse
import hashlib
import json
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
USER_AGENT = "cityscroll-geographic-discoverability-production-read/1"
RECEIPT_HEADERS = (
    "Date",
    "CF-Ray",
    "CF-Cache-Status",
    "Age",
    "ETag",
    "Last-Modified",
    "Content-Type",
)
DATA_PATH = "/data/connected_history_coverage.json"
REPOSITORY_DATA_PATH = "site/data/connected_history_coverage.json"
BOARD_REGISTRY_PATH = "site/data/community_board_constellation_lookup.json"
CANONICAL_BOARD_COUNT = 59
STAGES = ("registered", "acquired", "extractable", "admitted", "discoverable")
STAGE_STATES = frozenset({"observed", "partial", "measured_zero", "unknown"})
SCHEMA = "cityscroll.connected_histories_geographic_discoverability.v1"
COVERAGE_SCHEMA = "cityscroll.connected_history_coverage.v1"
PROVENANCE_SCHEMA = "cityscroll.production_provenance.v1"
OUT_PATH = ROOT / "docs/evidence/connected-histories/geographic-discoverability-readback.json"
PUBLIC_ALIAS = "cea7b8f3a22f7"
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


def require_production_base(base: str) -> str:
    normalized = base.rstrip("/")
    host = (urllib.parse.urlsplit(normalized).hostname or "").lower()
    if host not in PRODUCTION_HOSTS:
        raise SystemExit(f"production capture requires cityscroll.org, got {base}")
    return normalized


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


def require_json_content_type(url: str, headers, body: bytes) -> None:
    content_type = str(headers.get("Content-Type") or "")
    if "application/json" not in content_type.lower() or not (body or b"").lstrip().startswith(b"{"):
        preview = (body or b"")[:80].decode("utf-8", errors="replace")
        raise ServedDataMissingError(
            f"served coverage is absent at {url}: content-type {content_type!r} body={preview!r}"
        )


def require_distinct_receipts(receipts: list[dict]) -> None:
    rays = [receipt.get("edge_ray") for receipt in receipts]
    if any(not isinstance(ray, str) or not ray.strip() for ray in rays):
        raise RequestReceiptError("served request is missing its own edge ray receipt")
    if len(set(rays)) != len(rays):
        raise RequestReceiptError("served request edge ray receipts are not distinct")


def canonical_board_ids(cwd: Path = ROOT) -> list[str]:
    registry = json.loads((Path(cwd) / BOARD_REGISTRY_PATH).read_text(encoding="utf-8"))
    return sorted(registry["by_id"])


def require_board_enumeration(boards, canonical_ids: list[str] | None = None) -> None:
    if not isinstance(boards, list) or len(boards) != CANONICAL_BOARD_COUNT:
        count = len(boards) if isinstance(boards, list) else "no"
        raise ServedDataMissingError(
            f"served coverage board enumeration is incomplete: {count} boards, "
            f"expected {CANONICAL_BOARD_COUNT}"
        )
    ids = [row.get("board_id") if isinstance(row, dict) else None for row in boards]
    if len(set(ids)) != CANONICAL_BOARD_COUNT or ids != sorted(ids, key=str):
        raise ServedDataMissingError(
            "served coverage board enumeration is incomplete: identities are missing, duplicated, or unordered"
        )
    if canonical_ids is not None and ids != sorted(canonical_ids):
        missing = sorted(set(canonical_ids) - set(ids))
        extra = sorted(set(ids) - set(canonical_ids))
        raise ServedDataMissingError(
            "served coverage board enumeration is incomplete: "
            f"differs from the canonical board registry (missing {missing}, unexpected {extra})"
        )


def build_area_rows(boards: list[dict]) -> list[dict]:
    """Project per-board discoverability rows with an explicit boolean.

    ``unknown`` means the area was attempted and discoverability is unresolved.
    ``measured_zero`` is a measured non-discoverable outcome (zero subjects).
    ``partial`` / ``observed`` with unique_subjects > 0 count as discoverable.
    """

    areas = []
    for row in boards:
        stage = row["stages"]["discoverable"]
        unique = stage.get("unique_subjects")
        discoverable = (
            stage.get("state") in {"partial", "observed"}
            and type(unique) is int
            and unique > 0
        )
        areas.append({
            "board_id": row["board_id"],
            "discoverable": bool(discoverable),
            "state": stage.get("state"),
            "unique_subjects": unique,
            "unknown_subjects": stage.get("unknown_subjects"),
        })
    return areas


def require_census_counts(census: dict) -> tuple[int, int]:
    if not isinstance(census, dict):
        raise ObservationValidationError("census is absent rather than a counted observation")
    if "areas_attempted" not in census:
        raise ObservationValidationError(
            "census.areas_attempted is absent rather than zero; absence is refused"
        )
    if "areas_discoverable" not in census:
        raise ObservationValidationError(
            "census.areas_discoverable is absent rather than zero; absence is refused"
        )
    attempted = census["areas_attempted"]
    discoverable = census["areas_discoverable"]
    if type(attempted) is not int or attempted < 0:
        raise ObservationValidationError("census.areas_attempted must be a non-negative integer")
    if type(discoverable) is not int or discoverable < 0:
        raise ObservationValidationError("census.areas_discoverable must be a non-negative integer")
    if discoverable > attempted:
        raise ObservationValidationError(
            f"census.areas_discoverable ({discoverable}) exceeds areas_attempted ({attempted})"
        )
    return attempted, discoverable


def refuse_synthetic_provenance(payload: dict) -> None:
    provenance = payload.get("provenance")
    if not isinstance(provenance, dict):
        raise ObservationValidationError(
            "production provenance not retained (fixture-built files cannot certify production)"
        )
    for marker in ("fixture", "rehearsal", "synthetic", "isolated", "simulation"):
        if provenance.get(marker) is True:
            raise ObservationValidationError(
                "fixture/rehearsal/synthetic provenance cannot prove a production gate"
            )
    if provenance.get("schema") != PROVENANCE_SCHEMA:
        raise ObservationValidationError(f"provenance.schema must be {PROVENANCE_SCHEMA!r}")
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
    attempted, discoverable = require_census_counts(payload.get("census") or {})
    areas = payload.get("areas")
    if not isinstance(areas, list):
        raise ObservationValidationError("areas list is required")
    if len(areas) != attempted:
        raise ObservationValidationError(
            f"areas length {len(areas)} does not match areas_attempted {attempted}"
        )
    derived = sum(1 for row in areas if isinstance(row, dict) and row.get("discoverable") is True)
    if derived != discoverable:
        raise ObservationValidationError(
            f"census.areas_discoverable {discoverable} does not match area rows ({derived})"
        )
    if "result" in payload or "verdict" in payload or "passed" in payload:
        raise ObservationValidationError(
            "observation must not carry a self-asserted verdict field"
        )
    return {
        "areas_attempted": attempted,
        "areas_discoverable": discoverable,
        "served_revision": payload["served_revision"],
        "observed_at": payload["observed_at"],
    }


def production_read(
    base: str,
    landed_commit: str,
    *,
    get: Callable[[str], dict] = http_get,
    cwd: Path = ROOT,
    main_ref: str = DEFAULT_BRANCH_REF,
    canonical_ids: list[str] | None = None,
    repository_revision: str | None = None,
    observed_at: str | None = None,
) -> dict:
    receipts: list[dict] = []

    def fetch(request_name: str, path: str) -> tuple[str, dict]:
        url = urllib.parse.urljoin(base.rstrip("/") + "/", path.lstrip("/"))
        try:
            response = get(url)
        except (OSError, urllib.error.URLError) as error:
            raise ServedDataMissingError(f"served coverage is absent at {url}: {error}") from error
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

    url, response = fetch("coverage_census", DATA_PATH)
    require_json_content_type(url, response["headers"], response["body"] or b"")
    if response["status"] != 200:
        raise ServedDataMissingError(f"served coverage is absent at {url}: HTTP {response['status']}")
    try:
        payload = json.loads((response["body"] or b"").decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ServedDataMissingError(f"served coverage body is not valid JSON at {url}") from error
    if not isinstance(payload, dict) or payload.get("schema") != COVERAGE_SCHEMA:
        raise ServedDataMissingError("served coverage has the wrong or absent schema")

    boards = payload.get("snapshots", {}).get("post_change", {}).get("boards")
    ids = canonical_ids if canonical_ids is not None else canonical_board_ids(ROOT)
    require_board_enumeration(boards, ids)
    for row in boards:
        if set(row.get("stages", {})) != set(STAGES):
            raise ServedDataMissingError(f"served coverage stages are incomplete for {row.get('board_id')}")
        if any(row["stages"][stage].get("state") not in STAGE_STATES for stage in STAGES):
            raise ServedDataMissingError(f"served coverage state is invalid for {row.get('board_id')}")

    areas = build_area_rows(boards)
    attempted = len(areas)
    discoverable_count = sum(1 for row in areas if row["discoverable"] is True)

    served_revision_after = served_page_revision(base, fetch_json=served_manifest("served_revision_end"))
    if served_revision_after != served_revision:
        raise ServedRevisionChangedError(
            f"served revision changed during the production read: {served_revision} -> {served_revision_after}"
        )
    require_distinct_receipts(receipts)

    revision = repository_revision or resolve_repository_revision(cwd, main_ref=main_ref)
    stamp = observed_at or utc_now()
    tool_path = "tools/capture_connected_histories_geographic_discoverability_production_read.py"
    tool_sha = sha256_bytes((ROOT / tool_path).read_bytes()) if (ROOT / tool_path).exists() else sha256_bytes(Path(__file__).read_bytes())
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
                {
                    "path": REPOSITORY_DATA_PATH,
                    "sha256": sha256_bytes(response["body"] or b""),
                },
            ],
        },
        "served_census": {
            "url": url,
            "bytes": len(response["body"] or b""),
            "sha256": sha256_bytes(response["body"] or b""),
            "repository_path": REPOSITORY_DATA_PATH,
            "snapshot": "post_change",
            "data_vintage": payload.get("input_vintages"),
        },
        "census": {
            "areas_attempted": attempted,
            "areas_discoverable": discoverable_count,
            "canonical_board_count": CANONICAL_BOARD_COUNT,
            "snapshot": "post_change",
        },
        "areas": areas,
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
            "geographic-discoverability production read-back passed: "
            f"attempted={summary['areas_attempted']} discoverable={summary['areas_discoverable']} "
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
            f"attempted={observation['census']['areas_attempted']} "
            f"discoverable={observation['census']['areas_discoverable']} "
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
