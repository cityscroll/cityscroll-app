#!/usr/bin/env python3
"""Regenerate the CI-10 routing evidence tables from their raw receipts.

Reporting tool only. It reads the committed receipts under
``docs/evidence/default-reduced-profile/raw/`` and prints the Markdown
tables that appear in that directory's README, so every routing decision, byte
figure and probe exit status in the prose can be reproduced rather than trusted.

Usage:
    python3 tools/summarize_card_profile_routing_evidence.py [--evidence-dir DIR]

Byte policy is CI-08's and CI-09's, unchanged and restated here because the
same three measures are reported. ``logical`` is ``st_size``. ``allocated`` is
``st_blocks * 512``, which on APFS counts every copy-on-write clone at full size
and therefore cannot see sharing. ``charged`` is the free-space delta across one
provisioning run, the only one of the three that observes what the disk is
actually asked for. The under-400-MB claim is made on charged bytes, and MB
means 10**6 bytes.

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

VARIANTS = [
    ("routed-focused", "Routed focused card work (`focused-reduced`)"),
    ("routed-ci", "Routed CI surface (`full` control)"),
]


def read_json(path: str) -> dict:
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def read_jsonl(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def mib(value: int) -> str:
    return f"{value / MIB:,.2f}"


def cell(value: str) -> str:
    return value.replace("|", "\\|")


def p95(values: list[float]) -> str:
    if len(values) < MIN_TRIALS_FOR_P95:
        return "n/a"
    return f"{statistics.quantiles(values, n=20)[18]:,.0f}"


def surface_decision_table(raw: str) -> str:
    records = [r for r in read_jsonl(os.path.join(raw, "routing-decisions.jsonl")) if r["probe"].startswith("surface:")]
    rows = [
        "| Work surface | Selected profile | Rule | Exit |",
        "| --- | --- | --- | ---: |",
    ]
    for record in records:
        profile = f"`{record['profile']}`" if record.get("profile") else "_failed closed_"
        rows.append(
            f"| `{record['surface']}` | {profile} | `{record['rule']}` (order {record['rule_order']}) "
            f"| {record['exit_status']} |"
        )
    return "\n".join(rows) + "\n"


def gate_decision_table(raw: str) -> str:
    records = read_jsonl(os.path.join(raw, "routing-decisions.jsonl"))
    rows = [
        "| Gate class requested by focused card work | Selected profile | Rule |",
        "| --- | --- | --- |",
    ]
    for record in records:
        if not record["probe"].startswith(("supported-gate:", "full-only-gate:")):
            continue
        gate = record["probe"].split(":", 1)[1]
        profile = f"`{record['profile']}`" if record.get("profile") else "_failed closed_"
        rows.append(f"| `{gate}` | {profile} | `{record['rule']}` |")
    return "\n".join(rows) + "\n"


def boundary_decision_table(raw: str) -> str:
    wanted = [
        "declared-complete-history",
        "deferred-path-requested",
        "in-closure-path-requested",
        "stale-recorded-digest",
        "undeclared-surface",
        "undeclared-gate-class",
    ]
    records = {r["probe"]: r for r in read_jsonl(os.path.join(raw, "routing-decisions.jsonl"))}
    rows = ["| Request | Selected profile | Rule | Exit |", "| --- | --- | --- | ---: |"]
    for probe in wanted:
        record = records[probe]
        profile = f"`{record['profile']}`" if record.get("profile") else "**failed closed**"
        rows.append(f"| `{probe}` | {profile} | `{record['rule']}` | {record['exit_status']} |")
    return "\n".join(rows) + "\n"


def footprint_table(raw: str) -> str:
    footprints = {
        variant: read_json(os.path.join(raw, f"footprint-{variant}.json"))
        for variant, _ in VARIANTS
        if os.path.exists(os.path.join(raw, f"footprint-{variant}.json"))
    }
    header = [label for variant, label in VARIANTS if variant in footprints]
    rows = [
        "| Category | " + " | ".join(f"{label} (MiB)" for label in header) + " |",
        "| --- | " + " | ".join("---:" for _ in header) + " |",
    ]
    for key, label in CATEGORY_ROWS:
        values = [mib(footprints[v]["categories"][key]["logical_bytes"]) for v, _ in VARIANTS if v in footprints]
        rows.append(f"| {label} | " + " | ".join(values) + " |")
    rows.append(
        "| **Declared total, logical** | "
        + " | ".join(f"**{mib(footprints[v]['total']['logical_bytes'])}**" for v, _ in VARIANTS if v in footprints)
        + " |"
    )
    rows.append(
        "| Declared total, allocated | "
        + " | ".join(mib(footprints[v]["total"]["allocated_bytes"]) for v, _ in VARIANTS if v in footprints)
        + " |"
    )
    return "\n".join(rows) + "\n"


def charged_table(raw: str) -> str:
    records = read_jsonl(os.path.join(raw, "charged-disk.jsonl"))
    footprints = {
        variant: read_json(os.path.join(raw, f"footprint-{variant}.json"))
        for variant, _ in VARIANTS
        if os.path.exists(os.path.join(raw, f"footprint-{variant}.json"))
    }
    rows = [
        "| Provisioned profile | n | Median charged MB | Observed min | Observed max | "
        "Allocated minus the shared dependency view, MB | Under 400 MB |",
        "| --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ]
    for variant, label in VARIANTS:
        values = [r["charged_bytes"] / MB for r in records if r["variant"] == variant]
        if not values:
            continue
        median = statistics.median(values)
        cross_check = ""
        if variant in footprints:
            categories = footprints[variant]["categories"]
            allocated = footprints[variant]["total"]["allocated_bytes"] - categories["dependency_view"]["allocated_bytes"]
            cross_check = f"{allocated / MB:,.1f}"
        rows.append(
            f"| {label} | {len(values)} | **{median:,.1f}** | {min(values):,.1f} | {max(values):,.1f} "
            f"| {cross_check} | {'yes' if median < 400 else 'no'} |"
        )
    return "\n".join(rows) + "\n"


def timing_table(raw: str) -> str:
    records = read_jsonl(os.path.join(raw, "provisioning-timings.jsonl"))
    rows = [
        "| Provisioned profile | n | Phase | Median ms | p95 ms | Min ms | Max ms |",
        "| --- | ---: | --- | ---: | ---: | ---: | ---: |",
    ]
    for variant, label in VARIANTS:
        group = [r for r in records if r["label"] == variant]
        if not group:
            continue
        for phase in ("prepare", "sparse", "checkout", "install", "measured_total"):
            key = f"{phase}_ms" if phase != "measured_total" else "measured_total_ms"
            values = [float(r[key]) for r in group if r.get(key) is not None]
            if not values or (phase == "sparse" and max(values) == 0):
                continue
            name = f"**{phase}**" if phase == "measured_total" else phase
            median = f"**{statistics.median(values):,.0f}**" if phase == "measured_total" else f"{statistics.median(values):,.0f}"
            rows.append(
                f"| {label} | {len(values)} | {name.replace('measured_total', 'total')} | {median} "
                f"| {p95(values)} | {min(values):,.0f} | {max(values):,.0f} |"
            )
    return "\n".join(rows) + "\n"


def probe_table(raw: str) -> str:
    records = read_jsonl(os.path.join(raw, "fail-closed-probes.jsonl"))
    rows = ["| Probe | Expected | Exit | Met | What it shows |", "| --- | --- | ---: | --- | --- |"]
    for record in records:
        rows.append(
            f"| `{record['id']}` | `{record.get('expected', '')}` | {record['exit_status']} "
            f"| {'yes' if record.get('expectation_met') else '**no**'} | {cell(record['description'])} |"
        )
    return "\n".join(rows) + "\n"


def integrity_table(raw: str) -> str:
    record = read_json(os.path.join(raw, "object-integrity.json"))
    fields = [
        ("commits_reachable_from_head", "Commits reachable from HEAD"),
        ("shallow_repository", "Shallow repository"),
        ("promisor_remote", "Promisor remote configured"),
        ("partial_clone_filter", "Partial clone filter"),
        ("packs", "Packs"),
        ("pack_size_kib", "Pack size (KiB)"),
        ("loose_objects", "Loose objects"),
        ("tracked_paths_not_materialised", "Tracked paths not materialised"),
        ("working_tree_clean", "Working tree clean at the pinned revision"),
        ("fsck_connectivity_only_exit", "`git fsck --connectivity-only` exit"),
        ("merge_base_against_default_branch_exit", "`git merge-base HEAD origin/main` exit"),
    ]
    rows = [
        "| Field | " + " | ".join(label for _, label in VARIANTS) + " |",
        "| --- | " + " | ".join("---" for _ in VARIANTS) + " |",
    ]
    for key, label in fields:
        rows.append(f"| {label} | " + " | ".join(str(record[v][key]) for v, _ in VARIANTS) + " |")
    return "\n".join(rows) + "\n"


def gate_probe_table(raw: str) -> str:
    records = read_jsonl(os.path.join(raw, "gate-probes.jsonl"))
    gates = {}
    for record in records:
        gates.setdefault(record["gate_class"], {})[record["variant"]] = record
    rows = [
        "| Gate class | " + " | ".join(label for _, label in VARIANTS) + " | Observed test counts |",
        "| --- | " + " | ".join("---" for _ in VARIANTS) + " | --- |",
    ]
    for gate, byvariant in gates.items():
        cells = []
        counts = []
        for variant, _ in VARIANTS:
            record = byvariant.get(variant, {})
            cells.append("pass" if record.get("exit_status") == 0 else f"exit {record.get('exit_status')}")
            if record.get("test_counts"):
                counts.append(" ".join(f"{k} {v}" for k, v in sorted(record["test_counts"].items())))
        # Identical counts in both profiles is the property that rules out a
        # pass reached by skipping work whose input was not materialised.
        observed = counts[0] if counts and len(set(counts)) == 1 else " / ".join(counts)
        rows.append(f"| `{gate}` | " + " | ".join(cells) + f" | {observed} |")
    return "\n".join(rows) + "\n"


def identity_table(raw: str) -> str:
    rows = [
        "| Provisioned profile | Manifest digest | Provision identity | Receipt deterministic digest | Reproduces |",
        "| --- | --- | --- | --- | --- |",
    ]
    for variant, label in VARIANTS:
        receipt_path = os.path.join(raw, f"receipt-{variant}.json")
        if not os.path.exists(receipt_path):
            continue
        receipt = read_json(receipt_path)
        block = receipt["deterministic"]
        reproduction = os.path.join(raw, f"receipt-{variant}.reproduction.txt")
        reproduced = "yes" if os.path.exists(reproduction) and "reproduces" in open(reproduction, encoding="utf-8").read() else "no"
        rows.append(
            f"| {label} | `{block['manifest_digest'][:16]}` | `{block['provision_identity'][:16]}` "
            f"| `{receipt['deterministic_digest'][:16]}` | {reproduced} |"
        )
    return "\n".join(rows) + "\n"


def control_table(raw: str) -> str:
    path = os.path.join(raw, "full-checkout-controls.jsonl")
    if not os.path.exists(path):
        return "_not recorded_\n"
    rows = ["| Gate class | Result | Observed test counts |", "| --- | --- | --- |"]
    for record in read_jsonl(path):
        counts = record.get("test_counts") or {}
        observed = " ".join(f"{k} {v}" for k, v in sorted(counts.items()))
        result = "pass" if record["exit_status"] == 0 else f"**exit {record['exit_status']}**"
        rows.append(f"| `{record['id']}` | {result} | {observed} |")
    return "\n".join(rows) + "\n"


def product_surface_table(raw: str) -> str:
    path = os.path.join(raw, "product-surface.json")
    if not os.path.exists(path):
        return "_not recorded_\n"
    record = read_json(path)
    rows = [
        "| Surface | Files | Digest at merge base | Digest at measured revision | Identical |",
        "| --- | ---: | --- | --- | --- |",
    ]
    for row in record["surfaces"]:
        rows.append(
            f"| `{row['surface']}/` | {row['files']:,} | `{row['merge_base_digest']}` "
            f"| `{row['measured_revision_digest']}` | {'yes' if row['identical'] else '**no**'} |"
        )
    return "\n".join(rows) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--evidence-dir",
        default=os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "docs/evidence/default-reduced-profile",
        ),
    )
    args = parser.parse_args()
    raw = os.path.join(args.evidence_dir, "raw")
    if not os.path.isdir(raw):
        print(f"raw evidence directory not found: {raw}", file=sys.stderr)
        return 2

    print("### Where each work surface is routed\n")
    print(surface_decision_table(raw))
    print("### Where each gate class routes focused card work\n")
    print(gate_decision_table(raw))
    print("### Boundary requests\n")
    print(boundary_decision_table(raw))
    print("### Profile identity and receipt reproduction\n")
    print(identity_table(raw))
    print("### Provisioned footprint by category\n")
    print(footprint_table(raw))
    print("### Charged disk — the free-space delta of one provisioning run\n")
    print(charged_table(raw))
    print("### Provisioning time by phase\n")
    print(timing_table(raw))
    print("### Fail-closed and fallback probes\n")
    print(probe_table(raw))
    print("### Git object behaviour, integrity and history\n")
    print(integrity_table(raw))
    print("### Gate classes run in both provisioned profiles\n")
    print(gate_probe_table(raw))
    print("### Full-checkout controls\n")
    print(control_table(raw))
    print("### Product surface, unchanged\n")
    print(product_surface_table(raw))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
