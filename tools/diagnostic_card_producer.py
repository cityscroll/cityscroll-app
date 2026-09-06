#!/usr/bin/env python3
"""Bounded scheduled producer: Desk repair issues → deduplicated engineering cards.

Reads a revalidated repair-queue snapshot, looks up active and implemented
repairs, and upserts one candidate card per stable issue fingerprint. Human
edits are preserved. Failed collection never resolves work or reports zero
outstanding findings. Public resident copy is never written.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
_TOOLS = Path(__file__).resolve().parent
if str(_TOOLS) not in sys.path:
    sys.path.insert(0, str(_TOOLS))

from diagnostic_card_fitness import assert_fit, parse_card_text  # noqa: E402

POLICY_PATH = ROOT / "data" / "diagnostic-card-producer.v1.json"
QUEUE_SCHEMA = "cityscroll.repair_queue.v1"
LINEAGE_SCHEMA = "cityscroll.diagnostic_card_lineage.v1"
RECEIPT_SCHEMA = "cityscroll.diagnostic_card_producer_receipt.v1"
UNIT_SEPARATOR = "\u001f"
CONTROL_CHARACTERS = re.compile(r"[\u0000-\u001f\u007f]")
WORK_STATES = frozenset({"repair-candidate", "regressed"})
SKIP_STATES = frozenset({"expected-absence", "source-policy-limitation"})
PUBLIC_PREFIXES = ("site/", "_site/")
SPEC = "docs/diagnostic-repair-cards.md#repair-card-contract"
VERIFY = "node --test test/desk-diagnostic-queue.test.mjs"
PRODUCER_HEADING = "## Producer evidence"


def load_policy(repo_root: Path) -> dict[str, Any]:
    path = repo_root / "data" / "diagnostic-card-producer.v1.json"
    if not path.is_file():
        return {
            "interval_seconds": 3600,
            "batch_size": 20,
            "retry_limit": 3,
            "kill_switch_env": "CITYSCROLL_DIAGNOSTIC_CARD_PRODUCER",
            "kill_switch_off_values": ["off", "0", "false", "disabled"],
            "kill_switch_file": ".diagnostic-card-producer.off",
            "card_spec": SPEC,
            "verify": VERIFY,
        }
    return json.loads(path.read_text(encoding="utf-8"))


def now_iso(value: str | None = None) -> str:
    if value:
        return value
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def clean(value: Any, max_len: int) -> str | None:
    if value is None:
        return None
    out = CONTROL_CHARACTERS.sub(" ", str(value))
    out = re.sub(r"\s+", " ", out).strip()
    return out[:max_len] if out else None


def repair_issue_key(identity: dict[str, Any]) -> str:
    payload = UNIT_SEPARATOR.join(
        [
            QUEUE_SCHEMA,
            clean(identity.get("source_contract_id") or "", 120) or "",
            clean(identity.get("condition") or "", 80) or "",
            clean(identity.get("adapter"), 80) or "",
        ]
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def kill_switch_engaged(policy: dict[str, Any], env: dict[str, str], repo_root: Path, state_dir: Path) -> bool:
    name = policy.get("kill_switch_env") or "CITYSCROLL_DIAGNOSTIC_CARD_PRODUCER"
    off = {str(item).lower() for item in policy.get("kill_switch_off_values") or ["off", "0", "false", "disabled"]}
    raw = str(env.get(name, "")).strip().lower()
    if raw in off:
        return True
    filename = policy.get("kill_switch_file") or ".diagnostic-card-producer.off"
    return (repo_root / filename).exists() or (state_dir / filename).exists()


class CollectionFailure(Exception):
    def __init__(self, reason: str, missing_inputs: list[str] | None = None):
        super().__init__(reason)
        self.reason = reason
        self.missing_inputs = missing_inputs or []


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise CollectionFailure(f"queue input was not read: {path.as_posix()}", [path.as_posix()]) from exc
    except json.JSONDecodeError as exc:
        raise CollectionFailure(f"queue input was not valid JSON: {path.as_posix()}", [path.as_posix()]) from exc


def collect_queue(source: Any, retry_limit: int = 3) -> dict[str, Any]:
    last: Exception | None = None
    attempts = max(1, int(retry_limit))
    for _ in range(attempts):
        try:
            if isinstance(source, dict):
                queue = source
            elif source is None:
                raise CollectionFailure("repair queue was not provided", ["queue"])
            else:
                queue = _read_json(Path(source))
            if not isinstance(queue, dict):
                raise CollectionFailure("repair queue is not an object", ["queue"])
            if queue.get("schema") != QUEUE_SCHEMA:
                raise CollectionFailure("repair queue schema is not the diagnostic queue schema", ["queue"])
            if queue.get("status") != "available":
                raise CollectionFailure(
                    queue.get("ingestion", {}).get("reason") or "repair observations were not read",
                    list(queue.get("ingestion", {}).get("missing_inputs") or ["queue"]),
                )
            if queue.get("counts") is None:
                raise CollectionFailure("repair queue counts are unavailable", ["queue"])
            return queue
        except CollectionFailure as exc:
            last = exc
    assert last is not None
    raise last


def load_lineage(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {"schema": LINEAGE_SCHEMA, "cards": {}}
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("schema") != LINEAGE_SCHEMA:
        data = {"schema": LINEAGE_SCHEMA, "cards": data.get("cards") or {}}
    data.setdefault("cards", {})
    return data


def load_register(source: Any) -> dict[str, Any]:
    if source is None:
        return {"schema": "cityscroll.repair_queue_register.v1", "issues": []}
    if isinstance(source, dict):
        return source
    path = Path(source)
    if not path.is_file():
        return {"schema": "cityscroll.repair_queue_register.v1", "issues": []}
    return json.loads(path.read_text(encoding="utf-8"))


def register_index(register: dict[str, Any]) -> dict[str, Any]:
    rows = {}
    for issue in register.get("issues") or []:
        key = issue.get("issue_key")
        if key:
            rows[key] = issue
    return rows


def load_implemented_repairs(evidence_dir: Path | None) -> list[dict[str, Any]]:
    found = []
    if evidence_dir is None or not evidence_dir.is_dir():
        return found
    for path in sorted(evidence_dir.glob("*.json")):
        try:
            entry = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if entry.get("status") != "implemented":
            continue
        found.append(
            {
                "id": entry.get("id"),
                "path": path.as_posix(),
                "fingerprint": entry.get("fingerprint"),
            }
        )
    return found


def existing_repair_link(issue: dict[str, Any], lineage_row: dict[str, Any] | None, registered: dict[str, Any]) -> dict[str, Any] | None:
    if lineage_row and lineage_row.get("linked_existing"):
        return lineage_row["linked_existing"]
    if lineage_row and lineage_row.get("status") in {"implemented", "in-progress"}:
        return {
            "reference": lineage_row.get("card_id"),
            "label": lineage_row.get("card_id"),
            "status": lineage_row.get("status"),
        }
    entry = registered.get(issue.get("issue_key") or "")
    card = (entry or {}).get("engineering_card")
    if isinstance(card, dict) and card.get("reference"):
        return card
    issue_card = issue.get("engineering_card")
    if isinstance(issue_card, dict) and issue_card.get("reference"):
        return issue_card
    return None


def revalidated_work_issue(issue: dict[str, Any]) -> str | None:
    """Return a skip reason, or None if the issue may become a card."""
    key = issue.get("issue_key")
    identity = issue.get("identity") or {}
    if not key or repair_issue_key(identity) != key:
        return "identity does not re-derive the issue key"
    state = issue.get("state")
    if state in SKIP_STATES:
        return f"state {state} is not repairable work"
    if state not in WORK_STATES:
        return f"state {state} does not mint a card"
    if issue.get("disposition") and issue.get("disposition") != "repair":
        return "disposition is not repair"
    if issue.get("causal_story") or issue.get("unproven_cause"):
        return "unproven causal interpretation"
    detail = " ".join(
        str(part)
        for part in (
            issue.get("detail"),
            (issue.get("identity") or {}).get("condition"),
        )
        if part
    )
    if re.search(r"\b(?:because the publisher|publisher (?:failed|refused))\b", detail, re.I):
        return "unproven causal interpretation"
    return None


def slug_for(issue: dict[str, Any]) -> str:
    identity = issue.get("identity") or {}
    bits = [
        clean(identity.get("source_contract_id"), 40) or "source",
        clean(identity.get("condition"), 40) or "condition",
        clean(identity.get("adapter"), 40) or "adapter",
    ]
    slug = re.sub(r"[^a-z0-9]+", "-", "-".join(bits).lower()).strip("-")
    return slug[:80] or issue["issue_key"][:12]


def card_id_for(issue: dict[str, Any]) -> str:
    return f"cityscroll-repair/{slug_for(issue)}"


def card_filename(issue: dict[str, Any]) -> str:
    return f"{slug_for(issue)}.md"


def yaml_quote(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def render_card(issue: dict[str, Any], *, last_seen: str, repo_paths: list[str]) -> str:
    identity = issue.get("identity") or {}
    condition = identity.get("condition") or "repair-condition"
    adapter = identity.get("adapter") or "undeclared-adapter"
    contract = identity.get("source_contract_id") or "undeclared-source"
    owner = issue.get("owner") or {}
    revision = issue.get("revision") or {}
    code_revision = revision.get("code_revision") or "not recorded"
    source_vintage = revision.get("source_vintage") or "not recorded"
    scopes = issue.get("affected_scopes") or 0
    detail = issue.get("detail") or "The owning adapter needs a repair for this condition."
    context = repo_paths or owner.get("code_paths") or ["tools/repair_queue.mjs"]
    context_yaml = "\n".join(f"  - {json.dumps(item, ensure_ascii=False)}" for item in context)
    title = f"Repair {condition} for {contract} through {adapter}"
    reason = (
        "Operators need one engineering card for this grouped Desk repair so a "
        "repeated adapter failure is commissioned once and stays attached to the same lineage."
    )
    ux = {"audience": "operator", "reason": reason}
    body = f"""---
card_standard: engineering-card.v1
richness_profile: standard
id: {card_id_for(issue)}
title: {yaml_quote(title)}
status: proposed
wave: resident-ux-repair
spec: {SPEC}
builds_on:
  - desk-repair-queue
related: []
context:
{context_yaml}
verify: {yaml_quote(VERIFY)}
needs_james: null
repair_fingerprint: {issue['issue_key']}
repair_state: {issue.get('state')}
last_seen: {yaml_quote(last_seen)}
source_revision: {yaml_quote(str(code_revision))}
affected_scope: {scopes}
ux_review: {json.dumps(ux, ensure_ascii=False)}
---

## Story

An operator watching the authenticated Desk repair queue sees the same {condition}
condition recur for source contract {contract} through adapter {adapter}. Commissioning
that repair separately on every refresh would split one adapter change across duplicate
cards and lose the history of resolution and recurrence that the queue already grouped.

## Change

**Before:** The Desk retains the grouped issue, but no canonical engineering card carries
the source revision, affected scope, owner, reproducible failure, and runnable verify gate
for this fingerprint, so each later sighting looks like new work.

**After (intended):** One proposed engineering card owns this fingerprint. Later last-seen
updates attach to that lineage, an existing active or implemented repair is linked instead
of duplicated, and expected absence or policy limitation never becomes a repair card.

**Theory / mechanism:** A durable diagnostic-to-card loop converts internal queue state into
engineering work without making it resident copy. Idempotent fingerprints and evidence
revalidation prevent duplicate tasks and automatic narratives about missing data.

### Gap -> fix

| ID | Gap | Fix | Acceptance |
| --- | --- | --- | --- |
| G1 | Recurring Desk findings reopen the same adapter repair as if it were new work | Upsert one candidate card per stable repair fingerprint with lineage through resolution | A1, A2, A3 |

## Acceptance

- [ ] A1 [outcome] [G1] Two identical producer runs keep a single card for this fingerprint and a later last-seen value updates evidence on that same lineage.
- [ ] A2 [boundary] [G1] Expected absence, source-policy limitation, failed collection, and unproven causal stories do not mint this card or report an all-clear.
- [ ] A3 [verification] [G1] The named verify command {VERIFY} remains the runnable gate for the reproducible adapter failure described by the queue.

{PRODUCER_HEADING}

- Fingerprint: `{issue['issue_key']}`
- Condition: {condition}
- Adapter: {adapter}
- Source contract: {contract}
- Last seen: {last_seen}
- Source vintage: {source_vintage}
- Code revision: {code_revision}
- Affected scopes: {scopes}
- Owner publishers: {", ".join(owner.get("publishers") or []) or "not recorded"}
- Reproducible failure: {detail}
- Verify: `{VERIFY}`
"""
    return body


def producer_evidence_block(issue: dict[str, Any], last_seen: str) -> str:
    identity = issue.get("identity") or {}
    owner = issue.get("owner") or {}
    revision = issue.get("revision") or {}
    detail = issue.get("detail") or "The owning adapter needs a repair for this condition."
    return "\n".join(
        [
            PRODUCER_HEADING,
            "",
            f"- Fingerprint: `{issue['issue_key']}`",
            f"- Condition: {identity.get('condition')}",
            f"- Adapter: {identity.get('adapter')}",
            f"- Source contract: {identity.get('source_contract_id')}",
            f"- Last seen: {last_seen}",
            f"- Source vintage: {revision.get('source_vintage') or 'not recorded'}",
            f"- Code revision: {revision.get('code_revision') or 'not recorded'}",
            f"- Affected scopes: {issue.get('affected_scopes') or 0}",
            f"- Owner publishers: {', '.join(owner.get('publishers') or []) or 'not recorded'}",
            f"- Reproducible failure: {detail}",
            f"- Verify: `{VERIFY}`",
            "",
        ]
    )


def upsert_human_edited(existing: str, issue: dict[str, Any], last_seen: str) -> str:
    parsed = parse_card_text(Path("existing.md"), existing)
    lines = parsed.lines[:]
    end = parsed.body_start - 1
    updates = {
        "last_seen": last_seen,
        "source_revision": str((issue.get("revision") or {}).get("code_revision") or "not recorded"),
        "affected_scope": issue.get("affected_scopes") or 0,
        "repair_state": issue.get("state"),
        "repair_fingerprint": issue["issue_key"],
    }
    for key, value in updates.items():
        start = None
        stop = None
        for index in range(1, end):
            match = re.match(rf"^{re.escape(key)}:", lines[index])
            if match:
                start = index
                stop = index + 1
                break
        rendered = f"{key}: {json.dumps(value) if isinstance(value, str) else value}"
        if start is None:
            lines.insert(end, rendered)
            end += 1
        else:
            lines[start] = rendered
    text = "\n".join(lines) + "\n"
    if PRODUCER_HEADING in text:
        prefix, _sep, _tail = text.partition(PRODUCER_HEADING)
        text = prefix.rstrip() + "\n\n" + producer_evidence_block(issue, last_seen)
    else:
        text = text.rstrip() + "\n\n" + producer_evidence_block(issue, last_seen)
    return text if text.endswith("\n") else text + "\n"


def public_path(path: Path, repo_root: Path) -> bool:
    try:
        relative = path.resolve().relative_to(repo_root.resolve()).as_posix()
    except ValueError:
        return False
    return any(relative == prefix.rstrip("/") or relative.startswith(prefix) for prefix in PUBLIC_PREFIXES)


def write_receipt(path: Path, receipt: dict[str, Any], dry_run: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if dry_run:
        # Dry-run still records the receipt; that is the documented artefact.
        pass
    path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def run_producer(
    *,
    repo_root: Path,
    state_dir: Path,
    queue_source: Any,
    register_source: Any = None,
    evidence_dir: Path | None = None,
    dry_run: bool = False,
    env: dict[str, str] | None = None,
    now: str | None = None,
    successful_check: bool | None = None,
    batch_size: int | None = None,
) -> dict[str, Any]:
    env = env if env is not None else dict(os.environ)
    policy = load_policy(repo_root)
    observed_at = now_iso(now)
    cards_dir = state_dir / "cards" / "proposed"
    lineage_path = state_dir / "lineage.v1.json"
    checkpoint_path = state_dir / "checkpoint.json"
    receipt_path = state_dir / "receipts" / "latest.json"
    public_touched: list[str] = []

    def finish(receipt: dict[str, Any], *, write: bool = True) -> dict[str, Any]:
        receipt.setdefault("schema", RECEIPT_SCHEMA)
        receipt.setdefault("observed_at", observed_at)
        receipt.setdefault("dry_run", dry_run)
        receipt.setdefault("notify", False)
        receipt.setdefault("public_copy_mutated", False)
        receipt.setdefault("interval_seconds", policy.get("interval_seconds"))
        if write and not (receipt.get("silent") and receipt.get("outcome") == "unchanged" and not dry_run):
            write_receipt(receipt_path, receipt, dry_run)
        elif write and dry_run:
            write_receipt(receipt_path, receipt, dry_run)
        receipt["receipt_path"] = str(receipt_path)
        return receipt

    if kill_switch_engaged(policy, env, repo_root, state_dir):
        return finish(
            {
                "outcome": "killed",
                "reason": "kill switch engaged",
                "notify": False,
                "outstanding_count": None,
                "cards_written": 0,
            }
        )

    try:
        queue = collect_queue(queue_source, retry_limit=int(policy.get("retry_limit") or 3))
    except CollectionFailure as exc:
        return finish(
            {
                "outcome": "collection-failed",
                "reason": exc.reason,
                "missing_inputs": exc.missing_inputs,
                "notify": True,
                "outstanding_count": None,
                "resolved_count": 0,
                "cards_written": 0,
                "all_clear": False,
            }
        )

    check_ok = queue.get("status") == "available" if successful_check is None else bool(successful_check)
    lineage = load_lineage(lineage_path)
    registered = register_index(load_register(register_source))
    implemented = load_implemented_repairs(evidence_dir)
    checkpoint = {}
    if checkpoint_path.is_file():
        try:
            checkpoint = json.loads(checkpoint_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            checkpoint = {}
    cursor = checkpoint.get("cursor") or ""
    batch_size = int(batch_size if batch_size is not None else policy.get("batch_size") or 20)

    issues = list(queue.get("issues") or [])
    work = []
    skipped = []
    for issue in issues:
        reason = revalidated_work_issue(issue)
        if reason:
            skipped.append({"issue_key": issue.get("issue_key"), "reason": reason, "state": issue.get("state")})
            continue
        work.append(issue)
    work.sort(key=lambda item: item.get("issue_key") or "")
    if cursor:
        work = [item for item in work if (item.get("issue_key") or "") > cursor]
    batch = work[:batch_size]
    remainder = work[batch_size:]
    next_cursor = batch[-1]["issue_key"] if remainder else ""

    created = []
    updated = []
    linked = []
    reopened = []
    closed = []
    planned = []

    def record_action(kind: str, payload: dict[str, Any]) -> None:
        planned.append({"action": kind, **payload})

    cards = lineage.setdefault("cards", {})

    for issue in issues:
        key = issue.get("issue_key")
        row = cards.get(key) if key else None
        if issue.get("state") != "resolved" or not row:
            continue
        if not check_ok:
            continue
        if row.get("status") == "resolved":
            continue
        row["status"] = "resolved"
        row["resolved_at"] = observed_at
        row.setdefault("history", []).append({"at": observed_at, "event": "resolved", "basis": "fresh successful check"})
        closed.append(key)
        record_action("resolve", {"issue_key": key})

    for issue in batch:
        key = issue["issue_key"]
        last_seen = issue.get("last_observed_at") or observed_at
        row = cards.get(key)
        link = existing_repair_link(issue, row, registered)
        if link and not (row and row.get("path") and (state_dir / row["path"]).is_file()):
            if not row:
                cards[key] = {
                    "card_id": None,
                    "fingerprint": key,
                    "status": "linked",
                    "linked_existing": link,
                    "last_seen": last_seen,
                    "source_revision": (issue.get("revision") or {}).get("code_revision"),
                    "affected_scope": issue.get("affected_scopes") or 0,
                    "human_edited": False,
                    "history": [{"at": observed_at, "event": "linked-existing"}],
                }
            else:
                row["last_seen"] = last_seen
                row["linked_existing"] = link
                row.setdefault("history", []).append({"at": observed_at, "event": "last-seen"})
            linked.append(key)
            record_action("link", {"issue_key": key, "reference": link.get("reference")})
            continue

        relative = Path("cards") / "proposed" / card_filename(issue)
        target = state_dir / relative
        if public_path(target, repo_root):
            public_touched.append(str(target))
            continue

        reopen = bool(row and row.get("status") == "resolved" and issue.get("state") == "regressed")
        existing_text = target.read_text(encoding="utf-8") if target.is_file() else None
        human_edited = False
        if existing_text and row and row.get("producer_hash") and sha256_text(existing_text) != row.get("producer_hash"):
            human_edited = True
            text = upsert_human_edited(existing_text, issue, last_seen)
        else:
            text = render_card(
                issue,
                last_seen=last_seen,
                repo_paths=list((issue.get("owner") or {}).get("code_paths") or ["tools/repair_queue.mjs"]),
            )
            if reopen and existing_text:
                text = re.sub(r"^status: .*$", "status: proposed", text, count=1, flags=re.M)

        assert_fit(target, text, repo_root)

        changed = existing_text != text
        if not changed and not reopen:
            if row:
                row["last_seen"] = last_seen
            continue

        record_action("upsert", {"issue_key": key, "path": relative.as_posix(), "reopen": reopen})
        if not dry_run:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8")
        cards[key] = {
            "card_id": card_id_for(issue),
            "path": relative.as_posix(),
            "fingerprint": key,
            "status": "proposed",
            "last_seen": last_seen,
            "source_revision": (issue.get("revision") or {}).get("code_revision"),
            "affected_scope": issue.get("affected_scopes") or 0,
            "producer_hash": sha256_text(text),
            "human_edited": human_edited,
            "linked_existing": None,
            "history": (row or {}).get("history") or [],
        }
        event = "reopened" if reopen else ("created" if existing_text is None else "updated")
        cards[key]["history"] = list(cards[key]["history"]) + [{"at": observed_at, "event": event}]
        if reopen:
            reopened.append(key)
        elif existing_text is None:
            created.append(key)
        else:
            updated.append(key)

    outstanding = queue.get("open_work_count")
    if outstanding is None:
        outstanding = sum(1 for issue in issues if issue.get("state") in WORK_STATES)

    silent = not created and not updated and not reopened and not linked and not closed
    outcome = "unchanged" if silent else "applied"
    if dry_run:
        outcome = "dry-run"

    if not dry_run:
        lineage_path.parent.mkdir(parents=True, exist_ok=True)
        lineage_path.write_text(json.dumps(lineage, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        checkpoint_path.write_text(
            json.dumps({"cursor": next_cursor, "observed_at": observed_at}, indent=2) + "\n",
            encoding="utf-8",
        )

    receipt = {
        "outcome": outcome,
        "notify": bool(created or reopened) and not dry_run,
        "silent": silent,
        "dry_run": dry_run,
        "outstanding_count": outstanding,
        "all_clear": False,
        "cards_written": 0 if dry_run else len(created) + len(updated) + len(reopened),
        "created": created,
        "updated": updated,
        "linked": linked,
        "reopened": reopened,
        "closed": closed,
        "skipped": skipped,
        "planned": planned if dry_run else [],
        "cursor": next_cursor,
        "batch_size": batch_size,
        "implemented_repairs_seen": len(implemented),
        "public_copy_mutated": bool(public_touched),
        "public_paths_refused": public_touched,
        "successful_check": check_ok,
    }
    if silent and not dry_run:
        # Unchanged live runs stay quiet: no receipt churn, no notification.
        return finish(receipt, write=False)
    return finish(receipt)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Upsert engineering cards from the Desk repair queue")
    parser.add_argument("--repo-root", type=Path, default=ROOT)
    parser.add_argument("--state-dir", type=Path)
    parser.add_argument("--queue", type=Path, help="Repair-queue JSON snapshot")
    parser.add_argument("--register", type=Path, help="Reviewed repair-queue register")
    parser.add_argument("--evidence-dir", type=Path)
    parser.add_argument("--dry-run", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    repo_root = args.repo_root.resolve()
    state_dir = (args.state_dir or (repo_root / ".diagnostic-card-producer")).resolve()
    register = args.register or (repo_root / "data" / "repair-queue-register.v1.json")
    evidence = args.evidence_dir or (repo_root / "architecture" / "evidence.d")
    result = run_producer(
        repo_root=repo_root,
        state_dir=state_dir,
        queue_source=args.queue,
        register_source=register,
        evidence_dir=evidence,
        dry_run=args.dry_run,
    )
    print(json.dumps({k: v for k, v in result.items() if k != "skipped"}, indent=2, default=str))
    if result.get("outcome") == "collection-failed":
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
