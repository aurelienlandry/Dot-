import { DatabaseSync } from 'node:sqlite';
import type { Episode } from '../engine/baseline.ts';
import type { IncidentType, Observation, PlannedOutage, Reputation, WeatherPoint } from '../engine/types.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  value TEXT NOT NULL,
  scored INTEGER NOT NULL DEFAULT 0,
  demo INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS obs_zone_at ON observations(zone_id, at);
CREATE INDEX IF NOT EXISTS obs_scored ON observations(scored, at);
CREATE TABLE IF NOT EXISTS planned (
  id INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL,
  zone_ids TEXT NOT NULL,
  start INTEGER NOT NULL,
  end INTEGER NOT NULL,
  note TEXT,
  url TEXT,
  scored INTEGER NOT NULL DEFAULT 0,
  demo INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS weather (
  city TEXT NOT NULL,
  at INTEGER NOT NULL,
  rain_mm REAL NOT NULL,
  gust_kmh REAL NOT NULL,
  thunder INTEGER NOT NULL,
  PRIMARY KEY (city, at)
);
CREATE TABLE IF NOT EXISTS reputation (
  source_id TEXT PRIMARY KEY,
  alpha REAL NOT NULL,
  beta REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY,
  zone_id TEXT NOT NULL,
  start INTEGER NOT NULL,
  end INTEGER,
  demo INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ep_zone ON episodes(zone_id, start);
CREATE TABLE IF NOT EXISTS predictions (
  id INTEGER PRIMARY KEY,
  zone_id TEXT NOT NULL,
  made_at INTEGER NOT NULL,
  target_at INTEGER NOT NULL,
  horizon_h REAL NOT NULL,
  p REAL NOT NULL,
  outcome INTEGER,
  resolved INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS pred_target ON predictions(resolved, target_at);
`;

type Row = Record<string, unknown>;

function toObservation(r: Row): Observation {
  const base = { sourceId: r.source_id as string, zoneId: r.zone_id as string, at: Number(r.at) };
  if (r.kind === 'device') return { kind: 'device', ...base, event: r.value as 'power_lost' | 'power_back' | 'charging' };
  if (r.kind === 'report') return { kind: 'report', ...base, state: r.value as 'out' | 'on' };
  return { kind: 'incident', ...base, incident: r.value as IncidentType };
}

function toPlanned(r: Row): PlannedOutage {
  return {
    id: Number(r.id),
    sourceId: r.source_id as string,
    zoneIds: JSON.parse(r.zone_ids as string),
    start: Number(r.start),
    end: Number(r.end),
    note: (r.note as string) ?? undefined,
    url: (r.url as string) ?? undefined,
  };
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  // --- Observations
  addObservation(o: Observation, demo = false): number {
    const value = o.kind === 'device' ? o.event : o.kind === 'report' ? o.state : o.incident;
    const r = this.db
      .prepare('INSERT INTO observations (kind, source_id, zone_id, at, value, demo) VALUES (?, ?, ?, ?, ?, ?)')
      .run(o.kind, o.sourceId, o.zoneId, o.at, value, demo ? 1 : 0);
    return Number(r.lastInsertRowid);
  }

  observationsFor(zoneIds: string[], from: number, to: number): Observation[] {
    if (!zoneIds.length) return [];
    const q = `SELECT * FROM observations WHERE zone_id IN (${zoneIds.map(() => '?').join(',')}) AND at >= ? AND at <= ? ORDER BY at`;
    return (this.db.prepare(q).all(...zoneIds, from, to) as Row[]).map(toObservation);
  }

  unscoredObservations(olderThan: number, newerThan: number): (Observation & { id: number })[] {
    const rows = this.db
      .prepare("SELECT * FROM observations WHERE scored = 0 AND kind != 'incident' AND at <= ? AND at >= ? ORDER BY at LIMIT 500")
      .all(olderThan, newerThan) as Row[];
    return rows.map((r) => ({ ...toObservation(r), id: Number(r.id) }));
  }

  markScored(id: number, status: number): void {
    this.db.prepare('UPDATE observations SET scored = ? WHERE id = ?').run(status, id);
  }

  expireUnscored(before: number): void {
    this.db.prepare('UPDATE observations SET scored = 2 WHERE scored = 0 AND at < ?').run(before);
  }

  // --- Coupures programmées
  addPlanned(p: Omit<PlannedOutage, 'id'>, demo = false): number {
    const r = this.db
      .prepare('INSERT INTO planned (source_id, zone_ids, start, end, note, url, demo) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(p.sourceId, JSON.stringify(p.zoneIds), p.start, p.end, p.note ?? null, p.url ?? null, demo ? 1 : 0);
    return Number(r.lastInsertRowid);
  }

  plannedOverlapping(from: number, to: number): PlannedOutage[] {
    return (this.db.prepare('SELECT * FROM planned WHERE end >= ? AND start <= ? ORDER BY start').all(from, to) as Row[]).map(toPlanned);
  }

  plannedToScore(before: number): PlannedOutage[] {
    return (this.db.prepare('SELECT * FROM planned WHERE scored = 0 AND end <= ?').all(before) as Row[]).map(toPlanned);
  }

  markPlannedScored(id: number): void {
    this.db.prepare('UPDATE planned SET scored = 1 WHERE id = ?').run(id);
  }

  deletePlanned(id: number): void {
    this.db.prepare('DELETE FROM planned WHERE id = ?').run(id);
  }

  // --- Météo
  upsertWeather(w: WeatherPoint): void {
    this.db
      .prepare('INSERT OR REPLACE INTO weather (city, at, rain_mm, gust_kmh, thunder) VALUES (?, ?, ?, ?, ?)')
      .run(w.city, w.at, w.rainMm, w.gustKmh, w.thunder ? 1 : 0);
  }

  weatherFor(city: string, from: number, to: number): Map<number, WeatherPoint> {
    const rows = this.db.prepare('SELECT * FROM weather WHERE city = ? AND at >= ? AND at <= ?').all(city, from, to) as Row[];
    return new Map(rows.map((r) => [Number(r.at), { city, at: Number(r.at), rainMm: Number(r.rain_mm), gustKmh: Number(r.gust_kmh), thunder: !!r.thunder }]));
  }

  // --- Réputation
  allReputations(): Map<string, Reputation> {
    const rows = this.db.prepare('SELECT * FROM reputation').all() as Row[];
    return new Map(rows.map((r) => [r.source_id as string, { alpha: Number(r.alpha), beta: Number(r.beta) }]));
  }

  setReputation(sourceId: string, rep: Reputation): void {
    this.db.prepare('INSERT OR REPLACE INTO reputation (source_id, alpha, beta) VALUES (?, ?, ?)').run(sourceId, rep.alpha, rep.beta);
  }

  // --- Épisodes de coupure
  openEpisode(zoneId: string): { id: number; start: number } | null {
    const r = this.db.prepare('SELECT id, start FROM episodes WHERE zone_id = ? AND end IS NULL ORDER BY start DESC LIMIT 1').get(zoneId) as Row | undefined;
    return r ? { id: Number(r.id), start: Number(r.start) } : null;
  }

  startEpisode(zoneId: string, start: number, demo = false): number {
    return Number(this.db.prepare('INSERT INTO episodes (zone_id, start, demo) VALUES (?, ?, ?)').run(zoneId, start, demo ? 1 : 0).lastInsertRowid);
  }

  endEpisode(id: number, end: number): void {
    this.db.prepare('UPDATE episodes SET end = ? WHERE id = ?').run(end, id);
  }

  addEpisode(e: Episode, demo = false): void {
    this.db.prepare('INSERT INTO episodes (zone_id, start, end, demo) VALUES (?, ?, ?, ?)').run(e.zoneId, e.start, e.end, demo ? 1 : 0);
  }

  episodes(from: number, to: number): Episode[] {
    const rows = this.db.prepare('SELECT zone_id, start, end FROM episodes WHERE start <= ? AND (end IS NULL OR end >= ?) ORDER BY start').all(to, from) as Row[];
    return rows.map((r) => ({ zoneId: r.zone_id as string, start: Number(r.start), end: r.end === null ? null : Number(r.end) }));
  }

  /** Début des données disponibles (pour ne pas compter comme « sans coupure » des jours non observés). */
  dataStart(): number | null {
    const r = this.db.prepare('SELECT MIN(m) AS m FROM (SELECT MIN(start) AS m FROM episodes UNION ALL SELECT MIN(at) AS m FROM observations)').get() as Row;
    return r.m === null ? null : Number(r.m);
  }

  hasDemoData(): boolean {
    return !!this.db.prepare('SELECT 1 FROM episodes WHERE demo = 1 LIMIT 1').get();
  }

  // --- Prévisions enregistrées (calibration)
  addPrediction(zoneId: string, madeAt: number, targetAt: number, p: number): void {
    this.db
      .prepare('INSERT INTO predictions (zone_id, made_at, target_at, horizon_h, p) VALUES (?, ?, ?, ?, ?)')
      .run(zoneId, madeAt, targetAt, (targetAt - madeAt) / 3_600_000, p);
  }

  pendingPredictions(before: number): { id: number; zoneId: string; targetAt: number; p: number }[] {
    const rows = this.db.prepare('SELECT * FROM predictions WHERE resolved = 0 AND target_at <= ? LIMIT 2000').all(before) as Row[];
    return rows.map((r) => ({ id: Number(r.id), zoneId: r.zone_id as string, targetAt: Number(r.target_at), p: Number(r.p) }));
  }

  resolvePrediction(id: number, outcome: boolean | null): void {
    this.db.prepare('UPDATE predictions SET resolved = ?, outcome = ? WHERE id = ?').run(outcome === null ? 2 : 1, outcome === null ? null : outcome ? 1 : 0, id);
  }

  resolvedPredictions(since: number): { p: number; outcome: boolean; horizonH: number }[] {
    const rows = this.db.prepare('SELECT p, outcome, horizon_h FROM predictions WHERE resolved = 1 AND target_at >= ?').all(since) as Row[];
    return rows.map((r) => ({ p: Number(r.p), outcome: Number(r.outcome) === 1, horizonH: Number(r.horizon_h) }));
  }

  stats(): Record<string, number> {
    const one = (q: string) => Number((this.db.prepare(q).get() as Row).n);
    return {
      observations: one('SELECT COUNT(*) AS n FROM observations'),
      sources: one('SELECT COUNT(DISTINCT source_id) AS n FROM observations'),
      episodes: one('SELECT COUNT(*) AS n FROM episodes'),
      predictionsResolved: one('SELECT COUNT(*) AS n FROM predictions WHERE resolved = 1'),
    };
  }
}
