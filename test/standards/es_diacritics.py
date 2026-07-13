#!/usr/bin/env python3
"""Spanish diacritics gate — accent-less forms of common Spanish words fail the build.

Born from the 2026-07-13 hotfix-2 finding: "Mi investigacion", "Codigo postal", "ULTIMA
EDICION" and ~40 other accent-less strings shipped since wave-6 phase 2 because nothing
checked orthography. This gate scans STRINGS.es and SECTION_I18N.es in i18n.js (and the
worker's EMAIL_STRINGS.es) for a curated map of words that ALWAYS carry an accent in the
form we use them; any bare form fails.

Curation rules: only include words whose accent-less spelling is not itself a valid word
we might legitimately write (so no "esta/está", no "aun/aún", no "si/sí" — those need
human context). Extend the map as reviewers catch new misses; each entry makes that miss
unregressable.
"""
import json
import re
import subprocess
import sys
import pathlib

ROOT = pathlib.Path(__file__).parents[2]

# wrong (accent-less) -> right. Checked case-insensitively on word boundaries.
DIACRITICS = {
    "investigacion": "investigación", "informacion": "información", "direccion": "dirección",
    "codigo": "código", "ultima": "última", "ultimo": "último", "edicion": "edición",
    "proximos": "próximos", "proxima": "próxima", "revision": "revisión",
    "busqueda": "búsqueda", "titulo": "título", "titulos": "títulos", "ningun": "ningún",
    "dias": "días", "ingles": "inglés", "numero": "número", "telefono": "teléfono",
    "categoria": "categoría", "traduccion": "traducción", "electrica": "eléctrica",
    "electrico": "eléctrico", "paramedico": "paramédico", "construccion": "construcción",
    "rapido": "rápido", "facil": "fácil", "estadisticas": "estadísticas",
    "nomina": "nómina", "adjudicacion": "adjudicación", "zonificacion": "zonificación",
    "rezonificacion": "rezonificación", "tambien": "también", "aqui": "aquí",
    "encontro": "encontró", "instantanea": "instantánea", "cronologia": "cronología",
    "expiracion": "expiración", "suscripcion": "suscripción", "confirmacion": "confirmación",
}

WORD_RE = re.compile(r"[A-Za-zÀ-ÿ]+")


def check_dict(name, d, failures):
    for key, val in d.items():
        if not isinstance(val, str):
            continue
        for w in WORD_RE.findall(val):
            if w.lower() in DIACRITICS:
                failures.append(f"{name}.{key}: {w!r} → should be {DIACRITICS[w.lower()]!r}")


def main():
    failures = []
    site = json.loads(subprocess.check_output(
        ["node", "-e",
         "global.window={};require(process.argv[1]);"
         "console.log(JSON.stringify({s:window.STRINGS.es,sec:window.SECTION_I18N&&window.SECTION_I18N.es||{}}))",
         str(ROOT / "i18n.js")], text=True))
    check_dict("STRINGS.es", site["s"], failures)
    check_dict("SECTION_I18N.es", site["sec"], failures)

    worker_i18n = ROOT / "worker" / "src" / "lib" / "i18n.mjs"
    if worker_i18n.exists():
        worker = json.loads(subprocess.check_output(
            ["node", "--input-type=module", "-e",
             f"import {{ EMAIL_STRINGS }} from '{worker_i18n.as_posix()}';"
             "console.log(JSON.stringify(EMAIL_STRINGS.es||{}))"], text=True))
        check_dict("EMAIL_STRINGS.es", worker, failures)

    if failures:
        print("es diacritics gate FAILED — accent-less Spanish:", file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        sys.exit(1)
    print(f"es diacritics OK — {len(DIACRITICS)} pinned words, 0 accent-less forms")


if __name__ == "__main__":
    main()
