"""Shared English-word list for the stray-English gates (LL30/EO120 hardening).

Used by both the static lint (test/standards/stray_english.py) and the runtime guard
(test/functional/13_stray_english.py). A string "looks English" when, after data values,
approved translations, and allowlisted terms are stripped, any remaining whole word is in
this set.

Curation rules — every entry must be:
  * common in this app's UI chrome (or an English month/weekday name, which also catches
    hardcoded en-US date formatting leaking into a non-English locale), and
  * NOT a word in any of the ten LL30 languages as written in our translations —
    including their unaccented spellings (the es dictionary sometimes drops accents).
Excluded as ambiguous: no, a, me, general, personal, total, original, final, area, plan,
idea, normal, region, natural, editions, digital… (Spanish/French/Polish collisions).

Extending to a new language: check every entry against that language's dictionary before
activating its guard run; drop collisions here (the guard is conservative by design).
"""

ENGLISH_WORDS = frozenset("""
the of from and with this that these those your you for are was were has have had is not
all any new more most other another or by to at on in into over under near about them
they their what when who where how why which while
day days week weeks month months year years today tomorrow yesterday
open opened closed closes closing due left until since ago
published notice notices agencies award awards awarded contract contracts
search results found nothing loading fetching building pulling translating locating
view copy copied link add remove watch watching watched alert alerts digest
email subscribe unsubscribe subscription preview calendar map print share export
people person roles role salary median average range exam hearing hearings
meeting meetings rules property sale sales rezoning rezonings land money
city record click here please enter valid address keyword method contact pin call
respond response deadline still standing upcoming past proposed stages types
vehicles equipment seized unclaimed forest timber untitled unnamed project applicant
actions resolved connection needs showing lots confirm approximate checking demolition
permit lot career ladder top matching titles pay payroll gross paid overtime history
saved demo first latest everything anything something nothing broader word try pick
procurement linkable affordable housing status public soon largest next minimum
matches morning emailed prefer feeds needed edition
type look up down only also both each every per within without after before
january february march april may june july august september october november december
monday tuesday wednesday thursday friday saturday sunday
""".split())
