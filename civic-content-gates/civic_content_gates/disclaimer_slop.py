"""Plain-language lint for defensive disclaimer copy.

This gate looks only at user-facing HTML text and JavaScript string literals. It
keeps the initial pattern set intentionally small: a warning that fires often is
quickly ignored. Findings recommend a positive rewrite that says what the thing
is, why it matters, and what the reader should do.

Absence-caveats are a construction, not a phrase list: a heading or short lead
in negative scope that introduces a list of undetermined items. Ordinary
negative sentences, coverage notes, and methodology limits without that
enumeration are not refused.

The default mode is ``warn``. ``block`` is the calibrated enforcement mode.
Reviewed exceptions may use the allowlist file or an adjacent
``no-disclaimer-slop: ignore`` comment.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from typing import Iterable, Optional, Sequence


DEFAULT_ALLOWLIST = Path(__file__).with_name("no_disclaimer_slop_allowlist.txt")
IGNORE_RE = re.compile(r"no-disclaimer-slop\s*:\s*ignore\b", re.IGNORECASE)


@dataclass(frozen=True)
class Pattern:
    id: str
    name: str
    regex: re.Pattern[str]


PATTERNS = (
    Pattern(
        "navigational_aid_authority",
        "navigational-aid disclaimer",
        re.compile(
            r"\bthis is a navigational aid\b.{0,140}?\bnot an authoritative determination\b",
            re.IGNORECASE | re.DOTALL,
        ),
    ),
    Pattern(
        "promised_date_disclaimer",
        "promised-date disclaimer",
        re.compile(r"\bnot a promised date\b", re.IGNORECASE),
    ),
    Pattern(
        "timing_disclaimer",
        "timing disclaimer",
        re.compile(r"\bactual timing can change\b", re.IGNORECASE),
    ),
    Pattern(
        "materialization_scope_disclaimer",
        "materialization-scope disclaimer",
        re.compile(
            r"\bthis summary is limited to\b.{0,180}?\boutside this materialization\b",
            re.IGNORECASE | re.DOTALL,
        ),
    ),
    Pattern(
        "winner_identity_disclaimer",
        "winner-and-identity disclaimer",
        re.compile(
            r"\bthis check compares claims\b.{0,180}?\bdoes not choose a winner or merge identities\b",
            re.IGNORECASE | re.DOTALL,
        ),
    ),
    Pattern(
        "provenance_restatement",
        "provenance-restatement disclaimer",
        re.compile(
            r"(?:"
            r"\bawards?\s+are\s+as\s+published\s+in\s+the\s+city\s+record\b|"
            r"\bregistered\s+contracts\s+and\s+payments\s+live\s+on\b|"
            r"\btimeline\s+lead\s+carries\b|"
            r"\blas\s+adjudicaciones\s+son\s+las\s+del\s+city\s+record\b|"
            r"\bcontratos\s+registrados\s+y\s+los\s+pagos\s+est[aá]n\s+en\b|"
            r"\bencabezado\s+de\s+la\s+cronolog[ií]a\b"
            r")",
            re.IGNORECASE,
        ),
    ),
    Pattern(
        "defensive_hedge_shape",
        "defensive hedge",
        re.compile(
            r"\b(?:this is\s+[^.!?\n]{1,120}|"
            r"(?:default|summary|guide|check|measure|timeline|map|record|result|status|"
            r"label|date|aid|page|identity|winner|prediction|verdict|self-report)\b"
            r"[^.!?\n]{0,100}),\s*(?:it is\s+)?not\s+[^.!?\n]{1,120}(?:[.!?]|$)",
            re.IGNORECASE,
        ),
    ),
)

ABSENCE_CAVEAT_RULE_ID = "absence_caveat_shape"
ABSENCE_CAVEAT_RULE_NAME = "absence-caveat disclaimer"

# Negative scope names the family of "we did not determine this" leads. The
# enumeration (a following list, a colon-led series, or short parallel
# fragments) is required separately; matching one of these phrases alone is
# not a finding.
NEGATIVE_SCOPE_RE = re.compile(
    r"(?:"
    r"\bcan(?:\s+not|not)\s+verify\b|"
    r"\bnot\s+confirmed\s+by\b|"
    r"\boutside\s+what\s+(?:we|the\s+site)\s+can\s+check\b|"
    r"\bdo(?:es)?\s+not\s+(?:carry|include)\b|"
    r"\bnot\s+a\s+finding\b|"
    r"\bunable\s+to\s+establish\b|"
    r"\bno\s+record\s+of\b|"
    r"\bnot\s+part\s+of\s+(?:our|the)\s+sources\b|"
    r"\bwe\s+(?:were|are)\s+unable\s+to\s+(?:establish|confirm|verify|determine)\b|"
    r"\bcould\s+not\s+(?:establish|confirm|verify|determine)\b"
    r")",
    re.IGNORECASE,
)
HTML_STRUCTURE_HINT_RE = re.compile(
    r"<\s*(?:p|h[1-6]|ul|ol|li|div|section|article|blockquote)\b",
    re.IGNORECASE,
)
SERIES_SPLIT_RE = re.compile(r"\s*(?:,|;|·|•|\band\b)\s*", re.IGNORECASE)
# A long paragraph that happens to contain "not a finding" is not introducing
# the list that follows it. Headings and short leads are.
ABSENCE_INTRODUCER_MAX_CHARS = 120
SHORT_FRAGMENT_MAX_CHARS = 80

# These short forms carry a concrete evidence, timing, or source boundary. They
# are deliberately retained as positive product copy; the gate targets defensive
# framing that replaces the meaning with a disclaimer.
LEGITIMATE_BOUNDARY_RE = re.compile(
    r"(?:^status is\b|historical context|historical, not a current warning|"
    r"source-linked measure|published layer|"
    r"date is context)",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class Finding:
    path: str
    line: int
    rule_id: str
    rule_name: str
    text: str

    def as_dict(self) -> dict[str, object]:
        return {
            "path": self.path,
            "line": self.line,
            "rule_id": self.rule_id,
            "rule": self.rule_name,
            "text": self.text,
        }


class VisibleTextExtractor(HTMLParser):
    """Extract rendered text while excluding machine-readable page payloads."""

    SKIP_TAGS = {"code", "pre", "script", "style", "template"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._stack: list[str] = []
        self.parts: list[tuple[str, int]] = []

    def _skipping(self) -> bool:
        return any(tag in self.SKIP_TAGS for tag in self._stack)

    def handle_starttag(self, tag: str, attrs) -> None:  # noqa: ANN001 - HTMLParser API
        self._stack.append(tag.lower())

    def handle_startendtag(self, tag: str, attrs) -> None:  # noqa: ANN001 - HTMLParser API
        return

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        for index in range(len(self._stack) - 1, -1, -1):
            if self._stack[index] == tag:
                del self._stack[index:]
                break

    def handle_data(self, data: str) -> None:
        if data.strip() and not self._skipping():
            self.parts.append((data, self.getpos()[0]))


@dataclass
class _Block:
    kind: str
    text: str
    line: int
    items: tuple[str, ...] = field(default_factory=tuple)


class StructuredTextExtractor(HTMLParser):
    """Visible block structure: headings, leads, and lists with line offsets."""

    SKIP_TAGS = {"code", "pre", "script", "style", "template"}
    HEADING_TAGS = {"h1", "h2", "h3", "h4", "h5", "h6"}
    LEAD_TAGS = {"p"}
    LIST_TAGS = {"ul", "ol"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._stack: list[str] = []
        self._lead: Optional[dict[str, object]] = None
        self._lists: list[dict[str, object]] = []
        self.blocks: list[_Block] = []

    def _skipping(self) -> bool:
        return any(tag in self.SKIP_TAGS for tag in self._stack)

    def _in_list(self) -> bool:
        return bool(self._lists)

    def _close_tag(self, tag: str) -> None:
        tag = tag.lower()
        for index in range(len(self._stack) - 1, -1, -1):
            if self._stack[index] == tag:
                del self._stack[index:]
                break

    def handle_starttag(self, tag: str, attrs) -> None:  # noqa: ANN001 - HTMLParser API
        tag = tag.lower()
        self._stack.append(tag)
        if self._skipping():
            return
        if tag in self.LIST_TAGS:
            self._lists.append({"line": self.getpos()[0], "items": [], "item_parts": None})
        elif tag == "li" and self._lists:
            self._lists[-1]["item_parts"] = []
        elif tag in self.HEADING_TAGS or tag in self.LEAD_TAGS:
            if not self._in_list():
                self._lead = {
                    "kind": "heading" if tag in self.HEADING_TAGS else "lead",
                    "line": self.getpos()[0],
                    "parts": [],
                }

    def handle_startendtag(self, tag: str, attrs) -> None:  # noqa: ANN001 - HTMLParser API
        return

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        skipping = self._skipping()
        self._close_tag(tag)
        if skipping:
            return
        if tag == "li" and self._lists:
            current = self._lists[-1]
            parts = current.get("item_parts")
            if isinstance(parts, list):
                text = _normalise(" ".join(parts))
                if text:
                    current["items"].append(text)  # type: ignore[union-attr]
            current["item_parts"] = None
        elif tag in self.LIST_TAGS and self._lists:
            current = self._lists.pop()
            items = tuple(str(item) for item in current["items"])  # type: ignore[union-attr]
            if items:
                self.blocks.append(_Block("list", " ".join(items), int(current["line"]), items))
        elif tag in self.HEADING_TAGS or tag in self.LEAD_TAGS:
            if self._lead is not None and not self._in_list():
                parts = self._lead["parts"]
                text = _normalise(" ".join(str(part) for part in parts))  # type: ignore[union-attr]
                if text:
                    self.blocks.append(_Block(str(self._lead["kind"]), text, int(self._lead["line"])))
                self._lead = None

    def handle_data(self, data: str) -> None:
        if self._skipping() or not data.strip():
            return
        if self._lists:
            parts = self._lists[-1].get("item_parts")
            if isinstance(parts, list):
                parts.append(data)
                return
        if self._lead is not None:
            self._lead["parts"].append(data)  # type: ignore[union-attr]


def _normalise(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _ignored(lines: Sequence[str], line: int) -> bool:
    # Same-line and immediately preceding comments keep exceptions local to the
    # copy they review. The marker is intentionally language-neutral for HTML,
    # JavaScript, and i18n source comments.
    for index in (line - 1, line - 2):
        if 0 <= index < len(lines) and IGNORE_RE.search(lines[index]):
            return True
    return False


def _load_allowlist(path: Optional[Path]) -> dict[str, set[str]]:
    allowlist = Path(path) if path else DEFAULT_ALLOWLIST
    values: dict[str, set[str]] = {}
    if not allowlist.exists():
        return values
    for raw in allowlist.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        rule_id, separator, text = line.partition("\t")
        if not separator or not text.strip():
            raise ValueError(
                f"{allowlist}: each entry must be RULE_ID<TAB>reviewed copy"
            )
        values.setdefault(rule_id.strip(), set()).add(_normalise(text))
    return values


def _line_for_offset(segments: Sequence[tuple[int, int, int]], offset: int) -> int:
    for start, end, line in segments:
        if start <= offset <= end:
            return line
    return segments[-1][2] if segments else 1


def _find_in_text(
    text: str,
    path: str,
    lines: Sequence[str],
    line: int = 1,
    segments: Optional[Sequence[tuple[int, int, int]]] = None,
) -> list[Finding]:
    findings: list[Finding] = []
    for pattern in PATTERNS:
        for match in pattern.regex.finditer(text):
            finding_line = _line_for_offset(segments or [], match.start()) if segments else line
            if _ignored(lines, finding_line):
                continue
            matched = _normalise(match.group(0))
            if pattern.id == "defensive_hedge_shape" and LEGITIMATE_BOUNDARY_RE.search(matched):
                continue
            findings.append(Finding(path, finding_line, pattern.id, pattern.name, matched))
    return findings


def _visible_text(source: str) -> tuple[str, list[tuple[int, int, int]]]:
    parser = VisibleTextExtractor()
    parser.feed(source)
    pieces: list[str] = []
    segments: list[tuple[int, int, int]] = []
    offset = 0
    for data, line in parser.parts:
        piece = _normalise(data)
        if not piece:
            continue
        if pieces:
            pieces.append(" ")
            offset += 1
        start = offset
        pieces.append(piece)
        offset += len(piece)
        segments.append((start, offset, line))
    return "".join(pieces), segments


def _structured_blocks(source: str) -> list[_Block]:
    parser = StructuredTextExtractor()
    parser.feed(source)
    parser.close()
    if parser._lead is not None:
        parts = parser._lead["parts"]
        text = _normalise(" ".join(str(part) for part in parts))  # type: ignore[union-attr]
        if text:
            parser.blocks.append(_Block(str(parser._lead["kind"]), text, int(parser._lead["line"])))
        parser._lead = None
    while parser._lists:
        current = parser._lists.pop()
        items = tuple(str(item) for item in current["items"])  # type: ignore[union-attr]
        if items:
            parser.blocks.append(_Block("list", " ".join(items), int(current["line"]), items))
    return parser.blocks


def _colon_led_series(text: str) -> Optional[list[str]]:
    match = NEGATIVE_SCOPE_RE.search(text)
    if not match:
        return None
    rest = text[match.end():]
    colon = rest.find(":")
    if colon < 0:
        return None
    series_text = rest[colon + 1:].strip()
    if not series_text:
        return None
    items = [_normalise(part).strip(" .") for part in SERIES_SPLIT_RE.split(series_text) if _normalise(part).strip(" .")]
    return items if len(items) >= 2 else None


def _is_short_fragment(text: str) -> bool:
    compact = _normalise(text)
    if not compact or compact.endswith(":") or compact.endswith("?"):
        return False
    return len(compact) <= SHORT_FRAGMENT_MAX_CHARS


def _is_introducer(block: _Block) -> bool:
    if block.kind not in {"heading", "lead"}:
        return False
    if not NEGATIVE_SCOPE_RE.search(block.text):
        return False
    if block.kind == "heading":
        return True
    return len(block.text) <= ABSENCE_INTRODUCER_MAX_CHARS or block.text.rstrip().endswith(":")


def _absence_finding(path: str, line: int, text: str) -> Finding:
    return Finding(path, line, ABSENCE_CAVEAT_RULE_ID, ABSENCE_CAVEAT_RULE_NAME, _normalise(text))


def _find_absence_in_blocks(
    blocks: Sequence[_Block],
    path: str,
    lines: Sequence[str],
    line_offset: int = 0,
) -> list[Finding]:
    findings: list[Finding] = []
    length = len(blocks)
    index = 0
    while index < length:
        block = blocks[index]
        line = block.line + line_offset
        if block.kind in {"heading", "lead"} and NEGATIVE_SCOPE_RE.search(block.text):
            if _ignored(lines, line):
                index += 1
                continue
            if _colon_led_series(block.text):
                findings.append(_absence_finding(path, line, block.text))
                index += 1
                continue
            if _is_introducer(block):
                lookahead = index + 1
                if (
                    lookahead < length
                    and blocks[lookahead].kind == "lead"
                    and NEGATIVE_SCOPE_RE.search(blocks[lookahead].text)
                ):
                    lookahead += 1
                if lookahead < length and blocks[lookahead].kind == "list" and blocks[lookahead].items:
                    findings.append(_absence_finding(path, line, block.text))
                    index += 1
                    continue
                fragments: list[_Block] = []
                cursor = index + 1
                while (
                    cursor < length
                    and blocks[cursor].kind == "lead"
                    and _is_short_fragment(blocks[cursor].text)
                ):
                    fragments.append(blocks[cursor])
                    cursor += 1
                if len(fragments) >= 2:
                    findings.append(_absence_finding(path, line, block.text))
        index += 1
    return findings


def _find_absence_in_plain_text(text: str, path: str, lines: Sequence[str], line: int) -> list[Finding]:
    compact = _normalise(text)
    if not compact or not NEGATIVE_SCOPE_RE.search(compact):
        return []
    if _ignored(lines, line):
        return []
    if _colon_led_series(compact):
        return [_absence_finding(path, line, compact)]
    raw_lines = [part.strip() for part in re.split(r"[\r\n]+", text) if part.strip()]
    if len(raw_lines) >= 3 and _is_introducer(_Block("lead", _normalise(raw_lines[0]), line)):
        fragments = [_normalise(part) for part in raw_lines[1:] if _is_short_fragment(part)]
        if len(fragments) >= 2:
            return [_absence_finding(path, line, raw_lines[0])]
    return []


def _find_absence_caveat(
    source: str,
    path: str,
    lines: Sequence[str],
    *,
    html: bool,
    line: int = 1,
) -> list[Finding]:
    if html or HTML_STRUCTURE_HINT_RE.search(source):
        blocks = _structured_blocks(source)
        return _find_absence_in_blocks(blocks, path, lines, line_offset=line - 1)
    return _find_absence_in_plain_text(source, path, lines, line)


def _javascript_strings(source: str) -> Iterable[tuple[str, int]]:
    """Yield quoted/template string contents without scanning comments."""
    i = 0
    line = 1
    length = len(source)
    previous_significant = ""
    while i < length:
        char = source[i]
        if char == "\n":
            line += 1
            i += 1
            continue
        if char == "/" and i + 1 < length and source[i + 1] == "/":
            i += 2
            while i < length and source[i] != "\n":
                i += 1
            continue
        if char == "/" and i + 1 < length and source[i + 1] == "*":
            i += 2
            while i + 1 < length and not (source[i] == "*" and source[i + 1] == "/"):
                if source[i] == "\n":
                    line += 1
                i += 1
            i = min(length, i + 2)
            continue
        if char not in {"'", '"', "`"}:
            if not char.isspace():
                previous_significant = char
            i += 1
            continue

        # A quote inside a regular-expression literal or an apostrophe in a
        # non-string token is not user-facing copy. Valid string starts occur
        # after expression punctuation or a small set of statement keywords.
        prefix = source[:i].rstrip()
        starts_after_word = bool(re.search(r"(?:return|throw|yield|case)\s*$", prefix))
        starts_after_punctuation = previous_significant in "=([{,:;!?&|+*-~<>"
        if not (starts_after_word or starts_after_punctuation or not previous_significant):
            i += 1
            continue

        quote = char
        start_line = line
        i += 1
        chars: list[str] = []
        while i < length:
            char = source[i]
            if quote == "`" and char == "$" and i + 1 < length and source[i + 1] == "{":
                # Template expressions contain JavaScript, including comments and
                # nested strings. They are executable source rather than rendered
                # copy, so skip the balanced expression and keep scanning its text.
                depth = 1
                i += 2
                while i < length and depth:
                    if source[i] == "\\":
                        i += 2
                        continue
                    if source[i] == "\n":
                        line += 1
                    elif source[i] == "{":
                        depth += 1
                    elif source[i] == "}":
                        depth -= 1
                    i += 1
                continue
            if char == "\\" and i + 1 < length:
                chars.extend((char, source[i + 1]))
                if source[i + 1] == "\n":
                    line += 1
                i += 2
                continue
            if char == quote:
                i += 1
                break
            chars.append(char)
            if char == "\n":
                line += 1
            i += 1
        value = "".join(chars)
        if value.strip():
            yield value, start_line
        previous_significant = quote


def _source_files(root: Path, paths: Optional[Sequence[str]]) -> list[Path]:
    if paths:
        return [(root / path).resolve() if not Path(path).is_absolute() else Path(path) for path in paths]
    return sorted(
        path
        for path in root.rglob("*")
        if path.is_file() and path.suffix.lower() in {".html", ".js", ".mjs"}
    )


def scan(
    site_root: Path,
    paths: Optional[Sequence[str]] = None,
    allowlist_file: Optional[Path] = None,
) -> list[Finding]:
    root = Path(site_root).resolve()
    allowlist = _load_allowlist(allowlist_file)
    findings: list[Finding] = []
    for path in _source_files(root, paths):
        if not path.exists():
            raise FileNotFoundError(path)
        source = path.read_text(encoding="utf-8")
        lines = source.splitlines()
        relative = str(path.relative_to(root))
        if path.suffix.lower() == ".html":
            text, segments = _visible_text(source)
            findings.extend(_find_in_text(text, relative, lines, segments=segments))
            findings.extend(_find_absence_caveat(source, relative, lines, html=True))
        else:
            for text, line in _javascript_strings(source):
                findings.extend(_find_in_text(text, relative, lines, line=line))
                findings.extend(_find_absence_caveat(text, relative, lines, html=False, line=line))

    # The English dictionary is copied into several locale bundles as a fallback.
    # One finding per distinct copy keeps the warning useful while the source path
    # still points to the first canonical occurrence.
    unique: dict[tuple[str, str], Finding] = {}
    for finding in findings:
        if _normalise(finding.text) in allowlist.get(finding.rule_id, set()):
            continue
        key = (finding.rule_id, _normalise(finding.text))
        unique[key] = finding
    return sorted(unique.values(), key=lambda item: (item.path, item.line, item.rule_id))


GUIDANCE = (
    "Rewrite as a positive plain statement: say what it is, why it matters, and what to do. "
    "Default: X, because Y; do Z."
)


def run(
    site_root: Path,
    paths: Optional[Sequence[str]] = None,
    allowlist_file: Optional[Path] = None,
    mode: str = "warn",
    fmt: str = "text",
) -> int:
    if mode not in {"warn", "block"}:
        raise ValueError("mode must be 'warn' or 'block'")
    findings = scan(site_root, paths=paths, allowlist_file=allowlist_file)
    status = "BLOCK" if mode == "block" and findings else "WARN"
    if fmt == "json":
        print(json.dumps({"mode": mode, "findings": [f.as_dict() for f in findings]}, indent=2))
    else:
        print(f"no-disclaimer-slop: {status} — {len(findings)} finding(s)")
        for finding in findings:
            message = f"{finding.rule_name}: {GUIDANCE} Copy: {finding.text!r}"
            if fmt == "github":
                print(
                    f"::warning file={finding.path},line={finding.line},"
                    f"title=no-disclaimer-slop::{message}"
                )
            else:
                print(f"  {finding.path}:{finding.line} [{finding.rule_id}] {message}")
        if not findings:
            print("no-disclaimer-slop: positive-copy scan passed")
        elif mode == "warn":
            print("no-disclaimer-slop: warnings are non-blocking; use --mode block after calibration")
    return 1 if mode == "block" and findings else 0


def main(argv: Optional[Sequence[str]] = None, site_root: Optional[Path] = None, allowlist_file: Optional[Path] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Find defensive disclaimer copy and guide positive plain-language rewrites"
    )
    parser.add_argument("--root", type=Path, default=site_root, help="Site or generated-artifact root")
    parser.add_argument("--allowlist", type=Path, default=allowlist_file, help="Reviewed exceptions: RULE_ID<TAB>copy")
    parser.add_argument("--mode", choices=("warn", "block"), default="warn", help="warn reports findings; block returns failure")
    parser.add_argument("--format", choices=("text", "github", "json"), default="text")
    parser.add_argument("paths", nargs="*", help="Optional paths relative to --root")
    args = parser.parse_args(list(argv) if argv is not None else None)
    if not args.root:
        parser.error("--root is required")
    return run(args.root, paths=args.paths or None, allowlist_file=args.allowlist, mode=args.mode, fmt=args.format)


if __name__ == "__main__":
    raise SystemExit(main())
