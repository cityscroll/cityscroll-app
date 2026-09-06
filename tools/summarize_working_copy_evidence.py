#!/usr/bin/env python3
"""Regenerate the CI-08 working-copy evidence tables from their raw inputs.

Measurement-only reporting tool. It reads the committed raw receipts under
``docs/evidence/working-copy-footprint/raw/`` and prints the Markdown tables
that appear in that directory's README, so a reviewer can reproduce every byte,
percentage and timing figure rather than trusting the prose.

Usage:
    python3 tools/summarize_working_copy_evidence.py [--evidence-dir DIR]

Statistics policy: the median is reported for every group. The 95th percentile
is reported only where a group has at least five trials; smaller groups print
``n/a`` and report their observed maximum instead, so a two-run group can never
masquerade as a distribution.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys

MIN_TRIALS_FOR_P95 = 5

CATEGORY_LABELS = {
    "git_metadata": "Git objects and repository metadata",
    "tracked_site_data": "Tracked site/data payload (source, not generated)",
    "tracked_site_other": "Tracked site/ payload outside site/data (source)",
    "tracked_warehouse": "Tracked warehouse code, schemas and fixtures",
    "tracked_other": "Tracked payload elsewhere (tests, tools, docs, artifacts)",
    "dependency_view": "Dependency view (worker/node_modules) after store install",
    "generated_site_output": "Generated site output (_site, site/browse, site/now)",
    "generated_warehouse": "Generated warehouse bulk (raw, parquet, duckdb)",
    "other_overhead": "Other overhead (untracked, directory inodes)",
}

CATEGORY_ROWS = [
    "git_metadata",
    "tracked_site_data",
    "tracked_site_other",
    "tracked_warehouse",
    "tracked_other",
    "dependency_view",
    "generated_site_output",
    "generated_warehouse",
    "other_overhead",
]


def mib(value: int | float | None) -> str:
    if value is None:
        return "n/a"
    return f"{value / (1024 * 1024):.1f}"


def read_json(path: str):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def read_jsonl(path: str) -> list[dict]:
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def percentile(values: list[float], quantile: float) -> float | None:
    """Linear-interpolation percentile, suppressed below the trial threshold."""
    if len(values) < MIN_TRIALS_FOR_P95:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * quantile
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def footprint_table(receipt: dict, title: str) -> str:
    total = receipt["total"]
    lines = [
        f"#### {title}",
        "",
        "| Category | Classification | Logical MiB | % of total | Allocated MiB | % of total | Entries |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    for name in CATEGORY_ROWS:
        cat = receipt["categories"][name]
        lines.append(
            f"| {CATEGORY_LABELS[name]} | {cat['kind']} | {mib(cat['logical_bytes'])} | "
            f"{cat['logical_pct']:.2f}% | {mib(cat['allocated_bytes'])} | "
            f"{cat['allocated_pct']:.2f}% | {cat['entries']} |"
        )
    lines.append(
        f"| **Declared total** | | **{mib(total['logical_bytes'])}** | **100.00%** | "
        f"**{mib(total['allocated_bytes'])}** | **100.00%** | |"
    )
    lines.append("")
    return "\n".join(lines)


def timing_table(records: list[dict]) -> str:
    groups: dict[tuple[str, str, str], list[dict]] = {}
    for record in records:
        label = record["label"]
        family = label.rsplit("-t", 1)[0] if "-t" in label else label
        groups.setdefault(
            (family, record["source_class"], record["network"]), []
        ).append(record)

    lines = [
        "| Trial group | Source | Cache / network | n | Phase | Median ms | p95 ms | Min ms | Max ms |",
        "| --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: |",
    ]
    for (family, source, network), group in groups.items():
        for phase in ("prepare_ms", "checkout_ms", "install_ms", "pages_ms", "measured_total_ms"):
            values = [r[phase] for r in group if r.get(phase) is not None]
            if not values:
                continue
            p95 = percentile(values, 0.95)
            p95_text = f"{p95:.0f}" if p95 is not None else "n/a"
            lines.append(
                f"| {family} | {source} | {network} | {len(values)} | "
                f"{phase.removesuffix('_ms')} | {statistics.median(values):.0f} | "
                f"{p95_text} | {min(values):.0f} | {max(values):.0f} |"
            )
    lines.append("")
    return "\n".join(lines)


def candidate_table(records: list[dict]) -> str:
    groups: dict[str, list[dict]] = {}
    for record in records:
        groups.setdefault(record["candidate"], []).append(record)
    lines = [
        "| Clone variant | n | Median prepare ms | p95 prepare ms | Git dir MiB | Working-tree files |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    for name, group in groups.items():
        prepares = [r["prepare_ms"] for r in group]
        p95 = percentile(prepares, 0.95)
        p95_text = f"{p95:.0f}" if p95 is not None else "n/a"
        git_bytes = statistics.median(r["git_dir_logical_bytes"] for r in group)
        lines.append(
            f"| {name} | {len(group)} | {statistics.median(prepares):.0f} | {p95_text} | "
            f"{mib(git_bytes)} | {group[0]['working_tree_file_count']} |"
        )
    lines.append("")
    return "\n".join(lines)


def sparse_table(records: list[dict]) -> str:
    groups: dict[str, list[dict]] = {}
    for record in records:
        groups.setdefault(record["profile"], []).append(record)
    lines = [
        "| Sparse profile | n | Median checkout ms | Working-tree MiB | Working-tree files | Cone |",
        "| --- | ---: | ---: | ---: | ---: | --- |",
    ]
    for name, group in groups.items():
        checkouts = [r["checkout_ms"] for r in group]
        tree = statistics.median(r["working_tree_logical_bytes"] for r in group)
        lines.append(
            f"| {name} | {len(group)} | {statistics.median(checkouts):.0f} | {mib(tree)} | "
            f"{group[0]['working_tree_file_count']} | `{group[0]['cone']}` |"
        )
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--evidence-dir",
        default=os.path.join("docs", "evidence", "working-copy-footprint"),
    )
    args = parser.parse_args()
    raw = os.path.join(args.evidence_dir, "raw")
    if not os.path.isdir(raw):
        print(f"raw evidence directory not found: {raw}", file=sys.stderr)
        return 2

    print("### Working-copy footprint by category\n")
    for name, title in (
        ("footprint-checkout-a.json", "Checkout A — cloned from the remote origin, dependencies installed"),
        ("footprint-checkout-b.json", "Checkout B — cloned from a local object source, dependencies installed"),
    ):
        print(footprint_table(read_json(os.path.join(raw, name)), title))

    store = read_json(os.path.join(raw, "footprint-shared-store.json"))
    print("#### Shared dependency store — counted once, outside every checkout\n")
    print(f"- Logical: {mib(store['logical_bytes'])} MiB")
    print(f"- Allocated: {mib(store['allocated_bytes'])} MiB")
    print(f"- Entries: {store['entries']}\n")

    print("### Provisioning time by phase\n")
    records = read_jsonl(os.path.join(raw, "provisioning-timings.jsonl"))
    records += read_jsonl(os.path.join(raw, "install-timings.jsonl"))
    records += read_jsonl(os.path.join(raw, "pages-timings.jsonl"))
    print(timing_table(records))

    print("### Reduction candidate — shallow and partial clone variants\n")
    print(candidate_table(read_jsonl(os.path.join(raw, "reduction-candidates.jsonl"))))

    print("### Reduction candidate — sparse-checkout profiles\n")
    print(sparse_table(read_jsonl(os.path.join(raw, "sparse-profiles.jsonl"))))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
