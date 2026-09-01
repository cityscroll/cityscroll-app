#!/usr/bin/env python3
"""Regenerate the CI-09 card-profile evidence tables from their raw receipts.

Reporting tool only. It reads the committed receipts under
``docs/evidence/ci-09-working-copy-reduction/raw/`` and prints the Markdown
tables that appear in that directory's README, so every byte, percentage and
timing figure in the prose can be reproduced rather than trusted.

Usage:
    python3 tools/summarize_card_profile_evidence.py [--evidence-dir DIR]

Byte policy. Three measures are reported and never conflated. ``logical`` is
``st_size``. ``allocated`` is ``st_blocks * 512``, which on APFS counts every
copy-on-write clone at full size and therefore cannot see sharing. ``charged``
is the free-space delta across a provisioning run, which is the only one of the
three that observes what the disk is actually asked for. The under-400-MB claim
is made on charged bytes, and MB means 10**6 bytes.

Statistics policy. The median is reported for every group. The 95th percentile
is reported only where a group has at least five trials; smaller groups print
``n/a`` and report their observed maximum instead.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys

MIN_TRIALS_FOR_P95 = 5
MB = 1_000_000
MIB = 1024 * 1024

CATEGORY_ROWS = [
    ("git_metadata", "Git objects and repository metadata"),
    ("tracked_site_data", "Tracked `site/data` payload"),
    ("tracked_site_other", "Tracked `site/` payload outside `site/data`"),
    ("tracked_other", "Tracked payload elsewhere (tests, tools, docs, artifacts)"),
    ("tracked_warehouse", "Tracked warehouse code, schemas and fixtures"),
    ("dependency_view", "Dependency view (`worker/node_modules`) after store install"),
    ("generated_site_output", "Generated site output"),
    ("generated_warehouse", "Generated warehouse bulk"),
    ("other_overhead", "Other overhead (untracked, directory inodes)"),
]

VARIANT_LABELS = {
    "card": "Reduced card-work profile",
    "card-depth1": "Card-work profile, opt-in `--depth 1`",
    "full": "Full-checkout control",
}


def read_json(path: str) -> dict:
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def read_jsonl(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def mib(value: int) -> str:
    return f"{value / MIB:,.2f}"


def mb(value: int) -> str:
    return f"{value / MB:,.1f}"


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(round(fraction * (len(ordered) - 1)))))
    return ordered[index]


def footprint_table(raw: str) -> str:
    receipts = {}
    for variant in VARIANT_LABELS:
        path = os.path.join(raw, f"footprint-{variant}.json")
        if os.path.exists(path):
            receipts[variant] = read_json(path)
    if not receipts:
        return "_no footprint receipts found_\n"

    header = "| Category | " + " | ".join(f"{VARIANT_LABELS[v]} (MiB)" for v in receipts) + " |"
    divider = "| --- | " + " | ".join("---:" for _ in receipts) + " |"
    lines = [header, divider]
    for key, label in CATEGORY_ROWS:
        cells = []
        for variant in receipts:
            category = receipts[variant]["categories"].get(key)
            cells.append(mib(category["logical_bytes"]) if category else "0.00")
        lines.append(f"| {label} | " + " | ".join(cells) + " |")
    lines.append(
        "| **Declared total, logical** | "
        + " | ".join(f"**{mib(receipts[v]['total']['logical_bytes'])}**" for v in receipts)
        + " |"
    )
    lines.append(
        "| Declared total, allocated | "
        + " | ".join(mib(receipts[v]["total"]["allocated_bytes"]) for v in receipts)
        + " |"
    )
    return "\n".join(lines) + "\n"


def charged_table(raw: str) -> str:
    records = read_jsonl(os.path.join(raw, "charged-disk.jsonl"))
    groups: dict[str, list[int]] = {}
    for record in records:
        groups.setdefault(record["variant"], []).append(record["charged_bytes"])
    lines = [
        "| Provisioned profile | n | Median charged MB | Min MB | Max MB | Under 400 MB |",
        "| --- | ---: | ---: | ---: | ---: | --- |",
    ]
    for variant, label in VARIANT_LABELS.items():
        values = groups.get(variant)
        if not values:
            continue
        median = statistics.median(values)
        lines.append(
            f"| {label} | {len(values)} | **{mb(median)}** | {mb(min(values))} | {mb(max(values))} | "
            f"{'yes' if median < 400 * MB else 'no'} |"
        )
    return "\n".join(lines) + "\n"


def timing_table(raw: str) -> str:
    records = read_jsonl(os.path.join(raw, "provisioning-timings.jsonl"))
    groups: dict[str, list[dict]] = {}
    for record in records:
        groups.setdefault(record["label"], []).append(record)
    lines = [
        "| Provisioned profile | n | Phase | Median ms | p95 ms | Min ms | Max ms |",
        "| --- | ---: | --- | ---: | ---: | ---: | ---: |",
    ]
    for variant, label in VARIANT_LABELS.items():
        rows = groups.get(variant)
        if not rows:
            continue
        for phase in ("prepare_ms", "sparse_ms", "checkout_ms", "install_ms", "measured_total_ms"):
            values = [row[phase] for row in rows if row.get(phase) is not None]
            if not values or set(values) == {0}:
                continue
            p95 = f"{percentile(values, 0.95):,.0f}" if len(values) >= MIN_TRIALS_FOR_P95 else "n/a"
            name = phase.replace("_ms", "").replace("measured_total", "**total**")
            median = f"{statistics.median(values):,.0f}"
            if name.startswith("**"):
                median = f"**{median}**"
            lines.append(
                f"| {label} | {len(values)} | {name} | {median} | {p95} | "
                f"{min(values):,} | {max(values):,} |"
            )
    return "\n".join(lines) + "\n"


def gate_table(raw: str) -> str:
    records = read_jsonl(os.path.join(raw, "gate-probes.jsonl"))
    gates: dict[str, dict[str, dict]] = {}
    for record in records:
        gates.setdefault(record["gate_class"], {})[record["profile"]] = record
    lines = [
        "| Gate class | Reduced card-work profile | Full-checkout control | Observed test counts |",
        "| --- | --- | --- | --- |",
    ]
    for gate, byprofile in gates.items():
        reduced = byprofile.get("card-work")
        control = byprofile.get("full-checkout")

        def verdict(record: dict | None) -> str:
            if record is None:
                return "not run — full-checkout only"
            return "pass" if record["exit_status"] == 0 else f"fail (exit {record['exit_status']})"

        summary = (reduced or control or {}).get("test_summary") or ""
        control_summary = (control or {}).get("test_summary") or ""
        counts = summary
        if summary and control_summary and summary != control_summary:
            counts = f"reduced: {summary} / control: {control_summary}"
        lines.append(f"| `{gate}` | {verdict(reduced)} | {verdict(control)} | {counts} |")
    return "\n".join(lines) + "\n"


def behaviour_table(raw: str) -> str:
    records = read_jsonl(os.path.join(raw, "behaviour-probes.jsonl"))
    lines = ["| Probe | Profile | Exit | What it shows |", "| --- | --- | ---: | --- |"]
    for record in records:
        lines.append(
            f"| `{record['id']}` | {record['profile']} | {record['exit_status']} | {record['description']} |"
        )
    return "\n".join(lines) + "\n"


def integrity_table(raw: str) -> str:
    receipt = read_json(os.path.join(raw, "object-integrity.json"))
    lines = [
        "| Field | Reduced card-work profile | Full-checkout control |",
        "| --- | --- | --- |",
    ]
    card, full = receipt["checkouts"]
    fields = [
        ("Commits reachable from HEAD", "commit_count_reachable_from_head"),
        ("Shallow repository", "shallow"),
        ("Promisor remote configured", "promisor_remote"),
        ("Partial clone filter", "partial_clone_filter"),
        ("Packs", "packs"),
        ("Pack size (KiB)", "pack_size_kib"),
        ("Loose objects", "loose_objects"),
        ("Tracked paths not materialised", "tracked_paths_not_materialised"),
    ]
    for label, key in fields:
        lines.append(f"| {label} | {card.get(key)} | {full.get(key)} |")
    lines.append(
        f"| `git fsck --connectivity-only` | exit {card['fsck_connectivity_only']['exit_status']} | "
        f"exit {full['fsck_connectivity_only']['exit_status']} |"
    )
    return "\n".join(lines) + "\n"


def surface_table(raw: str) -> str:
    receipt = read_json(os.path.join(raw, "product-surface.json"))
    lines = ["| Surface | Files | Digest at merge base | Digest at measured revision | Identical |", "| --- | ---: | --- | --- | --- |"]
    for prefix, entry in receipt["surfaces"].items():
        lines.append(
            f"| `{prefix}/` | {entry['measured_revision']['file_count']} | "
            f"`{entry['merge_base']['sha256'][:12]}` | `{entry['measured_revision']['sha256'][:12]}` | "
            f"{'yes' if entry['identical'] else 'no'} |"
        )
    return "\n".join(lines) + "\n"


def closure_table(closure: dict) -> str:
    measured = closure["measured"]
    profile = measured["profile_paths"]
    excluded = measured["excluded_paths"]
    deferred = measured["deferred_paths"]
    tracked = measured["tracked_total"]
    site_data = measured["site_data"]
    lines = [
        "| Set | Files | Logical MiB | Share of tracked payload |",
        "| --- | ---: | ---: | ---: |",
        f"| Materialised by the profile | {profile['count']:,} | {mib(profile['logical_bytes'])} | "
        f"{100 * profile['logical_bytes'] / tracked['logical_bytes']:.1f}% |",
        f"| Deferred to explicit hydration | {deferred['count']:,} | {mib(deferred['logical_bytes'])} | "
        f"{100 * deferred['logical_bytes'] / tracked['logical_bytes']:.1f}% |",
        f"| Left out of the profile entirely | {excluded['count']:,} | {mib(excluded['logical_bytes'])} | "
        f"{100 * excluded['logical_bytes'] / tracked['logical_bytes']:.1f}% |",
        f"| **Tracked payload at this revision** | **{tracked['count']:,}** | **{mib(tracked['logical_bytes'])}** | 100.0% |",
        f"| of which tracked `site/data` | {site_data['tracked_count']:,} | {mib(site_data['tracked_logical_bytes'])} | "
        f"{100 * site_data['tracked_logical_bytes'] / tracked['logical_bytes']:.1f}% |",
        f"| of which `site/data` in the profile | {site_data['profile_count']:,} | {mib(site_data['profile_logical_bytes'])} | "
        f"{100 * site_data['profile_logical_bytes'] / site_data['tracked_logical_bytes']:.1f}% of tracked `site/data` |",
    ]
    return "\n".join(lines) + "\n"


def source_table(closure: dict) -> str:
    sources = closure["sources"]
    return "\n".join(
        [
            "| Closure source | What it contributes | Paths |",
            "| --- | --- | ---: |",
            f"| observed | {sources['observed']['description']} | {sources['observed']['path_count']:,} |",
            f"| static | {sources['static']['description']} | {sources['static']['path_count']:,} |",
            f"| declared | {sources['declared']['description']} | {sources['declared']['path_count']:,} |",
        ]
    ) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--evidence-dir",
        default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                             "docs/evidence/ci-09-working-copy-reduction"),
    )
    args = parser.parse_args()
    raw = os.path.join(args.evidence_dir, "raw")
    if not os.path.isdir(raw):
        print(f"raw evidence directory not found: {raw}", file=sys.stderr)
        return 2

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    closure = read_json(os.path.join(root, "tools/card-profile/closure.v1.json"))
    environment = read_json(os.path.join(raw, "environment.json"))

    print(f"Measured at revision `{environment['revision']}`.\n")
    print("### Profile closure\n")
    print(closure_table(closure))
    print("### Where the closure comes from\n")
    print(source_table(closure))
    print("### Provisioned footprint by category\n")
    print(footprint_table(raw))
    print("### Charged disk — the free-space delta of one provisioning run\n")
    print(charged_table(raw))
    print("### Provisioning time by phase\n")
    print(timing_table(raw))
    print("### Gate compatibility\n")
    print(gate_table(raw))
    print("### Missing-path and fallback behaviour\n")
    print(behaviour_table(raw))
    print("### Git object behaviour and integrity\n")
    print(integrity_table(raw))
    print("### Product surface, unchanged\n")
    print(surface_table(raw))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
