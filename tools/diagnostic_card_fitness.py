#!/usr/bin/env python3
"""Engineering-card plus resident-UX checks for diagnostic repair card proposals.

This is the producer-side gate. Generated cards never leave the operator
plane unless they satisfy the same required fields, causal shape, and
operator `ux_review` contract the Hanlin validators enforce for live cards.
"""

from __future__ import annotations

import ast
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

CARD_STANDARD = "engineering-card.v1"
VALID_PROFILES = {"standard", "micro"}
VALID_STATUSES = {"proposed", "in-progress", "blocked", "implemented", "obsolete"}
REQUIRED_FIELDS = (
    "card_standard",
    "richness_profile",
    "id",
    "title",
    "status",
    "wave",
    "spec",
    "builds_on",
    "related",
    "context",
    "verify",
    "needs_james",
)
REQUIRED_HEADINGS = ("Story", "Change", "Acceptance")
PLACEHOLDER_RE = re.compile(
    r"\b(?:TBD|TODO|N/?A|FIXME)\b|<[^>\n]+>|\{\{[^}\n]+\}\}|\[placeholder\]",
    re.IGNORECASE,
)
LOCAL_PATH_RE = re.compile(r"(?:file:/{2}|/(?:Users|home)/|[A-Za-z]:\\|(?:^|\s)~/)")
HEADING_RE = re.compile(r"^(#{2,6})\s+(.+?)\s*$")
FRONTMATTER_KEY_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]*(.*))?$")
ACCEPTANCE_RE = re.compile(
    r"^- \[([ xX])\]\s+(A[1-9][0-9]*)\s+((?:\[[^\]]+\]\s*)+)(.+?)\s*$"
)
RAW_INTERNAL = re.compile(
    r"\b(?:not_yet_ingested|generated_in_memory|held_mnar|unmatched_identity)\b",
    re.I,
)
CAUSAL_STORY_RE = re.compile(
    r"\b(?:because the publisher|publisher (?:failed|refused|ignored)|proves that|caused by the agency)\b",
    re.I,
)


@dataclass(frozen=True)
class Violation:
    path: Path
    line: int
    rule: str
    message: str

    def format(self) -> str:
        return f"{self.path.as_posix()}:{self.line} {self.rule} {self.message}"


@dataclass
class ParsedCard:
    path: Path
    text: str
    fields: dict[str, object]
    field_lines: dict[str, int]
    body_start: int
    lines: list[str]


def _parse_scalar(raw: str) -> object:
    value = raw.strip()
    if value in {"", "null", "None", "~"}:
        return None
    if value.lower() == "true":
        return True
    if value.lower() == "false":
        return False
    try:
        return ast.literal_eval(value)
    except (SyntaxError, ValueError):
        return value


def parse_card_text(path: Path, text: str) -> ParsedCard:
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        raise ValueError("card has no YAML frontmatter")
    try:
        end = next(index for index in range(1, len(lines)) if lines[index].strip() == "---")
    except StopIteration as exc:
        raise ValueError("card has unterminated YAML frontmatter") from exc
    fields: dict[str, object] = {}
    field_lines: dict[str, int] = {}
    index = 1
    while index < end:
        match = FRONTMATTER_KEY_RE.match(lines[index])
        if not match:
            index += 1
            continue
        key, raw = match.group(1), match.group(2) or ""
        field_lines[key] = index + 1
        if raw.strip():
            fields[key] = _parse_scalar(raw)
            index += 1
            continue
        items: list[object] = []
        cursor = index + 1
        while cursor < end:
            item = re.match(r"^\s+-\s*(.*?)\s*$", lines[cursor])
            if not item:
                break
            items.append(_parse_scalar(item.group(1)))
            cursor += 1
        mapping: dict[str, object] = {}
        if not items:
            while cursor < end:
                nested = re.match(r"^ +([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]*(.*))?$", lines[cursor])
                if not nested:
                    break
                mapping[nested.group(1)] = _parse_scalar(nested.group(2) or "")
                cursor += 1
        fields[key] = items if items else mapping or None
        index = cursor
    return ParsedCard(path, text, fields, field_lines, end + 1, lines)


def _normalized_words(text: str) -> list[str]:
    text = re.sub(r"https?://\S+", " ", text)
    text = re.sub(r"`[^`]*`", " ", text)
    text = re.sub(r"[*_#>|\[\](){},.:;/\\]", " ", text)
    return re.findall(r"\b[\w’'-]+\b", text, flags=re.UNICODE)


def word_count(text: str) -> int:
    return len(_normalized_words(text))


def _headings(parsed: ParsedCard) -> list[tuple[int, int, str]]:
    result = []
    for index in range(parsed.body_start, len(parsed.lines)):
        match = HEADING_RE.match(parsed.lines[index])
        if match:
            result.append((index + 1, len(match.group(1)), match.group(2)))
    return result


def _h2_section(parsed: ParsedCard, title: str) -> tuple[int, list[str]] | None:
    headings = _headings(parsed)
    for position, (line_no, level, heading) in enumerate(headings):
        if level == 2 and heading == title:
            end = len(parsed.lines) + 1
            for next_line, next_level, _ in headings[position + 1 :]:
                if next_level == 2:
                    end = next_line
                    break
            return line_no, parsed.lines[line_no:end - 1]
    return None


def _labeled_block(lines: list[str], label: str) -> tuple[int, str] | None:
    pattern = re.compile(rf"^\*\*{re.escape(label)}:\*\*\s*(.*)$", re.IGNORECASE)
    labels = re.compile(
        r"^\*\*(?:Before|After \(intended\)|After \(realized\)|Theory / mechanism):\*\*",
        re.IGNORECASE,
    )
    for index, line in enumerate(lines):
        match = pattern.match(line.strip())
        if not match:
            continue
        collected = [match.group(1)]
        cursor = index + 1
        while cursor < len(lines):
            candidate = lines[cursor].strip()
            if labels.match(candidate) or candidate.startswith("### Gap -> fix") or candidate.startswith("## "):
                break
            collected.append(lines[cursor])
            cursor += 1
        return index, "\n".join(collected).strip()
    return None


def _parse_gap_rows(change_lines: list[str]) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    in_table = False
    for offset, candidate in enumerate(change_lines):
        if candidate.strip() == "### Gap -> fix":
            in_table = True
            continue
        if not in_table:
            continue
        stripped = candidate.strip()
        if stripped.startswith("### ") or stripped.startswith("## "):
            break
        if not stripped.startswith("|"):
            continue
        cells = [cell.strip() for cell in stripped.strip("|").split("|")]
        if len(cells) != 4 or cells[0].casefold() == "id" or all(set(cell) <= {"-", ":"} for cell in cells):
            continue
        rows.append(
            {
                "line": offset + 1,
                "id": cells[0],
                "gap": cells[1],
                "fix": cells[2],
                "acceptance": re.findall(r"\bA[1-9][0-9]*\b", cells[3]),
            }
        )
    return rows


def validate_resident_ux(fields: dict[str, object]) -> list[str]:
    """Operator/resident UX contract (Hanlin KCF070 shape)."""
    status = fields.get("status")
    if status not in {"proposed", "in-progress", "blocked", "ready"}:
        return []
    review = fields.get("ux_review")
    if isinstance(review, str):
        try:
            review = json.loads(review)
        except json.JSONDecodeError:
            review = None
    if not isinstance(review, dict):
        return ["live cards require ux_review; classify the audience before projecting internal state"]
    audience = review.get("audience")
    if audience not in {"resident", "mixed", "operator", "machine"}:
        return ["ux_review.audience must be resident, mixed, operator or machine"]
    required = ("primary", "disclosure", "absence", "failure", "proof") if audience in {"resident", "mixed"} else ("reason",)
    errors = []
    for key in required:
        value = review.get(key)
        if not isinstance(value, str) or len(value.split()) < 5 or re.search(r"\b(?:TBD|TODO|placeholder)\b", value, re.I):
            errors.append(f"ux_review.{key} needs a concrete task-specific decision of at least five words")
    primary = review.get("primary", "")
    if isinstance(primary, str) and RAW_INTERNAL.search(primary):
        errors.append("ux_review.primary prescribes a raw internal state; use resident meaning or Desk diagnostics")
    return errors


def validate_card_text(path: Path, text: str, repo_root: Path) -> list[Violation]:
    parsed = parse_card_text(path, text)
    violations: list[Violation] = []

    def add(rule: str, message: str, line: int = 1) -> None:
        violations.append(Violation(path, line, rule, message))

    missing = [field for field in REQUIRED_FIELDS if field not in parsed.fields]
    if missing:
        add("KCF001", f"missing required frontmatter: {', '.join(missing)}")
    if parsed.fields.get("card_standard") != CARD_STANDARD:
        add("KCF001", f"card_standard must be {CARD_STANDARD!r}", parsed.field_lines.get("card_standard", 1))
    for field in ("id", "title", "wave", "spec"):
        value = parsed.fields.get(field)
        if not isinstance(value, str) or not value.strip() or PLACEHOLDER_RE.search(value):
            add("KCF001", f"{field} must be a non-placeholder string", parsed.field_lines.get(field, 1))
    card_id = parsed.fields.get("id")
    if isinstance(card_id, str) and (any(character.isspace() for character in card_id) or "/" not in card_id):
        add("KCF001", "id must be a namespaced, whitespace-free logical identifier", parsed.field_lines.get("id", 1))
    profile = str(parsed.fields.get("richness_profile") or "")
    if profile not in VALID_PROFILES:
        add("KCF001", "richness_profile must be 'standard' or 'micro'", parsed.field_lines.get("richness_profile", 1))
        profile = "standard"
    if str(parsed.fields.get("status") or "") not in VALID_STATUSES:
        add("KCF001", "status is not part of the engineering-card vocabulary", parsed.field_lines.get("status", 1))
    for field in ("builds_on", "related", "context"):
        if field in parsed.fields and not isinstance(parsed.fields[field], list):
            add("KCF001", f"{field} must be an explicit YAML list", parsed.field_lines.get(field, 1))
    if not isinstance(parsed.fields.get("verify"), str) or not str(parsed.fields.get("verify") or "").strip():
        add("KCF002", "verify must be a runnable command or explicit inspection protocol", parsed.field_lines.get("verify", 1))
    if isinstance(parsed.fields.get("context"), list) and not parsed.fields["context"]:
        add("KCF002", "context must name at least one durable locator", parsed.field_lines.get("context", 1))
    for field in ("spec", "verify"):
        value = parsed.fields.get(field)
        if PLACEHOLDER_RE.search(str(value or "")) or (isinstance(value, str) and LOCAL_PATH_RE.search(value)):
            add("KCF002", f"{field} contains a placeholder or local-machine path", parsed.field_lines.get(field, 1))
    if isinstance(parsed.fields.get("context"), list):
        if any(
            not isinstance(item, str) or PLACEHOLDER_RE.search(item) or LOCAL_PATH_RE.search(item)
            for item in parsed.fields["context"]
        ):
            add("KCF002", "context must contain only durable repo-relative locators or URLs", parsed.field_lines.get("context", 1))

    spec = parsed.fields.get("spec")
    if isinstance(spec, str) and spec:
        file_part, separator, anchor = spec.partition("#")
        spec_path = (repo_root / file_part).resolve()
        if not file_part or not spec_path.is_file():
            add("KCF002", f"spec target does not exist: {file_part or spec!r}", parsed.field_lines.get("spec", 1))
        elif not separator or not anchor:
            add("KCF002", "spec must include an existing anchor", parsed.field_lines.get("spec", 1))
        else:
            target = spec_path.read_text(encoding="utf-8", errors="replace")
            if not re.search(rf"(?:id|name)=[\"']{re.escape(anchor)}[\"']", target):
                add("KCF002", f"spec anchor does not exist: #{anchor}", parsed.field_lines.get("spec", 1))

    headings = _headings(parsed)
    required_occurrences = {
        title: [(line, level) for line, level, heading in headings if heading == title]
        for title in REQUIRED_HEADINGS
    }
    bad = [title for title, occurrences in required_occurrences.items() if len(occurrences) != 1 or occurrences[0][1] != 2]
    if bad:
        add("KCF010", f"required exact H2 headings missing or duplicated: {', '.join(bad)}", parsed.body_start + 1)

    story_section = _h2_section(parsed, "Story")
    change_section = _h2_section(parsed, "Change")
    acceptance_section = _h2_section(parsed, "Acceptance")
    story_floor = 15 if profile == "micro" else 30
    before_floor = 10 if profile == "micro" else 15
    after_floor = 10 if profile == "micro" else 15
    theory_floor = 12 if profile == "micro" else 20
    item_floor = 6 if profile == "micro" else 8
    item_count_floor = 2 if profile == "micro" else 3

    if story_section:
        story_line, story_lines = story_section
        story = "\n".join(story_lines)
        if word_count(story) < story_floor:
            add("KCF011", f"Story has {word_count(story)} words; {profile} requires {story_floor}", story_line)
        if PLACEHOLDER_RE.search(story):
            add("KCF011", "Story contains placeholder prose", story_line)
        if CAUSAL_STORY_RE.search(story):
            add("KCF011", "Story asserts an unproven causal interpretation", story_line)

    if change_section:
        change_line, change_lines = change_section
        after_label = "After (realized)" if str(parsed.fields.get("status")) == "implemented" else "After (intended)"
        for label, floor in (("Before", before_floor), (after_label, after_floor), ("Theory / mechanism", theory_floor)):
            block = _labeled_block(change_lines, label)
            if block is None:
                add("KCF020", f"Change is missing **{label}:**", change_line)
                continue
            offset, prose = block
            if word_count(prose) < floor or PLACEHOLDER_RE.search(prose):
                add("KCF020", f"{label} has {word_count(prose)} words; {profile} requires {floor} substantive words", change_line + offset + 1)
            if CAUSAL_STORY_RE.search(prose):
                add("KCF020", f"{label} asserts an unproven causal interpretation", change_line + offset + 1)
        gaps = _parse_gap_rows(change_lines)
        if not gaps:
            add("KCF021", "Change needs a non-empty four-column '### Gap -> fix' table", change_line)

    if acceptance_section:
        acceptance_line, acceptance_lines = acceptance_section
        items = []
        for offset, line in enumerate(acceptance_lines, start=1):
            if not re.match(r"^- \[[ xX]\]", line.strip()):
                continue
            match = ACCEPTANCE_RE.match(line.strip())
            if not match:
                add("KCF030", "Acceptance checkbox must have A#, type tag, G# tag, and observable prose", acceptance_line + offset)
                continue
            tags: set[str] = set()
            for group in re.findall(r"\[([^\]]+)\]", match.group(3)):
                tags.update(piece.strip() for piece in group.split(",") if piece.strip())
            items.append({"id": match.group(2), "tags": tags, "text": match.group(4), "line": acceptance_line + offset})
        if len(items) < item_count_floor:
            add("KCF030", f"Acceptance has {len(items)} valid items; {profile} requires {item_count_floor}", acceptance_line)
        types = set()
        for item in items:
            types |= item["tags"] & {"outcome", "boundary", "verification"}
            if word_count(item["text"]) < item_floor:
                add("KCF030", f"{item['id']} needs at least {item_floor} substantive words", int(item["line"]))
        missing_types = {"outcome", "boundary", "verification"} - types
        if profile == "standard" and missing_types:
            add("KCF030", f"Acceptance lacks type coverage: {', '.join(sorted(missing_types))}", acceptance_line)

    for message in validate_resident_ux(parsed.fields):
        add("KCF070", message, parsed.field_lines.get("ux_review", 1))
    return violations


def assert_fit(path: Path, text: str, repo_root: Path) -> None:
    violations = validate_card_text(path, text, repo_root)
    if violations:
        raise ValueError("; ".join(item.format() for item in violations))
