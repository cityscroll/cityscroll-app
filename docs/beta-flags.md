# Lightweight beta flags

Public feature flags are for small UI experiments that are safe to include in
the stable bundle. They are not a release lane, authentication mechanism,
authorization check, secret, or way to hide unfinished sensitive behavior.

## Register a flag

Every entry in `beta-flags.json` is default-off and names:

- a lowercase slug;
- an accountable owner;
- its introduction and removal dates;
- every affected surface; and
- tests for both the on and off states.

The removal date must be no more than 90 days after introduction. CI fails once
that date passes. The change that removes a flag should remove its alternate
code path, registry entry, and tests together. Extending a trial is an explicit
registry change with a new removal date and review of both states.

## Use a flag

`?beta=<slug>` opts the current browser into a registered flag and stores that
choice locally. The visible banner identifies the experimental view and links
back with `?beta=0`, which clears the choice. Unknown and expired slugs fail
closed to the standard view.

Flag state can select presentation or behavior already safe for every public
visitor. Server routes must enforce their own authentication and authorization;
they must never trust a query parameter, local storage, `CROL_BETA_FLAG`, or the
document's `data-beta-flag` attribute.
