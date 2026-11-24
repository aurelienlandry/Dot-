// Construit la page « Labo Yaoundé » : le modèle + les dernières données publiques intégrées.
//   npm run labo   (relève les données puis construit dist-labo/labo-yaounde.html)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const tpl = readFileSync(join(ROOT, 'web-labo', 'template.html'), 'utf8');
const data = readFileSync(join(ROOT, 'web-labo', 'data.json'), 'utf8').replace(/</g, '\\u003c');
mkdirSync(join(ROOT, 'dist-labo'), { recursive: true });
writeFileSync(join(ROOT, 'dist-labo', 'labo-yaounde.html'), tpl.replace('/*DATA*/null', data));
console.log('Page construite : dist-labo/labo-yaounde.html');
