// Scénario de démonstration partagé par le serveur (npm run demo) et la démo dans le navigateur.
// Toutes ces données sont SIMULÉES et marquées comme telles.

import { ZONES } from '../data/zones.ts';
import type { Episode } from '../engine/baseline.ts';
import { DAY, HOUR, MINUTE } from '../engine/math.ts';
import type { Observation, PlannedOutage } from '../engine/types.ts';
import { generateEpisodes, rng } from './world.ts';

export interface DemoSink {
  addEpisode(e: Episode, demo?: boolean): void;
  addObservation(o: Observation, demo?: boolean): number;
  addPlanned(p: Omit<PlannedOutage, 'id'>, demo?: boolean): number;
}

export function seedScenario(store: DemoSink, now: number): { episodes: number; devices: number } {
  const r = rng(20261122);
  // 1. Historique : coupures simulées sur 150 jours (jusqu'à 3 h avant maintenant).
  let total = 0;
  for (const z of ZONES) {
    for (const e of generateEpisodes(z.id, now - 150 * DAY, now - 3 * HOUR, r)) {
      store.addEpisode(e, true);
      total++;
    }
  }

  // 2. Situation en direct.
  const dev = (n: number) => `dev:demo-${n.toString().padStart(4, '0')}`;
  const ago = (min: number) => now - min * MINUTE;
  let k = 0;

  // Kotto : 6 téléphones perdent la charge en même temps il y a 25 min, 2 personnes confirment.
  for (let i = 0; i < 6; i++) store.addObservation({ kind: 'device', sourceId: dev(k++), zoneId: 'dla-kotto', at: ago(25) + i * 20_000, event: 'power_lost' }, true);
  for (let i = 0; i < 2; i++) store.addObservation({ kind: 'report', sourceId: dev(k++), zoneId: 'dla-kotto', at: ago(20 - i * 4), state: 'out' }, true);

  // Bépanda : transformateur en feu signalé par deux personnes, pas encore de coupure confirmée.
  for (let i = 0; i < 2; i++) store.addObservation({ kind: 'incident', sourceId: dev(k++), zoneId: 'dla-bepanda', at: ago(12 - i * 3), incident: 'transformer_fire' }, true);

  // Akwa : courant présent, des téléphones en charge le confirment.
  for (let i = 0; i < 4; i++) store.addObservation({ kind: 'device', sourceId: dev(k++), zoneId: 'dla-akwa', at: ago(3 + i * 2), event: 'charging' }, true);

  // Bonamoussadi : coupure il y a 2 h 30, courant revenu il y a 40 min.
  for (let i = 0; i < 4; i++) {
    const id = dev(k++);
    store.addObservation({ kind: 'device', sourceId: id, zoneId: 'dla-bonamoussadi', at: ago(150) + i * 30_000, event: 'power_lost' }, true);
    store.addObservation({ kind: 'device', sourceId: id, zoneId: 'dla-bonamoussadi', at: ago(40) + i * 25_000, event: 'power_back' }, true);
  }

  // Yaoundé, Mimboman : quelques signalements sans capteur.
  for (let i = 0; i < 3; i++) store.addObservation({ kind: 'report', sourceId: dev(k++), zoneId: 'yde-mimboman', at: ago(35 - i * 7), state: 'out' }, true);

  // Coupures programmées (annonces fictives de démonstration).
  store.addPlanned({ sourceId: 'official:eneo', zoneIds: ['dla-akwa', 'dla-bali'], start: now + 3 * HOUR, end: now + 5 * HOUR, note: 'Travaux de maintenance (démo)' }, true);
  const tomorrow8 = Math.ceil((now + HOUR) / DAY) * DAY + 7 * HOUR; // 8 h heure locale
  store.addPlanned({ sourceId: 'official:eneo', zoneIds: ['dla-bonamoussadi', 'dla-makepe'], start: tomorrow8, end: tomorrow8 + 6 * HOUR, note: 'Renforcement du réseau (démo)' }, true);

  return { episodes: total, devices: k };
}
