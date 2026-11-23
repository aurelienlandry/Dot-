// Apprentissage de l'historique : à quelle heure, quel jour, dans quel quartier les coupures arrivent,
// et combien de temps elles durent. Lissage hiérarchique : un quartier avec peu de données
// emprunte le comportement de sa ville, une heure peu observée emprunte celui des heures similaires.

import { HOUR, hourOfWeek } from './math.ts';
import type { ZoneBaseline } from './types.ts';

export interface Episode {
  zoneId: string;
  start: number;
  end: number | null;
}

/** Valeurs par défaut sans aucune donnée : ~1 coupure tous les 2 jours, 2 h 30 en moyenne. */
export const DEFAULT_RATE_PER_HOUR = 0.02;
export const DEFAULT_MEAN_HOURS = 2.5;
/** Clé du profil moyen de la ville dans le résultat de learnBaselines. */
export const CITY_KEY = '*';

export function defaultBaseline(): ZoneBaseline {
  return { startsPerHour: new Array(168).fill(DEFAULT_RATE_PER_HOUR), meanOutageHours: DEFAULT_MEAN_HOURS };
}

export function learnBaselines(episodes: Episode[], zoneIds: string[], from: number, to: number): Map<string, ZoneBaseline> {
  const result = new Map<string, ZoneBaseline>();
  const totalHours = Math.max(0, (to - from) / HOUR);
  if (totalHours < 24 || zoneIds.length === 0) {
    for (const z of zoneIds) result.set(z, defaultBaseline());
    result.set(CITY_KEY, defaultBaseline());
    return result;
  }

  // Exposition : nombre d'occurrences de chaque heure de la semaine dans la période.
  const exposure = new Array(168).fill(0);
  for (let t = Math.ceil(from / HOUR) * HOUR; t < to; t += HOUR) exposure[hourOfWeek(t)]++;

  const zoneSet = new Set(zoneIds);
  const eps = episodes.filter((e) => zoneSet.has(e.zoneId) && e.start >= from && e.start < to);
  const cityCounts = new Array(168).fill(0);
  const zoneCounts = new Map<string, number>(zoneIds.map((z) => [z, 0]));
  const durSum = new Map<string, number>(zoneIds.map((z) => [z, 0]));
  const durN = new Map<string, number>(zoneIds.map((z) => [z, 0]));
  for (const e of eps) {
    cityCounts[hourOfWeek(e.start)]++;
    zoneCounts.set(e.zoneId, (zoneCounts.get(e.zoneId) ?? 0) + 1);
    if (e.end !== null && e.end > e.start) {
      durSum.set(e.zoneId, (durSum.get(e.zoneId) ?? 0) + (e.end - e.start) / HOUR);
      durN.set(e.zoneId, (durN.get(e.zoneId) ?? 0) + 1);
    }
  }
  const nz = zoneIds.length;

  // Niveau 1 : taux global de la ville, lissé vers la valeur par défaut.
  const totalStarts = cityCounts.reduce((a, b) => a + b, 0);
  const globalRate = (totalStarts + 50 * DEFAULT_RATE_PER_HOUR) / (totalHours * nz + 50);

  // Niveau 2 : profil par heure du jour (tous jours confondus), lissé vers le global.
  const hodRate = new Array(24).fill(0).map((_, h) => {
    let c = 0;
    let e = 0;
    for (let d = 0; d < 7; d++) {
      c += cityCounts[d * 24 + h];
      e += exposure[d * 24 + h] * nz;
    }
    return (c + 30 * globalRate) / (e + 30);
  });

  // Niveau 3 : heure de la semaine, lissée vers l'heure du jour.
  const cityRate = cityCounts.map((c, how) => (c + 40 * hodRate[how % 24]) / (exposure[how] * nz + 40));

  // Durée moyenne de la ville, puis par quartier.
  let allDur = 0;
  let allN = 0;
  for (const z of zoneIds) {
    allDur += durSum.get(z) ?? 0;
    allN += durN.get(z) ?? 0;
  }
  const cityMean = (allDur + 5 * DEFAULT_MEAN_HOURS) / (allN + 5);

  // Profil moyen de la ville : utilisé pour un endroit sans historique propre.
  result.set(CITY_KEY, { startsPerHour: cityRate.slice(), meanOutageHours: cityMean });

  for (const z of zoneIds) {
    // Facteur multiplicatif du quartier : est-il plus ou moins touché que la moyenne de la ville ?
    const expected = cityRate.reduce((s, r, how) => s + r * exposure[how], 0);
    const factor = ((zoneCounts.get(z) ?? 0) + 5) / (expected + 5);
    const meanOutageHours = Math.max(0.25, ((durSum.get(z) ?? 0) + 5 * cityMean) / ((durN.get(z) ?? 0) + 5));
    result.set(z, { startsPerHour: cityRate.map((r) => r * factor), meanOutageHours });
  }
  return result;
}
