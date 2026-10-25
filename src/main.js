import * as THREE from 'three';
import { buildCity } from './city.js?v=20261025164024';
import { solid } from './toon.js?v=20261025164024';
import { initFeatures, updateFeatures } from './features/index.js?v=20261025164024';

const $ = (s) => document.querySelector(s);
const clamp = THREE.MathUtils.clamp;
const MOBILE = matchMedia('(max-width: 640px), (pointer: coarse) and (max-width: 950px)').matches;
const V = (document.querySelector('script[src*="main.js"]')?.src.match(/v=(\w+)/) ?? [])[1] ?? Date.now();

// --- Rendu
const canvas = $('#scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, MOBILE ? 1.5 : 2));
renderer.shadowMap.enabled = !MOBILE;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const SKY = '#a8c4d8';
const scene = new THREE.Scene();
scene.background = new THREE.Color(SKY);
const camera = new THREE.PerspectiveCamera(30, 1, 3, 9000);
scene.add(new THREE.HemisphereLight('#e8f0ff', '#7d7a66', 1.15));
const sun = new THREE.DirectionalLight('#ffeccc', 2.1);
sun.castShadow = !MOBILE;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -150, right: 150, top: 150, bottom: -150, near: 10, far: 700 });
sun.shadow.bias = -0.0006;
scene.add(sun, sun.target);

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// --- Projection lat/lon <-> mètres locaux (identique à tools/build_data.py)
const LAT0 = 47.2132, LON0 = -1.5559;
const KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KZ = 110574;
const toXZ = (lat, lon) => ({ x: (lon - LON0) * KX, z: -(lat - LAT0) * KZ });
const toLL = (x, z) => ({ lat: LAT0 - z / KZ, lon: LON0 + x / KX });

// --- Planeur : un petit avion en papier qu'on pilote au-dessus de la ville.
class Glider {
  constructor() {
    const wings = new THREE.BufferGeometry();
    wings.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 3, -2.4, 0.2, -1.8, 0, 0, -0.9, 0, 0, 3, 0, 0, -0.9, 2.4, 0.2, -1.8], 3));
    wings.computeVertexNormals();
    const keel = new THREE.BufferGeometry();
    keel.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 3, 0, 0, -0.9, 0, -0.95, -1.3], 3));
    keel.computeVertexNormals();
    this.root = new THREE.Group();
    this.body = new THREE.Group();
    this.root.add(this.body);
    for (const m of [solid(wings, '#ff6a4d', { outlineWidth: 0.07 }), solid(keel, '#fbf7ec', { outlineWidth: 0.06 })]) {
      m.material = m.material.clone();
      m.material.side = THREE.DoubleSide;
      this.body.add(m);
    }
    this.body.scale.setScalar(2.8);
    this.pos = new THREE.Vector2();
    this.vel = new THREE.Vector2();
    this.heading = 0;
    this.bank = 0;
    this.y = 0;
    this.alt = 70; // hauteur de croisière au-dessus du sol / des toits
    this.agl = 0;
    this.goto = null;
  }
  place(x, z, city) {
    this.pos.set(x, z);
    this.vel.set(0, 0);
    this.y = city.surfaceY(x, z) + this.alt;
  }
  update(dt, input, boost, city, bounds) {
    const dir = input.clone();
    if (dir.length() > 0.05) this.goto = null;
    else if (this.goto) {
      const dx = this.goto.x - this.pos.x, dz = this.goto.z - this.pos.y, d = Math.hypot(dx, dz);
      if (d < 12) this.goto = null; else dir.set(dx / d, dz / d).multiplyScalar(Math.min(1, d / 120 + 0.25));
    }
    const base = clamp(55 + this.alt * 0.7, 55, 420) * (boost ? 2.6 : 1);
    const l = Math.min(dir.length(), 1);
    if (l > 0) dir.normalize().multiplyScalar(l * base);
    this.vel.x = THREE.MathUtils.damp(this.vel.x, dir.x, 2.2, dt);
    this.vel.y = THREE.MathUtils.damp(this.vel.y, dir.y, 2.2, dt);
    this.pos.x = clamp(this.pos.x + this.vel.x * dt, bounds[0], bounds[2]);
    this.pos.y = clamp(this.pos.y + this.vel.y * dt, bounds[1], bounds[3]);
    const speed = this.vel.length();
    let err = 0;
    if (speed > 4) {
      const want = Math.atan2(this.vel.x, this.vel.y);
      err = Math.atan2(Math.sin(want - this.heading), Math.cos(want - this.heading));
      this.heading += err * Math.min(1, dt * 5);
    }
    this.bank = THREE.MathUtils.damp(this.bank, clamp(-err * 1.4, -0.8, 0.8) * Math.min(speed / 50, 1), 6, dt);
    // Altitude : au-dessus du point le plus haut (sol ou toit) ici et un peu devant.
    const wantY = Math.max(city.surfaceY(this.pos.x, this.pos.y), city.surfaceY(this.pos.x + this.vel.x * 0.9, this.pos.y + this.vel.y * 0.9)) + this.alt;
    this.y = THREE.MathUtils.damp(this.y, wantY, wantY > this.y ? 3.5 : 1.6, dt);
    this.agl = this.y - city.terrain.h(this.pos.x, this.pos.y);
    const pitch = clamp((wantY - this.y) * 0.04, -0.35, 0.35);
    this.root.position.set(this.pos.x, this.y, this.pos.y);
    this.root.rotation.set(0, this.heading, 0);
    this.body.rotation.set(-pitch, 0, this.bank);
  }
}

// --- Points d'intérêt : data/pois.json (dépôt) + modifications locales (localStorage) exportables.
const STORE = 'nantes-world-pois-v1';
const loadLocal = () => { try { return JSON.parse(localStorage.getItem(STORE)) ?? { upserts: {}, removed: [] }; } catch { return { upserts: {}, removed: [] }; } };
const saveLocal = () => { try { localStorage.setItem(STORE, JSON.stringify(local)); } catch { /* navigation privée */ } };
let local = loadLocal();
let basePois = [];
const pois = new Map(); // id -> { data, group, hit, label }
const labelsEl = $('#labels');
const pinGeo = { ball: new THREE.SphereGeometry(2.6, 14, 10), cone: new THREE.ConeGeometry(2.1, 5.5, 10).rotateX(Math.PI), ring: new THREE.RingGeometry(3.4, 4.6, 28).rotateX(-Math.PI / 2), hit: new THREE.SphereGeometry(6, 8, 6) };
const hitMat = new THREE.MeshBasicMaterial({ visible: false });
const pinMat = (c) => new THREE.MeshToonMaterial({ color: c });
const ringMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.8, side: THREE.DoubleSide });

function mergedPois() {
  const list = basePois.filter((p) => !local.removed.includes(p.id) && !local.upserts[p.id]);
  for (const p of basePois) if (local.upserts[p.id] && !local.removed.includes(p.id)) list.push(local.upserts[p.id]);
  for (const [id, p] of Object.entries(local.upserts)) if (!basePois.some((b) => b.id === id) && !local.removed.includes(id)) list.push(p);
  return list;
}

function makePin(p) {
  const { x, z } = p.lat != null ? toXZ(p.lat, p.lon) : p;
  const g = new THREE.Group();
  const y = city.terrain.h(x, z);
  g.position.set(x, y, z);
  const col = p.color || '#ff6a4d';
  const ball = new THREE.Mesh(pinGeo.ball, pinMat(col)); ball.position.y = 14;
  const cone = new THREE.Mesh(pinGeo.cone, pinMat(col)); cone.position.y = 9.5;
  const ring = new THREE.Mesh(pinGeo.ring, ringMat); ring.position.y = 0.4;
  const hit = new THREE.Mesh(pinGeo.hit, hitMat); hit.position.y = 11; hit.userData.poi = p.id;
  for (const m of [ball, cone]) m.castShadow = !MOBILE;
  g.add(ball, cone, ring, hit);
  scene.add(g);
  const el = document.createElement('button');
  el.className = 'pin';
  el.innerHTML = `<span class="e">${p.emoji || '📍'}</span><span class="t"></span>`;
  el.querySelector('.t').textContent = p.title || '';
  el.addEventListener('click', (ev) => { ev.stopPropagation(); openCard(p.id); });
  labelsEl.appendChild(el);
  return { data: p, group: g, ball, cone, hit, label: el, x, y, z };
}

function syncPois() {
  for (const e of pois.values()) { scene.remove(e.group); e.label.remove(); }
  pois.clear();
  for (const p of mergedPois()) pois.set(p.id, makePin(p));
}

// --- Fiche d'un point
const card = $('#card');
let openId = null, dismissed = null;
function openCard(id) {
  const e = pois.get(id);
  if (!e) return;
  openId = id;
  const p = e.data;
  card.querySelector('.kicker').textContent = (p.emoji || '📍') + (p.by ? ` · ${p.by}` : '');
  card.querySelector('h2').textContent = p.title || '';
  card.querySelector('.body').textContent = p.text || '';
  const link = card.querySelector('.link');
  link.hidden = !p.url;
  if (p.url) { link.href = p.url; link.textContent = p.urlLabel || 'Ouvrir le lien'; }
  card.querySelector('.edit').hidden = !editMode;
  card.hidden = false;
}
function closeCard() { card.hidden = true; dismissed = openId; openId = null; }
card.querySelector('.close').addEventListener('click', closeCard);
card.querySelector('.edit').addEventListener('click', () => openEditor(pois.get(openId).data));

// --- Éditeur de points
let editMode = false;
const ed = $('#editor');
let editing = null; // poi en cours (existant) ou { x, z } nouveau
const val = (n) => ed.querySelector(`[name=${n}]`);
function setEdit(on) {
  editMode = on;
  $('#btn-edit').classList.toggle('on', on);
  document.body.classList.toggle('editing', on);
  $('#hint').textContent = on ? 'Mode placement : clique sur la carte pour poser un point, sur un point pour le modifier.' : '';
  $('#hint').hidden = !on;
  $('#export').hidden = !on;
  if (!on) ed.hidden = true;
}
function openEditor(p) {
  editing = p;
  const isNew = p.id == null;
  val('emoji').value = p.emoji || '📍';
  val('title').value = p.title || '';
  val('text').value = p.text || '';
  val('by').value = p.by || localStorage.getItem('nantes-world-by') || '';
  val('color').value = p.color || '#ff6a4d';
  ed.querySelector('.del').hidden = isNew;
  ed.querySelector('h3').textContent = isNew ? 'Nouveau point' : 'Modifier le point';
  card.hidden = true;
  ed.hidden = false;
  val('title').focus();
}
ed.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const data = {
    id: editing.id ?? 'p' + Date.now().toString(36),
    emoji: val('emoji').value.trim() || '📍', title: val('title').value.trim(), text: val('text').value.trim(),
    by: val('by').value.trim(), color: val('color').value,
  };
  try { localStorage.setItem('nantes-world-by', data.by); } catch { /* ok */ }
  if (editing.id != null) {
    const old = pois.get(editing.id).data;
    if (old.lat != null) { data.lat = old.lat; data.lon = old.lon; } else { data.x = old.x; data.z = old.z; }
    if (old.url) { data.url = old.url; data.urlLabel = old.urlLabel; }
  } else {
    const ll = toLL(editing.x, editing.z);
    data.lat = +ll.lat.toFixed(6); data.lon = +ll.lon.toFixed(6);
  }
  local.upserts[data.id] = data;
  local.removed = local.removed.filter((i) => i !== data.id);
  saveLocal(); syncPois(); ed.hidden = true; openCard(data.id);
});
ed.querySelector('.del').addEventListener('click', () => {
  if (!confirm('Supprimer ce point ?')) return;
  delete local.upserts[editing.id];
  if (basePois.some((b) => b.id === editing.id)) local.removed.push(editing.id);
  saveLocal(); syncPois(); ed.hidden = true;
});
ed.querySelector('.cancel').addEventListener('click', () => { ed.hidden = true; });
$('#export').addEventListener('click', async () => {
  const json = JSON.stringify({ pois: mergedPois().map((p) => { const { x, z, ...r } = p; return p.lat != null ? r : p; }) }, null, 2);
  try { await navigator.clipboard.writeText(json); $('#hint').textContent = 'pois.json copié : colle-le dans data/pois.json (ou envoie-le à Benjamin).'; }
  catch { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' })); a.download = 'pois.json'; a.click(); }
});
$('#btn-edit').addEventListener('click', () => setEdit(!editMode));

// --- Caméra, commandes
const cam = { az: 0.55, el: 0.4, dist: 190 };
const target = new THREE.Vector3();
const keys = new Set();
let started = false;
addEventListener('keydown', (e) => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
  const k = e.key.toLowerCase();
  if (k === 'v') return toggleAlt();
  if (k === 'p') return setEdit(!editMode);
  if (k === 'escape') { closeCard(); ed.hidden = true; return; }
  keys.add(k);
  if (e.key.startsWith('Arrow') || k === ' ') e.preventDefault();
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => keys.clear());

function toggleAlt() {
  const high = walker.alt < 200;
  walker.alt = high ? 380 : 60;
  $('#btn-sky').classList.toggle('on', high);
  if (high) cam.dist = Math.max(cam.dist, 260);
}
$('#btn-sky').addEventListener('click', toggleAlt);

// Pointeur : glisser = tourner / incliner, clic = toucher un point ou un lieu, molette / pincement = zoom.
const ptrs = new Map();
let moved = 0, pinch = 0;
canvas.addEventListener('pointerdown', (e) => {
  if (!started) return;
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  canvas.setPointerCapture(e.pointerId);
  moved = 0;
  if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); } else pinch = 0;
});
canvas.addEventListener('pointermove', (e) => {
  const p = ptrs.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX; p.y = e.clientY;
  if (ptrs.size === 2) {
    const [a, b] = [...ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinch) cam.dist = clamp(cam.dist * pinch / d, 35, 2600);
    pinch = d; moved = 99;
  } else {
    moved += Math.abs(dx) + Math.abs(dy);
    cam.az -= dx * 0.006;
    cam.el = clamp(cam.el + dy * 0.004, 0.2, 1.5);
  }
});
canvas.addEventListener('pointerup', (e) => {
  const had = ptrs.delete(e.pointerId);
  if (had && moved < 6 && ptrs.size === 0) onClick(e);
});
canvas.addEventListener('pointercancel', (e) => ptrs.delete(e.pointerId));
canvas.addEventListener('wheel', (e) => { e.preventDefault(); cam.dist = clamp(cam.dist * Math.exp(e.deltaY * 0.0012), 35, 2600); }, { passive: false });

const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
// Point du sol visé par un rayon : on avance pas à pas jusqu'à passer sous le relief, puis dichotomie.
function pickGround(r) {
  const o = r.origin, d = r.direction;
  const h = (t) => city.terrain.h(o.x + d.x * t, o.z + d.z * t);
  let t = 0;
  while (t < 12000) {
    const step = Math.max(2, t * 0.01);
    t += step;
    const x = o.x + d.x * t, z = o.z + d.z * t;
    if (x < bounds[0] || x > bounds[2] || z < bounds[1] || z > bounds[3]) return null;
    if (o.y + d.y * t < h(t)) {
      let a = t - step, b = t;
      for (let k = 0; k < 8; k++) { const m = (a + b) / 2; if (o.y + d.y * m < h(m)) b = m; else a = m; }
      return new THREE.Vector3(o.x + d.x * b, 0, o.z + d.z * b);
    }
  }
  return null;
}
function onClick(e) {
  ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hits = ray.intersectObjects([...pois.values()].map((p) => p.hit));
  if (hits.length) {
    const id = hits[0].object.userData.poi;
    if (editMode) openEditor(pois.get(id).data); else openCard(id);
    return;
  }
  const pt = pickGround(ray.ray);
  if (!pt) return;
  if (editMode) openEditor({ x: pt.x, z: pt.z });
  else walker.goto = { x: pt.x, z: pt.z }; // clic = y aller en volant
}

// Joystick tactile.
const joy = $('#joy'), knob = joy.querySelector('.joy-knob');
const joyV = new THREE.Vector2();
if (MOBILE) {
  joy.hidden = false;
  let id = null, cx = 0, cy = 0;
  const R = 46;
  joy.addEventListener('pointerdown', (e) => { id = e.pointerId; joy.setPointerCapture(id); const r = joy.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2; move(e); });
  const move = (e) => {
    if (e.pointerId !== id) return;
    const dx = e.clientX - cx, dy = e.clientY - cy, l = Math.hypot(dx, dy) || 1, k = Math.min(l, R) / l;
    knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
    joyV.set(dx * k / R, dy * k / R);
  };
  joy.addEventListener('pointermove', move);
  const end = (e) => { if (e.pointerId !== id) return; id = null; joyV.set(0, 0); knob.style.transform = ''; };
  joy.addEventListener('pointerup', end); joy.addEventListener('pointercancel', end);
}

// --- Démarrage
const walker = new Glider();
scene.add(walker.root);
let city, bounds;

async function boot() {
  const [data, demMeta, demBuf, poiData] = await Promise.all([
    fetch(`data/nantes.json?v=${V}`).then((r) => r.json()),
    fetch(`data/dem.json?v=${V}`).then((r) => r.json()),
    fetch(`data/dem.bin?v=${V}`).then((r) => r.arrayBuffer()),
    fetch(`data/pois.json?v=${V}`).then((r) => r.json()).catch(() => ({ pois: [] })),
  ]);
  bounds = data.bounds;
  basePois = poiData.pois;
  const bar = $('#loading .bar i');
  city = await buildCity(scene, data, { mobile: MOBILE, demMeta, demBuf, onProgress: (f) => { bar.style.width = `${Math.round(f * 100)}%`; } });
  // Point de départ : #lat,lon dans l'adresse, sinon place du Commerce (ou la case libre la plus proche).
  let sx = 0, sz = -30;
  if (basePois[0]?.lat != null) ({ x: sx, z: sz } = toXZ(basePois[0].lat, basePois[0].lon)); // chez nous
  const m = location.hash.match(/(-?\d+\.\d+),\s*(-?\d+\.\d+)/);
  if (m) ({ x: sx, z: sz } = toXZ(+m[1], +m[2]));
  walker.place(sx, sz, city);
  target.set(sx, walker.y, sz);
  city.warm(sx, sz);
  syncPois();
  await initFeatures(featureCtx);
  $('#loading').classList.add('done');
  started = true;
  requestAnimationFrame(frame);
}

// --- Contexte offert aux modules de src/features/
const toastEl = $('#toast');
let toastTimer = 0;
const confetti = [];
const featureCtx = {
  THREE, scene, walker, toXZ, toLL,
  get city() { return city; },
  loadJSON: (path) => fetch(`${path}?v=${V}`).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
  ui: {
    toast(msg) {
      toastEl.textContent = msg; toastEl.hidden = false;
      clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastEl.hidden = true; }, 4200);
    },
    // Gerbe de confettis à (x, z) : de petits cubes qui retombent.
    burst(x, z, color = '#ffc845') {
      const cols = [color, '#ff6a4d', '#4d7cff', '#ffffff', '#2f9e55'];
      for (let i = 0; i < 40; i++) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.12), new THREE.MeshBasicMaterial({ color: cols[i % cols.length] }));
        m.position.set(x, 4, z);
        scene.add(m);
        confetti.push({ m, v: new THREE.Vector3((Math.random() - 0.5) * 16, 12 + Math.random() * 14, (Math.random() - 0.5) * 16), life: 2.2 });
      }
    },
  },
};

const tmp = new THREE.Vector3();
const clock = new THREE.Clock();
let t = 0;
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  t += dt;

  // Déplacement : relatif à la caméra (haut = devant l'écran).
  const k = (a) => (keys.has(a) ? 1 : 0);
  const fx = k('d') + k('arrowright') - k('a') - k('q') - k('arrowleft');
  const fz = k('s') + k('arrowdown') - k('w') - k('z') - k('arrowup');
  const inp = new THREE.Vector2(fx + joyV.x, fz + joyV.y);
  const run = keys.has('shift') || joyV.length() > 0.9;
  const sa = Math.sin(cam.az), ca = Math.cos(cam.az);
  // (x droite écran, z bas écran) -> monde : la caméra regarde vers -z tourné de az.
  const world = new THREE.Vector2(inp.x * ca + inp.y * sa, -inp.x * sa + inp.y * ca);
  const up = k(' ') + k('r') - k('c') - k('f');
  if (up) walker.alt = clamp(walker.alt * Math.exp(up * dt * 1.3), 18, 700);
  walker.update(dt, world, run, city, bounds);
  target.lerp(walker.root.position, 1 - Math.exp(-dt * 7));

  city.updateDetail(walker.pos.x, walker.pos.y, t);
  updateFeatures(featureCtx, dt);
  for (let i = confetti.length - 1; i >= 0; i--) {
    const c = confetti[i];
    c.life -= dt; c.v.y -= 28 * dt;
    c.m.position.addScaledVector(c.v, dt); c.m.rotation.x += dt * 8; c.m.rotation.y += dt * 6;
    if (c.life <= 0 || c.m.position.y < 0) { scene.remove(c.m); c.m.geometry.dispose(); c.m.material.dispose(); confetti.splice(i, 1); }
  }

  // Caméra orbitale.
  const ce = Math.cos(cam.el), se = Math.sin(cam.el);
  camera.position.set(target.x + Math.sin(cam.az) * ce * cam.dist, target.y + se * cam.dist, target.z + Math.cos(cam.az) * ce * cam.dist);
  const floor = city.surfaceY(camera.position.x, camera.position.z) + 5;
  if (camera.position.y < floor) camera.position.y = floor;
  camera.lookAt(target);
  sun.position.set(target.x + 220, 340, target.z + 160);
  sun.target.position.copy(target);

  // Points : flottement, taille lisible de loin, proximité = ouverture de la fiche.
  let near = null, nd = 1e9;
  for (const [id, e] of pois) {
    const d = Math.hypot(e.x - walker.pos.x, e.z - walker.pos.y);
    if (d < nd) { nd = d; near = id; }
    const sc = clamp(camera.position.distanceTo(e.group.position) / 160, 1, 6);
    e.group.scale.setScalar(sc);
    const bob = Math.sin(t * 2 + e.x * 0.01) * 0.6;
    e.ball.position.y = (14 + bob) ;
    e.cone.position.y = 9.5 + bob;
    e.group.children[2].rotation.y = t;
    tmp.set(e.x, e.y + 16 * sc, e.z).project(camera);
    const vis = tmp.z < 1 && Math.abs(tmp.x) < 1.15 && Math.abs(tmp.y) < 1.15;
    e.label.style.display = vis ? '' : 'none';
    if (vis) {
      e.label.style.transform = `translate(-50%, -100%) translate(${(tmp.x * 0.5 + 0.5) * innerWidth}px, ${(-tmp.y * 0.5 + 0.5) * innerHeight}px)`;
      e.label.classList.toggle('far', camera.position.distanceTo(e.group.position) > 700 && id !== openId);
    }
  }
  if (!editMode && near && nd < 40 && ed.hidden) { if (openId !== near && dismissed !== near) openCard(near); }
  if (nd > 80) dismissed = null;
  if (openId && nd > 110 && ed.hidden && !editMode) closeCard();

  $('#coords').textContent = (() => { const p = { x: walker.pos.x, z: walker.pos.y }; const l = toLL(p.x, p.z); return `${l.lat.toFixed(5)}, ${l.lon.toFixed(5)}`; })();
  renderer.render(scene, camera);
}

boot().catch((err) => { console.error(err); $('#loading .msg').textContent = 'Erreur de chargement : ' + err.message; });
