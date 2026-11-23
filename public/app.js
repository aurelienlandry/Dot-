// Dot — application mobile (PWA). Sans framework, pensée pour les petits forfaits data.
// L'utilisateur ne voit que l'essentiel : courant ou pas, depuis quand, jusqu'à quand, et à son heure d'arrivée.

const $view = document.getElementById('view');
const $sheet = document.getElementById('sheet');
const TZ = 3600_000; // Africa/Douala (UTC+1)
const DEMO = !!window.DOT_DEMO;

// ---------- Stockage local (tout reste sur le téléphone, sauf le pseudo)
// Si le navigateur bloque le stockage (navigation privée, aperçu…), on garde les données en mémoire.
const memory = new Map();
const store = {
  get(k, d = null) {
    try {
      const v = localStorage.getItem(`dot.${k}`);
      if (v !== null) return JSON.parse(v);
    } catch { /* stockage indisponible */ }
    return memory.has(k) ? memory.get(k) : d;
  },
  set(k, v) {
    memory.set(k, v);
    try { localStorage.setItem(`dot.${k}`, JSON.stringify(v)); } catch { /* stockage indisponible */ }
  },
};
let deviceId = store.get('device');
if (!deviceId) {
  deviceId = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
  store.set('device', deviceId);
}
if (window.DOT_DEMO_SEED && store.get('places') === null) {
  store.set('profile', window.DOT_DEMO_SEED.profile);
  store.set('places', window.DOT_DEMO_SEED.places);
}
const places = () => store.get('places', []);
const savePlaces = (list) => store.set('places', list);
const placeById = (id) => places().find((p) => p.id === id);
let meta = null;

// ---------- Utilitaires
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pct = (p) => `${Math.round(p * 100)} %`;
function hhmm(t) {
  const d = new Date(t + TZ);
  const m = d.getUTCMinutes();
  return `${d.getUTCHours()}h${m ? String(m).padStart(2, '0') : ''}`;
}
function dayWord(t) {
  const day = (x) => Math.floor((x + TZ) / 86400000);
  const diff = day(t) - day(Date.now());
  return diff === 0 ? "aujourd'hui" : diff === 1 ? 'demain' : new Date(t).toLocaleDateString('fr-FR', { weekday: 'long', timeZone: 'Africa/Douala' });
}
const when = (t) => (dayWord(t) === "aujourd'hui" ? `à ${hhmm(t)}` : `${dayWord(t)} à ${hhmm(t)}`);
function duration(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 >= 10 ? `${h} h ${String(m % 60).padStart(2, '0')}` : `${h} h`;
}
function nextLocal(hm) {
  const [h, m] = hm.split(':').map(Number);
  const d = new Date(Date.now() + TZ);
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m) - TZ;
  if (t < Date.now() - 5 * 60000) t += 86400000;
  return t;
}
/** « entre 18h et 21h », en précisant « demain » si la plage passe minuit. */
function span(w) {
  const end = dayWord(w.end) !== dayWord(w.start) ? `${hhmm(w.end)} (${dayWord(w.end)})` : hhmm(w.end);
  return `entre <b>${hhmm(w.start)} et ${end}</b>`;
}
function greeting() {
  const h = new Date(Date.now() + TZ).getUTCHours();
  return h < 5 || h >= 18 ? 'Bonsoir' : 'Bonjour';
}
const ICONS = { maison: '🏠', travail: '💼', autre: '📍' };
const DEFAULT_ARRIVAL = { maison: '19:00', travail: '08:00', autre: '12:00' };

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

// ---------- Réseau (file d'attente hors connexion pour les signalements)
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
    if (err.status) throw err;
    store.set('queue', [...store.get('queue', []), { path, payload }].slice(-50));
    return { queued: true };
  }
}
async function flushQueue() {
  const queue = store.get('queue', []);
  if (!queue.length || !navigator.onLine) return;
  const rest = [];
  for (const item of queue) {
    try { await api(item.path, { method: 'POST', body: JSON.stringify(item.payload) }); } catch (err) { if (!err.status) rest.push(item); }
  }
  store.set('queue', rest);
  if (queue.length > rest.length) toast('Vos signalements en attente ont été envoyés.');
}
const updateNet = () => (document.getElementById('net').hidden = navigator.onLine);
addEventListener('online', () => { updateNet(); flushQueue(); });
addEventListener('offline', updateNet);

function myPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Localisation indisponible'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => reject(new Error('Position indisponible. Autorisez la localisation ou placez le point sur la carte.')),
      { timeout: 10000, maximumAge: 120000, enableHighAccuracy: false },
    );
  });
}

// ---------- Capteur automatique : la charge du téléphone et le Wi-Fi de la maison
const sensor = {
  battery: null,
  lastBeat: 0,
  lastType: navigator.connection?.type,
  home() { return places().find((p) => p.type === 'maison'); },
  send(event) {
    const h = this.home();
    if (store.get('sensor') && h) post('/api/device', { lat: h.lat, lon: h.lon, event }).catch(() => {});
  },
  async start() {
    let ok = false;
    if ('getBattery' in navigator) {
      this.battery = this.battery || (await navigator.getBattery());
      if (!this.bBound) {
        this.battery.addEventListener('chargingchange', () => {
          this.send(this.battery.charging ? 'power_back' : 'power_lost');
          if (this.battery.charging) this.lastBeat = Date.now();
        });
        this.bBound = true;
      }
      ok = true;
    }
    if (navigator.connection && 'type' in navigator.connection && !this.cBound) {
      navigator.connection.addEventListener('change', () => {
        const t = navigator.connection.type;
        if (this.lastType === 'wifi' && t === 'cellular') this.send('wifi_lost');
        if (this.lastType === 'cellular' && t === 'wifi') this.send('wifi_back');
        this.lastType = t;
      });
      this.cBound = true;
      ok = true;
    }
    this.beat();
    return ok;
  },
  beat() {
    if (!this.battery?.charging || Date.now() - this.lastBeat < 10 * 60000) return;
    this.lastBeat = Date.now();
    this.send('charging');
  },
};
setInterval(() => { if (document.visibilityState === 'visible') sensor.beat(); }, 60000);

// ---------- Carte (Leaflet + OpenStreetMap)
function makeMap(el, center, zoom = 13) {
  const map = L.map(el, { zoomControl: true, attributionControl: true }).setView([center.lat, center.lon], zoom);
  if (!DEMO) {
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  } else {
    // L'aperçu de démonstration ne peut pas charger les fonds de carte : on affiche les noms des quartiers.
    el.classList.add('no-tiles');
    for (const q of meta.quartiers) L.marker([q.lat, q.lon], { icon: L.divIcon({ className: 'q-label', html: esc(q.name), iconSize: null }), interactive: false }).addTo(map);
  }
  return map;
}
const cityCenter = (name) => meta.cities.find((c) => c.name === name) ?? meta.cities[0];
function nearestCity(lat, lon) {
  return meta.cities.reduce((best, c) => ((c.lat - lat) ** 2 + (c.lon - lon) ** 2 < (best.lat - lat) ** 2 + (best.lon - lon) ** 2 ? c : best)).name;
}

// ---------- Lecture de l'état d'un lieu, en mots simples
function status(d) {
  if (d.pOut >= 0.6) return { cls: 'out', word: 'Coupure', icon: '✕' };
  if (d.pOut >= 0.3) return { cls: 'mid', word: 'Risque de coupure', icon: '!' };
  return { cls: 'on', word: 'Courant', icon: '⚡' };
}
function mainLine(d) {
  if (d.pOut >= 0.6) {
    const parts = [];
    if (d.since) parts.push(`Depuis ${duration(d.at - d.since)}`);
    parts.push(d.likelyRestore ? `retour probable ${when(d.likelyRestore)}` : 'retour incertain');
    return parts.join(' · ');
  }
  const planned = d.planned[0];
  if (planned) return `Coupure annoncée ${dayWord(planned.start)} ${hhmm(planned.start)}–${hhmm(planned.end)}`;
  const risk = d.riskWindows[0];
  if (risk) return `Risque de coupure ${when(risk.start)}`;
  return d.summary;
}
function probAt(points, t) {
  if (!points.length || t < points[0].at || t > points[points.length - 1].at) return null;
  for (let i = 1; i < points.length; i++) {
    if (t <= points[i].at) {
      const a = points[i - 1];
      const b = points[i];
      return a.pOut + ((t - a.at) / (b.at - a.at)) * (b.pOut - a.pOut);
    }
  }
  return null;
}
function arrivalLine(place, d) {
  const t = nextLocal(place.arrival ?? DEFAULT_ARRIVAL[place.type] ?? '19:00');
  const p = probAt(d.forecast, t);
  if (p === null) return '';
  return `${dayWord(t) === "aujourd'hui" ? 'À' : 'Demain à'} ${hhmm(t)} : <b>${pct(1 - p)}</b> de chances d'avoir le courant`;
}

/** Bande des 24 prochaines heures : une case par heure, verte / orange / rouge. */
function strip(d, arrival) {
  const hours = [];
  for (let i = 0; i < 24; i++) {
    const t0 = d.at + i * 3600000;
    const pts = d.forecast.filter((p) => p.at >= t0 && p.at < t0 + 3600000);
    hours.push({ t0, p: pts.length ? Math.max(...pts.map((x) => x.pOut)) : 0 });
  }
  const hourOf = (t) => new Date(t + TZ).getUTCHours();
  const label = (t, i) => (i === 0 ? 'Maint.' : hourOf(t) % 3 === 0 ? `${hourOf(t)}h` : '');
  return `<div class="strip" role="img" aria-label="Prévision heure par heure">
    ${hours.map((h, i) => `<div class="hr ${h.p >= 0.6 ? 'out' : h.p >= 0.3 ? 'mid' : 'on'}${arrival && arrival >= h.t0 && arrival < h.t0 + 3600000 ? ' arr' : ''}" title="${hhmm(h.t0)} : ${pct(1 - h.p)} de courant"><i></i><span>${label(h.t0, i)}</span></div>`).join('')}
  </div>
  <div class="legend"><span><i class="sw on"></i>Courant</span><span><i class="sw mid"></i>Risque</span><span><i class="sw out"></i>Coupure</span>${arrival ? '<span><i class="sw arr"></i>Votre arrivée</span>' : ''}</div>`;
}

// ---------- Écrans
function setTab(tab) {
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  document.getElementById('fab').hidden = !places().length || tab === 'onboarding';
  document.getElementById('tabs').hidden = tab === 'onboarding';
}

/** Choisir un lieu sur la carte (inscription et ajout de lieu). */
function placePicker({ title, intro, type, onDone, cancel }) {
  const start = places()[0] ?? cityCenter('Douala');
  $view.innerHTML = `
  <section class="card">
    <h1>${esc(title)}</h1>
    ${intro ? `<p class="muted">${intro}</p>` : ''}
    <div class="chips" role="radiogroup" aria-label="Type de lieu">
      ${Object.entries({ maison: 'Maison', travail: 'Travail', autre: 'Autre' }).map(([k, v]) => `<button type="button" class="chip-btn" data-type="${k}" aria-pressed="${k === type}">${ICONS[k]} ${v}</button>`).join('')}
    </div>
    <label class="field">Nom du lieu<input id="pname" maxlength="30" value="${esc({ maison: 'Maison', travail: 'Travail', autre: '' }[type])}" placeholder="Ex. : Chez maman"></label>
    <p class="muted">Touchez la carte à l'endroit exact, ou utilisez votre position.</p>
    <div class="row"><button type="button" id="gps">📍 Ma position actuelle</button>
      <select id="city" aria-label="Ville">${meta.cities.map((c) => `<option ${c.name === nearestCity(start.lat, start.lon) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
    <div id="pickmap" class="map"></div>
    <p id="picked" class="muted">Aucun point choisi.</p>
    <div class="row">${cancel ? '<button type="button" id="cancel">Annuler</button>' : ''}<button class="primary grow" id="save" disabled>Enregistrer ce lieu</button></div>
  </section>`;
  let chosen = null;
  let kind = type;
  const map = makeMap(document.getElementById('pickmap'), start, places().length ? 15 : 13);
  let marker = null;
  const choose = (lat, lon, zoom) => {
    chosen = { lat, lon };
    if (marker) marker.setLatLng([lat, lon]);
    else marker = L.circleMarker([lat, lon], { radius: 10, color: '#1d4ed8', weight: 3, fillOpacity: 0.6 }).addTo(map);
    if (zoom) map.setView([lat, lon], 16);
    document.getElementById('picked').textContent = 'Point choisi. Touchez ailleurs pour le déplacer.';
    document.getElementById('save').disabled = false;
  };
  map.on('click', (e) => choose(e.latlng.lat, e.latlng.lng));
  document.getElementById('city').onchange = (e) => {
    const c = cityCenter(e.target.value);
    map.setView([c.lat, c.lon], 13);
  };
  document.getElementById('gps').onclick = async () => {
    try {
      const p = await myPosition();
      choose(p.lat, p.lon, true);
    } catch (err) {
      toast(err.message);
    }
  };
  $view.querySelectorAll('[data-type]').forEach((b) => (b.onclick = () => {
    kind = b.dataset.type;
    $view.querySelectorAll('[data-type]').forEach((x) => x.setAttribute('aria-pressed', x === b));
    const n = document.getElementById('pname');
    if (!n.value || ['Maison', 'Travail'].includes(n.value)) n.value = { maison: 'Maison', travail: 'Travail', autre: '' }[kind];
  }));
  document.getElementById('cancel')?.addEventListener('click', cancel);
  document.getElementById('save').onclick = () => {
    const name = document.getElementById('pname').value.trim() || 'Mon lieu';
    onDone({ id: `p${Date.now().toString(36)}`, type: kind, name, lat: chosen.lat, lon: chosen.lon, arrival: DEFAULT_ARRIVAL[kind] });
  };
  setTimeout(() => map.invalidateSize(), 50);
}

function viewOnboarding(step = store.get('profile')?.pseudo ? 2 : 1) {
  setTab('onboarding');
  if (step === 1) {
    $view.innerHTML = `
    <section class="card hero">
      <h1>Savoir s'il y a le courant, avant d'arriver.</h1>
      <p>Dot vous dit s'il y a le courant chez vous, quand il reviendra, et vous prévient des coupures annoncées.</p>
      <label class="field">Votre pseudo<input id="pseudo" maxlength="24" placeholder="Ex. : Aurel237" autocomplete="nickname"></label>
      <p class="muted">Seul ce pseudo est enregistré. Pas de nom, pas de numéro, pas d'e-mail.</p>
      <button class="primary wide" id="next">Continuer</button>
    </section>`;
    document.getElementById('next').onclick = () => {
      const pseudo = document.getElementById('pseudo').value.trim();
      if (pseudo.length < 2) return toast('Choisissez un pseudo de 2 caractères minimum.');
      store.set('profile', { pseudo });
      post('/api/profile', { pseudo }).catch(() => {});
      viewOnboarding(2);
    };
    return;
  }
  placePicker({
    title: 'Où est votre maison ?',
    intro: 'Le lieu reste sur votre téléphone. Pour les signalements, seule une position approximative (à ~100 m près) est envoyée.',
    type: 'maison',
    onDone: (p) => {
      savePlaces([p]);
      toast('Maison enregistrée.');
      location.hash = '#accueil';
      route();
    },
  });
}

async function loadPlace(p) {
  try {
    const d = await api(`/api/place?lat=${p.lat}&lon=${p.lon}`);
    store.set(`cache.${p.id}`, d);
    return d;
  } catch {
    return store.get(`cache.${p.id}`);
  }
}

function placeCard(p, d, big = false) {
  const s = status(d);
  return `<div class="row spread"><span class="pname">${ICONS[p.type] ?? '📍'} ${esc(p.name)}</span><span class="where">${esc(d.name)}</span></div>
    <div class="state"><span class="badge ${s.cls}" aria-hidden="true">${s.icon}</span>${s.word}</div>
    <div class="line">${esc(mainLine(d))}</div>
    ${!big && arrivalLine(p, d) ? `<div class="arrival">${arrivalLine(p, d)}</div>` : ''}`;
}

async function viewAccueil() {
  setTab('accueil');
  const list = places();
  const pseudo = store.get('profile')?.pseudo;
  $view.innerHTML = `<h1 class="hello">${greeting()}${pseudo ? ` ${esc(pseudo)}` : ''}</h1>
    ${list.map((p) => `<a class="card place" id="card-${p.id}" href="#lieu-${p.id}"><div class="skeleton-line"></div></a>`).join('')}
    <button class="add" id="add">+ Ajouter un lieu (travail, famille…)</button>`;
  document.getElementById('add').onclick = () => (location.hash = '#ajout');
  await Promise.all(list.map(async (p) => {
    const d = await loadPlace(p);
    const el = document.getElementById(`card-${p.id}`);
    if (!el) return;
    if (!d) {
      el.innerHTML = '<p class="muted">Données indisponibles hors ligne.</p>';
      return;
    }
    el.className = `card place ${status(d).cls}`;
    el.innerHTML = placeCard(p, d);
  }));
}

async function viewLieu(id) {
  setTab('accueil');
  const p = placeById(id);
  if (!p) {
    location.hash = '#accueil';
    return;
  }
  $view.innerHTML = '<div class="card skeleton"></div>';
  const d = await loadPlace(p);
  if (!d) {
    $view.innerHTML = '<section class="card">Données indisponibles hors ligne.</section>';
    return;
  }
  const arrivalT = nextLocal(p.arrival ?? DEFAULT_ARRIVAL[p.type]);
  const upcoming = [
    ...d.planned.map((x) => ({ t: x.start, html: `📢 <b>Coupure annoncée</b> ${dayWord(x.start)} ${hhmm(x.start)}–${hhmm(x.end)}${x.note ? ` <span class="muted">(${esc(x.note)})</span>` : ''}` })),
    ...d.riskWindows
      .filter((w) => !(d.pOut >= 0.6 && w.start <= d.at + 600000)) // la coupure en cours est déjà affichée en haut
      .filter((w) => !d.planned.some((x) => Math.abs(x.start - w.start) < 3600000))
      .map((w) => ({ t: w.start, html: `⚠️ Risque de coupure ${dayWord(w.start)} ${span(w)}` })),
    ...d.safeWindows.slice(0, 2).map((w) => ({ t: w.start, html: `🔋 Bon moment pour recharger, repasser, pomper l'eau : ${span(w)}` })),
  ].sort((a, b) => a.t - b.t);
  $view.innerHTML = `
  <a class="back" href="#accueil">‹ Mes lieux</a>
  <section class="card place big ${status(d).cls}">${placeCard(p, d, true)}</section>
  <section class="card">
    <h2>J'arrive à</h2>
    <div class="row"><input type="time" id="arrival" value="${esc(p.arrival ?? DEFAULT_ARRIVAL[p.type])}" aria-label="Heure d'arrivée"><span class="arrival">${arrivalLine(p, d) || 'Au-delà de 24 h, pas de prévision.'}</span></div>
  </section>
  <section class="card">
    <h2>Prochaines 24 heures</h2>
    ${strip(d, arrivalT)}
  </section>
  ${upcoming.length ? `<section class="card"><h2>À prévoir</h2><ul class="plain">${upcoming.map((u) => `<li>${u.html}</li>`).join('')}</ul></section>` : ''}
  <section class="card">
    <h2>Ici, ces 30 derniers jours</h2>
    <div class="kpis"><div class="kpi"><b>${Math.round(d.month.hoursOut)} h</b><span>sans courant</span></div><div class="kpi"><b>${d.month.outages}</b><span>coupures</span></div></div>
  </section>
  <section class="card">
    <h2>Vous y êtes ?</h2>
    <div class="actions"><button class="cut" data-report="out">Le courant est coupé</button><button class="ok" data-report="on">Le courant est là</button></div>
  </section>
  <div class="row center"><button class="link" id="del">Supprimer ce lieu</button></div>`;
  document.getElementById('arrival').onchange = (e) => {
    savePlaces(places().map((x) => (x.id === id ? { ...x, arrival: e.target.value || DEFAULT_ARRIVAL[x.type] } : x)));
    viewLieu(id);
  };
  $view.querySelectorAll('[data-report]').forEach((b) => (b.onclick = () => report({ lat: p.lat, lon: p.lon }, b.dataset.report, () => viewLieu(id))));
  const del = document.getElementById('del');
  del.onclick = () => {
    if (del.dataset.sure !== '1') {
      del.dataset.sure = '1';
      del.textContent = 'Toucher encore pour confirmer la suppression';
      return;
    }
    savePlaces(places().filter((x) => x.id !== id));
    location.hash = '#accueil';
  };
}

async function report(pos, state, then) {
  try {
    const r = await post('/api/report', { lat: pos.lat, lon: pos.lon, state });
    toast(r.queued ? 'Pas de réseau : envoi automatique dès son retour.' : 'Merci ! Votre signalement aide vos voisins.');
    if (!r.queued && then) setTimeout(then, 300);
  } catch (err) {
    toast(err.message);
  }
}

/** Fenêtre « Signaler » : où, et quoi. */
function openSheet() {
  const list = places();
  $sheet.hidden = false;
  $sheet.innerHTML = `<div class="sheet-card" role="dialog" aria-modal="true" aria-label="Signaler">
    <div class="row spread"><h2>Signaler</h2><button class="link" id="close">Fermer</button></div>
    <p class="muted">Où ?</p>
    <div class="chips">${list.map((p, i) => `<button class="chip-btn" data-where="${p.id}" aria-pressed="${i === 0}">${ICONS[p.type] ?? '📍'} ${esc(p.name)}</button>`).join('')}<button class="chip-btn" data-where="gps" aria-pressed="false">📍 Ici (ma position)</button></div>
    <div class="actions"><button class="cut" data-s="out">Le courant est coupé</button><button class="ok" data-s="on">Le courant est revenu</button></div>
    <p class="muted">Un incident ?</p>
    <div class="incidents">${Object.entries(meta.incidents).map(([k, v]) => `<button data-inc="${k}">${esc(v)}</button>`).join('')}</div>
  </div>`;
  let where = list[0]?.id ?? 'gps';
  const close = () => {
    $sheet.hidden = true;
    $sheet.innerHTML = '';
  };
  $sheet.onclick = (e) => { if (e.target === $sheet) close(); };
  document.getElementById('close').onclick = close;
  $sheet.querySelectorAll('[data-where]').forEach((b) => (b.onclick = () => {
    where = b.dataset.where;
    $sheet.querySelectorAll('[data-where]').forEach((x) => x.setAttribute('aria-pressed', x === b));
  }));
  const resolvePos = async () => (where === 'gps' ? myPosition() : placeById(where));
  $sheet.querySelectorAll('[data-s]').forEach((b) => (b.onclick = async () => {
    try {
      const pos = await resolvePos();
      close();
      report(pos, b.dataset.s, route);
    } catch (err) {
      toast(err.message);
    }
  }));
  $sheet.querySelectorAll('[data-inc]').forEach((b) => (b.onclick = async () => {
    try {
      const pos = await resolvePos();
      close();
      const r = await post('/api/incident', { lat: pos.lat, lon: pos.lon, incident: b.dataset.inc });
      toast(r.queued ? 'Pas de réseau : envoi automatique dès son retour.' : 'Incident signalé. Merci !');
      route();
    } catch (err) {
      toast(err.message);
    }
  }));
}
document.getElementById('fab').onclick = openSheet;

async function viewCarte() {
  setTab('carte');
  const home = places()[0];
  const city = store.get('city') ?? (home ? nearestCity(home.lat, home.lon) : meta.cities[0].name);
  $view.innerHTML = `
  <div class="seg">${meta.cities.map((c) => `<button data-city="${esc(c.name)}" aria-pressed="${c.name === city}">${esc(c.name)}</button>`).join('')}</div>
  <div id="bigmap" class="map tall"></div>
  <div class="legend"><span><i class="sw out"></i>Coupure</span><span><i class="sw mid"></i>Risque</span><span><i class="sw plan"></i>Coupure annoncée</span><span><i class="sw me"></i>Mes lieux</span></div>
  <section class="card" id="maplist"><p class="muted">Chargement…</p></section>`;
  $view.querySelectorAll('[data-city]').forEach((b) => (b.onclick = () => { store.set('city', b.dataset.city); viewCarte(); }));
  const center = home && nearestCity(home.lat, home.lon) === city ? home : cityCenter(city);
  const map = makeMap(document.getElementById('bigmap'), center, 13);
  setTimeout(() => map.invalidateSize(), 50);
  let m;
  try {
    m = await api(`/api/map?city=${encodeURIComponent(city)}`);
  } catch {
    document.getElementById('maplist').innerHTML = '<p class="muted">Carte indisponible hors ligne.</p>';
    return;
  }
  const css = getComputedStyle(document.documentElement);
  const color = (v) => css.getPropertyValue(v).trim();
  for (const a of m.planned) L.circle([a.lat, a.lon], { radius: a.radiusM, color: color('--accent'), dashArray: '6 6', weight: 2, fillOpacity: 0.06 }).addTo(map).bindPopup(`<b>Coupure annoncée</b><br>${esc(a.label)}<br>${dayWord(a.start)} ${hhmm(a.start)}–${hhmm(a.end)}`);
  for (const a of m.risks) L.circle([a.lat, a.lon], { radius: a.radiusM, color: color('--mid'), weight: 1, fillOpacity: 0.25 }).addTo(map).bindPopup(`<b>Risque de coupure</b><br>${esc(a.name)}`);
  for (const a of m.outages) L.circle([a.lat, a.lon], { radius: a.radiusM, color: color('--out'), weight: 2, fillOpacity: 0.3 }).addTo(map).bindPopup(`<b>Coupure</b><br>${esc(a.name)}<br>Sur environ ${a.radiusM} m autour`);
  for (const p of places()) L.circleMarker([p.lat, p.lon], { radius: 7, color: '#ffffff', weight: 2, fillColor: color('--accent'), fillOpacity: 1 }).addTo(map).bindTooltip(esc(p.name));
  const items = [
    ...m.outages.map((a) => `<li><span class="dot out"></span><span><b>Coupure</b> · ${esc(a.name)} <span class="muted">(environ ${a.radiusM} m autour)</span></span></li>`),
    ...m.risks.map((a) => `<li><span class="dot mid"></span><span><b>Risque</b> · ${esc(a.name)}</span></li>`),
    ...m.planned.map((a) => `<li><span class="dot plan"></span><span><b>Annoncée</b> · ${esc(a.label)} <span class="muted">${dayWord(a.start)} ${hhmm(a.start)}–${hhmm(a.end)}</span></span></li>`),
  ];
  document.getElementById('maplist').innerHTML = items.length ? `<h2>En ce moment à ${esc(city)}</h2><ul class="plain dots">${items.join('')}</ul>` : `<p>Aucune coupure signalée à ${esc(city)} en ce moment.</p>`;
}

async function viewBilan() {
  setTab('bilan');
  const period = store.get('period', 'month');
  const periods = { month: 'Ce mois', year: 'Cette année' };
  const list = places();
  const city = list[0] ? nearestCity(list[0].lat, list[0].lon) : meta.cities[0].name;
  $view.innerHTML = `<div class="seg">${Object.entries(periods).map(([k, v]) => `<button data-period="${k}" aria-pressed="${k === period}">${v}</button>`).join('')}</div><div id="bl"><div class="card skeleton"></div></div>`;
  $view.querySelectorAll('[data-period]').forEach((b) => (b.onclick = () => { store.set('period', b.dataset.period); viewBilan(); }));
  try {
    const [mine, cityB] = await Promise.all([
      Promise.all(list.map((p) => api(`/api/history?lat=${p.lat}&lon=${p.lon}&period=${period}`))),
      api(`/api/bilan?city=${encodeURIComponent(city)}&period=${period}`),
    ]);
    const max = Math.max(1, ...cityB.zones.map((z) => z.hoursOut));
    document.getElementById('bl').innerHTML = `
      ${list.map((p, i) => `<section class="card"><h2>${ICONS[p.type] ?? '📍'} ${esc(p.name)} · ${periods[period].toLowerCase()}</h2>
        <div class="kpis">
          <div class="kpi"><b>${Math.round(mine[i].hoursOut)} h</b><span>sans courant</span></div>
          <div class="kpi"><b>${mine[i].outages}</b><span>coupures</span></div>
          <div class="kpi"><b>${mine[i].availability === null ? '—' : pct(mine[i].availability)}</b><span>du temps avec courant</span></div>
          <div class="kpi"><b>${mine[i].longestHours.toFixed(0)} h</b><span>plus longue coupure</span></div>
        </div></section>`).join('')}
      <section class="card"><h2>Les quartiers de ${esc(city)}</h2>
        <p class="muted">Heures sans courant, ${periods[period].toLowerCase()}. Moyenne : ${Math.round(cityB.averageHoursOut)} h.</p>
        <ul class="bars">${cityB.zones.map((z) => `<li><span class="bname">${esc(z.name)}</span><span class="btrack"><span style="width:${(z.hoursOut / max) * 100}%"></span></span><span class="bval">${Math.round(z.hoursOut)} h</span></li>`).join('')}</ul>
      </section>`;
  } catch {
    document.getElementById('bl').innerHTML = '<section class="card">Bilan indisponible hors ligne.</section>';
  }
}

async function viewProfil() {
  setTab('profil');
  const profile = store.get('profile', {});
  const sensorOk = 'getBattery' in navigator || (navigator.connection && 'type' in navigator.connection);
  $view.innerHTML = `
  <section class="card">
    <h2>Mon profil</h2>
    <label class="field">Pseudo<span class="row"><input id="pseudo" maxlength="24" value="${esc(profile.pseudo ?? '')}"><button id="savep">Enregistrer</button></span></label>
    <div class="kpis" id="contrib"><div class="kpi"><b>…</b><span>signalements</span></div></div>
  </section>
  <section class="card">
    <h2>Mes lieux</h2>
    <ul class="plain">${places().map((p) => `<li><a href="#lieu-${p.id}">${ICONS[p.type] ?? '📍'} ${esc(p.name)}</a></li>`).join('')}</ul>
    <button class="add" id="addp">+ Ajouter un lieu</button>
  </section>
  <section class="card">
    <h2>Détection automatique</h2>
    <label class="switch"><input type="checkbox" id="sensor" ${store.get('sensor') ? 'checked' : ''} ${sensorOk ? '' : 'disabled'}>
      <span>Aider à détecter les coupures chez moi, sans rien faire.
      <span class="muted">${sensorOk ? "Quand votre téléphone arrête de charger ou perd le Wi-Fi de la maison, Dot le note. Plus il y a de voisins qui l'activent, plus l'info est rapide et sûre." : 'Votre navigateur ne le permet pas (fonctionne avec Chrome sur Android).'}</span></span>
    </label>
  </section>
  <section class="card">
    <h2>Vie privée</h2>
    <p class="muted">Vos lieux restent sur ce téléphone. Les signalements sont envoyés avec une position arrondie à ~100 m. Aucun nom, numéro ou e-mail n'est demandé.</p>
  </section>`;
  document.getElementById('addp').onclick = () => (location.hash = '#ajout');
  document.getElementById('savep').onclick = async () => {
    const pseudo = document.getElementById('pseudo').value.trim();
    try {
      await post('/api/profile', { pseudo });
      store.set('profile', { ...profile, pseudo });
      toast('Pseudo enregistré.');
    } catch (err) {
      toast(err.message);
    }
  };
  document.getElementById('sensor').onchange = async (e) => {
    store.set('sensor', e.target.checked);
    if (e.target.checked) toast((await sensor.start()) ? 'Merci ! Laissez Dot ouvert pendant que le téléphone charge.' : 'Non disponible sur ce navigateur.');
  };
  try {
    const pr = await api(`/api/profile?deviceId=${deviceId}`);
    document.getElementById('contrib').innerHTML = `<div class="kpi"><b>${pr.contributions}</b><span>signalements envoyés</span></div><div class="kpi"><b>${pr.reliability === null ? '—' : pct(pr.reliability)}</b><span>${pr.reliability === null ? 'de justesse (après 3 signalements vérifiés)' : 'de signalements justes'}</span></div>`;
  } catch {
    /* hors ligne */
  }
}

function viewAjout() {
  setTab('accueil');
  placePicker({
    title: 'Ajouter un lieu',
    type: places().some((p) => p.type === 'maison') ? 'travail' : 'maison',
    cancel: () => (location.hash = '#accueil'),
    onDone: (p) => {
      savePlaces([...places(), p]);
      toast('Lieu ajouté.');
      location.hash = '#accueil';
    },
  });
}

// ---------- Routage (#nom simples)
async function route() {
  const h = location.hash.replace(/^#\/?/, '');
  if (!places().length) return viewOnboarding();
  const lieu = h.match(/^lieu-(.+)$/);
  if (lieu) return viewLieu(lieu[1]);
  if (h === 'carte') return viewCarte();
  if (h === 'bilan') return viewBilan();
  if (h === 'profil') return viewProfil();
  if (h === 'ajout') return viewAjout();
  return viewAccueil();
}

async function init() {
  updateNet();
  try {
    meta = await api('/api/meta');
    store.set('meta', meta);
  } catch {
    meta = store.get('meta');
  }
  if (!meta) {
    $view.innerHTML = '<section class="card">Connexion nécessaire au premier lancement.</section>';
    return;
  }
  document.getElementById('demo').hidden = !meta.demo;
  addEventListener('hashchange', route);
  await route();
  flushQueue();
  if (store.get('sensor')) sensor.start();
  setInterval(() => {
    const h = location.hash.replace(/^#/, '');
    if (document.visibilityState === 'visible' && $sheet.hidden && (h === '' || h === 'accueil' || h.startsWith('lieu-')) && !document.activeElement?.matches('input,select')) route();
  }, 120000);
  if (!DEMO && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

init();
