# Relais de suivi des vols (Google Apps Script)

Le navigateur ne peut pas appeler l'API de suivi des vols directement (CORS). Ce petit script, déployé gratuitement sur le compte Google qui possède le Sheet, fait l'appel côté Google et renvoie la réponse au dashboard. Il garde chaque réponse 55 secondes en cache : tous les écrans partagent les mêmes appels.

## Déployer (environ 5 minutes, une seule fois)

1. Ouvrir https://script.google.com avec le compte Google du Sheet, cliquer sur **Nouveau projet**.
2. Renommer le projet (en haut à gauche) : `ANGA live relay`.
3. Effacer le contenu de `Code.gs`, coller tout le contenu de `live-relay.gs`, enregistrer (icône disquette).
4. Cliquer sur **Déployer > Nouveau déploiement**.
5. Roue dentée à côté de « Sélectionner le type » : choisir **Application Web**.
6. Remplir :
   - Description : `live relay`
   - Exécuter en tant que : **Moi**
   - Qui a accès : **Tout le monde**
7. Cliquer sur **Déployer**, puis **Autoriser l'accès**, choisir le compte. Google affiche « Google n'a pas validé cette application » : cliquer sur **Paramètres avancés**, puis **Accéder à ANGA live relay (non sécurisé)**, puis **Autoriser**. Le script demande seulement le droit d'appeler des services externes.
8. Copier l'**URL de l'application Web** (elle finit par `/exec`).
9. Vérifier : ouvrir cette URL suivie de `?cs=ABC123` (indicatif fictif) dans le navigateur. Une réponse du type `{"now":...,"cs":{"ABC123":[]},...}` doit s'afficher.
10. Coller l'URL dans l'onglet **Config** du Sheet, clé `LIVE_RELAY_URL`.

## Historique des arrivées (onglet History)

Le relais enregistre lui-même l'heure réelle d'atterrissage de chaque arrivée, grâce à un déclencheur qui tourne toutes les 15 min (ou moins si `ADSB_REFRESH_SEC` est plus court). Il lit le Sheet directement, jamais des données envoyées par un navigateur.

- Onglet `History` (créé automatiquement), **à ne pas publier sur le Web** : `DATE, FLIGHT, ETA_SCHEDULED, FIRST_SEEN_AT, ETA_LIVE_AT_FIRST_SEEN, LAST_SEEN_AT, LANDED_AT, DEVIATION_MIN, PRECISION_MIN, NOTE`. Une ligne par `DATE + FLIGHT + ETA_SCHEDULED` (mise à jour, jamais de doublon).
- Rattachement : même indicatif, ligne du Sheet dont l'ETA prévue est la plus proche. Deux lignes trop proches : `NOTE` « ambiguous », aucun écart enregistré.
- Atterrissage : avion au sol à moins de `LANDED_RADIUS_NM` de l'aéroport, après avoir été vu en vol pour cette ligne. Précision = intervalle du déclencheur (`PRECISION_MIN`).
- `DEVIATION_MIN` = atterrissage - ETA prévue (passage de minuit géré). Le dashboard reçoit la **médiane** par vol et par ETA prévue, écarts supérieurs à `HISTORY_OUTLIER_MAX_MIN` exclus. L'ETA du Sheet peut être une heure de posé ou de parking : ce biais constant est absorbé par la médiane.
- Lignes plus vieilles que `HISTORY_KEEP_DAYS` supprimées. Lignes avec `Days = 0` ignorées.
- Toutes les heures sont calculées dans le fuseau `TIMEZONE` de l'onglet Config. Le fuseau du projet Apps Script doit être le même (Paramètres du projet > Fuseau horaire) : le relais renvoie un avertissement sinon.

Réglages du projet, une seule fois :
1. **Paramètres du projet** (roue dentée à gauche) > **Fuseau horaire** : le même que `TIMEZONE`.
2. **Paramètres du projet** > **Propriétés du script** > **Ajouter une propriété** : `SHEET_ID` = l'identifiant du Sheet (la longue suite de caractères entre `/d/` et `/edit` dans son adresse).
3. Dans l'éditeur, choisir la fonction `installTrigger` dans la liste en haut, cliquer sur **Exécuter**, accepter les autorisations (accès au Sheet et aux déclencheurs). Le journal affiche l'intervalle choisi.

## Mettre à jour le script plus tard

Modifier le code, enregistrer, puis **Déployer > Gérer les déploiements > crayon > Version : Nouvelle version > Déployer**. L'URL ne change pas.

## Limites et quotas (compte Google gratuit)

- Environ 20 000 appels externes par jour. Le dashboard (toutes les 20 min) et le déclencheur d'historique (toutes les 15 min) restent ensemble autour de 1 000 à 1 500 appels par jour avec le planning actuel.
- Durée totale des déclencheurs : 90 min par jour sur un compte gratuit ; l'historique en utilise quelques minutes.
- L'URL est publique : n'importe qui peut l'appeler. Elle ne donne accès à rien d'autre qu'aux données publiques de suivi, et le cache limite la consommation.
- Aucun secret dans ce script. Si l'API demande un jour une clé, la mettre dans **Paramètres du projet > Propriétés du script**, jamais dans le code.
