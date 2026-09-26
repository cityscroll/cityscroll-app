"""Cross-packet image digest provenance for render capture manifests.

A capture row's image digest may appear in ANOTHER retained evidence packet only
when the row honestly discloses it: either ``reused_from`` metadata (a declared
reuse that claims no journey interaction) or a ``coincident_hash`` declaration (a
fresh in-run capture that observed a click and re-produced a deterministic page
whose bytes coincide with a named sibling packet + revision). Silent reuse
(copying a hosted URL / sha256 from another packet while asserting a fresh
coherent run) is refused. A byte-identical re-capture of the SAME packet's own
prior committed version is legitimate deterministic output and is not refused.
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

# ``navigation`` values that describe loading a route directly, i.e. no user
# interaction produced the captured image. Anything else (a click into detail,
# an inspector open, a back-journey) is a journey interaction that only a live
# run can honestly assert.
NON_INTERACTION_NAVIGATION = frozenset({"", "direct", "none", "load", "goto"})
# ``served_values`` keys whose truthiness asserts the run acted on the page.
INTERACTION_SERVED_VALUE_KEYS = (
    "opened_from_list_click",
    "clicked_from_list",
    "opened_from_click",
    "journey_interaction",
)


def row_claims_journey_interaction(row: dict) -> list[str]:
    """Return the journey-interaction claims a row asserts (empty when none).

    A "journey interaction" is any assertion that the captured image resulted
    from the run acting on the page - clicking a row into detail, opening an
    inspector, navigating back - rather than loading a route directly.
    """
    claims: list[str] = []
    navigation = row.get("navigation")
    if isinstance(navigation, str) and navigation.strip().lower() not in NON_INTERACTION_NAVIGATION:
        claims.append(f"navigation={navigation!r}")
    values = row.get("served_values")
    if isinstance(values, dict):
        for key in INTERACTION_SERVED_VALUE_KEYS:
            if values.get(key):
                claims.append(f"served_values.{key}={values.get(key)!r}")
    return claims


def refuse_reuse_claiming_interaction(manifest: dict) -> None:
    """Refuse any reused row that also claims a journey interaction (e.g. a click).

    Disclosed ``reused_from`` metadata can attribute an image to a prior packet,
    but it can never stand in for an interaction the current run did not perform:
    a reused image was produced by another run, so this run cannot have clicked,
    inspected, or navigated to reach it. Disclosure fixes attribution; it can
    never satisfy a "clicked detail" clause. A row therefore may carry
    ``reused_from`` or claim a journey interaction, but never both.
    """
    for row in manifest.get("captures") or []:
        if not isinstance(row, dict):
            continue
        if not row.get("reused_from"):
            continue
        claims = row_claims_journey_interaction(row)
        if claims:
            name = row.get("name") or "<unnamed>"
            raise SystemExit(
                f"{name}: a row carrying reused_from must not claim a journey interaction "
                f"({', '.join(claims)}); a reused image was produced by another run and "
                "cannot evidence an interaction performed in this one"
            )


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


# A ``coincident_hash`` declaration lets a genuinely fresh in-run capture stand
# even though a deterministic page renders byte-identically to an image another
# packet already captured. It is NOT reuse: the row was re-captured this run and
# observed a click. It names the sibling packet and its revision, and affirms the
# independent re-capture, so the coincidence is disclosed rather than silent.
COINCIDENT_HASH_FIELD = "coincident_hash"


def coincident_hash_declaration(row: dict) -> dict | None:
    """Return a row's coincident_hash declaration, or None when absent."""
    declared = row.get(COINCIDENT_HASH_FIELD)
    return declared if isinstance(declared, dict) else None


def validate_coincident_hash(row: dict) -> None:
    """Validate a coincident_hash declaration and its required click observation.

    A coincident_hash asserts that this run independently re-captured a
    deterministic page whose bytes match a sibling packet. It must name the
    sibling ``feature`` and ``revision`` and set ``independently_recaptured``,
    it must observe a journey interaction (the click that reached the detail),
    and it must never coexist with ``reused_from`` (which claims another run's
    image). A coincident_hash without a click observation is refused: an image
    that only "happens to match" with no interaction performed is exactly the
    silent-reuse case this field must not launder.
    """
    declared = coincident_hash_declaration(row)
    name = row.get("name") or "<unnamed>"
    if declared is None:
        return
    feature = declared.get("feature")
    revision = declared.get("revision")
    if not feature or not revision or declared.get("independently_recaptured") is not True:
        raise SystemExit(
            f"{name}: coincident_hash must name feature, revision, and set "
            f"independently_recaptured: true; got {declared!r}"
        )
    if row.get("reused_from"):
        raise SystemExit(
            f"{name}: a row cannot carry both coincident_hash (a fresh in-run capture) "
            "and reused_from (another run's image)"
        )
    interactions = row_claims_journey_interaction(row)
    if not interactions:
        raise SystemExit(
            f"{name}: coincident_hash requires a journey interaction observation "
            "(e.g. navigation=clicked-from-list and served_values.opened_from_list_click); "
            "a coincident hash without an observed in-run interaction is silent reuse"
        )


def refuse_silent_image_reuse(
    manifest: dict,
    *,
    evidence_root: Path,
    manifest_path: Path | None = None,
    cwd: Path | None = None,
    previous: CommittedManifestDigests | None = None,
    foreign_index: dict[str, list[DigestOccurrence]] | None = None,
) -> None:
    """Refuse rows whose image digest already appears in ANOTHER retained packet.

    A digest seen in a sibling packet is refused unless the row either
    (a) carries ``reused_from`` (declared reuse - and, per
    :func:`refuse_reuse_claiming_interaction`, claims no interaction), or
    (b) is a fresh in-run capture that observed a click and carries a validated
    ``coincident_hash`` declaration naming the sibling packet.

    A deterministic page legitimately renders byte-identically across runs and
    across packets, so a byte-identical re-capture of the SAME packet's own prior
    committed version is not reuse and is not refused here; ``previous`` and
    ``cwd`` are accepted for backward compatibility but no longer gate a refusal.
    The residual reuse fraud they once guarded (copying a prior detail image
    while claiming a fresh run) is caught by the sibling-packet check above,
    because those detail images also live in a sibling packet.
    """
    del previous, cwd  # deterministic same-packet re-capture is legitimate; see docstring
    if foreign_index is None:
        foreign_index = collect_retained_image_digests(
            evidence_root,
            exclude_manifest=manifest_path,
        )

    for row in manifest.get("captures") or []:
        if not isinstance(row, dict):
            continue
        if row.get("reused_from"):
            continue
        name = row.get("name") or "<unnamed>"
        declared = coincident_hash_declaration(row)
        if declared is not None:
            validate_coincident_hash(row)
        digests = [digest for _field, digest in iter_row_image_digests(row)]
        if not digests:
            continue
        # Prefer the primary sha256 when present; still check every image field.
        for digest in digests:
            foreign_hits = foreign_index.get(digest) or []
            if not foreign_hits:
                continue
            shown = ", ".join(format_occurrence(hit) for hit in foreign_hits[:3])
            if declared is None:
                raise SystemExit(
                    f"{name}: sha256 {digest} already appears in retained evidence "
                    f"without reused_from or coincident_hash ({shown})"
                )
            hit_features = {hit.feature for hit in foreign_hits}
            if declared.get("feature") not in hit_features:
                raise SystemExit(
                    f"{name}: coincident_hash names feature {declared.get('feature')!r} but "
                    f"sha256 {digest} appears under {sorted(hit_features)} ({shown})"
                )
            # Disclosed, click-verified deterministic match: independently
            # re-captured this run, permitted.


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
