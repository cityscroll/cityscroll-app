"""Cross-packet image digest provenance for render capture manifests.

A capture row's image digest may appear in another retained evidence packet or in
this manifest's previous committed version only when the row carries explicit
``reused_from`` metadata. Silent reuse (copying a hosted URL / sha256 from an
earlier packet while asserting a fresh coherent run) is refused.
"""

from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")
IMAGE_DIGEST_FIELDS = ("sha256", "screenshot_sha256")


@dataclass(frozen=True)
class DigestOccurrence:
    """One retained occurrence of an image digest."""

    digest: str
    manifest_path: str
    feature: str
    row_name: str
    field: str


@dataclass(frozen=True)
class CommittedManifestDigests:
    """Image digests from a previously committed manifest revision."""

    digests: frozenset[str]
    capture_run_id: str | None
    source: str


def _norm_digest(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    digest = value.strip().lower()
    if not DIGEST_RE.fullmatch(digest):
        return None
    return digest


def iter_row_image_digests(row: dict) -> list[tuple[str, str]]:
    """Return (field, digest) pairs for image-bearing fields on a capture row."""
    found: list[tuple[str, str]] = []
    for field in IMAGE_DIGEST_FIELDS:
        digest = _norm_digest(row.get(field))
        if digest:
            found.append((field, digest))
    return found


def collect_retained_image_digests(
    evidence_root: Path,
    *,
    exclude_manifest: Path | None = None,
) -> dict[str, list[DigestOccurrence]]:
    """Index image digests across retained capture-manifest.json files.

    Both ``sha256`` and ``screenshot_sha256`` count: some packets store the
    hosted screenshot digest under the latter while ``sha256`` holds a different
    render fingerprint.
    """
    root = evidence_root.resolve()
    exclude = exclude_manifest.resolve() if exclude_manifest is not None else None
    index: dict[str, list[DigestOccurrence]] = {}
    for path in sorted(root.rglob("capture-manifest.json")):
        if exclude is not None and path.resolve() == exclude:
            continue
        try:
            manifest = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(manifest, dict):
            continue
        feature = str(manifest.get("feature") or path.parent.name)
        rel = str(path.relative_to(root))
        for row in manifest.get("captures") or []:
            if not isinstance(row, dict):
                continue
            row_name = str(row.get("name") or "")
            for field, digest in iter_row_image_digests(row):
                index.setdefault(digest, []).append(
                    DigestOccurrence(
                        digest=digest,
                        manifest_path=rel,
                        feature=feature,
                        row_name=row_name,
                        field=field,
                    )
                )
    return index


def load_committed_manifest_text(
    manifest_path: Path,
    *,
    cwd: Path,
    git_ref: str = "HEAD",
) -> str | None:
    """Return the committed file text at git_ref, or None when absent."""
    rel = manifest_path if not manifest_path.is_absolute() else manifest_path.relative_to(cwd)
    spec = f"{git_ref}:{rel.as_posix()}"
    proc = subprocess.run(
        ["git", "show", spec],
        cwd=cwd,
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        return None
    return proc.stdout


def load_previous_committed_digests(
    manifest_path: Path,
    *,
    cwd: Path,
    git_ref: str = "HEAD",
) -> CommittedManifestDigests | None:
    """Load image digests from this manifest path at a prior git revision."""
    text = load_committed_manifest_text(manifest_path, cwd=cwd, git_ref=git_ref)
    if text is None:
        return None
    try:
        manifest = json.loads(text)
    except json.JSONDecodeError:
        return None
    if not isinstance(manifest, dict):
        return None
    digests: set[str] = set()
    for row in manifest.get("captures") or []:
        if not isinstance(row, dict):
            continue
        for _field, digest in iter_row_image_digests(row):
            digests.add(digest)
    run_id = manifest.get("capture_run_id")
    return CommittedManifestDigests(
        digests=frozenset(digests),
        capture_run_id=str(run_id) if isinstance(run_id, str) and run_id.strip() else None,
        source=f"{git_ref}:{manifest_path.as_posix() if not manifest_path.is_absolute() else manifest_path.relative_to(cwd).as_posix()}",
    )


def format_occurrence(hit: DigestOccurrence) -> str:
    return f"{hit.manifest_path}::{hit.row_name} ({hit.field}, feature={hit.feature})"


def refuse_silent_image_reuse(
    manifest: dict,
    *,
    evidence_root: Path,
    manifest_path: Path | None = None,
    cwd: Path | None = None,
    previous: CommittedManifestDigests | None = None,
    foreign_index: dict[str, list[DigestOccurrence]] | None = None,
) -> None:
    """Refuse rows whose image digest already exists elsewhere without reused_from.

    Raises SystemExit with a precise message on silent reuse. Rows that carry
    ``reused_from`` are skipped here; callers still validate that metadata.
    """
    if foreign_index is None:
        foreign_index = collect_retained_image_digests(
            evidence_root,
            exclude_manifest=manifest_path,
        )

    if previous is None and manifest_path is not None and cwd is not None:
        previous = load_previous_committed_digests(manifest_path, cwd=cwd)

    current_run = manifest.get("capture_run_id")
    current_run_id = (
        str(current_run) if isinstance(current_run, str) and current_run.strip() else None
    )
    check_previous = (
        previous is not None
        and previous.capture_run_id is not None
        and current_run_id is not None
        and previous.capture_run_id != current_run_id
    )

    for row in manifest.get("captures") or []:
        if not isinstance(row, dict):
            continue
        if row.get("reused_from"):
            continue
        name = row.get("name") or "<unnamed>"
        digests = [digest for _field, digest in iter_row_image_digests(row)]
        if not digests:
            continue
        # Prefer the primary sha256 when present; still check every image field.
        for digest in digests:
            foreign_hits = foreign_index.get(digest) or []
            if foreign_hits:
                shown = ", ".join(format_occurrence(hit) for hit in foreign_hits[:3])
                raise SystemExit(
                    f"{name}: sha256 {digest} already appears in retained evidence "
                    f"without reused_from ({shown})"
                )
            if check_previous and digest in previous.digests:
                raise SystemExit(
                    f"{name}: sha256 {digest} already appears in this manifest's previous "
                    f"committed version ({previous.source}) without reused_from"
                )


def assert_digests_absent_elsewhere(
    digests: Iterable[str],
    *,
    evidence_root: Path,
    exclude_manifest: Path | None = None,
) -> None:
    """Raise SystemExit when any digest still appears outside exclude_manifest."""
    index = collect_retained_image_digests(evidence_root, exclude_manifest=exclude_manifest)
    for digest in digests:
        norm = _norm_digest(digest)
        if not norm:
            raise SystemExit(f"invalid digest {digest!r}")
        hits = index.get(norm) or []
        if hits:
            shown = ", ".join(format_occurrence(hit) for hit in hits[:3])
            raise SystemExit(f"digest {norm} still appears elsewhere: {shown}")
