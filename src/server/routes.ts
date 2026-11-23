// Routes de l'API, indépendantes du transport : utilisées par le serveur Node (api.ts)
// et par la démo qui tourne entièrement dans le navigateur.

import { CITIES, CITY_COORDS, cityOf, QUARTIERS_BY_ID } from '../data/zones.ts';
import { blur, cellOf } from '../engine/geo.ts';
import { DAY, HOUR, MINUTE, TZ_OFFSET_MS } from '../engine/math.ts';
import { INCIDENT_LABELS } from '../engine/nowcast.ts';
import type { DeviceEvent, IncidentType, Observation } from '../engine/types.ts';
import type { Service } from './service.ts';

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface RouteRequest {
  method: string;
  url: URL;
  body: Record<string, unknown>;
  auth?: string;
}

const SOURCE_RE = /^[A-Za-z0-9_-]{8,64}$/;
const DEVICE_EVENTS: DeviceEvent[] = ['power_lost', 'power_back', 'charging', 'wifi_lost', 'wifi_back'];

function source(v: unknown): string {
  if (typeof v !== 'string' || !SOURCE_RE.test(v)) throw new HttpError(400, 'Identifiant d’appareil invalide');
  return `dev:${v}`;
}

/** Position valide, limitée au Cameroun (large boîte). */
function position(latV: unknown, lonV: unknown): { lat: number; lon: number } {
  const lat = Number(latV);
  const lon = Number(lonV);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 1.5 || lat > 13.2 || lon < 8.3 || lon > 16.3) {
    throw new HttpError(400, 'Position hors du Cameroun ou invalide');
  }
  return { lat, lon };
}

function observedAt(v: unknown, now: number): number {
  const t = typeof v === 'number' ? v : NaN;
  if (Number.isFinite(t) && t <= now + 2 * MINUTE && t >= now - 6 * HOUR) return Math.min(t, now);
  return now;
}

function periodStart(period: string, now: number): number {
  const d = new Date(now + TZ_OFFSET_MS);
  if (period === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - TZ_OFFSET_MS;
  if (period === 'year') return Date.UTC(d.getUTCFullYear(), 0, 1) - TZ_OFFSET_MS;
  if (period === '30d') return now - 30 * DAY;
  return 0;
}

const lastSeen = new Map<string, number>();
function rateLimit(key: string, now: number, minGapMs: number): void {
  const prev = lastSeen.get(key);
  if (prev !== undefined && now - prev < minGapMs) throw new HttpError(429, 'Vous venez déjà de signaler, merci ! Réessayez dans une minute.');
  lastSeen.set(key, now);
  if (lastSeen.size > 50_000) lastSeen.clear();
}

export function createRoutes(service: Service, opts: { adminToken?: string; demo?: boolean }) {
  const store = service.store;

  return function handle(req: RouteRequest, now: number): { status: number; data: unknown } {
    const { method, url, body } = req;
    const q = url.searchParams;
    const path = url.pathname;

    if (method === 'GET' && path === '/api/meta') {
      return {
        status: 200,
        data: {
          cities: CITIES.map((c) => ({ name: c, ...CITY_COORDS[c] })),
          quartiers: [...QUARTIERS_BY_ID.values()].map(({ id, name, city, lat, lon }) => ({ id, name, city, lat, lon })),
          incidents: INCIDENT_LABELS,
          demo: opts.demo ?? store.hasDemoData(),
        },
      };
    }

    if (method === 'GET' && path === '/api/place') {
      const { lat, lon } = position(q.get('lat'), q.get('lon'));
      return { status: 200, data: { at: now, ...service.placeDetail(lat, lon, now) } };
    }

    if (method === 'GET' && path === '/api/map') {
      const city = q.get('city') ?? CITIES[0];
      if (!CITIES.includes(city)) throw new HttpError(400, 'Ville inconnue');
      return { status: 200, data: service.mapView(city, now) };
    }

    if (method === 'POST' && (path === '/api/report' || path === '/api/device' || path === '/api/incident')) {
      const sourceId = source(body.deviceId);
      const raw = position(body.lat, body.lon);
      const pos = blur(raw.lat, raw.lon);
      const zoneId = cellOf(pos.lat, pos.lon).id;
      const at = observedAt(body.at, now);
      const base = { sourceId, zoneId, lat: pos.lat, lon: pos.lon, at };
      let obs: Observation;
      if (path === '/api/report') {
        if (body.state !== 'out' && body.state !== 'on') throw new HttpError(400, 'État invalide');
        rateLimit(`r|${sourceId}|${zoneId}`, now, 60_000);
        obs = { kind: 'report', ...base, state: body.state };
      } else if (path === '/api/device') {
        if (!DEVICE_EVENTS.includes(body.event as DeviceEvent)) throw new HttpError(400, 'Événement invalide');
        rateLimit(`d|${sourceId}|${body.event}`, now, body.event === 'charging' ? 5 * MINUTE : 20_000);
        obs = { kind: 'device', ...base, event: body.event as DeviceEvent };
      } else {
        if (typeof body.incident !== 'string' || !(body.incident in INCIDENT_LABELS)) throw new HttpError(400, 'Incident invalide');
        rateLimit(`i|${sourceId}|${zoneId}|${body.incident}`, now, 10 * MINUTE);
        obs = { kind: 'incident', ...base, incident: body.incident as IncidentType };
      }
      store.addObservation(obs);
      return { status: 201, data: { ok: true } };
    }

    if (path === '/api/profile') {
      const sourceId = source(method === 'GET' ? q.get('deviceId') : body.deviceId);
      if (method === 'POST') {
        const pseudo = typeof body.pseudo === 'string' ? body.pseudo.trim().replace(/\s+/g, ' ') : '';
        if (pseudo.length < 2 || pseudo.length > 24) throw new HttpError(400, 'Le pseudo doit faire entre 2 et 24 caractères.');
        store.setProfile(sourceId, pseudo, now);
      }
      return { status: 200, data: service.profile(sourceId) };
    }

    if (method === 'GET' && path === '/api/history') {
      const { lat, lon } = position(q.get('lat'), q.get('lon'));
      return { status: 200, data: service.placeHistory(cellOf(lat, lon).id, periodStart(q.get('period') ?? 'year', now), now) };
    }

    if (method === 'GET' && path === '/api/bilan') {
      const city = q.get('city') ?? CITIES[0];
      if (!CITIES.includes(city)) throw new HttpError(400, 'Ville inconnue');
      return { status: 200, data: service.bilan(city, periodStart(q.get('period') ?? 'year', now), now) };
    }

    if (method === 'GET' && path === '/api/reliability') return { status: 200, data: service.reliabilityReport(now) };

    if (method === 'GET' && path === '/api/planned') return { status: 200, data: store.plannedOverlapping(now - DAY, now + 30 * DAY) };

    if (path.startsWith('/api/admin/')) {
      if (!opts.adminToken || req.auth !== `Bearer ${opts.adminToken}`) throw new HttpError(401, 'Jeton administrateur requis');
      if (method === 'POST' && path === '/api/admin/planned') {
        const start = Number(body.start);
        const end = Number(body.end);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 3 * DAY) throw new HttpError(400, 'Créneau invalide');
        const src = typeof body.source === 'string' && /^[a-z0-9-]{2,32}$/.test(body.source) ? body.source : 'eneo';
        const note = typeof body.note === 'string' ? body.note.slice(0, 300) : undefined;
        const link = typeof body.url === 'string' && /^https?:\/\//.test(body.url) ? body.url.slice(0, 500) : undefined;
        // Soit des quartiers connus (1 km autour de leur centre), soit un point et un rayon.
        const areas = Array.isArray(body.quartiers) && body.quartiers.length
          ? body.quartiers.map((id) => {
              const z = QUARTIERS_BY_ID.get(String(id));
              if (!z) throw new HttpError(400, 'Quartier inconnu');
              return { lat: z.lat, lon: z.lon, radiusKm: 1, label: z.name };
            })
          : [{ ...position(body.lat, body.lon), radiusKm: Math.min(10, Math.max(0.2, Number(body.radiusKm) || 1)), label: typeof body.label === 'string' && body.label ? body.label.slice(0, 120) : 'Zone annoncée' }];
        const ids = areas.map((a) => store.addPlanned({ sourceId: `official:${src}`, ...a, start, end, note, url: link }));
        return { status: 201, data: { ids, city: cityOf(areas[0].lat, areas[0].lon) } };
      }
      const del = path.match(/^\/api\/admin\/planned\/(\d+)$/);
      if (method === 'DELETE' && del) {
        store.deletePlanned(Number(del[1]));
        return { status: 200, data: { ok: true } };
      }
    }

    throw new HttpError(404, 'Introuvable');
  };
}
