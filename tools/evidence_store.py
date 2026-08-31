#!/usr/bin/env python3
"""Content-addressed owner-proof evidence storage.

The store is deliberately host-side.  Captures are immutable objects addressed by
the SHA-256 of their compressed bytes; the index is a review receipt, not a public
site data source.  DuckDB is used when installed (CI and warehouse environments),
while the JSONL index keeps local capture and verification usable without an
optional native dependency.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse


SCHEMA = "cityscroll.evidence_store.v1"
INDEX_SCHEMA = "cityscroll.evidence_store_index.v1"
DEFAULT_RETENTION_DAYS = 90
RELEASE_PHASES = {"release", "release-evidence", "accepted-release"}
MEDIA_TYPES = {"image/webp": ".webp", "image/avif": ".avif"}
REQUIRED_FIELDS = (
    "capture_id",
    "pr_number",
    "card_id",
    "capture_kind",
    "surface",
    "phase",
    "viewport_width",
    "viewport_height",
    "captured_at",
    "timestamp",
    "commit",
    "sha256",
    "hash",
    "media_type",
    "bytes",
    "url",
    "retention_deadline",
    "gate_receipt",
)


def utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def isoformat(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_timestamp(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def validate_url(value: str, *, field: str = "url") -> str:
    """Require a reviewable URL and reject local filesystem references."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a non-empty URL")
    parsed = urlparse(value)
    if parsed.scheme.lower() in {"file", "", "path"}:
        raise ValueError(f"{field} must not be a local filesystem URL")
    if parsed.scheme.lower() not in {"http", "https", "backstage"}:
        raise ValueError(f"{field} uses unsupported URL scheme: {parsed.scheme}")
    if parsed.scheme.lower() in {"http", "https"} and not parsed.netloc:
        raise ValueError(f"{field} must include a host")
    return value


def github_run_url(*, run_id: str | None = None, repository: str | None = None, server: str | None = None) -> str | None:
    run_id = str(run_id or os.environ.get("GITHUB_RUN_ID", "")).strip()
    repository = str(repository or os.environ.get("GITHUB_REPOSITORY", "")).strip()
    server = str(server or os.environ.get("GITHUB_SERVER_URL", "https://github.com")).rstrip("/")
    if not run_id or not repository:
        return None
    return f"{server}/{repository}/actions/runs/{quote(run_id, safe='')}"


def stable_artifact_base(explicit: str | None = None) -> str | None:
    value = explicit or os.environ.get("EVIDENCE_ARTIFACT_URL")
    if value:
        return validate_url(value, field="artifact URL").rstrip("#")
    return github_run_url()


def object_url(digest: str, suffix: str, artifact_base: str | None) -> str:
    relative = f"objects/sha256/{digest[:2]}/{digest}{suffix}"
    if artifact_base:
        return f"{artifact_base}#evidence/{relative}"
    private_root = "backstage" + "://" + "cityscroll-evidence"
    return f"{private_root}/{relative}"


def default_pr_number() -> int | None:
    value = os.environ.get("GITHUB_PR_NUMBER") or os.environ.get("PR_NUMBER")
    event_path = os.environ.get("GITHUB_EVENT_PATH")
    if not value and event_path:
        try:
            event = json.loads(Path(event_path).read_text(encoding="utf-8"))
            value = event.get("number") or event.get("pull_request", {}).get("number")
        except (OSError, json.JSONDecodeError, AttributeError):
            pass
    if value in (None, "", "null"):
        return None
    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"invalid PR number: {value!r}") from exc


def default_commit() -> str:
    value = os.environ.get("GITHUB_SHA")
    if value:
        return value
    try:
        return subprocess.check_output(["git", "rev-parse", "HEAD"], text=True, stderr=subprocess.DEVNULL).strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def phase_for_ref(ref: str) -> str:
    return {"baseline": "before", "candidate": "after"}.get(ref.strip().lower(), ref.strip().lower())


def retention_deadline(captured_at: str, phase: str, days: int = DEFAULT_RETENTION_DAYS) -> str | None:
    if phase.strip().lower() in RELEASE_PHASES:
        return None
    return isoformat(parse_timestamp(captured_at) + timedelta(days=days))


def index_paths(root: Path) -> tuple[Path, Path, Path]:
    return root / "objects", root / "index.json", root / "index.jsonl"


def read_rows(root: Path) -> list[dict[str, Any]]:
    _, index_path, jsonl_path = index_paths(root)
    if index_path.is_file():
        payload = json.loads(index_path.read_text(encoding="utf-8"))
        if payload.get("schema") != INDEX_SCHEMA:
            raise ValueError(f"unsupported evidence index schema: {payload.get('schema')!r}")
        return list(payload.get("captures", []))
    if jsonl_path.is_file():
        rows: list[dict[str, Any]] = []
        for line in jsonl_path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                rows.append(json.loads(line))
        return rows
    return []


def write_rows(root: Path, rows: list[dict[str, Any]]) -> None:
    root.mkdir(parents=True, exist_ok=True)
    ordered = sorted(rows, key=lambda row: (str(row.get("captured_at", "")), str(row.get("capture_id", ""))))
    payload = {"schema": INDEX_SCHEMA, "backend": "duckdb-when-available", "captures": ordered}
    _, index_path, jsonl_path = index_paths(root)
    index_path.write_text(json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    jsonl_path.write_text("".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in ordered), encoding="utf-8")


def upsert_duckdb(root: Path, rows: list[dict[str, Any]]) -> str:
    """Materialize the same rows in DuckDB when the optional package is present."""
    try:
        import duckdb  # type: ignore
    except ImportError:
        return "jsonl"
    database = root / "index.duckdb"
    connection = duckdb.connect(str(database))
    try:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS captures (
              capture_id VARCHAR PRIMARY KEY,
              pr_number INTEGER,
              card_id VARCHAR NOT NULL,
              capture_kind VARCHAR NOT NULL,
              surface VARCHAR NOT NULL,
              phase VARCHAR NOT NULL,
              viewport_width INTEGER NOT NULL,
              viewport_height INTEGER NOT NULL,
              viewport VARCHAR NOT NULL,
              captured_at TIMESTAMPTZ NOT NULL,
              "timestamp" TIMESTAMPTZ NOT NULL,
              "commit" VARCHAR NOT NULL,
              sha256 VARCHAR NOT NULL,
              "hash" VARCHAR NOT NULL,
              media_type VARCHAR NOT NULL,
              bytes BIGINT NOT NULL,
              url VARCHAR NOT NULL,
              retention_deadline TIMESTAMPTZ,
              gate_receipt VARCHAR NOT NULL,
              gate_receipt_path VARCHAR,
              artifact_name VARCHAR,
              run_id VARCHAR,
              object_path VARCHAR NOT NULL
            )
            """
        )
        connection.execute("DELETE FROM captures")
        for row in rows:
            connection.execute(
                """
                INSERT INTO captures VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    row["capture_id"], row["pr_number"], row["card_id"], row["capture_kind"], row["surface"],
                    row["phase"], row["viewport_width"], row["viewport_height"], row["viewport"],
                    parse_timestamp(row["captured_at"]), parse_timestamp(row["timestamp"]), row["commit"],
                    row["sha256"], row["hash"],
                    row["media_type"], row["bytes"], row["url"],
                    parse_timestamp(row["retention_deadline"]) if row["retention_deadline"] else None,
                    row["gate_receipt"], row.get("gate_receipt_path"), row.get("artifact_name"),
                    row.get("run_id"), row["object_path"],
                ],
            )
        connection.commit()
    finally:
        connection.close()
    return "duckdb"


def record_capture(
    source: Path,
    *,
    root: Path,
    pr_number: int | None,
    card_id: str,
    capture_kind: str,
    surface: str,
    phase: str,
    viewport_width: int,
    viewport_height: int,
    captured_at: str | None = None,
    commit: str | None = None,
    artifact_base: str | None = None,
    gate_receipt: str | None = None,
    gate_receipt_path: str | None = None,
    artifact_name: str | None = None,
    run_id: str | None = None,
    retention_days: int = DEFAULT_RETENTION_DAYS,
    media_type: str = "image/webp",
    capture_id: str | None = None,
) -> dict[str, Any]:
    media_type = media_type.lower().strip()
    if media_type not in MEDIA_TYPES:
        raise ValueError(f"unsupported evidence media type: {media_type}")
    if not source.is_file():
        raise ValueError(f"capture does not exist: {source}")
    data = source.read_bytes()
    if not data:
        raise ValueError(f"capture is empty: {source}")
    digest = hashlib.sha256(data).hexdigest()
    suffix = MEDIA_TYPES[media_type]
    objects, _, _ = index_paths(root)
    object_path = objects / "sha256" / digest[:2] / f"{digest}{suffix}"
    object_path.parent.mkdir(parents=True, exist_ok=True)
    if object_path.exists() and object_path.read_bytes() != data:
        raise ValueError(f"content-addressed object collision: {object_path}")
    if not object_path.exists():
        with tempfile.NamedTemporaryFile(dir=object_path.parent, prefix=f".{digest}.", delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(data)
        temporary.replace(object_path)

    timestamp = captured_at or isoformat(utc_now())
    parse_timestamp(timestamp)
    phase = phase.strip().lower()
    artifact_base = stable_artifact_base(artifact_base)
    url = object_url(digest, suffix, artifact_base)
    validate_url(url)
    private_root = "backstage" + "://" + "cityscroll-evidence"
    receipt = gate_receipt or (f"{artifact_base}#gate-receipt" if artifact_base else f"{private_root}/gates/{phase}/{surface}.json")
    validate_url(receipt, field="gate receipt")
    capture_id = capture_id or ":".join((str(pr_number or "none"), card_id, capture_kind, surface, phase, str(viewport_width), digest))
    row = {
        "schema": SCHEMA,
        "capture_id": capture_id,
        "pr_number": pr_number,
        "card_id": card_id,
        "capture_kind": capture_kind,
        "surface": surface,
        "phase": phase,
        "viewport_width": int(viewport_width),
        "viewport_height": int(viewport_height),
        "viewport": f"{viewport_width}x{viewport_height}",
        "captured_at": timestamp,
        "timestamp": timestamp,
        "commit": commit or default_commit(),
        "sha256": digest,
        "hash": digest,
        "media_type": media_type,
        "bytes": len(data),
        "url": url,
        "retention_deadline": retention_deadline(timestamp, phase, retention_days),
        "retention": "indefinite" if phase in RELEASE_PHASES else f"{retention_days}d",
        "gate_receipt": receipt,
        "gate_receipt_path": gate_receipt_path,
        "artifact_name": artifact_name,
        "run_id": run_id or os.environ.get("GITHUB_RUN_ID"),
        "object_path": str(object_path.relative_to(root)),
    }
    rows = [existing for existing in read_rows(root) if existing.get("capture_id") != capture_id]
    rows.append(row)
    write_rows(root, rows)
    backend = upsert_duckdb(root, rows)
    return {**row, "index_backend": backend}


def validate_row(row: dict[str, Any], root: Path) -> list[str]:
    errors: list[str] = []
    for field in REQUIRED_FIELDS:
        if field not in row:
            errors.append(f"missing field {field}")
    if errors:
        return errors
    try:
        validate_url(row["url"])
        validate_url(row["gate_receipt"], field="gate receipt")
    except ValueError as exc:
        errors.append(str(exc))
    if row["media_type"] not in MEDIA_TYPES:
        errors.append(f"unsupported media type {row['media_type']}")
    if not isinstance(row["bytes"], int) or row["bytes"] <= 0:
        errors.append("bytes must be a positive integer")
    try:
        parse_timestamp(row["captured_at"])
        if row["retention_deadline"]:
            parse_timestamp(row["retention_deadline"])
    except (TypeError, ValueError) as exc:
        errors.append(f"invalid timestamp: {exc}")
    digest = row["sha256"]
    if not isinstance(digest, str) or len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
        errors.append("sha256 must be a lowercase SHA-256 digest")
    if row.get("hash") != digest:
        errors.append(f"hash/sha256 mismatch for {row['capture_id']}")
    if row.get("timestamp") != row.get("captured_at"):
        errors.append(f"timestamp/captured_at mismatch for {row['capture_id']}")
    object_file = root / row.get("object_path", "")
    if not object_file.is_file():
        errors.append(f"object missing: {row.get('object_path')}")
    else:
        content = object_file.read_bytes()
        if len(content) != row["bytes"]:
            errors.append(f"byte count mismatch for {row['capture_id']}")
        if hashlib.sha256(content).hexdigest() != digest:
            errors.append(f"content address mismatch for {row['capture_id']}")
        if row["media_type"] in MEDIA_TYPES and object_file.suffix != MEDIA_TYPES[row["media_type"]]:
            errors.append(f"object extension does not match media type for {row['capture_id']}")
    if row["phase"] in RELEASE_PHASES and row["retention_deadline"] is not None:
        errors.append(f"release evidence must be retained indefinitely: {row['capture_id']}")
    if row["phase"] not in RELEASE_PHASES and row["retention_deadline"] is None:
        errors.append(f"ordinary evidence needs a retention deadline: {row['capture_id']}")
    return errors


def check_store(root: Path, *, require_rows: bool = False) -> dict[str, Any]:
    rows = read_rows(root)
    errors: list[str] = []
    if require_rows and not rows:
        errors.append("evidence store has no captures")
    seen_ids: set[str] = set()
    for row in rows:
        capture_id = row.get("capture_id")
        if capture_id in seen_ids:
            errors.append(f"duplicate capture_id: {capture_id}")
        seen_ids.add(capture_id)
        errors.extend(validate_row(row, root))
    database = root / "index.duckdb"
    if database.is_file():
        try:
            import duckdb  # type: ignore
            connection = duckdb.connect(str(database), read_only=True)
            try:
                database_count = int(connection.execute("SELECT COUNT(*) FROM captures").fetchone()[0])
                if database_count != len(rows):
                    errors.append(f"DuckDB/index row count mismatch: {database_count} != {len(rows)}")
                columns = {str(item[0]) for item in connection.execute("DESCRIBE captures").fetchall()}
                missing_columns = {field for field in REQUIRED_FIELDS if field not in columns}
                if missing_columns:
                    errors.append(f"DuckDB index missing columns: {', '.join(sorted(missing_columns))}")
            finally:
                connection.close()
        except ImportError:
            errors.append("DuckDB index exists but the duckdb Python package is unavailable")
        except Exception as exc:  # pragma: no cover - exercised in CI with DuckDB installed
            errors.append(f"cannot inspect DuckDB index: {exc}")
    return {
        "schema": SCHEMA,
        "verdict": "PASS" if not errors else "FAIL",
        "root": str(root),
        "rows": len(rows),
        "errors": errors,
        "duckdb_present": (root / "index.duckdb").is_file(),
    }


def command_check(args: argparse.Namespace) -> int:
    result = check_store(Path(args.root).resolve(), require_rows=args.require_rows)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["verdict"] == "PASS" else 1


def command_record(args: argparse.Namespace) -> int:
    result = record_capture(
        Path(args.file).resolve(), root=Path(args.root).resolve(), pr_number=args.pr_number,
        card_id=args.card_id, capture_kind=args.capture_kind, surface=args.surface, phase=args.phase,
        viewport_width=args.viewport_width, viewport_height=args.viewport_height, captured_at=args.captured_at,
        commit=args.commit, artifact_base=args.artifact_url, gate_receipt=args.gate_receipt,
        gate_receipt_path=args.gate_receipt_path, artifact_name=args.artifact_name, run_id=args.run_id,
        retention_days=args.retention_days, media_type=args.media_type, capture_id=args.capture_id,
    )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    sub = root.add_subparsers(dest="command", required=True)
    check = sub.add_parser("check", help="validate objects and receipt index")
    check.add_argument("--root", default=".artifacts/evidence-store")
    check.add_argument("--require-rows", action="store_true")
    check.set_defaults(func=command_check)
    record = sub.add_parser("record", help="copy one compressed capture into the store")
    record.add_argument("--file", required=True)
    record.add_argument("--root", default=".artifacts/evidence-store")
    record.add_argument("--pr-number", type=int)
    record.add_argument("--card-id", required=True)
    record.add_argument("--capture-kind", required=True)
    record.add_argument("--surface", required=True)
    record.add_argument("--phase", required=True)
    record.add_argument("--viewport-width", type=int, required=True)
    record.add_argument("--viewport-height", type=int, required=True)
    record.add_argument("--captured-at")
    record.add_argument("--commit")
    record.add_argument("--artifact-url")
    record.add_argument("--gate-receipt")
    record.add_argument("--gate-receipt-path")
    record.add_argument("--artifact-name")
    record.add_argument("--run-id")
    record.add_argument("--retention-days", type=int, default=DEFAULT_RETENTION_DAYS)
    record.add_argument("--media-type", default="image/webp")
    record.add_argument("--capture-id")
    record.set_defaults(func=command_record)
    return root


if __name__ == "__main__":
    arguments = parser().parse_args()
    raise SystemExit(arguments.func(arguments))
