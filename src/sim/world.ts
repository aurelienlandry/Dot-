// Monde simulé : génère des coupures « vraies » réalistes (soirées à risque, saison des pluies,
// quartiers plus ou moins bien desservis), et le comportement imparfait des téléphones et des gens.
// Sert à la démonstration ET à mesurer la fiabilité du moteur (voir backtest.ts).

import { DAY, HOUR, hourOfWeek, MINUTE, TZ_OFFSET_MS } from '../engine/math.ts';
import type { Episode } from '../engine/baseline.ts';

/** Générateur pseudo-aléatoire déterministe (reproductible). */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Exposition relative des quartiers (hypothèses de démonstration, pas des mesures). */
export const ZONE_RISK: Record<string, number> = {
  'dla-bonanjo': 0.35, 'dla-bonapriso': 0.45, 'dla-akwa': 0.6, 'dla-bali': 0.7,
  'dla-deido': 1, 'dla-newbell': 1.2, 'dla-bepanda': 1.3, 'dla-ndogbong': 1.1,
  'dla-bonamoussadi': 1.2, 'dla-makepe': 1.4, 'dla-kotto': 1.5, 'dla-logpom': 1.6,
  'dla-village': 1.3, 'dla-yassa': 1.5, 'dla-bonaberi': 1.4,
  'yde-bastos': 0.4, 'yde-emana': 0.9, 'yde-ngousso': 1, 'yde-essos': 1, 'yde-mimboman': 1.3,
  'yde-mvogmbi': 1, 'yde-odza': 1.4, 'yde-biyemassi': 1.1, 'yde-mendong': 1.3, 'yde-nkolbisson': 1.5,
};

/** Profil horaire : pic en soirée (forte demande), creux en pleine nuit. */
const HOUR_PROFILE = [0.4, 0.3, 0.3, 0.3, 0.4, 0.6, 0.8, 0.9, 1, 1, 1, 1, 1.1, 1.1, 1, 1, 1.1, 1.4, 2, 2.4, 2.2, 1.6, 1, 0.6];

/** Saison des pluies (mars → novembre, pic juillet–septembre). */
function seasonFactor(at: number): number {
  const m = new Date(at + TZ_OFFSET_MS).getUTCMonth();
  return [0.8, 0.8, 1, 1.1, 1.2, 1.3, 1.5, 1.6, 1.5, 1.3, 1.1, 0.9][m];
}

export const BASE_RATE = 0.018; // débuts de coupure par heure pour un quartier « moyen »

export function trueRate(zoneId: string, at: number, rainBoost = 1): number {
  const how = hourOfWeek(at);
  const weekend = how >= 5 * 24 ? 0.85 : 1;
  return BASE_RATE * (ZONE_RISK[zoneId] ?? 1) * HOUR_PROFILE[how % 24] * weekend * seasonFactor(at) * rainBoost;
}

/** Durée log-normale, médiane ~1 h 45, longue traîne (parfois plus de 8 h). */
export function drawDuration(r: () => number): number {
  const u1 = Math.max(r(), 1e-9);
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * r());
  return Math.min(14 * HOUR, Math.max(10 * MINUTE, Math.exp(Math.log(1.75) + 0.8 * z) * HOUR));
}

/** Génère des coupures réalistes dans un quartier entre `from` et `to` (pas de 10 min). */
export function generateEpisodes(zoneId: string, from: number, to: number, r: () => number): Episode[] {
  const out: Episode[] = [];
  const step = 10 * MINUTE;
  let t = from;
  while (t < to) {
    if (r() < trueRate(zoneId, t) * (step / HOUR)) {
      const end = t + drawDuration(r);
      out.push({ zoneId, start: t, end: Math.min(end, to) });
      t = end + 20 * MINUTE;
    } else t += step;
  }
  return out;
}

export const isOutAt = (episodes: Episode[], t: number): boolean => episodes.some((e) => e.start <= t && (e.end ?? Infinity) > t);

export { DAY };
