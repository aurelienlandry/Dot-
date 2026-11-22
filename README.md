# Dot — anticiper les coupures

Savoir **s'il y a le courant chez soi maintenant**, **le risque de coupure dans les prochaines heures**,
et **combien d'heures de coupure on a subies sur l'année**, quartier par quartier (Douala, Yaoundé pour commencer).

V1 : **électricité**. L'eau, internet et les embouteillages suivront avec le même moteur.

## Ce que fait l'appli

- **Chez moi** : « Courant probablement présent : 82 % », avec les raisons affichées, la confiance, et le temps depuis lequel c'est coupé.
- **« Je serai à la maison à 19h30 »** : probabilité d'avoir le courant à ce moment-là.
- **Courbe des 24 prochaines heures**, coupures programmées annoncées, créneaux à risque, **créneaux sûrs** pour recharger / repasser.
- **Signaler** « coupé / revenu » ou un **incident** (transformateur en feu, poteau tombé…), même hors ligne (envoi différé).
- **Téléphone capteur** : détecte tout seul l'arrêt de la charge (Chrome Android, appli ouverte).
- **Quartiers** : carte schématique de la ville en temps réel.
- **Bilan** : heures de coupure, nombre de coupures, % du temps avec courant, par quartier, sur le mois / l'année.
- **Fiabilité** : nos prévisions sont notées publiquement, et chaque source aussi.

Comment les données sont fiabilisées : **[docs/DONNEES-ET-FIABILITE.md](docs/DONNEES-ET-FIABILITE.md)**.

## Lancer

Prérequis : Node.js ≥ 22.18. **Aucune dépendance à installer.**

```bash
npm run demo        # données de démonstration simulées + serveur sur http://localhost:8080
npm start           # serveur seul (base vide, vraies données)
npm test            # tests du moteur
npm run backtest    # banc d'essai de fiabilité (≈ 1 min) ; options : -- --sensors 12 --days 14
```

Variables : `PORT` (8080), `DB_PATH` (`data/dot.sqlite`), `ADMIN_TOKEN` (sinon un jeton temporaire est affiché au démarrage).
Saisie des coupures programmées : `/admin.html`.

## Organisation

```
src/engine/   moteur pur et testé : fusion des signaux, prévision, apprentissage, réputation, calibration
src/server/   API HTTP + SQLite (node:sqlite) + tâches de fond (état, notation, météo)
src/data/     quartiers (coordonnées et départs électriques approximatifs)
src/sim/      monde simulé : démonstration et banc d'essai
public/       appli mobile (PWA, sans framework, hors ligne)
test/         tests
```

## API

| Méthode | Chemin | Rôle |
|---|---|---|
| GET | `/api/zones` | villes, quartiers, types d'incident |
| GET | `/api/status?city=Douala` | état de tous les quartiers d'une ville |
| GET | `/api/zone/:id` | état détaillé + raisons + prévision 24 h + créneaux |
| POST | `/api/report` | `{deviceId, zoneId, state: "out"\|"on", at?}` |
| POST | `/api/device` | `{deviceId, zoneId, event: "power_lost"\|"power_back"\|"charging", at?}` |
| POST | `/api/incident` | `{deviceId, zoneId, incident}` |
| GET | `/api/bilan?city=&period=month\|year\|all` | bilan des coupures |
| GET | `/api/reliability` | calibration des prévisions, fiabilité des sources |
| POST/DELETE | `/api/admin/planned[/id]` | coupures programmées (jeton admin) |

Vie privée : aucun compte, aucun nom ; un identifiant anonyme par appareil ; seul le **quartier** est envoyé, jamais la position.
