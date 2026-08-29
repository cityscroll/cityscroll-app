# US-17 Committees worker lens evidence

Query: `Committee on Finance`.

## Before (production)

Live `api.cityscroll.org/search` reports Committees as not indexed and returns no typed Committee objects.

- Coverage state: `not_indexed`
- `indexed_count`: null
- Typed Committee results: 0

![Before coverage panel](backstage://cityscroll-evidence/objects/sha256/c4/c4a73a138d467bcb994cf77a29ec7f4cd125f961ff055487415ca1adf58b6eab.webp)

## After (this branch)

The worker indexes all 96 published Committee documents through the production collection provider seam.

- Coverage state: `matched` (`indexed` in the panel)
- `indexed_count`: 96
- Query returns `committee:11` → `/committees/11/`

![After coverage panel](backstage://cityscroll-evidence/objects/sha256/25/250bc904d67426c14f1b0fce8e7504b9e217a820f42dfb6013e091f46c6cb68c.webp)
