import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOUR, MINUTE } from '../src/engine/math.ts';
import { Store } from '../src/server/db.ts';
import { createRoutes } from '../src/server/routes.ts';
import { Service } from '../src/server/service.ts';
import { seedScenario } from '../src/sim/scenario.ts';

const NOW = Date.UTC(2026, 10, 20, 18, 0);

function setup() {
  const store = new Store(':memory:');
  const service = new Service(store);
  seedScenario(store, NOW);
  service.refreshBaselines(NOW, true);
  service.tick(NOW);
  const routes = createRoutes(service, { adminToken: 'secret' });
  const call = (method: string, path: string, body: Record<string, unknown> = {}, auth?: string) =>
    routes({ method, url: new URL(path, 'http://x'), body, auth }, NOW) as { status: number; data: any };
  return { store, service, call };
}

test('un lieu en pleine coupure : statut simple, depuis quand, retour probable', () => {
  const { call } = setup();
  const r = call('GET', '/api/place?lat=4.0752&lon=9.7648').data;
  assert.ok(r.pOut > 0.9);
  assert.equal(r.summary, 'Confirmé par des habitants');
  assert.ok(r.since && r.since <= NOW - 20 * MINUTE);
  assert.ok(r.likelyRestore > NOW && r.likelyRestore < NOW + 12 * HOUR);
  assert.equal(r.name, 'Kotto');
});

test('un lieu loin de tout signal : courant présumé, estimation sur l’historique', () => {
  const { call } = setup();
  const r = call('GET', '/api/place?lat=4.01&lon=9.79').data;
  assert.ok(r.pOut < 0.3);
  assert.equal(r.summary, 'Aucune coupure signalée');
  assert.ok(r.month.outages > 0);
});

test('la carte montre la zone coupée de Kotto avec un rayon, et les coupures annoncées', () => {
  const { call } = setup();
  const m = call('GET', '/api/map?city=Douala').data;
  const kotto = m.outages.find((a: any) => a.name.includes('Kotto'));
  assert.ok(kotto, JSON.stringify(m.outages));
  assert.ok(kotto.radiusM >= 300 && kotto.radiusM <= 1500);
  assert.equal(m.planned.length, 2);
});

test('signalement par position, profil avec pseudo, anti-abus', () => {
  const { call } = setup();
  assert.equal(call('POST', '/api/report', { deviceId: 'abcdefgh123', lat: 4.08, lon: 9.748, state: 'out' }).status, 201);
  assert.throws(() => call('POST', '/api/report', { deviceId: 'abcdefgh123', lat: 4.08, lon: 9.748, state: 'out' }), /Réessayez/);
  assert.throws(() => call('POST', '/api/report', { deviceId: 'abcdefgh123', lat: 48.8, lon: 2.3, state: 'out' }), /Cameroun/);
  const p = call('POST', '/api/profile', { deviceId: 'abcdefgh123', pseudo: '  Aurel  ' }).data;
  assert.equal(p.pseudo, 'Aurel');
  assert.equal(p.contributions, 1);
});

test('annonce officielle par quartiers (admin seulement)', () => {
  const { call } = setup();
  assert.throws(() => call('POST', '/api/admin/planned', {}), /administrateur/);
  const r = call('POST', '/api/admin/planned', { quartiers: ['dla-deido'], start: NOW + HOUR, end: NOW + 3 * HOUR }, 'Bearer secret');
  assert.equal(r.status, 201);
  const place = call('GET', '/api/place?lat=4.063&lon=9.708').data;
  assert.equal(place.planned.length, 1);
});
