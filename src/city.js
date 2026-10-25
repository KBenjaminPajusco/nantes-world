import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { toon, rng } from './toon.js?v=20261025160413';

// La ville : OpenStreetMap (data/nantes.json, mètres locaux, x = est, z = sud) transformé en décor cel shading.
// Les bâtiments sont fusionnés par tuiles (le frustum culling reste efficace), le reste par couche.

export const PAL = {
  ground: '#efe8d4',
  water: '#4aa8d8',
  waterEdge: '#2f86bd',
  park: '#a3d67e', wood: '#74b45e', pitch: '#c9dd8d',
  roads: ['#c4cad4', '#d2d7df', '#e0e3e8', '#e8e9ec', '#f6f0dc', '#f2e7c6'],
  tram: '#8d93a0', rail: '#6f7482',
  walls: ['#f4eedc', '#efe3c8', '#f2dccc', '#e9ecee', '#f0e8d0'],
  roofs: ['#53607a', '#4a566d', '#5c6a85', '#a0553f', '#47536a'],
  church: '#ece3cc', churchRoof: '#6d7a93', castle: '#f4ead2', industrial: '#c9ced6', industrialRoof: '#98a1af',
  outline: '#1d2533',
};
const ROAD_W = [13, 9, 6, 3.6, 5.5, 1.8];
const TILE = 320;

const c3 = (hex) => new THREE.Color(hex);
const shade = (hex, k) => c3(hex).multiplyScalar(k);

function ring(a) { // [x,z,x,z,…] en dm -> [{x,y}] en m, y = z (pour Shape après rotation)
  const out = [];
  for (let i = 0; i < a.length; i += 2) out.push(new THREE.Vector2(a[i] / 10, a[i + 1] / 10));
  return out;
}

function paint(geo, color) {
  const n = geo.attributes.position.count, col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = color.r; col[i * 3 + 1] = color.g; col[i * 3 + 2] = color.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

// Polygone plat (avec trous) à la hauteur y. Le contour est donné en (x, z) ; on triangule en 2D puis on remet à plat.
function flatPoly(outer, holes, y) {
  const o = ring(outer), hs = holes.map(ring);
  const faces = THREE.ShapeUtils.triangulateShape(o, hs);
  const pts = o.concat(...hs);
  const pos = new Float32Array(pts.length * 3);
  pts.forEach((p, i) => { pos[i * 3] = p.x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = p.y; });
  const idx = [];
  for (const [a, b, c] of faces) {
    // (b-a)x(c-a).y = (b.z-a.z)(c.x-a.x) - (b.x-a.x)(c.z-a.z) ; > 0 = face vers le haut
    const up = (pts[b].y - pts[a].y) * (pts[c].x - pts[a].x) - (pts[b].x - pts[a].x) * (pts[c].y - pts[a].y) > 0;
    idx.push(a, up ? b : c, up ? c : b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function ribbon(list, width, y) {
  // Ruban le long de chaque polyligne (joints en moyenne des normales, bornés).
  const pos = [], idx = [];
  for (const pl of list) {
    const p = pl.p, n = p.length / 2;
    if (n < 2) continue;
    const base = pos.length / 3;
    for (let i = 0; i < n; i++) {
      const x = p[i * 2] / 10, z = p[i * 2 + 1] / 10;
      const ax = i > 0 ? x - p[(i - 1) * 2] / 10 : p[2] / 10 - x, az = i > 0 ? z - p[(i - 1) * 2 + 1] / 10 : p[3] / 10 - z;
      const bx = i < n - 1 ? p[(i + 1) * 2] / 10 - x : ax, bz = i < n - 1 ? p[(i + 1) * 2 + 1] / 10 - z : az;
      const la = Math.hypot(ax, az) || 1, lb = Math.hypot(bx, bz) || 1;
      let nx = -(az / la) - (bz / lb), nz = ax / la + bx / lb;
      const ln = Math.hypot(nx, nz) || 1;
      nx /= ln; nz /= ln;
      const dot = Math.max(nx * (-az / la) + nz * (ax / la), 0.55); // limite le miter
      const w = (pl.w ?? width) / 2 / dot;
      const yy = y + (pl.y ?? 0);
      pos.push(x + nx * w, yy, z + nz * w, x - nx * w, yy, z - nz * w);
    }
    for (let i = 0; i < n - 1; i++) {
      const a = base + i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // Les triangles peuvent sortir à l'envers selon le sens de la ligne : on force les normales vers le haut.
  const nrm = g.attributes.normal;
  for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, 0, 1, 0);
  return g;
}

function mesh(geo, color, { shadow = false, receive = true, offset = 0, order = 0, vertexColors = false } = {}) {
  const m = toon(vertexColors ? '#ffffff' : color, {
    side: THREE.DoubleSide, vertexColors,
    polygonOffset: offset !== 0, polygonOffsetFactor: -offset, polygonOffsetUnits: -offset,
  });
  const o = new THREE.Mesh(geo, m);
  o.receiveShadow = receive;
  o.castShadow = shadow;
  o.renderOrder = order;
  return o;
}

// --- Bâtiments : murs (normales plates) + toit plat de couleur ardoise, par tuiles.
function buildingGeometry(b, R) {
  const pts = ring(b.p), h = b.h / 10;
  const n = pts.length;
  let wallC, roofC;
  if (b.k === 1) { wallC = c3(PAL.church); roofC = c3(PAL.churchRoof); }
  else if (b.k === 2) { wallC = c3(PAL.castle); roofC = c3(PAL.churchRoof); }
  else if (b.k === 3) { wallC = c3(PAL.industrial); roofC = c3(PAL.industrialRoof); }
  else { wallC = c3(PAL.walls[b.c % PAL.walls.length]); roofC = c3(PAL.roofs[(b.c * 3 + (R() < 0.15 ? 3 : 0)) % PAL.roofs.length]); }
  wallC.multiplyScalar(0.94 + R() * 0.1);
  const pos = [], col = [], nor = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i], c = pts[(i + 1) % n];
    // Anneau d'aire positive dans (x, z) : la normale sortante est (dz, -dx).
    pos.push(a.x, 0, a.y, c.x, h, c.y, c.x, 0, c.y, a.x, 0, a.y, a.x, h, a.y, c.x, h, c.y);
    const l = Math.hypot(c.x - a.x, c.y - a.y) || 1, nx = (c.y - a.y) / l, nz = -(c.x - a.x) / l;
    for (let k = 0; k < 6; k++) { col.push(wallC.r, wallC.g, wallC.b); nor.push(nx, 0, nz); }
  }
  const roof = THREE.ShapeUtils.triangulateShape(pts.slice(), []);
  for (const [a, b2, c] of roof) {
    const up = (pts[b2].y - pts[a].y) * (pts[c].x - pts[a].x) - (pts[b2].x - pts[a].x) * (pts[c].y - pts[a].y) > 0;
    for (const i of up ? [a, b2, c] : [a, c, b2]) { pos.push(pts[i].x, h, pts[i].y); col.push(roofC.r, roofC.g, roofC.b); nor.push(0, 1, 0); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  // Liseré sombre au sommet et au pied du toit.
  const ln = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i], c = pts[(i + 1) % n];
    ln.push(a.x, h + 0.04, a.y, c.x, h + 0.04, c.y);
  }
  return { g, ln };
}

export async function buildCity(scene, data, { mobile = false, onProgress = () => {} } = {}) {
  const R = rng(99);
  const root = new THREE.Group();
  scene.add(root);
  const [bx0, bz0, bx1, bz1] = data.bounds;

  // Sol : très grand (le brouillard cache l'horizon).
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(40000, 40000).rotateX(-Math.PI / 2), toon(PAL.ground));
  ground.receiveShadow = true;
  ground.position.y = -0.05;
  root.add(ground);

  // Espaces verts et eau.
  const parts = { park: [], wood: [], pitch: [] };
  for (const g of data.green) parts[g.k]?.push(paint(flatPoly(g.p, g.h, 0), c3(PAL[g.k])));
  for (const k of Object.keys(parts)) if (parts[k].length) root.add(mesh(mergeGeometries(parts[k]), null, { vertexColors: true, offset: 1 }));
  onProgress(0.1);

  const wg = data.water.map((w) => flatPoly(w.p, w.h, 0.04));
  if (wg.length) {
    const water = mesh(mergeGeometries(wg), PAL.water, { offset: 2, order: 1 });
    water.name = 'water';
    root.add(water);
  }
  const wl = ribbon(data.waterlines.map((w) => ({ p: w.p, w: w.w })), 3, 0.05);
  root.add(mesh(wl, PAL.water, { offset: 2, order: 1 }));
  onProgress(0.2);

  // Routes : une couche par classe, les grandes dessous. Les ponts sont relevés.
  const byClass = [[], [], [], [], [], []];
  const bridges = [];
  for (const r of data.roads) {
    (r.b ? bridges : byClass[r.c]).push(r);
  }
  for (let c = 5; c >= 0; c--) {
    if (!byClass[c].length) continue;
    // Les petits chemins passent au-dessus des grandes routes pour rester visibles.
    const m = mesh(ribbon(byClass[c], ROAD_W[c], 0.1 + (c === 5 ? 0.04 : c === 4 ? 0.03 : (5 - c) * 0.005)), PAL.roads[c], { offset: 3 + (c >= 4 ? 1 : 0) });
    root.add(m);
  }
  if (bridges.length) {
    const bw = bridges.map((r) => ({ p: r.p, w: ROAD_W[r.c] + 1.4, y: 0.5 }));
    root.add(mesh(ribbon(bw, 0, 0.1), '#9aa3b2', { offset: 5, order: 2 }));
    root.add(mesh(ribbon(bridges.map((r) => ({ p: r.p, w: ROAD_W[r.c], y: 0.55 })), 0, 0.12), '#dfe2e8', { offset: 6, order: 3 }));
  }
  const tram = data.rails.filter((r) => r.k === 0), rail = data.rails.filter((r) => r.k === 1);
  if (tram.length) root.add(mesh(ribbon(tram, 2, 0.17), PAL.tram, { offset: 6 }));
  if (rail.length) root.add(mesh(ribbon(rail, 3.2, 0.17), PAL.rail, { offset: 6 }));
  onProgress(0.3);

  // Bâtiments par tuiles.
  const tiles = new Map();
  for (const b of data.buildings) {
    const tx = Math.floor(b.p[0] / 10 / TILE), tz = Math.floor(b.p[1] / 10 / TILE);
    const k = tx + ',' + tz;
    (tiles.get(k) ?? tiles.set(k, []).get(k)).push(b);
  }
  const lineMat = new THREE.LineBasicMaterial({ color: PAL.outline });
  const bodyMat = toon('#ffffff', { vertexColors: true });
  const keys = [...tiles.keys()];
  const buildingMeshes = [];
  for (let i = 0; i < keys.length; i++) {
    const g = [], lines = [];
    for (const b of tiles.get(keys[i])) {
      const r = buildingGeometry(b, R);
      g.push(r.g); lines.push(...r.ln);
    }
    const body = new THREE.Mesh(mergeGeometries(g), bodyMat);
    body.castShadow = !mobile;
    body.receiveShadow = !mobile;
    root.add(body);
    buildingMeshes.push(body);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    root.add(new THREE.LineSegments(lg, lineMat));
    g.forEach((x) => x.dispose());
    if (i % 4 === 3) { onProgress(0.3 + 0.55 * (i / keys.length)); await new Promise((r) => setTimeout(r)); }
  }

  // Arbres : instances (tronc + feuillage).
  const tr = data.trees, step = mobile ? 2 : 1;
  const count = Math.floor(tr.length / 2 / step);
  const crown = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), toon('#ffffff'), count);
  const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.18, 0.25, 1, 5), toon('#8a5f3c'), count);
  crown.castShadow = !mobile;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const greens = ['#6cb35a', '#5fa653', '#7cc062', '#69ae5c'].map(c3);
  for (let i = 0; i < count; i++) {
    const x = tr[i * 2 * step] / 10, z = tr[i * 2 * step + 1] / 10;
    const r = 2.1 + R() * 1.5, h = 4 + R() * 3;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), R() * 6.28);
    m4.compose(p.set(x, h * 0.55 + r * 0.55, z), q, s.set(r, r * 0.9, r));
    crown.setMatrixAt(i, m4);
    crown.setColorAt(i, greens[i % greens.length]);
    m4.compose(p.set(x, h * 0.3, z), q, s.set(1, h * 0.6, 1));
    trunk.setMatrixAt(i, m4);
  }
  root.add(crown, trunk);
  onProgress(0.9);

  // Masque de marche : on rasterise bâtiments / eau / ponts à 2 m. Rouge = bâti, bleu = eau, vert = pont.
  const RES = 2;
  const W = Math.ceil((bx1 - bx0) / RES), H = Math.ceil((bz1 - bz0) / RES);
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const X = (v) => (v - bx0) / RES, Z = (v) => (v - bz0) / RES;
  const path = (a) => { for (let i = 0; i < a.length; i += 2) (i ? cx.lineTo : cx.moveTo).call(cx, X(a[i] / 10), Z(a[i + 1] / 10)); cx.closePath(); };
  cx.fillStyle = '#000'; cx.fillRect(0, 0, W, H);
  cx.fillStyle = '#00f';
  for (const w of data.water) { cx.beginPath(); path(w.p); for (const h of w.h) path(h); cx.fill('evenodd'); }
  cx.strokeStyle = '#00f'; cx.lineJoin = 'round';
  for (const w of data.waterlines) { cx.lineWidth = Math.max(w.w / RES, 1); cx.beginPath(); for (let i = 0; i < w.p.length; i += 2) (i ? cx.lineTo : cx.moveTo).call(cx, X(w.p[i] / 10), Z(w.p[i + 1] / 10)); cx.stroke(); }
  cx.strokeStyle = '#0f0';
  for (const r of bridges) { cx.lineWidth = Math.max(ROAD_W[r.c] / RES, 2); cx.beginPath(); for (let i = 0; i < r.p.length; i += 2) (i ? cx.lineTo : cx.moveTo).call(cx, X(r.p[i] / 10), Z(r.p[i + 1] / 10)); cx.stroke(); }
  cx.fillStyle = '#f00';
  for (const b of data.buildings) { cx.beginPath(); path(b.p); cx.fill(); }
  const px = cx.getImageData(0, 0, W, H).data;
  const at = (x, z) => {
    const i = Math.floor((x - bx0) / RES), j = Math.floor((z - bz0) / RES);
    if (i < 0 || j < 0 || i >= W || j >= H) return 3;
    const o = (j * W + i) * 4, r = px[o], g = px[o + 1], b = px[o + 2];
    if (g > 120) return 2; // pont
    if (r > 120) return 1; // bâti
    if (b > 120) return 4; // eau
    return 0;
  };
  onProgress(1);

  return {
    root, buildingMeshes, ground,
    // Cases franchissables : libre ou pont.
    walkable(x, z, r = 1.2) {
      for (const [dx, dz] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]]) {
        const t = at(x + dx, z + dz);
        if (t === 1 || t === 3 || t === 4) return false;
      }
      return true;
    },
    groundY(x, z) { return at(x, z) === 2 ? 0.55 : 0; },
    kindAt: at,
  };
}
