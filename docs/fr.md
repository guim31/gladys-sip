# Appels vocaux SIP (Asterisk)

Appelez un téléphone depuis une scène Gladys et lisez-lui un message (alarme, fuite d'eau, porte restée ouverte),
et réagissez aux appels reçus (ouvrir le portail quand un numéro connu appelle). L'intégration pilote **votre
propre Asterisk ou FreePBX** par ARI, l'interface REST d'Asterisk : elle ne parle jamais SIP elle-même, c'est
votre serveur téléphonique qui le fait.

Développée sans ligne d'opérateur : testée contre Asterisk 23.5 dans Docker, avec des téléphones simulés. Vos
retours sont les bienvenus.

## Ce que vous obtenez

- Une action de scène **« Appeler et lire un message »** : appelle un numéro autorisé, lit le message une ou
  plusieurs fois, rappelle si personne ne répond. En option, l'appel n'est **acquitté** que lorsque quelqu'un appuie
  sur **1** : d'ici là, l'intégration rappelle (jusqu'au nombre de tentatives).
- Une action de scène **« Arrêter les appels »** : raccroche et annule les rappels (fausse alerte).
- Un déclencheur **« Appel reçu »**, filtré par numéro de l'appelant et numéro appelé, avec le numéro et le nom de
  l'appelant en variables.
- Un déclencheur **« Appel passé terminé »**, filtré par numéro et résultat (acquitté, décroché, sans réponse,
  occupé, échec, annulé).
- Un appareil **Serveur Asterisk** : serveur joignable, dernier appel reçu, dernier appel passé.
- Un widget de tableau de bord **Appels téléphoniques**.

## Prérequis : Asterisk

1. Activez le serveur HTTP dans `/etc/asterisk/http.conf` :

   ```ini
   [general]
   enabled=yes
   bindaddr=0.0.0.0
   bindport=8088
   ```

2. Créez un utilisateur ARI dans `/etc/asterisk/ari.conf` (choisissez un mot de passe long) :

   ```ini
   [general]
   enabled=yes

   [gladys]
   type=user
   read_only=no
   password=un-long-mot-de-passe-aleatoire
   ```

3. Enregistrez vos messages. Un message est un ou plusieurs sons Asterisk : placez `alarme.wav` (8 kHz mono) dans
   `/var/lib/asterisk/sounds/fr/custom/` et utilisez `custom/alarme`. Les médias `digits:1234`, `number:42` et
   `tone:ring` fonctionnent aussi.
4. Pour les appels reçus, envoyez les appels à l'intégration depuis le contexte du trunk de votre opérateur dans
   `extensions.conf`, avant de faire sonner vos postes :

   ```ini
   [from-trunk]
   exten => _X.,1,Stasis(gladys)
    same => n,Dial(PJSIP/100,30)
   ```

   Quand l'intégration est arrêtée, `Stasis()` échoue aussitôt et l'appel continue : vos postes sonnent toujours.

5. Les appels sortants passent par le trunk de votre opérateur : la chaîne de numérotation `PJSIP/{number}@mon-trunk`
   appelle par l'endpoint PJSIP `mon-trunk`. Lancez `core reload` après ces changements.

## Prérequis : FreePBX

1. **Settings → Asterisk REST Interface Users** : ajoutez un utilisateur (lecture/écriture) et notez son mot de
   passe. Vérifiez dans **Settings → Advanced Settings** que le mini-serveur HTTP d'Asterisk est activé (port 8088).
2. **Admin → System Recordings** : enregistrez ou téléversez les messages ; un enregistrement nommé `alarme` est le
   son `custom/alarme`.
3. Chaîne de numérotation : `Local/{number}@from-internal`, pour que les routes sortantes de FreePBX choisissent le
   trunk.
4. Appels reçus : dans `extensions_custom.conf`, ajoutez un contexte qui passe par Stasis puis par votre route
   entrante, et faites-y pointer une **Custom Destination** ou le contexte du trunk :

   ```ini
   [gladys-incoming]
   exten => _X.,1,Stasis(gladys)
    same => n,Goto(from-trunk,${EXTEN},1)
   ```

## Configuration

| Champ                     | Usage                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| Adresse ARI               | `http://<adresse du serveur>:8088`                                                                 |
| Utilisateur, mot de passe | L'utilisateur de `ari.conf` ou de FreePBX                                                          |
| Application Stasis        | `gladys` par défaut : le nom utilisé dans `Stasis(gladys)`                                         |
| Numéros autorisés         | Les seuls numéros que les scènes peuvent appeler, séparés par des virgules                         |
| Chaîne de numérotation    | `{number}` est remplacé par le numéro appelé                                                       |
| Identifiant d'appelant    | Affiché sur le téléphone appelé, ex. `Gladys <100>` (l'opérateur peut le remplacer)                |
| Appels entrants           | Continuer dans le plan (les postes sonnent) ou raccrocher sans décrocher (gratuit pour l'appelant) |
| Langue des textes         | Langue des noms des fonctionnalités et des résultats d'appel                                       |

**Tester la connexion** vérifie l'adresse et l'utilisateur. **Appel de test** passe un appel (une tentative, une
lecture).

## Scènes

- **Alarme par téléphone** : déclencheur « Alarme déclenchée » → action « Appeler et lire un message », numéro
  `0612345678`, message `custom/alarme`, 3 lectures, 5 tentatives, 60 s entre tentatives, « Attendre l'appui sur 1 »
  coché.
- **Fausse alerte** : déclencheur « Alarme désarmée » → action « Arrêter les appels ».
- **Portail par téléphone** : déclencheur « Appel reçu », numéro de l'appelant `0612345678` → ouvrir le portail. En
  mode « raccrocher sans décrocher », l'appel ne coûte rien à l'appelant.
- **Personne n'a acquitté** : déclencheur « Appel passé terminé », résultat « Sans réponse » → envoyer un message à
  une autre personne.

L'action de scène rend la main aussitôt (un appel avec rappels dure plus longtemps qu'une action de scène ne le
peut) : le résultat arrive par le déclencheur « Appel passé terminé » et la fonctionnalité « Dernier appel passé ».
Le numéro s'écrit comme dans les numéros autorisés ; espaces, points et tirets sont ignorés. Un second appel vers
un numéro déjà en cours d'appel n'est pas passé.

Le numéro de l'appelant du déclencheur « Appel reçu » est comparé tel quel : saisissez-le exactement comme l'affiche
la fonctionnalité « Dernier appel reçu » (les opérateurs envoient souvent `+33612345678` ou `33612345678`).

## Tableau de bord

Le widget **Appels téléphoniques** affiche le lien avec Asterisk, les appels en cours, l'heure du dernier appel reçu
et du dernier appel passé avec son résultat et, pendant un appel, un bouton pour arrêter les appels (masquable dans
les réglages du widget).

## Limites

- **Pas de synthèse vocale** : Asterisk lit des sons enregistrés. Enregistrez vos messages une fois (System
  Recordings de FreePBX, ou un outil de synthèse vocale sur votre ordinateur).
- Seuls les **numéros autorisés** peuvent être appelés. N'ajoutez jamais de numéro surtaxé : une scène pourrait
  l'appeler en boucle.
- Le **numéro de l'appelant peut être usurpé** par n'importe qui : ne l'utilisez pas seul pour ouvrir une porte ou
  désarmer une alarme.
- Les appels en cours quand Asterisk redémarre ou que le lien avec lui tombe se terminent en échec ; quand
  l'intégration elle-même redémarre, ils sont perdus (pas de déclencheur).
- Seuls les appels envoyés dans `Stasis(gladys)` sont vus.
- Développée sans le matériel : aucune vraie ligne d'opérateur n'a servi aux tests, seulement Asterisk 23.5 avec des
  téléphones simulés. Vos retours sont les bienvenus.

## Dépannage

- **« Asterisk ne répond pas »** : vérifiez l'adresse et le port, `http show status` dans la console Asterisk, et
  que la machine de Gladys atteint le port 8088.
- **« Asterisk refuse l'utilisateur ARI »** : vérifiez `ari.conf` (ou l'utilisateur ARI de FreePBX) et lancez
  `module reload res_ari.so`.
- **« Échec » immédiat** : la chaîne de numérotation est fausse (`pjsip show endpoints`), ou le trunk refuse
  l'appel : la console Asterisk dit pourquoi.
- **Le message est muet** : le son n'existe pas ; vérifiez `core show file formats` et le chemin sous
  `sounds/<langue>/`.
- **Pas de déclencheur à l'appel reçu** : le plan de numérotation n'atteint pas `Stasis(gladys)`, ou le nom de
  l'application diffère de la configuration.
