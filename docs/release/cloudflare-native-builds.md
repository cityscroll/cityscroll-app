# Cloudflare-native release builds

Cloudflare is the canonical release control plane for the production Pages site
and Worker. The machine-readable settings in
[`cloudflare-native-builds.json`](./cloudflare-native-builds.json) are the
repository contract for the corresponding Cloudflare dashboard integrations.

## Activation checklist

The site owner must connect the `cityscroll/crol-list` repository to the existing
`cityscroll` Pages project through Pages Git integration and set the Pages fields
from the JSON contract. Enable preview deployments and keep `main` as the
production branch.

The site owner must connect the repository to the existing `crol-worker` Worker
through Workers Builds, set its root directory to `worker`, and configure the
production and preview commands from the JSON contract. The Worker build token
authorizes deployment; `LEGISTAR_API_TOKEN` remains a separately managed
Cloudflare secret and is never written by the build.

Before enabling either production integration, run one preview build and compare
its artifact or Worker version with the current public release. Then enable the
production branch and observe one release end to end. Cloudflare’s build history
and the public smoke commands are the release receipt.

The old Cloudflare deploy workflows remain manual, non-required fallback paths
while the native builds are observed. They do not run on pushes and therefore
cannot race the canonical Cloudflare build. The beta preview and promotion lanes
remain explicit manual workflows because they publish selected review channels,
not the production release.

## GitHub Pages fallback decision

GitHub Pages remains intact and continues to be an active public fallback. The
site owner should explicitly choose whether to keep or retire it after the
Cloudflare-native path has a measured rollback history:

- Keep it for an independent static-origin fallback during Cloudflare incidents;
  the cost is a second public release surface and a freshness obligation.
- Retire it only after accepting the loss of that origin-level fallback and
  updating the cutover regression and DNS/incident documentation accordingly.

This change does not make that choice.
