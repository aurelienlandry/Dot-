// Orchestration : relie le stockage au moteur (estimation, prévision, apprentissage, réputation, calibration).

import { ZONES, ZONES_BY_ID } from '../data/zones.ts';
import { defaultBaseline, learnBaselines } from '../engine/baseline.ts';
import { brier, reliabilityBuckets, truthFrom } from '../engine/calibration.ts';
import { episodeStep } from '../engine/episodes.ts';
import { forecast, windows } from '../engine/forecast.ts';
import { DAY, HOUR, hourStart, MINUTE } from '../engine/math.ts';
import { combine, INCIDENT_LOOKBACK_MS, localEvidence, peersOf, type LocalEvidence } from '../engine/nowcast.ts';
import { DEFAULT_PLANNED_REPUTATION, judgeClaim, reliability, updateReputation } from '../engine/reputation.ts';
import type { Nowcast, Zone, ZoneBaseline } from '../engine/types.ts';
import type { Store } from './db.ts';

export const PREDICTION_HORIZONS_H = [1, 3, 6];

export class Service {
  private baselines = new Map<string, ZoneBaseline>();
  private baselinesAt = 0;

  readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  baseline(zoneId: string): ZoneBaseline {
    return this.baselines.get(zoneId) ?? defaultBaseline();
  }

  refreshBaselines(now: number, force = false): void {
    if (!force && now - this.baselinesAt < HOUR) return;
    const start = this.store.dataStart();
    const from = Math.max(now - 365 * DAY, start ?? now);
    const episodes = this.store.episodes(from, now);
    for (const city of new Set(ZONES.map((z) => z.city))) {
      const ids = ZONES.filter((z) => z.city === city).map((z) => z.id);
      for (const [id, b] of learnBaselines(episodes, ids, from, now)) this.baselines.set(id, b);
    }
    this.baselinesAt = now;
  }

  /** Estimation pour toute une ville (les quartiers s'informent mutuellement). */
  nowcastCity(city: string, at: number, excludeSource?: string): Map<string, Nowcast> {
    const zones = ZONES.filter((z) => z.city === city);
    const ids = zones.map((z) => z.id);
    const observations = this.store.observationsFor(ids, at - INCIDENT_LOOKBACK_MS, at);
    const planned = this.store.plannedOverlapping(at, at);
    const weather = this.store.weatherFor(city, hourStart(at), hourStart(at)).get(hourStart(at));
    const reputations = this.store.allReputations();
    const locals = new Map<string, { zone: Zone; local: LocalEvidence }>();
    for (const zone of zones) {
      const local = localEvidence({
        zone,
        at,
        observations: observations.filter((o) => o.zoneId === zone.id),
        planned,
        weather,
        reputations,
        baseline: this.baseline(zone.id),
        excludeSource,
      });
      locals.set(zone.id, { zone, local });
    }
    const out = new Map<string, Nowcast>();
    for (const { zone, local } of locals.values()) out.set(zone.id, combine(zone, at, local, peersOf(zone, locals)));
    return out;
  }

  nowcastZone(zoneId: string, at: number, excludeSource?: string): Nowcast {
    const zone = ZONES_BY_ID.get(zoneId);
    if (!zone) throw new Error(`Quartier inconnu : ${zoneId}`);
    return this.nowcastCity(zone.city, at, excludeSource).get(zoneId)!;
  }

  zoneDetail(zoneId: string, at: number, horizonH = 24) {
    const zone = ZONES_BY_ID.get(zoneId)!;
    const nowcast = this.nowcastZone(zoneId, at);
    const planned = this.store.plannedOverlapping(at, at + horizonH * HOUR).filter((p) => p.zoneIds.includes(zoneId));
    const reputations = this.store.allReputations();
    const points = forecast({
      zoneId,
      at,
      pNow: nowcast.pOut,
      baseline: this.baseline(zoneId),
      planned,
      reputations,
      weatherByHour: this.store.weatherFor(zone.city, hourStart(at), at + horizonH * HOUR),
      incidentSeverity: nowcast.incidentSeverity,
      horizonH,
    });
    const episode = this.store.openEpisode(zoneId);
    return {
      zone,
      nowcast,
      forecast: points,
      safeWindows: windows(points, (p) => p.pOut <= 0.2),
      riskWindows: windows(points, (p) => p.pOut >= 0.5, 30 * MINUTE),
      planned: planned.map((p) => ({ ...p, reliability: reliability(reputations.get(p.sourceId) ?? DEFAULT_PLANNED_REPUTATION) })),
      currentOutageSince: episode?.start ?? null,
      meanOutageHours: this.baseline(zoneId).meanOutageHours,
    };
  }

  /** Tâche périodique : met à jour l'état de chaque quartier et l'historique des coupures. */
  tick(now: number): void {
    this.refreshBaselines(now);
    for (const city of new Set(ZONES.map((z) => z.city))) {
      for (const [zoneId, n] of this.nowcastCity(city, now)) {
        const open = this.store.openEpisode(zoneId);
        const action = episodeStep(!!open, open?.start ?? null, n);
        if (action?.action === 'open') this.store.startEpisode(zoneId, action.start);
        else if (action?.action === 'close' && open) this.store.endEpisode(open.id, action.end);
      }
    }
  }

  /** Enregistre nos prévisions pour pouvoir les noter plus tard. */
  recordPredictions(now: number): void {
    for (const zone of ZONES) {
      const detail = this.zoneDetail(zone.id, now, Math.max(...PREDICTION_HORIZONS_H));
      for (const h of PREDICTION_HORIZONS_H) {
        const target = now + h * HOUR;
        const pt = detail.forecast.reduce((best, p) => (Math.abs(p.at - target) < Math.abs(best.at - target) ? p : best));
        this.store.addPrediction(zone.id, now, target, pt.pOut);
      }
    }
  }

  /** Compare les prévisions échues à ce qui s'est réellement passé. */
  resolvePredictions(now: number): number {
    const pending = this.store.pendingPredictions(now - 20 * MINUTE);
    const cache = new Map<string, Nowcast>();
    let resolved = 0;
    for (const p of pending) {
      const zone = ZONES_BY_ID.get(p.zoneId);
      if (!zone) {
        this.store.resolvePrediction(p.id, null);
        continue;
      }
      // Vérité a posteriori : l'état observé un quart d'heure après l'instant visé.
      let n = cache.get(`${p.zoneId}|${p.targetAt}`);
      if (!n) {
        const city = this.nowcastCity(zone.city, p.targetAt + 15 * MINUTE);
        for (const [id, nc] of city) cache.set(`${id}|${p.targetAt}`, nc);
        n = cache.get(`${p.zoneId}|${p.targetAt}`)!;
      }
      const truth = truthFrom(n);
      this.store.resolvePrediction(p.id, truth);
      if (truth !== null) resolved++;
    }
    return resolved;
  }

  /** Note chaque témoin contre l'avis des autres sources (sans lui) et ajuste sa réputation. */
  scoreSources(now: number): number {
    const candidates = this.store.unscoredObservations(now - 30 * MINUTE, now - 6 * HOUR);
    let judged = 0;
    for (const o of candidates) {
      const truth = this.nowcastZone(o.zoneId, o.at + 20 * MINUTE, o.sourceId);
      const claimOut = o.kind === 'report' ? o.state === 'out' : o.kind === 'device' ? o.event === 'power_lost' : true;
      const verdict = judgeClaim(claimOut, truth);
      if (verdict !== null) {
        const reps = this.store.allReputations();
        this.store.setReputation(o.sourceId, updateReputation(reps.get(o.sourceId), verdict));
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
      const duration = p.end - p.start;
      const eps = this.store.episodes(p.start, p.end);
      const observed = this.store.observationsFor(p.zoneIds, p.start - HOUR, p.end + HOUR);
      if (!observed.length) {
        this.store.markPlannedScored(p.id); // personne pour témoigner : on ne juge pas
        continue;
      }
      let hits = 0;
      for (const z of p.zoneIds) {
        const covered = eps
          .filter((e) => e.zoneId === z)
          .reduce((s, e) => s + Math.max(0, Math.min(p.end, e.end ?? p.end) - Math.max(p.start, e.start)), 0);
        if (covered >= 0.3 * duration) hits++;
      }
      const reps = this.store.allReputations();
      const correct = hits >= p.zoneIds.length / 2;
      this.store.setReputation(p.sourceId, updateReputation(reps.get(p.sourceId) ?? DEFAULT_PLANNED_REPUTATION, correct));
      this.store.markPlannedScored(p.id);
    }
  }

  /** Bilan : heures de coupure par quartier sur une période. */
  bilan(city: string, from: number, to: number) {
    const start = Math.max(from, this.store.dataStart() ?? to);
    const periodHours = Math.max(0, (to - start) / HOUR);
    const eps = this.store.episodes(start, to);
    const zones = ZONES.filter((z) => z.city === city).map((zone) => {
      const mine = eps.filter((e) => e.zoneId === zone.id);
      const hours = mine.reduce((s, e) => s + Math.max(0, Math.min(to, e.end ?? to) - Math.max(start, e.start)) / HOUR, 0);
      const longest = mine.reduce((m, e) => Math.max(m, ((e.end ?? to) - e.start) / HOUR), 0);
      return {
        zoneId: zone.id,
        name: zone.name,
        outages: mine.length,
        hoursOut: hours,
        longestHours: longest,
        availability: periodHours ? 1 - hours / periodHours : null,
      };
    });
    zones.sort((a, b) => b.hoursOut - a.hoursOut);
    const totalHours = zones.reduce((s, z) => s + z.hoursOut, 0);
    return { city, from: start, to, periodHours, zones, averageHoursOut: zones.length ? totalHours / zones.length : 0 };
  }

  reliabilityReport(now: number) {
    const rows = this.store.resolvedPredictions(now - 90 * DAY);
    const byHorizon = PREDICTION_HORIZONS_H.map((h) => {
      const r = rows.filter((x) => Math.abs(x.horizonH - h) < 0.01);
      return { horizonH: h, n: r.length, brier: brier(r) };
    });
    const reps = [...this.store.allReputations().entries()];
    const judgedSources = reps.filter(([, r]) => r.alpha + r.beta > 6);
    return {
      brier: brier(rows),
      n: rows.length,
      byHorizon,
      buckets: reliabilityBuckets(rows),
      sources: {
        total: this.store.stats().sources,
        judged: judgedSources.length,
        trusted: judgedSources.filter(([, r]) => reliability(r) >= 0.8).length,
        distrusted: judgedSources.filter(([, r]) => reliability(r) <= 0.55).length,
      },
      officialSources: reps
        .filter(([id]) => id.startsWith('official:'))
        .map(([id, r]) => ({ id, reliability: reliability(r), judgements: Math.round(r.alpha + r.beta - DEFAULT_PLANNED_REPUTATION.alpha - DEFAULT_PLANNED_REPUTATION.beta) })),
      stats: this.store.stats(),
    };
  }
}
