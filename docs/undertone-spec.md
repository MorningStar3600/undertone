# Undertone — spécification produit et évolution du code existant

Version du 9 novembre 2026. Base examinée : fork OpenTogetherTube, commit `2f6ac02523fe`, ainsi que les maquettes interactives réalisées dans cette conversation.

Undertone transforme les rooms synchronisées d’OpenTogetherTube en espaces d’écoute musicale partagée. Les utilisateurs apportent des morceaux issus de sources différentes, les annotent personnellement avec des moods, construisent ensemble une sélection et partagent équitablement les passages.

Cette spécification décrit la cible à développer dans le dépôt existant. Les maquettes HTML servent de référence d’interaction ; elles ne constituent pas une implémentation du serveur, de la persistance ou du moteur de sélection.

**Statut des règles :** les exigences exprimées par l’utilisateur sont formulées comme des obligations. Les détails nécessaires mais non explicitement décidés portent la mention **Proposition**. Les derniers échanges prévalent sur les versions antérieures des maquettes.

## 1. Décisions structurantes

- Nom du projet : **Undertone**. Le nom Moodroom n’est plus retenu.
- Base : fork personnel [MorningStar3600/undertone](https://github.com/MorningStar3600/undertone), issu de [dyc3/opentogethertube](https://github.com/dyc3/opentogethertube).
- Réutiliser le client Vue, le serveur Node, les rooms, les lecteurs, la synchronisation, les comptes et les permissions existants.
- Séparer l’identité musicale du morceau, ses sources de lecture, ses annotations personnelles et ses occurrences dans une room.
- Chaque occurrence musicale a une personne qui l’apporte ; cette provenance sert au fair share, quelle que soit la source.
- Dans les filtres de room : **OU pour les moods d’une personne, ET entre les personnes, exclusions globales**.
- Pour les inclusions, examiner uniquement les annotations de l’apporteur. Pour les exclusions, examiner les annotations de tous les participants présents.
- Les ajouts manuels ignorent les inclusions. Une exclusion déclenche une confirmation explicite, pas un refus définitif ; la personne peut ajouter le morceau malgré cet avertissement.
- Chaque changement pertinent de moods recalcule et mélange la file commune, sans effacer l’historique.
- La file automatique est courte. Les ajouts manuels peuvent dépasser son plafond et suspendent alors le remplissage automatique.
- Le lecteur reste en bas sur téléphone et ordinateur ; lecture, changement de titre et volume priment sur les commandes de moods.
- L’application PC est reportée. La présence Discord est une évolution ultérieure, pas un prérequis de cette version.

## 2. Point de départ réel dans OpenTogetherTube

### 2.1 Ce qui existe et doit être réutilisé

| Élément existant | Comportement constaté | Évolution attendue |
| --- | --- | --- |
| [`common/models/video.ts`](../common/models/video.ts) | `VideoId = { service, id }` ; `Video` porte les métadonnées ; `QueueItem` ajoute notamment `startAt`, `endAt`, `subtitleUrl`. | Introduire une identité de morceau et une identité d’occurrence sans perdre les références fournisseur et les options de lecture. |
| [`server/serviceadapter.ts`](../server/serviceadapter.ts), [`server/infoextractor.ts`](../server/infoextractor.ts) | Adaptateurs par fournisseur, résolution des URL, collections et récupération des métadonnées. | Les conserver comme couche d’accès aux sources ; ajouter une résolution vers le catalogue musical. |
| [`server/services/direct.ts`](../server/services/direct.ts) | Lecture de médias directs, prise en charge audio dont MP3, métadonnées via ffprobe ; rejet explicite de `file:`. | Ajouter une bibliothèque locale publiée de manière contrôlée par le serveur ; un chemin sur le PC de l’utilisateur n’est pas une source partagée. |
| [`server/videoqueue.ts`](../server/videoqueue.ts) | Tableau ordonné, mutex sur les mutations, `enqueue`, `dequeue`, `pushTop`, `move`, `shuffle`. Recherche d’éléments par `service + id`. | Conserver les primitives, passer les opérations métier à `entryId`, et ajouter un ordonnanceur au-dessus de cette file. |
| [`server/room.ts`](../server/room.ts) | `Room.update()` détecte la fin à partir de la position serveur ; `dequeueNext()` avance ; `joinRoom()` et `leaveRoom()` suivent la présence. | Brancher la sélection équitable, les changements de composition et l’historique dans ces points existants. |
| [`common/models/messages.ts`](../common/models/messages.ts) | Requêtes typées d’ajout, de lecture, de changement d’ordre, de shuffle et messages `sync`. | Étendre ce protocole ; ne pas créer une seconde synchronisation indépendante. |
| [`client/src/stores/room.ts`](../client/src/stores/room.ts) | État Vuex avec `currentSource`, `queue`, `isPlaying`, `playbackPosition`, `playbackSpeed`. | Ajouter la sélection collective, la provenance, les paramètres et la révision du plan. |
| [`client/src/components/players/OmniPlayer.vue`](../client/src/components/players/OmniPlayer.vue) | Sélection du lecteur YouTube, Vimeo, direct, HLS, DASH, etc. | Recevoir la source résolue du morceau, sans réécrire tous les lecteurs. |
| [`client/src/components/composables/media-player.ts`](../client/src/components/composables/media-player.ts) | Contrat de lecture, pause, position et volume ; gestion du volume personnel déjà présente. | Réutiliser ce contrat pour les contrôles persistants et les capacités de chaque source. |
| [`client/src/views/Room.vue`](../client/src/views/Room.vue) | Composition du lecteur, des contrôles, du chat, de la file, des ajouts et réglages. | Réorganiser cette vue autour d’un lecteur bas et d’une file courte. |
| [`server/models/index.ts`](../server/models/index.ts) | Sequelize, SQLite ou PostgreSQL ; modèles `Room`, `User`, `CachedVideo`. | Ajouter les modèles musicaux et les migrations dans le système existant. |
| [`docs/synchronization.md`](synchronization.md) | État de room synchronisable et stockable, restauration via Redis. | Étendre explicitement les champs persistés ; ne pas confondre présence temporaire et données musicales durables. |

### 2.2 Écarts importants à traiter

1. `QueueItem` ne possède actuellement ni `trackId`, ni `entryId`, ni apporteur durable, ni origine manuel/mood.
2. Le shuffle actuel utilise un mélange uniforme de la file. Il ne tient compte ni des écoutes passées ni des comptes par personne.
3. `prevQueue` représente une file sauvegardée pour restauration, **pas l’historique des titres effectivement joués**.
4. `playNow()` interrompt actuellement le titre et remet le titre interrompu dans la file. Ce comportement ne correspond pas au nouveau choix « juste après le morceau en cours ».
5. Les modes actuels sont `Manual`, `Vote`, `Loop` et `Dj`. Le mode `Dj` répète le titre courant ; ce n’est pas le fair share demandé.
6. Les identités de connexion `ClientId` ne suffisent pas pour des favoris, des annotations et des compteurs persistants par personne.
7. `CachedVideo` est un cache de métadonnées fournisseur. Il ne doit pas devenir, par simple renommage, la bibliothèque durable des utilisateurs.
8. La connexion Discord actuelle demande `identify` dans [`server/app.ts`](../server/app.ts). Elle n’est pas une intégration Rich Presence.

## 3. Morceaux, sources et bibliothèques

### 3.1 Identité du morceau

Un `Track` désigne un enregistrement musical : titre, artiste ou artistes, durée de référence, illustration et éventuellement styles musicaux. Son identité ne dépend pas d’un lien YouTube ou d’un chemin de fichier.

Un `TrackSource` désigne une manière de lire ce morceau : fournisseur, identifiant fournisseur, URL ou référence de stockage, état de disponibilité et caractéristiques de lecture.

Un même morceau peut avoir plusieurs sources. Une file peut enchaîner un fichier local, un titre YouTube puis un autre fichier sans changer sa logique de moods ou de fair share. Les annotations et l’historique s’attachent au morceau, pas à l’URL utilisée ce jour-là.

**Proposition :** ne pas fusionner automatiquement deux enregistrements sur le seul titre. Un live, un remix et une version studio peuvent être des morceaux distincts. Créer d’abord une identité par source, puis permettre des rapprochements fiables ou explicites. Le passage d’une source à une autre ne doit pas provoquer un décalage de synchronisation entre deux versions différentes.

### 3.2 Bibliothèque personnelle et apport à une room

La bibliothèque relie une personne à des morceaux qu’elle peut apporter. Être dans sa bibliothèque, avoir un tag `like`, avoir un mood favori et contribuer à la room sont quatre états distincts.

Une occurrence dans la file porte exactement un `contributorId`. Si deux personnes possèdent le même morceau, le moteur choisit l’apporteur de cette occurrence selon l’équité. Il ne crédite pas simultanément les deux personnes.

Changer de source de lecture ne change pas cet apporteur. Le propriétaire technique du stockage et l’auteur d’une recommandation ne deviennent pas automatiquement l’apporteur.

### 3.3 Stockage local et autonomie

L’objectif est de pouvoir utiliser Undertone avec une bibliothèque maîtrisée et sans rendre le cœur de l’application dépendant de YouTube ou d’un service tiers particulier.

Pour une écoute partagée, un fichier local doit être accessible aux lecteurs autorisés, généralement par le serveur de stockage de l’instance. Un fichier présent uniquement sur l’appareil de X n’est pas lisible par Y sans mécanisme explicite de mise à disposition.

**Proposition :** ajouter un indexeur de répertoire et un endpoint de médias avec contrôle d’accès, prise en charge des requêtes partielles et identifiants de fichiers opaques. Ne jamais exposer directement les chemins du disque dans le protocole de room.

### 3.4 Playlists et synchronisation quotidienne

Le besoin initial comprend un job quotidien capable de synchroniser une bibliothèque locale à partir d’une playlist. Il faut distinguer :

- la synchronisation des références et métadonnées d’une playlist ;
- l’acquisition de fichiers audio, uniquement pour les contenus et moyens d’accès autorisés ;
- l’indexation de fichiers déjà disponibles dans le stockage personnel.

L’import d’une playlist ne doit pas ajouter tous ses morceaux à la file de room. Il enrichit une bibliothèque ; le moteur de room prélève ensuite un petit ensemble adapté aux règles.

**Proposition :** job idempotent avec curseur de synchronisation, rapport d’ajouts/indisponibilités, reprise sur erreur et absence de doublons. La disparition d’un titre de la playlist ne supprime pas automatiquement un fichier personnel ou ses annotations. La politique de suppression est un réglage séparé à décider.

L’extraction systématique de toute playlist YouTube vers MP3 n’est pas un prérequis validé de cette version. Les premières questions exploraient cette possibilité ; le produit retenu repose sur l’abstraction de sources et sur des usages autorisés.

## 4. Moods personnels et favoris

### 4.1 Vocabulaire commun, annotations personnelles

Chaque mood a un identifiant stable, un nom et une icône. Valeurs par défaut : `like`, `focus`, `energetic`, `happy`, `sad`.

Les utilisateurs peuvent créer des moods depuis l’interface. `epic`, `dreamy` ou `chill` sont des exemples supplémentaires, pas de nouveaux defaults imposés.

Une personne peut attribuer plusieurs moods à un morceau. Ses annotations sont indépendantes de celles des autres personnes. Retirer son tag ne retire jamais celui de l’apporteur ou d’un autre utilisateur.

**Proposition :** vocabulaire partagé dans l’instance, avec unicité du nom normalisé et référence par identifiant. Renommer ou changer une icône ne casse pas les annotations. Définir une permission de gestion pour éviter qu’un utilisateur renomme les moods communs arbitrairement.

### 4.2 Favoris

Chaque utilisateur possède une sélection personnelle de moods favoris, éditable dans un espace « Mes favoris ». Un favori est un raccourci d’annotation, pas une annotation ni un filtre de room.

- Mettre `focus` en favori ne tague aucun morceau.
- Retirer `focus` des favoris conserve les annotations déjà faites.
- Les favoris d’X ne changent pas ceux d’Y.
- Les favoris persistent entre les sessions et les rooms.

### 4.3 Deux groupes d’icônes sur le lecteur

Pour un morceau `t`, un apporteur `a` et la personne connectée `v` :

```text
Groupe prioritaire = tags(a, t)
Groupe complémentaire = (tags(v, t) ∪ favoris(v)) − tags(a, t)
Bouton actif(m) = m ∈ tags(v, t)
```

Le premier groupe affiche les moods de l’apporteur. Leur présence ne les rend pas automatiquement actifs pour la personne connectée. Le second affiche les autres tags de cette personne et ses favoris restants, sans doublon entre les deux groupes.

Les boutons actifs sont bleus, avec un état accessible qui ne repose pas uniquement sur la couleur. Le nom apparaît au survol et au focus. Le bouton `+` permet de rechercher et d’ajouter n’importe quel mood, ou d’en créer un.

Exemple : X apporte un titre tagué `energetic`, `like`. Y l’a tagué `like`, `dreamy` et a `focus`, `like` en favoris. Y voit `energetic` inactif et `like` actif dans le premier groupe ; `dreamy` actif et `focus` inactif dans le second.

Au changement de morceau, ces groupes sont entièrement recalculés. Les annotations du morceau précédent sont conservées, sans être recopiées sur le suivant.

## 5. Règle collective de la room

### 5.1 Expression

Chaque participant `u` possède des moods inclus `Iu` et exclus `Eu`. La sélection est :

```text
(x1 OU x2) ET (y1 OU y2 OU y3) SANS (exclusionX OU exclusionY)
```

L’éditeur de groupes booléens arbitrairement imbriqués envisagé précédemment est remplacé par cette construction collective simple. L’interface n’a pas à présenter de parenthèses éditables ou d’arbre logique.

Soient `P` les participants présents, `a` l’apporteur et `T(u,t)` les tags attribués par `u` au morceau `t` :

```text
InclusionsOK(t,a) = pour tout u dans P : Iu est vide OU Iu ∩ T(a,t) ≠ ∅
ExclusionsGlobales = union des Eu pour u dans P
TagsPourExclusion(t) = union des T(u,t) pour u dans P
ExclusionsOK(t) = ExclusionsGlobales ∩ TagsPourExclusion(t) = ∅
AdmissibleAutomatiquement(t,a) = source utilisable ET InclusionsOK(t,a) ET ExclusionsOK(t)
```

Cette formalisation s’applique aux sélections automatiques. L’admission manuelle suit la section 10.3 : aucune exigence d’inclusion, et confirmation en cas d’exclusion. Dans la suite, une occurrence « admissible » est évaluée selon son origine, automatique ou manuelle.

Les exclusions utilisent les annotations des participants présents. Les utilisateurs absents ne participent pas automatiquement aux exclusions de la room.

Une personne sans inclusion n’impose aucune restriction positive. Ses exclusions continuent à s’appliquer. Un mood ne peut pas être à la fois inclus et exclu par la même personne ; le dernier choix remplace son état précédent.

### 5.2 Exemple de veto

Y apporte un morceau auquel Y a donné `energetic` et `like`. X a donné `epic` à ce même morceau. Si `epic` est exclu par un participant présent, le morceau est exclu des sélections automatiques, même si Y ne lui a pas donné `epic`. Si Y le demande manuellement, l’interface affiche l’avertissement et lui permet de confirmer l’ajout.

En revanche, un tag positif de X ne complète pas les tags de Y pour satisfaire les inclusions : il faut que les tags de Y satisfassent tous les groupes d’inclusions.

### 5.3 Interface de sélection

- Chaque personne modifie ses propres préférences de room.
- Clic gauche : inclure ou retirer une inclusion.
- Clic droit : exclure ou retirer une exclusion.
- Sur écran tactile et au clavier : fournir une action d’exclusion explicite équivalente.
- Afficher les choix des participants et une règle de salle calculée, en lecture seule.
- Les moods restent représentés par leurs icônes, avec noms accessibles.

Une sélection positive peut être neutralisée par l’exclusion d’un autre participant. Conserver les choix personnels, mais afficher qu’aucun morceau automatique n’est disponible si la combinaison ne peut pas être satisfaite. Les ajouts manuels restent possibles selon leur parcours de confirmation.

La liste « À suivre » ne contient que les morceaux admis : titres automatiques compatibles et ajouts manuels, y compris ceux confirmés malgré une exclusion. Ne pas afficher de liste des titres rejetés ou du panneau de démonstration « écarté pour epic » des anciennes maquettes. L’avertissement demandé lors d’un ajout manuel est présenté dans le dialogue de confirmation de cette action.

### 5.4 Changements et reshuffle partagé

Un changement d’inclusion, d’exclusion ou d’annotation ayant un effet sur l’admissibilité entraîne une réévaluation côté serveur, suivie d’un reshuffle commun tenant compte de l’historique et du fair share. Le nouvel état est envoyé à tous les clients.

Changer uniquement un favori ne déclenche aucun reshuffle.

Le morceau déjà en cours continue ; ce changement porte sur les morceaux à venir. L’historique et les compteurs ne sont jamais réinitialisés par un changement de moods.

Le choix initial « garder les chansons à venir ou non » concerne le contenu retenu, pas la conservation stricte de l’ordre. **Proposition de conciliation :** « garder » conserve les occurrences automatiques encore compatibles puis recalcule leur ordre ; « renouveler » remplace les propositions automatiques. Les ajouts manuels ne sont jamais retirés pour une incompatibilité d’inclusion. Leurs confirmations d’exclusion sont conservées lors des reshuffles ; les nouveaux conflits éventuels suivent la section 10.3.

## 6. Composition dynamique de la room

Quand Y rejoint X, les règles de Y participent à l’expression et sa bibliothèque devient une source de candidats. Ses morceaux sont intercalés régulièrement lorsque le réglage de room correspondant est activé, ce qui est le défaut demandé.

Quand Y quitte la room, ses règles et ses exclusions cessent de participer. Par défaut, ses morceaux à venir sont retirés. Une option de room permet de conserver ses occurrences déjà présentes ; cela n’autorise pas le renouvellement automatique de sa bibliothèque après son départ.

Le titre en cours n’est pas interrompu au départ de son apporteur. L’historique conserve son identité et ses passages.

**Proposition :** en cas de conservation des titres d’un utilisateur parti, garder un apporteur historique temporairement éligible uniquement pour ces occurrences. Il conserve son compteur et disparaît de l’ordonnanceur une fois ses occurrences épuisées. Ses préférences de room restent retirées.

Plusieurs connexions du même compte représentent un seul participant pour le fair share, les règles et le calcul de la taille cible. Un départ n’a lieu qu’après disparition de toutes ses connexions à la room.

**Proposition :** une courte période de grâce de reconnexion évite de retirer puis réinjecter la bibliothèque sur une coupure réseau. Les invités déjà supportés par OTT gardent une identité de session ; la persistance personnelle entre appareils nécessite un compte.

## 7. Taille de file et ajouts manuels non plafonnés

### 7.1 Plafond du remplissage automatique

`N` est le nombre de personnes présentes, pas le nombre de connexions, et `Q(N)` le seuil de remplissage automatique. Le titre courant n’entre pas dans la taille de la file à venir.

| Personnes | Q(N) | Répartition de référence quand les historiques sont équilibrés |
| --- | ---: | --- |
| 1 | 10 | 10 |
| 2 | 10 | 5 chacune |
| 3 | 9 | 3 chacune |
| 4 | 12 | 3 chacune |
| 5 | 10 | 2 chacune |
| 6 | 12 | 2 chacune |
| 7 | 14 | 2 chacune |
| 8 | 8 | 1 chacune |
| 9 | 9 | 1 chacune |
| 10 et plus | 10 | Horizon commun de 10 ; les participants tournent au fil des passages |

À zéro participant, suspendre le remplissage. Une bibliothèque insuffisante peut produire une file plus courte ; ne pas ajouter de titres incompatibles pour atteindre le seuil.

Ces répartitions servent de référence en situation équilibrée. Le fair share doit pouvoir corriger l’historique ; les ajouts manuels ne sont pas soumis à un quota de cinq titres en duo ou de trois en trio.

### 7.2 Précision déterminante sur le dépassement

Les ajouts manuels sont **non plafonnés par Q(N)**. Ils augmentent la file réelle, même lorsqu’elle atteint déjà le seuil.

```text
placesAutomatiques = max(0, Q(N) − nombreTotalDeTitresÀVenir)
```

Le total compte les occurrences manuelles et automatiques, y compris celles demandées pour le prochain passage. Aucun nouveau titre automatique ne peut être ajouté lorsque ce total est supérieur ou égal à `Q(N)`.

Exemple : en duo, 10 titres sont prévus et X en ajoute 4 à la main. La file passe à 14 ; aucun titre automatique supplémentaire n’est ajouté. Elle descend à 13, 12, 11, puis 10 : toujours aucun ajout automatique. À 9, le moteur peut ajouter un titre compatible pour revenir à 10.

Un ajout manuel ne supprime pas automatiquement quatre propositions déjà présentes pour rester artificiellement à 10. Ne pas contourner le seuil en fabriquant un titre automatique au moment même de sa lecture lorsque la file est encore pleine.

Un reshuffle ne doit pas supprimer artificiellement des éléments admissibles d’une file saturée pour créer de la place et produire de nouveaux titres. L’invalidation réelle par les règles peut en revanche libérer de la place.

**Proposition :** si `Q(N)` diminue lors d’une arrivée ou d’un départ, conserver les occurrences admissibles existantes et suspendre le remplissage jusqu’au retour sous le nouveau seuil. Retirer les apports des personnes parties selon la politique de room.

### 7.3 File réelle et aperçu compact

L’interface affiche en priorité un horizon court. Si des ajouts manuels portent le total au-delà du seuil, afficher le nombre total et un accès « Voir tous les ajouts » avec pagination ou virtualisation. L’aperçu court ne doit jamais faire croire que les autres demandes ont été perdues.

Le plafond de génération n’est ni une limite globale d’ajout manuel, ni une obligation de transmettre et de rendre des milliers de lignes à chaque mise à jour.

## 8. Fair share et choix de la personne suivante

### 8.1 Fair share activé

Le fair share est un paramètre de room. **Proposition de valeur par défaut : activé.**

Chaque participant possède un score de passages. Plus il a déjà fait jouer de morceaux, plus son score est élevé. Lors du choix d’un passage ordinaire :

1. Déterminer les personnes qui peuvent effectivement proposer un titre admissible dans les conditions de remplissage actuelles.
2. Trouver le score minimal parmi ces personnes.
3. Choisir au hasard, uniformément, l’une des personnes ayant ce minimum.
4. Choisir son morceau selon les demandes manuelles et les règles de récence/diversité.
5. À son démarrage effectif, augmenter le score de son apporteur d’une unité.

Le score porte sur le **nombre de morceaux**, pas leur durée. Un titre long et un titre court comptent chacun pour un passage, conformément au besoin exprimé.

Tous les passages comptent : ajout manuel normal, ajout demandé pour le prochain passage, sélection par mood et morceau issu d’une recommandation.

Exemple : X a un score de 4, Y un score de 0. Si Y dispose de suffisamment de titres admissibles et que la politique de remplissage permet de les proposer, les passages ordinaires rattrapent d’abord le retard de Y. Lorsque les scores sont égaux, les égalités sont départagées aléatoirement.

Une personne sans candidat admissible est momentanément ignorée, sans augmenter artificiellement son compteur. Le moteur ne s’arrête pas parce que la personne au score le plus bas n’a rien à proposer.

Quand la file dépasse son plafond, les candidats sont les occurrences déjà admises dans cette file : l’équité n’autorise pas à produire de nouveaux titres automatiques en violation du seuil. Si seuls des ajouts de X subsistent, ils peuvent être lus ; la dette de X reste enregistrée pour les futurs choix.

### 8.2 Compteurs réels et simulation de la file

Le serveur conserve deux notions séparées :

- **compteur réel** : passages effectivement commencés dans la room ;
- **compteur projeté** : copie temporaire utilisée pour prévoir l’ordre des prochains passages.

Lors de la construction d’une file prévisionnelle, le serveur augmente les scores projetés après chaque choix simulé. Il ne touche jamais aux compteurs réels pour cette opération.

À la fin d’un morceau, il revalide le prochain passage à partir de l’historique réel. Si aucun événement pertinent n’est intervenu, le premier titre affiché doit rester celui qui démarre : ne pas effectuer un second tirage indépendant et surprenant au dernier instant. Si l’état a changé, publier d’abord un nouveau plan cohérent.

Un client ne tire pas sa propre séquence. Tous les auditeurs reçoivent la même file et la même occurrence courante.

### 8.3 Fair share désactivé

Le moteur passe en **tour de rôle stable** : personne 1, personne 2, … personne N, puis retour à la première. La référence « 1 à 10 » n’exclut pas les personnes au-delà de la dixième : le seuil de 10 concerne l’horizon, pas le nombre de personnes pouvant contribuer.

Dans ce mode, les passages manuels supplémentaires ne donnent ni dette ni compensation dans l’ordre du tour de rôle. Le système continue cependant à enregistrer tous les passages dans l’historique.

**Proposition :** un ajout manuel ordinaire est pris au tour de son auteur. Une priorité explicite « jouer ensuite » passe hors tour et ne déplace pas le curseur du tour de rôle. Sans cela, demander un titre prioritaire modifierait indirectement le tour suivant des autres personnes.

Ignorer temporairement les personnes sans candidat ; reprendre leur place normale dès qu’elles peuvent contribuer. Conserver un ordre de participants stable pendant la session, au lieu de le recalculer à chaque rendu client.

### 8.4 Arrivées, départs et sessions

Un reshuffle, une reconnexion ou le changement d’un mood ne remet pas les scores à zéro. Un départ suivi d’un retour ne permet pas d’effacer sa dette.

**Proposition à valider :** pour une personne qui rejoint pour la première fois une session déjà avancée, initialiser un score de référence au minimum des participants présents, sans créer de fausses écoutes. Son score devient `baseÀLArrivée + passagesRéelsDepuisLArrivée`. Cette normalisation évite qu’un nouvel arrivant récupère à lui seul des centaines de passages de rattrapage.

La durée de vie d’une session d’équité reste un choix produit : room permanente, session d’écoute réinitialisée explicitement, ou redémarrage après une longue période vide. Par défaut proposé, persister la session et ne permettre sa remise à zéro que par une action de gestion explicite. L’historique musical peut être conservé indépendamment de cette remise à zéro.

## 9. Historique et hasard pondéré par la récence

### 9.1 Historique à conserver

Chaque passage est un événement avec un identifiant unique, une room, une session, un morceau, une source réellement utilisée, un apporteur, une origine manuel/mood/recommandation, un instant de démarrage et un état de fin.

Enregistrer également la cause de fin lorsqu’elle est connue : terminé, passé par l’utilisateur, interrompu par une commande autorisée, erreur de lecture.

**Proposition de comptabilisation :** compter une fois lorsque la lecture de l’occurrence commence côté serveur. Charger le prochain titre en pause ne compte pas encore. Pause/reprise, seek, reconnexion et changement de source de secours ne créent pas de nouveau passage. Un échec avant le démarrage ne compte pas ; un titre commencé puis passé compte. Les erreurs tardives ne doivent pas provoquer de décrément répété.

Les confirmations de plusieurs clients et les répétitions de messages ne doivent jamais compter plusieurs fois le même `playbackId`.

L’historique musical est indexé par `trackId`, de sorte qu’un titre récemment joué depuis YouTube reste récent si sa prochaine source est locale.

### 9.2 Probabilité de retour

La récence est une pénalité probabiliste, pas une interdiction permanente. Une petite bibliothèque doit pouvoir continuer à jouer après avoir été parcourue.

Plus un morceau a été joué récemment, plus son poids de sélection automatique est faible. Un morceau jamais joué bénéficie d’un poids élevé. Le changement de moods conserve ces informations.

**Proposition de formule initiale, à calibrer par simulation :**

```text
d(t) = nombre de passages de room depuis le dernier démarrage de t
wRécence(t) = ε + (1 − ε) × (1 − exp(−d(t) / τ))
jamais joué : wRécence(t) = 1
ε = 0,02 ; τ = 10 passages
```

Avec cette formule, le dernier titre a un poids de 0,02 ; un titre plus ancien tend progressivement vers 1. Le tirage utilise des poids normalisés parmi les candidats, sans tri déterministe imposant toujours le plus ancien.

Ces constantes ne sont pas des décisions utilisateur. Les tests doivent vérifier la monotonie du poids et une distribution cohérente ; ils ne doivent pas imposer une séquence aléatoire unique en production.

### 9.3 Artistes et styles

Après avoir choisi l’apporteur, essayer de choisir un artiste différent du passage précédent. S’il existe plusieurs artistes sur un titre, considérer leur intersection pour éviter de répéter le même artiste sous un autre crédit.

Si plusieurs styles sont disponibles dans la sélection, favoriser leur répartition au fil des passages. Les styles musicaux sont des métadonnées distinctes des moods : un titre peut être `focus` et appartenir à plusieurs styles, sans que ses tags représentent des genres musicaux.

L’ordre des priorités est : admissibilité et source utilisable, priorité manuelle explicitement réservée, équité de l’apporteur, choix manuel ordinaire, puis diversité/récence pour les choix automatiques.

La variété ne justifie pas de faire systématiquement passer un apporteur déjà en avance. S’il n’existe qu’un artiste admissible pour la personne retenue, autoriser la répétition plutôt que bloquer la room.

**Proposition :** éviter les doublons automatiques d’un même `trackId` dans l’horizon prévisionnel et éviter de reprendre immédiatement le titre courant s’il existe une alternative pour l’apporteur retenu. Si la bibliothèque est trop petite, garder un horizon plus court et remplir après les passages ; ne pas mettre une liste noire définitive des morceaux déjà joués.

## 10. Ajouts manuels et priorité de passage

### 10.1 Deux intentions explicites

L’interface d’ajout propose :

- **Ajouter au mix** : mémoriser la demande et la servir au tour de son apporteur, en respectant le fair share ou le tour de rôle.
- **Jouer ensuite** : réserver le prochain passage après le morceau courant. Ne pas interrompre celui-ci.

Une demande manuelle ordinaire doit être prioritaire sur un nouveau tirage automatique au prochain tour de la même personne. Elle ne doit pas être placée simplement après des centaines de morceaux d’autres personnes dans une FIFO globale.

**Proposition :** traiter les demandes ordinaires d’une même personne dans l’ordre de leur demande. Un ajout « jouer ensuite » est une exception explicite à l’ordre entre apporteurs ; dès qu’il commence, il compte exactement comme tout autre morceau. Avec fair share actif, les passages suivants compensent l’avance créée.

### 10.2 Réservation du prochain passage

**Proposition :** un seul créneau « prochain passage » est réservé par frontière de lecture. Si deux demandes arrivent ensemble, la première acceptée par le serveur conserve ce créneau. La seconde reçoit le conflit et peut être ajoutée au mix ou réservée ultérieurement ; ne pas lui promettre silencieusement le prochain titre.

Cette règle limite la promesse de priorité, pas le nombre d’ajouts manuels. Elle empêche aussi qu’une nouvelle demande repousse continuellement celle qui avait déjà été acceptée.

La suppression, une source devenue inutilisable ou le départ de l’apporteur selon la politique de room peut annuler une réservation. Un conflit d’exclusion non encore confirmé suit la section 10.3 ; une inclusion ne peut pas invalider un ajout manuel. Le client concerné reçoit le résultat de son opération. Les permissions existantes continuent de décider qui peut gérer la file et demander une priorité.

### 10.3 Compatibilité avec les moods

**Règle confirmée : les inclusions ne bloquent jamais un ajout manuel.** Un titre sans mood, ou ne correspondant à aucun des moods sélectionnés, peut être ajouté au mix ou demandé pour le prochain passage. Il n’est pas nécessaire de modifier ses annotations ou les préférences de la room.

Si le morceau correspond à une exclusion active, afficher un dialogue avant de finaliser son admission. Exemple : « Léa a exclu le mood epic, et cette musique en fait partie. Voulez-vous quand même l’ajouter ? » Proposer **Annuler** et **Ajouter quand même**. La personne citée est celle qui a posé l’exclusion dans la room ; elle peut être différente de celle qui a attribué ce mood au morceau.

Si plusieurs personnes ou moods sont concernés, regrouper tous les conflits dans une seule confirmation. L’examen des tags reste identique à celui des exclusions automatiques : considérer les annotations de tous les participants présents.

- Aucun conflit : accepter l’ajout sans confirmation liée aux moods.
- Confirmation acceptée : admettre cette occurrence malgré les exclusions signalées.
- Annulation : ne pas ajouter l’occurrence et ne pas réserver le prochain passage.
- Confirmation encore ouverte : conserver une intention temporaire, sans occurrence active, place de file ou incrément de fair share.

La confirmation vaut pour cette demande et ce morceau. Elle ne retire aucun mood, ne change aucune préférence de room, et ne rend pas le morceau admissible aux tirages automatiques. Une autre demande manuelle indépendante doit être examinée à son tour. Une répétition technique de la même requête confirmée ne crée pas une deuxième occurrence.

Une fois admis, le titre manuel compte dans la taille réelle de la file, le fair share et l’historique exactement comme les autres. Il conserve son origine manuelle et la trace de la confirmation ; un reshuffle, une projection ou un repli vers une source équivalente ne doit ni le retirer pour ces mêmes exclusions ni redemander la même confirmation.

**Proposition pour un conflit apparu après l’ajout :** seuls les nouveaux conflits d’exclusion non couverts par la confirmation existante demandent une nouvelle confirmation. La demande est conservée, temporairement en attente hors file active, puis réadmise si son auteur confirme. Un changement d’inclusions ou une modification sans nouveau conflit ne déclenche jamais ce parcours. Si les conflits disparaissent avant la réponse, la demande peut être admise sans cette confirmation.

Les règles d’accès à la room, les permissions et la disponibilité technique de la source restent applicables ; elles ne constituent pas des filtres de moods. La confirmation autorise une exception de sélection musicale, pas une élévation de permissions.

Les morceaux choisis manuellement alimentent le même historique de récence. Leur sélection explicite n’est cependant pas un tirage probabiliste : une demande de répétition autorisée ne doit pas être silencieusement remplacée par un autre morceau.

### 10.4 Délai et absence de promesse impossible

Afficher la position prévisionnelle d’une demande admise plutôt qu’une garantie en minutes, car les durées, arrivées, départs et nouveaux choix modifient la prévision.

Le fair share strict peut faire attendre une personne déjà très en avance. Une quantité manuelle non plafonnée peut également créer un long arriéré chez un même utilisateur. Aucune durée maximale universelle n’est possible sans une règle supplémentaire.

Le chemin garanti pour demander un passage proche est « jouer ensuite », sous réserve que le créneau soit libre, que le titre soit admissible et que la personne ait la permission. Une garantie de délai automatique pour tous les ajouts ordinaires reste à décider ; ne pas inventer un quota caché ou une exception automatique au fair share.

## 11. Planification serveur et événements

### 11.1 Responsabilité du serveur

Le serveur de room reste l’unique autorité. Il choisit l’apporteur, la musique, l’occurrence, la source et l’ordre. Le client exprime des intentions et rend l’état accepté.

Le mutex de `VideoQueue` protège des mutations individuelles ; il ne suffit pas à rendre atomique « modifier les règles, examiner l’historique, choisir un titre, enregistrer son passage et publier la file ». Ajouter une sérialisation des transitions métier au niveau de la room, sans attendre les requêtes réseau lentes sous le verrou.

**Proposition d’algorithme de planification :**

```text
prendre un instantané versionné de la room, des annotations et des candidats
revalider les occurrences automatiques selon les inclusions et exclusions
revalider les demandes manuelles sans inclusions et avec leurs confirmations d’exclusion
retirer de la file active les seules occurrences non admises selon leur origine
préserver les demandes manuelles et les réservations valides
calculer les places automatiques depuis la taille réelle de la file
copier les scores réels et le curseur de tour de rôle
placer la réservation « jouer ensuite », si elle existe, et simuler son passage
tant qu’il reste des occurrences à ordonner ou des places automatiques à remplir :
    déterminer les apporteurs ayant un candidat autorisé
    tirer un apporteur au score projeté minimal, ou suivre le tour de rôle
    choisir sa demande manuelle la plus ancienne, sinon un candidat automatique
    ne créer une nouvelle occurrence automatique que s’il reste une place
    ajouter l’occurrence au plan et augmenter uniquement le score projeté
valider que la révision n’a pas changé, sinon recalculer
publier une nouvelle révision de file commune
```

Une occurrence automatique déjà prévue et encore admissible est un candidat existant. Un reshuffle de la file saturée peut réordonner ces candidats sans en créer de nouveaux. Une demande explicite de renouvellement du contenu ou une invalidation réelle modifie d’abord la file, puis le seuil est réévalué sur cet état.

### 11.2 Événements déclencheurs

| Événement | Effet |
| --- | --- |
| Modification des préférences de room | Recalcul de la règle et reshuffle commun ; historique inchangé. |
| Annotation d’un morceau | Réévaluer les candidats et occurrences affectés ; recalculer le plan si nécessaire. |
| Favori ajouté ou retiré | Mise à jour personnelle des raccourcis seulement. |
| Ajout manuel | Ignorer les inclusions ; en cas d’exclusion, demander confirmation avant admission. Après admission, réévaluer le plan et autoriser le dépassement du seuil. |
| Confirmation d’exclusion manuelle | Valider les conflits acceptés et admettre la demande sans changer les règles de room ; conserver cette confirmation lors des reshuffles. |
| Demande « jouer ensuite » | Réserver le prochain passage de façon atomique. |
| Fin ou saut du morceau | Clore le passage, revalider la sélection suivante, démarrer une occurrence et compléter la file si elle repasse sous le seuil. |
| Arrivée ou départ | Réévaluer les règles, les apporteurs, le seuil et la file selon les réglages. |
| Source indisponible | Chercher une source équivalente autorisée ; sinon écarter l’occurrence active et recalculer. |
| Pause ou seek | Synchronisation de lecture existante ; aucun nouveau passage ni dette supplémentaire. |
| Redémarrage serveur | Restaurer les événements et compteurs sans rejouer un incrément. |

### 11.3 État transmis

Étendre les messages `sync` avec une révision de plan et les informations nécessaires : occurrence courante, aperçu de file, total, apporteurs, préférences de room, réglages et états des demandes manuelles de la personne concernée.

Les favoris et détails de bibliothèque restent personnels. Ne pas diffuser l’ensemble de toutes les annotations à tous les clients pour leur faire exécuter le moteur. Diffuser les tags nécessaires à l’affichage du morceau et de ses propres contrôles.

Conserver la séparation actuelle entre états synchronisables, stockables et données d’authentification. Un `contributorId` fourni par le client ne fait pas foi : le serveur le déduit de l’identité autorisée.

## 12. Suggestions de morceaux

Quand la sélection personnelle d’une personne n’offre plus de nouveaux morceaux intéressants pour les moods demandés, lui proposer des morceaux que d’autres utilisateurs ont annotés avec ces moods.

Il faut distinguer « bibliothèque entièrement parcourue récemment » et « aucun morceau compatible ». La première situation peut déclencher des suggestions tout en autorisant des répétitions pondérées ; la seconde ne doit pas déclencher un assouplissement silencieux des filtres.

**Proposition de parcours :** les suggestions apparaissent dans la bibliothèque ou le panneau d’ajout. Une personne choisit d’ajouter un morceau à sa bibliothèque et confirme les moods proposés, éventuellement modifiés. Pour une sélection automatique ultérieure, ses propres annotations deviennent la base des inclusions et les exclusions sont revérifiées. Si elle demande explicitement l’ajout du titre à la room, appliquer le parcours manuel : inclusions ignorées, avertissement confirmable pour les exclusions. Le recommandant d’origine reste une information de découverte, pas le bénéficiaire du passage.

Pour proposer une combinaison de moods, ne pas fabriquer artificiellement une annotation collective : `energetic` chez A et `like` chez B ne signifient pas qu’un même utilisateur a recommandé ce titre pour `energetic ET like`. L’utilisation de recommandations publiques nécessite une politique explicite de visibilité des annotations.

Aucune suggestion ne rejoint automatiquement la file au-delà du plafond ni sans apporteur identifié.

## 13. Interface de room et usages mobiles

### 13.1 Organisation

La room présente la file, les participants, la discussion et les réglages. Le lecteur est ancré en bas sur téléphone comme sur ordinateur. Le contenu principal peut défiler sans déplacer les commandes de lecture.

Ordre de priorité d’usage : morceau courant, lecture/pause, suivant/précédent lorsque disponible, position, volume/muet, puis accès aux moods. Une grande pochette ou un long panneau de tags ne doit pas obliger à faire défiler la page pour changer de morceau.

Le panneau de moods s’ouvre au-dessus du lecteur. Il conserve les deux groupes d’icônes décrits en section 4, le catalogue `+` et la gestion des favoris. Ouvrir le panneau ne masque ni le bouton suivant ni le volume.

La sélection des moods de **room** est séparée des annotations du **morceau courant**. Le clic droit d’exclusion concerne le filtre de room ; il ne doit pas supprimer ou exclure un morceau lorsqu’on annote simplement le titre dans le lecteur.

Le volume reste personnel, en réutilisant `useVolume()`. Les permissions de lecture commune, de saut et de gestion de file restent celles du serveur. Afficher un contrôle désactivé ou absent lorsque l’action n’est pas autorisée.

### 13.2 Adaptation depuis l’interface existante

- Réorganiser `Room.vue` au lieu de créer une application concurrente.
- Extraire ou adapter une variante persistante de [`controls/VideoControls.vue`](../client/src/components/controls/VideoControls.vue).
- Conserver le montage des lecteurs et les mécanismes de blocage/autoplay dans `OmniPlayer.vue` ; fermer un panneau de moods ne démonte pas le lecteur.
- Réutiliser [`RoomSidePanel.vue`](../client/src/components/RoomSidePanel.vue), le chat et la liste des utilisateurs, notamment leur conservation d’état lorsque les onglets changent.
- Adapter [`VideoQueue.vue`](../client/src/components/VideoQueue.vue) et [`VideoQueueItem.vue`](../client/src/components/VideoQueueItem.vue) à la provenance, aux identifiants d’occurrence et à l’aperçu compact.
- Étendre [`AddPreview.vue`](../client/src/components/AddPreview.vue) et [`AddPreviewHelper.vue`](../client/src/components/AddPreviewHelper.vue) avec les intentions « au mix » et « ensuite ».
- Étendre [`RoomSettingsForm.vue`](../client/src/components/RoomSettingsForm.vue) avec fair share, participation automatique des arrivants et retrait au départ.
- Réutiliser les composants de `client/src/components/ui`, les icônes et la localisation existants. Les libellés français de cette spec sont illustratifs ; les chaînes de production passent dans les locales conformément au dépôt.

Le réordonnancement libre de `VideoQueue.vue` ne doit pas annuler silencieusement le fair share. **Proposition :** en mode musical, exposer des intentions compatibles, notamment « jouer ensuite » ; garder le drag-and-drop libre dans les modes historiques qui le supportent.

### 13.3 Accessibilité et petit écran

Supporter au minimum 320 px de largeur sans débordement horizontal. Prévoir des cibles tactiles suffisantes, des noms accessibles pour toutes les icônes, des états sélectionnés annoncés et une alternative au survol et au clic droit.

L’ancrage du lecteur doit tenir compte de la zone de sécurité du téléphone et du clavier virtuel. La file et les panneaux peuvent défiler ; les contrôles ne sont pas enfouis en bas d’une longue page. Dans l’application réelle, utiliser le viewport disponible, pas la hauteur fixe utilisée pour simuler un écran dans le chat.

Les contrôles de démonstration « Voir en tant que Léa », les titres fictifs et les boutons simulant les arrivées ne sont pas des éléments de l’interface de production.

### 13.4 Écran verrouillé et lecture en arrière-plan

L’objectif initial est de pouvoir écouter sur téléphone, y compris écran éteint lorsque la source et la plateforme le permettent. Pour les fichiers locaux servis ou les sources directes, prévoir les métadonnées et commandes média du système, et tester effectivement les navigateurs et systèmes ciblés.

Ne pas promettre la même capacité pour toutes les sources embarquées. Une UI de lecteur commune n’efface ni les limites de lecture en arrière-plan, ni les contraintes du fournisseur. La compatibilité doit être exprimée dans les capacités des sources et vérifiée sur appareils.

Une application mobile native peut venir plus tard si nécessaire ; la première étape exploite le client web existant. L’application PC reste reportée.

## 14. Modèle de données proposé

Les noms ci-dessous désignent de nouveaux concepts à ajouter au schéma Sequelize et aux modèles partagés ; ils ne décrivent pas des tables déjà présentes.

| Objet | Informations principales | Contraintes importantes |
| --- | --- | --- |
| `Track` | `id`, titre, artistes, durée, illustration, styles | Identité musicale stable, distincte des sources. |
| `TrackSource` | `id`, `trackId`, fournisseur, identifiant fournisseur, localisation, capacités, disponibilité | Unicité fournisseur/identifiant ; URLs sensibles résolues seulement pour les lecteurs autorisés. |
| `UserLibraryTrack` | `userId`, `trackId`, provenance d’import, date d’ajout | Un lien de bibliothèque ne copie pas les tags d’un autre utilisateur. |
| `Mood` | `id`, nom, nom normalisé, `iconKey`, créateur | Cinq valeurs initiales ; icône parmi les ressources autorisées. |
| `UserTrackMood` | `userId`, `trackId`, `moodId`, date | Unicité du triplet, index par utilisateur/mood et morceau/utilisateur. |
| `UserFavoriteMood` | `userId`, `moodId`, ordre optionnel | Indépendant des annotations et de la room. |
| `RoomParticipantPreference` | room, identité de participant, inclusions, exclusions | Préférences personnelles ; participation uniquement pendant la présence effective. |
| `QueueEntry` | `entryId`, `trackId`, `sourceId`, `contributorId`, origine, date d’admission, référence de demande | Une occurrence a un apporteur ; la source peut changer sans recréer l’occurrence. |
| `ManualRequest` | `requestId`, room, apporteur, morceau, intention, ordre, statut, réservation, conflits d’exclusion acceptés et date de confirmation | Identifiant d’idempotence ; confirmation propre à la demande ; aucune limite métier dérivée de Q(N). |
| `PlaybackEvent` | `playbackId`, room/session, occurrence, morceau, source, apporteur, début/fin, statut | Un seul incrément de fair share par passage comptabilisé. |
| `RoomSchedulingState` | session, révision, scores, bases à l’arrivée, curseur, état de tirage | Restaurable ; projections séparées des passages réels. |
| `LibrarySyncJob` | propriétaire, source de playlist/répertoire, fréquence, curseur, état, erreurs | Import idempotent indépendant de la room. |

### 14.1 Compatibilité progressive avec `QueueItem`

**Proposition :** étendre le DTO actuel avec les nouveaux identifiants et la provenance, tout en conservant temporairement `service`, `id` et les métadonnées résolues attendues par les lecteurs. Un adaptateur produit cette vue à partir de `TrackSource`.

Les opérations d’occurrence, les clés Vue, le réordonnancement et les suppressions passent à `entryId`. Les comparaisons musicales et la récence utilisent `trackId`. Les appels fournisseur utilisent toujours `service + id`.

Préserver `startAt`, `endAt`, les sous-titres et les caractéristiques spécifiques aux lecteurs. Une reprise d’une occurrence interrompue n’est pas automatiquement un nouveau passage musical.

Un ajout manuel répété explicitement peut créer une autre occurrence du même morceau : la détection de doublon ne doit pas constituer un refus définitif de la demande. **Proposition :** signaler qu’un morceau est déjà prévu, puis permettre sa répétition explicite. Distinguer cette répétition volontaire d’une retransmission technique de la même demande, qui doit rester idempotente. La prévention des doublons automatiques reste inchangée.

### 14.2 Persistance et migration

Ajouter des migrations dans `server/migrations` et les enregistrements correspondants dans `server/models/index.ts`. Les évolutions doivent fonctionner dans les deux modes de base actuellement supportés, SQLite et PostgreSQL.

Les bibliothèques, annotations, favoris et événements d’écoute sont durables. Redis conserve les états de room actifs, projections et informations utiles à la restauration. Persister suffisamment de données pour reconstruire les scores si une projection est perdue.

Mettre à jour `syncableProps`, `storableProps`, les types d’état et les conversions de [`server/storage/room.ts`](../server/storage/room.ts). Ne pas ajouter un champ uniquement au modèle TypeScript en supposant qu’il sera automatiquement synchronisé ou sauvegardé.

Les anciens éléments de file n’ont pas d’apporteur fiable. Conserver leur lecture dans les modes historiques ; pour les inclure dans une session musicale, demander ou appliquer une adoption explicite par une personne. Ne pas inventer un historique de contributions à partir du propriétaire de la room.

Le cache de métadonnées existant reste un cache. Ne pas peupler arbitrairement les bibliothèques personnelles à partir de tout `CachedVideo`.

## 15. Intégration technique par sous-système

### 15.1 Serveur de room

**Proposition :** ajouter des modules `room-mood-policy`, `music-scheduler`, `playback-history` et `track-resolver`, appelés par `Room`, plutôt que concentrer tout le nouvel algorithme dans `room.ts`.

Points d’intégration précis :

- `addToQueue()` : résoudre le morceau, déduire l’apporteur depuis le contexte autorisé, ignorer les inclusions, produire si nécessaire les conflits d’exclusion à confirmer, puis admettre la demande manuelle et planifier.
- `dequeueNext()` : sélectionner/revalider le prochain passage dans le mode musical, puis conserver l’initialisation existante de position, vitesse, segments et lecture.
- `update()` : conserver la détection serveur de fin et empêcher le tri du mode Vote de réordonner une file musicale en parallèle.
- `joinRoom()` / `leaveRoom()` : agréger les connexions en participants, recalculer règles et seuil, gérer les apports et les scores.
- `shuffle()` : utiliser le moteur musical dans le mode musical ; conserver la sémantique existante dans les autres modes.
- `playNow()` : ne pas le détourner pour implémenter « jouer ensuite ». Ajouter une intention distincte qui réserve une prochaine occurrence sans changer `currentSource` immédiatement.
- Restauration et undo : conserver les identités, ne pas annuler des événements historiques déjà joués comme s’il s’agissait seulement d’un changement d’ordre.

L’état de planification doit être restauré avant le premier choix après redémarrage. Une transaction logique de changement de passage doit associer l’événement historique, le compteur et l’occurrence courante ; une publication WebSocket répétée ne rejoue pas cette transaction.

### 15.2 Modes et paramètres

**Proposition :** introduire un mode `Music` dans `QueueMode`, avec `fairShareEnabled` comme réglage de ce mode. Conserver `Manual`, `Vote`, `Loop`, `Dj` pour les comportements OTT existants. Désactiver fair share dans le mode musical sélectionne le tour de rôle, pas l’ancien mode `Manual`.

| Paramètre | Cible | Statut |
| --- | --- | --- |
| Participation automatique de la bibliothèque à l’arrivée | Activée par défaut | Demandé |
| Retrait des apports à venir au départ | Activé par défaut | Demandé |
| Fair share | Réglage de room ; désactivation = tour de rôle | Demandé ; défaut activé proposé |
| Taille de remplissage automatique | Barème Q(N), pas un plafond manuel | Demandé |
| Au changement de moods | Garder les titres compatibles ou renouveler les propositions, puis reshuffle | Choix demandé ; conciliation détaillée proposée |
| Favoris | Réglage personnel | Demandé |
| Pondération de récence | Active ; constantes internes configurables | Principe demandé ; paramètres proposés |
| Diversité artistes/styles | Éviter les répétitions si possible | Demandé |

**Proposition :** le réglage historique « intercaler les arrivants » contrôle l’admission automatique de leur bibliothèque. Le fair share contrôle l’ordre des apports une fois admis. Les fusionner sans distinction rendrait ambigu le comportement quand fair share est désactivé mais que le tour de rôle doit continuer.

### 15.3 Protocole et API

Étendre `RoomSettings`, `ServerMessageSync` et les requêtes dans `common/models/messages.ts`. Les nouvelles commandes couvrent au minimum : modification de ses préférences de room, ajout manuel avec intention, réservation/annulation du prochain passage et lecture paginée des demandes.

Pour une demande manuelle en conflit, retourner un résultat structuré de confirmation requise avec l’identifiant de demande, le morceau et la liste des couples personne ayant exclu/mood. La confirmation renvoie les conflits acceptés pour cette demande. Le serveur les recalcule : les anciens conflits déjà acceptés restent couverts, mais un conflit supplémentaire doit être présenté avant admission. Une modification sans nouveau conflit ne force pas une nouvelle validation. Ne pas implémenter l’exception avec un simple booléen global `ignoreExclusions` fourni par le client.

Les annotations, favoris, catalogue et bibliothèques peuvent être gérés via des routes personnelles à ajouter aux API existantes. Après une annotation modifiée, notifier les rooms concernées pour invalider leurs candidats ; une simple mise à jour locale du navigateur serait insuffisante.

Utiliser la validation d’entrée et les exceptions du projet. Vérifier les permissions existantes d’ajout, de gestion d’ordre et de lecture, et ajouter les permissions spécifiques nécessaires plutôt que contourner `Grants`.

`RoomRequestType` est actuellement un enum numérique implicite : préserver les valeurs déjà utilisées et ajouter les nouvelles valeurs sans déplacer les anciennes. Auditer les schémas, sérialisations, clients, tests et éventuels miroirs Rust du protocole avant déploiement.

Adapter [`client/src/util/roomapi.ts`](../client/src/util/roomapi.ts) comme point d’appel de la vue. Ne pas introduire un second canal de contrôle contournant la connexion existante.

### 15.4 Cache et performances

**Proposition :** indexer les tags par utilisateur et morceau, mettre en cache les candidats d’une sélection de room et invalider ce cache sur les changements pertinents. Ne pas relire l’ensemble des bibliothèques à chaque tick de progression ou chaque affichage de seconde.

Les tirages se font sur des candidats connus et accessibles. Les résolutions réseau et imports de playlists s’exécutent hors de la transition atomique de passage, puis sont revalidés avant admission.

Une file manuelle très longue reste stockée intégralement, mais sa transmission et son rendu sont paginés. Les limites techniques de taille de requête ou de débit ne doivent pas être présentées comme un quota de morceaux imposé par le fair share.

## 16. Discord et application PC

L’application PC est explicitement reportée. Le cœur des rooms, le moteur de moods et la bibliothèque ne doivent dépendre ni d’un client desktop ni de Discord.

L’objectif futur de présence Discord est d’afficher le morceau réellement joué, l’artiste, éventuellement la pochette, la progression et un accès à la room. Prévoir un module consommant l’état de lecture commun, désactivable par la personne.

La connexion Discord déjà présente authentifie l’utilisateur ; elle ne publie pas son activité musicale. Une intégration Rich Presence devra choisir son environnement : application installée/compagnon, ou application embarquée dans Discord. La documentation distingue le [Social SDK](https://docs.discord.com/developers/discord-social-sdk/development-guides/setting-rich-presence) et le [Embedded App SDK](https://docs.discord.com/developers/rich-presence/using-with-the-embedded-app-sdk).

Cette distinction suffit pour le découpage actuel. Le choix du client natif, la compatibilité mobile de Discord et la distribution d’une application PC ne bloquent pas le développement web décrit ici.

## 17. Séquence de réalisation sur le dépôt

1. **Fondations d’identité et migration** : modèles Track/Source, occurrence avec apporteur, compatibilité `QueueItem`, accès autorisé aux fichiers directs. Conserver le fonctionnement des rooms historiques.
2. **Bibliothèques et annotations** : liens personnels, moods, création d’icônes depuis le catalogue, favoris, API et persistance. Réutiliser les adaptateurs d’import de références.
3. **Règle collective** : préférences par participant, évaluateur commun testable, veto sur les annotations présentes, mise à jour serveur des candidats.
4. **Historique et ordonnanceur** : événement de passage idempotent, fair share, tour de rôle, récence, seuils, ajouts manuels et réservation du prochain passage.
5. **Intégration dans Room** : fin de titre, reshuffle, arrivées/départs, reprise après incident, messages synchronisés et versions de plan.
6. **Interface réelle** : lecteur bas, aperçu court, annotations et favoris, panneau de room, intention d’ajout, modes compatibles avec les permissions existantes.
7. **Bibliothèque locale et synchronisation** : indexation, accès aux médias, job quotidien, récupération d’erreurs et provenance d’import.
8. **Suggestions et consolidation mobile** : recommandations explicites, expérience tactile et tests de lecture en arrière-plan par source.
9. **Évolutions reportées** : application PC, intégration Discord et éventuel client mobile natif.

Ce découpage réutilise l’architecture actuelle. Il n’impose ni nouveau backend, ni remplacement de Vuex, ni changement d’ORM, ni réécriture des lecteurs ou du load balancer pour lancer la fonctionnalité.

## 18. Critères d’acceptation

### 18.1 Sources et identité

- Un morceau possède des annotations identiques lorsqu’on change sa source équivalente de local vers YouTube ou inversement.
- Deux versions distinctes ne sont pas fusionnées sur le seul nom.
- Le repli d’une source ne crédite pas un deuxième passage.
- Une URL `file:` n’est pas considérée comme un partage valide entre clients.
- Un import quotidien répété n’ajoute pas de doublons dans la bibliothèque et n’alimente pas directement une immense file.

### 18.2 Moods et interface

- Les cinq moods initiaux existent ; un mood personnalisé peut être créé avec une icône.
- Un titre peut recevoir plusieurs tags différents selon les personnes.
- Pour la sélection automatique, les inclusions consultent exclusivement les tags de l’apporteur ; elles sont ignorées lors d’un ajout manuel.
- Le tag `epic` attribué par X exclut le titre de Y des tirages automatiques si ce mood est exclu dans la room ; un ajout manuel reste possible après confirmation.
- Aucune inclusion d’un utilisateur ne s’ajoute implicitement aux tags de l’apporteur pour faire passer un morceau.
- Une personne sans inclusion est neutre ; les exclusions continuent de fonctionner.
- Un favori ne tague pas de titre et ne modifie pas la règle de room.
- Les deux groupes d’icônes du lecteur sont dédupliqués ; leur état bleu dépend de la personne connectée.
- Un tag personnel non favori reste affiché tant qu’il est attribué au morceau.
- Changer de morceau ou de personne connectée ne mélange pas les annotations.
- Le lecteur, son bouton suivant et son volume restent accessibles en bas avec le panneau de moods ouvert, à 320 px comme sur ordinateur.
- Les morceaux rejetés n’apparaissent pas dans la liste active, et la room ne présente pas leurs justifications individuelles.

### 18.3 File et équité

- Q(1)=10, Q(2)=10, Q(3)=9, Q(4)=12, Q(5)=10, Q(6)=12, Q(7)=14, Q(8)=8, Q(9)=9 et Q(N)=10 pour N≥10.
- En duo, 10 titres plus 4 ajouts manuels donnent 14 occurrences actives si toutes sont admissibles ; le moteur ne tronque pas les ajouts.
- Les transitions 14→13→12→11→10 ne déclenchent aucun remplissage ; 10→9 autorise une création automatique au maximum.
- Une personne sans candidats ne bloque pas les autres, mais son compteur n’augmente pas.
- Les titres manuels et automatiques incrémentent le même score de contribution au démarrage.
- Les égalités de score sont départagées aléatoirement, sans biais permanent vers le premier utilisateur.
- Un horizon de 10 dans une room de 12 personnes ne prive pas systématiquement les deux dernières d’un passage.
- Désactiver fair share produit un tour de rôle stable ; un ajout prioritaire ne crée pas une compensation cachée.
- Une projection de file ou dix reshuffles successifs n’augmentent aucun compteur réel.
- Un morceau récent a un poids plus faible qu’un morceau ancien ; il n’est pas banni définitivement.
- La diversité d’artiste des tirages automatiques est recherchée sans contourner les exclusions ni l’équité ; elle ne remet pas en cause un titre choisi manuellement et admis.
- Tous les clients reçoivent la même révision et le même ordre après un changement de moods.

### 18.4 Demandes manuelles, présence et restauration

- Un titre ne correspondant à aucune inclusion, ou dépourvu de moods, peut être ajouté manuellement sans modifier les filtres.
- Une exclusion déclenche un avertissement citant la personne ayant exclu le mood et le nom du mood ; plusieurs conflits sont regroupés.
- « Ajouter quand même » admet le titre pour cette demande, sans modifier les préférences de room ni son admissibilité automatique.
- Annuler la confirmation ne crée ni occurrence active, ni réservation, ni dette de fair share.
- Un ajout confirmé malgré une exclusion reste présent après reshuffle et restauration, sans redemander la même confirmation.
- Les nouveaux conflits non couverts suivent le parcours proposé de reconfirmation ; les changements d’inclusions ne retirent jamais un ajout manuel.
- Un ajout confirmé malgré une exclusion compte dans le dépassement du seuil et dans l’historique comme tout autre ajout manuel.
- « Jouer ensuite » ne modifie pas le morceau courant et ne déclenche pas l’actuel `playNow()`.
- Deux demandes simultanées pour le même prochain créneau ne sont pas toutes les deux confirmées comme prochaines.
- Une demande ordinaire n’est pas repoussée derrière tout le stock automatique de son propre apporteur.
- Une file saturée ne permet pas de créer un morceau automatique invisible juste avant sa lecture.
- Départ avec retrait activé : les occurrences à venir de la personne partent, pas le morceau courant.
- Départ avec retrait désactivé : les occurrences déjà admises restent attribuées à leur apporteur ; aucune nouvelle génération depuis sa bibliothèque.
- Ouvrir deux onglets ne double ni les droits d’équité ni le nombre de personnes dans le barème.
- Une reconnexion ou une restauration Redis ne remet pas la dette à zéro.
- Une retransmission d’un même événement de démarrage ne double pas son comptage.
- Les tests OTT de synchronisation, permissions, vote-skip, sources et modes historiques restent valides ou sont explicitement adaptés au nouveau mode.

### 18.5 Vérifications à intégrer au projet

Utiliser Vitest dans les workspaces actuels pour l’évaluateur, le calcul de seuil, les scores, les projections, la récence et les transitions de room. Utiliser une source aléatoire injectable pour vérifier les invariants et les distributions sans tests instables.

Étendre notamment [`server/tests/unit/room.spec.ts`](../server/tests/unit/room.spec.ts), les tests d’API concernés et les tests de composants existants. Ajouter des scénarios Playwright de synchronisation entre plusieurs utilisateurs, d’ajout manuel concurrent, de panneau de moods et de lecture bas de page.

Tester la migration et la restauration avec SQLite et PostgreSQL. Un simple passage des tests du prototype HTML ne valide pas la persistance, les permissions ou la synchronisation réelle.

## 19. Arbitrages restant ouverts

Ces points ne remettent pas en question les exigences établies ; ils évitent de transformer des choix d’implémentation en décisions utilisateur fictives.

1. **Initialisation du score des nouveaux arrivants et durée d’une session d’équité** : base au minimum courant et remise à zéro explicite proposées ; les historiques réels ne sont jamais falsifiés.
2. **Conflits de priorité « ensuite »** : créneau unique, première demande acceptée prioritaire, proposés. Le comportement « sans interruption » est confirmé.
3. **Nouvelles exclusions après admission manuelle** : reconfirmation uniquement des conflits supplémentaires proposée. L’absence de blocage par les inclusions et la possibilité de confirmer malgré les exclusions sont des règles confirmées, pas des arbitrages ouverts.
4. **Maintien ou renouvellement au changement de moods** : conservation des propositions automatiques compatibles, puis reshuffle, proposée ; les demandes manuelles et leurs confirmations sont préservées selon la section 10.3.
5. **Sens exact d’« intercaler à l’arrivée » lorsque désactivé** : admission automatique de la bibliothèque désactivée proposée ; les ajouts manuels restent possibles et équitables.
6. **Visibilité des annotations pour les recommandations** : opt-in et périmètre instance/communauté à définir. Ne pas exposer par défaut les bibliothèques privées.
7. **Constantes de récence, de diversité et durée de grâce de reconnexion** : paramètres proposés à ajuster avec des simulations et des essais d’écoute.
8. **Délai maximal des ajouts ordinaires** : aucun plafond absolu ne peut être promis avec ajouts illimités et fair share strict ; l’utilisateur dispose déjà de l’intention explicite « jouer ensuite ».
9. **Gestion des fichiers d’une playlist supprimée et fusion de versions musicales** : aucune suppression ou fusion destructive implicite.
10. **Réutilisation exacte des interfaces vidéo historiques dans la room musicale** : conserver les capacités et restrictions des fournisseurs ; déterminer quels éléments vidéo doivent rester visibles selon la source.

## 20. Références de conception et portée des maquettes

Les maquettes locales `output/undertone-moods.html`, `output/undertone-room.html` et `output/undertone-room-bottom.html` retracent les itérations d’interface. Elles ne sont pas livrées avec cette spécification dans Git. La dernière disposition du lecteur en bas constitue la référence de placement ; les règles et comportements nécessaires à son implémentation sont décrits dans le présent document.

La présente spécification remplace leurs simplifications : file de six titres, exclusion définitive des titres déjà joués, ordonnancement de démonstration, données fictives et absence de serveur. Les nouveaux plafonds, l’historique probabiliste, les ajouts manuels non plafonnés et le fair share doivent être implémentés dans le dépôt réel.

Cette livraison est documentaire. Elle n’ajoute pas encore ces fonctionnalités à l’application et ne lance aucun import, téléchargement, déploiement ou changement de compte externe.
