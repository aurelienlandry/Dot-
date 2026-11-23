// Estimation « maintenant » : y a-t-il le courant à cet endroit ?
//
// Principe : on part de ce que l'historique dit de cette heure-là (l'a priori), puis chaque indice
// déplace la probabilité selon sa force et la fiabilité de sa source (fusion bayésienne en log-cotes).
// Les indices vieillissent, les sources douteuses pèsent peu, et la simultanéité est reine :
// un téléphone qui arrête de charger, c'est peut-être un chargeur débranché ;
// dix téléphones du même quartier à la même minute, c'est une coupure.

import { clamp, diminishing, formatAge, formatLocalTime, haversineKm, hourOfWeek, HOUR, logit, MINUTE, sigmoid } from './math.ts';
import { DEFAULT_PLANNED_REPUTATION, reliability } from './reputation.ts';
import type {
  Confidence,
  Evidence,
  IncidentType,
  Nowcast,
  Observation,
  PlannedOutage,
  Reputation,
  WeatherPoint,
  Zone,
  ZoneBaseline,
} from './types.ts';

export const LOOKBACK_MS = 6 * HOUR;
export const INCIDENT_LOOKBACK_MS = 12 * HOUR;
const CLUSTER_WINDOW_MS = 4 * MINUTE;
// Une affirmation « le courant est là » ne dit rien de ce qui s'est passé APRÈS : elle vieillit vite.
const ON_FRESHNESS_H = 20 / 60;
const BACK_FRESHNESS_H = 30 / 60;
const INCIDENT_HALF_LIFE_H = 8;

const INCIDENT_LR: Record<IncidentType, number> = {
  transformer_fire: 10,
  pole_down: 5,
  cable_down: 5,
  explosion: 3,
  storm_damage: 3,
};

export const INCIDENT_LABELS: Record<IncidentType, string> = {
  transformer_fire: 'Transformateur en feu',
  pole_down: 'Poteau tombé',
  cable_down: 'Câble à terre / arraché',
  explosion: 'Bruit d’explosion (transfo)',
  storm_damage: 'Dégâts d’orage',
};

export interface LocalInput {
  zone: Zone;
  at: number;
  /** Observations du quartier (au moins les 12 dernières heures, aucune postérieure à `at` n'est utilisée). */
  observations: Observation[];
  planned: PlannedOutage[];
  weather?: WeatherPoint;
  reputations: Map<string, Reputation>;
  baseline: ZoneBaseline;
  /** Source à ignorer (pour juger une source contre les autres). */
  excludeSource?: string;
}

export interface LocalEvidence {
  zoneId: string;
  prior: number;
  evidence: Evidence[];
  /** Somme des indices propres au quartier. */
  sum: number;
  /** Partie transmissible aux quartiers voisins (terrain uniquement, pas la météo ni les annonces). */
  propagable: number;
  onsetHint?: number;
  restoreHint?: number;
  incidentSeverity: number;
}

export function priorFromBaseline(baseline: ZoneBaseline, at: number): number {
  const lambda = baseline.startsPerHour[hourOfWeek(at)];
  const mu = 1 / baseline.meanOutageHours;
  return clamp(lambda / (lambda + mu), 0.01, 0.5);
}

export function weatherMultiplier(w: WeatherPoint | undefined): number {
  if (!w) return 1;
  let m = 1;
  if (w.thunder || w.rainMm >= 10) m *= 2.5;
  else if (w.rainMm >= 4) m *= 1.5;
  if (w.gustKmh >= 50) m *= 1.4;
  return m;
}

/**
 * Groupe le plus récent d'au moins 2 téléphones distincts ayant le même événement dans une fenêtre de 4 minutes.
 * C'est un « point de rupture » : tout ce qui précède dans le sens contraire est périmé.
 */
export function latestCluster(events: { sourceId: string; at: number }[]): { size: number; start: number; end: number } | null {
  const sorted = events.slice().sort((a, b) => a.at - b.at);
  let best: { size: number; start: number; end: number } | null = null;
  const counts = new Map<string, number>();
  let j = 0;
  for (let i = 0; i < sorted.length; i++) {
    counts.set(sorted[i].sourceId, (counts.get(sorted[i].sourceId) ?? 0) + 1);
    while (sorted[i].at - sorted[j].at > CLUSTER_WINDOW_MS) {
      const c = counts.get(sorted[j].sourceId)! - 1;
      if (c) counts.set(sorted[j].sourceId, c);
      else counts.delete(sorted[j].sourceId);
      j++;
    }
    const size = counts.size;
    if (size < 2) continue;
    const startsNew = !best || sorted[j].at > best.end;
    if (startsNew || size >= best!.size) best = { size, start: startsNew ? sorted[j].at : Math.min(best!.start, sorted[j].at), end: sorted[i].at };
  }
  return best;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n > 1 ? 's' : ''}`;
}

export function localEvidence(input: LocalInput): LocalEvidence {
  const { zone, at, baseline, reputations, excludeSource } = input;
  const mu = 1 / baseline.meanOutageHours;
  const prior = priorFromBaseline(baseline, at);
  const obs = input.observations.filter((o) => o.at <= at && o.sourceId !== excludeSource);

  // --- 1. Simultanéité : plusieurs téléphones distincts qui changent d'état ensemble.
  const deviceObs = obs.filter((o): o is Extract<Observation, { kind: 'device' }> => o.kind === 'device' && at - o.at <= LOOKBACK_MS);
  // Perte de charge et perte du Wi-Fi de la maison vont dans le même sens : on les regroupe.
  const lost = latestCluster(deviceObs.filter((o) => o.event === 'power_lost' || o.event === 'wifi_lost'));
  const back = latestCluster(deviceObs.filter((o) => o.event === 'power_back' || o.event === 'wifi_back'));
  const newest = lost && back ? (lost.end >= back.end ? 'lost' : 'back') : lost ? 'lost' : back ? 'back' : null;
  const evidence: Evidence[] = [];
  if (newest === 'lost' && lost) {
    const w = Math.min(Math.log(4) * (lost.size - 1), Math.log(500)) * Math.exp(-((at - lost.end) / HOUR) * mu);
    evidence.push({ kind: 'cluster', label: `${plural(lost.size, 'téléphone')} ont perdu le courant en même temps à ${formatLocalTime(lost.start)}`, logLR: w, at: lost.start });
  } else if (newest === 'back' && back) {
    const w = -Math.min(Math.log(4) * (back.size - 1), Math.log(500)) * Math.exp(-((at - back.end) / HOUR) / BACK_FRESHNESS_H / 3);
    evidence.push({ kind: 'cluster', label: `${plural(back.size, 'téléphone')} ont retrouvé le courant ensemble à ${formatLocalTime(back.start)}`, logLR: w, at: back.start });
  }
  // Point de rupture : un indice contraire antérieur au dernier changement groupé est périmé.
  const changePoint = newest === 'lost' ? lost!.start : newest === 'back' ? back!.start : -Infinity;
  const stale = (w: number, t: number) => t < changePoint && (newest === 'lost' ? w < 0 : w > 0);

  // --- 2. Témoins (téléphones capteurs + signalements) : on garde le dernier état de chaque source.
  const latest = new Map<string, Observation>();
  for (const o of obs) {
    if (o.kind === 'incident' || at - o.at > LOOKBACK_MS) continue;
    const prev = latest.get(o.sourceId);
    if (!prev || o.at > prev.at) latest.set(o.sourceId, o);
  }

  type Raw = { w: number; at: number; label: string; kind: 'report' | 'device' };
  const raws: Raw[] = [];
  for (const o of latest.values()) {
    const r = reliability(reputations.get(o.sourceId));
    const ageH = (at - o.at) / HOUR;
    const age = formatAge(at - o.at);
    if (o.kind === 'report') {
      const base = Math.log(r / (1 - r));
      if (o.state === 'out') raws.push({ w: base * Math.exp(-ageH * mu), at: o.at, label: `Signalement « coupé » (${age})`, kind: 'report' });
      else raws.push({ w: -base * Math.exp(-ageH / ON_FRESHNESS_H), at: o.at, label: `Signalement « courant présent » (${age})`, kind: 'report' });
    } else if (o.kind === 'device') {
      // Un téléphone seul est ambigu (chargeur débranché, groupe électrogène…) : poids modéré, ajusté par sa fiabilité.
      const relFactor = clamp((r - 0.5) / (0.667 - 0.5), 0, 1.5);
      if (o.event === 'power_lost') raws.push({ w: Math.log(3) * relFactor * Math.exp(-ageH * mu), at: o.at, label: `Un téléphone a cessé de charger (${age})`, kind: 'device' });
      else if (o.event === 'power_back') raws.push({ w: -Math.log(6) * relFactor * Math.exp(-ageH / BACK_FRESHNESS_H), at: o.at, label: `Un téléphone a repris la charge (${age})`, kind: 'device' });
      // Le Wi-Fi qui disparaît : la box s'est peut-être éteinte (ou la personne a quitté la maison).
      else if (o.event === 'wifi_lost') raws.push({ w: Math.log(2) * relFactor * Math.exp(-ageH * mu), at: o.at, label: `Un téléphone a perdu le Wi-Fi de la maison (${age})`, kind: 'device' });
      else if (o.event === 'wifi_back') raws.push({ w: -Math.log(3) * relFactor * Math.exp(-ageH / BACK_FRESHNESS_H), at: o.at, label: `Un téléphone a retrouvé le Wi-Fi (${age})`, kind: 'device' });
      // Rester en charge est un indice faible : onduleurs et groupes électrogènes sont courants.
      else raws.push({ w: -Math.log(2) * relFactor * Math.exp(-ageH / ON_FRESHNESS_H), at: o.at, label: `Un téléphone est en charge (${age})`, kind: 'device' });
    }
  }
  const fresh = raws.filter((x) => !stale(x.w, x.at));
  const pos = fresh.filter((x) => x.w > 0);
  const neg = fresh.filter((x) => x.w < 0);
  const posW = diminishing(pos.map((x) => x.w));
  const negW = diminishing(neg.map((x) => x.w));
  pos.forEach((x, i) => evidence.push({ kind: x.kind, label: x.label, logLR: posW[i], at: x.at }));
  neg.forEach((x, i) => evidence.push({ kind: x.kind, label: x.label, logLR: negW[i], at: x.at }));

  // --- 3. Incidents physiques : on « price » la coupure avant même sa confirmation.
  const incidents = obs.filter((o): o is Extract<Observation, { kind: 'incident' }> => o.kind === 'incident' && at - o.at <= INCIDENT_LOOKBACK_MS);
  const bestByType = new Map<IncidentType, { w: number; at: number; n: number }>();
  for (const inc of incidents) {
    const r = reliability(reputations.get(inc.sourceId));
    const relW = clamp((r - 0.5) / 0.25, 0, 1);
    const ageH = (at - inc.at) / HOUR;
    const w = Math.log(INCIDENT_LR[inc.incident]) * relW * 0.5 ** (ageH / INCIDENT_HALF_LIFE_H);
    const cur = bestByType.get(inc.incident);
    // Plusieurs témoins du même incident le rendent plus crédible (jusqu'à x2).
    if (!cur) bestByType.set(inc.incident, { w, at: inc.at, n: 1 });
    else bestByType.set(inc.incident, { w: Math.max(cur.w, w), at: Math.min(cur.at, inc.at), n: cur.n + 1 });
  }
  let incidentSeverity = 0;
  const incEntries = [...bestByType.entries()];
  const incW = diminishing(incEntries.map(([, v]) => v.w * Math.min(2, 1 + 0.3 * (v.n - 1))));
  incEntries.forEach(([type, v], i) => {
    incidentSeverity += incW[i];
    evidence.push({
      kind: 'incident',
      label: `${INCIDENT_LABELS[type]} signalé ${v.n > 1 ? `par ${v.n} personnes ` : ''}(${formatAge(at - v.at)})`,
      logLR: incW[i],
      at: v.at,
    });
  });

  // --- 4. Annonces officielles en cours.
  for (const p of input.planned) {
    if (p.start <= at && at <= p.end && haversineKm(zone.lat, zone.lon, p.lat, p.lon) <= p.radiusKm) {
      const r = reliability(reputations.get(p.sourceId) ?? DEFAULT_PLANNED_REPUTATION);
      evidence.push({
        kind: 'planned',
        label: `Coupure programmée annoncée (${formatLocalTime(p.start)}–${formatLocalTime(p.end)}, fiabilité source ${Math.round(r * 100)} %)`,
        logLR: Math.log(r / (1 - r)),
        at: p.start,
      });
      break;
    }
  }

  // --- 5. Météo en cours.
  const wm = weatherMultiplier(input.weather);
  if (wm > 1 && input.weather) {
    const w = input.weather;
    const what = w.thunder ? 'Orage' : w.rainMm >= 4 ? `Pluie forte (${w.rainMm.toFixed(0)} mm/h)` : `Vent fort (${w.gustKmh.toFixed(0)} km/h)`;
    evidence.push({ kind: 'weather', label: `${what} en cours`, logLR: Math.log(wm) });
  }

  const sum = evidence.reduce((s, e) => s + e.logLR, 0);
  const propagable = evidence.filter((e) => e.kind === 'report' || e.kind === 'device' || e.kind === 'cluster' || e.kind === 'incident').reduce((s, e) => s + e.logLR, 0);

  // Début / fin estimés d'une coupure (pour l'historique) : premier indice « coupé », premier indice « revenu » après lui.
  const positives = evidence.filter((e) => e.logLR > 0 && e.at !== undefined && e.kind !== 'planned');
  const onsetHint = positives.length ? Math.min(...positives.map((e) => e.at as number)) : undefined;
  const negatives = evidence.filter((e) => e.logLR < 0 && e.at !== undefined && (onsetHint === undefined || (e.at as number) >= onsetHint));
  const restoreHint = negatives.length ? Math.min(...negatives.map((e) => e.at as number)) : undefined;

  return { zoneId: zone.id, prior, evidence, sum, propagable, onsetHint, restoreHint, incidentSeverity };
}

export interface Peer {
  zone: Zone;
  local: LocalEvidence;
  distanceKm: number;
  /** Alimenté par le même poste électrique : les coupures y sont très liées, même à plusieurs km. */
  sameFeeder?: boolean;
}

/** Influence d'un endroit voisin : forte tout près, quasi nulle au-delà de 2–3 km. */
export function propagationCoef(distanceKm: number): number {
  return 0.8 * Math.exp(-distanceKm / 1.2);
}

export function confidenceOf(weight: number): Confidence {
  if (weight < 1) return 'faible';
  if (weight < 3) return 'moyenne';
  return 'forte';
}

const fmtKm = (d: number) => (d < 1 ? `${Math.round(d * 10) * 100} m` : `${d.toFixed(1).replace('.', ',')} km`);

/** Combine les indices du lieu avec ceux des alentours (pondérés par la distance). */
export function combine(zone: Zone, at: number, local: LocalEvidence, peers: Peer[]): Nowcast {
  const evidence = local.evidence.slice();
  const props: Evidence[] = [];
  for (const peer of peers) {
    const coef = peer.sameFeeder ? Math.max(0.5, propagationCoef(peer.distanceKm)) : propagationCoef(peer.distanceKm);
    const c = clamp(coef * peer.local.propagable, -3 * coef, 5 * coef);
    if (Math.abs(c) < 0.1) continue;
    props.push({
      kind: 'propagation',
      label: `${c > 0 ? 'Coupure signalée' : 'Courant confirmé'} à ${fmtKm(peer.distanceKm)}${peer.sameFeeder ? ' (même poste électrique)' : ''}`,
      logLR: c,
    });
  }
  // Les alentours comptent, mais avec des rendements décroissants et un plafond.
  const pw = diminishing(props.map((e) => e.logLR), 0.7);
  const total = pw.reduce((a, b) => a + b, 0);
  const scale = total > 3 ? 3 / total : total < -2 ? -2 / total : 1;
  props.forEach((e, i) => evidence.push({ ...e, logLR: pw[i] * scale }));

  const logOdds = logit(local.prior) + evidence.reduce((s, e) => s + e.logLR, 0);
  const evidenceWeight = evidence.filter((e) => e.kind !== 'weather').reduce((s, e) => s + Math.abs(e.logLR), 0);
  evidence.sort((a, b) => Math.abs(b.logLR) - Math.abs(a.logLR));
  return {
    zoneId: zone.id,
    at,
    pOut: sigmoid(logOdds),
    prior: local.prior,
    confidence: confidenceOf(evidenceWeight),
    evidenceWeight,
    evidence,
    onsetHint: local.onsetHint,
    restoreHint: local.restoreHint,
    incidentSeverity: local.incidentSeverity,
  };
}

/**
 * Une seule phrase simple pour l'utilisateur : d'où vient l'information principale.
 * (Le détail technique reste disponible pour le débogage, pas affiché.)
 */
export function summarize(n: Nowcast): string {
  const feederOut = n.evidence.some((e) => e.kind === 'propagation' && e.logLR > 0 && e.label.includes('même poste'));
  const out = n.pOut >= 0.5;
  const sum = (kinds: string[], sign: number) => n.evidence.filter((e) => kinds.includes(e.kind) && Math.sign(e.logLR) === sign).reduce((s, e) => s + Math.abs(e.logLR), 0);
  const sign = out ? 1 : -1;
  const people = sum(['report', 'device', 'cluster'], sign);
  const around = sum(['propagation'], sign);
  const planned = sum(['planned'], 1);
  const incident = sum(['incident'], 1);
  if (out) {
    if (planned > 0 && planned >= people) return 'Coupure programmée annoncée';
    if (people >= 1) return 'Confirmé par des habitants';
    if (incident >= 1) return 'Incident signalé tout près';
    if (around >= 1) return feederOut ? 'Coupure sur votre poste électrique' : 'Coupure signalée tout près';
    return 'Estimation';
  }
  if (incident >= 1) return 'Incident signalé tout près : risque de coupure';
  if (sum(['propagation'], 1) >= 1) return feederOut ? 'Coupure sur votre poste électrique : risque élevé' : 'Coupure signalée tout près';
  if (people >= 1) return 'Confirmé par des habitants';
  if (around >= 1) return 'Courant confirmé aux alentours';
  return 'Aucune coupure signalée';
}
