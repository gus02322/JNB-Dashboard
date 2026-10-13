# Relais Ops On Time (Google Apps Script)

Un seul script, gratuit, attaché au Sheet. Il fait trois choses :

1. **URL publique en lecture seule** (`doGet`) : le navigateur ne peut pas appeler l'API de suivi des vols (CORS). Le relais l'appelle depuis les serveurs de Google, garde chaque réponse 55 secondes en cache (tous les écrans partagent les mêmes appels) et renvoie aussi l'écart médian des jours passés. Cette URL n'écrit jamais dans le Sheet et n'appelle jamais l'API d'horaires. Il n'y a pas de `doPost`. Les appels vers l'extérieur sont plafonnés à 150 par minute pour protéger le quota gratuit.
2. **Horaires automatiques** (menu du Sheet et déclencheur de nuit) : remplit les colonnes `AUTO_*` de chaque onglet d'unité à partir de l'API AeroDataBox.
3. **Historique et décollages** (déclencheur toutes les 15 min, même si aucun écran n'est ouvert) : enregistre l'heure réelle d'atterrissage (onglet `History`) et de décollage (onglet `Departures`), apprend le callsign réellement vu (`AUTO_CALLSIGN`). Le relais renvoie aux écrans les atterrissages et décollages du jour : un écran ouvert après que l'avion a quitté la couverture ADS-B (au-dessus de l'océan par exemple) sait quand même qu'il a décollé.
4. **Vol arrivant inconnu** (`FLIGHT_IN` vide) : le numéro de départ, puis le numéro moins 1 et plus 1 sont cherchés ; seul l'avion qui vole vers l'aéroport est retenu, et son callsign est appris.

Chaque changement automatique est écrit dans l'onglet `Audit` (DATE, SOURCE, KEY, OLD, NEW).

## Installer (environ 10 minutes, une seule fois)

Le menu « Ops On Time » n'existe que si le script est **attaché au Sheet**. L'ancien projet autonome (créé depuis script.google.com) ne peut pas l'afficher : on en crée un nouveau, attaché.

1. Ouvrir le Sheet, menu **Extensions > Apps Script**. Un projet attaché au Sheet s'ouvre.
2. Renommer le projet (en haut à gauche) : `Ops On Time relay`.
3. Effacer le contenu de `Code.gs`, coller **tout** le contenu de `live-relay.gs` (sans l'entourer d'une fonction), enregistrer.
4. **Paramètres du projet** (roue dentée à gauche) :
   - **Fuseau horaire** : `(GMT+02:00) Johannesburg` (le même que `TIMEZONE` dans RULES).
   - **Propriétés du script > Ajouter une propriété** : `AERODATABOX_KEY` = votre clé (voir plus bas). Facultatif : `ADB_MAX_CALLS_MONTH` (300 par défaut).
5. **Déployer > Nouveau déploiement**, roue dentée « Sélectionner le type » : **Application Web**.
   - Description : `relay`
   - Exécuter en tant que : **Moi**
   - Qui a accès : **Tout le monde**
6. **Déployer**, **Autoriser l'accès**, choisir le compte. Google affiche « Google n'a pas validé cette application » : **Paramètres avancés**, **Accéder à Ops On Time relay (non sécurisé)**, **Autoriser**. Le script demande l'accès à ce Sheet, aux services externes et aux déclencheurs.
7. Copier l'**URL de l'application Web** (elle finit par `/exec`) et la coller dans l'onglet **RULES**, clé `LIVE_RELAY_URL` (à la place de l'ancienne).
8. Vérifier : ouvrir cette URL suivie de `?cs=ABC123` (indicatif fictif). Une réponse du type `{"now":...,"cs":{"ABC123":[]},...}` doit s'afficher.
9. Recharger le Sheet : le menu **Ops On Time** apparaît. Cliquer **Ops On Time > Install triggers** (historique toutes les 15 min, horaires chaque nuit vers 02:00), puis **Ops On Time > Check setup**.
10. Cliquer **Ops On Time > Resolve flights** : les colonnes `AUTO_*` se remplissent, la colonne `STATUS` indique `Resolved`, `Unresolved` ou `Manual override`.
11. L'ancien projet autonome peut ensuite être supprimé (ou laissé : il ne sert plus dès que `LIVE_RELAY_URL` pointe vers le nouveau).

## Mettre à jour le script plus tard

Modifier le code, enregistrer, puis **Déployer > Gérer les déploiements > crayon > Version : Nouvelle version > Déployer**. L'URL ne change pas.

## Clé de l'API d'horaires (AeroDataBox)

1. Créer un compte gratuit sur https://rapidapi.com, ouvrir la page de l'API **AeroDataBox**, onglet **Pricing**, choisir l'offre gratuite (**Basic**, 0 $). Aucune carte bancaire n'est demandée pour cette offre ; si une carte est demandée, s'arrêter : ce n'est plus l'offre gratuite.
2. Onglet **Endpoints** : la clé s'affiche dans `X-RapidAPI-Key`. La copier.
3. La coller dans **Paramètres du projet > Propriétés du script**, propriété `AERODATABOX_KEY`. Jamais dans le code, jamais dans le Sheet (il est lisible par toute personne qui a le lien).

Consommation : une requête par aéroport et par tranche de 12 h, gardée dans l'onglet privé `ScheduleCache`. La première résolution d'un aéroport lit la veille et les 7 jours suivants (16 requêtes), ensuite environ 2 requêtes par jour et par aéroport. Le relais s'arrête de lui-même avant `ADB_MAX_CALLS_MONTH` requêtes dans le mois (300 par défaut) et le compteur s'affiche dans **Check setup**. Vérifier sur la page Pricing le quota mensuel exact de l'offre gratuite et régler `ADB_MAX_CALLS_MONTH` en dessous.

### Pourquoi AeroDataBox

| API | Offre gratuite | Ce qu'elle donne | Verdict |
| --- | --- | --- | --- |
| **AeroDataBox** (RapidAPI) | oui, quota mensuel limité | horaires d'un aéroport par tranche de 12 h (départs et arrivées), numéro, callsign, type d'avion, immatriculation, jusqu'à quelques jours à l'avance | **retenue** : une requête couvre tout un aéroport, l'immatriculation permet de trouver le vol arrivant (rotation) |
| AviationStack | 100 requêtes par mois, HTTP seulement en gratuit | vols du jour, peu fiable sur les horaires futurs | quota trop faible, clé envoyée en clair |
| AirLabs | environ 1 000 requêtes par mois | horaires par aéroport, peu d'informations sur l'appareil | possible en secours, pas d'immatriculation fiable pour la rotation |
| FlightAware AeroAPI | payant à la requête | très complet | exclu : coût |
| OpenSky | gratuit | positions ADS-B, pas d'horaires | ne répond pas au besoin |

## Comment la résolution fonctionne

Pour chaque ligne d'un onglet d'unité (`UNITS` dans RULES), à partir de la colonne `FLIGHT` (numéro de départ) :

- Numéro normalisé : majuscules, sans espace, sans zéro de tête (`KP0073` = `KP73`), IATA ou ICAO.
- `AUTO_STD` et `AUTO_DAYS` : heure de départ la plus fréquente sur les 7 prochains jours et les jours où elle vole.
- Vol arrivant (`AUTO_FLIGHT_IN`) : `FLIGHT_IN` saisi à la main s'il existe ; sinon le même avion (immatriculation) arrivé avant le départ ; sinon le numéro moins 1, puis plus 1, puis le même numéro, validé par l'API (au moins un départ sur deux doit avoir cette arrivée avant lui).
- `AUTO_STA` : heure d'arrivée de ce vol. Arrivée la veille :
  - rotation courte après minuit (par exemple arrivée 23:45, départ 00:45) : le jour d'exploitation est celui de l'arrivée (convention du Sheet : ETD le lendemain) ;
  - sinon c'est un day stop : `AUTO_STA` = `D-1 HH:MM`, le dashboard n'affiche pas d'ETA ce jour-là (comme HM062).
- `AUTO_CALLSIGN`, `AUTO_AIRLINE`, `AUTO_AIRCRAFT` (le type d'avion sert à la règle widebody).
- `STATUS` : `Manual override` dès qu'une ETA ou une ETD est saisie à la main (la valeur manuelle gagne toujours), `Resolved` sinon, `Unresolved` si le vol n'est pas trouvé.

Le menu résout toutes les lignes. Le déclencheur de nuit ne résout que les lignes nouvelles ou `Unresolved`, et toutes les lignes le lundi (les horaires changent).

## Historique des arrivées (onglet History)

- Onglet créé automatiquement : `DATE, FLIGHT, ETA_SCHEDULED, FIRST_SEEN_AT, ETA_LIVE_AT_FIRST_SEEN, LAST_SEEN_AT, LANDED_AT, DEVIATION_MIN, PRECISION_MIN, NOTE, UNIT, CALLSIGN`. Une ligne par `UNIT + DATE + FLIGHT + ETA_SCHEDULED`.
- Atterrissage : avion au sol à moins de `LANDED_RADIUS_NM` de l'aéroport de l'unité, après avoir été vu en vol pour cette ligne. Deux lignes trop proches avec le même callsign : `NOTE` « ambiguous », aucun écart enregistré.
- Le dashboard reçoit la médiane par vol et par ETA prévue (écarts supérieurs à `HISTORY_OUTLIER_MAX_MIN` exclus), à partir de `HISTORY_MIN_SAMPLES` jours.
- Lignes plus vieilles que `HISTORY_KEEP_DAYS` supprimées.

## Sécurité

- Le Sheet et l'URL du relais sont publics. L'URL publique ne fait que lire : aucun paramètre ne permet d'écrire, de lancer une résolution ou d'appeler l'API d'horaires. Seul le propriétaire du Sheet peut lancer le menu ; les déclencheurs tournent sous son compte.
- La clé AeroDataBox est dans les propriétés du script, invisibles depuis le Sheet et depuis l'URL publique.
- Les onglets `History`, `ScheduleCache` et `Audit` ne contiennent aucun secret, mais ils sont lisibles par toute personne qui a le lien du Sheet.

## Limites et quotas (compte Google gratuit)

- Environ 20 000 appels externes par jour : dashboard (toutes les 20 min) et historique (toutes les 15 min) restent autour de 1 000 à 1 500 appels par jour.
- Durée totale des déclencheurs : 90 min par jour ; l'historique et la résolution de nuit en utilisent quelques minutes.
