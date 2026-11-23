// Construit une démo autonome (sans serveur) dans dist-demo/ : le vrai moteur et le vrai service
// tournent dans le navigateur sur des données simulées. Utilisée pour partager un lien de démonstration.
//   npm run build:demo

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'dist-demo');
const MODULES = [
  'engine/types', 'engine/math', 'engine/reputation', 'engine/nowcast', 'engine/forecast', 'engine/baseline',
  'engine/calibration', 'engine/episodes', 'engine/geo', 'data/zones', 'server/service', 'server/routes', 'sim/world', 'sim/scenario',
];

rmSync(OUT, { recursive: true, force: true });
for (const m of MODULES) {
  const src = readFileSync(join(ROOT, 'src', `${m}.ts`), 'utf8');
  const js = stripTypeScriptTypes(src, { mode: 'strip' }).replace(/(from\s+['"][^'"]+)\.ts(['"])/g, '$1.js$2');
  const dest = join(OUT, 'js', `${m}.js`);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, js);
}
for (const f of ['memstore.js', 'boot.js']) writeFileSync(join(OUT, f), readFileSync(join(ROOT, 'web-demo', f)));
writeFileSync(join(OUT, 'app.js'), readFileSync(join(ROOT, 'public', 'app.js')));
writeFileSync(join(OUT, 'leaflet.js'), readFileSync(join(ROOT, 'public', 'vendor', 'leaflet', 'leaflet.js')));

const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));
const icon = `data:image/svg+xml;base64,${readFileSync(join(ROOT, 'public', 'icon.svg')).toString('base64')}`;
const css = readFileSync(join(ROOT, 'public', 'vendor', 'leaflet', 'leaflet.css'), 'utf8') + '\n' + readFileSync(join(ROOT, 'public', 'style.css'), 'utf8');
const page = `<title>Dot Courant</title>
<style>
${css}
</style>
${body.replace('src="/icon.svg"', `src="${icon}"`).replace('<script src="/vendor/leaflet/leaflet.js"></script>', '<script src="leaflet.js"></script>').replace('<script type="module" src="/app.js"></script>', '<script type="module" src="boot.js"></script>')}
`;
writeFileSync(join(OUT, 'index.html'), page);
console.log(`Démo construite dans ${OUT}`);
