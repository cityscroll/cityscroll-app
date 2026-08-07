# Local developer targets. CI does not invoke this file.
.PHONY: prepush install-hooks hooks-help module-graph-digest

# Mirror of the required CI gates (reading-level always; browser gates when
# site/** is in the push range or PREPUSH_FULL=1). Same suite as the hook.
prepush:
	@args="--with-reading-level"; \
	if [ "$${PREPUSH_FULL:-0}" = "1" ]; then args="$$args --full"; fi; \
	if [ -n "$${PREPUSH_EXTRA_ARGS:-}" ]; then args="$$args $$PREPUSH_EXTRA_ARGS"; fi; \
	./tools/preflight-required-checks.sh $$args

# Point this clone's hooks at the versioned tools/git-hooks directory.
install-hooks:
	git config core.hooksPath tools/git-hooks
	@echo "hooksPath set to tools/git-hooks (pre-push will run make-equivalent preflight)."
	@echo "Bypass when needed: git push --no-verify"

hooks-help:
	@echo "Install once:  make install-hooks"
	@echo "Run gates:     make prepush (includes reading-level)"
	@echo "Full browser:  PREPUSH_FULL=1 make prepush"
	@echo "Bypass push:   git push --no-verify"

# Validate the live module graph and print its check-time fingerprint.
module-graph-digest:
	node tools/site_module_architecture.mjs --check
