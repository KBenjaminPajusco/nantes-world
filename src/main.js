import * as THREE from 'three';
import { buildCity } from './city.js?v=20261025160413';
import { person } from './characters.js?v=20261025160413';

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

const SKY = '#cfe7f6';
const scene = new THREE.Scene();
scene.background = new THREE.Color(SKY);
scene.fog = new THREE.Fog(SKY, 1100, 4200);
const camera = new THREE.PerspectiveCamera(30, 1, 3, 9000);
scene.add(new THREE.HemisphereLight('#ffffff', '#b9c9b0', 1.5));
const sun = new THREE.DirectionalLight('#fff3dc', 2.3);
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

// --- Marcheur
class Walker {
  constructor() {
    this.root = person({ shirt: '#ff6a4d', pants: '#26324a', skin: '#f2c9a0', hair: '#3a2618' });
    this.root.scale.setScalar(2.2);
    // Silhouette visible à travers les bâtiments (dessinée après le décor, avant le personnage).
    const xray = new THREE.MeshBasicMaterial({ color: '#ff6a4d', depthWrite: false, depthFunc: THREE.GreaterDepth });
    const meshes = [];
    this.root.traverse((o) => { if (o.isMesh && !(o.material instanceof THREE.ShaderMaterial)) meshes.push(o); });
    this.root.traverse((o) => { if (o.isMesh && o.material instanceof THREE.ShaderMaterial) o.renderOrder = 13; });
    for (const m of meshes) {
      m.renderOrder = 12;
      const ghost = new THREE.Mesh(m.geometry, xray);
      ghost.renderOrder = 11;
      m.add(ghost);
    }
    this.pos = new THREE.Vector2();
    this.heading = Math.PI;
    this.speed = 0;
    this.y = 0;
    this.phase = 0;
  }
  place(x, z, city) {
    this.pos.set(x, z);
    this.y = city.groundY(x, z);
    this.speed = 0;
  }
  update(dt, move, run, city, bounds) {
    const len = Math.min(move.length(), 1);
    this.speed = THREE.MathUtils.damp(this.speed, len * (run ? 42 : 15), 10, dt);
    if (len > 0.05) {
      const want = Math.atan2(move.x, move.y);
      const err = Math.atan2(Math.sin(want - this.heading), Math.cos(want - this.heading));
      this.heading += err * Math.min(1, dt * 12);
    }
    const step = new THREE.Vector2(Math.sin(this.heading), Math.cos(this.heading)).multiplyScalar(this.speed * dt);
    for (const s of [step, new THREE.Vector2(step.x, 0), new THREE.Vector2(0, step.y)]) {
      const nx = this.pos.x + s.x, nz = this.pos.y + s.y;
      if (nx > bounds[0] && nx < bounds[2] && nz > bounds[1] && nz < bounds[3] && city.walkable(nx, nz, 1.3)) { this.pos.set(nx, nz); break; }
    }
    this.y = THREE.MathUtils.damp(this.y, city.groundY(this.pos.x, this.pos.y), 12, dt);
    this.phase += dt * this.speed * 0.6;
    const swing = Math.min(this.speed / 15, 1);
    const { legs, arms } = this.root.userData;
    legs.forEach((l, i) => { l.rotation.x = Math.sin(this.phase + i * Math.PI) * 0.8 * swing; });
    arms.forEach((a, i) => { a.rotation.x = -Math.sin(this.phase + i * Math.PI) * 0.7 * swing; });
    this.root.position.set(this.pos.x, this.y + Math.abs(Math.sin(this.phase)) * 0.3 * swing, this.pos.y);
    this.root.rotation.y = this.heading;
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
  g.position.set(x, 0, z);
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
  return { data: p, group: g, ball, cone, hit, label: el, x, z };
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
const cam = { az: 0.55, el: 0.82, dist: 150 };
const target = new THREE.Vector3();
let skyMode = false;
const keys = new Set();
let started = false;
addEventListener('keydown', (e) => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
  const k = e.key.toLowerCase();
  if (k === 'v') return setSky(!skyMode);
  if (k === 'p') return setEdit(!editMode);
  if (k === 'escape') { closeCard(); ed.hidden = true; return; }
  keys.add(k);
  if (e.key.startsWith('Arrow') || k === ' ') e.preventDefault();
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => keys.clear());

function setSky(on) {
  skyMode = on;
  $('#btn-sky').classList.toggle('on', on);
  if (on) { cam.dist = Math.max(cam.dist, 900); cam.el = Math.max(cam.el, 1.0); } else { cam.dist = 150; cam.el = 0.82; target.set(walker.pos.x, 0, walker.pos.y); }
}
$('#btn-sky').addEventListener('click', () => setSky(!skyMode));

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
const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
function onClick(e) {
  ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hits = ray.intersectObjects([...pois.values()].map((p) => p.hit));
  if (hits.length) {
    const id = hits[0].object.userData.poi;
    if (editMode) openEditor(pois.get(id).data); else openCard(id);
    return;
  }
  const pt = new THREE.Vector3();
  if (!ray.ray.intersectPlane(plane, pt)) return;
  if (editMode) openEditor({ x: pt.x, z: pt.z });
  else if (skyMode && city.walkable(pt.x, pt.z, 1.3)) { walker.place(pt.x, pt.z, city); target.set(pt.x, 0, pt.z); setSky(false); }
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
const walker = new Walker();
scene.add(walker.root);
let city, bounds;

async function boot() {
  const [data, poiData] = await Promise.all([
    fetch(`data/nantes.json?v=${V}`).then((r) => r.json()),
    fetch(`data/pois.json?v=${V}`).then((r) => r.json()).catch(() => ({ pois: [] })),
  ]);
  bounds = data.bounds;
  basePois = poiData.pois;
  const bar = $('#loading .bar i');
  city = await buildCity(scene, data, { mobile: MOBILE, onProgress: (f) => { bar.style.width = `${Math.round(f * 100)}%`; } });
  // Point de départ : #lat,lon dans l'adresse, sinon place du Commerce (ou la case libre la plus proche).
  let sx = 0, sz = -30;
  const m = location.hash.match(/(-?\d+\.\d+),\s*(-?\d+\.\d+)/);
  if (m) ({ x: sx, z: sz } = toXZ(+m[1], +m[2]));
  for (let r = 0; r < 200 && !city.walkable(sx, sz, 1.3); r += 2) {
    const a = r * 2.4; sx += Math.cos(a) * 2; sz += Math.sin(a) * 2;
  }
  walker.place(sx, sz, city);
  target.set(sx, 0, sz);
  syncPois();
  $('#loading').classList.add('done');
  started = true;
  requestAnimationFrame(frame);
}

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
  const run = keys.has('shift') || joyV.length() > 0.85;
  const sa = Math.sin(cam.az), ca = Math.cos(cam.az);
  // (x droite écran, z bas écran) -> monde : la caméra regarde vers -z tourné de az.
  const world = new THREE.Vector2(inp.x * ca + inp.y * sa, -inp.x * sa + inp.y * ca);
  if (skyMode) {
    const sp = cam.dist * 0.9 * dt * (run ? 2 : 1);
    target.x = clamp(target.x + world.x * sp, bounds[0], bounds[2]);
    target.z = clamp(target.z + world.y * sp, bounds[1], bounds[3]);
  } else {
    walker.update(dt, world, run, city, bounds);
    target.lerp(tmp.set(walker.pos.x, walker.y + 3, walker.pos.y), 1 - Math.exp(-dt * 8));
  }

  // Caméra orbitale.
  const ce = Math.cos(cam.el), se = Math.sin(cam.el);
  camera.position.set(target.x + Math.sin(cam.az) * ce * cam.dist, target.y + se * cam.dist, target.z + Math.cos(cam.az) * ce * cam.dist);
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
    tmp.set(e.x, 16 * sc, e.z).project(camera);
    const vis = tmp.z < 1 && Math.abs(tmp.x) < 1.15 && Math.abs(tmp.y) < 1.15;
    e.label.style.display = vis ? '' : 'none';
    if (vis) {
      e.label.style.transform = `translate(-50%, -100%) translate(${(tmp.x * 0.5 + 0.5) * innerWidth}px, ${(-tmp.y * 0.5 + 0.5) * innerHeight}px)`;
      e.label.classList.toggle('far', camera.position.distanceTo(e.group.position) > 700 && id !== openId);
    }
  }
  if (!skyMode && !editMode && near && nd < 14 && ed.hidden) { if (openId !== near && dismissed !== near) openCard(near); }
  if (nd > 30) dismissed = null;
  if (!skyMode && openId && nd > 40 && ed.hidden) closeCard();

  $('#coords').textContent = (() => { const p = skyMode ? { x: target.x, z: target.z } : { x: walker.pos.x, z: walker.pos.y }; const l = toLL(p.x, p.z); return `${l.lat.toFixed(5)}, ${l.lon.toFixed(5)}`; })();
  renderer.render(scene, camera);
}

boot().catch((err) => { console.error(err); $('#loading .msg').textContent = 'Erreur de chargement : ' + err.message; });
