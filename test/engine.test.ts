import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultBaseline, learnBaselines } from '../src/engine/baseline.ts';
import { brier, reliabilityBuckets, truthFrom } from '../src/engine/calibration.ts';
import { episodeStep } from '../src/engine/episodes.ts';
import { forecast, probabilityAt, windows } from '../src/engine/forecast.ts';
import { DAY, HOUR, hourOfWeek, MINUTE } from '../src/engine/math.ts';
import { combine, latestCluster, localEvidence, summarize } from '../src/engine/nowcast.ts';
import { judgeClaim, reliability, updateReputation } from '../src/engine/reputation.ts';
import type { Observation, Reputation, Zone } from '../src/engine/types.ts';
import { cellOf, cellsWithin, groupAreas } from '../src/engine/geo.ts';

const NOW = Date.UTC(2026, 10, 20, 18, 0); // jeudi 19h heure de Douala
const makepe: Zone = { id: 'dla-makepe', name: 'Makepe', city: 'Douala', lat: 4.08, lon: 9.748 };
const kotto: Zone = { id: 'dla-kotto', name: 'Kotto', city: 'Douala', lat: 4.075, lon: 9.765 };
const P = { lat: 4.08, lon: 9.748 };

function now(observations: Observation[], reps = new Map<string, Reputation>(), zone = makepe) {
  const local = localEvidence({ zone, at: NOW, observations, planned: [], reputations: reps, baseline: defaultBaseline() });
  return combine(zone, NOW, local, []);
}

const dev = (id: string, minAgo: number, event: 'power_lost' | 'power_back' | 'charging' | 'wifi_lost' = 'power_lost'): Observation => ({
  kind: 'device', sourceId: id, zoneId: 'dla-makepe', ...P, at: NOW - minAgo * MINUTE, event,
});

test("sans aucun indice, on reste sur l'a priori et la confiance est faible", () => {
  const n = now([]);
  assert.ok(n.pOut < 0.2);
  assert.equal(n.confidence, 'faible');
});

test('un seul téléphone qui arrête de charger reste ambigu', () => {
  const n = now([dev('a', 2)]);
  assert.ok(n.pOut > 0.05 && n.pOut < 0.5, `pOut=${n.pOut}`);
});

test('plusieurs téléphones qui perdent la charge à la même minute = coupure quasi certaine', () => {
  const n = now([dev('a', 10), dev('b', 9), dev('c', 9), dev('d', 8), dev('e', 8)]);
  assert.ok(n.pOut > 0.97, `pOut=${n.pOut}`);
  assert.equal(n.confidence, 'forte');
  assert.ok(n.evidence.some((e) => e.kind === 'cluster'));
  assert.equal(n.onsetHint, NOW - 10 * MINUTE);
});

test('les mêmes événements étalés sur des heures ne forment pas un groupe', () => {
  assert.equal(latestCluster([{ sourceId: 'a', at: 0 }, { sourceId: 'b', at: 2 * HOUR }]), null);
  assert.equal(latestCluster([{ sourceId: 'a', at: 0 }, { sourceId: 'a', at: MINUTE }]), null);
  assert.equal(latestCluster([{ sourceId: 'a', at: 0 }, { sourceId: 'b', at: MINUTE }])?.size, 2);
});

test('le retour groupé du courant annule la coupure', () => {
  const n = now([dev('a', 60), dev('b', 60), dev('c', 59), dev('a', 5, 'power_back'), dev('b', 4, 'power_back'), dev('c', 4, 'power_back')]);
  assert.ok(n.pOut < 0.05, `pOut=${n.pOut}`);
  assert.equal(n.restoreHint, NOW - 5 * MINUTE);
});

test('rendements décroissants : des dizaines de comptes neufs ne valent pas des sources fiables', () => {
  const spam: Observation[] = Array.from({ length: 30 }, (_, i) => ({ kind: 'report', sourceId: `bot${i}`, zoneId: 'dla-makepe', ...P, at: NOW - MINUTE, state: 'out' }));
  const reliable = new Map<string, Reputation>([['vet', { alpha: 40, beta: 2 }]]);
  const nSpam = now(spam);
  const nTruth = now([{ kind: 'report', sourceId: 'vet', zoneId: 'dla-makepe', ...P, at: NOW - MINUTE, state: 'on' }, ...spam], reliable);
  // 30 comptes inconnus rendent la coupure probable, mais jamais certaine.
  assert.ok(nSpam.pOut > 0.7 && nSpam.pOut < 0.95, `pOut=${nSpam.pOut}`);
  assert.ok(nTruth.pOut < nSpam.pOut);
  // Somme bornée : 30 comptes ≈ 6,7 × un compte, pas 30 ×.
  const one = now(spam.slice(0, 1)).evidence[0].logLR;
  const total = nSpam.evidence.reduce((s, e) => s + e.logLR, 0);
  assert.ok(total < 7 * one, `total=${total}, one=${one}`);
});

test("un incident grave fait monter la probabilité avant toute confirmation, et plus encore s'il est recoupé", () => {
  const inc = (id: string): Observation => ({ kind: 'incident', sourceId: id, zoneId: 'dla-makepe', ...P, at: NOW - 5 * MINUTE, incident: 'transformer_fire' });
  const base = now([]).pOut;
  const one = now([inc('x')]);
  const three = now([inc('x'), inc('y'), inc('z')]);
  assert.ok(one.pOut > base * 2);
  assert.ok(three.pOut > one.pOut);
  assert.ok(three.incidentSeverity > one.incidentSeverity);
});

test('propagation : une coupure à 700 m pèse, une coupure à 5 km presque pas', () => {
  const obsKotto: Observation[] = ['a', 'b', 'c', 'd'].map((id) => ({ kind: 'device', sourceId: id, zoneId: 'dla-kotto', lat: kotto.lat, lon: kotto.lon, at: NOW - 3 * MINUTE, event: 'power_lost' }));
  const args = { at: NOW, planned: [], reputations: new Map(), baseline: defaultBaseline() };
  const mine = localEvidence({ ...args, zone: makepe, observations: [] });
  const theirs = localEvidence({ ...args, zone: kotto, observations: obsKotto });
  const alone = combine(makepe, NOW, mine, []);
  const close = combine(makepe, NOW, mine, [{ zone: kotto, local: theirs, distanceKm: 0.7 }]);
  const far = combine(makepe, NOW, mine, [{ zone: kotto, local: theirs, distanceKm: 5 }]);
  assert.ok(close.pOut > alone.pOut * 3, `${alone.pOut} -> ${close.pOut}`);
  assert.ok(far.pOut < alone.pOut * 1.5);
  assert.equal(summarize(close), 'Coupure signalée tout près');
});

test('le Wi-Fi de la maison qui disparaît chez plusieurs personnes ensemble compte comme une coupure', () => {
  const n = now([dev('a', 6, 'wifi_lost'), dev('b', 5), dev('c', 5, 'wifi_lost')]);
  assert.ok(n.pOut > 0.8, `pOut=${n.pOut}`);
  assert.equal(summarize(n), 'Confirmé par des habitants');
});

test('grille : cases, voisinage et regroupement en zones (point + rayon)', () => {
  const c = cellOf(4.0801, 9.7481);
  assert.equal(c.id, cellOf(4.0805, 9.7485).id);
  assert.ok(cellsWithin(4.08, 9.748, 0.7).length >= 4);
  const areas = groupAreas([
    { lat: 4.08, lon: 9.748, pOut: 0.9 }, { lat: 4.084, lon: 9.748, pOut: 0.8 }, { lat: 4.2, lon: 9.9, pOut: 0.95 }, { lat: 4.05, lon: 9.7, pOut: 0.1 },
  ], 0.6);
  assert.equal(areas.length, 2);
  assert.ok(areas[0].radiusKm > 0.3 && areas[0].radiusKm < 1);
});

test('réputation : se tromper fait perdre de l’influence, avoir raison en fait gagner', () => {
  let rep: Reputation | undefined;
  const r0 = reliability(rep);
  for (let i = 0; i < 5; i++) rep = updateReputation(rep, true);
  assert.ok(reliability(rep) > r0);
  let bad: Reputation | undefined;
  for (let i = 0; i < 5; i++) bad = updateReputation(bad, false);
  assert.equal(reliability(bad), 0.5); // plus aucune influence
  assert.equal(judgeClaim(true, { pOut: 0.9, evidenceWeight: 3 }), true);
  assert.equal(judgeClaim(true, { pOut: 0.1, evidenceWeight: 3 }), false);
  assert.equal(judgeClaim(true, { pOut: 0.9, evidenceWeight: 0.5 }), null);
});

test('prévision : une coupure programmée apparaît dans la fenêtre annoncée', () => {
  const planned = [{ id: 1, sourceId: 'eneo', lat: 4.081, lon: 9.749, radiusKm: 1, label: 'Makepe', start: NOW + 2 * HOUR, end: NOW + 5 * HOUR }];
  const pts = forecast({ ...P, at: NOW, pNow: 0.05, baseline: defaultBaseline(), planned, reputations: new Map(), weatherByHour: new Map(), incidentSeverity: 0 });
  assert.ok(probabilityAt(pts, NOW + 3 * HOUR)! > 0.7);
  assert.ok(probabilityAt(pts, NOW + HOUR)! < 0.2);
  assert.ok(probabilityAt(pts, NOW + 8 * HOUR)! < 0.2);
  const safe = windows(pts, (p) => p.pOut < 0.2);
  assert.ok(safe.length >= 2);
});

test("prévision : une coupure en cours se résorbe selon la durée moyenne, plus lentement s'il y a un incident grave", () => {
  const args = { ...P, at: NOW, pNow: 0.95, baseline: defaultBaseline(), planned: [], reputations: new Map(), weatherByHour: new Map() };
  const normal = probabilityAt(forecast({ ...args, incidentSeverity: 0 }), NOW + 3 * HOUR)!;
  const severe = probabilityAt(forecast({ ...args, incidentSeverity: 2 }), NOW + 3 * HOUR)!;
  assert.ok(normal < 0.5);
  assert.ok(severe > normal);
});

test("l'historique apprend les heures à risque d'un quartier", () => {
  const from = NOW - 120 * DAY;
  const episodes = [];
  // Coupure presque tous les soirs à 19h à Makepe, rarement ailleurs.
  for (let d = 0; d < 120; d++) {
    const day = from + d * DAY;
    const start = day + ((19 - 1 - new Date(day).getUTCHours() + 24) % 24) * HOUR; // 19h locale
    if (d % 4 !== 0) episodes.push({ zoneId: 'dla-makepe', start, end: start + 2 * HOUR });
    if (d % 20 === 0) episodes.push({ zoneId: 'dla-kotto', start: start - 6 * HOUR, end: start - 5 * HOUR });
  }
  const b = learnBaselines(episodes, ['dla-makepe', 'dla-kotto'], from, NOW);
  const mk = b.get('dla-makepe')!;
  const how19 = hourOfWeek(NOW); // jeudi 19h
  const how3 = how19 - 16;
  assert.ok(mk.startsPerHour[how19] > 5 * mk.startsPerHour[how3]);
  assert.ok(mk.startsPerHour[how19] > b.get('dla-kotto')!.startsPerHour[how19]);
  assert.ok(Math.abs(mk.meanOutageHours - 2) < 0.3);
});

test('suivi des coupures avec hystérésis', () => {
  const open = episodeStep(false, null, { ...now([]), pOut: 0.9, evidenceWeight: 3, onsetHint: NOW - 10 * MINUTE });
  assert.deepEqual(open, { action: 'open', start: NOW - 10 * MINUTE });
  assert.equal(episodeStep(false, null, { ...now([]), pOut: 0.9, evidenceWeight: 0.5 }), null);
  assert.equal(episodeStep(true, NOW - HOUR, { ...now([]), pOut: 0.5 }), null);
  assert.deepEqual(episodeStep(true, NOW - HOUR, { ...now([]), pOut: 0.1, restoreHint: NOW - 2 * MINUTE }), { action: 'close', end: NOW - 2 * MINUTE });
});

test('calibration : Brier et diagramme de fiabilité', () => {
  const rows = [{ p: 0.9, outcome: true }, { p: 0.9, outcome: true }, { p: 0.1, outcome: false }, { p: 0.7, outcome: false }];
  assert.ok(Math.abs(brier(rows)! - (0.01 + 0.01 + 0.01 + 0.49) / 4) < 1e-9);
  const b = reliabilityBuckets(rows);
  assert.equal(b[9].n, 2);
  assert.equal(b[9].observed, 1);
  assert.equal(truthFrom({ pOut: 0.95, evidenceWeight: 3 }), true);
  assert.equal(truthFrom({ pOut: 0.95, evidenceWeight: 1 }), null);
});
