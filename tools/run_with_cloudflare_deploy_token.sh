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

# When a caller has explicitly entered the deployment path, require the same
# current-writer assertion used by the workflow before passing credentials on.
# Plain local read-only commands remain unaffected.
if [[ "${WORKER_DEPLOY_FENCE_REQUIRED:-false}" == "true" ]]; then
  node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/worker_deploy_fence.mjs" assert
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
