// Remplit la base avec des DONNÉES DE DÉMONSTRATION (simulées, marquées comme telles dans l'appli) :
// 150 jours d'historique de coupures + une situation « en direct » autour de l'instant présent.
//   npm run seed:demo            (refuse d'écraser une base contenant de vraies données)
//   npm run seed:demo -- --force

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ZONES } from '../data/zones.ts';
import { DAY, HOUR, MINUTE } from '../engine/math.ts';
import { Store } from '../server/db.ts';
import { Service } from '../server/service.ts';
import { generateEpisodes, rng } from './world.ts';

const DB_PATH = process.env.DB_PATH ?? join(import.meta.dirname, '..', '..', 'data', 'dot.sqlite');
const force = process.argv.includes('--force');

if (existsSync(DB_PATH) && !force) {
  const db = new DatabaseSync(DB_PATH);
  const real = db.prepare('SELECT COUNT(*) AS n FROM observations WHERE demo = 0').get() as { n: number };
  db.close();
  if (Number(real.n) > 0) {
    console.error(`La base ${DB_PATH} contient de vraies observations. Relancez avec --force pour l'écraser.`);
    process.exit(1);
  }
}
mkdirSync(dirname(DB_PATH), { recursive: true });
for (const suffix of ['', '-wal', '-shm']) rmSync(DB_PATH + suffix, { force: true });

const store = new Store(DB_PATH);
const now = Date.now();
const r = rng(20261122);

// 1. Historique : coupures simulées sur 150 jours (jusqu'à 3 h avant maintenant).
let total = 0;
store.db.exec('BEGIN');
for (const z of ZONES) {
  for (const e of generateEpisodes(z.id, now - 150 * DAY, now - 3 * HOUR, r)) {
    store.addEpisode(e, true);
    total++;
  }
}
store.db.exec('COMMIT');

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

// 3. Laisser le moteur reconstituer l'état courant (ouverture des coupures en cours).
const service = new Service(store);
service.refreshBaselines(now, true);
service.tick(now);

console.log(`Démo prête : ${total} coupures historiques simulées, ${k} appareils fictifs, 2 annonces.`);
console.log(`Base : ${DB_PATH}`);
