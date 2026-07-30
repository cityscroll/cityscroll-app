# Standards dashboard — dated snapshots

`compliance-snapshots.json` feeds the timeline on `standards.html`. It exists to make one
thing visible over time: how the site's language switcher and accessibility posture compare
to standards New York City and New York State have actually published, as those standards
move.

## How the file is used by the page

The two live sections at the top of `standards.html` (the language-switcher join and the
accessibility milestones) always compute their numbers fresh, from `i18n.js`'s own
`SHIPPING_LANGS`/`LANG_META`/`I18N_PROVENANCE` — they are never read from this file. This
file only backs the timeline underneath: each entry is a frozen copy of what those live
numbers were on a given date, plus the accessibility standard that was published as of
that date.

## How to add a new entry

Append an object to the `snapshots` array — never edit an existing entry's values. A new
entry belongs here when either side of the join changes:

- **The published standard moves** (a new WCAG deadline, a change to the designated
  citywide-language list).
- **The site's own posture changes** (a language added to or dropped from the switcher, a
  language's translation moving from `machine-drafted` to `native-reviewed` in
  `i18n.js`'s `I18N_PROVENANCE`).

Fields: `date` (ISO, the day the entry was recorded), `languages.standard_count` (how many
languages the published list names), `languages.matched_count` (how many of those are in
the site's switcher that day), `languages.source` (the law or policy naming the list),
`accessibility.city_current_standard`, `accessibility.next_published_standard` +
`next_published_effective` + `next_published_source`.
