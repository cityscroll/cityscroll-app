#!/usr/bin/env python3
"""NL-input clarity gate — two free-text boxes that give different results must not look
like one input.

The Alerts tab carries two plain-text fields side by side: the 60-second quiz's "narrow it"
keyword field (an exact substring match, no parsing) and the "Ask" box (routes through the
combined parser, nl_parse.js's parseNL()/the model-backed /nl endpoint). A query typed into
one gives a materially different result than the same text typed into the other, so each
must telegraph what it actually does:

  1. The quiz keyword field's label says "keyword" (not just "narrow it"), so it doesn't
     read as an invitation to type a full sentence the way the Ask box does.
  2. The Ask box's parsed-filter summary (.qchip spans) is inert status text, not a lookalike
     of the clickable sample-query chips (.trychip) sitting right above it in the same panel —
     it needs its own non-interactive styling (cursor:default, a distinct shape from
     .trychip's pill/999px radius) and an explicit status label + role="status" so it can't be
     mistaken for another clickable option.

Static source checks — no Playwright needed, so this runs in the fast unit job on every PR.
"""
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).parents[2]


def load_strings_en():
    out = subprocess.check_output(
        ["node", "-e",
         "global.window={};require(process.argv[1]);"
         "console.log(JSON.stringify(window.STRINGS.en))",
         str(ROOT / "i18n.js")], text=True)
    return __import__("json").loads(out)


def main():
    failures = []
    strings_en = load_strings_en()

    # (1) the quiz's keyword field reads as exact-keyword, not free-text/NL.
    quiz_step2 = strings_en.get("quiz_step2", "")
    if "keyword" not in quiz_step2.lower():
        failures.append(
            f"quiz_step2 ({quiz_step2!r}) doesn't say \"keyword\" — it reads as an open "
            "invitation to type a sentence, same as the Ask box next to it"
        )

    index_src = (ROOT / "index.html").read_text(encoding="utf-8")

    # (2a) the parsed-filter summary has its own explicit status label + role, wired through
    # the shared nlTransHTML() helper (both nlTranslate() and nlTranslateLens() route through it).
    m = re.search(r"function nlTransHTML\([^)]*\)\s*\{([^}]*)\}", index_src, re.S)
    if not m:
        failures.append("nlTransHTML() helper not found — parsed-filter summary rendering changed")
    else:
        body = m.group(1)
        if 'role="status"' not in body:
            failures.append("nlTransHTML() output has no role=\"status\" — parsed-filter chips read as generic markup, not a status update")
        if "nl_understood_label" not in body:
            failures.append("nlTransHTML() doesn't render nl_understood_label — the chip row has no explanatory text of its own")

    for fn in ("nlTranslate", "nlTranslateLens"):
        fm = re.search(r"async function " + fn + r"\(.*?\n\}", index_src, re.S)
        if fm and "nlTransHTML(" not in fm.group(0):
            failures.append(f"{fn}() no longer routes its chips through nlTransHTML() — the status label/role could silently regress")

    # (2b) .qchip (the inert summary) must not look interactive; .trychip (the real clickable
    # sample queries) is the one allowed a pointer cursor and pill shape.
    style_block = re.search(r"<style>(.*?)</style>", index_src, re.S)
    css = style_block.group(1) if style_block else ""
    qchip_rule = re.search(r"\.qchip\{([^}]*)\}", css)
    if not qchip_rule:
        failures.append(".qchip CSS rule not found")
    elif "cursor:default" not in qchip_rule.group(1).replace(" ", ""):
        failures.append(".qchip has no explicit cursor:default — it can still read as clickable next to .trychip")
    trychip_rule = re.search(r"\.trychip\{([^}]*)\}", css)
    if qchip_rule and trychip_rule and "border-radius:999px" in trychip_rule.group(1).replace(" ", "") \
            and "border-radius:999px" in qchip_rule.group(1).replace(" ", ""):
        failures.append(".qchip shares .trychip's pill shape (border-radius:999px) — the two read as the same kind of control")

    if failures:
        print("nl_input_clarity gate FAILED:", file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        sys.exit(1)
    print("nl_input_clarity gate OK — quiz keyword field and Ask-box status summary are each unambiguous")


if __name__ == "__main__":
    main()
