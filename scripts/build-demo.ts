// Construit une démo autonome (sans serveur) : UN SEUL fichier HTML, tout le code inclus.
// Le vrai moteur, le vrai service et les vraies routes de l'API tournent dans le navigateur
// sur des données simulées. Sert à partager un lien de démonstration.
//   npm run build:demo   →   dist-demo/index.html

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'dist-demo');
// Ordre des dépendances : chaque module ne dépend que des précédents.
const MODULES = [
  'engine/math', 'engine/reputation', 'engine/geo', 'engine/nowcast', 'engine/forecast', 'engine/baseline',
  'engine/calibration', 'engine/episodes', 'data/zones', 'sim/world', 'sim/scenario', 'server/service', 'server/routes',
];

/** Retire les import/export : tous les modules partagent une seule portée. */
function unmodule(js: string): string {
  return js
    .replace(/^\s*import\s[\s\S]*?\sfrom\s*['"][^'"]+['"];?/gm, '')
    .replace(/^\s*import\s*['"][^'"]+['"];?/gm, '')
    .replace(/^\s*export\s*\{[^}]*\};?/gm, '')
    .replace(/^(\s*)export\s+(?=(async\s+)?function|const|let|class)/gm, '$1');
}

const engine = MODULES.map((m) => {
  const js = stripTypeScriptTypes(readFileSync(join(ROOT, 'src', `${m}.ts`), 'utf8'), { mode: 'strip' });
  return `// ---- ${m}\n${unmodule(js)}`;
}).join('\n');
const memstore = unmodule(readFileSync(join(ROOT, 'web-demo', 'memstore.js'), 'utf8'));
const app = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
const leaflet = readFileSync(join(ROOT, 'public', 'vendor', 'leaflet', 'leaflet.js'), 'utf8');
const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
const body = html
  .slice(html.indexOf('<body>') + 6, html.indexOf('</body>'))
  .replace(/<script[^>]*><\/script>\s*/g, '');
const icon = `data:image/svg+xml;base64,${readFileSync(join(ROOT, 'public', 'icon.svg')).toString('base64')}`;
const fonts = html.match(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>/)?.[0] ?? '';
const css = `${readFileSync(join(ROOT, 'public', 'vendor', 'leaflet', 'leaflet.css'), 'utf8')}\n${readFileSync(join(ROOT, 'public', 'style.css'), 'utf8')}`;
const safe = (s: string) => s.replace(/<\/script/gi, '<\\/script');

function page(title: string, bootFile: string): string {
  const boot = unmodule(readFileSync(join(ROOT, 'web-demo', bootFile), 'utf8')).replace(/^await import\('\.\/app\.js'\);?$/m, '');
  return `<title>${title}</title>
${fonts}
<style>
${css}
</style>
${body.replace('src="/icon.svg"', `src="${icon}"`)}
<script>
${safe(leaflet)}
</script>
<script>
(() => {
${safe(engine)}
${safe(memstore)}
${safe(boot)}
})();
</script>
<script>
${safe(app)}
</script>
`;
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const [file, title, boot] of [['index.html', 'Dot Courant', 'boot.js'], ['test-yaounde.html', 'Dot Yaoundé', 'boot-test.js']]) {
  const html = page(title, boot);
  writeFileSync(join(OUT, file), html);
  console.log(`${file} : ${Math.round(html.length / 1024)} Ko`);
}
