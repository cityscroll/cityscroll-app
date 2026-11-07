"""Specimen selection for Land Map functional proofs, derived from the live render.

Which project is a multi-lot anchor, a single-lot exact point, or carries no marker at all
moves with every data refresh: the Default Land snapshot is a rotating 40-row window, not a
fixed set of ids. These helpers read the already-rendered Map/List DOM for a specimen that
satisfies the needed shape right now, rather than pinning an id a later refresh can quietly
invalidate. Call them after the page has reached the Land Map's ready state.
"""

from __future__ import annotations


def find_marker_by_method(page, method: str) -> str:
    """The first (by id, sorted) rendered marker using the given placement method."""
    ids = page.evaluate(
        """(method) => [...document.querySelectorAll('#land-map-panel .land-map-marker')]
          .filter((el) => el.dataset.landMapMethod === method)
          .map((el) => el.dataset.landMapProject)
          .sort()""",
        method,
    )
    assert ids, f"no rendered marker currently uses placement method {method!r}"
    return ids[0]


def find_unmapped_project_id(page) -> str:
    """The first (by id, sorted) List row the Map drew no marker for."""
    ids = page.evaluate(
        """() => {
          const mapped = new Set([...document.querySelectorAll(
            '#land-map-panel [data-land-map-project]')].map((el) => el.dataset.landMapProject));
          return [...document.querySelectorAll('#llist a[href*="#land/"]')]
            .map((a) => decodeURIComponent(a.getAttribute('href').split('#land/')[1] || ''))
            .filter((id) => id && !mapped.has(id))
            .sort();
        }"""
    )
    assert ids, "no List row currently lacks a marker"
    return ids[0]


def find_project_with_parcel_outline(page) -> str:
    """The first exact single-lot marker that, once selected, paints a parcel outline.

    Not every single_bbl_centroid project also carries a retained tax-lot shape, so this
    selects by clicking through live candidates (sorted) rather than assuming the method
    attribute alone guarantees one.
    """
    ids = page.evaluate(
        """() => [...document.querySelectorAll('#land-map-panel .land-map-marker')]
          .filter((el) => el.dataset.landMapPrecision === 'exact')
          .map((el) => el.dataset.landMapProject)
          .sort()"""
    )
    assert ids, "no rendered marker currently carries exact precision"
    for project_id in ids:
        page.locator(f'[data-land-map-project="{project_id}"][role="button"]').click()
        try:
            page.wait_for_selector(
                f'.land-map-parcel-outline[data-land-map-project="{project_id}"]', timeout=4_000)
            return project_id
        except Exception:
            continue
    raise AssertionError(f"none of the exact-precision specimens {ids} currently paint a parcel outline")


def find_unmapped_project_ids(page, count: int) -> list[str]:
    """The first `count` (by id, sorted) List rows the Map drew no marker for."""
    ids = page.evaluate(
        """() => {
          const mapped = new Set([...document.querySelectorAll(
            '#land-map-panel [data-land-map-project]')].map((el) => el.dataset.landMapProject));
          return [...document.querySelectorAll('#llist a[href*="#land/"]')]
            .map((a) => decodeURIComponent(a.getAttribute('href').split('#land/')[1] || ''))
            .filter((id) => id && !mapped.has(id))
            .sort();
        }"""
    )
    assert len(ids) >= count, f"needed {count} unmapped specimens, only {len(ids)} are currently unmapped"
    return ids[:count]
