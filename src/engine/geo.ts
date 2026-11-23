// Géographie : on ne raisonne plus par quartier figé mais par position.
// La ville est découpée en petites cases (~450 m) pour stocker et suivre les coupures,
// et l'état d'un lieu est calculé à partir de tout ce qui se passe dans un rayon autour de lui.

import { haversineKm } from './math.ts';

/** Taille d'une case : 0,004° ≈ 445 m au Cameroun. */
export const CELL_DEG = 0.004;
/** Rayon dans lequel les signaux comptent pleinement pour un lieu. */
export const LOCAL_RADIUS_KM = 0.6;
/** Rayon au-delà duquel les signaux voisins ne comptent plus. */
export const RING_RADIUS_KM = 2.5;

export interface Cell {
  id: string;
  lat: number;
  lon: number;
}

export function cellOf(lat: number, lon: number): Cell {
  const i = Math.floor(lat / CELL_DEG);
  const j = Math.floor(lon / CELL_DEG);
  return { id: `c${i}_${j}`, lat: (i + 0.5) * CELL_DEG, lon: (j + 0.5) * CELL_DEG };
}

export function cellFromId(id: string): Cell | null {
  const m = id.match(/^c(-?\d+)_(-?\d+)$/);
  if (!m) return null;
  const i = Number(m[1]);
  const j = Number(m[2]);
  return { id, lat: (i + 0.5) * CELL_DEG, lon: (j + 0.5) * CELL_DEG };
}

/** Cases dont le centre est à moins de `radiusKm` du point. */
export function cellsWithin(lat: number, lon: number, radiusKm: number): Cell[] {
  const dLat = radiusKm / 111 + CELL_DEG;
  const dLon = radiusKm / (111 * Math.cos((lat * Math.PI) / 180)) + CELL_DEG;
  const out: Cell[] = [];
  for (let i = Math.floor((lat - dLat) / CELL_DEG); i <= Math.floor((lat + dLat) / CELL_DEG); i++) {
    for (let j = Math.floor((lon - dLon) / CELL_DEG); j <= Math.floor((lon + dLon) / CELL_DEG); j++) {
      const c = { id: `c${i}_${j}`, lat: (i + 0.5) * CELL_DEG, lon: (j + 0.5) * CELL_DEG };
      if (haversineKm(lat, lon, c.lat, c.lon) <= radiusKm) out.push(c);
    }
  }
  return out;
}

/** Arrondi à ~100 m : on ne stocke jamais la position exacte des gens. */
export function blur(lat: number, lon: number): { lat: number; lon: number } {
  return { lat: Math.round(lat * 1000) / 1000, lon: Math.round(lon * 1000) / 1000 };
}

export interface AreaInput {
  lat: number;
  lon: number;
  pOut: number;
}

export interface Area {
  lat: number;
  lon: number;
  radiusKm: number;
  pOut: number;
  cells: number;
}

/**
 * Regroupe les cases voisines en zones (point + rayon) pour l'affichage sur la carte :
 * « coupure dans un rayon de 800 m autour de tel point ».
 */
export function groupAreas(cells: AreaInput[], minP: number, maxP = 1.01): Area[] {
  const pick = cells.filter((c) => c.pOut >= minP && c.pOut < maxP);
  const seen = new Set<number>();
  const areas: Area[] = [];
  for (let s = 0; s < pick.length; s++) {
    if (seen.has(s)) continue;
    const group = [s];
    seen.add(s);
    for (let g = 0; g < group.length; g++) {
      const a = pick[group[g]];
      for (let t = 0; t < pick.length; t++) {
        if (!seen.has(t) && haversineKm(a.lat, a.lon, pick[t].lat, pick[t].lon) <= 0.7) {
          seen.add(t);
          group.push(t);
        }
      }
    }
    const members = group.map((i) => pick[i]);
    const lat = members.reduce((s2, m) => s2 + m.lat, 0) / members.length;
    const lon = members.reduce((s2, m) => s2 + m.lon, 0) / members.length;
    const radiusKm = Math.max(...members.map((m) => haversineKm(lat, lon, m.lat, m.lon))) + 0.3;
    const pOut = members.reduce((s2, m) => s2 + m.pOut, 0) / members.length;
    areas.push({ lat, lon, radiusKm, pOut, cells: members.length });
  }
  return areas;
}
