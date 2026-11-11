#!/usr/bin/env bash
# Installs the pinned poppler-utils package (pdftotext) used by first-class
# calendar extraction, tolerating a transient package-mirror DNS outage on
# GitHub-hosted runners. apt-get update can exit 0 even when the default
# Azure mirror can't be resolved (it just warns and keeps whatever index it
# already has), so the real failure often only shows up later at install
# time. This checks both steps' output for the mirror-DNS failure signature
# and, if seen, rewrites apt's sources (including the mirror+file
# apt-mirrors.txt list) to archive.ubuntu.com / security.ubuntu.com before
# retrying. Fails loudly if every attempt is exhausted.
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

mirror_failure_pattern='azure\.(archive|security)\.ubuntu\.com|Temporary failure resolving'
mirror_fallback_applied=0

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
  if [ "$mirror_fallback_applied" -eq 1 ]; then
    return 0
  fi
  mirror_fallback_applied=1
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
install_log="$(mktemp)"
trap 'rm -f "$update_log" "$install_log"' EXIT

set +e
sudo apt-get update 2>&1 | tee "$update_log"
update_status="${PIPESTATUS[0]}"
set -e

if [ "$update_status" -ne 0 ] || grep -qiE "$mirror_failure_pattern" "$update_log"; then
  if grep -qiE "$mirror_failure_pattern" "$update_log"; then
    fall_back_to_default_mirrors
  fi
  if ! retry sudo apt-get update; then
    echo "apt-get update failed after retries" >&2
    exit 1
  fi
fi

set +e
sudo apt-get install -y "$pkg" 2>&1 | tee "$install_log"
install_status="${PIPESTATUS[0]}"
set -e

if [ "$install_status" -ne 0 ]; then
  if [ "$mirror_fallback_applied" -eq 0 ] && grep -qiE "$mirror_failure_pattern" "$install_log"; then
    fall_back_to_default_mirrors
    retry sudo apt-get update
  fi
  if ! retry sudo apt-get install -y "$pkg"; then
    echo "apt-get install -y $pkg failed after retries" >&2
    exit 1
  fi
fi

command -v pdftotext >/dev/null
pdftotext -v
