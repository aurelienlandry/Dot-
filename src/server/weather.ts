// Prévisions météo (Open-Meteo, gratuit, sans clé). Les fortes pluies et les orages
// sont la première cause des coupures accidentelles.

import { CITY_COORDS } from '../data/zones.ts';
import type { Store } from './db.ts';

let lastError = '';

export async function refreshWeather(store: Store): Promise<boolean> {
  try {
    for (const [city, c] of Object.entries(CITY_COORDS)) {
      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lon}` +
        '&hourly=precipitation,wind_gusts_10m,weather_code&past_days=1&forecast_days=2&timezone=UTC&timeformat=unixtime';
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { hourly: { time: number[]; precipitation: number[]; wind_gusts_10m: number[]; weather_code: number[] } };
      const h = data.hourly;
      h.time.forEach((t, i) => {
        store.upsertWeather({
          city,
          at: t * 1000,
          rainMm: h.precipitation[i] ?? 0,
          gustKmh: h.wind_gusts_10m[i] ?? 0,
          thunder: (h.weather_code[i] ?? 0) >= 95,
        });
      });
    }
    lastError = '';
    return true;
  } catch (err) {
    const msg = (err as Error).message;
    if (msg !== lastError) console.warn(`[météo] indisponible (${msg}) — prévisions sans météo.`);
    lastError = msg;
    return false;
  }
}
