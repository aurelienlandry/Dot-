import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { CITIES, ZONES, ZONES_BY_ID } from '../data/zones.ts';
import { DAY, HOUR, MINUTE, TZ_OFFSET_MS } from '../engine/math.ts';
import { INCIDENT_LABELS } from '../engine/nowcast.ts';
import type { IncidentType, Observation } from '../engine/types.ts';
import type { Service } from './service.ts';

const PUBLIC_DIR = join(import.meta.dirname, '..', '..', 'public');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 16_384) throw new HttpError(413, 'Requête trop volumineuse');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'JSON invalide');
  }
}

const SOURCE_RE = /^[A-Za-z0-9_-]{8,64}$/;

function requireSource(v: unknown): string {
  if (typeof v !== 'string' || !SOURCE_RE.test(v)) throw new HttpError(400, 'Identifiant d’appareil invalide');
  return `dev:${v}`;
}

function requireZone(v: unknown): string {
  if (typeof v !== 'string' || !ZONES_BY_ID.has(v)) throw new HttpError(400, 'Quartier inconnu');
  return v;
}

/** Heure de l'observation : celle du téléphone si plausible (envoi différé hors connexion), sinon maintenant. */
function observedAt(v: unknown, now: number): number {
  const t = typeof v === 'number' ? v : NaN;
  if (Number.isFinite(t) && t <= now + 2 * MINUTE && t >= now - 6 * HOUR) return Math.min(t, now);
  return now;
}

// Anti-abus : un même appareil ne peut pas inonder un quartier.
const lastSeen = new Map<string, number>();
function rateLimit(key: string, now: number, minGapMs: number): void {
  const prev = lastSeen.get(key);
  if (prev !== undefined && now - prev < minGapMs) throw new HttpError(429, 'Trop de signalements rapprochés, réessayez dans un instant.');
  lastSeen.set(key, now);
  if (lastSeen.size > 50_000) lastSeen.clear();
}

/** Début du jour / mois / année en heure locale du Cameroun. */
function periodStart(period: string, now: number): number {
  const d = new Date(now + TZ_OFFSET_MS);
  if (period === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - TZ_OFFSET_MS;
  if (period === 'year') return Date.UTC(d.getUTCFullYear(), 0, 1) - TZ_OFFSET_MS;
  if (period === '30d') return now - 30 * DAY;
  if (period === '7d') return now - 7 * DAY;
  return 0;
}

export function createHandler(service: Service, opts: { adminToken: string; now?: () => number }) {
  const clock = opts.now ?? Date.now;

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const now = clock();
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (method === 'GET' && path === '/api/zones') {
      return send(res, 200, {
        cities: CITIES,
        zones: ZONES.map(({ id, name, city, lat, lon, feeder }) => ({ id, name, city, lat, lon, feeder })),
        incidents: INCIDENT_LABELS,
        demo: service.store.hasDemoData(),
      });
    }

    if (method === 'GET' && path === '/api/status') {
      const city = url.searchParams.get('city') ?? CITIES[0];
      if (!CITIES.includes(city)) throw new HttpError(400, 'Ville inconnue');
      const nowcasts = service.nowcastCity(city, now);
      return send(res, 200, {
        at: now,
        city,
        zones: [...nowcasts.values()].map((n) => ({
          zoneId: n.zoneId,
          pOut: n.pOut,
          confidence: n.confidence,
          topReason: n.evidence[0]?.label ?? null,
          since: service.store.openEpisode(n.zoneId)?.start ?? null,
        })),
      });
    }

    const zoneMatch = path.match(/^\/api\/zone\/([a-z0-9-]+)$/);
    if (method === 'GET' && zoneMatch) {
      const zoneId = requireZone(zoneMatch[1]);
      const d = service.zoneDetail(zoneId, now);
      return send(res, 200, { at: now, ...d, nowcast: { ...d.nowcast, evidence: d.nowcast.evidence.slice(0, 8) } });
    }

    if (method === 'POST' && (path === '/api/report' || path === '/api/device' || path === '/api/incident')) {
      const body = await readJson(req);
      const sourceId = requireSource(body.deviceId);
      const zoneId = requireZone(body.zoneId);
      const at = observedAt(body.at, now);
      let obs: Observation;
      if (path === '/api/report') {
        if (body.state !== 'out' && body.state !== 'on') throw new HttpError(400, 'État invalide');
        rateLimit(`r|${sourceId}|${zoneId}`, now, 60_000);
        obs = { kind: 'report', sourceId, zoneId, at, state: body.state };
      } else if (path === '/api/device') {
        if (body.event !== 'power_lost' && body.event !== 'power_back' && body.event !== 'charging') throw new HttpError(400, 'Événement invalide');
        rateLimit(`d|${sourceId}|${body.event}`, now, body.event === 'charging' ? 5 * MINUTE : 20_000);
        obs = { kind: 'device', sourceId, zoneId, at, event: body.event };
      } else {
        if (typeof body.incident !== 'string' || !(body.incident in INCIDENT_LABELS)) throw new HttpError(400, 'Incident invalide');
        rateLimit(`i|${sourceId}|${zoneId}|${body.incident}`, now, 10 * MINUTE);
        obs = { kind: 'incident', sourceId, zoneId, at, incident: body.incident as IncidentType };
      }
      service.store.addObservation(obs);
      const n = service.nowcastZone(zoneId, now);
      return send(res, 201, { ok: true, pOut: n.pOut, confidence: n.confidence });
    }

    if (method === 'GET' && path === '/api/bilan') {
      const city = url.searchParams.get('city') ?? CITIES[0];
      if (!CITIES.includes(city)) throw new HttpError(400, 'Ville inconnue');
      const period = url.searchParams.get('period') ?? 'year';
      return send(res, 200, service.bilan(city, periodStart(period, now), now));
    }

    if (method === 'GET' && path === '/api/reliability') {
      return send(res, 200, service.reliabilityReport(now));
    }

    if (method === 'GET' && path === '/api/planned') {
      return send(res, 200, service.store.plannedOverlapping(now - DAY, now + 30 * DAY));
    }

    if (path.startsWith('/api/admin/')) {
      if (req.headers.authorization !== `Bearer ${opts.adminToken}`) throw new HttpError(401, 'Jeton administrateur requis');
      if (method === 'POST' && path === '/api/admin/planned') {
        const b = await readJson(req);
        const zoneIds = Array.isArray(b.zoneIds) ? b.zoneIds.map(requireZone) : [];
        const start = Number(b.start);
        const end = Number(b.end);
        if (!zoneIds.length) throw new HttpError(400, 'Choisir au moins un quartier');
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 3 * DAY) throw new HttpError(400, 'Créneau invalide');
        const source = typeof b.source === 'string' && /^[a-z0-9-]{2,32}$/.test(b.source) ? b.source : 'eneo';
        const id = service.store.addPlanned({
          sourceId: `official:${source}`,
          zoneIds,
          start,
          end,
          note: typeof b.note === 'string' ? b.note.slice(0, 300) : undefined,
          url: typeof b.url === 'string' && /^https?:\/\//.test(b.url) ? b.url.slice(0, 500) : undefined,
        });
        return send(res, 201, { id });
      }
      const del = path.match(/^\/api\/admin\/planned\/(\d+)$/);
      if (method === 'DELETE' && del) {
        service.store.deletePlanned(Number(del[1]));
        return send(res, 200, { ok: true });
      }
    }

    throw new HttpError(404, 'Introuvable');
  }

  async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
    const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
    const file = join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'Interdit' });
    try {
      const data = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'cache-control': rel === '/sw.js' ? 'no-cache' : 'public, max-age=300',
      });
      res.end(data);
    } catch {
      send(res, 404, { error: 'Introuvable' });
    }
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else await serveStatic(res, decodeURIComponent(url.pathname));
    } catch (err) {
      if (err instanceof HttpError) send(res, err.status, { error: err.message });
      else {
        console.error(err);
        send(res, 500, { error: 'Erreur interne' });
      }
    }
  };
}
