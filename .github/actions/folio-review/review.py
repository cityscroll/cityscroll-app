"""Compare a repository's architecture folio with its cited evidence in Git."""
import json
import os
import re
import subprocess
from pathlib import Path
from urllib.parse import unquote, urlsplit

FOLIO = "ARCHITECTURE.md"
LINK = re.compile(r"\[[^\]\n]*\]\(([^()\s]+)\)")
CODE = re.compile(r"`([\w.][\w./-]*)`")


def git(*args):
    return subprocess.check_output(["git", *args]).decode("utf-8", "surrogateescape")


def local_link(url, repository):
    link = urlsplit(url)
    if link.scheme or link.netloc:
        prefix = f"/{repository}/blob/main/"
        if link.hostname != "github.com" or not link.path.startswith(prefix):
            return None
        path = link.path[len(prefix):]
    else:
        path = link.path.removeprefix("./")
    return unquote(path).rstrip("/") if path and not path.startswith("/") else None


def inventory(revision, repository, previous_paths=()):
    files = set(git("ls-tree", "-rz", "--name-only", revision).split("\0"))
    document = git("show", f"{revision}:{FOLIO}")
    if not document.strip():
        raise ValueError(f"{FOLIO} is empty")
    sections, evidence, broken = {}, {}, set()
    title = "Introduction"
    for line in document.splitlines():
        if line.startswith("## "):
            title = line[3:].strip()
        sections.setdefault(title, []).append(line.strip())
        for url in LINK.findall(line):
            path = local_link(url, repository)
            if not path or path == FOLIO:
                continue
            if path in files:
                evidence.setdefault(path, set()).add(title)
            elif not any(name.startswith(path + "/") for name in files):
                broken.add(path)
        for path in CODE.findall(line):
            if path in files and path != FOLIO:
                evidence.setdefault(path, set()).add(title)
            elif path in previous_paths:
                broken.add(path)
    return sections, evidence, broken


def review(event, repository):
    pr = event.get("pull_request")
    # Actions checks out the proposed merge. Its first parent is the exact
    # base, including any changes made since the contributor branched.
    head = "HEAD"
    base = "HEAD^1"
    old_sections, evidence, _ = inventory(base, repository) if pr else ({}, {}, set())
    sections, _, broken = inventory(head, repository, evidence)
    if broken:
        for path in sorted(broken):
            print(f"Missing folio evidence: {path!r}")
        return 1
    if not pr:
        return 0
    changed = git("diff", "--name-only", "--no-renames", "-z", base, head).split("\0")
    affected = {}
    for path in changed:
        for title in evidence.get(path, ()):
            if sections.get(title) == old_sections[title]:
                affected.setdefault(title, []).append(path)
    if not affected:
        return 0
    for title, paths in sorted(affected.items()):
        print(f"Review {title!r} for {', '.join(map(repr, paths))}")
    body = re.sub(r"<!--.*?-->", "", pr.get("body") or "", flags=re.S)
    if re.search(r"^Folio review:[ \t]+\S[^\n]*", body, re.I | re.M):
        print("The PR description records why the current decision still holds.")
        return 0
    print("Update each affected decision that changed in ARCHITECTURE.md. "
          "For passages that still hold, add a line to the PR description beginning "
          "with 'Folio review:' explaining why. Editing the description reruns this check.")
    return 1


if __name__ == "__main__":
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    raise SystemExit(review(event, os.environ["GITHUB_REPOSITORY"]))
