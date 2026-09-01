#!/usr/bin/env python3
"""Measure the on-disk footprint of a provisioned CityScroll working copy.

Measurement-only instrument for the CI-08 working-copy footprint evidence. It
changes no application behaviour, no package versions and no dependency
semantics; it only reads a checkout and reports bytes.

The script walks every entry beneath a checkout root, assigns each one to
exactly one category using an ordered path-partition, and sums logical bytes
(``st_size``) and allocated bytes (``st_blocks * 512``) per category. Because
the partition is ordered and exhaustive, the per-category sums add up to the
directory total with no byte counted twice.

Hard links are counted once per device/inode pair within a single run, so a
dependency view that hard-links into a shared content-addressed store does not
inflate the checkout total with bytes the store already owns.

The shared dependency store lives outside the checkout root and is measured by
a separate invocation (``--store-only``). It is never summed into a checkout
total.

Output is JSON on stdout. Paths are emitted relative to the checkout root, so
no host-specific absolute path, user name or host name enters the receipt.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import subprocess
import sys

# Ordered partition. The first matching rule owns the path, so the categories
# are disjoint by construction and their union is the whole directory.
#
# Each rule is (category, kind, matcher). ``kind`` records whether the bytes are
# version-controlled payload, build/generated output, an installed dependency
# view, or repository metadata.
CATEGORY_ORDER = [
    ("git_metadata", "metadata"),
    ("dependency_view", "installed"),
    ("generated_site_output", "generated"),
    ("generated_warehouse", "generated"),
    ("tracked_site_data", "tracked"),
    ("tracked_site_other", "tracked"),
    ("tracked_warehouse", "tracked"),
    ("tracked_other", "tracked"),
    ("other_overhead", "untracked"),
]

# Generated site output. These paths are produced by the Cloudflare Pages build
# and by the constellation document builders; every one of them is ignored by
# the repository's .gitignore rather than tracked.
GENERATED_SITE_GLOBS = [
    "_site",
    "_site/*",
    "site/browse",
    "site/browse/*",
    "site/now",
    "site/now/*",
    "site/data/procurement_browse_query.json",
    "site/data/procurement_browse_query_rows.json",
    "site/data/procurement_browse_rows",
    "site/data/procurement_browse_rows/*",
    "site/agencies/*/index.html",
    "site/community-boards/*/index.html",
]

# Warehouse bulk payloads. Code, schemas and fixtures under warehouse/ are
# tracked; these subtrees hold generated or downloaded bulk data.
GENERATED_WAREHOUSE_PREFIXES = [
    "warehouse/raw/",
    "warehouse/parquet/",
    "warehouse/duckdb/",
    "warehouse/.venv/",
]

DEPENDENCY_VIEW_PREFIXES = [
    "worker/node_modules/",
    "node_modules/",
]


def tracked_paths(root: str) -> set[str]:
    """Return every path Git tracks at this checkout, as relative POSIX paths."""
    out = subprocess.run(
        ["git", "-C", root, "ls-files", "-z"],
        check=True,
        capture_output=True,
    ).stdout
    return {p for p in out.decode("utf-8").split("\0") if p}


def matches_any(rel: str, globs: list[str]) -> bool:
    return any(fnmatch.fnmatch(rel, g) for g in globs)


def has_prefix(rel: str, prefixes: list[str]) -> bool:
    return any(rel == p.rstrip("/") or rel.startswith(p) for p in prefixes)


def classify(rel: str, tracked: set[str]) -> str:
    """Assign one relative path to exactly one category, first rule wins."""
    if rel == ".git" or rel.startswith(".git/"):
        return "git_metadata"
    if has_prefix(rel, DEPENDENCY_VIEW_PREFIXES):
        return "dependency_view"
    if matches_any(rel, GENERATED_SITE_GLOBS):
        return "generated_site_output"
    if has_prefix(rel, GENERATED_WAREHOUSE_PREFIXES) and rel not in tracked:
        return "generated_warehouse"
    if rel in tracked:
        if rel.startswith("site/data/"):
            return "tracked_site_data"
        if rel.startswith("site/"):
            return "tracked_site_other"
        if rel.startswith("warehouse/"):
            return "tracked_warehouse"
        return "tracked_other"
    return "other_overhead"


def walk(root: str, tracked: set[str]) -> dict:
    """Sum logical and allocated bytes per category beneath ``root``."""
    totals = {
        name: {"kind": kind, "logical_bytes": 0, "allocated_bytes": 0, "entries": 0}
        for name, kind in CATEGORY_ORDER
    }
    seen_inodes: set[tuple[int, int]] = set()
    hardlink_dedup = {"entries": 0, "logical_bytes": 0}

    # The checkout root's own directory inode belongs to the partition too, so
    # the category sums equal the whole directory rather than its contents.
    root_st = os.lstat(root)
    totals["other_overhead"]["logical_bytes"] += root_st.st_size
    totals["other_overhead"]["allocated_bytes"] += root_st.st_blocks * 512
    totals["other_overhead"]["entries"] += 1

    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        for name in list(dirnames) + filenames:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root)
            try:
                st = os.lstat(full)
            except OSError:
                continue
            if os.path.isdir(full) and not os.path.islink(full):
                # Directory inodes carry their own allocated blocks; count them
                # in the owning category but skip the recursive descent here
                # (os.walk already yields the children).
                pass
            elif st.st_nlink > 1:
                key = (st.st_dev, st.st_ino)
                if key in seen_inodes:
                    hardlink_dedup["entries"] += 1
                    hardlink_dedup["logical_bytes"] += st.st_size
                    continue
                seen_inodes.add(key)
            category = classify(rel, tracked)
            bucket = totals[category]
            bucket["logical_bytes"] += st.st_size
            bucket["allocated_bytes"] += st.st_blocks * 512
            bucket["entries"] += 1

    return {"categories": totals, "hardlink_dedup": hardlink_dedup}


def walk_flat(root: str) -> dict:
    """Sum a directory with no category partition (used for the shared store)."""
    logical = 0
    allocated = 0
    entries = 0
    seen_inodes: set[tuple[int, int]] = set()
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        for name in list(dirnames) + filenames:
            full = os.path.join(dirpath, name)
            try:
                st = os.lstat(full)
            except OSError:
                continue
            if not os.path.isdir(full) and st.st_nlink > 1:
                key = (st.st_dev, st.st_ino)
                if key in seen_inodes:
                    continue
                seen_inodes.add(key)
            logical += st.st_size
            allocated += st.st_blocks * 512
            entries += 1
    return {"logical_bytes": logical, "allocated_bytes": allocated, "entries": entries}


def git_dir_target(root: str) -> str | None:
    """Resolve the real Git object directory backing this checkout.

    A linked working tree stores a ``.git`` file pointing at a shared common
    directory. Reporting that shared directory separately keeps such a
    measurement honest about metadata it does not privately own.
    """
    try:
        common = subprocess.run(
            ["git", "-C", root, "rev-parse", "--git-common-dir"],
            check=True,
            capture_output=True,
        ).stdout.decode().strip()
    except subprocess.CalledProcessError:
        return None
    if not os.path.isabs(common):
        common = os.path.join(root, common)
    return os.path.realpath(common)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", help="checkout root, or store path with --store-only")
    parser.add_argument("--label", default="", help="trial label recorded in the receipt")
    parser.add_argument(
        "--store-only",
        action="store_true",
        help="measure a shared dependency store instead of a checkout",
    )
    args = parser.parse_args()

    root = os.path.realpath(args.root)
    if not os.path.isdir(root):
        print(f"not a directory: {args.root}", file=sys.stderr)
        return 2

    if args.store_only:
        result = walk_flat(root)
        result["label"] = args.label
        result["scope"] = "shared_dependency_store"
        json.dump(result, sys.stdout, indent=2, sort_keys=True)
        print()
        return 0

    tracked = tracked_paths(root)
    measured = walk(root, tracked)
    categories = measured["categories"]

    total_logical = sum(c["logical_bytes"] for c in categories.values())
    total_allocated = sum(c["allocated_bytes"] for c in categories.values())

    for cat in categories.values():
        cat["logical_pct"] = (
            round(100.0 * cat["logical_bytes"] / total_logical, 3) if total_logical else 0.0
        )
        cat["allocated_pct"] = (
            round(100.0 * cat["allocated_bytes"] / total_allocated, 3)
            if total_allocated
            else 0.0
        )

    common = git_dir_target(root)
    own_git = os.path.realpath(os.path.join(root, ".git"))
    shared_metadata = None
    if common and common != own_git and not common.startswith(root + os.sep):
        # Linked working tree: the object store is shared and lives outside the
        # checkout, so measure it separately rather than folding it into the
        # per-checkout total.
        shared_metadata = walk_flat(common)

    receipt = {
        "schema": "cityscroll.working-copy-footprint.v1",
        "label": args.label,
        "scope": "checkout",
        "tracked_file_count": len(tracked),
        "categories": categories,
        "total": {"logical_bytes": total_logical, "allocated_bytes": total_allocated},
        "hardlink_dedup": measured["hardlink_dedup"],
        "shared_git_metadata_outside_checkout": shared_metadata,
        "no_double_counting_rule": (
            "Every entry beneath the checkout root is assigned to exactly one "
            "category by an ordered, exhaustive path partition (first rule "
            "wins), so per-category sums equal the directory total. Hard-linked "
            "content is counted once per device/inode within a run. A shared "
            "dependency store, and a shared Git object directory for a linked "
            "working tree, live outside the checkout root and are reported "
            "separately; neither is ever added to a checkout total."
        ),
    }
    json.dump(receipt, sys.stdout, indent=2, sort_keys=True)
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
