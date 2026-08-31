#!/usr/bin/env python3
"""Move owner-proof captures from the public tip into the evidence store.

The migration is intentionally tip-only.  It records the original path and
digest beside the content-addressed store receipt, rewrites exact references in
``docs/`` to stable store URLs, and removes only tracked capture files after the
store and manifest have been verified.

The store itself is host-side (``.artifacts/evidence-store`` by default); the
committed manifest is the reversible map from the former public paths to their
content addresses.  Functional visual goldens and explicitly public captures
are never part of the migration population.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from evidence_store import check_store, read_rows, record_capture, upsert_duckdb, write_rows


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_STORE = ROOT / ".artifacts" / "evidence-store"
DEFAULT_MANIFEST = ROOT / "docs" / "evidence-tip-migration.json"
MIGRATION_CARD = "repo-diet/evidence-tip-migration"
PRIVATE_EVIDENCE_ROOT = "backstage" + "://" + "cityscroll-evidence"
MIGRATION_GATE = f"{PRIVATE_EVIDENCE_ROOT}/gates/repo-diet-evidence-tip-migration.json"
TARGET_ROOTS = (ROOT / "docs" / "screenshots", ROOT / "docs" / "performance", ROOT / "docs" / "evidence")
PUBLIC_CAPTURE_PATHS = {
    "docs/screenshots/browse-people-cb-card/before-mobile.png",
    "docs/screenshots/browse-people-cb-card/before-desktop.png",
    "docs/screenshots/browse-people-cb-card/after-mobile.png",
    "docs/screenshots/browse-people-cb-card/after-desktop.png",
}
FUNCTIONAL_GOLDEN_ROOTS = (
    ROOT / "artifacts" / "content-parity-r3",
    ROOT / "docs" / "screenshots" / "bid-tabulations-recon",
    ROOT / "docs" / "screenshots" / "land-event-spine",
    ROOT / "docs" / "screenshots" / "legistar-depth-recon",
    ROOT / "docs" / "screenshots" / "notice-land-zap-spine",
    ROOT / "docs" / "screenshots" / "ulurp-recommendations-recon",
    ROOT / "docs" / "screenshots" / "zap-outcomes",
    ROOT / "docs" / "screenshots" / "zoning-statistics",
    ROOT / "docs" / "screenshots" / "applicant-conditioned-ulurp",
    ROOT / "docs" / "screenshots" / "qr-share",
)
RASTER_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg"}
PATH_TOKEN = re.compile(r"(?:^|[-_/])(?P<phase>before|after)(?:[-_/]|$)", re.IGNORECASE)
VIEWPORT_TOKEN = re.compile(r"(?:^|[-_/])(?P<width>\d{3,4})(?:x(?P<height>\d{3,4}))?(?=[-_/.$]|$)")


def rel(path: Path) -> str:
    return path.resolve().relative_to(ROOT).as_posix()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tracked(path: Path) -> bool:
    result = subprocess.run(
        ["git", "ls-files", "--error-unmatch", "--", rel(path)],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    return result.returncode == 0


def git_provenance(path: Path) -> tuple[str, str]:
    result = subprocess.run(
        ["git", "log", "-1", "--format=%H%x00%cI", "--", rel(path)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    value = result.stdout.strip()
    if not value or "\x00" not in value:
        return "unknown", "2026-08-29T00:00:00Z"
    commit, timestamp = value.split("\x00", 1)
    return commit, timestamp


def png_dimensions(path: Path) -> tuple[int, int]:
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n" or len(data) < 24:
        raise ValueError(f"not a readable PNG: {path}")
    return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")


def image_dimensions(path: Path, converted: Path | None = None) -> tuple[int, int]:
    candidate = converted or path
    if candidate.suffix.lower() == ".png":
        return png_dimensions(candidate)
    result = subprocess.run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", str(candidate)], capture_output=True, text=True, check=True)
    values = [int(match) for match in re.findall(r"pixel(?:Width|Height):\s*(\d+)", result.stdout)]
    if len(values) != 2:
        raise ValueError(f"could not determine image dimensions: {candidate}")
    return values[0], values[1]


def phase_for(path: Path) -> str:
    match = PATH_TOKEN.search(path.stem)
    return match.group("phase").lower() if match else "snapshot"


def viewport_for(path: Path, dimensions: tuple[int, int]) -> tuple[int, int]:
    matches = list(VIEWPORT_TOKEN.finditer(path.as_posix()))
    for match in reversed(matches):
        width = int(match.group("width"))
        if 240 <= width <= 1600:
            return width, int(match.group("height") or dimensions[1])
    return dimensions


def surface_for(path: Path) -> str:
    relative = Path(rel(path))
    return relative.parent.as_posix()


def is_functional_golden(path: Path) -> bool:
    return any(path == root or root in path.parents for root in FUNCTIONAL_GOLDEN_ROOTS)


def migration_sources() -> list[Path]:
    sources: list[Path] = []
    for root in TARGET_ROOTS:
        if not root.is_dir():
            continue
        for path in root.rglob("*"):
            if (
                path.is_file()
                and path.suffix.lower() in RASTER_SUFFIXES
                and rel(path) not in PUBLIC_CAPTURE_PATHS
                and not is_functional_golden(path)
            ):
                if not tracked(path):
                    raise RuntimeError(f"refusing to migrate untracked capture: {rel(path)}")
                sources.append(path)
    return sorted(sources, key=rel)


def retained_population() -> list[dict[str, Any]]:
    populations: list[dict[str, Any]] = []
    public = []
    for source in sorted((ROOT / "docs" / "screenshots").rglob("*")):
        if source.is_file() and rel(source) in PUBLIC_CAPTURE_PATHS:
            public.append(rel(source))
    populations.append({
        "classification": "public-documentation-captures",
        "reason": "Explicit entries in docs/public-capture-allowlist.json remain public documentation assets.",
        "paths": public,
    })
    golden_paths = []
    for golden_root in FUNCTIONAL_GOLDEN_ROOTS:
        golden_paths.extend(
            rel(path)
            for path in sorted(golden_root.rglob("*"))
            if path.is_file() and path.suffix.lower() in RASTER_SUFFIXES
        )
    populations.append({
        "classification": "functional-visual-goldens",
        "reason": "Committed content-parity and checksum-pinned acceptance captures are functional comparison fixtures, not owner-only proofs, and remain in the tip.",
        "paths": sorted(golden_paths),
    })
    return populations


def compress(source: Path, destination: Path) -> tuple[int, int]:
    """Encode a source capture as WebP and return its dimensions."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    if source.suffix.lower() == ".svg":
        with tempfile.TemporaryDirectory(prefix="cityscroll-svg-", dir=destination.parent) as temporary:
            png = Path(temporary) / "source.png"
            subprocess.run(["sips", "-s", "format", "png", str(source), "--out", str(png)], capture_output=True, text=True, check=True)
            dimensions = image_dimensions(source, png)
            subprocess.run(["cwebp", "-quiet", "-q", "82", str(png), "-o", str(destination)], check=True)
            return dimensions
    dimensions = image_dimensions(source)
    candidate = source
    with tempfile.TemporaryDirectory(prefix="cityscroll-resize-", dir=destination.parent) as temporary:
        if max(dimensions) > 16382:
            candidate = Path(temporary) / "resized.png"
            subprocess.run(["sips", "-Z", "16382", str(source), "--out", str(candidate)], capture_output=True, text=True, check=True)
        subprocess.run(["cwebp", "-quiet", "-q", "82", str(candidate), "-o", str(destination)], check=True)
    return dimensions


def build_row(source: Path, *, store: Path) -> dict[str, Any]:
    source_path = rel(source)
    source_digest = sha256(source)
    source_bytes = source.stat().st_size
    commit, captured_at = git_provenance(source)
    with tempfile.TemporaryDirectory(prefix="cityscroll-proof-", dir=store) as temporary:
        compressed = Path(temporary) / "capture.webp"
        dimensions = compress(source, compressed)
        width, height = viewport_for(source, dimensions)
        row = record_capture(
            compressed,
            root=store,
            pr_number=None,
            card_id=MIGRATION_CARD,
            capture_kind="legacy-owner-proof",
            surface=surface_for(source),
            phase=phase_for(source),
            viewport_width=width,
            viewport_height=height,
            captured_at=captured_at,
            commit=commit,
            gate_receipt=MIGRATION_GATE,
            gate_receipt_path="docs/evidence-tip-migration.json",
            retention_days=90,
            media_type="image/webp",
            capture_id=f"{MIGRATION_CARD}:{source_path}:{source_digest}",
        )
    row.update({
        "source_path": source_path,
        "source_sha256": source_digest,
        "source_bytes": source_bytes,
        "source_media_type": "image/svg+xml" if source.suffix.lower() == ".svg" else "image/png",
        "migration": "repo-diet/evidence-tip-migration",
    })
    return row


def rewrite_docs(mapping: dict[str, str]) -> list[str]:
    changed: list[str] = []
    if not mapping:
        return changed
    for path in sorted((ROOT / "docs").rglob("*")):
        if not path.is_file() or path == DEFAULT_MANIFEST:
            continue
        try:
            original = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        updated = original
        for source, target in mapping.items():
            updated = updated.replace(source, target)
            source_path = ROOT / source
            relative = Path(os.path.relpath(source_path, path.parent)).as_posix()
            updated = updated.replace(relative, target)
            updated = updated.replace(f"./{relative}", target)
        if updated != original:
            path.write_text(updated, encoding="utf-8")
            changed.append(rel(path))
    return changed


def docs_with_stable_references() -> list[str]:
    paths: list[str] = []
    for path in sorted((ROOT / "docs").rglob("*")):
        if not path.is_file() or path == DEFAULT_MANIFEST:
            continue
        try:
            content = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        if f"{PRIVATE_EVIDENCE_ROOT}/objects/" in content:
            paths.append(rel(path))
    return paths


def manifest_payload(rows: list[dict[str, Any]], retained: list[dict[str, Any]], rewritten_docs: list[str]) -> dict[str, Any]:
    migrated_bytes = sum(int(row["source_bytes"]) for row in rows)
    return {
        "schema": "cityscroll.evidence_tip_migration.v1",
        "card_id": MIGRATION_CARD,
        "tip_only": True,
        "history_rewrite": "not performed",
        "generated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "source_roots": [str(root.relative_to(ROOT)) for root in TARGET_ROOTS],
        "migrated": {
            "classification": "owner-only-raster-proofs",
            "count": len(rows),
            "source_bytes": migrated_bytes,
            "media_type": "image/webp",
            "captures": rows,
        },
        "retained_populations": retained,
        "rewritten_docs": rewritten_docs,
        "reversibility": {
            "restore_source": "Each migrated row carries source_path, source_sha256, source_bytes, and the content-addressed object_path.",
            "object_store": ".artifacts/evidence-store",
            "store_gate_receipt": MIGRATION_GATE,
        },
    }


def write_manifest(payload: dict[str, Any], manifest: Path) -> None:
    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text(json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")


def check_manifest(manifest: Path, store: Path) -> dict[str, Any]:
    if not manifest.is_file():
        raise RuntimeError(f"migration manifest is missing: {manifest}")
    payload = json.loads(manifest.read_text(encoding="utf-8"))
    if payload.get("schema") == "cityscroll.evidence_tip_public_summary.v1":
        required = ("source_sha256", "private_reference_count", "private_reference_set_sha256", "disposition", "maintainer_resolution")
        missing = [field for field in required if not payload.get(field)]
        if missing:
            raise RuntimeError(f"public evidence placement summary lacks fields: {missing}")
        if payload.get("private_reference_count") != 2299:
            raise RuntimeError("public evidence placement summary count drifted")
        return {"manifest": str(manifest), "migrated": "owner-only", "store": "registered-maintainer-disposition", "verdict": "PASS"}
    if payload.get("schema") != "cityscroll.evidence_tip_migration.v1":
        raise RuntimeError("unsupported evidence tip migration manifest schema")
    rows = payload.get("migrated", {}).get("captures", [])
    if payload.get("migrated", {}).get("count") != len(rows):
        raise RuntimeError("migration manifest count does not match captures")
    source_paths = {row.get("source_path") for row in rows}
    if None in source_paths or len(source_paths) != len(rows):
        raise RuntimeError("migration manifest has duplicate or missing source paths")
    still_present = [source for source in source_paths if (ROOT / source).is_file()]
    if still_present:
        raise RuntimeError(f"migrated source captures remain in tip: {still_present[:5]}")
    missing_urls = [row.get("source_path") for row in rows if not str(row.get("url", "")).startswith("backstage" + "://")]
    if missing_urls:
        raise RuntimeError(f"migrated captures lack stable store URLs: {missing_urls[:5]}")
    result = check_store(store, require_rows=bool(rows))
    if result["verdict"] != "PASS":
        raise RuntimeError(json.dumps(result, sort_keys=True))
    indexed = {row.get("capture_id"): row for row in read_rows(store)}
    if set(indexed) != {row.get("capture_id") for row in rows}:
        raise RuntimeError("evidence store index does not account for every migrated capture")
    missing_source_metadata = [row.get("capture_id") for row in rows if not row.get("source_path") or not row.get("source_sha256")]
    if missing_source_metadata:
        raise RuntimeError(f"evidence store index lacks source metadata: {missing_source_metadata[:5]}")
    return {"manifest": str(manifest), "migrated": len(rows), "store": result}


def execute(args: argparse.Namespace) -> int:
    store = args.store.resolve()
    manifest = args.manifest.resolve()
    store.mkdir(parents=True, exist_ok=True)
    sources = migration_sources()
    if not sources and manifest.is_file():
        payload = json.loads(manifest.read_text(encoding="utf-8"))
        rows = [
            row
            for row in payload.get("migrated", {}).get("captures", [])
            if not is_functional_golden(ROOT / row["source_path"])
        ]
        payload["migrated"]["captures"] = rows
        payload["migrated"]["count"] = len(rows)
        payload["migrated"]["source_bytes"] = sum(int(row["source_bytes"]) for row in rows)
        payload["retained_populations"] = retained_population()
        payload["rewritten_docs"] = docs_with_stable_references()
        write_manifest(payload, manifest)
        valid_capture_ids = {row["capture_id"] for row in rows}
        indexed = [row for row in read_rows(store) if row.get("capture_id") in valid_capture_ids]
        write_rows(store, indexed)
        upsert_duckdb(store, indexed)
        print(json.dumps(check_manifest(manifest, store), indent=2, sort_keys=True))
        return 0
    if not sources:
        raise RuntimeError("no tracked owner-proof captures found")
    rows = [build_row(source, store=store) for source in sources]
    mapping = {row["source_path"]: row["url"] for row in rows}
    rewritten_docs = rewrite_docs(mapping)
    payload = manifest_payload(rows, retained_population(), rewritten_docs)
    write_manifest(payload, manifest)
    store_result = check_store(store, require_rows=True)
    if store_result["verdict"] != "PASS":
        raise RuntimeError(json.dumps(store_result, sort_keys=True))
    indexed = {row.get("capture_id"): row for row in read_rows(store)}
    for row in rows:
        indexed[row["capture_id"]] = row
    write_rows(store, list(indexed.values()))
    upsert_duckdb(store, list(indexed.values()))
    store_result = check_store(store, require_rows=True)
    if store_result["verdict"] != "PASS":
        raise RuntimeError(json.dumps(store_result, sort_keys=True))
    for source in sources:
        source.unlink()
    result = check_manifest(manifest, store)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("execute", "check"))
    parser.add_argument("--store", type=Path, default=DEFAULT_STORE)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    args = parser.parse_args()
    if args.command == "check":
        print(json.dumps(check_manifest(args.manifest.resolve(), args.store.resolve()), indent=2, sort_keys=True))
        return 0
    return execute(args)


if __name__ == "__main__":
    raise SystemExit(main())
