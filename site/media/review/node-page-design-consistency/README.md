# Node page design consistency — evidence

Headless captures at 390px and 1440px for the parcel and exam node documents.

## Root cause (parcel unstyled look)

Parcel / pack / digest pages used `civic-object-*` classes and loaded
`brand.css` + `civic-documents.css`, but **component rules only existed for
exam pages**. Action controls fell back to default browser buttons.

## Root cause (duplicate "Land projects")

`renderComposedObjectDocument` labeled sections with an incomplete ternary that
omitted `ll48`, so both `land` and `ll48` rendered as "Land projects". Fixed by
exporting and using `parcelSectionLabel` (one label per civic-process section).

## Changed regions (annotated on after/ frames)

- **hero** — shared node masthead title treatment
- **actions** — styled primary/secondary action buttons (Watch / Copy / Print / Download)
- **section card** — civic-process groups as card sections (parcel) / exam sections

## Files

- `before/` — pre-change captures
- `after/` — post-change captures with region labels
