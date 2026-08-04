# Local developer targets. CI does not invoke this file.
.PHONY: prepush install-hooks hooks-help module-graph-digest

# Mirror of the required CI unit gates (and browser gates when site/** is in the
# push range or PREPUSH_FULL=1). Same suite as tools/git-hooks/pre-push.
prepush:
	@args=""; \
	if [ "$${PREPUSH_FULL:-0}" = "1" ]; then args="--full"; fi; \
	if [ -n "$${PREPUSH_EXTRA_ARGS:-}" ]; then args="$$args $$PREPUSH_EXTRA_ARGS"; fi; \
	# shellcheck disable=SC2086 \
	./tools/preflight-required-checks.sh $$args

# Point this clone's hooks at the versioned tools/git-hooks directory.
install-hooks:
	git config core.hooksPath tools/git-hooks
	@echo "hooksPath set to tools/git-hooks (pre-push will run make-equivalent preflight)."
	@echo "Bypass when needed: git push --no-verify"

hooks-help:
	@echo "Install once:  make install-hooks"
	@echo "Run gates:     make prepush"
	@echo "Full browser:  PREPUSH_FULL=1 make prepush"
	@echo "Bypass push:   git push --no-verify"

# Validate the live module graph and print its check-time fingerprint.
module-graph-digest:
	node tools/site_module_architecture.mjs --check
