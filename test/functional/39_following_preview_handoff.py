"""Following preview handoff: notice-scoped create flow and unrecognized scope."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def render(query: str, preview_items: list[dict], match_count: int | None) -> str:
    script = f"""
import {{ buildFollowingViewModel, renderFollowingDocument, watchFromFollowingParams }} from "./site/following_view.mjs";
const parsed = watchFromFollowingParams(new URLSearchParams({json.dumps(query)}));
const view = buildFollowingViewModel({{
  ...parsed,
  matchCount: {json.dumps(match_count)},
  previewItems: {json.dumps(preview_items)},
}});
process.stdout.write(renderFollowingDocument(view));
"""
    return subprocess.check_output(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT,
        text=True,
    )


def main() -> int:
    positive = render(
        "lens=meetings&filter=%7B%22agency%22%3A%22Transportation%22%7D&notice=20260716009&from=%2Fnotices%2F20260716009%2F",
        [
            {
                "id": "20260716009",
                "title": "Dining Out NYC Public Hearing",
                "url": "/notices/20260716009/",
                "summary": "Transportation",
            }
        ],
        1,
    )
    empty = render("lens=not-a-lens&filter=%7B%7D", [], None)

    checks = [
        ("positive has canonical Following title", "<h1>Following</h1>" in positive),
        ("positive keeps notice focus", 'data-focus-id="20260716009"' in positive),
        ("positive keeps origin", 'name="from" value="/notices/20260716009/"' in positive),
        ("positive keeps one save action", 'data-following-subscribe-form' in positive and positive.count("Create watch") == 1),
        ("positive keeps reviewed meetings lens", 'name="lens" value="meetings"' in positive),
        ("unrecognized stays honest", 'data-following-handoff-status="unrecognized_scope"' in empty),
        ("unrecognized does not save a Contracts watch", 'data-following-subscribe-form' not in empty),
        ("unrecognized does not remap to money", 'name="lens" value="money"' not in empty),
    ]
    failed = False
    for name, ok in checks:
        print(("OK" if ok else "FAIL"), name, flush=True)
        failed = failed or not ok
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
