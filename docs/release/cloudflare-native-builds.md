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
duplicate deployments. The beta preview and promotion lanes remain explicit
manual workflows because they publish selected review channels, not the
production release.

## GitHub Pages fallback decision

GitHub Pages remains intact and continues to be an active public fallback. The
site owner should explicitly choose whether to keep or retire it after the
Cloudflare-native path has a measured rollback history:

- Keep it for an independent static-origin fallback during Cloudflare incidents;
  the cost is a second public release surface and a freshness obligation.
- Retire it only after accepting the loss of that origin-level fallback and
  updating the cutover regression and DNS/incident documentation accordingly.

This change does not make that choice.
