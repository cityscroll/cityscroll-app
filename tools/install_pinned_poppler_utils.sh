#!/usr/bin/env bash
# Installs the pinned poppler-utils package (pdftotext) used by first-class
# calendar extraction, tolerating a transient package-mirror DNS outage on
# GitHub-hosted runners. Retries apt with bounded backoff; if the default
# Azure mirror cannot be resolved, falls back to archive.ubuntu.com /
# security.ubuntu.com and retries again. Fails loudly if every attempt fails.
set -euo pipefail

. /etc/os-release
case "${VERSION_CODENAME:-}" in
  noble) pkg="poppler-utils=24.02.0-1ubuntu9.11" ;;
  jammy) pkg="poppler-utils=22.02.0-2ubuntu0.15" ;;
  *)
    echo "Unsupported runner suite '${VERSION_CODENAME:-unknown}' for pinned poppler-utils (expected noble or jammy)" >&2
    exit 1
    ;;
esac

retry() {
  local attempt
  for attempt in 1 2 3; do
    if "$@"; then
      return 0
    fi
    echo "Attempt $attempt/3 of '$*' failed" >&2
    sleep $((attempt * 5))
  done
  return 1
}

fall_back_to_default_mirrors() {
  echo "Default apt mirror unreachable; switching to archive.ubuntu.com / security.ubuntu.com" >&2
  local rewrite='s#https?://azure\.archive\.ubuntu\.com/ubuntu#http://archive.ubuntu.com/ubuntu#g; s#https?://azure\.security\.ubuntu\.com/ubuntu#http://security.ubuntu.com/ubuntu#g'
  local path
  for path in /etc/apt/apt-mirrors.txt /etc/apt/sources.list.d/ubuntu.sources /etc/apt/sources.list; do
    if [ -f "$path" ]; then
      sudo sed -E -i "$rewrite" "$path"
    fi
  done
}

update_log="$(mktemp)"
trap 'rm -f "$update_log"' EXIT

set +e
retry sudo apt-get update 2>&1 | tee "$update_log"
update_status="${PIPESTATUS[0]}"
set -e

if [ "$update_status" -ne 0 ]; then
  if grep -qiE 'azure\.(archive|security)\.ubuntu\.com|Temporary failure resolving' "$update_log"; then
    fall_back_to_default_mirrors
    if ! retry sudo apt-get update; then
      echo "apt-get update failed against both the default and archive.ubuntu.com mirrors" >&2
      exit 1
    fi
  else
    echo "apt-get update failed for a reason other than mirror DNS resolution" >&2
    exit 1
  fi
fi

if ! retry sudo apt-get install -y "$pkg"; then
  echo "apt-get install -y $pkg failed after retries" >&2
  exit 1
fi

command -v pdftotext >/dev/null
pdftotext -v
