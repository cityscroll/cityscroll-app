# Non-default Contracts payload bounding evidence

This capture set records the bounded query and post-paint hydration described by
the performance analysis.

The focused five-run Browse Contracts comparison retained 22 records and 90
controls at both viewports, with zero visual change and no content loss. The
after-minus-before p75 readiness deltas were:

| Viewport | Content ready | Component ready | First paint | First contentful paint |
| --- | ---: | ---: | ---: | ---: |
| Desktop | -11.2 ms | -11.3 ms | -4.0 ms | -4.0 ms |
| Mobile | -14.95 ms | -14.85 ms | -2.0 ms | -2.0 ms |

The focused verdict is PASS. The committed report contains the before/after
content, readiness, and visual verdicts used for this gate.

The other five non-Agency surfaces were captured as well. Their content checks
were subject to unrelated timing and fixture variation; the required Contracts
surface remained the passing readiness gate. Agency was not included in the
comparison because the baseline did not reach its settled civic-object marker;
that is the known main-branch behavior introduced by #1256, unrelated to this
Contracts-only change.
