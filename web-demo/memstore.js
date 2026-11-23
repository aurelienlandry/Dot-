// Stockage en mémoire, même interface que src/server/db.ts (Store) : permet de faire tourner
// le vrai moteur et le vrai service directement dans le navigateur pour la démonstration.

const clone = (x) => ({ ...x });

export class MemoryStore {
  constructor() {
    this.observations = [];
    this.planned = [];
    this.weather = new Map();
    this.reputation = new Map();
    this.eps = [];
    this.predictions = [];
    this.profiles = new Map();
    this.seq = 1;
  }

  addObservation(o, demo = false) {
    const id = this.seq++;
    this.observations.push({ ...o, id, scored: 0, demo });
    return id;
  }
  observationsNear(lat, lon, radiusKm, from, to) {
    const dLat = radiusKm / 111;
    const dLon = radiusKm / (111 * Math.cos((lat * Math.PI) / 180));
    return this.observations
      .filter((o) => o.at >= from && o.at <= to && Math.abs(o.lat - lat) <= dLat && Math.abs(o.lon - lon) <= dLon)
      .sort((a, b) => a.at - b.at)
      .map(({ id, scored, demo, ...o }) => o);
  }
  activeZoneIds(from, to) {
    const ids = new Set(this.observations.filter((o) => o.at >= from && o.at <= to).map((o) => o.zoneId));
    for (const e of this.eps) if (e.end === null) ids.add(e.zoneId);
    return [...ids];
  }
  observationsBySource(sourceId) {
    const mine = this.observations.filter((o) => o.sourceId === sourceId);
    return { total: mine.length, judged: mine.filter((o) => o.scored === 1).length };
  }
  getProfile(sourceId) {
    return this.profiles.get(sourceId) ?? null;
  }
  setProfile(sourceId, pseudo, now) {
    this.profiles.set(sourceId, { pseudo, createdAt: this.profiles.get(sourceId)?.createdAt ?? now });
  }
  unscoredObservations(olderThan, newerThan) {
    return this.observations.filter((o) => o.scored === 0 && o.kind !== 'incident' && o.at <= olderThan && o.at >= newerThan).slice(0, 500).map(clone);
  }
  markScored(id, status) {
    const o = this.observations.find((x) => x.id === id);
    if (o) o.scored = status;
  }
  expireUnscored(before) {
    for (const o of this.observations) if (o.scored === 0 && o.at < before) o.scored = 2;
  }

  addPlanned(p, demo = false) {
    const id = this.seq++;
    this.planned.push({ ...p, id, scored: 0, demo });
    return id;
  }
  plannedOverlapping(from, to) {
    return this.planned.filter((p) => p.end >= from && p.start <= to).sort((a, b) => a.start - b.start).map(({ scored, demo, ...p }) => p);
  }
  plannedToScore(before) {
    return this.planned.filter((p) => !p.scored && p.end <= before).map(clone);
  }
  markPlannedScored(id) {
    const p = this.planned.find((x) => x.id === id);
    if (p) p.scored = 1;
  }
  deletePlanned(id) {
    this.planned = this.planned.filter((p) => p.id !== id);
  }

  upsertWeather(w) {
    this.weather.set(`${w.city}|${w.at}`, w);
  }
  weatherFor(city, from, to) {
    const m = new Map();
    for (const w of this.weather.values()) if (w.city === city && w.at >= from && w.at <= to) m.set(w.at, w);
    return m;
  }

  allReputations() {
    return new Map(this.reputation);
  }
  setReputation(id, rep) {
    this.reputation.set(id, rep);
  }

  openEpisode(zoneId) {
    const open = this.eps.filter((e) => e.zoneId === zoneId && e.end === null).sort((a, b) => b.start - a.start)[0];
    return open ? { id: open.id, start: open.start } : null;
  }
  startEpisode(zoneId, start, demo = false) {
    const id = this.seq++;
    this.eps.push({ id, zoneId, start, end: null, demo });
    return id;
  }
  endEpisode(id, end) {
    const e = this.eps.find((x) => x.id === id);
    if (e) e.end = end;
  }
  addEpisode(e, demo = false) {
    this.eps.push({ ...e, id: this.seq++, demo });
  }
  episodes(from, to, zoneIds) {
    const set = zoneIds ? new Set(zoneIds) : null;
    return this.eps.filter((e) => e.start <= to && (e.end === null || e.end >= from) && (!set || set.has(e.zoneId))).sort((a, b) => a.start - b.start).map(({ zoneId, start, end }) => ({ zoneId, start, end }));
  }
  dataStart() {
    let m = Infinity;
    for (const e of this.eps) m = Math.min(m, e.start);
    for (const o of this.observations) m = Math.min(m, o.at);
    return m === Infinity ? null : m;
  }
  hasDemoData() {
    return this.eps.some((e) => e.demo);
  }

  addPrediction(zoneId, madeAt, targetAt, p) {
    this.predictions.push({ id: this.seq++, zoneId, madeAt, targetAt, horizonH: (targetAt - madeAt) / 3_600_000, p, outcome: null, resolved: 0 });
  }
  pendingPredictions(before) {
    return this.predictions.filter((x) => !x.resolved && x.targetAt <= before).map(clone);
  }
  resolvePrediction(id, outcome) {
    const x = this.predictions.find((y) => y.id === id);
    if (x) {
      x.resolved = outcome === null ? 2 : 1;
      x.outcome = outcome;
    }
  }
  resolvedPredictions(since) {
    return this.predictions.filter((x) => x.resolved === 1 && x.targetAt >= since).map((x) => ({ p: x.p, outcome: x.outcome, horizonH: x.horizonH }));
  }
  stats() {
    return {
      observations: this.observations.length,
      sources: new Set(this.observations.map((o) => o.sourceId)).size,
      episodes: this.eps.length,
      predictionsResolved: this.predictions.filter((x) => x.resolved === 1).length,
    };
  }
}
