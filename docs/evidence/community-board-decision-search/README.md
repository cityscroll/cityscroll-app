# Community board decision search

Admitted board decisions are searchable objects. A query for an address, docket,
or topic returns a named decision whose ordinary link opens that decision's
stable destination.

Regenerate with:

```sh
node tools/build_keyword_search_index.mjs
python3 tools/capture_community_board_decision_search.py
```

Images remain under `.artifacts/community-board-decision-search/` and are not
committed. The receipt is this manifest.
