#!/usr/bin/env python3
"""Static stray-English lint — every user-facing string literal routes through t()/tSection().

Companion to the runtime guard (test/functional/13_stray_english.py): the guard proves what a
reader SEES; this lint catches the source pattern that causes it — an English-looking string
literal inside the inline <script> of index.html (or a builder in i18n.js) that is emitted
into the DOM without passing through the i18n layer. Born from the 2026-07-13 regression
("36 notices from 16 agencies" + raw section names in es mode).

Mechanism: extract every string/template literal from the JS (template literals contribute
their literal parts, ${…} expressions stripped), discard literals that cannot be UI text
(SODA/SQL query fragments, CSS, URLs, i18n keys, console noise), then flag literals whose
words hit the shared English-word list (test/standards/english_words.py).

The allowlist (stray_english_allowlist.txt) is the EXPLICIT, TRACKED register of remaining
English literals — mostly the entity/notice/investigation hash-routed views and outbound
email/ICS bodies, queued for the language-expansion wave. The gate fails on NEW findings;
it also fails on STALE allowlist entries so the register can only shrink honestly.
"""
import re
import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from english_words import ENGLISH_WORDS  # noqa: E402

ROOT = pathlib.Path(__file__).parents[2]
ALLOWLIST_FILE = pathlib.Path(__file__).parent / "stray_english_allowlist.txt"

# Terms allowed as-printed (mirrors the runtime guard's case-sensitive acronym list).
ALLOWED_TERMS = {
    "RFP", "RFPs", "PIN", "ZAP", "ZoLa", "PASSPort", "API", "RSS", "Atom", "JSON", "CSV",
    "ICS", "DOB", "HPD", "DCAS", "NYC", "MOCS", "ULURP", "MIH", "FY", "CD", "M/WBE",
}
ALLOWED_PHRASES = ["CROL-List", "City Record", "NYC Open Data", "Checkbook NYC", "New York",
                   "MapPLUTO", "GeoSearch", "Staten Island"]

WORD_RE = re.compile(r"[A-Za-z]+")
I18N_CALL_RE = re.compile(r"(?:\bt|\btSection)\s*\(\s*$")


# A `/` starts a regex literal (not division) when the previous significant token ends
# with one of these chars, or is one of the keywords below — the standard JS heuristic.
_PUNCT_BEFORE_REGEX = set("(,=:[!&|?{};+*%~^<>-")
_KW_BEFORE_REGEX = {"return", "typeof", "case", "in", "of", "new", "delete", "void", "instanceof"}


def _skip_regex(src, i):
    """i points at the opening '/'. Return index just past the regex (incl. flags)."""
    j, n, in_class = i + 1, len(src), False
    while j < n:
        c = src[j]
        if c == "\\":
            j += 2
            continue
        if c == "[":
            in_class = True
        elif c == "]":
            in_class = False
        elif c == "/" and not in_class:
            j += 1
            break
        elif c == "\n":
            break
        j += 1
    while j < n and src[j].isalpha():
        j += 1
    return j


def extract_literals(src, _stop_at_brace=False, _pos=0):
    """Tokenize JS well enough to yield (preceding_context, literal_text_part) pairs.

    Handles nested template literals (`a ${cond ? `b` : "c"} d`), regex literals
    (.replace(/'/g,"''") — the naive-regex failure mode), and // and /* */ comments.
    Template ${…} expressions are recursed into, so their own strings are yielded too.
    """
    out = []
    i, n = 0, len(src)
    prev_sig = ""   # last significant char
    prev_word = ""  # last identifier (for return/typeof/… before a regex)
    depth = 0
    while i < n:
        c = src[i]
        if _stop_at_brace and c == "}" and depth == 0:
            return out, i
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
        if c == "/" and i + 1 < n and src[i + 1] == "/":
            j = src.find("\n", i)
            i = n if j == -1 else j + 1
            continue
        if c == "/" and i + 1 < n and src[i + 1] == "*":
            j = src.find("*/", i)
            i = n if j == -1 else j + 2
            continue
        if c == "/" and (prev_sig == "" or prev_sig in _PUNCT_BEFORE_REGEX or prev_word in _KW_BEFORE_REGEX):
            i = _skip_regex(src, i)
            prev_sig, prev_word = "0", ""
            continue
        if c in "'\"":
            ctx = src[max(0, i - 24):i]
            j = i + 1
            buf = []
            while j < n and src[j] != c:
                if src[j] == "\\":
                    buf.append(src[j + 1] if j + 1 < n else "")
                    j += 2
                    continue
                if src[j] == "\n":
                    break
                buf.append(src[j])
                j += 1
            out.append((ctx, "".join(buf)))
            i = j + 1
            prev_sig, prev_word = "0", ""
            continue
        if c == "`":
            ctx = src[max(0, i - 24):i]
            j = i + 1
            buf = []
            while j < n:
                if src[j] == "\\":
                    buf.append(src[j + 1] if j + 1 < n else "")
                    j += 2
                    continue
                if src[j] == "`":
                    break
                if src[j] == "$" and j + 1 < n and src[j + 1] == "{":
                    inner, end = extract_literals(src[j + 2:], _stop_at_brace=True)
                    out.extend(inner)
                    buf.append("\x00")  # part boundary
                    j = j + 2 + end + 1
                    continue
                buf.append(src[j])
                j += 1
            for part in "".join(buf).split("\x00"):
                out.append((ctx, part))
            i = j + 1
            prev_sig, prev_word = "0", ""
            continue
        if not c.isspace():
            prev_sig = c
            if c.isalpha() or c == "_":
                prev_word += c
            else:
                prev_word = ""
        i += 1
    if _stop_at_brace:
        return out, n
    return out

# A literal is skipped entirely (cannot be UI text) if it matches any of these.
NON_UI_RE = [
    re.compile(r"\$(select|where|order|group|limit|q)\b"),           # SODA param names/values
    re.compile(r"\b(AND|IS NOT NULL|IS NULL|LIKE|DESC|ASC|between)\b"),  # SQL-ish where/order
    re.compile(r"^[a-z0-9_]+(,[a-z0-9_]+)+$"),                       # column lists
    re.compile(r"https?://|mailto:|tel:|\.json$|\.csv|\.ics|\.png"),  # URLs / files
    re.compile(r"[{;]\s*$|font(-|:)|margin|padding|width:|color:|border|display:|position:"),  # CSS
    re.compile(r"^[A-Z0-9 _/#·—\-\.\+…✓⚑⚠←→↗☰●◷]*$"),               # constants/symbols, no lowercase
    re.compile(r"BEGIN:|END:|VCALENDAR|VEVENT|DTSTAMP|TRIGGER"),     # ICS structure
    re.compile(r"<criteria>|</?search_criteria>|type_of_data|records_from"),  # Checkbook XML
    re.compile(r"^[#.\[/&@?][^ ]*$"),                                # selectors / paths / query frags
    re.compile(r"^[a-zA-Z0-9_\- ]{1,3}$"),                           # too short to judge
]

ATTR_RE = re.compile(r"[a-zA-Z-]+=\"[^\"]*\"?|[a-zA-Z-]+='[^']*'?")


def strip_markup(part):
    """Reduce a literal to its human-visible text: drop tags, dangling tag halves, attributes."""
    s = re.sub(r"<[^<>]*>", " ", part)
    # dangling tag tail at the start (literal began mid-tag): "...">visible
    m = re.match(r"^[^<>]*>", s)
    if m and any(c in m.group(0) for c in ('=', '"', "'")):
        s = s[m.end():]
    # dangling tag opened at the end: visible<a href="...
    s = re.sub(r"<[^<>]*$", " ", s)
    s = ATTR_RE.sub(" ", s)
    return re.sub(r"\s+", " ", s).strip()


def is_ui_english(part):
    for rx in NON_UI_RE:
        if rx.search(part):
            return False
    text = strip_markup(part)
    for p in ALLOWED_PHRASES:
        text = text.replace(p, " ")
    words = WORD_RE.findall(text)
    hits = [w for w in words if w not in ALLOWED_TERMS and w.lower() in ENGLISH_WORDS]
    return bool(hits)


def scan_js(src):
    findings = []
    for ctx, part in extract_literals(src):
        if I18N_CALL_RE.search(ctx):
            continue  # a t("key") / tSection("…") argument IS the i18n layer
        part = re.sub(r"\s+", " ", part).strip()
        if len(part) < 4:
            continue
        # single lowercase token = a code identifier (lens id, mode, event key), not UI text
        if re.fullmatch(r"[a-z0-9_\-]+", part):
            continue
        if is_ui_english(part):
            findings.append(part)
    return findings


def main():
    src = (ROOT / "index.html").read_text(encoding="utf-8")
    start, end = src.find("<script>"), src.rfind("</script>")
    findings = scan_js(src[start + 8:end] if start != -1 and end != -1 else "")
    # i18n.js: only the code AFTER the dictionaries (builders/helpers) is linted —
    # the STRINGS/SECTION_I18N tables *are* the i18n layer.
    i18n_src = (ROOT / "i18n.js").read_text(encoding="utf-8")
    tail_start = i18n_src.find("// Expose globals")
    findings += scan_js(i18n_src[tail_start:] if tail_start != -1 else "")

    allow = set()
    if ALLOWLIST_FILE.exists():
        for line in ALLOWLIST_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                allow.add(line)

    found = {}
    for f in findings:
        found[f] = found.get(f, 0) + 1

    new = sorted(set(found) - allow)
    stale = sorted(allow - set(found))
    if new:
        print("stray-english lint FAILED — string literal(s) not routed through t():", file=sys.stderr)
        for f in new:
            print(f"  NEW: {f!r}", file=sys.stderr)
        print("Fix: add the string to i18n.js (en+es) and call t()/tSection(); only allowlist",
              "content that must legitimately stay English.", file=sys.stderr)
    if stale:
        print("stray-english lint FAILED — stale allowlist entries (string no longer in source):", file=sys.stderr)
        for f in stale:
            print(f"  STALE: {f!r}", file=sys.stderr)
        print(f"Remove them from {ALLOWLIST_FILE.name} so the register only shrinks honestly.", file=sys.stderr)
    if new or stale:
        sys.exit(1)
    print(f"stray-english lint OK — {len(found)} known English literal(s), all allowlisted; 0 new")


if __name__ == "__main__":
    main()
