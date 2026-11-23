// Dot — application mobile (PWA). Aucune dépendance, pensée pour les petits forfaits data.

const $view = document.getElementById('view');
const TZ_OFFSET = 3600_000; // Africa/Douala (UTC+1)
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(`dot.${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`dot.${k}`, JSON.stringify(v)); } catch { /* stockage indisponible */ } },
};

// Identifiant anonyme de l'appareil : aucune donnée personnelle, aucune position GPS envoyée.
let deviceId = store.get('device');
if (!deviceId) {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  deviceId = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  store.set('device', deviceId);
}

let meta = null; // { cities, zones, incidents, demo }
const zoneById = (id) => meta.zones.find((z) => z.id === id);

// ---------- Utilitaires
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pct = (p) => `${Math.round(p * 100)} %`;
function localTime(t) {
  const d = new Date(t + TZ_OFFSET);
  return `${String(d.getUTCHours()).padStart(2, '0')}h${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
function localDay(t, now = Date.now()) {
  const day = (x) => Math.floor((x + TZ_OFFSET) / 86400000);
  const diff = day(t) - day(now);
  return diff === 0 ? "aujourd'hui" : diff === 1 ? 'demain' : diff === -1 ? 'hier' : new Date(t).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'Africa/Douala' });
}
function duration(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${String(m % 60).padStart(2, '0')}` : `${h} h`;
}
const level = (pOut) => (pOut >= 0.6 ? 'out' : pOut >= 0.3 ? 'mid' : 'on');

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

// ---------- Réseau, avec file d'attente hors connexion pour les signalements
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Erreur ${res.status}`), { status: res.status });
  return data;
}

async function post(path, body) {
  const payload = { ...body, deviceId, at: Date.now() };
  try {
    return await api(path, { method: 'POST', body: JSON.stringify(payload) });
  } catch (err) {
    if (err.status) throw err; // refus du serveur : inutile de réessayer
    const queue = store.get('queue', []);
    queue.push({ path, payload });
    store.set('queue', queue.slice(-50));
    return { queued: true };
  }
}

async function flushQueue() {
  const queue = store.get('queue', []);
  if (!queue.length || !navigator.onLine) return;
  const rest = [];
  for (const item of queue) {
    try {
      await api(item.path, { method: 'POST', body: JSON.stringify(item.payload) });
    } catch (err) {
      if (!err.status) rest.push(item);
    }
  }
  store.set('queue', rest);
  if (queue.length > rest.length) toast(`${queue.length - rest.length} signalement(s) envoyé(s).`);
}

function updateNet() {
  document.getElementById('net').hidden = navigator.onLine;
}
addEventListener('online', () => { updateNet(); flushQueue(); route(); });
addEventListener('offline', updateNet);

// ---------- Capteur : le téléphone signale automatiquement quand il arrête / reprend la charge
const sensor = {
  battery: null,
  lastBeat: 0,
  async start() {
    if (!('getBattery' in navigator)) return false;
    this.battery = this.battery || (await navigator.getBattery());
    if (!this.bound) {
      this.battery.addEventListener('chargingchange', () => this.onChange());
      this.bound = true;
    }
    this.beat();
    return true;
  },
  onChange() {
    const zone = store.get('home');
    if (!store.get('sensor') || !zone) return;
    post('/api/device', { zoneId: zone, event: this.battery.charging ? 'power_back' : 'power_lost' });
    if (this.battery.charging) this.lastBeat = Date.now();
  },
  beat() {
    const zone = store.get('home');
    if (!store.get('sensor') || !zone || !this.battery?.charging) return;
    if (Date.now() - this.lastBeat < 10 * 60000) return;
    this.lastBeat = Date.now();
    post('/api/device', { zoneId: zone, event: 'charging' });
  },
};
setInterval(() => { if (document.visibilityState === 'visible') sensor.beat(); }, 60000);

// ---------- Graphique des 12 prochaines heures
function chart(points, arrival) {
  const W = 600, H = 150, PAD_B = 22, PAD_T = 8;
  const t0 = points[0].at, t1 = points[points.length - 1].at;
  const x = (t) => ((t - t0) / (t1 - t0)) * W;
  const y = (p) => PAD_T + (1 - p) * (H - PAD_B - PAD_T);
  // On affiche la probabilité d'AVOIR le courant (plus intuitif).
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.at).toFixed(1)},${y(1 - p.pOut).toFixed(1)}`).join('');
  const area = `${line}L${W},${y(0)}L0,${y(0)}Z`;
  let planned = '';
  let start = null;
  points.forEach((p, i) => {
    if (p.planned && start === null) start = p.at;
    if ((!p.planned || i === points.length - 1) && start !== null) {
      planned += `<rect x="${x(start)}" y="${PAD_T}" width="${Math.max(2, x(p.at) - x(start))}" height="${H - PAD_B - PAD_T}" fill="var(--planned)"/>`;
      start = null;
    }
  });
  let ticks = '';
  const firstHour = Math.ceil((t0 + TZ_OFFSET) / 3600000) * 3600000 - TZ_OFFSET;
  for (let t = firstHour; t <= t1; t += 3600000) {
    const h = new Date(t + TZ_OFFSET).getUTCHours();
    if (h % 4) continue;
    ticks += `<line x1="${x(t)}" x2="${x(t)}" y1="${PAD_T}" y2="${H - PAD_B}" stroke="var(--line)"/><text x="${x(t)}" y="${H - 6}" text-anchor="middle">${h}h</text>`;
  }
  const grid = [0.5, 0.8].map((p) => `<line x1="0" x2="${W}" y1="${y(p)}" y2="${y(p)}" stroke="var(--line)" stroke-dasharray="4 4"/><text x="4" y="${y(p) - 3}">${p * 100} %</text>`).join('');
  const arr = arrival && arrival >= t0 && arrival <= t1
    ? `<line x1="${x(arrival)}" x2="${x(arrival)}" y1="${PAD_T}" y2="${H - PAD_B}" stroke="var(--accent)" stroke-width="2"/><text x="${Math.min(W - 40, x(arrival) + 4)}" y="${PAD_T + 12}" style="fill:var(--accent)">arrivée</text>`
    : '';
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Probabilité d'avoir le courant sur les 24 prochaines heures">
    ${planned}${ticks}${grid}
    <path d="${area}" fill="var(--on)" opacity=".15"/>
    <path d="${line}" fill="none" stroke="var(--on)" stroke-width="2.5"/>
    ${arr}
  </svg>
  <div class="legend"><span><i style="background:var(--on);opacity:.5"></i>Chance d'avoir le courant</span><span><i style="background:var(--planned)"></i>Coupure programmée annoncée</span></div>`;
}

function probAt(points, t) {
  if (t < points[0].at || t > points[points.length - 1].at) return null;
  for (let i = 1; i < points.length; i++) {
    if (t <= points[i].at) {
      const a = points[i - 1], b = points[i];
      return a.pOut + ((t - a.at) / (b.at - a.at)) * (b.pOut - a.pOut);
    }
  }
  return null;
}

/** Prochaine occurrence de HH:MM (heure de Douala) après maintenant. */
function nextLocal(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const now = Date.now();
  const d = new Date(now + TZ_OFFSET);
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m) - TZ_OFFSET;
  if (t < now - 5 * 60000) t += 86400000;
  return t;
}

// ---------- Vues
function zonePicker(current) {
  return `<select id="zone-select" aria-label="Quartier">
    <option value="">— Choisir un quartier —</option>
    ${meta.cities.map((c) => `<optgroup label="${esc(c)}">${meta.zones.filter((z) => z.city === c).map((z) => `<option value="${z.id}" ${z.id === current ? 'selected' : ''}>${esc(z.name)}</option>`).join('')}</optgroup>`).join('')}
  </select>`;
}

function nearestZone(lat, lon) {
  let best = null, bestD = Infinity;
  for (const z of meta.zones) {
    const d = (z.lat - lat) ** 2 + ((z.lon - lon) * Math.cos((lat * Math.PI) / 180)) ** 2;
    if (d < bestD) { bestD = d; best = z; }
  }
  return best;
}

function viewWelcome() {
  $view.innerHTML = `
  <section class="card">
    <h2>Bienvenue</h2>
    <p>Dot estime, quartier par quartier, s'il y a le courant maintenant et le risque de coupure dans les prochaines heures, en croisant les téléphones de la communauté, vos signalements, les annonces officielles et la météo.</p>
    <p><b>Où habitez-vous ?</b></p>
    ${zonePicker(null)}
    <p><button id="locate">Trouver mon quartier (position utilisée seulement sur ce téléphone)</button></p>
  </section>`;
  bindZoneSelect();
  document.getElementById('locate').onclick = () => {
    navigator.geolocation?.getCurrentPosition(
      (pos) => {
        const z = nearestZone(pos.coords.latitude, pos.coords.longitude);
        store.set('home', z.id);
        toast(`Quartier choisi : ${z.name}`);
        route();
      },
      () => toast('Position indisponible, choisissez dans la liste.'),
      { timeout: 10000, maximumAge: 600000 },
    );
  };
}

function bindZoneSelect() {
  const sel = document.getElementById('zone-select');
  sel.onchange = () => {
    if (!sel.value) return;
    store.set('home', sel.value);
    location.hash = '#accueil';
    route();
  };
}

function headline(n) {
  if (n.pOut >= 0.6) return 'Coupure probable';
  if (n.pOut >= 0.3) return 'Situation incertaine';
  return 'Courant probablement présent';
}

async function viewZone(zoneId, isHome) {
  const zone = zoneById(zoneId);
  if (!zone) return viewWelcome();
  $view.innerHTML = '<div class="skeleton"></div>';
  let d;
  try {
    d = await api(`/api/zone/${zoneId}`);
    store.set(`cache.${zoneId}`, d);
  } catch {
    d = store.get(`cache.${zoneId}`);
    if (!d) { $view.innerHTML = '<section class="card">Impossible de charger les données. Vérifiez votre connexion.</section>'; return; }
    toast('Hors ligne : dernières données connues.');
  }
  const n = d.nowcast;
  const lv = level(n.pOut);
  const arrival = store.get('arrival', '19:00');
  const arrivalT = nextLocal(arrival);
  const pArr = probAt(d.forecast, arrivalT);
  const since = d.currentOutageSince ? `Coupé depuis ${duration(d.at - d.currentOutageSince)} (durée moyenne ici : ${duration(d.meanOutageHours * 3600000)}).` : '';
  const sensorSupported = 'getBattery' in navigator;

  $view.innerHTML = `
  <section class="card status ${lv}">
    <div class="row spread"><span class="zone">${esc(zone.name)}, ${esc(zone.city)}${isHome ? ' · chez moi' : ''}</span><span class="chip">confiance ${esc(n.confidence)}</span></div>
    <div class="headline">${headline(n)}</div>
    <div class="big-pct">Chance d'avoir le courant maintenant : <b>${pct(1 - n.pOut)}</b></div>
    ${since ? `<p class="muted">${since}</p>` : ''}
    ${n.evidence.length ? `<ul class="reasons">${n.evidence.slice(0, 5).map((e) => `<li><span class="arrow ${e.logLR > 0 ? 'up' : 'down'}" title="${e.logLR > 0 ? 'pousse vers coupure' : 'pousse vers courant'}">${e.logLR > 0 ? '↑' : '↓'}</span><span>${esc(e.label)}</span></li>`).join('')}</ul>`
      : '<p class="muted">Aucun signal récent dans ce quartier : estimation basée sur l\'historique des coupures à cette heure-ci.</p>'}
  </section>

  <section class="card">
    <h2>Je serai à la maison à</h2>
    <div class="row"><input type="time" id="arrival" value="${esc(arrival)}" aria-label="Heure d'arrivée"><span id="arrival-out" class="big-pct">${pArr === null ? 'Au-delà de 24 h : pas de prévision.' : `<b>${pct(1 - pArr)}</b> de chances d'avoir le courant (${localDay(arrivalT)} ${localTime(arrivalT)})`}</span></div>
  </section>

  <section class="card">
    <h2>24 prochaines heures</h2>
    ${chart(d.forecast, arrivalT)}
  </section>

  <section class="card">
    <h2>À prévoir</h2>
    <ul class="windows">
      ${d.planned.map((p) => `<li>📢 <b>Coupure annoncée</b> ${localDay(p.start)} ${localTime(p.start)}–${localTime(p.end)}${p.note ? ` · ${esc(p.note)}` : ''} <span class="muted">(cette source tient parole ${pct(p.reliability)} du temps)</span></li>`).join('')}
      ${d.riskWindows.map((w) => `<li>⚠️ Risque de coupure <b>${localTime(w.start)}–${localTime(w.end)}</b> (${pct(w.meanPOut)} en moyenne)</li>`).join('')}
      ${d.safeWindows.slice(0, 3).map((w) => `<li>🔋 Créneau sûr pour recharger / repasser : <b>${localTime(w.start)}–${localTime(w.end)}</b></li>`).join('')}
      ${!d.planned.length && !d.riskWindows.length && !d.safeWindows.length ? '<li class="muted">Pas de créneau franchement sûr ni risqué dans les 24 h.</li>' : ''}
    </ul>
  </section>

  <section class="card">
    <h2>Ce que je constate ${isHome ? 'chez moi' : `à ${esc(zone.name)}`}</h2>
    <div class="actions">
      <button class="cut" data-report="out">Le courant est coupé</button>
      <button class="back" data-report="on">Le courant est là</button>
      <select id="incident" class="wide" aria-label="Signaler un incident">
        <option value="">Signaler un incident…</option>
        ${Object.entries(meta.incidents).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}
      </select>
    </div>
    <p class="muted">Chaque signalement est comparé aux autres sources. Les signalements justes donnent plus de poids à votre voix, les faux la font disparaître.</p>
  </section>

  ${isHome ? `<section class="card">
    <h2>Mon téléphone comme capteur</h2>
    <label class="switch"><input type="checkbox" id="sensor" ${store.get('sensor') ? 'checked' : ''} ${sensorSupported ? '' : 'disabled'}>
      <span>Quand mon téléphone est en charge et que la charge s'arrête, prévenir Dot automatiquement.
      <span class="muted">${sensorSupported ? "Fonctionne tant que l'appli est ouverte. Plus il y a de téléphones dans un quartier, plus la détection est rapide et sûre. Seul le quartier est envoyé." : "Votre navigateur ne donne pas accès à l'état de charge (Chrome sur Android le permet)."}</span></span>
    </label>
  </section>
  <section class="card"><h2>Mon quartier</h2>${zonePicker(zoneId)}</section>`
    : `<section class="card"><button class="primary" id="set-home">Définir ${esc(zone.name)} comme chez moi</button></section>`}
  `;

  document.getElementById('arrival').onchange = (e) => {
    store.set('arrival', e.target.value || '19:00');
    viewZone(zoneId, isHome);
  };
  $view.querySelectorAll('[data-report]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        const r = await post('/api/report', { zoneId, state: b.dataset.report });
        toast(r.queued ? 'Hors ligne : envoi dès le retour du réseau.' : 'Merci ! Signalement pris en compte.');
        if (!r.queued) setTimeout(() => viewZone(zoneId, isHome), 400);
      } catch (err) {
        toast(err.message);
      } finally {
        b.disabled = false;
      }
    };
  });
  document.getElementById('incident').onchange = async (e) => {
    if (!e.target.value) return;
    try {
      const r = await post('/api/incident', { zoneId, incident: e.target.value });
      toast(r.queued ? 'Hors ligne : envoi dès le retour du réseau.' : 'Incident signalé, merci.');
      if (!r.queued) setTimeout(() => viewZone(zoneId, isHome), 400);
    } catch (err) {
      toast(err.message);
    }
  };
  const sensorBox = document.getElementById('sensor');
  if (sensorBox) {
    sensorBox.onchange = async () => {
      store.set('sensor', sensorBox.checked);
      if (sensorBox.checked) {
        const ok = await sensor.start();
        toast(ok ? 'Capteur activé. Branchez votre téléphone pour qu\'il serve.' : 'Capteur indisponible sur ce navigateur.');
      }
    };
    bindZoneSelect();
  }
  document.getElementById('set-home')?.addEventListener('click', () => {
    store.set('home', zoneId);
    location.hash = '#accueil';
  });
}

async function viewCarte() {
  const city = store.get('city', zoneById(store.get('home'))?.city ?? meta.cities[0]);
  $view.innerHTML = '<div class="skeleton"></div>';
  let s;
  try { s = await api(`/api/status?city=${encodeURIComponent(city)}`); } catch { $view.innerHTML = '<section class="card">Données indisponibles hors ligne.</section>'; return; }
  const zones = meta.zones.filter((z) => z.city === city);
  const byId = Object.fromEntries(s.zones.map((x) => [x.zoneId, x]));
  const lats = zones.map((z) => z.lat), lons = zones.map((z) => z.lon);
  const [la0, la1, lo0, lo1] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
  const W = 600, H = 360, P = 40;
  const sx = (lon) => P + ((lon - lo0) / (lo1 - lo0 || 1)) * (W - 2 * P);
  const sy = (lat) => H - P - ((lat - la0) / (la1 - la0 || 1)) * (H - 2 * P);
  const color = (p) => `var(--${level(p)})`;
  const sorted = zones.slice().sort((a, b) => byId[b.id].pOut - byId[a.id].pOut);
  $view.innerHTML = `
  <div class="seg">${meta.cities.map((c) => `<button data-city="${esc(c)}" aria-pressed="${c === city}">${esc(c)}</button>`).join('')}</div>
  <section class="card">
    <h2>${esc(city)} maintenant</h2>
    <svg class="map" viewBox="0 0 ${W} ${H}" role="img" aria-label="Carte schématique des quartiers">
      ${zones.map((z) => {
        const st = byId[z.id];
        return `<a href="#zone-${z.id}"><circle cx="${sx(z.lon)}" cy="${sy(z.lat)}" r="16" fill="${color(st.pOut)}" opacity="${st.confidence === 'faible' ? 0.45 : 0.95}"><title>${esc(z.name)} : ${pct(1 - st.pOut)} de courant</title></circle>
        <text x="${sx(z.lon)}" y="${sy(z.lat) + 30}" text-anchor="middle">${esc(z.name)}</text></a>`;
      }).join('')}
    </svg>
    <div class="legend"><span><i style="background:var(--on)"></i>Courant</span><span><i style="background:var(--mid)"></i>Incertain</span><span><i style="background:var(--out)"></i>Coupure</span><span>Pâle = peu de données</span></div>
  </section>
  <section class="card">
    <ul class="zones">${sorted.map((z) => {
      const st = byId[z.id];
      return `<li><span class="dot ${level(st.pOut)}"></span><a href="#zone-${z.id}">${esc(z.name)}<span class="reason">${esc(st.since ? `Coupé depuis ${duration(s.at - st.since)}` : st.topReason ?? 'Pas de signal récent')}</span></a><span class="pct">${pct(1 - st.pOut)}</span></li>`;
    }).join('')}</ul>
    <p class="muted">Pourcentage = chance d'avoir le courant. Carte schématique (positions approximatives).</p>
  </section>`;
  $view.querySelectorAll('[data-city]').forEach((b) => (b.onclick = () => { store.set('city', b.dataset.city); viewCarte(); }));
}

async function viewBilan() {
  const city = store.get('city', zoneById(store.get('home'))?.city ?? meta.cities[0]);
  const period = store.get('period', 'year');
  $view.innerHTML = '<div class="skeleton"></div>';
  let b;
  try { b = await api(`/api/bilan?city=${encodeURIComponent(city)}&period=${period}`); } catch { $view.innerHTML = '<section class="card">Données indisponibles hors ligne.</section>'; return; }
  const max = Math.max(1, ...b.zones.map((z) => z.hoursOut));
  const home = store.get('home');
  const mine = b.zones.find((z) => z.zoneId === home);
  const periods = { month: 'Ce mois', year: 'Cette année', all: 'Depuis le début' };
  $view.innerHTML = `
  <div class="seg">${meta.cities.map((c) => `<button data-city="${esc(c)}" aria-pressed="${c === city}">${esc(c)}</button>`).join('')}</div>
  <div class="seg">${Object.entries(periods).map(([k, v]) => `<button data-period="${k}" aria-pressed="${k === period}">${v}</button>`).join('')}</div>
  ${mine ? `<section class="card"><h2>Chez moi · ${esc(mine.name)}</h2><div class="kpis">
    <div class="kpi"><b>${Math.round(mine.hoursOut)} h</b><span>sans courant</span></div>
    <div class="kpi"><b>${mine.outages}</b><span>coupures</span></div>
    <div class="kpi"><b>${mine.availability === null ? '—' : pct(mine.availability)}</b><span>du temps avec courant</span></div>
    <div class="kpi"><b>${mine.longestHours.toFixed(1)} h</b><span>plus longue coupure</span></div>
  </div></section>` : ''}
  <section class="card">
    <h2>${esc(city)} · ${periods[period]}</h2>
    <p class="muted">Période observée : ${Math.round(b.periodHours / 24)} jours. Moyenne : ${Math.round(b.averageHoursOut)} h de coupure par quartier.</p>
    <table><thead><tr><th>Quartier</th><th class="num">Heures coupées</th><th class="num">Coupures</th><th class="num">Courant</th></tr></thead><tbody>
    ${b.zones.map((z) => `<tr><td>${esc(z.name)}<div class="bar" style="width:${(z.hoursOut / max) * 100}%"></div></td><td class="num">${Math.round(z.hoursOut)}</td><td class="num">${z.outages}</td><td class="num">${z.availability === null ? '—' : pct(z.availability)}</td></tr>`).join('')}
    </tbody></table>
  </section>`;
  $view.querySelectorAll('[data-city]').forEach((x) => (x.onclick = () => { store.set('city', x.dataset.city); viewBilan(); }));
  $view.querySelectorAll('[data-period]').forEach((x) => (x.onclick = () => { store.set('period', x.dataset.period); viewBilan(); }));
}

async function viewFiabilite() {
  $view.innerHTML = '<div class="skeleton"></div>';
  let r;
  try { r = await api('/api/reliability'); } catch { $view.innerHTML = '<section class="card">Données indisponibles hors ligne.</section>'; return; }
  const W = 300, H = 200, P = 28;
  const sx = (v) => P + v * (W - P - 8);
  const sy = (v) => H - P - v * (H - P - 8);
  const pts = r.buckets.filter((b) => b.n >= 5);
  const diagram = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Diagramme de fiabilité">
    <line x1="${sx(0)}" y1="${sy(0)}" x2="${sx(1)}" y2="${sy(1)}" stroke="var(--line)" stroke-dasharray="4 4"/>
    <line x1="${sx(0)}" y1="${sy(0)}" x2="${sx(1)}" y2="${sy(0)}" stroke="var(--line)"/>
    <line x1="${sx(0)}" y1="${sy(0)}" x2="${sx(0)}" y2="${sy(1)}" stroke="var(--line)"/>
    ${pts.map((b) => `<circle cx="${sx(b.meanP)}" cy="${sy(b.observed)}" r="${Math.min(9, 3 + Math.log10(b.n) * 2)}" fill="var(--accent)"><title>Annoncé ${pct(b.meanP)}, observé ${pct(b.observed)} (${b.n})</title></circle>`).join('')}
    <text x="${W / 2}" y="${H - 6}" text-anchor="middle">probabilité annoncée</text>
    <text x="10" y="${H / 2}" transform="rotate(-90 10 ${H / 2})" text-anchor="middle">fréquence observée</text>
  </svg>`;
  $view.innerHTML = `
  <section class="card">
    <h2>Nos prévisions sont-elles justes ?</h2>
    <p>Chaque prévision (dans 1 h, 3 h, 6 h) est enregistrée puis comparée à ce qui s'est réellement passé. Si Dot annonce 70 %, la coupure doit arriver environ 7 fois sur 10.</p>
    <div class="kpis">
      <div class="kpi"><b>${r.n}</b><span>prévisions vérifiées (90 j)</span></div>
      ${r.byHorizon.map((h) => `<div class="kpi"><b>${h.brier === null ? '—' : h.brier.toFixed(3)}</b><span>score de Brier à ${h.horizonH} h (0 = parfait)</span></div>`).join('')}
    </div>
    ${pts.length ? diagram + '<p class="muted">Points proches de la diagonale = prévisions bien calibrées.</p>' : '<p class="muted">Pas encore assez de prévisions vérifiées : il faut des signaux réels dans les quartiers pour juger.</p>'}
  </section>
  <section class="card">
    <h2>Les sources</h2>
    <div class="kpis">
      <div class="kpi"><b>${r.sources.total}</b><span>appareils contributeurs</span></div>
      <div class="kpi"><b>${r.sources.judged}</b><span>déjà évalués</span></div>
      <div class="kpi"><b>${r.sources.trusted}</b><span>très fiables (≥ 80 %)</span></div>
      <div class="kpi"><b>${r.sources.distrusted}</b><span>sans influence (peu fiables)</span></div>
    </div>
    ${r.officialSources.length ? `<p>Annonces officielles :</p><ul>${r.officialSources.map((s) => `<li>${esc(s.id.replace('official:', '').toUpperCase())} : annonces suivies d'une vraie coupure <b>${pct(s.reliability)}</b> du temps (${s.judgements} vérifiée(s))</li>`).join('')}</ul>` : ''}
  </section>
  <section class="card">
    <h2>Comment ça marche</h2>
    <details><summary>Les signaux utilisés</summary>
      <ul>
        <li><b>Téléphones capteurs</b> : quand plusieurs téléphones du même quartier arrêtent de charger à la même minute, c'est une coupure (un seul téléphone peut juste être débranché).</li>
        <li><b>Signalements</b> « coupé / revenu » et <b>incidents</b> (transformateur en feu, poteau tombé…) : un incident fait monter le risque avant même la coupure.</li>
        <li><b>Annonces officielles</b> de coupures programmées.</li>
        <li><b>Historique</b> : heures et jours à risque de chaque quartier.</li>
        <li><b>Météo</b> : orages et fortes pluies.</li>
        <li><b>Quartiers voisins</b> et du même départ électrique.</li>
      </ul>
    </details>
    <details><summary>Pourquoi on peut nous faire confiance</summary>
      <p>Comme sur un marché de prédiction, chaque source a un historique : on la compare aux autres sources (sans elle), et son poids monte ou descend selon sa justesse. Personne ne peut fausser la carte avec de faux comptes : un compte nouveau pèse peu, et cent comptes ne valent pas cent fois un. Même les annonces officielles sont notées.</p>
    </details>
  </section>`;
}

// ---------- Routage
function setTab(tab) {
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
}

async function route() {
  // Routes en simple #nom (compatibles avec les liens partagés) : #carte, #bilan, #fiabilite, #zone-<id>.
  const h = location.hash.replace(/^#\/?/, '');
  const home = store.get('home');
  const zoneMatch = h.match(/^zone[-/]([a-z0-9-]+)$/);
  if (zoneMatch) { setTab('carte'); return viewZone(zoneMatch[1], zoneMatch[1] === home); }
  if (h === 'carte') { setTab('carte'); return viewCarte(); }
  if (h === 'bilan') { setTab('bilan'); return viewBilan(); }
  if (h === 'fiabilite') { setTab('fiabilite'); return viewFiabilite(); }
  setTab('home');
  return home ? viewZone(home, true) : viewWelcome();
}

async function init() {
  updateNet();
  try {
    meta = await api('/api/zones');
    store.set('meta', meta);
  } catch {
    meta = store.get('meta');
    if (!meta) { $view.innerHTML = '<section class="card">Connexion nécessaire au premier lancement.</section>'; return; }
  }
  document.getElementById('demo').hidden = !meta.demo;
  addEventListener('hashchange', route);
  await route();
  flushQueue();
  if (store.get('sensor')) sensor.start();
  // Rafraîchissement discret quand l'écran est visible.
  setInterval(() => { if (document.visibilityState === 'visible' && !document.activeElement?.matches('input,select')) route(); }, 120000);
  if (!window.DOT_DEMO && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

init();
