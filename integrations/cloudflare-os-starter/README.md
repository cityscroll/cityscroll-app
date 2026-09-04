# Cloudflare OS starter — upstream reference

`upstream-reference.json` records the upstream Cloudflare OS starter as it
actually exists: the repository, the revision on its default branch, the
submodule revision it pins, the packages it ships, the six Worker roles it
deploys, and the account prerequisites it names.

It is a reference document, not evidence. It carries no evidence class and
`provides_deployment_evidence` is `false`, because reading a public repository
proves nothing about whether anything has been deployed.

## Why it exists

The two sibling directories, `cloudflare-os-code-mode` and
`cloudflare-os-entity-research`, describe local rehearsals. Their manifests
name a Gatekeeper package (`packages/gatekeeper-mcp`) that the upstream starter
does not contain. Those rehearsals remain useful contract work — CS-09
reclassified them rather than deleting them — but their manifests are not a
description of the real starter, and a deployment must not be configured from
them.

This file is the corrective: the deployment repository pins from here, and
`capabilities/os_deployment_receipt.mjs` rejects any deployment receipt that
names the invented package path.

## Repository boundary

The deployment itself lives in a separate private repository along with its
configuration, Worker names, access configuration and the receipts a real
deploy produces. What this repository owns is the public half: the receipt
contract in `capabilities/os_deployment_receipt.mjs`, the tests in
`test/os_deployment_receipt.test.mjs`, and this reference.

Refresh this file when the deployment repository moves to a newer pin; the
contract tests assert it stays consistent with the contract's own constants.
