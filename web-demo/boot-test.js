// Test réel à Yaoundé : AUCUNE donnée simulée. Le moteur tourne dans le navigateur et ne voit que
// les vrais signalements, enregistrés dans la base partagée de la page (capacité « db ») :
// chacun écrit dans son propre document `reports/<id>`, tout le monde lit tout.

import { createRoutes } from './js/server/routes.js';
import { Service } from './js/server/service.js';
import { MemoryStore } from './memstore.js';

window.DOT_DEMO = true; // page intégrée : pas de fond de carte externe ni de service worker
window.DOT_TEST = true;
window.DOT_CITY = 'Yaoundé';
window.DOT_BANNER = 'Test réel à Yaoundé : rien n’est simulé, tout vient de vos signalements.';

const store = new MemoryStore();
const service = new Service(store);
const routes = createRoutes(service, { demo: false });
setInterval(() => service.tick(Date.now()), 60_000);

const MAX_ITEMS = 200;
const seen = new Set();
const VALUES = {
  report: ['out', 'on'],
  device: ['power_lost', 'power_back', 'charging', 'wifi_lost', 'wifi_back'],
  incident: ['transformer_fire', 'pole_down', 'cable_down', 'explosion', 'storm_damage'],
};
const FIELD = { report: 'state', device: 'event', incident: 'incident' };

/** Ajoute au moteur un signalement venu de la base partagée (donnée non fiable : on vérifie tout). */
function ingest(uid, it) {
  if (!it || typeof it !== 'object') return;
  const key = `${uid}:${it.id}`;
  if (seen.has(key)) return;
  const lat = Number(it.lat);
  const lon = Number(it.lon);
  const at = Number(it.at);
  if (!VALUES[it.kind]?.includes(it.value)) return;
  if (!(lat > 1.5 && lat < 13.2 && lon > 8.3 && lon < 16.3)) return;
  if (!(at > Date.now() - 400 * 86400000 && at < Date.now() + 120000)) return;
  seen.add(key);
  const p = blur(lat, lon);
  store.addObservation({ kind: it.kind, sourceId: `u:${uid}`, zoneId: cellOf(p.lat, p.lon).id, lat: p.lat, lon: p.lon, at, [FIELD[it.kind]]: it.value });
}

let shared = null;
let chain = Promise.resolve();
function saveShared(item) {
  if (!shared) return;
  seen.add(`${shared.uid}:${item.id}`);
  chain = chain
    .then(async () => {
      const ref = shared.db.collection('reports').doc(shared.uid);
      const snap = await ref.get();
      const items = Array.isArray(snap.data()?.items) ? snap.data().items : [];
      await ref.set({ items: [...items, item].slice(-MAX_ITEMS), updatedAt: Date.now() });
    })
    .catch((err) => console.warn('Enregistrement partagé impossible', err));
}

(async () => {
  window.DOT_SHARED = 'pending';
  const db = await window.claude?.use?.('db');
  const user = await window.claude?.use?.('user');
  if (!db || !user) {
    window.DOT_SHARED = 'off';
    return;
  }
  shared = { db, uid: await user.id() };
  window.DOT_SHARED = 'on';
  let timer = null;
  db.collection('reports').onSnapshot(
    (snap) => {
      for (const d of snap.docs) {
        const items = d.data()?.items;
        if (Array.isArray(items)) for (const it of items.slice(-MAX_ITEMS)) ingest(d.id, it);
      }
      service.tick(Date.now());
      clearTimeout(timer);
      timer = setTimeout(() => window.dispatchEvent(new Event('dot-data')), 300);
    },
    (err) => {
      console.warn('Lecture partagée impossible', err);
      window.DOT_SHARED = 'off';
    },
  );
})();

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const raw = typeof input === 'string' ? input : input.url;
  if (!raw.startsWith('/api/')) return realFetch(input, init);
  const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  try {
    const method = (init.method ?? 'GET').toUpperCase();
    const url = new URL(raw, 'http://test.local');
    const body = init.body ? JSON.parse(init.body) : {};
    const r = routes({ method, url, body }, Date.now());
    const kind = { '/api/report': 'report', '/api/device': 'device', '/api/incident': 'incident' }[url.pathname];
    if (method === 'POST' && kind) {
      const p = blur(Number(body.lat), Number(body.lon));
      saveShared({ id: Math.random().toString(36).slice(2, 12), kind, value: body[FIELD[kind]], lat: p.lat, lon: p.lon, at: Date.now() });
      service.tick(Date.now());
    }
    return json(r.status, r.data);
  } catch (err) {
    if (!err.status) console.error(err);
    return json(err.status ?? 500, { error: err.message });
  }
};
