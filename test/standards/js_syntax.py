#!/usr/bin/env python3
"""Standards gate: every inline <script> block and every .js file must parse.

Born from a production outage (2026-07-11): an editing pass introduced smart quotes
(“ ”) into index.html's main script block; unit tests exercise extracted pure
functions and the axe gate only needs static HTML, so a dead script block sailed
through CI and Pages auto-deployed a site whose entire JS was one SyntaxError.
`node --check` on every script would have caught it in one second. Now it does.
"""
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HTML_PAGES = ["index.html", "about.html", "data.html", "stats.html", "changelog.html", "api.html"]
JS_FILES = ["i18n.js", "nl_parse.js"]

failures = 0
for page in HTML_PAGES:
    text = (ROOT / page).read_text()
    for i, block in enumerate(re.findall(r"<script>(.*?)</script>", text, re.S)):
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
            f.write(block)
            path = f.name
        r = subprocess.run(["node", "--check", path], capture_output=True, text=True)
        if r.returncode:
            failures += 1
            print(f"FAIL {page} script block {i}:")
            print("  " + r.stderr.strip().splitlines()[-1][:200])
        else:
            print(f"OK   {page} script block {i}")

for js in JS_FILES:
    r = subprocess.run(["node", "--check", str(ROOT / js)], capture_output=True, text=True)
    if r.returncode:
        failures += 1
        print(f"FAIL {js}: " + r.stderr.strip().splitlines()[-1][:200])
    else:
        print(f"OK   {js}")

if failures:
    sys.exit(f"js_syntax gate: {failures} unparseable script(s)")
print("✅ js_syntax gate green")
