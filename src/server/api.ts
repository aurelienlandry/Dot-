import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { createRoutes, HttpError } from './routes.ts';
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

export function createHandler(service: Service, opts: { adminToken: string; now?: () => number }) {
  const clock = opts.now ?? Date.now;
  const routes = createRoutes(service, { adminToken: opts.adminToken });

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
      if (url.pathname.startsWith('/api/')) {
        const method = req.method ?? 'GET';
        const body = method === 'POST' ? await readJson(req) : {};
        const r = routes({ method, url, body, auth: req.headers.authorization }, clock());
        send(res, r.status, r.data);
      } else await serveStatic(res, decodeURIComponent(url.pathname));
    } catch (err) {
      if (err instanceof HttpError) send(res, err.status, { error: err.message });
      else {
        console.error(err);
        send(res, 500, { error: 'Erreur interne' });
      }
    }
  };
}
