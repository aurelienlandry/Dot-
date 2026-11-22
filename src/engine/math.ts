export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Cameroun : Africa/Douala, UTC+1 toute l'année (pas d'heure d'été). */
export const TZ_OFFSET_MS = HOUR;

export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
export const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));
export const logit = (p: number): number => {
  const q = clamp(p, 1e-6, 1 - 1e-6);
  return Math.log(q / (1 - q));
};

/** Heure de la semaine en heure locale : lundi 0h → 0, dimanche 23h → 167. */
export function hourOfWeek(at: number): number {
  const d = new Date(at + TZ_OFFSET_MS);
  return ((d.getUTCDay() + 6) % 7) * 24 + d.getUTCHours();
}

/** Début de l'heure (UTC) contenant `at`. */
export const hourStart = (at: number): number => Math.floor(at / HOUR) * HOUR;

export function formatLocalTime(at: number): string {
  const d = new Date(at + TZ_OFFSET_MS);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

export function formatAge(ms: number): string {
  const min = Math.max(0, Math.round(ms / MINUTE));
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `il y a ${h} h ${m}` : `il y a ${h} h`;
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Rendements décroissants : le i-ème indice dans la même direction compte pour factor^i.
 * Cent faux comptes qui crient « coupé » ne valent pas cent fois un témoin fiable.
 */
export function diminishing(values: number[], factor = 0.85): number[] {
  const order = values.map((v, i) => [Math.abs(v), i] as const).sort((a, b) => b[0] - a[0]);
  const out = values.slice();
  order.forEach(([, idx], rank) => {
    out[idx] = values[idx] * factor ** rank;
  });
  return out;
}
