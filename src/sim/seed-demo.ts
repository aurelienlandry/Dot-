// Remplit la base avec des DONNÉES DE DÉMONSTRATION (simulées, marquées comme telles dans l'appli) :
// 150 jours d'historique de coupures + une situation « en direct » autour de l'instant présent.
//   npm run seed:demo            (refuse d'écraser une base contenant de vraies données)
//   npm run seed:demo -- --force

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/db.ts';
import { Service } from '../server/service.ts';
import { seedScenario } from './scenario.ts';

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

store.db.exec('BEGIN');
const { episodes: total, devices: k } = seedScenario(store, now);
store.db.exec('COMMIT');

// 3. Laisser le moteur reconstituer l'état courant (ouverture des coupures en cours).
const service = new Service(store);
service.refreshBaselines(now, true);
service.tick(now);

console.log(`Démo prête : ${total} coupures historiques simulées, ${k} appareils fictifs, 2 annonces.`);
console.log(`Base : ${DB_PATH}`);
