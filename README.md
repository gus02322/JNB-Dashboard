# ANGA

Live catering operations, on one screen.

Tableau de bord d'opérations catering aérien : timeline du jour (ETA, Sealing & Loading, Truck Departure, ETD), vue par compagnie, slots Box Time, semaine, alertes. Site statique servi par GitHub Pages, sans serveur ni base de données.

## Fichiers

| Fichier | Rôle |
| --- | --- |
| `index.html` | Interface (HTML, CSS, JS). |
| `config.js` | Configuration centrale : nom du produit, accroche, contact, URL, Sheet et gid des onglets, feature flags. |
| `js/data-source.js` | Seul module qui sait d'où viennent les données (lecture, rafraîchissement, écriture plus tard). |
| `data/local-data.example.json` | Exemple fictif du fichier de secours. |
| `data/local-data.json` | Fichier de secours réel. **Non versionné** (voir `.gitignore`). |
| `assets/`, `manifest.webmanifest` | Favicon, icônes, manifest d'application web. |
| `tests/` | Tests du module de données (`node --test tests/*.test.mjs`, aucune dépendance). |

## Données : le Google Sheet

Le Sheet est la seule source de vérité, configuration comprise. Il est publié en CSV : **tout ce qu'il contient est lisible publiquement. N'y mettez jamais de secret** (mot de passe, hash, clé).

Onglets (ligne 1 = en-têtes) :

| Onglet | Colonnes |
| --- | --- |
| principal (premier onglet) | `SI, Airline, H/W, Flight, ETA, ETD, Sealing, Truck Dep, Days`, puis `FLIGHT_OUT` en option, en dernière position (callsign de départ, vide = même que Flight). Les lignes de données commencent par un numéro (SI). `Days` : chiffres 1 (lundi) à 7 (dimanche), `daily` ou `1234567`, `0` = ne vole pas. |
| `Airlines` | `NAME, COLOR, IATA, ICAO` |
| `Config` | `KEY, VALUE, DESCRIPTION` |
| `BoxTime` | `SI, FLIGHT, DAY` (`D-1` ou `D`), `OVERRIDE` (HH:MM) |
| `Audit` (phase 4) | `TIMESTAMP, USER, KEY, OLD, NEW` |

Brancher un onglet :

1. Fichier > Partager > Publier sur le Web, publier le document entier (ou chaque onglet) au format CSV.
2. Ouvrir l'onglet : le `gid` est le nombre après `#gid=` dans l'adresse.
3. Le reporter dans `SHEET_GIDS` de `config.js`.

Ordre de lecture pour chaque onglet : Sheet, puis dernière lecture réussie gardée dans le navigateur, puis `data/local-data.json` s'il existe, sinon vide. Sur GitHub Pages, le fichier local n'est pas publié (il n'est pas versionné) : en production, le secours est la dernière lecture réussie de chaque écran. Le détail de la source utilisée par onglet s'affiche au survol de l'indicateur de synchronisation.

## Lancer en local

```sh
python3 -m http.server 8000
# puis ouvrir http://localhost:8000
```

L'ouverture directe du fichier (`file://`) ne permet pas de lire le Sheet.

## Feature flags

Définis dans `FLAGS` (`config.js`), tous désactivés en production tant qu'ils ne sont pas validés. Pour tester sur un seul écran : ajouter `?ff=NOM1,NOM2` à l'adresse (mémorisé sur cet appareil), `?ff=none` pour revenir à la normale.

## Déploiement

GitHub Pages publie la branche `main`. Tout merge sur `main` part en production : une branche et une pull request par évolution, merge uniquement après validation.

## Contact

À compléter : `CONTACT_EMAIL` et `SITE_URL` dans `config.js` sont encore des placeholders.
