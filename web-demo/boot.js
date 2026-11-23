// Démarrage de la démo autonome : le vrai moteur tourne dans le navigateur, sur des données simulées.
// Les appels /api/... de l'appli sont servis localement, sans serveur.

import { CITIES, ZONES, ZONES_BY_ID } from './js/data/zones.js';
import { TZ_OFFSET_MS } from './js/engine/math.js';
import { INCIDENT_LABELS } from './js/engine/nowcast.js';
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

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function periodStart(period, now) {
  const d = new Date(now + TZ_OFFSET_MS);
  if (period === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - TZ_OFFSET_MS;
  if (period === 'year') return Date.UTC(d.getUTCFullYear(), 0, 1) - TZ_OFFSET_MS;
  return 0;
}

const zone = (id) => {
  if (!ZONES_BY_ID.has(id)) throw new HttpError(400, 'Quartier inconnu');
  return id;
};

function handle(method, url, body) {
  const now = Date.now();
  const path = url.pathname;
  if (method === 'GET' && path === '/api/zones') {
    return { cities: CITIES, zones: ZONES.map(({ id, name, city, lat, lon, feeder }) => ({ id, name, city, lat, lon, feeder })), incidents: INCIDENT_LABELS, demo: true };
  }
  if (method === 'GET' && path === '/api/status') {
    const city = url.searchParams.get('city') ?? CITIES[0];
    const nowcasts = service.nowcastCity(city, now);
    return {
      at: now,
      city,
      zones: [...nowcasts.values()].map((n) => ({ zoneId: n.zoneId, pOut: n.pOut, confidence: n.confidence, topReason: n.evidence[0]?.label ?? null, since: store.openEpisode(n.zoneId)?.start ?? null })),
    };
  }
  const zm = path.match(/^\/api\/zone\/([a-z0-9-]+)$/);
  if (method === 'GET' && zm) {
    const d = service.zoneDetail(zone(zm[1]), now);
    return { at: now, ...d, nowcast: { ...d.nowcast, evidence: d.nowcast.evidence.slice(0, 8) } };
  }
  if (method === 'POST' && ['/api/report', '/api/device', '/api/incident'].includes(path)) {
    const sourceId = `dev:${body.deviceId}`;
    const zoneId = zone(body.zoneId);
    if (path === '/api/report') store.addObservation({ kind: 'report', sourceId, zoneId, at: now, state: body.state === 'on' ? 'on' : 'out' });
    else if (path === '/api/device') store.addObservation({ kind: 'device', sourceId, zoneId, at: now, event: body.event });
    else store.addObservation({ kind: 'incident', sourceId, zoneId, at: now, incident: body.incident });
    service.tick(now);
    const n = service.nowcastZone(zoneId, now);
    return { ok: true, pOut: n.pOut, confidence: n.confidence };
  }
  if (method === 'GET' && path === '/api/bilan') {
    return service.bilan(url.searchParams.get('city') ?? CITIES[0], periodStart(url.searchParams.get('period') ?? 'year', now), now);
  }
  if (method === 'GET' && path === '/api/reliability') return service.reliabilityReport(now);
  throw new HttpError(404, 'Introuvable');
}

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const raw = typeof input === 'string' ? input : input.url;
  if (!raw.startsWith('/api/')) return realFetch(input, init);
  const url = new URL(raw, 'http://demo.local');
  try {
    const data = handle((init.method ?? 'GET').toUpperCase(), url, init.body ? JSON.parse(init.body) : {});
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: err.message }), { status: err.status ?? 500, headers: { 'content-type': 'application/json' } });
  }
};

// Démo : on part de Kotto (coupure en cours) si aucun quartier n'a encore été choisi.
try {
  if (!localStorage.getItem('dot.home')) localStorage.setItem('dot.home', JSON.stringify('dla-kotto'));
} catch {
  /* stockage indisponible */
}
await import('./app.js');
