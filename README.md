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
| principal (premier onglet) | `SI, Airline, H/W, Flight, ETA, ETD, Sealing, Truck Dep, Days`, puis deux colonnes optionnelles : `FLIGHT_OUT` (J, numéro de départ s'il diffère de Flight) et `FLIGHT_IN` (K, numéro sous lequel l'avion **arrive**, souvent différent du numéro de départ, par exemple 749 à l'arrivée pour 748 au départ ; vide = même que Flight). `Flight` est le numéro du vol au départ. Le suivi de l'arrivée utilise `FLIGHT_IN`. Les lignes de données commencent par un numéro (SI). `Days` : chiffres 1 (lundi) à 7 (dimanche), `daily` ou `1234567`, `0` = ne vole pas. |
| `Airlines` | `NAME, COLOR, IATA, ICAO` |
| `Config` | `KEY, VALUE, DESCRIPTION` |
| `BoxTime` | `SI, FLIGHT, DAY` (`D-1` ou `D`), `OVERRIDE` (HH:MM) |
| `Audit` (phase 4) | `TIMESTAMP, USER, KEY, OLD, NEW` |

Brancher un onglet :

1. Fichier > Partager > Publier sur le Web, publier le document entier (ou chaque onglet) au format CSV.
2. Ouvrir l'onglet : le `gid` est le nombre après `#gid=` dans l'adresse.
3. Le reporter dans `SHEET_GIDS` de `config.js`.

Ordre de lecture pour chaque onglet : Sheet, puis dernière lecture réussie gardée dans le navigateur, puis `data/local-data.json` s'il existe, sinon vide. Sur GitHub Pages, le fichier local n'est pas publié (il n'est pas versionné) : en production, le secours est la dernière lecture réussie de chaque écran. Le détail de la source utilisée par onglet s'affiche au survol de l'indicateur de synchronisation.

## Suivi des vols en direct (flag `LIVE_ADSB`)

- Source : suivi des avions en direct (ADS-B) fourni par adsb.lol, sous licence ODbL. L'attribution « Données : adsb.lol » est affichée quand le flag est actif.
- **Avant le premier client payant, contacter l'auteur d'adsb.lol** : l'API est gratuite et sans clé aujourd'hui, mais il demande d'être prévenu de tout usage en production, et une clé sera exigée plus tard.
- Le navigateur n'appelle jamais l'API : il passe par le relais Google Apps Script (`apps-script/`, notice de déploiement dans `apps-script/README.md`). Son URL va dans la clé `LIVE_RELAY_URL` de l'onglet Config.
- Les heures affichées sont des **estimations** (« Live estimated ETA / ETD »), arrondies à 5 minutes, toujours à côté de l'heure prévue. Ce ne sont pas des heures officielles.
- Règles :
  - ETA live = distance jusqu'à l'aéroport / vitesse sol + `APPROACH_MARGIN_MIN`. Ignorée si vitesse < `MIN_GS_KT`, avion au sol ailleurs, ou position plus vieille que `MAX_POSITION_AGE_SEC`.
  - Vols suivis : ETA prévue entre maintenant - `ADSB_WINDOW_BEFORE_MIN` et maintenant + `ADSB_WINDOW_AFTER_MIN`.
  - ETD estimée = le plus tard entre l'ETD prévue et ETA live + `MIN_ROTATION_MIN`. Un day stop (au moins `DAY_STOP_MIN_GROUND` minutes au sol prévues) garde son ETD.
  - Sealing et Truck gardent l'écart propre à chaque vol avec l'ETD. Box Time : seuls les slots D encore à venir suivent ce décalage (mention « Auto ») ; les slots D-1 ne bougent jamais, un écart d'au moins 30 min est signalé (« Check »).
  - Un recalcul n'est appliqué que si l'estimation bouge d'au moins `RECALC_THRESHOLD_MIN`. Chaque recalcul est journalisé sur l'écran (menu ☰ > Live log). Une heure recalculée à moins de `TIGHT_SLOT_MIN` minutes déclenche l'alerte « Slot too tight ».
  - Relais injoignable : retour aux horaires du Sheet, indicateur orange « Scheduled times ».
- Mode diagnostic (`?ff=LIVE_ADSB,DIAGNOSTIC`) : callsigns essayés et reçus pour chaque vol attendu, vols introuvables, callsigns vus autour de l'aéroport, écarts Box Time règle / OVERRIDE.

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
