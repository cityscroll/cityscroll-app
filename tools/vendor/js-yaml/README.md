# Vendored js-yaml 4.1.1

Pinned copy of https://www.npmjs.com/package/js-yaml (`dist/js-yaml.mjs`) so
site-node / local preflight can YAML-parse `.github/workflows` without an npm
install (the unit-family site-node job does not run `pnpm install`).

Do not edit the `.mjs` by hand; refresh by re-copying the published dist.
