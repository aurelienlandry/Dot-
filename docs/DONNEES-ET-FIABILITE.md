# Données et fiabilité : le cœur de Dot

> Une appli d'anticipation qui se trompe est pire qu'inutile. Ce document explique d'où viennent
> les données, comment elles sont combinées, et comment on mesure qu'on a raison.

## 1. Le problème

Les fournisseurs (ENEO, Camwater, opérateurs) ne publient pas de données en temps réel.
Il faut donc **produire nous-mêmes la donnée**, puis la **fiabiliser**, sans dépendre de leur bonne volonté.
Les données officielles restent les bienvenues : elles sont une source parmi d'autres, et elles sont notées comme les autres.

## 2. Les sources (V1 : électricité)

| Source | Ce qu'elle dit | Force | Faiblesse | Défense |
|---|---|---|---|---|
| **Téléphones capteurs** (état de charge) | « la charge vient de s'arrêter / reprendre » | Automatique, à la minute près, sans effort | Un téléphone seul peut juste être débranché ; onduleur / groupe électrogène | **Simultanéité** : plusieurs téléphones distincts d'un même quartier dans la même fenêtre de 4 min |
| **Signalements** « coupé / revenu » | état observé | Simple, couvre ceux sans capteur | Rares, en retard, parfois faux | Réputation + rendements décroissants |
| **Incidents** (transfo en feu, poteau tombé, câble…) | une coupure va probablement arriver | **Anticipe** avant la coupure | Peut être faux ou ne pas causer de coupure | Pondéré par la réputation, recoupement par plusieurs témoins |
| **Annonces officielles** (coupures programmées) | créneau prévu | Plusieurs heures/jours d'avance | Pas toujours respectées, débordent | La source a sa propre réputation, mesurée a posteriori |
| **Historique** | heures, jours, saisons, quartiers à risque | Toujours disponible | Ne voit pas l'imprévu | Lissage hiérarchique (ville → quartier) |
| **Météo** (Open-Meteo) | orages, fortes pluies, vent | Prévisible à l'avance | Effet indirect | Multiplicateur modéré du risque |
| **Quartiers voisins / même départ** | une coupure se propage souvent | Couvre les quartiers sans utilisateurs | Les groupes de départ sont approximatifs | Coefficients bornés |

## 3. Comment on combine (le « mindset marché de prédiction »)

Sur un marché de prédiction, le prix agrège l'avis de milliers de participants, et ceux qui se trompent
perdent leur influence. Dot applique la même logique, **sans argent** :

1. **A priori** : ce que l'historique dit de cette heure-ci dans ce quartier.
2. **Chaque indice déplace la probabilité** (fusion bayésienne en log-cotes), selon sa force et la **fiabilité de sa source**.
3. **Les indices vieillissent** : « coupé il y a 3 h » compte moins que « coupé il y a 3 min ». Un « courant présent » vieillit très vite (il ne dit rien de ce qui s'est passé après).
4. **Point de rupture** : quand un groupe de téléphones change d'état ensemble, tout indice contraire plus ancien est périmé.
5. **Rendements décroissants** : le n-ième signalement dans le même sens compte de moins en moins. 30 comptes inconnus qui disent « coupé » donnent ≈ 83 %, jamais la certitude.
6. **Réputation (loi Beta)** : chaque source est jugée **contre les autres sources sans elle** (leave-one-out), pour qu'elle ne puisse jamais se donner raison toute seule. Une source fausse tombe à 50 % de fiabilité, c'est-à-dire **zéro influence**.
7. **Les incidents sont « pricés » tout de suite** : un transformateur en feu fait monter le risque des heures suivantes avant toute confirmation.
8. **Explicabilité** : l'appli affiche les raisons (« 6 téléphones ont perdu la charge à 19h02 »). La confiance se gagne en montrant son raisonnement.

Code : `src/engine/nowcast.ts` (maintenant), `src/engine/forecast.ts` (prochaines heures),
`src/engine/reputation.ts`, `src/engine/baseline.ts` (apprentissage), `src/engine/calibration.ts`.

## 4. Comment on prouve qu'on a raison

- **Calibration publique** : chaque prévision (+1 h, +3 h, +6 h) est enregistrée puis comparée à la réalité (score de Brier, diagramme de fiabilité). Onglet « Fiabilité » de l'appli.
- **Banc d'essai** (`npm run backtest`) : une ville simulée dont on connaît la vérité, avec des sources volontairement imparfaites
  (téléphones débranchés au hasard, 15 % de foyers avec groupe électrogène, signalements rares et en retard, trolls).
  Le vrai moteur ne reçoit que les signaux, puis on mesure ce qu'il en déduit.

### Résultats actuels (Douala simulé, 15 quartiers, 14 jours, saison des pluies)

| Téléphones capteurs par quartier | Coupures détectées | Délai médian | Fausses alertes | Gain prévision 1 h vs historique seul |
|---|---|---|---|---|
| 3 | 33 % | 12 min | 0,2 % du temps | +6 % |
| 6 | 70 % | 6 min | 0,2 % du temps | +15 % |
| 12 | RESULT12 |
| 25 | RESULT25 |

Les trolls finissent à 50 % de fiabilité (aucune influence) ; les capteurs honnêtes montent à ~90 %.

**Conclusion pour la stratégie de lancement** : la fiabilité dépend surtout du **nombre de téléphones capteurs actifs par quartier**.
Il vaut mieux lancer **quartier par quartier** (atteindre une dizaine de capteurs dans un quartier avant de passer au suivant)
que s'étaler sur toute une ville. Le pilote naturel : ton propre quartier, ta famille, tes voisins, un groupe WhatsApp de quartier.

## 5. Limites connues (honnêteté)

- **Le capteur web ne marche que appli ouverte** (et seulement sur Chrome Android). La vraie détection en continu demande une
  **appli Android native** (écoute de `ACTION_POWER_DISCONNECTED` en arrière-plan). C'est la priorité n°1 de la V2.
- Les coordonnées et les « départs électriques » des quartiers sont **approximatifs** : à corriger avec la connaissance terrain.
- Les annonces officielles sont saisies à la main (page `/admin.html`). Les récupérer automatiquement (pages Facebook ENEO, communiqués)
  doit se faire dans le respect des conditions d'utilisation de ces plateformes.
- Les chiffres du banc d'essai viennent d'un monde **simulé** : ils valident la logique, pas la réalité camerounaise. La vraie mesure sera la page « Fiabilité » une fois l'appli utilisée.

## 6. Suite logique

1. Appli Android native (capteur en arrière-plan, notifications « coupure probable ce soir chez toi »).
2. Bot / chaîne WhatsApp pour diffuser les alertes là où sont les gens.
3. Eau (Camwater) : même moteur, signaux différents (pression / « robinet sec »).
4. Internet : mesure passive du débit par opérateur et par zone.
5. Embouteillages par carrefour : signalements + vitesse GPS anonymisée (consentie) des utilisateurs en voiture.
6. Partenariats : proposer gratuitement aux fournisseurs la carte des coupures en temps réel, en échange de leurs données.
