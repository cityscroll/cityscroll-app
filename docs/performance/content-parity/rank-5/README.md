# Agency and Near You payload deferral evidence

This capture set records the payload deferral described by the performance analysis.

The focused Agency and Near You comparison waited for each surface's settled deferred
state. Both surfaces passed content parity at desktop and mobile, with the following
after-minus-before p75 readiness deltas in milliseconds:

| Surface | Desktop content | Desktop component | Mobile content | Mobile component |
| --- | ---: | ---: | ---: | ---: |
| Agency | -4.2 | -3.9 | -14.2 | -13.55 |
| Near You | -0.05 | -0.35 | -12.9 | -14.1 |

Agency retained 51 records and 94 controls at both viewports. Near You retained 522
records, 948 desktop controls, and 936 mobile controls. Visual parity passed for all
four focused captures.

The full six-surface capture retained content parity for Home, Near You, Following,
Browse Contracts, Notice, and Agency at both viewports. The `full-six` directory
contains those mobile and desktop captures; the `focused-pass` directory contains the
settled Agency/Near You verdict and captures used for the readiness gate.
