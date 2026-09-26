# Drop Git's per-invocation bindings that a hook inherits from `git`.
#
# Git exports GIT_DIR, GIT_INDEX_FILE, and often GIT_WORK_TREE / GIT_PREFIX /
# GIT_OBJECT_DIRECTORY / GIT_COMMON_DIR / GIT_ALTERNATE_OBJECT_DIRECTORIES into
# every hook it runs. `pre-push` then launches the full preflight, so unit tests
# that shell out to `git -C <tmpdir> init/add/commit` would otherwise write into
# the ambient repository: the fixture's `add -A` + `commit` lands on the
# pusher's branch and truncates the tree to whatever the fixture contained.
#
# Source this file from any hook that runs the test suite, after the hook's own
# git reads finish and before it launches preflight or any other child that may
# spawn nested git. Per-suite `isolatedGitEnv()` defenses remain; this is the
# root guard so a new unguarded fixture cannot damage the pusher's tree.
#
# Keep the variable list aligned with `GIT_BINDINGS` in
# `tools/architecture_evidence_shards.mjs` (`isolatedGitEnv`).
unset GIT_DIR \
  GIT_WORK_TREE \
  GIT_INDEX_FILE \
  GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES \
  GIT_PREFIX \
  GIT_COMMON_DIR
