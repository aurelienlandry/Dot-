// Scénario de démonstration partagé par le serveur (npm run demo) et la démo dans le navigateur.
// Toutes ces données sont SIMULÉES et marquées comme telles.

import { QUARTIERS_BY_ID, QUARTIERS } from '../data/zones.ts';
import type { Episode } from '../engine/baseline.ts';
import { blur, cellOf, cellsWithin } from '../engine/geo.ts';
import { DAY, HOUR, MINUTE } from '../engine/math.ts';
import type { DeviceEvent, Observation, PlannedOutage } from '../engine/types.ts';
import { generateEpisodes, rng } from './world.ts';

export interface DemoSink {
  addEpisode(e: Episode, demo?: boolean): void;
  addObservation(o: Observation, demo?: boolean): number;
  addPlanned(p: Omit<PlannedOutage, 'id'>, demo?: boolean): number;
}

export function seedScenario(store: DemoSink, now: number): { episodes: number; devices: number } {
  const r = rng(20261122);

  // 1. Historique : coupures simulées sur 150 jours, sur une zone d'environ 800 m autour de chaque quartier.
  let total = 0;
  for (const q of QUARTIERS) {
    const cells = cellsWithin(q.lat, q.lon, 0.8);
    for (const e of generateEpisodes(q.id, now - 150 * DAY, now - 3 * HOUR, r)) {
      for (const c of cells) store.addEpisode({ ...e, zoneId: c.id }, true);
      total++;
    }
  }

  // 2. Situation en direct.
  let k = 0;
  const dev = () => `dev:demo-${(k++).toString().padStart(4, '0')}`;
  const ago = (min: number) => now - min * MINUTE;
  /** Un point au hasard à moins de ~350 m du centre du quartier. */
  const near = (id: string) => {
    const q = QUARTIERS_BY_ID.get(id)!;
    const p = blur(q.lat + (r() - 0.5) * 0.006, q.lon + (r() - 0.5) * 0.006);
    return { ...p, zoneId: cellOf(p.lat, p.lon).id };
  };
  const device = (id: string, at: number, event: DeviceEvent, sourceId = dev()) => {
    store.addObservation({ kind: 'device', sourceId, ...near(id), at, event }, true);
    return sourceId;
  };

  // Kotto : 6 téléphones perdent la charge en même temps il y a 25 min, 3 autres perdent le Wi-Fi, 2 personnes confirment.
  for (let i = 0; i < 6; i++) device('dla-kotto', ago(25) + i * 20_000, 'power_lost');
  for (let i = 0; i < 3; i++) device('dla-kotto', ago(25) + i * 30_000, 'wifi_lost');
  for (let i = 0; i < 2; i++) store.addObservation({ kind: 'report', sourceId: dev(), ...near('dla-kotto'), at: ago(20 - i * 4), state: 'out' }, true);

  // Bépanda : transformateur en feu signalé par deux personnes, pas encore de coupure confirmée.
  for (let i = 0; i < 2; i++) store.addObservation({ kind: 'incident', sourceId: dev(), ...near('dla-bepanda'), at: ago(12 - i * 3), incident: 'transformer_fire' }, true);

  // Akwa : courant présent, des téléphones en charge le confirment.
  for (let i = 0; i < 4; i++) device('dla-akwa', ago(3 + i * 2), 'charging');

  // Bonamoussadi : coupure il y a 2 h 30, courant revenu il y a 40 min.
  for (let i = 0; i < 4; i++) {
    const id = device('dla-bonamoussadi', ago(150) + i * 30_000, 'power_lost');
    device('dla-bonamoussadi', ago(40) + i * 25_000, 'power_back', id);
  }

  // Yaoundé, Mimboman : quelques signalements sans capteur.
  for (let i = 0; i < 3; i++) store.addObservation({ kind: 'report', sourceId: dev(), ...near('yde-mimboman'), at: ago(35 - i * 7), state: 'out' }, true);

  // Coupures programmées (annonces fictives de démonstration).
  const akwa = QUARTIERS_BY_ID.get('dla-akwa')!;
  store.addPlanned({ sourceId: 'official:eneo', lat: akwa.lat - 0.004, lon: akwa.lon + 0.003, radiusKm: 1.2, label: 'Akwa, Bali', start: now + 3 * HOUR, end: now + 5 * HOUR, note: 'Travaux de maintenance (démo)' }, true);
  const tomorrow8 = Math.ceil((now + HOUR) / DAY) * DAY + 7 * HOUR; // 8 h heure locale
  store.addPlanned({ sourceId: 'official:eneo', lat: 4.087, lon: 9.745, radiusKm: 1.5, label: 'Bonamoussadi, Makepe', start: tomorrow8, end: tomorrow8 + 6 * HOUR, note: 'Renforcement du réseau (démo)' }, true);

  return { episodes: total, devices: k };
}
