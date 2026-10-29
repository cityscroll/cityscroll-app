#!/usr/bin/env bash
# Secret-transport wrapper for Cloudflare Worker deploy/mutator children.
#
# Use as the launcher payload so the admission line never contains the token:
#   <launcher> -- ./tools/run_with_cloudflare_deploy_token.sh -- \
#     npx wrangler@4.126.0 versions deploy ...
#
# Reads the mode-0600 key file INSIDE this process, exports CLOUDFLARE_API_TOKEN
# for the child only, then execs. Never puts the token on argv. Never prints it.
set -euo pipefail

refuse_token_on_argv() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      CLOUDFLARE_API_TOKEN=*|*CLOUDFLARE_API_TOKEN=*)
        printf '%s\n' "run_with_cloudflare_deploy_token: refusing token assignment on argv" >&2
        exit 2
        ;;
      cfut_*|*=cfut_*)
        printf '%s\n' "run_with_cloudflare_deploy_token: refusing token-shaped argv element" >&2
        exit 2
        ;;
    esac
  done
}

refuse_token_on_argv "$@"

if [[ "${1:-}" == "--" ]]; then
  shift
fi

if [[ "$#" -lt 1 ]]; then
  printf '%s\n' "usage: run_with_cloudflare_deploy_token.sh -- <command> [args...]" >&2
  exit 2
fi

# Only these concrete, token-bearing read-only invocations are exempt. The
# argv shape is intentionally narrow: shell indirection, unknown subcommands,
# and any extra flag all require the same fence as a writer.
is_exact_read_only_command() {
  [[ "${1:-}" == "npx" ]] || return 1
  shift
  if [[ "${1:-}" == "--yes" ]]; then shift; fi
  [[ "${1:-}" == "wrangler@4.126.0" ]] || return 1
  shift
  case "$#:$*" in
    "1:--help"|"1:help"|"1:--version") return 0 ;;
    "3:versions list --json"|"4:versions list --name cityscroll-worker" ) return 0 ;;
    "5:versions list --name cityscroll-worker --json"|"5:versions list --json --name cityscroll-worker") return 0 ;;
    *) return 1 ;;
  esac
}

# Credentialed commands require a last-moment writer-fence assertion by
# default. Only the exact structured read-only modes above may omit it.
if ! is_exact_read_only_command "$@"; then
  if [[ "${WORKER_DEPLOY_FENCE_LIVE_ASSERT:-}" == "true" ]]; then
    node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/worker_deploy_fence.mjs" live-assert
  elif [[ "${WORKER_DEPLOY_FENCE_REQUIRED:-}" == "true" ]]; then
    node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/worker_deploy_fence.mjs" assert
  else
    printf '%s\n' "run_with_cloudflare_deploy_token: WORKER_DEPLOY_FENCE_REQUIRED=true is required for credentialed commands" >&2
    exit 2
  fi
fi

TOKEN_FILE="${CLOUDFLARE_API_TOKEN_FILE:-${HOME}/.config/estate/cloudflare-workers-deploy-cityscroll.key}"
if [[ ! -f "$TOKEN_FILE" ]]; then
  printf '%s\n' "run_with_cloudflare_deploy_token: missing token file" >&2
  exit 2
fi

# Read inside this process only. Do not echo, log, or pass on argv.
CLOUDFLARE_API_TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE")"
if [[ -z "$CLOUDFLARE_API_TOKEN" ]]; then
  printf '%s\n' "run_with_cloudflare_deploy_token: empty token file" >&2
  exit 2
fi
export CLOUDFLARE_API_TOKEN
unset CLOUDFLARE_API_TOKEN_FILE

exec "$@"
