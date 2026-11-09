# Faisabilité YouTube Music sans extension

État au **9 novembre 2026**, date de consultation des sources primaires. Inspection du code sans
connexion à un compte, appel API authentifié ni essai de lecture. Les inférences et essais restant
à faire sont indiqués explicitement.

## Décision proposée

**Le parcours promis n'est pas établi : connecter un abonnement personnel YouTube Music depuis
le web, bénéficier de cet abonnement dans le salon, rafraîchir sa session puis reprendre dans
l'application officielle à la position exacte.** Aucun SDK/API public de lecture Music offrant
ce parcours n'a été identifié dans le [catalogue officiel](https://developers.google.com/youtube),
la [référence Data API](https://developers.google.com/youtube/data/reference/rest) et les contrats
lecteur/OAuth ci-dessous. Cela ne prouve ni l'impossibilité technique ni l'absence d'accords partenaires.

Continuer la chronologie neutre du salon et conserver YouTube ordinaire. Ne pas afficher
« Connecter YouTube Music » sur la seule base d'un consentement OAuth aux métadonnées.

## Ce qui existe dans le dépôt

| Couche inspectée | Fait démontré par le code | Limite |
| --- | --- | --- |
| [YouTubeAdapter](../server/services/youtube.ts), [initExtractor](../server/infoextractor.ts) | Métadonnées, recherche, collections ; Data API v3 avec clé du projet. Pagination d'import filtrant vidéos non intégrables/privées. | Pas d'autorisation Music. Le repli historique de durée lit une page publique, sans accès abonné démontré. |
| [YoutubePlayer.vue](../client/src/components/players/YoutubePlayer.vue), [OmniPlayer.vue](../client/src/components/players/OmniPlayer.vue) | `service === "youtube"` sélectionne `YT.Player` : lecture/pause, `getCurrentTime`, `seekTo`, volume, vitesse, événements. | Aucun jeton OAuth ni contrôle de l'app Music. Erreurs réduites à un événement générique ; `onAutoplayBlocked` absent. |
| [Room.vue](../client/src/views/Room.vue) | Position cible calculée toutes les 250 ms ; correction si écart supérieur à une seconde hors blocage média ; réapplication de l'état au lecteur prêt. | Synchronisation locale implémentée, sans garantie de précision exacte ni mesure réseau réalisée ici. |
| [Catalogue](../server/music/catalogue.ts), [types](../common/models/music.ts) | Unicité `(service, providerId)`, IDs déterministes, résolution à la lecture par `CatalogueResolver.video` / `toQueueItem`. `seek` déduit d'une durée positive ; arrière-plan `unknown` ; disponibilité initiale `available`. | Indications de catalogue, pas droits ou garanties par participant/appareil. Résumés personnels sans `providerId`. |
| [Imports](../server/music/imports.ts) | Un lien `music.youtube.com` admissible reste une référence `youtube` à playlist/vidéo. | Accepter ce domaine ne connecte pas Music et ne rend pas toute la bibliothèque Music accessible. |

L'enregistrement reste distinct de sa source : ni URL temporaire comme identité durable, ni fusion
par titre. Le chemin YouTube reste disponible selon configuration et disponibilité des vidéos ;
sa lecture réelle n'a pas été retestée ici.

## Ce que permettent les interfaces officielles

### Données et autorisation ne sont pas lecture abonnée

La [Data API](https://developers.google.com/youtube/data/reference/rest) expose des ressources
JSON. Une clé suffit aux données publiques ; OAuth autorise certaines données privées/écritures.
Les [scopes YouTube](https://developers.google.com/youtube/data/guides/authentication)
incluent `youtube.readonly` (lecture du compte), `youtube.force-ssl` (opérations sur vidéos,
notations, commentaires et sous-titres), ainsi que gestion/upload. Aucun scope de lecture audio
Music ou de vérification du droit Premium n'y est documenté. `subscriptions` signifie
[abonnements à des chaînes](https://developers.google.com/youtube/data/reference/rest/v3/subscriptions),
pas abonnement payant au streaming.

Il existe bien une API officielle touchant Music : la
[Data Portability API](https://developers.google.com/data-portability/schema-reference/youtube)
décrit l'export de bibliothèque et de morceaux téléversés (`dataportability.youtube.music`).
Ce contrat d'export ne fournit pas un lecteur du catalogue sous abonnement, ni sa position courante.

### IFrame : lecture YouTube, avantages de navigateur conditionnels

Le [contrat IFrame](https://developers.google.com/youtube/iframe_api_reference) documente
lecture/pause, chargement à `startSeconds`, position en secondes et recherche temporelle. La
recherche peut tomber sur une image clé : aucune précision exacte n'est garantie. Les erreurs
100, 101/150 et 153 couvrent notamment contenu absent/privé, intégration refusée et identité client
manquante (`HTTP Referer` ou équivalent). Les méthodes concernent **cette instance intégrée**.

Les [règles d'autorisation](https://developers.google.com/youtube/terms/developer-policies#c.-implementing-youtube-features)
indiquent que l'IFrame n'exige pas d'autorisation ; ses
[paramètres publics](https://developers.google.com/youtube/player_parameters) ne définissent
aucun échange de jeton OAuth contre une session Music/Premium. **Inférence :** réussir OAuth
Data API ne connecte pas le lecteur à l'abonnement.

Nuance : l'[aide Premium sur les publicités](https://support.google.com/youtube/answer/7437519?hl=en)
demande d'être connecté au bon compte et de ne pas bloquer les cookies YouTube pour les vidéos
intégrées. Un avantage Premium dans un embed n'est donc pas à déclarer impossible. Il dépend de
la session gérée par YouTube dans le navigateur, non vérifiée ici et non pilotable par un refresh
token Data API. Music Premium et YouTube Premium ne donnent pas les mêmes avantages : ne pas
promettre l'absence de publicité sur toutes les vidéos à un titulaire de Music Premium seul.

### Rafraîchissement : deux sessions distinctes

Le [flux OAuth serveur](https://developers.google.com/identity/protocols/oauth2/web-server#offline)
permet, avec accès hors ligne et refresh token, de renouveler un access token **pour les scopes
accordés**. Cela ne renouvelle pas les cookies de connexion YouTube du navigateur. Google décrit
des [causes d'expiration/révocation](https://developers.google.com/identity/protocols/oauth2#expiration),
dont une expiration à sept jours des refresh tokens d'un projet externe en statut Testing, hors
exception des scopes d'identité de base. Aucune continuité indéfinie de session ne doit être promise.

### Application officielle, historique et position

| Besoin | Preuve primaire | Conclusion pour le salon web |
| --- | --- | --- |
| Lire l'historique YouTube via Data API | [Révision du 28 janvier 2021](https://developers.google.com/youtube/data/revision_history#january-28,-2021) : historique et Watch Later inaccessibles malgré la suppression de certains codes d'erreur documentés. | Explicitement indisponible par cette API ; OAuth ne l'ouvre pas. |
| Lire/écrire la position courante de l'app Music, transférer sa lecture | Aucun endpoint correspondant identifié dans les références publiques consultées. `getCurrentTime()` vise l'IFrame local. | Non documenté, non vérifié ; aucune reprise bidirectionnelle exacte à promettre. |
| Continuer entre appareils officiels | L'[aide Music](https://support.google.com/youtubemusic/answer/9231765?hl=en) décrit la restauration de file et « Continue Listening on Connected Devices ». | Fonction produit documentée ; aucune interface tierce ni précision de reprise garantie au salon. |
| Partager un point de départ | L'[aide au partage Music](https://support.google.com/youtubemusic/answer/9198182?hl=en) décrit « Start at » sur un lien partagé. | Alternative manuelle documentée ; un lien horodaté n'est ni une observation continue ni un transfert de session. Pas de syntaxe de lien inventée. |

### Restrictions du navigateur et du lecteur

- Le navigateur peut bloquer une lecture sonore scriptée : événement
  [`onAutoplayBlocked`](https://developers.google.com/youtube/iframe_api_reference#Events),
  [règles Chrome](https://developer.chrome.com/blog/autoplay/). Prévoir un geste local puis un
  rattrapage sur la position actuelle du salon ; un abonnement ne supprime pas cette restriction.
- La [politique de même origine](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy)
  limite l'accès à un autre onglet/iframe et à son stockage. Ouvrir Music ne donne pas au salon
  accès à son lecteur ; `postMessage` suppose une interface volontaire côté destinataire.
- Les [politiques YouTube, III.F](https://developers.google.com/youtube/terms/developer-policies#f.-user-experience)
  interdisent notamment séparation audio/vidéo et fonctionnalités de lecteur caché en arrière-plan.
  Garder le lecteur visible ; ne pas transformer l'IFrame en lecteur audio invisible ou promettre
  les usages écran verrouillé de l'app Music. Les publicités et restrictions restent celles du fournisseur.

## Frontières à réserver, sans bloquer la chronologie

Propositions de contrat, **non implémentées** par cette note :

1. **Catalogue** : conserver `trackId`, `sourceId`, `(service, providerId)` et les segments.
   Une future source abonnée aura un mode/une identité explicites ; ne pas renommer YouTube en Music.
   Valider équivalence d'enregistrement et décalage avant de choisir des sources différentes.
2. **Compte fournisseur** : lien personnel, scopes, expiration, révocation, référence interne aux
   jetons ; distincts du compte OTT et des droits effectifs. Connexion de données ne vaut pas
   `canPlayAuthenticated`. Aucun jeton, cookie, URL privée ou historique fournisseur dans les événements.
3. **Session de lecture par participant/appareil** : mode `embedded` / `sdk` / contrôle distant,
   activation, disponibilité, commandes, position observable et transfert évalués séparément.
   Valeurs inconnues conservées ; fonctions non établies désactivées. Session navigateur distincte d'OAuth.
4. **Chronologie** : occurrence, source, ancre temporelle, position cible, état/révision indépendants
   du fournisseur ; intention distincte de l'observation locale horodatée avec incertitude/erreur.
   Normaliser les unités. Reconnexion/rattrapage ne créent pas un passage ; rejeter les réponses
   d'anciennes occurrences/sessions. Un échec individuel ne bloque pas la chronologie commune.

Repère limité pour un futur adaptateur : Spotify fournit un
[Web Playback SDK](https://developer.spotify.com/documentation/web-playback-sdk), un
[compte Premium requis](https://developer.spotify.com/documentation/web-playback-sdk/tutorials/getting-started),
une [position `progress_ms` éventuellement nulle](https://developer.spotify.com/documentation/web-api/reference/get-information-about-the-users-current-playback)
et un [transfert de lecture](https://developer.spotify.com/documentation/web-api/reference/transfer-a-users-playback)
avec `user-modify-playback-state`. Ce sont des capacités explicitement documentées, sans garantie
de synchronisation exacte. Leur existence ne valide pas notre usage : la
[politique Spotify, III.4–5](https://developer.spotify.com/policy) restreint la diffusion non
interactive et l'intégration avec le contenu d'autres services ; le SDK impose aussi des
restrictions commerciales. Aucun connecteur Spotify ni accord d'usage n'est validé ici.

## Options concrètes et validation restante

| Option | Conséquence visible | État |
| --- | --- | --- |
| Continuer YouTube IFrame et la chronologie neutre | Vidéo visible, geste de lecture parfois nécessaire, disponibilité/publicités par participant ; aucun abonnement requis par le salon. | Chemin existant ; recommandé maintenant. |
| Examiner les avantages Premium déjà présents dans le navigateur | Éventuel bénéfice selon compte, offre et cookies ; pas de bouton de connexion Music garanti. | Essai avec comptes requis, sans extraction de cookies. |
| Ouvrir/partager Music à un instant | L'utilisateur gère l'app et la lecture ; sortie du contrôle continu du salon. | Fonction de partage officielle ; intégration au salon non réalisée. |
| Attendre un contrat public Music ou un accès partenaire documenté | Reporter la connexion abonnée et la reprise exacte, conserver le reste du produit. | Prérequis documentaire manquant. Une extension/app native changerait le périmètre, sans créer à elle seule des droits ou API. |

**Vérifié pour Music connecté : documentation uniquement.** Aucun compte connecté, avantage
observé, refresh ou transfert exécuté. Aucun prototype : un exemple IFrame ne prouverait que
YouTube ordinaire ; aucun chemin documenté identifié ne permet une preuve du connecteur Music.

**Minimum d'essai dépendant de comptes, non exécuté :** dans un environnement de test autorisé,
utiliser des comptes existants distincts sans abonnement, Music Premium seul et YouTube Premium,
sans achat ni collecte de secrets. Sur une même vidéo intégrable, comparer navigateur connecté et
cookies tiers autorisés/bloqués, puis activation locale, pause/seek et arrivée tardive de deux
participants. Relever seulement offre déclarée, navigateur, erreurs et écarts horodatés ; l'absence
ponctuelle de publicité ne prouve pas un droit Premium. Cet essai peut valider un comportement
d'embed, jamais à lui seul un contrat Music.

Pour rouvrir la promesse complète, exiger d'abord une interface fournisseur documentée et un accès
de test : deux comptes personnels, commande et observation de chaque lecteur, reprise à un point
connu dans les deux sens web/app, tolérance mesurée définie au préalable, puis expiration,
renouvellement et révocation pendant une occurrence. Séparer ces résultats de ceux d'un simple
consentement aux playlists. L'[aide Music](https://support.google.com/youtubemusic/answer/9027741?hl=en)
limite l'écoute musicale simultanée à un appareil par compte : tester le passage entre appareils
sans le confondre avec deux écoutes indépendantes.

**Prochain pas recommandé au parent :** livrer la chronologie et le comportement YouTube existant,
réserver ces frontières et traiter Music connecté comme recherche non validée. L'absence actuelle
de contrat de lecture/handoff est un blocage documentaire, pas une demande de permission ni une
raison de suspendre le travail neutre.
