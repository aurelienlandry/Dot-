// Orchestration : relie le stockage au moteur. Tout se calcule à partir d'une position :
// l'état d'un lieu = les signaux dans un rayon de 600 m + l'influence des alentours (jusqu'à 2,5 km).

import { CITIES, CITY_COORDS, cityOf, placeName, QUARTIERS } from '../data/zones.ts';
import { CITY_KEY, defaultBaseline, learnBaselines, type Episode } from '../engine/baseline.ts';
import { brier, reliabilityBuckets, truthFrom } from '../engine/calibration.ts';
import { episodeStep } from '../engine/episodes.ts';
import { forecast, likelyRestore, windows } from '../engine/forecast.ts';
import { cellFromId, cellOf, groupAreas, LOCAL_RADIUS_KM, RING_RADIUS_KM } from '../engine/geo.ts';
import { DAY, haversineKm, HOUR, hourStart, MINUTE } from '../engine/math.ts';
import { combine, INCIDENT_LOOKBACK_MS, localEvidence, summarize, type Peer } from '../engine/nowcast.ts';
import { DEFAULT_PLANNED_REPUTATION, judgeClaim, reliability, updateReputation } from '../engine/reputation.ts';
import type { Nowcast, Observation, Zone, ZoneBaseline } from '../engine/types.ts';
import type { Store } from './db.ts';

export const PREDICTION_HORIZONS_H = [1, 3, 6];
const MAX_TRACKED_CELLS = 400;

export class Service {
  readonly store: Store;
  private baselines = new Map<string, ZoneBaseline>();
  private baselinesAt = 0;

  constructor(store: Store) {
    this.store = store;
  }

  baseline(cellId: string, city: string): ZoneBaseline {
    return this.baselines.get(cellId) ?? this.baselines.get(`${city}|${CITY_KEY}`) ?? defaultBaseline();
  }

  refreshBaselines(now: number, force = false): void {
    if (!force && now - this.baselinesAt < HOUR) return;
    const from = Math.max(now - 365 * DAY, this.store.dataStart() ?? now);
    const byCity = new Map<string, Episode[]>();
    for (const e of this.store.episodes(from, now)) {
      const c = cellFromId(e.zoneId);
      if (!c) continue;
      const city = cityOf(c.lat, c.lon);
      if (!byCity.has(city)) byCity.set(city, []);
      byCity.get(city)!.push(e);
    }
    this.baselines.clear();
    for (const [city, eps] of byCity) {
      const cells = [...new Set(eps.map((e) => e.zoneId))];
      for (const [id, b] of learnBaselines(eps, cells, from, now)) this.baselines.set(id === CITY_KEY ? `${city}|${CITY_KEY}` : id, b);
    }
    this.baselinesAt = now;
  }

  /** État du courant à une position et à un instant. */
  nowcastAt(lat: number, lon: number, at: number, excludeSource?: string): Nowcast {
    const city = cityOf(lat, lon);
    const cell = cellOf(lat, lon);
    const zone: Zone = { id: cell.id, name: placeName(lat, lon), city, lat, lon };
    const observations = this.store.observationsNear(lat, lon, RING_RADIUS_KM, at - INCIDENT_LOOKBACK_MS, at);
    const planned = this.store.plannedOverlapping(at, at);
    const weather = this.store.weatherFor(city, hourStart(at), hourStart(at)).get(hourStart(at));
    const reputations = this.store.allReputations();
    const local: Observation[] = [];
    const rings = new Map<string, Observation[]>();
    for (const o of observations) {
      const d = haversineKm(lat, lon, o.lat, o.lon);
      if (d > RING_RADIUS_KM) continue;
      if (d <= LOCAL_RADIUS_KM) local.push(o);
      else {
        if (!rings.has(o.zoneId)) rings.set(o.zoneId, []);
        rings.get(o.zoneId)!.push(o);
      }
    }
    const baseline = this.baseline(cell.id, city);
    const mine = localEvidence({ zone, at, observations: local, planned, weather, reputations, baseline, excludeSource });
    const peers: Peer[] = [];
    for (const [cellId, obs] of rings) {
      const c = cellFromId(cellId);
      if (!c) continue;
      const pz: Zone = { id: cellId, name: '', city, lat: c.lat, lon: c.lon };
      const pl = localEvidence({ zone: pz, at, observations: obs, planned: [], reputations, baseline, excludeSource });
      peers.push({ zone: pz, local: pl, distanceKm: haversineKm(lat, lon, c.lat, c.lon) });
    }
    return combine(zone, at, mine, peers);
  }

  /** Tout ce qu'il faut savoir pour un lieu : maintenant, retour probable, prochaines 24 h, annonces. */
  placeDetail(lat: number, lon: number, at: number, horizonH = 24) {
    const city = cityOf(lat, lon);
    const cell = cellOf(lat, lon);
    const nowcast = this.nowcastAt(lat, lon, at);
    const reputations = this.store.allReputations();
    const planned = this.store
      .plannedOverlapping(at, at + horizonH * HOUR)
      .filter((p) => haversineKm(lat, lon, p.lat, p.lon) <= p.radiusKm)
      .map((p) => ({ ...p, reliability: reliability(reputations.get(p.sourceId) ?? DEFAULT_PLANNED_REPUTATION) }));
    const baseline = this.baseline(cell.id, city);
    const points = forecast({
      lat,
      lon,
      at,
      pNow: nowcast.pOut,
      baseline,
      planned,
      reputations,
      weatherByHour: this.store.weatherFor(city, hourStart(at), at + horizonH * HOUR),
      incidentSeverity: nowcast.incidentSeverity,
      horizonH,
    });
    const episode = this.store.openEpisode(cell.id);
    const since = nowcast.pOut >= 0.5 ? (episode?.start ?? nowcast.onsetHint ?? null) : null;
    const month = this.placeHistory(cell.id, at - 30 * DAY, at);
    return {
      name: placeName(lat, lon),
      city,
      pOut: nowcast.pOut,
      confidence: nowcast.confidence,
      summary: summarize(nowcast),
      since,
      likelyRestore: likelyRestore(points),
      meanOutageHours: baseline.meanOutageHours,
      forecast: points.filter((_, i) => i % 3 === 0).map((p) => ({ at: p.at, pOut: Math.round(p.pOut * 1000) / 1000, planned: p.planned })),
      riskWindows: windows(points, (p) => p.pOut >= 0.5, 30 * MINUTE),
      safeWindows: windows(points, (p) => p.pOut <= 0.2, 2 * HOUR),
      planned: planned.map(({ label, start, end, note, reliability: r }) => ({ label, start, end, note, reliability: r })),
      month,
      /** Détail technique (non affiché dans l'appli, utile pour vérifier le moteur). */
      debug: nowcast.evidence.slice(0, 8).map((e) => ({ label: e.label, logLR: Math.round(e.logLR * 100) / 100 })),
    };
  }

  /** Bilan d'une case : heures sans courant et nombre de coupures sur une période. */
  placeHistory(cellId: string, from: number, to: number) {
    const start = Math.max(from, this.store.dataStart() ?? to);
    const eps = this.store.episodes(start, to, [cellId]);
    const hours = eps.reduce((s, e) => s + Math.max(0, Math.min(to, e.end ?? to) - Math.max(start, e.start)) / HOUR, 0);
    const periodHours = Math.max(0, (to - start) / HOUR);
    return {
      hoursOut: hours,
      outages: eps.length,
      longestHours: eps.reduce((m, e) => Math.max(m, ((e.end ?? to) - e.start) / HOUR), 0),
      availability: periodHours >= 24 ? 1 - hours / periodHours : null,
      periodDays: periodHours / 24,
    };
  }

  private trackedCells(at: number): string[] {
    return this.store.activeZoneIds(at - INCIDENT_LOOKBACK_MS, at).slice(0, MAX_TRACKED_CELLS);
  }

  /** Carte : zones de coupure (point + rayon), zones à risque, coupures annoncées. */
  mapView(city: string, at: number) {
    const cells = this.trackedCells(at)
      .map((id) => cellFromId(id))
      .filter((c): c is NonNullable<typeof c> => !!c && cityOf(c.lat, c.lon) === city)
      .map((c) => ({ lat: c.lat, lon: c.lon, pOut: this.nowcastAt(c.lat, c.lon, at).pOut }));
    const name = (a: { lat: number; lon: number }) => placeName(a.lat, a.lon);
    const round = (a: { lat: number; lon: number; radiusKm: number; pOut: number }) => ({
      lat: a.lat, lon: a.lon, radiusM: Math.round(a.radiusKm * 1000 / 50) * 50, pOut: a.pOut, name: name(a),
    });
    return {
      at,
      city,
      center: CITY_COORDS[city] ?? null,
      outages: groupAreas(cells, 0.6).map(round),
      risks: groupAreas(cells, 0.3, 0.6).map(round),
      planned: this.store
        .plannedOverlapping(at, at + DAY)
        .filter((p) => cityOf(p.lat, p.lon) === city)
        .map((p) => ({ lat: p.lat, lon: p.lon, radiusM: Math.round(p.radiusKm * 1000), label: p.label, start: p.start, end: p.end, active: p.start <= at })),
      quartiers: QUARTIERS.filter((q) => q.city === city).map(({ name: n, lat, lon }) => ({ name: n, lat, lon })),
    };
  }

  /** Tâche périodique : met à jour l'historique des coupures de chaque case active. */
  tick(now: number): void {
    this.refreshBaselines(now);
    for (const id of this.trackedCells(now)) {
      const c = cellFromId(id);
      if (!c) continue;
      const n = this.nowcastAt(c.lat, c.lon, now);
      const open = this.store.openEpisode(id);
      const action = episodeStep(!!open, open?.start ?? null, n);
      if (action?.action === 'open') this.store.startEpisode(id, action.start);
      else if (action?.action === 'close' && open) this.store.endEpisode(open.id, action.end);
    }
  }

  /** Enregistre nos prévisions pour pouvoir les noter plus tard. */
  recordPredictions(now: number): void {
    for (const id of this.trackedCells(now)) {
      const c = cellFromId(id);
      if (!c) continue;
      const d = this.placeDetail(c.lat, c.lon, now, Math.max(...PREDICTION_HORIZONS_H));
      for (const h of PREDICTION_HORIZONS_H) {
        const target = now + h * HOUR;
        const pt = d.forecast.reduce((best, p) => (Math.abs(p.at - target) < Math.abs(best.at - target) ? p : best));
        this.store.addPrediction(id, now, target, pt.pOut);
      }
    }
  }

  /** Compare les prévisions échues à ce qui s'est réellement passé. */
  resolvePredictions(now: number): number {
    let resolved = 0;
    for (const p of this.store.pendingPredictions(now - 20 * MINUTE)) {
      const c = cellFromId(p.zoneId);
      const truth = c ? truthFrom(this.nowcastAt(c.lat, c.lon, p.targetAt + 15 * MINUTE)) : null;
      this.store.resolvePrediction(p.id, truth);
      if (truth !== null) resolved++;
    }
    return resolved;
  }

  /** Note chaque témoin contre l'avis des autres sources (sans lui) et ajuste sa réputation. */
  scoreSources(now: number): number {
    let judged = 0;
    for (const o of this.store.unscoredObservations(now - 30 * MINUTE, now - 6 * HOUR)) {
      const truth = this.nowcastAt(o.lat, o.lon, o.at + 20 * MINUTE, o.sourceId);
      const claimOut = o.kind === 'report' ? o.state === 'out' : o.kind === 'device' ? o.event === 'power_lost' || o.event === 'wifi_lost' : true;
      const verdict = judgeClaim(claimOut, truth);
      if (verdict !== null) {
        this.store.setReputation(o.sourceId, updateReputation(this.store.allReputations().get(o.sourceId), verdict));
        this.store.markScored(o.id, 1);
        judged++;
      } else if (o.at < now - 2 * HOUR) {
        this.store.markScored(o.id, 2);
      }
    }
    this.store.expireUnscored(now - 6 * HOUR);
    return judged;
  }

  /** Une annonce officielle a-t-elle été suivie d'une vraie coupure ? La source gagne ou perd en crédibilité. */
  scorePlanned(now: number): void {
    for (const p of this.store.plannedToScore(now - HOUR)) {
      const observed = this.store.observationsNear(p.lat, p.lon, p.radiusKm, p.start - HOUR, p.end + HOUR);
      const cells = [...new Set(observed.map((o) => o.zoneId))];
      if (!cells.length) {
        this.store.markPlannedScored(p.id); // personne pour témoigner : on ne juge pas
        continue;
      }
      const eps = this.store.episodes(p.start, p.end, cells);
      const duration = p.end - p.start;
      const hits = cells.filter((cid) => eps.filter((e) => e.zoneId === cid).reduce((s, e) => s + Math.max(0, Math.min(p.end, e.end ?? p.end) - Math.max(p.start, e.start)), 0) >= 0.3 * duration).length;
      const correct = hits >= cells.length / 2;
      this.store.setReputation(p.sourceId, updateReputation(this.store.allReputations().get(p.sourceId) ?? DEFAULT_PLANNED_REPUTATION, correct));
      this.store.markPlannedScored(p.id);
    }
  }

  /** Bilan par quartier (centre de chaque quartier) sur une période. */
  bilan(city: string, from: number, to: number) {
    const zones = QUARTIERS.filter((q) => q.city === city)
      .map((q) => ({ name: q.name, ...this.placeHistory(cellOf(q.lat, q.lon).id, from, to) }))
      .sort((a, b) => b.hoursOut - a.hoursOut);
    const start = Math.max(from, this.store.dataStart() ?? to);
    return { city, from: start, to, periodHours: Math.max(0, (to - start) / HOUR), zones, averageHoursOut: zones.length ? zones.reduce((s, z) => s + z.hoursOut, 0) / zones.length : 0 };
  }

  /** Profil : pseudo et fiabilité de ses signalements. */
  profile(sourceId: string) {
    const p = this.store.getProfile(sourceId);
    const contrib = this.store.observationsBySource(sourceId);
    const rep = this.store.allReputations().get(sourceId);
    const judged = rep ? Math.round(rep.alpha + rep.beta - 4.5) : 0;
    return { pseudo: p?.pseudo ?? null, contributions: contrib.total, judged, reliability: judged >= 3 ? reliability(rep) : null };
  }

  reliabilityReport(now: number) {
    const rows = this.store.resolvedPredictions(now - 90 * DAY);
    const reps = [...this.store.allReputations().entries()];
    const judgedSources = reps.filter(([, r]) => r.alpha + r.beta > 6);
    return {
      brier: brier(rows),
      n: rows.length,
      byHorizon: PREDICTION_HORIZONS_H.map((h) => {
        const r = rows.filter((x) => Math.abs(x.horizonH - h) < 0.01);
        return { horizonH: h, n: r.length, brier: brier(r) };
      }),
      buckets: reliabilityBuckets(rows),
      sources: {
        total: this.store.stats().sources,
        judged: judgedSources.length,
        trusted: judgedSources.filter(([, r]) => reliability(r) >= 0.8).length,
        distrusted: judgedSources.filter(([, r]) => reliability(r) <= 0.55).length,
      },
      officialSources: reps.filter(([id]) => id.startsWith('official:')).map(([id, r]) => ({ id, reliability: reliability(r) })),
    };
  }
}

export { CITIES };
