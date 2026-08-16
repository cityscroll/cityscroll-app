# ZAP project source records

`tools/retain_zap_project_source_records.mjs` retains the real committed
`hgx4-8ukb` ZAP project materialization as immutable, source-record-shaped
snapshots. The public Land and entity-intelligence read models remain unchanged;
the dual-write is a shadow replay input.

The publisher `project_id` is both the D1 `source_system_id` and the suffix of
the existing graph `source_record_id` (`zap-projects:<project_id>`). A row is
rejected unless it carries both that publisher id and a project name. Promoted
edges must retain source, method/version, confidence, and observation time.

```bash
node tools/retain_zap_project_source_records.mjs --check
node --test test/zap_project_source_records.test.mjs \
  worker/test/zap_project_source_records.test.mjs
```
