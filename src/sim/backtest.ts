// Banc d'essai de fiabilité : on connaît la vérité (coupures simulées), on la cache au moteur,
// on lui envoie seulement des signaux imparfaits, et on mesure ce qu'il en déduit.
//
// Sources imparfaites simulées :
//  - téléphones capteurs : seulement ~50 % sont en charge à un instant donné ;
//    ils sont débranchés au hasard (faux « power_lost ») ;
//  - foyers avec groupe électrogène / onduleur : leur téléphone continue de charger pendant la coupure ;
//  - signalements humains : rares et en retard ;
//  - trolls : signalent « coupé » au hasard.
//
//   npm run backtest  [-- --sensors 6 --days 14]

import { QUARTIERS } from '../data/zones.ts';
import { blur, cellOf, cellsWithin } from '../engine/geo.ts';
import { learnBaselines } from '../engine/baseline.ts';
import { brier } from '../engine/calibration.ts';
import { forecast, probabilityAt } from '../engine/forecast.ts';
import { DAY, HOUR, MINUTE } from '../engine/math.ts';
import { reliability } from '../engine/reputation.ts';
import type { Observation } from '../engine/types.ts';
import type { Episode } from '../engine/baseline.ts';
import { Store } from '../server/db.ts';
import { Service } from '../server/service.ts';
import { generateEpisodes, isOutAt, rng, trueRate } from './world.ts';

function arg(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
}

export interface BacktestOptions {
  city?: string;
  sensorsPerZone?: number;
  reportersPerZone?: number;
  trollsPerZone?: number;
  generatorShare?: number;
  trainDays?: number;
  testDays?: number;
  seed?: number;
}

export function runBacktest(opts: BacktestOptions = {}) {
  const city = opts.city ?? 'Douala';
  const sensors = opts.sensorsPerZone ?? 6;
  const reporters = opts.reportersPerZone ?? 10;
  const trolls = opts.trollsPerZone ?? 1;
  const generatorShare = opts.generatorShare ?? 0.15;
  const trainDays = opts.trainDays ?? 120;
  const testDays = opts.testDays ?? 14;
  const r = rng(opts.seed ?? 7);

  const zones = QUARTIERS.filter((z) => z.city === city);
  const t0 = Date.UTC(2026, 6, 1); // juillet : saison des pluies, cas difficile
  const testStart = t0 + trainDays * DAY;
  const testEnd = testStart + testDays * DAY;

  // Vérité terrain.
  const truth = new Map<string, Episode[]>();
  for (const z of zones) truth.set(z.id, generateEpisodes(z.id, t0, testEnd, r));

  const store = new Store(':memory:');
  const service = new Service(store);
  // L'historique d'entraînement est supposé connu (comme après plusieurs mois de fonctionnement).
  store.db.exec('BEGIN');
  for (const [zid, eps] of truth) {
    const q = zones.find((z) => z.id === zid)!;
    const cells = cellsWithin(q.lat, q.lon, 0.8);
    for (const e of eps) if (e.start < testStart) for (const c of cells) store.addEpisode({ ...e, zoneId: c.id });
  }
  store.db.exec('COMMIT');
  service.refreshBaselines(testStart, true);

  // --- Génération des signaux de la période de test (chaque personne a un domicile fixe à < 350 m du centre).
  const events: Observation[] = [];
  const homes = new Map<string, { lat: number; lon: number; zoneId: string }>();
  const home = (id: string, z: { lat: number; lon: number }) => {
    if (!homes.has(id)) {
      const p = blur(z.lat + (r() - 0.5) * 0.006, z.lon + (r() - 0.5) * 0.006);
      homes.set(id, { ...p, zoneId: cellOf(p.lat, p.lon).id });
    }
    return homes.get(id)!;
  };
  const trollIds = new Set<string>();
  for (const z of zones) {
    const eps = truth.get(z.id)!.filter((e) => (e.end ?? Infinity) > testStart && e.start < testEnd);
    for (let s = 0; s < sensors; s++) {
      const id = `dev:${z.id}-s${s}`;
      const hasGenerator = r() < generatorShare;
      // Débranchements aléatoires : ~1 toutes les 6 h quand le téléphone est en charge.
      for (let t = testStart; t < testEnd; t += 10 * MINUTE) {
        if (r() < (10 / 60) * (1 / 6) * 0.5) events.push({ kind: 'device', sourceId: id, ...home(id, z), at: t + r() * 10 * MINUTE, event: 'power_lost' });
        // Battement « en charge » quand l'appli est ouverte et que le courant est là (ou groupe électrogène).
        if (r() < 0.15 && (hasGenerator || !isOutAt(eps, t))) events.push({ kind: 'device', sourceId: id, ...home(id, z), at: t, event: 'charging' });
      }
      if (hasGenerator) continue;
      for (const e of eps) {
        if (r() < 0.5 && e.start >= testStart) events.push({ kind: 'device', sourceId: id, ...home(id, z), at: e.start + r() * MINUTE, event: 'power_lost' });
        if (r() < 0.5 && e.end !== null && e.end < testEnd) events.push({ kind: 'device', sourceId: id, ...home(id, z), at: e.end + r() * 1.5 * MINUTE, event: 'power_back' });
      }
    }
    for (let p = 0; p < reporters; p++) {
      const id = `dev:${z.id}-h${p}`;
      for (const e of eps) {
        if (r() < 0.25 && e.start >= testStart) events.push({ kind: 'report', sourceId: id, ...home(id, z), at: e.start + (5 + r() * 35) * MINUTE, state: 'out' });
        if (r() < 0.1 && e.end !== null && e.end < testEnd) events.push({ kind: 'report', sourceId: id, ...home(id, z), at: e.end + (2 + r() * 20) * MINUTE, state: 'on' });
      }
    }
    for (let k = 0; k < trolls; k++) {
      const id = `dev:${z.id}-troll${k}`;
      trollIds.add(id);
      for (let t = testStart; t < testEnd; t += HOUR) if (r() < 0.12) events.push({ kind: 'report', sourceId: id, ...home(id, z), at: t + r() * HOUR, state: 'out' });
    }
  }
  events.sort((a, b) => a.at - b.at);

  // --- Rejeu chronologique.
  const STEP = 10 * MINUTE;
  let cursor = 0;
  let correct = 0;
  let total = 0;
  let falseAlarmSteps = 0;
  let onSteps = 0;
  const detectedAt = new Map<Episode, number>();
  const fc: { h: number; p: number; naive: number; outcome: boolean }[] = [];
  const pending: { zoneId: string; target: number; h: number; p: number; naive: number }[] = [];

  for (let t = testStart; t < testEnd; t += STEP) {
    store.db.exec('BEGIN');
    while (cursor < events.length && events[cursor].at <= t) store.addObservation(events[cursor++]);
    store.db.exec('COMMIT');
    if ((t - testStart) % (30 * MINUTE) === 0) service.scoreSources(t);
    service.tick(t);

    for (const z of zones) {
      const n = service.nowcastAt(z.lat, z.lon, t);
      const eps = truth.get(z.id)!;
      const out = isOutAt(eps, t);
      total++;
      if ((n.pOut >= 0.5) === out) correct++;
      if (!out) {
        onSteps++;
        if (n.pOut >= 0.75) falseAlarmSteps++;
      } else if (n.pOut >= 0.75) {
        const e = eps.find((x) => x.start <= t && (x.end ?? Infinity) > t)!;
        if (!detectedAt.has(e)) detectedAt.set(e, t);
      }
      // Prévisions toutes les heures, comparées à la climatologie (taux moyen sans indices).
      if ((t - testStart) % HOUR === 0) {
        const b = service.baseline(cellOf(z.lat, z.lon).id, city);
        const pts = forecast({ lat: z.lat, lon: z.lon, at: t, pNow: n.pOut, baseline: b, planned: [], reputations: new Map(), weatherByHour: new Map(), incidentSeverity: n.incidentSeverity, horizonH: 3 });
        for (const h of [1, 3]) {
          const naive = (() => {
            const lam = b.startsPerHour.reduce((a, c) => a + c, 0) / 168;
            return lam / (lam + 1 / b.meanOutageHours);
          })();
          pending.push({ zoneId: z.id, target: t + h * HOUR, h, p: probabilityAt(pts, t + h * HOUR)!, naive });
        }
      }
    }
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i];
      if (p.target <= t) {
        fc.push({ h: p.h, p: p.p, naive: p.naive, outcome: isOutAt(truth.get(p.zoneId)!, p.target) });
        pending.splice(i, 1);
      }
    }
  }

  // --- Mesures.
  const testEpisodes = [...truth.values()].flat().filter((e) => e.start >= testStart && (e.end ?? testEnd) <= testEnd - HOUR && (e.end! - e.start) >= 15 * MINUTE);
  const delays = testEpisodes.filter((e) => detectedAt.has(e)).map((e) => (detectedAt.get(e)! - e.start) / MINUTE).sort((a, b) => a - b);
  const reps = store.allReputations();
  const relOf = (pred: (id: string) => boolean) => {
    const v = [...reps.entries()].filter(([id]) => pred(id)).map(([, rep]) => reliability(rep));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const skill = (h: number) => {
    const rows = fc.filter((x) => x.h === h);
    const model = brier(rows.map((x) => ({ p: x.p, outcome: x.outcome })))!;
    const naive = brier(rows.map((x) => ({ p: x.naive, outcome: x.outcome })))!;
    return { horizonH: h, n: rows.length, brier: model, brierClimatology: naive, skill: 1 - model / naive };
  };
  void trueRate;

  return {
    city,
    zones: zones.length,
    days: testDays,
    sensorsPerZone: sensors,
    outages: testEpisodes.length,
    detectionRate: delays.length / testEpisodes.length,
    medianDetectionDelayMin: delays.length ? delays[Math.floor(delays.length / 2)] : null,
    stateAccuracy: correct / total,
    falseAlarmRate: falseAlarmSteps / onSteps,
    forecast: [skill(1), skill(3)],
    reputation: {
      honestReporters: relOf((id) => /-h\d+$/.test(id)),
      trolls: relOf((id) => trollIds.has(id)),
      sensors: relOf((id) => /-s\d+$/.test(id)),
    },
  };
}

const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1)} %`);

if (import.meta.main) {
  const res = runBacktest({ sensorsPerZone: arg('sensors', 6), testDays: arg('days', 14), trollsPerZone: arg('trolls', 1), seed: arg('seed', 7) });
  console.log(`\nBanc d'essai — ${res.city}, ${res.zones} quartiers, ${res.days} jours, ${res.sensorsPerZone} téléphones capteurs/quartier`);
  console.log(`Coupures réelles (≥ 15 min)       : ${res.outages}`);
  console.log(`Coupures détectées                : ${pct(res.detectionRate)}`);
  console.log(`Délai médian de détection         : ${res.medianDetectionDelayMin?.toFixed(0)} min`);
  console.log(`État correct (courant / coupé)    : ${pct(res.stateAccuracy)}`);
  console.log(`Fausses alertes (temps)           : ${pct(res.falseAlarmRate)}`);
  for (const f of res.forecast) {
    console.log(`Prévision à ${f.horizonH} h : Brier ${f.brier.toFixed(3)} vs ${f.brierClimatology.toFixed(3)} sans indices → gain ${pct(f.skill)} (${f.n} prévisions)`);
  }
  console.log(`Fiabilité apprise — honnêtes : ${pct(res.reputation.honestReporters)}, trolls : ${pct(res.reputation.trolls)}, capteurs : ${pct(res.reputation.sensors)}\n`);
}
