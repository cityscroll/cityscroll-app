# Cloudflare release builds

GitHub Actions is the canonical release control plane for the production Pages
site: every push to `main` builds the provider-neutral `_site` artifact and
deploys it to the `cityscroll` Cloudflare Pages project. Cloudflare's native Git
integration is optional and production freshness does not depend on it. Workers
Builds remains the canonical release path for the Worker. The machine-readable settings in
[`cloudflare-native-builds.json`](./cloudflare-native-builds.json) are the
repository contract for the corresponding Cloudflare dashboard integrations.

## Activation checklist

The repository must retain the `CLOUDFLARE_API_TOKEN` Actions secret. The
`Deploy Cloudflare Pages` workflow resolves its single authorized account,
builds `_site`, deploys branch `main`, and smokes the immutable deployment before
checking route parity. The manual trigger is a recovery path for redeploying a
selected `main` revision; it is not required for normal merges.

The site owner must connect the repository to the existing `crol-worker` Worker
through Workers Builds, set its root directory to `worker`, and configure the
production and preview commands from the JSON contract. The Worker build token
authorizes deployment; `LEGISTAR_API_TOKEN` remains a separately managed
Cloudflare secret and is never written by the build.

Before enabling the Worker production integration, run one preview build and
compare its version with the current public release. Then enable the production
branch and observe one release end to end. Cloudflare's build history is the
Worker release receipt; GitHub Actions plus the post-deploy smoke are the Pages
release receipt.

The Cloudflare Pages workflow runs on pushes to `main`. If the native Pages Git
integration is also connected, disable its production-branch builds to avoid
duplicate deployments.

## Legacy hosting retirement

The independent GitHub Pages copy is retired. Cloudflare Pages is the production
static origin and the Worker keeps its existing two-tier failover: the stamped
`cityscroll.pages.dev` artifact covers the full site, while the raw repository is
used only for `/docs/*` and `/README.md`. The raw-repository tier is not a full-site
disaster-recovery substitute because it can contain unsubstituted build tokens.
