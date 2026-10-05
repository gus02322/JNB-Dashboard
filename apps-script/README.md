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
9. Vérifier : ouvrir cette URL suivie de `?cs=UAE768` dans le navigateur. Une réponse du type `{"now":...,"cs":{"UAE768":[...]},...}` doit s'afficher (liste vide si le vol n'est pas en l'air).
10. Coller l'URL dans l'onglet **Config** du Sheet, clé `LIVE_RELAY_URL`.

## Mettre à jour le script plus tard

Modifier le code, enregistrer, puis **Déployer > Gérer les déploiements > crayon > Version : Nouvelle version > Déployer**. L'URL ne change pas.

## Limites et quotas (compte Google gratuit)

- Environ 20 000 appels externes par jour. Avec le cache, il faut compter au plus un appel par vol suivi et par minute, plus un pour la zone autour de l'aéroport.
- L'URL est publique : n'importe qui peut l'appeler. Elle ne donne accès à rien d'autre qu'aux données publiques de suivi, et le cache limite la consommation.
- Aucun secret dans ce script. Si l'API demande un jour une clé, la mettre dans **Paramètres du projet > Propriétés du script**, jamais dans le code.
