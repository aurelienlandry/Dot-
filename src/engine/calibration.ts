// Notre propre fiabilité, mesurée publiquement : chaque prévision est enregistrée,
// puis comparée à ce qui s'est réellement passé. Si on annonce « 70 % », il faut que
// ça arrive 7 fois sur 10. C'est la seule façon honnête de gagner la confiance des gens.

import type { Nowcast } from './types.ts';

export interface Resolved {
  p: number;
  outcome: boolean;
}

/** Vérité a posteriori : on ne tranche que si les indices réels sont suffisamment clairs. */
export function truthFrom(n: Pick<Nowcast, 'pOut' | 'evidenceWeight'>): boolean | null {
  if (n.evidenceWeight < 2) return null;
  if (n.pOut >= 0.8) return true;
  if (n.pOut <= 0.2) return false;
  return null;
}

/** Score de Brier : 0 = parfait, 0,25 = autant dire « 50 % » à chaque fois. */
export function brier(rows: Resolved[]): number | null {
  if (!rows.length) return null;
  return rows.reduce((s, r) => s + (r.p - (r.outcome ? 1 : 0)) ** 2, 0) / rows.length;
}

export interface Bucket {
  lo: number;
  hi: number;
  n: number;
  meanP: number;
  observed: number;
}

/** Diagramme de fiabilité : pour chaque tranche de probabilité annoncée, la fréquence réellement observée. */
export function reliabilityBuckets(rows: Resolved[], count = 10): Bucket[] {
  const buckets: Bucket[] = [];
  for (let i = 0; i < count; i++) {
    const lo = i / count;
    const hi = (i + 1) / count;
    const inB = rows.filter((r) => r.p >= lo && (i === count - 1 ? r.p <= hi : r.p < hi));
    buckets.push({
      lo,
      hi,
      n: inB.length,
      meanP: inB.length ? inB.reduce((s, r) => s + r.p, 0) / inB.length : (lo + hi) / 2,
      observed: inB.length ? inB.filter((r) => r.outcome).length / inB.length : 0,
    });
  }
  return buckets;
}
