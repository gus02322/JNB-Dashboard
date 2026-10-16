# Relais Ops On Time (Google Apps Script)

Un seul script, gratuit, attaché au Sheet, collé à la main dans l'éditeur Apps Script (pas de clasp). Un seul fichier à coller : `live-relay.gs`.

Le relais ne travaille que pour les **unités actives** : la cellule jaune `ACTIVE_UNITS` en tête de RULES (liste déroulante : `JNB`, `CLIENT_1`...), sinon `DEFAULT_UNIT`. Les autres onglets d'unité ne coûtent aucune requête. Changer d'usine : remplir un onglet `CLIENT_` et `AIRPORT_IATA` dans son `RULES_CLIENT_` (code ICAO et coordonnées pris dans l'onglet `Airports`), puis le choisir dans `ACTIVE_UNITS`. Les écrans du dashboard suivent la même cellule.

## Ce qu'il fait

1. **AeroDataBox, source principale** (déclencheur `adbTick` toutes les 5 minutes) : le relais décide seul s'il appelle l'API, selon le planning `ADB_SCHEDULE` et le budget du mois. Un appel FIDS par aéroport (fenêtre de maintenant moins 2 h à maintenant plus 10 h, départs et arrivées), même si plusieurs unités actives partagent l'aéroport. Il écrit dans les colonnes `AUTO_` de chaque vol :
   - `AUTO_LIVE_DATE` (jour d'exploitation), `AUTO_ARR_STATUS`, `AUTO_ARR_SCHED`, `AUTO_ARR_REVISED`, `AUTO_ARR_ACTUAL`, `AUTO_DEP_STATUS`, `AUTO_DEP_SCHED`, `AUTO_DEP_REVISED`, `AUTO_DEP_ACTUAL` (heures `yyyy-MM-dd HH:mm` dans le fuseau de l'unité, converties depuis l'UTC) ;
   - `AUTO_ORIGIN`, `AUTO_DEST`, `AUTO_REG`, `AUTO_HEX` (code Mode S), `AUTO_AIRCRAFT` (type, utilisé par la règle widebody), `AUTO_AIRCRAFT_PREV` (type du passage précédent quand il change), `AUTO_TERMINAL`, `AUTO_GATE` ;
   - `AUTO_UPDATED_UTC` (fraîcheur donnée par AeroDataBox) et `AUTO_CHECKED_AT` (heure de la lecture).
   Le vol arrivant est trouvé par `FLIGHT_IN` (ou `AUTO_FLIGHT_IN`), sinon par le même avion (immatriculation) arrivé avant le départ, sinon par le numéro, moins 1 ou plus 1. Numéros normalisés (`EK 0761` = `EK761`). Les colonnes saisies à la main (`ETA`, `ETD`, `ACTIVE`...) ne sont jamais modifiées. Un vol annulé ou dérouté n'est qu'un statut du jour : `ACTIVE` n'est jamais touché. Chaque changement d'heure, de statut ou d'avion est écrit dans `Audit` (source `AERODATABOX`).
2. **Horaires appris la nuit, sans appel** (`resolveDaily`, vers 02:00) : `AUTO_STA`, `AUTO_STD`, `AUTO_DAYS`, `AUTO_FLIGHT_IN`, `AUTO_CALLSIGN`, `AUTO_AIRLINE` sont déduits des lectures AeroDataBox des 7 derniers jours (gardées dans `ScheduleCache`). Utile quand une unité n'a que les numéros de vol (`FLIGHT`) : le dashboard sait alors quels jours et à quelle heure chaque vol opère. Tant que 7 jours complets n'ont pas été lus, un vol non vu garde ses valeurs et `AUTO_DAYS` ne fait que grandir. Le menu **Fill a new unit now** fait la même chose tout de suite à partir des 7 prochains jours (16 appels, soit 32 unités, par aéroport) : seulement pour démarrer une nouvelle unité sans attendre 7 jours.
3. **URL publique en lecture seule** (`doGet`) : le navigateur ne peut pas appeler adsb.lol (CORS). Le relais l'appelle depuis les serveurs de Google (par code hex Mode S d'abord, puis par callsign), garde chaque réponse 55 secondes en cache et renvoie aussi l'écart médian des jours passés. **Cette URL n'écrit jamais dans le Sheet et n'appelle jamais AeroDataBox.** Il n'y a pas de `doPost`. Appels vers adsb.lol plafonnés à 150 par minute.
4. **Suivi ADS-B, en bonus** (déclencheur `recordHistory`, toutes les 15 min) : heure réelle d'atterrissage (onglet `History`) et de décollage (onglet `Departures`), callsign réellement vu (`AUTO_CALLSIGN`).

## Installer ou mettre à jour (pas à pas)

1. Ouvrir le Sheet, menu **Extensions > Apps Script**.
2. Ouvrir `Code.gs`, tout sélectionner, coller **tout** le contenu de [`live-relay.gs`](https://raw.githubusercontent.com/gus02322/JNB-Dashboard/main/apps-script/live-relay.gs), enregistrer (icône disquette).
3. **Clé AeroDataBox** : roue dentée **Paramètres du projet** (à gauche) > **Propriétés du script** > **Ajouter une propriété** :
   - `AERODATABOX_KEY` = votre clé API.Market (page AeroDataBox d'API.Market, onglet de test ou tableau de bord). **Jamais dans le code, jamais dans le Sheet** : il est lisible par toute personne qui a le lien.
   - Facultatif : `ADB_KEY_HEADER` si l'exemple de code d'API.Market utilise un autre nom d'en-tête que `x-api-market-key`.
   - Clé RapidAPI à la place : mettre `ADB_PROVIDER` = `RAPIDAPI` dans RULES.
4. **Fuseau horaire du projet** (même page) : `(GMT+02:00) Johannesburg`, le même que `TIMEZONE` dans RULES.
5. **Déployer > Gérer les déploiements > crayon > Version : Nouvelle version > Déployer**. L'URL `/exec` ne change pas (elle est dans RULES, `LIVE_RELAY_URL`). Première installation seulement : **Déployer > Nouveau déploiement**, type **Application Web**, exécuter en tant que **Moi**, accès **Tout le monde**, puis coller l'URL dans `LIVE_RELAY_URL`.
6. Recharger le Sheet, menu **Ops On Time > Install triggers** : `adbTick` toutes les 5 min, `recordHistory` toutes les 15 min, `resolveDaily` chaque nuit. L'ancien déclencheur horaire `refreshLive` est supprimé.
7. **Ops On Time > Check setup** : unités actives, aéroports lus, fournisseur, clé présente, crédits du mois, planning, déclencheurs, fuseau.
8. Facultatif : **Ops On Time > Read AeroDataBox now** fait un appel tout de suite (compté) pour vérifier la clé ; le résultat s'affiche et l'onglet `ApiUsage` se remplit.

## Budget de crédits

Réglages dans RULES (lisibles par tous, sans secret) :

| Clé | Exemple | Rôle |
| --- | --- | --- |
| `ADB_MONTHLY_UNITS` | `400` (offre gratuite) ou `5000` | Budget mensuel en unités |
| `ADB_UNITS_PER_CALL` | `2` | Coût d'un appel FIDS |
| `ADB_SCHEDULE` | `@00:00\|04:00\|08:00\|11:00\|14:00\|18:00` | Heures fixes (`@`), ou plages `00:00-06:00:20\|06:00-16:00:15\|16:00-21:00:30\|21:00-24:00:60` (plage:intervalle en minutes) |
| `ADB_WITH_LOCATION` | `TRUE` | Demande la position de l'avion à AeroDataBox |
| `ADB_PROVIDER` | `APIMARKET` | `APIMARKET` ou `RAPIDAPI` |

- **Préréglage économe, 400 unités** : `@00:00|04:00|08:00|11:00|14:00|18:00`, soit 6 appels par jour, environ 360 unités sur 30 jours. Chaque lecture couvre 12 h, donc la journée entière est couverte.
- **Passer à 5000 unités** : `ADB_MONTHLY_UNITS` = `5000` et un planning par plages, par exemple `00:00-06:00:30|06:00-21:00:15|21:00-24:00:30` (environ 76 appels par jour, environ 4 600 unités sur 30 jours).
- **Compteur** : onglet `ApiUsage` (écrit par le relais) et Config > Sync and tracking du dashboard : unités utilisées, appels, mode, dernier appel et son résultat.
- **Modes** : `normal` (le planning s'applique) ; `economy` dès que la consommation dépasse le rythme prévu (au plus un appel par heure, plus espacé si nécessaire pour tenir jusqu'à la fin du mois) ; `stopped` avant d'atteindre le plafond (réserve de 2 % ou d'un appel), plus aucun appel jusqu'au mois suivant.
- Un appel compte dès qu'AeroDataBox répond, même par une erreur. Vérifier sur la page de l'offre qu'elle est en limite stricte (pas de dépassement facturé).

## Comment le dashboard utilise ces données

- **Heure du jour** : réelle, sinon révisée, sinon prévue par AeroDataBox (« Airline ETA / ETD »). L'heure du Sheet reste le plan et s'affiche à côté : « ✓ Sheet = airline 16:15 » ou « No matching hours: Sheet 16:15 · airline 16:30 » (aussi dans Data health).
- **Retard** = révisée moins prévue, affiché sur les blocs (`+40`). Sealing, Truck et Box Time D glissent avec les règles TURN / DAYSTOP existantes.
- **ETD** : jamais déduite d'un retard à l'arrivée (strip and load, day stop). Seule l'ETD donnée par AeroDataBox compte ; si elle diffère du Sheet : « No matching · theoretical ETD changed: HH:MM ».
- **Annulé ou dérouté** aujourd'hui : vol barré « Cancelled », alertes coupées, Box Time « Hold production ». Le lendemain, retour à la normale.
- **Changement d'avion** : alerte « Aircraft change » (configuration galley).
- **Fraîcheur** : « Updated HH:MM » par vol, en orange au-delà de `ADB_STALE_MIN` minutes.
- **ADS-B** ne remplace jamais une heure AeroDataBox ; il ajoute la position et détecte un atterrissage ou un décollage qu'AeroDataBox n'a pas encore signalé. Avion non capté : pas d'alerte tant qu'AeroDataBox a le vol.
- Relais injoignable : les heures AeroDataBox restent affichées (elles viennent du Sheet).

## Sécurité

- Le Sheet et l'URL du relais sont publics. L'URL publique ne fait que lire : aucun paramètre ne permet d'écrire, de lancer une résolution ou d'appeler AeroDataBox. Seul le propriétaire du Sheet peut lancer le menu ; les déclencheurs tournent sous son compte.
- La clé AeroDataBox est dans les propriétés du script, invisibles depuis le Sheet et depuis l'URL publique.
- `History`, `Departures`, `ScheduleCache`, `ApiUsage` et `Audit` ne contiennent aucun secret, mais ils sont lisibles par toute personne qui a le lien du Sheet.

## Limites et quotas (compte Google gratuit)

- Environ 20 000 appels externes par jour : adsb.lol (dashboard et historique) reste autour de 1 000 à 1 500 appels par jour.
- Durée totale des déclencheurs : 90 min par jour. `adbTick` tourne 288 fois par jour mais s'arrête en moins d'une seconde quand rien n'est prévu.

## Historique des arrivées (onglet History)

- `DATE, FLIGHT, ETA_SCHEDULED, FIRST_SEEN_AT, ETA_LIVE_AT_FIRST_SEEN, LAST_SEEN_AT, LANDED_AT, DEVIATION_MIN, PRECISION_MIN, NOTE, UNIT, CALLSIGN`. Une ligne par `UNIT + DATE + FLIGHT + ETA_SCHEDULED`.
- Atterrissage : avion au sol à moins de `LANDED_RADIUS_NM` de l'aéroport, après avoir été vu en vol pour cette ligne.
- Le dashboard reçoit la médiane par vol et par ETA prévue (écarts au-delà de `HISTORY_OUTLIER_MAX_MIN` exclus), à partir de `HISTORY_MIN_SAMPLES` jours. Lignes plus vieilles que `HISTORY_KEEP_DAYS` supprimées.
