// Récupère les signaux publics pour Yaoundé et les résume heure par heure :
//  - IODA (Georgia Tech) : connectivité Internet de la région Centre (blocs d'adresses qui répondent,
//    routes BGP) et événements de panne détectés ;
//  - Open-Meteo : pluie, orages, rafales, observés et prévus.
// Résultat : web-labo/data.json, intégré ensuite dans la page « Labo ».
//   NODE_USE_ENV_PROXY=1 node scripts/labo-snapshot.ts

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const REGION = { code: '681', name: 'Centre', city: 'Yaoundé', lat: 3.87, lon: 11.52 };
const DAYS = 30;
const HOUR = 3600;

async function getJson(url: string): Promise<any> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    const body = await res.json();
    if (res.ok && !body.error) return body;
    if (attempt < 3) await new Promise((r) => setTimeout(r, 20_000 * (attempt + 1)));
    else throw new Error(`${url} → ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  }
}

const median = (a: number[]) => {
  const s = a.slice().sort((x, y) => x - y);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};

/** Rapport à la normale : valeur / médiane du même créneau horaire les 7 jours précédents. */
function ratios(from: number, step: number, values: (number | null)[]) {
  const slots = 86400 / step;
  const out = new Map<number, number>();
  values.forEach((v, i) => {
    if (v === null) return;
    const hist: number[] = [];
    for (let d = 1; d <= 7; d++) {
      const w = values[i - d * slots];
      if (w !== null && w !== undefined) hist.push(w);
    }
    if (hist.length >= 4) {
      const ref = median(hist);
      if (ref > 0) out.set(from + i * step, v / ref);
    }
  });
  return out;
}

const now = Math.floor(Date.now() / 1000);
const from = now - (DAYS + 7) * 86400; // 7 jours de plus pour calculer la « normale »
const base = 'https://api.ioda.inetintel.cc.gatech.edu/v2';

const sig = await getJson(`${base}/signals/raw/region/${REGION.code}?from=${from}&until=${now}`);
const series = sig.data[0] as { datasource: string; from: number; step: number; values: unknown[] }[];
const pick = (name: string) => series.find((s) => s.datasource === name)!;
const ping = pick('ping-slash24');
const bgp = pick('bgp');
const pingR = ratios(ping.from, ping.step, ping.values as (number | null)[]);
const bgpR = ratios(bgp.from, bgp.step, bgp.values as (number | null)[]);

const events = (await getJson(`${base}/outages/events?entityType=region&entityCode=${REGION.code}&from=${now - DAYS * 86400}&until=${now}&format=codf`)).data.map(
  (e: any) => ({ start: e.start * 1000, end: (e.start + e.duration) * 1000, score: Math.round(e.score), source: e.datasource }),
);
// Les mêmes événements à Douala au même moment trahissent une panne du réseau Internet national, pas une coupure locale.
const littoral = (await getJson(`${base}/outages/events?entityType=region&entityCode=679&from=${now - DAYS * 86400}&until=${now}&format=codf`)).data;
for (const e of events) e.alsoDouala = littoral.some((l: any) => Math.abs(l.start * 1000 - e.start) <= 30 * 60_000);

const meteo = await getJson(
  `https://api.open-meteo.com/v1/forecast?latitude=${REGION.lat}&longitude=${REGION.lon}&hourly=precipitation,weather_code,wind_gusts_10m&past_days=31&forecast_days=2&timeformat=unixtime`,
);
const mh = meteo.hourly;
const weather = new Map<number, { rain: number; storm: boolean; gust: number }>();
mh.time.forEach((t: number, i: number) => weather.set(t, { rain: mh.precipitation[i] ?? 0, storm: (mh.weather_code[i] ?? 0) >= 95, gust: mh.wind_gusts_10m[i] ?? 0 }));

// Résumé horaire : le pire rapport à la normale dans l'heure.
const hours: { t: number; net: number | null; bgp: number | null; rain: number; storm: boolean; gust: number }[] = [];
const start = Math.ceil((now - DAYS * 86400) / HOUR) * HOUR;
const end = Math.floor(now / HOUR) * HOUR + 48 * HOUR;
for (let t = start; t <= end; t += HOUR) {
  const inHour = (m: Map<number, number>) => [...m.entries()].filter(([ts]) => ts >= t && ts < t + HOUR).map(([, r]) => r);
  const n = t <= now ? inHour(pingR) : [];
  const b = t <= now ? inHour(bgpR) : [];
  const w = weather.get(t) ?? { rain: 0, storm: false, gust: 0 };
  hours.push({ t: t * 1000, net: n.length ? Math.round(Math.min(...n) * 100) / 100 : null, bgp: b.length ? Math.round(Math.min(...b) * 100) / 100 : null, ...w });
}

const out = { generatedAt: now * 1000, region: REGION, events, hours, sources: ['IODA (Georgia Tech) — api.ioda.inetintel.cc.gatech.edu', 'Open-Meteo — api.open-meteo.com'] };
mkdirSync(join(ROOT, 'web-labo'), { recursive: true });
writeFileSync(join(ROOT, 'web-labo', 'data.json'), JSON.stringify(out));
console.log(`Données : ${hours.length} heures, ${events.length} événements IODA, généré ${new Date(now * 1000).toISOString()}`);
