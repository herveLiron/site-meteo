# site-meteo

Micro site météo personnel, destiné à être hébergé sur `meteo.rvliron.fr` (Cloudflare Pages).

## Contenu actuel

- `index.html` — page du graphique des normales de température horaires (station Météo-France de Saintes, id `17415003`). Fichier autonome : Chart.js est chargé depuis un CDN, les données JSON des normales sont intégrées directement dans le fichier.
- `data/normales_saintes_3periodes.json` — les mêmes données de normales, en fichier séparé (copie de référence / réutilisable pour d'autres pages).
- `scripts/calculer_normales_3periodes.py` — script Python (autonome, `uv run scripts/calculer_normales_3periodes.py entree.csv sortie.json`) qui calcule, à partir d'un historique horaire consolidé (`DATE;TEMPERATURE`), la normale (médiane) pour chaque jour de l'année et chaque heure, séparément pour 3 périodes : avant 2000, 2000-2014, depuis 2015.

## Comment les normales ont été calculées

Fenêtre glissante de ±7 jours autour de chaque jour de l'année, toutes années de la période confondues. Source des données brutes : API Météo-France Données Publiques Climatologie (DPClim v1). Le CSV historique brut (312 091 lignes, 1990-2025) n'est pas versionné dans ce dépôt (fichier de données brutes, pas du code) — le conserver à part si besoin de recalculer les normales ou d'étendre la période.

## Déploiement

Déployé sur Cloudflare Pages, connecté à ce dépôt GitHub (build : aucun, site 100% statique — répertoire de sortie = racine du dépôt).

## Prochaines étapes envisagées

- Superposer les mesures de la station météo personnelle (Ecowitt GW2000A, via Home Assistant) heure par heure sur le graphique des normales.
- Éventuellement intégrer une donnée Météo-France en direct (prévision/observation).
- Ajouter les scripts de collecte (`recuperer_historique.py`, `fusionner_historiques.py`) évoqués dans le projet précédent, s'ils sont récupérés.
- Second graphique : tendance long terme / réchauffement climatique visible dans les données.

Voir le document `brief-et-decisions.md` dans le projet Claude « Site météo » pour l'historique complet des décisions.
