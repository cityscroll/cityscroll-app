#!/usr/bin/env python3
"""NYC Web Content Style Guide copy lint (w10-01).

Encodes the mechanically-checkable copy rules of the NYC Web Content Style Guide
(designsystem.nyc.gov/standards/nyc-web-content-style-guide.html) in the house
stray-english architecture: a static lint over two sources of truth —

  1. STRINGS.en in i18n.js (the actual rendered copy for every t()/tSection() call —
     loaded via node, same trick as link_text.py), and
  2. the six HTML pages' own rendered text, so headings/buttons/labels that are not
     (yet) routed through i18n still get checked.

Content-zone carve-outs mirror stray_english.py/13_stray_english.py: <script>/<style>/
<code>/<pre>, `.chg-detail` bullet lists and incident call-outs (changelog's archival
per-release technical detail), and the changelog's dated release <h2> titles themselves
(an archival register presented verbatim — same posture the heading-punctuation lint
(w10-04) carves out for the same headings).

Ships REPORT-ONLY (default: prints findings, always exits 0) until w10-06 fixes the
confirmed prose deviations; pass --gate to fail on any finding not in the allowlist
(and on stale allowlist entries), the mode w10-06 flips CI to.

Rule families (matrix ids from the full-standards audit, nycdds-matrix-w3):
  acronyms       B3   banned acronym forms (e.g./i.e./etc./ASAP/FYI/RSVP/a.k.a./DIY)
  emoji          B12  no emoji in copy (decorative pictographs — NOT the site's existing
                      utilitarian glyphs ✓⚑⚠←→↗☰●◷, which are icons, not emoji)
  em_i_s         B35  no <em>/<i>/<s> emphasis in copy zones
  ampersand      B31  "and" instead of "&" (outside an official title)
  and_or         B32  avoid "and/or"
  semicolon      B32  avoid semicolons in copy
  double_space   B32  single space between sentences
  word_form      B37  the specific-words table's checkable forms
  inclusive      B15  inclusive-language deny-list
  truncation     B1   no truncated abbreviations (appt, gov't)
  pdf_link       A6/B21 no linking to PDFs/spreadsheets
  currency       B27  spell out "$N million"+; numerals OK in chip/button/select context
  time_form      B10  12-hour clock, "9 a.m." not "9AM"/"17:30"
  button_generic B6   button text must say what will happen (extends link_text.py)
  all_caps       B8   no ALL CAPS for emphasis in copy (CSS text-transform chrome is a
                      separate design idiom, not linted here)
"""
import json
import pathlib
import re
import subprocess
import sys
from html.parser import HTMLParser

ROOT = pathlib.Path(__file__).parents[2]
ALLOWLIST_FILE = pathlib.Path(__file__).parent / "nyc_copy_lint_allowlist.txt"
PAGES = ["index.html", "about.html", "data.html", "stats.html", "api.html", "changelog.html"]

SKIP_TAGS = {"script", "style", "code", "pre"}

# Symbols the site already uses deliberately as UI icons — never emoji findings.
ALLOWED_GLYPHS = set("✓⚑⚠☰●◷")

EMOJI_RE = re.compile(
    "[\U0001F300-\U0001FAFF\U00002600-\U000027BF\U00002B00-\U00002BFF"
    "\U0001F1E6-\U0001F1FF]"
)
ACRONYM_RE = re.compile(r"\be\.g\.|\bi\.e\.|\betc\.|\bASAP\b|\bFYI\b|\bRSVP\b|\ba\.k\.a\.|\bDIY\b")
AMPERSAND_RE = re.compile(r"(?<=\w) & (?=\w)")
AND_OR_RE = re.compile(r"\band/or\b", re.IGNORECASE)
SEMICOLON_RE = re.compile(r";\s")
DOUBLE_SPACE_RE = re.compile(r"[^\s]  [^\s]")
TRUNCATION_RE = re.compile(r"\bappt\b|\bgov't\b", re.IGNORECASE)
PDF_LINK_RE = re.compile(r'href="[^"]*\.(pdf|docx?|xlsx?)(["#?])', re.IGNORECASE)
CURRENCY_RE = re.compile(r"\$[0-9.]+[MBK]\b")
TIME_FORM_RE = re.compile(r"\b\d{1,2}(AM|PM)\b|\b(1[3-9]|2[0-3]):[0-5]\d\b")
ALL_CAPS_RE = re.compile(r"\b[A-Z]{4,}\b")

WORD_FORM_VIOLATIONS = [
    (re.compile(r"\bweb site\b", re.IGNORECASE), "website"),
    (re.compile(r"\bweb page\b", re.IGNORECASE), "webpage"),
    (re.compile(r"\be-mail\b", re.IGNORECASE), "email"),
    (re.compile(r"\bokay\b", re.IGNORECASE), "OK"),
    (re.compile(r"\bclick here\b", re.IGNORECASE), "descriptive link text"),
    (re.compile(r"\bFAQ\b"), "frequently asked questions"),
]
INCLUSIVE_DENYLIST = [
    re.compile(r"\bsenior citizen(s)?\b", re.IGNORECASE),
    re.compile(r"\binmate(s)?\b", re.IGNORECASE),
    re.compile(r"\bhandicapped\b", re.IGNORECASE),
    re.compile(r"\bwheelchair[- ]bound\b", re.IGNORECASE),
    re.compile(r"\billegal (immigrant|alien)s?\b", re.IGNORECASE),
    re.compile(r"\bmentally ill\b", re.IGNORECASE),
]

# Acronyms/brand terms exempt from the all-caps rule (mirrors stray_english.py's list).
ALL_CAPS_ALLOW = {
    "RFP", "RFPS", "PIN", "ZAP", "API", "RSS", "JSON", "CSV", "ICS", "DOB", "HPD",
    "DCAS", "NYC", "MOCS", "ULURP", "MIH", "FY", "CD", "OK", "US", "ZIP", "MCP",
    "AI", "CROL", "LIST", "GET", "POST", "PDF", "HTML", "URL", "IT", "HTTP",
    "SODA", "NYPA", "CAPTCHA", "WCAG", "CAPS", "TTL", "SQL", "XML", "MISSION",
    "SECURITY", "CONTRIBUTING",
}

GENERIC_PHRASES = {
    "click here", "click", "here", "read more", "more", "more info", "more information",
    "learn more", "see more", "this link", "this", "link", "details", "view", "info",
    "go", "continue",
}

TAG_RE = re.compile(r"<[^<>]*>")
T_CALL_RE = re.compile(r"""\$\{t\(\s*["']([a-zA-Z0-9_]+)["'](?:\s*,[^)]*)?\)\}""")
DYNAMIC_RE = re.compile(r"\$\{[^}]*\}")


def load_strings_en():
    out = subprocess.check_output(
        ["node", "-e",
         "global.window={};require(process.argv[1]);console.log(JSON.stringify(window.STRINGS))",
         str(ROOT / "i18n.js")], text=True)
    return json.loads(out).get("en", {})


VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input",
             "link", "meta", "param", "source", "track", "wbr"}


class CopyExtractor(HTMLParser):
    """Walks a page, yielding the copy zones the lint cares about.

    Content-zone carve-outs (script/style/code/pre, `.chg-detail`, and the changelog's
    archival <h2> release titles) are tracked with a proper element stack — a flat
    depth counter would exit the zone early on the first *nested* closing tag (e.g. a
    <code> inside a `.chg-detail` <li>), which is exactly the bug this replaced.
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []  # frames: {"tag": str, "skip": bool, "archival": bool}
        self.em_stack = []
        self.button_stack = []
        self.text_parts = []
        self.em_findings = []
        self.button_findings = []
        self.pdf_hrefs = []

    def _in_skip(self):
        return any(f["skip"] for f in self.stack)

    def _in_archival(self):
        return any(f["archival"] for f in self.stack)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        cls = attrs.get("class", "") or ""
        data_i18n = attrs.get("data-i18n", "") or attrs.get("data-i18n-html", "") or ""
        if tag == "a" and "href" in attrs and PDF_LINK_RE.search(f'href="{attrs["href"]}"'):
            self.pdf_hrefs.append(attrs["href"])
        skip = tag in SKIP_TAGS or "chg-detail" in cls
        archival = tag == "h2" and data_i18n.startswith("chg_")
        if tag in VOID_TAGS:
            return  # no closing tag will arrive to pop a frame
        self.stack.append({"tag": tag, "skip": skip, "archival": archival})
        if self._in_skip() or self._in_archival():
            return
        if tag in ("em", "i", "s"):
            self.em_stack.append([])
        if tag == "button":
            self.button_stack.append([])

    def handle_endtag(self, tag):
        idx = None
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i]["tag"] == tag:
                idx = i
                break
        if idx is None:
            return  # stray/void-ish close with no matching open frame
        del self.stack[idx:]
        if tag in ("em", "i", "s") and not self._in_skip() and not self._in_archival() and self.em_stack:
            buf = "".join(self.em_stack.pop()).strip()
            if buf:
                self.em_findings.append(buf)
        if tag == "button" and not self._in_skip() and not self._in_archival() and self.button_stack:
            buf = "".join(self.button_stack.pop()).strip()
            self.button_findings.append(buf)

    def handle_data(self, data):
        if self._in_skip() or self._in_archival():
            return
        if self.em_stack:
            self.em_stack[-1].append(data)
        if self.button_stack:
            self.button_stack[-1].append(data)
        self.text_parts.append(data)


def extract_page(src):
    p = CopyExtractor()
    p.feed(src)
    return p


def check_text_rules(text, findings, source):
    if EMOJI_RE.search(text):
        for ch in EMOJI_RE.findall(text):
            if ch not in ALLOWED_GLYPHS:
                findings.append(("emoji", source, text))
                break
    if ACRONYM_RE.search(text):
        findings.append(("acronyms", source, text))
    if AMPERSAND_RE.search(text):
        findings.append(("ampersand", source, text))
    if AND_OR_RE.search(text):
        findings.append(("and_or", source, text))
    if SEMICOLON_RE.search(text):
        findings.append(("semicolon", source, text))
    if DOUBLE_SPACE_RE.search(text):
        findings.append(("double_space", source, text))
    if TRUNCATION_RE.search(text):
        findings.append(("truncation", source, text))
    if CURRENCY_RE.search(text):
        findings.append(("currency", source, text))
    if TIME_FORM_RE.search(text):
        findings.append(("time_form", source, text))
    for rx, _ in WORD_FORM_VIOLATIONS:
        if rx.search(text):
            findings.append(("word_form", source, text))
            break
    for rx in INCLUSIVE_DENYLIST:
        if rx.search(text):
            findings.append(("inclusive", source, text))
            break
    for m in ALL_CAPS_RE.finditer(text):
        if m.group(0) not in ALL_CAPS_ALLOW:
            findings.append(("all_caps", source, text))
            break


def check_button(text, findings, source):
    resolved = re.sub(r"\s+", " ", text).strip()
    if not resolved:
        return
    if resolved.lower() in GENERIC_PHRASES:
        findings.append(("button_generic", source, resolved))


def strip_html_value(value):
    return re.sub(r"\s+", " ", TAG_RE.sub(" ", value)).strip()


def main():
    gate = "--gate" in sys.argv
    findings = []

    for page in PAGES:
        src = (ROOT / page).read_text(encoding="utf-8")
        p = extract_page(src)
        for chunk in p.text_parts:
            chunk = re.sub(r"\s+", " ", chunk).strip()
            if chunk:
                check_text_rules(chunk, findings, page)
        for em_text in p.em_findings:
            findings.append(("em_i_s", page, em_text))
        for btn_text in p.button_findings:
            check_button(btn_text, findings, page)
        for href in p.pdf_hrefs:
            findings.append(("pdf_link", page, href))

    strings_en = load_strings_en()
    for key, value in strings_en.items():
        if not isinstance(value, str):
            continue
        if re.search(r"<em>|<i>|<s>", value):
            findings.append(("em_i_s", f"i18n.js:{key}", strip_html_value(value)))
        check_text_rules(strip_html_value(value), findings, f"i18n.js:{key}")

    allow = {}
    if ALLOWLIST_FILE.exists():
        for line in ALLOWLIST_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            rule_id, _, text = line.partition("\t")
            allow.setdefault(rule_id, set()).add(text)

    found_by_rule = {}
    for rule_id, source, text in findings:
        found_by_rule.setdefault(rule_id, set()).add(text)

    new = []
    for rule_id, source, text in findings:
        if text not in allow.get(rule_id, set()):
            new.append((rule_id, source, text))

    stale = []
    for rule_id, texts in allow.items():
        for text in texts - found_by_rule.get(rule_id, set()):
            stale.append((rule_id, text))

    total = len(findings)
    unique_new = sorted(set(new))
    print(f"nyc_copy_lint: {total} finding(s) across {len(PAGES)} page(s) + i18n.js "
          f"({len(unique_new)} not in the allowlist)")
    by_rule = {}
    for rule_id, source, text in findings:
        by_rule.setdefault(rule_id, 0)
        by_rule[rule_id] += 1
    for rule_id in sorted(by_rule):
        print(f"  {rule_id}: {by_rule[rule_id]}")

    if unique_new:
        print("\nfindings not in the allowlist:", file=sys.stderr if gate else sys.stdout)
        for rule_id, source, text in unique_new:
            print(f"  [{rule_id}] {source}: {text[:120]!r}", file=sys.stderr if gate else sys.stdout)

    if not gate:
        print("\nnyc_copy_lint OK (report-only — pass --gate to enforce)")
        return

    if stale:
        print("\nnyc_copy_lint FAILED — stale allowlist entries (no longer found):", file=sys.stderr)
        for rule_id, text in sorted(set(stale)):
            print(f"  STALE [{rule_id}]: {text!r}", file=sys.stderr)

    if unique_new or stale:
        sys.exit(1)
    print("\nnyc_copy_lint --gate OK — all findings allowlisted, 0 new, 0 stale")


if __name__ == "__main__":
    main()
