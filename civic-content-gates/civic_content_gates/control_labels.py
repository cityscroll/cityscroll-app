"""Control-label lint for concise, action-led interface copy.

Visible action labels are a control plane: they name what the control does. Object
context, provenance, dates, and status belong in adjacent data copy or accessible
names. This gate scans authored HTML/JavaScript control templates and the dynamic
action-key families used by CityScroll's list cards.
"""
from __future__ import annotations

import html
import re
import sys
from pathlib import Path
from typing import Optional, Sequence

from . import _util

MAX_WORDS = 4
CHECK_LANGS = ("en", "es")
SOURCE_SUFFIXES = frozenset((".html", ".js", ".mjs"))
SKIP_PARTS = frozenset(("data", "vendor", "node_modules"))

CONTROL_RE = re.compile(
    r"<(?P<tag>button|summary|a)\b(?P<attrs>[^>]*)>(?P<inner>.*?)</(?P=tag)>",
    re.IGNORECASE | re.DOTALL,
)
CLASS_RE = re.compile(r'''\bclass=["']([^"']*)["']''', re.IGNORECASE)
DATA_I18N_RE = re.compile(r'''\bdata-i18n=["']([A-Za-z0-9_]+)["']''')
T_CALL_RE = re.compile(
    r'''(?:\$\{)?(?:[A-Za-z]+\()*(?:window\.)?t\(\s*["']([A-Za-z0-9_]+)["'][^)]*\)(?:\))*(?:\})?'''
)
SR_ONLY_RE = re.compile(
    r'''<span\b[^>]*class=["'][^"']*\bsr-only\b[^"']*["'][^>]*>.*?</span>''',
    re.IGNORECASE | re.DOTALL,
)
TAG_RE = re.compile(r"<[^<>]*>")
DYNAMIC_RE = re.compile(r"\$\{.*?\}", re.DOTALL)
PLACEHOLDER_RE = re.compile(r"\{[^{}]+\}")
WORD_RE = re.compile(r"[\wÀ-ÖØ-öø-ÿ]+(?:['’.-][\wÀ-ÖØ-öø-ÿ]+)*", re.UNICODE)
STATUS_RES = {
    "en": re.compile(r"\b(?:is|are|was|were|closed|no\s+longer)\b", re.IGNORECASE),
    "es": re.compile(r"\b(?:está|están|estaba|estaban|cerrad[oa]s?|ya\s+no)\b", re.IGNORECASE),
}

# Anchors are included only when styled as action controls. Buttons and summaries
# are controls by element semantics. These named families cover labels selected at
# runtime (for example rulesExplorerCardHTML's action_key) that a template scan
# cannot resolve to one literal t("key") call.
ACTION_CLASSES = frozenset(("act", "watchbtn", "export-control", "mini-sub-btn"))
DYNAMIC_KEY_PREFIXES = (
    "disposition_phase_action_",
    "franchise_phase_action_",
    "rule_action_",
    "meeting_action_",
    "land_action_",
    "property_action_",
)
DYNAMIC_KEYS = frozenset((
    "award_watch_offer_btn",
    "agency_follow_btn",
    "agency_watch_meetings_btn",
    "agency_watch_rules_btn",
    "calendar_ics",
    "mini_subscribe_btn",
    "next_action_award_checkbook",
    "open_notice_submission_portal",
    "open_nycha_isupplier",
    "open_rfp_package",
    "participation_link",
    "preview_digest_btn",
    "quiz_preview_btn",
    "subscribe_btn",
    "search_passport_rfx",
    "view_comment_zap",
    "watch_this_search",
    "export_csv",
    "export_xlsx",
    "print_save_pdf",
))
STATUS_KEYS = frozenset(("property_action_closed", "rule_action_comment_closed"))


def _source_files(site_root: Path) -> list[Path]:
    files = list()
    for path in Path(site_root).rglob("*"):
        if not path.is_file() or path.suffix not in SOURCE_SUFFIXES:
            continue
        rel = path.relative_to(site_root)
        if any(part in SKIP_PARTS for part in rel.parts):
            continue
        if rel.parts[:2] == ("i18n", "lang") or rel.name == "i18n.js":
            continue
        files.append(path)
    return sorted(files)


def _is_action_control(tag: str, attrs: str, inner: str) -> bool:
    if tag in {"button", "summary"}:
        return True
    match = CLASS_RE.search(attrs)
    if match and ACTION_CLASSES.intersection(match.group(1).split()):
        return True
    keys = list(m.group(1) for m in DATA_I18N_RE.finditer(attrs))
    keys.extend(m.group(1) for m in T_CALL_RE.finditer(inner))
    return any(key in DYNAMIC_KEYS or key.startswith(DYNAMIC_KEY_PREFIXES) for key in keys)


def _resolved_control_text(attrs: str, inner: str, strings_en: dict) -> str:
    outer_key = DATA_I18N_RE.search(attrs)
    if outer_key:
        return str(strings_en.get(outer_key.group(1), ""))

    inner = SR_ONLY_RE.sub(" ", inner)

    def replace_i18n(match: re.Match) -> str:
        return str(strings_en.get(match.group(1), ""))

    inner = re.sub(
        r'''<[^>]*\bdata-i18n=["']([A-Za-z0-9_]+)["'][^>]*>.*?</[^>]+>''',
        replace_i18n,
        inner,
        flags=re.IGNORECASE | re.DOTALL,
    )
    inner = T_CALL_RE.sub(replace_i18n, inner)
    inner = DYNAMIC_RE.sub(" ", inner)
    inner = TAG_RE.sub(" ", inner)
    return re.sub(r"\s+", " ", html.unescape(inner)).strip()


def _visible_words(text: str) -> list[str]:
    return WORD_RE.findall(PLACEHOLDER_RE.sub(" ", text))


def _finding(source: str, text: str, lang: str = "en") -> Optional[str]:
    normalized = re.sub(r"\s+", " ", text).strip()
    if not normalized:
        return None
    words = _visible_words(normalized)
    if len(words) > MAX_WORDS:
        return f"{source}: {len(words)} words (max {MAX_WORDS}): {normalized!r}"
    if STATUS_RES[lang].search(normalized):
        return f"{source}: status phrasing inside a control: {normalized!r}"
    return None


def check(site_root: Path) -> list[str]:
    """Return concise-control findings (empty means pass)."""
    site_root = Path(site_root)
    strings = _util.load_strings(site_root)
    findings: list[str] = list()
    seen: set[tuple[str, str]] = set()

    for path in _source_files(site_root):
        rel = str(path.relative_to(site_root))
        src = path.read_text(encoding="utf-8")
        for match in CONTROL_RE.finditer(src):
            tag = match.group("tag").lower()
            attrs = match.group("attrs")
            if not _is_action_control(tag, attrs, match.group("inner")):
                continue
            for lang in CHECK_LANGS:
                text = _resolved_control_text(attrs, match.group("inner"), strings.get(lang, {}))
                source = rel if lang == "en" else f"{rel} [{lang}]"
                item = _finding(source, text, lang)
                identity = (source, text)
                if item and identity not in seen:
                    seen.add(identity)
                    findings.append(item)

    for key, value in strings.get("en", {}).items():
        if key in STATUS_KEYS:
            continue
        if key not in DYNAMIC_KEYS and not key.startswith(DYNAMIC_KEY_PREFIXES):
            continue
        for lang in CHECK_LANGS:
            localized = str(strings.get(lang, {}).get(key, value))
            source = f"i18n:{key}" if lang == "en" else f"i18n:{key} [{lang}]"
            item = _finding(source, localized, lang)
            identity = (source, localized)
            if item and identity not in seen:
                seen.add(identity)
                findings.append(item)

    return findings


def run(site_root: Path) -> int:
    findings = check(site_root)
    if findings:
        print(
            "control-label lint FAILED — visible controls must use a concise action phrase; "
            "put status and context beside the control:",
            file=sys.stderr,
        )
        for finding in findings:
            print(f"  {finding}", file=sys.stderr)
        return 1
    print(f"control-label lint OK — English and Spanish action controls use at most {MAX_WORDS} words and contain no status phrasing")
    return 0


def main(argv: Optional[Sequence[str]] = None, site_root: Optional[Path] = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Concise action-control label lint")
    parser.add_argument("--root", type=Path, default=site_root, help="Site root")
    args = parser.parse_args(list(argv) if argv is not None else None)
    if not args.root:
        parser.error("--root is required (or pass site_root to main())")
    return run(args.root)


if __name__ == "__main__":
    raise SystemExit(main())
