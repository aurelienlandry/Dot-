// Reconstitution des coupures (début / fin) à partir des estimations successives.
// Hystérésis : on ouvre une coupure seulement si elle est probable ET appuyée par de vrais indices,
// on la ferme quand le retour du courant devient probable. C'est la base du bilan annuel.

import type { Nowcast } from './types.ts';

export const OPEN_THRESHOLD = 0.75;
export const CLOSE_THRESHOLD = 0.3;
export const MIN_EVIDENCE_TO_OPEN = 1.5;

export type EpisodeAction = { action: 'open'; start: number } | { action: 'close'; end: number } | null;

export function episodeStep(isOpen: boolean, openStart: number | null, n: Nowcast): EpisodeAction {
  if (!isOpen && n.pOut >= OPEN_THRESHOLD && n.evidenceWeight >= MIN_EVIDENCE_TO_OPEN) {
    return { action: 'open', start: Math.min(n.at, n.onsetHint ?? n.at) };
  }
  if (isOpen && n.pOut <= CLOSE_THRESHOLD) {
    let end = n.restoreHint ?? n.at;
    if (openStart !== null && end <= openStart) end = n.at;
    return { action: 'close', end: Math.min(end, n.at) };
  }
  return null;
}
