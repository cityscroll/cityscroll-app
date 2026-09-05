# Machine-client profiles for the tool endpoint

`POST /mcp` accepts three kinds of caller. This page is the operator contract for the third.

| Caller | Credential | Inventory | Quota key |
| --- | --- | --- | --- |
| Anonymous | none | full | connecting address |
| Endpoint-wide bearer | `MCP_BEARER_TOKEN` | full | connecting address |
| Named profile | a profile secret binding | the profile's allowlist | the profile id |

The first two are unchanged. Adding a profile does not alter them, and a deployment with no
profile secret configured behaves exactly as it did before profiles existed.

`capabilities/machine_client_profile.mjs` owns the declarations, the resolution rules, and the
validation. `test/machine_client_profile.test.mjs` is the contract test.

## What a profile is

A profile is a named integration identity with three parts:

- a **stable id** (`public-research-read`), used as the quota meter key and the telemetry label;
- an **exact allowlist** of registered public-read capability tools;
- one or more **deployment-secret binding names** whose values authenticate the profile.

The allowlist is written out as a literal list rather than derived from the capability registry
at runtime. A grant that recomputes itself silently widens on the day a new public read is
registered; the literal list means adding a capability to a profile is a deliberate edit.
`validateMachineClientProfiles()` then re-derives every claim against the registry, so the
literal and the registry cannot drift apart unnoticed in either direction.

## Why discovery is filtered, not just calls

A tool an integration can see is a tool it will eventually try. Filtering `tools/list` by the
authenticated profile is what keeps the grant honest about its own shape; rejecting only at call
time would advertise authority the integration does not have.

For the same reason an ungranted call is refused with the ordinary unknown-tool error rather than
a distinct "not granted" message. A distinguishable refusal is a discovery oracle: it would let a
caller enumerate the withheld inventory one name at a time, which is exactly the leak the
filtered listing exists to close. The distinction is preserved internally in telemetry's
`error_class`, which is not returned to the caller.

## What a profile may never carry

Profiles grant registered public-read capabilities only. The negative rule excludes watch
preview, watch creation, future mutations, administrative routes, raw source or store access,
subscription authority, and email authority.

This is enforced against the capability registry, not merely documented. A tool joins a profile
only if the registry says it has `operationClass: read`, `authorityClass: public_read`,
`storeAccess: provider-only`, and a registered capability reference. Authenticating as a profile
grants no database, key-value, object-store, subscription, or email authority.

## Quota

An authenticated profile meters on its own stable id under the `mcpclient` meter; anonymous
callers keep the `mcpip` per-address meter. The two namespaces are separate, so a profile and an
anonymous caller sharing one address do not share a bucket.

This is the point of the profile identity: a gateway that collapses many users onto one address
used to exhaust a single shared address bucket, making those users each other's noisy
neighbours. Metering by integration instead moves the ceiling to the party that actually holds
the grant.

Actor identifiers are hashed before they become KV keys (`worker/src/lib/meter.mjs`), so neither
a profile id nor an address appears directly in a key name.

## Credentials

Profiles name secret **bindings**; they never contain secret values. Set a value with:

```
wrangler secret put MCP_CLIENT_PUBLIC_RESEARCH_TOKEN
```

Nothing in this repository holds the value: not the profile declaration, not the telemetry
record, not the receipt projection (`describeMachineClientProfile()`), and not the generated
integration client under `integrations/generated-client/`, which is handed to third parties and
must not even name the binding. A compromised generated component therefore cannot recover the
credential held by the gateway that calls the endpoint.

Presented credentials are compared by digest, so a timing observer learns nothing about a
secret's length or matching prefix.

### Rotation

Each profile accepts a current and a previous binding:

```
MCP_CLIENT_PUBLIC_RESEARCH_TOKEN            # current
MCP_CLIENT_PUBLIC_RESEARCH_TOKEN_PREVIOUS   # accepted during a rotation window
```

To rotate: put the new value in the current binding, move the old value to the previous binding,
let live integrations move over, then unset the previous binding. An unset binding never
matches, so unsetting is the revocation.

Rotation and revocation change **which credential authenticates**. They never change the profile
id, its allowlist, or its meter key, so capability semantics survive a rotation untouched.

A credential that is presented but matches nothing fails closed with `401` whenever any profile
secret is configured. It does not fall back to anonymous access — otherwise revoking a profile
token would quietly downgrade an integration to the unfiltered anonymous inventory instead of
locking it out.

## Telemetry

Profile telemetry is emitted only when the deployment provides a
`MACHINE_CLIENT_TELEMETRY.write` sink. One record carries exactly six fields:

`profile_id`, `capability_reference`, `availability`, `duration_ms`, `count`, `error_class`.

The key set is closed by the builder. There is no field for request arguments, response bodies,
prompt text, resident query strings, entity names, addresses, or credentials, and unknown inputs
are dropped rather than passed through — a caller cannot widen a record by handing it more.
`error_class` is a small closed enumeration, so an exception message can never arrive as free
text. Telemetry failures are swallowed: measurement must never break the call being measured.
