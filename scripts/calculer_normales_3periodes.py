# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""
Calcule 3 normales climatologiques horaires (une par période) à partir d'un
historique horaire consolidé (format DATE;TEMPERATURE, DATE=AAAAMMJJHH).

Pour chaque jour de l'année (1-365, le 29 février est fusionné avec le 28
février) et chaque heure (0-23), on calcule la température médiane sur une
fenêtre glissante de +/- N jours (toutes années de la période confondues).

Sortie JSON :
{
  "meta": {"station": "...", "fenetre_jours": 7, "periodes": {...}},
  "avant_2000":  { "1": [median_h0..h23], "2": [...], ... "365": [...] },
  "2000_2014":   { ... },
  "depuis_2015": { ... }
}
"""
import csv
import json
import statistics
import sys
from datetime import date
from collections import defaultdict

FENETRE = 7  # +/- jours

PERIODES = {
    "avant_2000": lambda y: y < 2000,
    "2000_2014": lambda y: 2000 <= y <= 2014,
    "depuis_2015": lambda y: y >= 2015,
}


def jour_de_l_annee(y, m, d):
    """Jour de l'année sur une base 365 jours (29 fév -> fusionné avec le 28)."""
    doy = date(y, m, d).timetuple().tm_yday
    is_bissextile = (y % 4 == 0 and (y % 100 != 0 or y % 400 == 0))
    if is_bissextile and doy >= 60:  # a partir du 1er mars en annee bissextile
        doy -= 1
    return doy  # 1..365


def charger_csv(path):
    """Retourne dict: annee -> jour_de_l_annee -> heure -> [temperatures]"""
    data = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))
    n_ok, n_bad = 0, 0
    with open(path, encoding="utf-8") as f:
        reader = csv.reader(f, delimiter=";")
        header = next(reader)
        for row in reader:
            if len(row) != 2:
                n_bad += 1
                continue
            d_str, t_str = row
            if len(d_str) != 10 or not d_str.isdigit():
                n_bad += 1
                continue
            y, m, day, h = int(d_str[0:4]), int(d_str[4:6]), int(d_str[6:8]), int(d_str[8:10])
            try:
                t = float(t_str.replace(",", "."))
            except ValueError:
                n_bad += 1
                continue
            try:
                doy = jour_de_l_annee(y, m, day)
            except ValueError:
                n_bad += 1
                continue
            data[y][doy][h].append(t)
            n_ok += 1
    print(f"Lignes lues valides: {n_ok}, ignorees: {n_bad}", file=sys.stderr)
    return data


def jours_fenetre(doy, fenetre):
    """Liste des jours de l'annee (1..365) dans la fenetre +/- fenetre autour de doy, avec wrap autour de l'annee."""
    jours = []
    for offset in range(-fenetre, fenetre + 1):
        j = doy + offset
        if j < 1:
            j += 365
        elif j > 365:
            j -= 365
        jours.append(j)
    return jours


def calculer_periode(data, filtre_annee, fenetre):
    """Calcule, pour chaque jour(1-365)/heure(0-23), la mediane sur la fenetre glissante."""
    annees = [y for y in data if filtre_annee(y)]
    resultat = {}
    for doy in range(1, 366):
        jours = jours_fenetre(doy, fenetre)
        par_heure = []
        for h in range(24):
            valeurs = []
            for y in annees:
                for j in jours:
                    valeurs.extend(data[y][j][h])
            if valeurs:
                par_heure.append(round(statistics.median(valeurs), 1))
            else:
                par_heure.append(None)
        resultat[str(doy)] = par_heure
    return resultat, len(annees)


def main():
    if len(sys.argv) < 3:
        print("Usage: uv run calculer_normales_3periodes.py entree.csv sortie.json [--fenetre N]", file=sys.stderr)
        sys.exit(1)
    entree = sys.argv[1]
    sortie = sys.argv[2]
    fenetre = FENETRE
    if "--fenetre" in sys.argv:
        fenetre = int(sys.argv[sys.argv.index("--fenetre") + 1])

    data = charger_csv(entree)

    resultat = {"meta": {"fenetre_jours": fenetre, "periodes": {}}}
    for cle, filtre in PERIODES.items():
        normales, n_annees = calculer_periode(data, filtre, fenetre)
        resultat[cle] = normales
        resultat["meta"]["periodes"][cle] = {"nb_annees": n_annees}
        print(f"{cle}: {n_annees} annees", file=sys.stderr)

    with open(sortie, "w", encoding="utf-8") as f:
        json.dump(resultat, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Ecrit: {sortie}", file=sys.stderr)


if __name__ == "__main__":
    main()
