// Prévision : probabilité d'avoir une coupure à chaque instant des prochaines heures.
//
// Modèle à deux états (courant / coupé) :
//  - une coupure démarre au rythme λ(t) appris de l'historique pour cette heure de la semaine,
//    multiplié par la météo prévue ;
//  - une coupure se termine au rythme μ = 1 / durée moyenne (plus lent si un incident grave est en cours) ;
//  - les coupures programmées annoncées se superposent, pondérées par la fiabilité de leur source.

import { hourOfWeek, hourStart, HOUR, MINUTE } from './math.ts';
import { weatherMultiplier } from './nowcast.ts';
import { DEFAULT_PLANNED_REPUTATION, reliability } from './reputation.ts';
import type { ForecastPoint, PlannedOutage, Reputation, WeatherPoint, ZoneBaseline } from './types.ts';

export interface ForecastInput {
  zoneId: string;
  at: number;
  pNow: number;
  baseline: ZoneBaseline;
  planned: PlannedOutage[];
  reputations: Map<string, Reputation>;
  weatherByHour: Map<number, WeatherPoint>;
  incidentSeverity: number;
  horizonH?: number;
  stepMin?: number;
}

const OVERRUN_MS = 45 * MINUTE;

export function forecast(input: ForecastInput): ForecastPoint[] {
  const horizon = (input.horizonH ?? 12) * HOUR;
  const step = (input.stepMin ?? 10) * MINUTE;
  const stepH = step / HOUR;
  const slowRepair = input.incidentSeverity > 1.5 ? 0.4 : 1;
  const mu = (1 / input.baseline.meanOutageHours) * slowRepair;
  const planned = input.planned.filter((p) => p.zoneIds.includes(input.zoneId));

  const points: ForecastPoint[] = [];
  let p = input.pNow;
  for (let t = input.at; t <= input.at + horizon; t += step) {
    if (t > input.at) {
      // Un incident grave (transfo en feu, poteau tombé…) ajoute son propre risque de coupure,
      // indépendant de l'heure : fort dans l'heure qui suit, puis décroissant.
      const incidentHazard = 0.5 * input.incidentSeverity * Math.exp(-(t - input.at) / (3 * HOUR));
      const lambda = input.baseline.startsPerHour[hourOfWeek(t)] * weatherMultiplier(input.weatherByHour.get(hourStart(t))) + incidentHazard;
      p = p * Math.exp(-mu * stepH) + (1 - p) * (1 - Math.exp(-lambda * stepH));
    }
    let pp = 0;
    let inPlanned = false;
    for (const pl of planned) {
      const r = reliability(input.reputations.get(pl.sourceId) ?? DEFAULT_PLANNED_REPUTATION);
      if (t >= pl.start && t <= pl.end) {
        pp = Math.max(pp, r);
        inPlanned = true;
      } else if (t > pl.end && t - pl.end <= 3 * OVERRUN_MS) {
        // Les coupures programmées débordent souvent : la probabilité retombe progressivement.
        pp = Math.max(pp, r * Math.exp(-(t - pl.end) / OVERRUN_MS));
      }
    }
    points.push({ at: t, pOut: 1 - (1 - p) * (1 - pp), planned: inPlanned });
  }
  return points;
}

/** Probabilité de coupure à l'instant `t` (interpolation dans la prévision). */
export function probabilityAt(points: ForecastPoint[], t: number): number | null {
  if (!points.length || t < points[0].at || t > points[points.length - 1].at) return null;
  for (let i = 1; i < points.length; i++) {
    if (t <= points[i].at) {
      const a = points[i - 1];
      const b = points[i];
      const f = (t - a.at) / (b.at - a.at || 1);
      return a.pOut + f * (b.pOut - a.pOut);
    }
  }
  return points[points.length - 1].pOut;
}

export interface TimeWindow {
  start: number;
  end: number;
  meanPOut: number;
}

/** Plages continues où la condition est vraie, d'une durée minimale. */
export function windows(points: ForecastPoint[], test: (p: ForecastPoint) => boolean, minDurationMs = HOUR): TimeWindow[] {
  const out: TimeWindow[] = [];
  let cur: ForecastPoint[] = [];
  const flush = () => {
    if (cur.length >= 2 && cur[cur.length - 1].at - cur[0].at >= minDurationMs) {
      out.push({ start: cur[0].at, end: cur[cur.length - 1].at, meanPOut: cur.reduce((s, x) => s + x.pOut, 0) / cur.length });
    }
    cur = [];
  };
  for (const pt of points) {
    if (test(pt)) cur.push(pt);
    else flush();
  }
  flush();
  return out;
}
