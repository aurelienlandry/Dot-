// Démarrage de la démo autonome : le vrai moteur, le vrai service et les vraies routes de l'API
// tournent dans le navigateur, sur des données simulées. Aucun serveur n'est nécessaire.

import { createRoutes } from './js/server/routes.js';
import { Service } from './js/server/service.js';
import { seedScenario } from './js/sim/scenario.js';
import { MemoryStore } from './memstore.js';

window.DOT_DEMO = true;
const store = new MemoryStore();
const service = new Service(store);
const start = Date.now();
seedScenario(store, start);
service.refreshBaselines(start, true);
service.tick(start);
setInterval(() => service.tick(Date.now()), 60_000);
const routes = createRoutes(service, { demo: true });

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const raw = typeof input === 'string' ? input : input.url;
  if (!raw.startsWith('/api/')) return realFetch(input, init);
  const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  try {
    const method = (init.method ?? 'GET').toUpperCase();
    const r = routes({ method, url: new URL(raw, 'http://demo.local'), body: init.body ? JSON.parse(init.body) : {} }, Date.now());
    if (method === 'POST') service.tick(Date.now());
    return json(r.status, r.data);
  } catch (err) {
    if (!err.status) console.error(err);
    return json(err.status ?? 500, { error: err.message });
  }
};

// Démo : un profil et une maison déjà placés à Kotto (coupure en cours), plus un bureau à Akwa.
// L'appli les reprend au démarrage si aucun lieu n'est encore enregistré.
window.DOT_DEMO_SEED = {
  profile: { pseudo: 'Visiteur' },
  places: [
    { id: 'demo-home', type: 'maison', name: 'Maison', lat: 4.0752, lon: 9.7648, arrival: '19:00' },
    { id: 'demo-work', type: 'travail', name: 'Bureau', lat: 4.0497, lon: 9.7003, arrival: '08:00' },
  ],
};
await import('./app.js');
