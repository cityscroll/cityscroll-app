# Digest time ontology

Digest matching uses three distinct time dimensions and a separate delivery identity.
Conflating these clocks causes late enrichments to be missed or publisher retries to be
sent twice.

| Dimension | Meaning | Digest use |
|---|---|---|
| Event time | When the civic event occurs, such as a hearing or comment deadline. | Determines whether an action is still open and supplies the reader-facing date. It does not determine whether an update is new. |
| Publication time | When City Record, NYC Rules, or Legistar published the source assertion. | Provenance and ordering evidence only. A publisher may revise this timestamp. |
| Recorded time | When CityScroll fetched or materialized the assertion. | Operational freshness and audit evidence only. A later processing run is not itself a new reader event. |
| Delivery identity | Stable source identity plus actionable semantic state. | The idempotency key stored in the watch's `seen:` set after a successful send. |

This is **idempotent reconciliation**, not a timestamp watermark. Every digest run
reconciles the current source state against successfully delivered semantic keys.
For an open NYC Rules comment period, the key is the City Record request id plus
`comment-open` and its deadline. Therefore:

- an RSS item first observed after its City Record notice was delivered still produces one
  actionable update;
- a republished RSS item with changed publication or recorded timestamps does not resend
  the same update; and
- a genuinely changed actionable state or deadline receives a new key.

The same contract applies to late Legistar agenda, vote, and outcome enrichment: event,
publication, and recorded timestamps remain evidence; source record plus semantic state is
the delivery identity. Seen state advances only after the email provider accepts the send.

Characterization: `node --test worker/test/alert_temporal.test.mjs`.
