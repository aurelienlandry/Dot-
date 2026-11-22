// Réputation des sources, façon « marché de prédiction » :
// chaque source (téléphone, utilisateur, ENEO…) a un historique de justesse.
// Son influence est proportionnelle à la confiance qu'elle a gagnée, jamais décrétée.

import { clamp } from './math.ts';
import type { Reputation } from './types.ts';

/** Nouvelle source : légèrement crédible (≈ 67 %), mais faible poids d'historique. */
export const DEFAULT_REPUTATION: Reputation = { alpha: 3, beta: 1.5 };

/** Annonces officielles : a priori assez fiables, mais elles doivent le prouver. */
export const DEFAULT_PLANNED_REPUTATION: Reputation = { alpha: 6, beta: 2 };

export function reliability(rep: Reputation | undefined): number {
  const r = rep ?? DEFAULT_REPUTATION;
  return clamp(r.alpha / (r.alpha + r.beta), 0.5, 0.97);
}

export function updateReputation(rep: Reputation | undefined, correct: boolean): Reputation {
  const r = rep ?? DEFAULT_REPUTATION;
  return correct ? { alpha: r.alpha + 1, beta: r.beta } : { alpha: r.alpha, beta: r.beta + 1 };
}

/**
 * Juge une affirmation (« coupé » / « courant ») contre la vérité estimée SANS cette source
 * (leave-one-out) : une source ne peut pas se donner raison toute seule.
 * Retourne null si la vérité n'est pas assez claire pour trancher.
 */
export function judgeClaim(claimOut: boolean, truth: { pOut: number; evidenceWeight: number }): boolean | null {
  if (truth.evidenceWeight < 1.5) return null;
  if (truth.pOut >= 0.8) return claimOut;
  if (truth.pOut <= 0.2) return !claimOut;
  return null;
}
