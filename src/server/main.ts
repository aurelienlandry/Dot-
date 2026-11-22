import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { MINUTE } from '../engine/math.ts';
import { createHandler } from './api.ts';
import { Store } from './db.ts';
import { Service } from './service.ts';
import { refreshWeather } from './weather.ts';

const PORT = Number(process.env.PORT ?? 8080);
const DB_PATH = process.env.DB_PATH ?? join(import.meta.dirname, '..', '..', 'data', 'dot.sqlite');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? randomBytes(12).toString('hex');

mkdirSync(dirname(DB_PATH), { recursive: true });
const store = new Store(DB_PATH);
const service = new Service(store);
service.refreshBaselines(Date.now(), true);

function safely(name: string, fn: () => unknown): void {
  try {
    fn();
  } catch (err) {
    console.error(`[${name}]`, err);
  }
}

// Boucles de fond : état des quartiers chaque minute, apprentissage et notation plus lentement.
safely('tick', () => service.tick(Date.now()));
setInterval(() => safely('tick', () => service.tick(Date.now())), MINUTE);
setInterval(() => safely('réputation', () => service.scoreSources(Date.now())), 5 * MINUTE);
setInterval(() => safely('annonces', () => service.scorePlanned(Date.now())), 15 * MINUTE);
setInterval(() => {
  safely('prévisions', () => service.recordPredictions(Date.now()));
  safely('calibration', () => service.resolvePredictions(Date.now()));
}, 15 * MINUTE);
void refreshWeather(store);
setInterval(() => void refreshWeather(store), 60 * MINUTE);

createServer(createHandler(service, { adminToken: ADMIN_TOKEN })).listen(PORT, () => {
  console.log(`Dot — anticipation des coupures : http://localhost:${PORT}`);
  console.log(`Base de données : ${DB_PATH}`);
  if (!process.env.ADMIN_TOKEN) console.log(`Jeton admin (temporaire) : ${ADMIN_TOKEN}  →  http://localhost:${PORT}/admin.html`);
});
