# Ops On Time

Live catering operations, on one screen.

Tableau de bord d'opérations catering aérien : timeline du jour (ETA, Sealing & Loading, Truck Departure, ETD), vue par compagnie, slots Box Time, semaine, alertes, suivi des avions en direct. Site statique servi par GitHub Pages, données dans un Google Sheet, relais Google Apps Script. Aucun serveur, aucune base de données. Interface en anglais.

## Fichiers

| Fichier | Rôle |
| --- | --- |
| `index.html` | Interface (HTML, CSS, JS). |
| `config.js` | Configuration centrale : nom du produit, identifiant du Sheet, unité par défaut, gid des onglets connus, feature flags. Aucun secret. |
| `js/rules.js` | Moteur de règles : fonctions pures, toutes les règles horaires lues dans l'onglet RULES. |
| `js/data-source.js` | Seul module qui sait d'où viennent les données (lecture des onglets, cache, contrôle des données). |
| `js/live-core.js`, `js/live.js` | Suivi des avions en direct (ADS-B) par le relais, estimations, simulation de démo. |
| `apps-script/live-relay.gs` | Relais Google Apps Script : URL publique en lecture seule, résolution des horaires, historique. Notice : `apps-script/README.md`. |
| `tools/check-unit.mjs` | Recalcule tout un onglet d'unité avec le moteur de règles et liste les écarts avec les heures saisies. |
| `OpsOnTime_Timing_Rules.xlsx` | Règles, contrôle de l'onglet JNB, scénarios, questions ouvertes. |
| `tests/` | Tests (`node --test tests/*.test.mjs`, aucune dépendance). |

## Le Google Sheet

Le Sheet est la seule source de vérité. **Tout ce qu'il contient est lisible par toute personne qui a le lien : jamais de mot de passe ni de clé dedans.** Le dashboard ne l'écrit jamais ; seul le relais (sous le compte du propriétaire) écrit les colonnes `AUTO_*`, `STATUS`, `History`, `ScheduleCache` et `Audit`.

| Onglet | Contenu |
| --- | --- |
| `README` | Mode d'emploi court. |
| `JNB`, `CPT`, `DUR`, `AIRCHEFS_DEMO`... | Un onglet par unité, choisi par `?unit=<NOM>` dans l'adresse (défaut `DEFAULT_UNIT`, JNB). |
| `DEMO_BLANK` | Modèle vide (seulement `FLIGHT`) à dupliquer pour un prospect. |
| `RULES` | Toutes les règles et réglages (`KEY, VALUE, DESCRIPTION`). |
| `RULES_<UNIT>` | Surcharge par unité : `AIRPORT_ICAO`, `AIRPORT_LAT`, `AIRPORT_LON`, `TIMEZONE`, `UNIT_LABEL`, et n'importe quelle clé de RULES. |
| `Airlines` | `NAME, COLOR, IATA, ICAO, DEFAULT_PROFILE, NOTES`. |
| `BoxTime` | Surcharges facultatives : `SI, FLIGHT, DAY, OVERRIDE, UNIT`. Sans ligne, la règle donne le slot. |
| `Audit` | Chaque changement automatique : `DATE, SOURCE, KEY, OLD, NEW`. |
| `History`, `ScheduleCache` | Écrits par le relais. |
| `Feuille 2`, `Feuille 3` | Anciens onglets, plus lus : les statistiques par jour sont calculées dans l'application (Config > Flights per day). |

Colonnes d'un onglet d'unité (lues par leur nom, dans n'importe quel ordre, lignes de titre au-dessus autorisées) :

- Obligatoire : `FLIGHT` (numéro de **départ**).
- Facultatives, saisies à la main : `DAYS` (1 = lundi ... 7 = dimanche, `daily`, `0` = ne vole pas), `FLIGHT_IN` (numéro sous lequel l'avion **arrive**, c'est lui qui est suivi en ADS-B), `CALLSIGN` (dernier recours pour le suivi), `AIRLINE`, `H/W`, `ETA`, `ETD`, `Sealing`, `Truck Dep`, `RULE_PROFILE` (`TURN` ou `DAYSTOP`), `SEAL_TO_TRUCK` (minutes), `TRUCK_OFFSET` (`ETA-30`, `ETD-120`...), `ACTIVE` (`NO` = masqué, `CANCELLED` = annulé), `NOTES`, `FLIGHT_OUT`, `SI`.
- Remplies par le relais : `AUTO_STA, AUTO_STD, AUTO_DAYS, AUTO_FLIGHT_IN, AUTO_CALLSIGN, AUTO_AIRLINE, AUTO_AIRCRAFT, STATUS` (`Resolved`, `Unresolved`, `Manual override`).
- **Une valeur manuelle gagne toujours** sur la valeur automatique. Sealing et Truck vides sont calculés par la règle.

Lecture de chaque onglet : par son nom (gviz CSV, demande le partage « Tous les utilisateurs disposant du lien : Lecteur »), puis par le CSV publié (gid dans `config.js`), puis dernière lecture réussie sur l'appareil, puis `data/local-data.json` s'il existe. Les onglets sont au format Texte : sinon la lecture gviz efface les valeurs d'un type minoritaire dans une colonne.

### Contrôle des données (Config > Data health)

Jamais de plantage : chaque ligne est vérifiée et les problèmes sont listés par niveau (`error`, `warn`, `check`, `info`) : numéro mal formé, compagnie inconnue ou sans code, vol non trouvé, doublon, heure illisible, ligne vide, ligne inactive (`DAYS = 0`, `ACTIVE = NO`), écart d'au moins `HEALTH_GAP_MIN` minutes entre une heure saisie et la règle, surcharge Box Time différente de la règle.

## Règles horaires (js/rules.js, valeurs dans RULES)

- **Profil** : `RULE_PROFILE` s'il est rempli, sinon temps au sol prévu (STD - STA) : `DAYSTOP` à partir de `DAY_STOP_MIN_GROUND` (360 min), `TURN` en dessous. Pas d'ETA (arrivée la veille) : `DAYSTOP`.
- **Truck** : `TRUCK_OFFSET` de la ligne, sinon `TRUCK_EXCEPTIONS` (ex. `ET848:ETD-120|UA187:ETD-150`), sinon TURN = ETA + `TURN_TRUCK_OFFSET_MIN` (-30), DAYSTOP = ETD + `DAYSTOP_TRUCK_OFFSET_MIN` (-180).
- **Sealing** = Truck - `SEAL_TO_TRUCK` de la ligne, sinon `SEAL_EXCEPTIONS` (ex. `UU344:45`), sinon widebody `SEAL_TO_TRUCK_WIDE_MIN` (120) ou `SEAL_TO_TRUCK_MIN` (60). Widebody : par type d'avion (`WIDEBODY_TYPES`, dans `AUTO_AIRCRAFT`) s'il est connu, sinon par compagnie (`WIDEBODY_AIRLINES`).
- **Box Time** : ETD après `BOX_THRESHOLD_ETD` (17:00) : slot D = Sealing + `BOX_D_OFFSET_MIN` (-240). Sinon slot D-1 = ETD + `BOX_D1_OFFSET_MIN` (120), plafonné à `BOX_D1_CAP` (15:00), ou `BOX_D1_LATE_SLOT` (19:00) si l'ETD est après 15:00 et au plus 17:00. L'onglet BoxTime ne sert qu'à surcharger.
- **Retard** (ETA live ou simulée) :
  - TURN : à partir de `RECALC_THRESHOLD_MIN` (5 min) d'écart, Truck, Sealing et Box Time D glissent avec l'ETA ; ETD estimée = max(STD, ETA + `MIN_ROTATION_MIN`). Les slots D-1 ne bougent pas et sont marqués « Check ».
  - DAYSTOP : rien ne bouge ; alerte « Day stop margin » si l'ETA laisse moins de `DAYSTOP_MARGIN_MIN` minutes avant Truck.
  - Heure recalculée à moins de `TIGHT_SLOT_MIN` minutes : alerte « Slot too tight ».
- **Annulation** (`ACTIVE = CANCELLED` ou démo) : événements barrés « Cancelled », alertes coupées, Box Time « Hold production ».
- Après minuit : une ETD plus tôt que l'ETA est le lendemain ; un Truck avant minuit reste sur le jour d'exploitation.

Contrôle d'un onglet complet : télécharger les onglets en CSV puis `node tools/check-unit.mjs JNB.csv RULES.csv Airlines.csv BoxTime.csv JNB`.

## Suivi des vols en direct (flag `LIVE_ADSB`)

- Source : ADS-B fourni par adsb.lol (ODbL), attribution « Données : adsb.lol ». **Avant le premier client payant, contacter l'auteur d'adsb.lol.**
- Le navigateur n'appelle jamais l'API : il passe par le relais (`LIVE_RELAY_URL` dans RULES).
- Vol suivi : `FLIGHT_IN` (ou `AUTO_FLIGHT_IN`), converti en callsign ICAO par l'onglet Airlines, puis `CALLSIGN`, puis le callsign appris par le relais (`AUTO_CALLSIGN`).
- **Vol arrivant (ETA)** : chaque ETA affiche le vol qui arrive, par exemple « ◂ EK763 in flight · 640 km » pour EK764, et la fiche vol affiche « Incoming flight EK763 from DXB · in flight ». `FLIGHT_IN` vide : le numéro de départ, puis moins 1 et plus 1 sont cherchés ; seul l'avion qui vole vers l'aéroport est retenu (route vérifiée), puis gardé pour la journée. Les vols arrivants sont suivis à partir de `ADSB_WINDOW_AFTER_MIN` (600 min) avant l'ETA ; la fiche ouverte est cherchée en priorité.
- **Départ (ETD)** : si l'avion n'est pas vu en l'air `DEP_LATE_MIN` (15) minutes après l'ETD, le bloc devient orange « Not airborne +Xm ». Affiché seulement si le suivi tournait déjà à l'heure de l'ETD (sinon un décollage a pu être manqué). « Departed » dès que le décollage est vu, ou transmis par le relais.
- Une recherche refusée par l'API (limite de débit) ne fait plus tomber tout le suivi : les autres réponses sont utilisées, la recherche refusée est refaite à la mise à jour suivante.
- Niveaux : Live (position récente), Estimated (vu puis perdu, ou historique), Scheduled (jamais vu). Jamais de position inventée présentée comme observée.
- Relais injoignable : retour aux horaires du Sheet, indicateur « Scheduled times ».

## Affichage

- Statuts : Live, Estimated, Scheduled, Delayed, Cancelled (légende en bas de la timeline). Heure nouvelle en premier, ancienne barrée, badge « Auto updated » ; les blocs glissent à leur nouvelle place.
- Menu ☰ : vues Ops, Airlines, Production, Week, Config ; filtres ; Live log ; panneau latéral ; Demo.
- Config : unité active, aéroport et fuseau, sources et dernière synchronisation, état ADS-B et horaires, vols chargés avec leur statut (blanc : Sheet, bleu : automatique, violet : règle), règles en lecture seule avec lien vers le Sheet, Data health, vols par jour, filtres, alertes, affichage.
- Écran sans surveillance : passe seul au jour suivant à minuit et se recharge une fois par nuit (03:30) pour prendre les mises à jour.

## Mode démo (flag `DEMO_MODE`)

- Menu ☰ > **Demo** (ou `?demo=on`) : bandeau permanent « DEMO MODE ». Rien n'est écrit dans le Sheet, l'Audit ni le journal de l'appareil.
- Dans la fiche d'un vol ou le **Demo panel** : Delay +15 / +30 / +60 / Custom, Early arrival, Cancel flight, Reset. Effet immédiat sur toutes les vues (blocs qui glissent, ancienne heure barrée, « Auto updated », ligne dans le Live log, alerte si Sealing ou Truck tombe dans la fenêtre d'alerte). Fonctionne sur n'importe quelle date.
- **Auto demo** : boucle retard, annulation, retour au plan toutes les X minutes.
- `?demo=live|lost|never|landed` : vol fictif XX123 avec observations simulées (niveaux d'estimation).

### Préparer une démo pour un prospect

1. Dans le Sheet, dupliquer `DEMO_BLANK`, le renommer (ex. `PROSPECT_X`), coller les numéros de vol au départ dans la colonne `FLIGHT`, créer `RULES_PROSPECT_X` (copie de `RULES_JNB` avec le code ICAO et les coordonnées de l'aéroport) et ajouter `PROSPECT_X` à `UNITS` dans RULES.
2. Menu **Ops On Time > Resolve flights** : horaires, jours, vol arrivant et callsign se remplissent.
3. Ouvrir `https://gus02322.github.io/JNB-Dashboard/?unit=PROSPECT_X&demo=on`.

## Sécurité

- Aucun secret dans le code, le navigateur ou le Sheet. La clé de l'API d'horaires est dans les propriétés du script Apps Script.
- L'URL du relais est publique et ne fait que lire (pas d'écriture, pas d'appel à l'API d'horaires, appels plafonnés par minute).
- Partage du Sheet : **« Tous les utilisateurs disposant du lien : Lecteur »**, jamais « Éditeur ». Le dashboard ne fait que lire ; le relais écrit avec le compte du propriétaire.

## Lancer en local

```sh
python3 -m http.server 8000
# puis ouvrir http://localhost:8000/?unit=JNB
```

## Feature flags

Définis dans `FLAGS` (`config.js`). Pour tester sur un seul écran : `?ff=NOM1,NOM2` (mémorisé sur cet appareil), `?ff=none` pour revenir à la normale.

## Déploiement

GitHub Pages publie la branche `main`. Tout merge sur `main` part en production.
