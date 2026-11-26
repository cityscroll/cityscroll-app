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
    # Sparse checkouts can lazily fetch an older folio blob. Use the read-only
    # workflow credential for that fetch without persisting it in the checkout.
    return subprocess.check_output(
        ["git", "-c", "credential.helper=!gh auth git-credential", *args]
    ).decode("utf-8", "surrogateescape")


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


def merged_review(repository, revision):
    # Several PRs can contain a commit. Only its merged PR on this branch
    # carries the disposition for this exact change.
    payload = subprocess.check_output(
        ["gh", "api", f"repos/{repository}/commits/{revision}/pulls"],
        text=True,
    )
    for pr in json.loads(payload):
        if (pr["merged_at"] and pr["merge_commit_sha"] == revision
                and pr["base"]["ref"] == "main"):
            return pr.get("body") or ""
    return ""


def review(event, repository):
    pr = event.get("pull_request")
    # Actions checks out the proposed merge. Its first parent is the exact
    # base, including any changes made since the contributor branched.
    head = "HEAD"
    push = event.get("before")
    base = "HEAD^1" if pr else push
    if push and not push.strip("0"):
        base = None
    elif push and subprocess.run(["git", "cat-file", "-e", f"{push}^{{commit}}"],
                                 capture_output=True).returncode:
        # A multi-commit push can put the previous tip outside the shallow clone.
        git("fetch", "--quiet", "--filter=blob:none", "--depth=1", "origin", push)
    old_sections, evidence, _ = inventory(base, repository) if base else ({}, {}, set())
    sections, _, broken = inventory(head, repository, evidence)
    if broken:
        for path in sorted(broken):
            print(f"Missing folio evidence: {path!r}")
        return 1
    if not base:
        return 0
    changed = git("diff", "--name-only", "--no-renames", "-z", base, head).split("\0")
    affected = {}
    for path in changed:
        for title in evidence.get(path, ()):
            if sections.get(title) == old_sections[title]:
                affected.setdefault(title, []).append(path)
    # New persistence boundaries can arrive before any passage cites the file.
    # Both repositories keep SQL migrations in a migrations directory and use
    # the same C4 model path.
    boundaries = sorted(path for path in changed
                        if path == "architecture/workspace.dsl"
                        or ("migrations" in Path(path).parts[:-1] and path.endswith(".sql")))
    if not affected and (not boundaries or FOLIO in changed):
        return 0
    if boundaries and FOLIO not in changed:
        print("Review the folio for a new or changed system boundary: "
              + ", ".join(map(repr, boundaries)))
    for title, paths in sorted(affected.items()):
        print(f"Review {title!r} for {', '.join(map(repr, paths))}")
    body = (pr.get("body") or "") if pr else ""
    if push and push == git("rev-parse", "HEAD^1").strip():
        body = merged_review(repository, git("rev-parse", head).strip())
    body = re.sub(r"<!--.*?-->", "", body, flags=re.S)
    if re.search(r"^Folio review:[ \t]+\S[^\n]*", body, re.I | re.M):
        print("The PR description records why the current decision still holds.")
        return 0
    if not pr:
        print("The merged change touched evidence for these passages without a recorded "
              "folio review. Reconcile the affected decisions against main.")
        return 1
    print("Update each affected decision that changed in ARCHITECTURE.md. "
          "For passages that still hold, add a line to the PR description beginning "
          "with 'Folio review:' explaining why. Editing the description reruns this check.")
    return 1


if __name__ == "__main__":
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    raise SystemExit(review(event, os.environ["GITHUB_REPOSITORY"]))
