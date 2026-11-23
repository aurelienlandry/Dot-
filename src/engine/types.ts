// Types du domaine : quartiers, observations brutes, estimations.
// Tous les instants sont en millisecondes depuis l'epoch (UTC).

export type ZoneId = string;

/** Un lieu évalué : une case de la grille, le domicile d'un utilisateur, le centre d'un quartier… */
export interface Zone {
  id: ZoneId;
  name: string;
  city: string;
  lat: number;
  lon: number;
  /** Groupe d'alimentation (départ / poste), quand il est connu. */
  feeder?: string;
}

/** Position commune à toutes les observations (arrondie à ~100 m) ; zoneId = case de la grille. */
interface Located {
  sourceId: string;
  zoneId: ZoneId;
  lat: number;
  lon: number;
  at: number;
}

export type DeviceEvent = 'power_lost' | 'power_back' | 'charging' | 'wifi_lost' | 'wifi_back';

/**
 * Événement envoyé automatiquement par un téléphone qui sert de capteur.
 * power_lost / power_back : la charge s'arrête / reprend ; charging : toujours en charge.
 * wifi_lost / wifi_back : le téléphone perd / retrouve le Wi-Fi de la maison (la box s'éteint avec le courant).
 */
export interface DeviceObservation extends Located {
  kind: 'device';
  event: DeviceEvent;
}

/** Signalement manuel d'un utilisateur. */
export interface ReportObservation extends Located {
  kind: 'report';
  state: 'out' | 'on';
}

export type IncidentType = 'transformer_fire' | 'pole_down' | 'cable_down' | 'explosion' | 'storm_damage';

/** Incident physique signalé : annonce une coupure probable avant même qu'elle soit confirmée. */
export interface IncidentObservation extends Located {
  kind: 'incident';
  incident: IncidentType;
}

export type Observation = DeviceObservation | ReportObservation | IncidentObservation;

/** Coupure programmée annoncée (ENEO ou autre source), sur une zone : un point et un rayon. */
export interface PlannedOutage {
  id: number;
  sourceId: string;
  lat: number;
  lon: number;
  radiusKm: number;
  /** Nom des quartiers concernés, tel qu'annoncé. */
  label: string;
  start: number;
  end: number;
  note?: string;
  url?: string;
}

/** Météo pour une ville et une heure (début d'heure). */
export interface WeatherPoint {
  city: string;
  at: number;
  rainMm: number;
  gustKmh: number;
  thunder: boolean;
}

/** Réputation d'une source : loi Beta(alpha, beta) sur sa probabilité de dire vrai. */
export interface Reputation {
  alpha: number;
  beta: number;
}

/** Ce que l'historique nous apprend d'un quartier. */
export interface ZoneBaseline {
  /** Taux de début de coupure par heure, pour chacune des 168 heures de la semaine (lundi 0h = 0). */
  startsPerHour: number[];
  /** Durée moyenne d'une coupure, en heures. */
  meanOutageHours: number;
}

export type EvidenceKind = 'report' | 'device' | 'cluster' | 'incident' | 'planned' | 'weather' | 'propagation';

/** Un élément d'explication : chaque indice déplace la probabilité (log du rapport de vraisemblance). */
export interface Evidence {
  kind: EvidenceKind;
  label: string;
  logLR: number;
  at?: number;
}

export type Confidence = 'faible' | 'moyenne' | 'forte';

export interface Nowcast {
  zoneId: ZoneId;
  at: number;
  pOut: number;
  prior: number;
  confidence: Confidence;
  /** Poids total des indices réels (hors a priori). Sert à savoir si on « sait » vraiment. */
  evidenceWeight: number;
  evidence: Evidence[];
  onsetHint?: number;
  restoreHint?: number;
  incidentSeverity: number;
}

export interface ForecastPoint {
  at: number;
  pOut: number;
  planned: boolean;
}
