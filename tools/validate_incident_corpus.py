#!/usr/bin/env python3
"""Validate the committed merge-throughput incident corpus.

The receipt is derived only from corpus bytes and therefore stays reproducible
across evaluation time, host timezone, and repeated validation runs.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse


SCHEMA = "cityscroll.merge-throughput.incident-corpus.v1"
CLASS_IDS = (
    "arm-time-thrash",
    "flaky-shard-ejection",
    "generated-file-conflict",
    "live-external-coupling",
    "long-pole-serial-check",
    "runner-pool-contention",
    "shared-gate-rot",
)
REQUIRED_INCIDENT_FIELDS = {
    "id",
    "class",
    "signature",
    "affected_checks",
    "detection_story",
    "root_cause",
    "fix_pr",
    "time_to_detection",
    "time_to_fix",
}
SHA = re.compile(r"^[0-9a-f]{40}$")


def fail(message: str) -> None:
    raise ValueError(message)


def check_ref(ref: object, label: str) -> None:
    if not isinstance(ref, str) or not ref.strip():
        fail(f"{label}: missing evidence reference")
    parsed = urlparse(ref)
    if not (SHA.fullmatch(ref) or (parsed.scheme == "https" and parsed.netloc)):
        fail(f"{label}: malformed evidence reference")


def check_refs(value: object, label: str) -> None:
    if not isinstance(value, list) or not value:
        fail(f"{label}: causal claim needs evidence_refs")
    for index, ref in enumerate(value):
        check_ref(ref, f"{label}.evidence_refs[{index}]")


def check_timing(value: object, label: str) -> None:
    if not isinstance(value, dict):
        fail(f"{label}: timing must be an object")
    measurement = value.get("measurement")
    if measurement not in {"measured", "estimated", "unknown"}:
        fail(f"{label}: measurement must be measured, estimated, or unknown")
    if measurement != "unknown":
        minutes = value.get("minutes")
        if not isinstance(minutes, (int, float)) or minutes < 0:
            fail(f"{label}: measured or estimated timing needs non-negative minutes")
        for field in ("from", "to", "basis"):
            if not isinstance(value.get(field), str) or not value[field].strip():
                fail(f"{label}: missing {field}")


def canonical_payload(corpus: dict) -> bytes:
    # The receipt is not embedded in the corpus, so this digest is not circular.
    return json.dumps(corpus, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def validate(corpus: dict) -> dict:
    if corpus.get("schema") != SCHEMA:
        fail("invalid corpus schema")
    if corpus.get("repository") != "cityscroll/cityscroll-app":
        fail("invalid repository")

    baseline = corpus.get("queue_baseline")
    if not isinstance(baseline, dict):
        fail("missing queue baseline")
    if baseline.get("pull_requests_scanned") != 573:
        fail("queue baseline must scan 573 pull requests")
    if baseline.get("removal_events_observed") != 680:
        fail("queue baseline must contain 680 removal events")
    if baseline.get("successful_dequeues_after_merge") + baseline.get("ejections") != 680:
        fail("queue baseline removal denominator does not reconcile")
    check_ref("https://github.com/cityscroll/cityscroll-app/commit/" + baseline["source"].rsplit("@", 1)[-1], "queue_baseline.source")

    taxonomy = corpus.get("taxonomy")
    if not isinstance(taxonomy, list) or [row.get("id") for row in taxonomy] != list(CLASS_IDS):
        fail("taxonomy must contain the seven sorted class identifiers")
    for row in taxonomy:
        if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)+", row["id"]):
            fail(f"malformed class identifier: {row.get('id')}")
        if not row.get("service_rate_mechanism"):
            fail(f"taxonomy class lacks service-rate mechanism: {row['id']}")

    incidents = corpus.get("incidents")
    if not isinstance(incidents, list) or not incidents:
        fail("missing incidents")
    incident_ids = [row.get("id") for row in incidents]
    if incident_ids != sorted(incident_ids) or len(set(incident_ids)) != len(incident_ids):
        fail("incident identifiers must be unique and sorted")
    for index, incident in enumerate(incidents):
        label = f"incidents[{index}]"
        missing = REQUIRED_INCIDENT_FIELDS - incident.keys()
        if missing:
            fail(f"{label}: missing fields {sorted(missing)}")
        if incident["class"] not in CLASS_IDS:
            fail(f"{label}: malformed class identifier {incident['class']}")
        if not isinstance(incident["signature"].get("id"), str):
            fail(f"{label}.signature: missing stable signature id")
        if not incident["signature"].get("check"):
            fail(f"{label}.signature: missing affected check")
        checks = incident["affected_checks"]
        if not isinstance(checks, list) or not checks:
            fail(f"{label}.affected_checks: missing checks")
        for check_index, check in enumerate(checks):
            if not check.get("name"):
                fail(f"{label}.affected_checks[{check_index}]: missing check name")
            refs = check.get("receipts", check.get("receipt"))
            if isinstance(refs, str):
                refs = [refs]
            check_refs(refs, f"{label}.affected_checks[{check_index}]")
        for claim in (incident["detection_story"], incident["root_cause"]):
            check_refs(claim.get("evidence_refs"), f"{label}.claim")
        if not incident["root_cause"].get("evidence_kind"):
            fail(f"{label}.root_cause: uncited causal claim")
        fix = incident["fix_pr"]
        if not isinstance(fix.get("number"), int) or not fix.get("url") or not fix.get("commit"):
            fail(f"{label}.fix_pr: missing pinned PR or commit")
        check_ref(fix["url"], f"{label}.fix_pr.url")
        check_ref("https://github.com/cityscroll/cityscroll-app/commit/" + fix["commit"], f"{label}.fix_pr.commit")
        check_timing(incident["time_to_detection"], f"{label}.time_to_detection")
        check_timing(incident["time_to_fix"], f"{label}.time_to_fix")

    for index, record in enumerate(corpus.get("history_records", [])):
        if record.get("class") not in CLASS_IDS:
            fail(f"history_records[{index}]: malformed class identifier")
        check_ref(record.get("ref"), f"history_records[{index}].ref")
        if not record.get("evidence"):
            fail(f"history_records[{index}]: missing evidence")

    digest = hashlib.sha256(canonical_payload(corpus)).hexdigest()
    return {
        "schema": "cityscroll.merge-throughput.incident-corpus.receipt.v1",
        "corpus_schema": SCHEMA,
        "corpus_sha256": digest,
        "incident_ids": incident_ids,
        "taxonomy_ids": list(CLASS_IDS),
        "validation": "passed",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("path", nargs="?", default="data/incident-corpus.json")
    parser.add_argument("--receipt", action="store_true", help="emit the deterministic fixture receipt")
    args = parser.parse_args()
    try:
        corpus = json.loads(Path(args.path).read_text())
        receipt = validate(corpus)
    except (OSError, json.JSONDecodeError, TypeError, KeyError, ValueError) as error:
        print(f"incident corpus invalid: {error}", file=sys.stderr)
        return 1
    if args.receipt:
        print(json.dumps(receipt, indent=2, sort_keys=True))
    else:
        print(f"incident corpus valid: {receipt['corpus_sha256']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
