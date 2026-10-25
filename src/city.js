import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { toon, rng } from './toon.js?v=20261025163310';

// La ville : OpenStreetMap + relief IGN (data/nantes.json, data/dem.bin), mètres locaux, x = est, z = sud.
// Relief : maillage régulier de 10 m ; routes, parcs, arbres et bâtiments y sont posés.
// Bâtiments fusionnés par tuiles (frustum culling) ; façades détaillées (fenêtres, balcons, plantes) construites
// à la demande autour de la caméra.

export const PAL = {
  // Teintes « vue satellite » : sol minéral, asphalte sombre, Loire verdâtre, ardoise et tuile.
  ground: '#8c8672', slab: '#4d4a3f',
  water: '#34677a',
  park: '#5b8a3c', wood: '#3c6b2e', pitch: '#6f9a45',
  roads: ['#4b4e54', '#575a60', '#64676c', '#74777b', '#b3aa93', '#a79d84'],
  tram: '#8a8d92', rail: '#5b5e66',
  walls: ['#cdbf9e', '#c2b08c', '#d1b9a2', '#b9b5aa', '#c9bc9a'],
  roofs: ['#444c5b', '#3b4351', '#505968', '#94503a', '#7a7f87'],
  church: '#d6c9a8', churchRoof: '#4f586a', castle: '#d9ccab', industrial: '#a6a9ad', industrialRoof: '#7c8088',
  outline: '#161c28',
  glass: ['#2f4a63', '#3a5a73', '#27394d', '#44627a'],
  shutters: ['#4f7a63', '#6b4a3a', '#8a8f98', '#3f5f86', '#7a2f35'],
};
const ROAD_W = [13, 9, 6, 3.6, 5.5, 1.8];
const TILE = 320;
const DETAIL_CELL = 120;

const c3 = (hex) => new THREE.Color(hex);
const lerp = THREE.MathUtils.lerp;

// ---------------------------------------------------------------------------------------------- relief
class Terrain {
  constructor(meta, buf, stride = 1) {
    const raw = new Int16Array(buf);
    const cols = Math.floor((meta.cols - 1) / stride) + 1, rows = Math.floor((meta.rows - 1) / stride) + 1;
    Object.assign(this, { x0: meta.x0, z0: meta.z0, step: meta.step * stride, cols, rows });
    this.d = new Float32Array(cols * rows);
    // Quelques cases de la mesure IGN sont aberrantes (trous) : on borne le relief.
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) this.d[j * cols + i] = Math.max(raw[j * stride * meta.cols + i * stride] / 10, -3);
  }
  // Interpolation sur les mêmes triangles que le maillage (diagonale a-c de chaque case).
  h(x, z) {
    const { step, cols, rows, d } = this;
    let fx = (x - this.x0) / step, fz = (z - this.z0) / step;
    fx = Math.min(Math.max(fx, 0), cols - 1.0001); fz = Math.min(Math.max(fz, 0), rows - 1.0001);
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
    const a = d[j * cols + i], b = d[j * cols + i + 1], c = d[(j + 1) * cols + i + 1], dd = d[(j + 1) * cols + i];
    return u >= v ? a + u * (b - a) + v * (c - b) : a + u * (c - dd) + v * (dd - a);
  }
  normal(x, z, out = new THREE.Vector3()) {
    const e = 3;
    return out.set(this.h(x - e, z) - this.h(x + e, z), 2 * e, this.h(x, z - e) - this.h(x, z + e)).normalize();
  }
}

// Remplit les cases de la grille du relief couvertes par des anneaux (pair/impair) : cb(i, j).
function rasterRings(rings, T, cb) {
  let zmin = Infinity, zmax = -Infinity;
  for (const r of rings) for (let k = 1; k < r.length; k += 2) { zmin = Math.min(zmin, r[k] / 10); zmax = Math.max(zmax, r[k] / 10); }
  const j0 = Math.max(0, Math.ceil((zmin - T.z0) / T.step)), j1 = Math.min(T.rows - 1, Math.floor((zmax - T.z0) / T.step));
  for (let j = j0; j <= j1; j++) {
    const zc = T.z0 + j * T.step, xs = [];
    for (const r of rings) {
      const n = r.length / 2;
      for (let k = 0; k < n; k++) {
        const ax = r[k * 2] / 10, az = r[k * 2 + 1] / 10, bx = r[((k + 1) % n) * 2] / 10, bz = r[((k + 1) % n) * 2 + 1] / 10;
        if ((az <= zc) !== (bz <= zc)) xs.push(ax + (zc - az) / (bz - az) * (bx - ax));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - T.x0) / T.step)), i1 = Math.min(T.cols - 1, Math.floor((xs[k + 1] - T.x0) / T.step));
      for (let i = i0; i <= i1; i++) cb(i, j);
    }
  }
}

function terrainMesh(T, bounds) {
  const { cols, rows, step } = T;
  const pos = new Float32Array(cols * rows * 3);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const k = (j * cols + i) * 3;
    pos[k] = T.x0 + i * step; pos[k + 1] = T.d[j * cols + i]; pos[k + 2] = T.z0 + j * step;
  }
  const idx = new Uint32Array((cols - 1) * (rows - 1) * 6);
  let n = 0;
  for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols - 1; i++) {
    const a = j * cols + i, b = a + 1, c = a + cols + 1, d = a + cols;
    idx[n++] = a; idx[n++] = c; idx[n++] = b; idx[n++] = a; idx[n++] = d; idx[n++] = c;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  return g;
}

// Socle : le monde est une « tranche » de ville ; des flancs descendent du bord du relief.
function slab(T, y0) {
  const pos = [], idx = [];
  const edge = [];
  for (let i = 0; i < T.cols; i++) edge.push([T.x0 + i * T.step, T.d[i], T.z0]);
  for (let j = 0; j < T.rows; j++) edge.push([T.x0 + (T.cols - 1) * T.step, T.d[j * T.cols + T.cols - 1], T.z0 + j * T.step]);
  for (let i = T.cols - 1; i >= 0; i--) edge.push([T.x0 + i * T.step, T.d[(T.rows - 1) * T.cols + i], T.z0 + (T.rows - 1) * T.step]);
  for (let j = T.rows - 1; j >= 0; j--) edge.push([T.x0, T.d[j * T.cols], T.z0 + j * T.step]);
  for (const [x, y, z] of edge) pos.push(x, y, z, x, y0, z);
  for (let k = 0; k < edge.length - 1; k++) idx.push(k * 2, k * 2 + 1, k * 2 + 2, k * 2 + 1, k * 2 + 3, k * 2 + 2);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------------------------- géométrie
function ring(a) {
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

// Polygone (avec trous) posé sur le relief : triangulé en 2D puis subdivisé pour suivre les pentes.
function drapedPoly(outer, holes, T, yOff, maxEdge = 24) {
  const o = ring(outer), hs = holes.map(ring);
  const faces = THREE.ShapeUtils.triangulateShape(o, hs);
  const pts = o.concat(...hs);
  const pos = [], nor = [];
  const n = new THREE.Vector3();
  const emit = (ax, az, bx, bz, cx, cz, depth) => {
    const eab = Math.hypot(bx - ax, bz - az), ebc = Math.hypot(cx - bx, cz - bz), eca = Math.hypot(ax - cx, az - cz);
    const m = Math.max(eab, ebc, eca);
    if (m > maxEdge && depth < 7) {
      if (m === eab) { const mx = (ax + bx) / 2, mz = (az + bz) / 2; emit(ax, az, mx, mz, cx, cz, depth + 1); emit(mx, mz, bx, bz, cx, cz, depth + 1); }
      else if (m === ebc) { const mx = (bx + cx) / 2, mz = (bz + cz) / 2; emit(ax, az, bx, bz, mx, mz, depth + 1); emit(ax, az, mx, mz, cx, cz, depth + 1); }
      else { const mx = (cx + ax) / 2, mz = (cz + az) / 2; emit(ax, az, bx, bz, mx, mz, depth + 1); emit(mx, mz, bx, bz, cx, cz, depth + 1); }
      return;
    }
    // Orientation vers le haut : (b-a)x(c-a).y > 0.
    const up = (bz - az) * (cx - ax) - (bx - ax) * (cz - az) > 0;
    const v = up ? [[ax, az], [bx, bz], [cx, cz]] : [[ax, az], [cx, cz], [bx, bz]];
    for (const [x, z] of v) { pos.push(x, T.h(x, z) + yOff, z); T.normal(x, z, n); nor.push(n.x, n.y, n.z); }
  };
  for (const [a, b, c] of faces) emit(pts[a].x, pts[a].y, pts[b].x, pts[b].y, pts[c].x, pts[c].y, 0);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}

function flatPoly(outer, holes, y) {
  const o = ring(outer), hs = holes.map(ring);
  const faces = THREE.ShapeUtils.triangulateShape(o, hs);
  const pts = o.concat(...hs);
  const pos = new Float32Array(pts.length * 3);
  pts.forEach((p, i) => { pos[i * 3] = p.x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = p.y; });
  const idx = [];
  for (const [a, b, c] of faces) {
    const up = (pts[b].y - pts[a].y) * (pts[c].x - pts[a].x) - (pts[b].x - pts[a].x) * (pts[c].y - pts[a].y) > 0;
    idx.push(a, up ? b : c, up ? c : b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Ruban posé sur le relief (échantillonné tous les 5 m). `deck` : pont dont la hauteur relie les deux rives.
function ribbon(list, width, yOff, T) {
  const pos = [], nor = [], idx = [];
  const n3 = new THREE.Vector3();
  for (const pl of list) {
    const p = pl.p;
    if (p.length < 4) continue;
    // Rééchantillonnage.
    const P = [];
    for (let i = 0; i < p.length / 2 - 1; i++) {
      const ax = p[i * 2] / 10, az = p[i * 2 + 1] / 10, bx = p[i * 2 + 2] / 10, bz = p[i * 2 + 3] / 10;
      const k = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 5));
      for (let s = 0; s < k; s++) P.push([lerp(ax, bx, s / k), lerp(az, bz, s / k)]);
    }
    P.push([p[p.length - 2] / 10, p[p.length - 1] / 10]);
    const n = P.length;
    let hA = 0, hB = 0, tot = 0;
    const cum = [0];
    if (pl.deck) {
      hA = T.h(P[0][0], P[0][1]); hB = T.h(P[n - 1][0], P[n - 1][1]);
      for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
      tot = cum[n - 1] || 1;
    }
    const base = pos.length / 3;
    for (let i = 0; i < n; i++) {
      const [x, z] = P[i];
      const [px, pz] = i > 0 ? P[i - 1] : [x, z], [qx, qz] = i < n - 1 ? P[i + 1] : [x, z];
      const ax = x - px || qx - x, az = z - pz || qz - z, bx = qx - x || ax, bz = qz - z || az;
      const la = Math.hypot(ax, az) || 1, lb = Math.hypot(bx, bz) || 1;
      let nx = -(az / la) - (bz / lb), nz = ax / la + bx / lb;
      const ln = Math.hypot(nx, nz) || 1;
      nx /= ln; nz /= ln;
      const dot = Math.max(nx * (-az / la) + nz * (ax / la), 0.55);
      const w = (pl.w ?? width) / 2 / dot;
      const y = (pl.deck ? lerp(hA, hB, cum[i] / tot) + 0.5 : T.h(x, z)) + yOff + (pl.y ?? 0);
      T.normal(x, z, n3);
      pos.push(x + nx * w, y, z + nz * w, x - nx * w, y, z - nz * w);
      nor.push(n3.x, n3.y, n3.z, n3.x, n3.y, n3.z);
    }
    for (let i = 0; i < n - 1; i++) {
      const a = base + i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

// Escaliers marche par marche : altitudes mesurées (z) aux sommets, marches de ~32 cm.
function stairsGeometry(steps) {
  const pos = [], nor = [], col = [];
  const tread = c3('#c4bda9'), riser = c3('#8f8977');
  const push = (a, b, c, n, color) => {
    // Oriente le triangle pour que sa normale géométrique suive n.
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
    const t = gx * n[0] + gy * n[1] + gz * n[2] >= 0 ? [a, b, c] : [a, c, b];
    for (const v of t) { pos.push(...v); nor.push(...n); col.push(color.r, color.g, color.b); }
  };
  for (const s of steps) {
    if (!s.z || s.p.length < 4) continue;
    const w = s.w || 2, hw = w / 2;
    for (let i = 0; i < s.p.length / 2 - 1; i++) {
      const ax = s.p[i * 2] / 10, az = s.p[i * 2 + 1] / 10, bx = s.p[i * 2 + 2] / 10, bz = s.p[i * 2 + 3] / 10;
      const za = s.z[i] / 10, zb = s.z[i + 1] / 10;
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 0.4) continue;
      const dx = (bx - ax) / L, dz = (bz - az) / L, nx = -dz, nz = dx;
      const k = Math.max(1, Math.round(L / 0.32)), dep = L / k, rise = (zb - za) / k;
      const down = rise >= 0 ? [-dx, 0, -dz] : [dx, 0, dz]; // la contremarche regarde vers le bas de la pente
      for (let m = 0; m < k; m++) {
        const s0 = m * dep, s1 = (m + 1) * dep;
        const yt = za + rise * (m + 1), yb = za + rise * m;
        const x0 = ax + dx * s0, z0 = az + dz * s0, x1 = ax + dx * s1, z1 = az + dz * s1;
        const cl = (m & 1) ? tread : tread.clone().multiplyScalar(0.94);
        const A = [x0 + nx * hw, yt, z0 + nz * hw], B = [x0 - nx * hw, yt, z0 - nz * hw];
        const C = [x1 - nx * hw, yt, z1 - nz * hw], D = [x1 + nx * hw, yt, z1 + nz * hw];
        push(A, B, C, [0, 1, 0], cl); push(A, C, D, [0, 1, 0], cl);
        if (Math.abs(rise) > 0.02) {
          const lo = rise >= 0 ? A : D, lo2 = rise >= 0 ? B : C; // arête basse de la marche
          push([lo[0], yb, lo[2]], [lo2[0], yb, lo2[2]], [lo2[0], yt, lo2[2]], down, riser);
          push([lo[0], yb, lo[2]], [lo2[0], yt, lo2[2]], [lo[0], yt, lo[2]], down, riser);
        }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
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

// ---------------------------------------------------------------------------------------------- bâtiments
// Triangle orienté vers n (normale voulue), ajouté aux tableaux.
class Soup {
  constructor() { this.pos = []; this.nor = []; this.col = []; }
  tri(a, b, c, n, color) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
    const t = gx * n[0] + gy * n[1] + gz * n[2] >= 0 ? [a, b, c] : [a, c, b];
    for (const v of t) { this.pos.push(v[0], v[1], v[2]); this.nor.push(n[0], n[1], n[2]); this.col.push(color.r, color.g, color.b); }
  }
  quad(a, b, c, d, n, color) { this.tri(a, b, c, n, color); this.tri(a, c, d, n, color); }
  // Pavé posé sur une façade : o = centre du pied (sur le mur), t = tangente, n = sortante, w large, h haut, d saillie.
  box(o, t, n, w, h, d, color, lift = 0) {
    const P = (s, y, e) => [o[0] + t[0] * s + n[0] * e, o[1] + lift + y, o[2] + t[1] * s + n[1] * e];
    const hw = w / 2;
    const n3 = [n[0], 0, n[1]], t3 = [t[0], 0, t[1]];
    this.quad(P(-hw, 0, d), P(hw, 0, d), P(hw, h, d), P(-hw, h, d), n3, color);
    this.quad(P(-hw, h, 0), P(hw, h, 0), P(hw, h, d), P(-hw, h, d), [0, 1, 0], color);
    this.quad(P(-hw, 0, 0), P(-hw, h, 0), P(-hw, h, d), P(-hw, 0, d), [-t3[0], 0, -t3[2]], color);
    this.quad(P(hw, 0, 0), P(hw, h, 0), P(hw, h, d), P(hw, 0, d), t3, color);
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    return g;
  }
}

// Ouvrages des ponts : tranche du tablier, parapets, piles dans l'eau et têtes de pont (pylônes) à chaque rive.
function bridgeStructure(bridges, T) {
  const S = new Soup();
  const stone = c3('#8f8b80'), dark = c3('#6f6c64'), cap = c3('#c6c0ae');
  for (const r of bridges) {
    const p = r.p;
    if (p.length < 4) continue;
    const P = [];
    for (let i = 0; i < p.length / 2 - 1; i++) {
      const ax = p[i * 2] / 10, az = p[i * 2 + 1] / 10, bx = p[i * 2 + 2] / 10, bz = p[i * 2 + 3] / 10;
      const k = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 4));
      for (let m = 0; m < k; m++) P.push([lerp(ax, bx, m / k), lerp(az, bz, m / k)]);
    }
    P.push([p[p.length - 2] / 10, p[p.length - 1] / 10]);
    const n = P.length;
    if (n < 2) continue;
    const hA = T.h(P[0][0], P[0][1]), hB = T.h(P[n - 1][0], P[n - 1][1]);
    const cum = [0];
    for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
    const tot = cum[n - 1] || 1, half = (ROAD_W[r.c] + 1.4) / 2;
    const F = P.map(([x, z], i) => {
      const [px, pz] = i > 0 ? P[i - 1] : [x, z], [qx, qz] = i < n - 1 ? P[i + 1] : [x, z];
      let tx = qx - px, tz = qz - pz;
      const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
      return { x, z, y: lerp(hA, hB, cum[i] / tot) + 0.65, tx, tz, nx: -tz, nz: tx };
    });
    for (let i = 0; i < n - 1; i++) {
      const a = F[i], b = F[i + 1];
      for (const sd of [-1, 1]) {
        const sn = [a.nx * sd, 0, a.nz * sd];
        const E = (f, o) => [f.x + f.nx * sd * (half - o), 0, f.z + f.nz * sd * (half - o)];
        const ea = E(a, 0), eb = E(b, 0), ia = E(a, 0.35), ib = E(b, 0.35);
        // Tranche du tablier (sous la chaussée) et parapet.
        S.quad([ea[0], a.y - 0.15, ea[2]], [eb[0], b.y - 0.15, eb[2]], [eb[0], b.y - 1.4, eb[2]], [ea[0], a.y - 1.4, ea[2]], sn, stone);
        S.quad([ea[0], a.y, ea[2]], [eb[0], b.y, eb[2]], [eb[0], b.y + 0.95, eb[2]], [ea[0], a.y + 0.95, ea[2]], sn, cap);
        S.quad([ia[0], a.y, ia[2]], [ib[0], b.y, ib[2]], [ib[0], b.y + 0.95, ib[2]], [ia[0], a.y + 0.95, ia[2]], [-sn[0], 0, -sn[2]], cap);
        S.quad([ea[0], a.y + 0.95, ea[2]], [eb[0], b.y + 0.95, eb[2]], [ib[0], b.y + 0.95, ib[2]], [ia[0], a.y + 0.95, ia[2]], [0, 1, 0], cap);
      }
      // Dessous du tablier.
      S.quad([a.x + a.nx * half, a.y - 1.4, a.z + a.nz * half], [b.x + b.nx * half, b.y - 1.4, b.z + b.nz * half], [b.x - b.nx * half, b.y - 1.4, b.z - b.nz * half], [a.x - a.nx * half, a.y - 1.4, a.z - a.nz * half], [0, -1, 0], dark);
    }
    // Piles : tous les ~26 m tant que le sol est bien plus bas que le tablier.
    for (let d = 14; d < tot - 12; d += 26) {
      let i = 0;
      while (i < n - 2 && cum[i + 1] < d) i++;
      const f = F[i], g = T.h(f.x, f.z);
      if (g > f.y - 3) continue;
      S.box([f.x - f.tx * 1.0, g - 0.5, f.z - f.tz * 1.0], [f.nx, f.nz], [f.tx, f.tz], half * 2 - 1.2, f.y - 1.4 - g + 0.5, 2.0, dark);
    }
    // Têtes de pont : pylônes à chaque angle des deux rives et massif de maçonnerie sous le tablier.
    for (const [k, dir] of [[0, 1], [n - 1, -1]]) {
      const f = F[k], g = T.h(f.x, f.z);
      for (const sd of [-1, 1]) {
        const cx = f.x + f.nx * sd * half, cz = f.z + f.nz * sd * half;
        const o = [cx - f.nx * sd * 0.7, Math.min(g, f.y) - 0.6, cz - f.nz * sd * 0.7];
        S.box(o, [f.tx, f.tz], [f.nx * sd, f.nz * sd], 1.4, f.y + 2.3 - o[1], 1.4, stone);
        S.box([o[0], f.y + 2.3, o[2]], [f.tx, f.tz], [f.nx * sd, f.nz * sd], 1.7, 0.25, 1.7, cap, 0);
      }
      const o = [f.x - f.tx * dir * 0.0, Math.min(g, f.y) - 0.8, f.z - f.tz * dir * 0.0];
      S.box([f.x + f.tx * dir * 0.2, Math.min(g, f.y) - 0.8, f.z + f.tz * dir * 0.2], [f.nx, f.nz], [f.tx * dir, f.tz * dir], half * 2 + 0.6, f.y - 1.4 - Math.min(g, f.y) + 0.8, 3.2, dark);
    }
  }
  return S.geometry();
}

// Murs + toit (plat ardoise, ou deux pans pour les petits rectangles), posés sur le relief.
function prepBuilding(b, T) {
  let minE = Infinity, maxE = -Infinity;
  for (let i = 0; i < b.p.length; i += 2) { const e = T.h(b.p[i] / 10, b.p[i + 1] / 10); minE = Math.min(minE, e); maxE = Math.max(maxE, e); }
  b.y0 = minE - 0.3;
  b.rh = b.rh ?? 0;
  b.y1 = Math.max(minE + b.h / 10, maxE + 2.2);
}

function buildingGeometry(b, R, T) {
  const pts = ring(b.p), n = pts.length;
  const h = b.h / 10;
  const bottom = b.y0, top = b.y1;
  let wallC, roofC;
  if (b.k === 1) { wallC = c3(PAL.church); roofC = c3(PAL.churchRoof); }
  else if (b.k === 2) { wallC = c3(PAL.castle); roofC = c3(PAL.churchRoof); }
  else if (b.k === 3) { wallC = c3(PAL.industrial); roofC = c3(PAL.industrialRoof); }
  else { wallC = c3(PAL.walls[b.c % PAL.walls.length]); roofC = c3(PAL.roofs[(b.c * 3 + (R() < 0.15 ? 3 : 0)) % PAL.roofs.length]); }
  // Couleurs OSM adoucies (certaines sont du noir ou du blanc pur) : on les mélange à la teinte du quartier.
  if (b.wc) wallC = c3(b.wc).lerp(wallC, 0.35);
  if (b.rc) roofC = c3(b.rc).lerp(roofC, 0.35);
  wallC.multiplyScalar(0.94 + R() * 0.1);
  b.wall = wallC;
  const S = new Soup();
  let cx = 0, cz = 0;
  for (const p of pts) { cx += p.x / n; cz += p.y / n; }
  const wallTop = top;
  for (let i = 0; i < n; i++) {
    const a = pts[i], c = pts[(i + 1) % n];
    const l = Math.hypot(c.x - a.x, c.y - a.y) || 1, nx = (c.y - a.y) / l, nz = -(c.x - a.x) / l;
    const A = [a.x, bottom, a.y], C = [c.x, bottom, c.y];
    S.quad(A, C, [c.x, wallTop, c.y], [a.x, wallTop, a.y], [nx, 0, nz], wallC);
  }
  let area = 0;
  for (let i = 0; i < n; i++) { const a = pts[i], c = pts[(i + 1) % n]; area += a.x * c.y - c.x * a.y; }
  area = Math.abs(area) / 2;
  b.rh = 0;
  if (n === 4 && area < 260 && b.k === 0 && h < 20) {
    // Toit à deux pans, faîtage dans le sens de la longueur.
    const [P0, P1, P2, P3] = pts;
    const e0 = Math.hypot(P1.x - P0.x, P1.y - P0.y), e1 = Math.hypot(P2.x - P1.x, P2.y - P1.y);
    const mid = (a, c) => [(a.x + c.x) / 2, wallTop + 0, (a.y + c.y) / 2];
    const rh = Math.min(Math.min(e0, e1) / 2 * 0.62, 4.2);
    b.rh = rh;
    const up = (v) => [v.x, wallTop, v.y];
    let r0, r1;
    if (e0 >= e1) { r0 = mid(P1, P2); r1 = mid(P3, P0); } else { r0 = mid(P0, P1); r1 = mid(P2, P3); }
    r0[1] = r1[1] = wallTop + rh;
    const upN = (a, c, d) => { const ux = c[0] - a[0], uy = c[1] - a[1], uz = c[2] - a[2], vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2]; const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx; const l = Math.hypot(gx, gy, gz) || 1; return gy < 0 ? [-gx / l, -gy / l, -gz / l] : [gx / l, gy / l, gz / l]; };
    const slope = (a, c, d, e) => S.quad(a, c, d, e, upN(a, c, d), roofC);
    const gable = (a, c, r) => S.tri(a, c, r, [(a[0] + c[0]) / 2 - cx, 0, (a[2] + c[2]) / 2 - cz].map((v, k, arr) => v / (Math.hypot(arr[0], arr[2]) || 1)), wallC);
    if (e0 >= e1) {
      slope(up(P0), up(P1), r0, r1);
      slope(up(P2), up(P3), r1, r0);
      gable(up(P1), up(P2), r0); gable(up(P3), up(P0), r1);
    } else {
      slope(up(P1), up(P2), r1, r0);
      slope(up(P3), up(P0), r0, r1);
      gable(up(P0), up(P1), r0); gable(up(P2), up(P3), r1);
    }
  } else {
    const roof = THREE.ShapeUtils.triangulateShape(pts.slice(), []);
    for (const [a, b2, c] of roof) S.tri([pts[a].x, top, pts[a].y], [pts[b2].x, top, pts[b2].y], [pts[c].x, top, pts[c].y], [0, 1, 0], roofC);
  }
  // Liseré sombre au bord du toit.
  const ln = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i], c = pts[(i + 1) % n];
    ln.push(a.x, top + 0.04, a.y, c.x, top + 0.04, c.y);
  }
  return { g: S.geometry(), ln };
}

// Détails de façade d'un bâtiment : fenêtres, volets, portes, balcons, jardinières, cheminées.
function facade(S, b, rr) {
  const pts = ring(b.p), n = pts.length;
  const bottom = b.y0, top = b.y1;
  const storeys = Math.max(1, Math.floor((top - bottom - 0.6) / 3.0));
  const church = b.k === 1, indus = b.k === 3;
  const style = rr();
  const shut = style < 0.45 ? c3(PAL.shutters[Math.floor(rr() * PAL.shutters.length)]) : null;
  const balconies = b.k === 0 && style > 0.5;
  const frame = c3('#ece6d6'), door = c3('#5a3d2b'), rail = c3('#232831'), slabC = c3('#b7b2a4');
  const plant = [c3('#3f7d34'), c3('#4f9440'), c3('#356b2c')], flower = [c3('#e8648a'), c3('#f2c23d'), c3('#f0f0f0'), c3('#d94a3a')];
  for (let i = 0; i < n; i++) {
    const a = pts[i], c = pts[(i + 1) % n];
    const L = Math.hypot(c.x - a.x, c.y - a.y);
    if (L < 3.2) continue;
    const t = [(c.x - a.x) / L, (c.y - a.y) / L], nn = [t[1], -t[0]];
    const gap = church ? 4.6 : indus ? 6 : 2.7;
    const cells = Math.floor((L - 1.4) / gap);
    if (cells < 1) continue;
    const sp = L / cells;
    for (let k = 0; k < cells; k++) {
      const s = (k + 0.5) * sp;
      const o = [a.x + t[0] * s, bottom, a.y + t[1] * s];
      const door0 = !church && !indus && k === 0 && storeys > 0 && rr() < 0.7;
      for (let f = 0; f < (church ? 1 : indus ? 1 : storeys); f++) {
        if (f === 0 && door0) { S.box(o, t, nn, 1.1, 2.1, 0.12, door); continue; }
        const y = church ? 3.6 : indus ? 2.4 : f * 3.0 + (f === 0 ? 1.15 : 1.0);
        const w = church ? 0.8 : 1.05, h = church ? 2.6 : indus ? 1.0 : 1.4;
        const gl = c3(PAL.glass[Math.floor(rr() * PAL.glass.length)]);
        S.box(o, t, nn, w + 0.18, h + 0.18, 0.05, frame, y - 0.09);
        S.box(o, t, nn, w, h, 0.09, gl, y);
        if (shut && !church && !indus) {
          for (const sgn of [-1, 1]) {
            const ox = [o[0] + t[0] * sgn * (w / 2 + 0.3), o[1], o[2] + t[1] * sgn * (w / 2 + 0.3)];
            S.box(ox, t, nn, 0.46, h, 0.09, shut, y);
          }
        }
        if (church || indus) continue;
        if (balconies && f > 0 && rr() < 0.4) {
          S.box(o, t, nn, 1.9, 0.1, 0.75, slabC, y - 0.32);
          S.box([o[0], o[1], o[2]], t, nn, 1.9, 0.85, 0.05, rail, y - 0.2);
          S.box([o[0] + t[0] * 0.55, o[1], o[2] + t[1] * 0.55], t, nn, 0.4, 0.36, 0.4, plant[Math.floor(rr() * 3)], y - 0.22);
          if (rr() < 0.6) S.box([o[0] - t[0] * 0.5, o[1], o[2] - t[1] * 0.5], t, nn, 0.3, 0.3, 0.3, flower[Math.floor(rr() * 4)], y - 0.22);
        } else if (rr() < 0.17) {
          S.box(o, t, nn, 1.0, 0.2, 0.22, c3('#6b4a3a'), y - 0.24);
          S.box(o, t, nn, 0.96, 0.2, 0.2, plant[Math.floor(rr() * 3)], y - 0.06);
          S.box([o[0] + t[0] * 0.25, o[1], o[2] + t[1] * 0.25], t, nn, 0.18, 0.12, 0.18, flower[Math.floor(rr() * 4)], y + 0.12);
        }
      }
    }
  }
  // Cheminée.
  if (b.k === 0 && rr() < 0.35 && n >= 3) {
    let cx = 0, cz = 0;
    for (const p of pts) { cx += p.x / n; cz += p.y / n; }
    S.box([cx, top + b.rh * 0.35, cz], [1, 0], [0, 1], 0.7, 1.6 + b.rh * 0.4, 0.7, c3('#8a7f72'));
  }
}

// ---------------------------------------------------------------------------------------------- construction
export async function buildCity(scene, data, { mobile = false, demBuf, demMeta, onProgress = () => {} } = {}) {
  const R = rng(99), rr = rng(5);
  const root = new THREE.Group();
  scene.add(root);
  const [bx0, bz0, bx1, bz1] = data.bounds;
  const T = new Terrain(demMeta, demBuf, mobile ? 2 : 1);

  // Eau : niveau de chaque plan d'eau = médiane du relief mesuré dedans ; le relief y est creusé de 1,2 m.
  const wlevel = [];
  data.water.forEach((w, id) => {
    const vals = [];
    rasterRings([w.p, ...w.h], T, (i, j) => vals.push(T.d[j * T.cols + i]));
    vals.sort((a, b) => a - b);
    wlevel[id] = vals.length ? vals[Math.floor(vals.length / 2)] : 0;
  });
  data.water.forEach((w, id) => {
    const lvl = wlevel[id] - 1.2;
    rasterRings([w.p, ...w.h], T, (i, j) => { const k = j * T.cols + i; if (T.d[k] > lvl) T.d[k] = lvl; });
  });
  onProgress(0.05);

  const terrain = new THREE.Mesh(terrainMesh(T), toon(PAL.ground));
  terrain.receiveShadow = true;
  root.add(terrain);
  const minY = T.d.reduce((m, v) => Math.min(m, v), 99) - 6;
  root.add(new THREE.Mesh(slab(T, minY), toon(PAL.slab, { side: THREE.DoubleSide })));
  const far = new THREE.Mesh(new THREE.PlaneGeometry(60000, 60000).rotateX(-Math.PI / 2), toon(PAL.slab));
  far.position.y = minY - 0.1;
  root.add(far);

  // Espaces verts.
  const parts = { park: [], wood: [], pitch: [] };
  for (const g of data.green) parts[g.k]?.push(paint(drapedPoly(g.p, g.h, T, 0.12), c3(PAL[g.k])));
  for (const k of Object.keys(parts)) if (parts[k].length) root.add(mesh(mergeGeometries(parts[k]), null, { vertexColors: true, offset: 1 }));
  onProgress(0.12);

  // Eau.
  const wg = data.water.map((w, id) => flatPoly(w.p, w.h, wlevel[id] + 0.05));
  if (wg.length) root.add(mesh(mergeGeometries(wg), PAL.water, { offset: 2, order: 1 }));
  root.add(mesh(ribbon(data.waterlines.map((w) => ({ p: w.p, w: w.w })), 3, 0.08, T), PAL.water, { offset: 2, order: 1 }));
  onProgress(0.2);

  // Routes : une couche par classe, les grandes dessous. Les ponts suivent la ligne droite entre rives.
  const byClass = [[], [], [], [], [], []];
  const bridges = [];
  for (const r of data.roads) (r.b ? bridges : byClass[r.c]).push(r);
  for (let c = 5; c >= 0; c--) {
    if (!byClass[c].length) continue;
    root.add(mesh(ribbon(byClass[c], ROAD_W[c], 0.16 + (5 - c) * 0.004 * -1 + (c >= 4 ? 0.04 : 0), T), PAL.roads[c], { offset: 3 + (c >= 4 ? 1 : 0) }));
  }
  if (bridges.length) {
    root.add(mesh(ribbon(bridges.map((r) => ({ p: r.p, w: ROAD_W[r.c] + 1.4, deck: true, y: -0.15 })), 0, 0.1, T), '#3a3d43', { offset: 5, order: 2 }));
    root.add(mesh(ribbon(bridges.map((r) => ({ p: r.p, w: ROAD_W[r.c], deck: true })), 0, 0.15, T), '#5a5d63', { offset: 6, order: 3 }));
  }
  if (bridges.length) {
    const bs = mesh(bridgeStructure(bridges, T), null, { vertexColors: true, shadow: !mobile });
    root.add(bs);
  }
  const tram = data.rails.filter((r) => r.k === 0), rail = data.rails.filter((r) => r.k === 1);
  if (tram.length) root.add(mesh(ribbon(tram, 2, 0.24, T), PAL.tram, { offset: 6 }));
  if (rail.length) root.add(mesh(ribbon(rail, 3.2, 0.24, T), PAL.rail, { offset: 6 }));
  if (data.steps?.length) {
    const sg = stairsGeometry(data.steps);
    if (sg.attributes.position.count) { const sm = mesh(sg, null, { vertexColors: true, shadow: !mobile }); root.add(sm); }
  }
  onProgress(0.3);

  // Bâtiments par tuiles + grille des détails de façade.
  const tiles = new Map(), cells = new Map();
  for (const b of data.buildings) {
    const tx = Math.floor(b.p[0] / 10 / TILE), tz = Math.floor(b.p[1] / 10 / TILE);
    (tiles.get(tx + ',' + tz) ?? tiles.set(tx + ',' + tz, []).get(tx + ',' + tz)).push(b);
    const cx = Math.floor(b.p[0] / 10 / DETAIL_CELL), cz = Math.floor(b.p[1] / 10 / DETAIL_CELL);
    (cells.get(cx + ',' + cz) ?? cells.set(cx + ',' + cz, { cx, cz, list: [], mesh: null }).get(cx + ',' + cz)).list.push(b);
  }
  const lineMat = new THREE.LineBasicMaterial({ color: PAL.outline });
  const bodyMat = toon('#ffffff', { vertexColors: true });
  for (const b of data.buildings) prepBuilding(b, T);
  const tileList = [...tiles.entries()].map(([k, list]) => {
    const [tx, tz] = k.split(',').map(Number);
    return { cx: (tx + 0.5) * TILE, cz: (tz + 0.5) * TILE, list, body: null, lines: null };
  });
  // Vue lointaine : chaque bâtiment est un pavé orienté (rectangle englobant de plus petite aire), en instances par tuile.
  // La tuile détaillée remplace ses pavés dès qu'elle est construite.
  function footprintBox(b) {
    const n = b.p.length / 2, xs = new Float32Array(n), zs = new Float32Array(n);
    for (let i = 0; i < n; i++) { xs[i] = b.p[i * 2] / 10; zs[i] = b.p[i * 2 + 1] / 10; }
    let best = null;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      let dx = xs[j] - xs[i], dz = zs[j] - zs[i];
      const l = Math.hypot(dx, dz);
      if (l < 0.5) continue;
      dx /= l; dz /= l;
      let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
      for (let k = 0; k < n; k++) {
        const u = xs[k] * dx + zs[k] * dz, v = -xs[k] * dz + zs[k] * dx;
        if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
      }
      const a = (u1 - u0) * (v1 - v0);
      if (!best || a < best.a) best = { a, dx, dz, u0, u1, v0, v1 };
    }
    if (!best) return null;
    const cu = (best.u0 + best.u1) / 2, cv = (best.v0 + best.v1) / 2;
    return { x: cu * best.dx - cv * best.dz, z: cu * best.dz + cv * best.dx, w: best.u1 - best.u0, d: best.v1 - best.v0, ang: Math.atan2(-best.dz, best.dx) };
  }
  const farGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  {
    // Toit sombre (ardoise) : face du dessus teintée, les murs gardent la couleur de l'instance.
    const col = new Float32Array(farGeo.attributes.position.count * 3).fill(1);
    for (let v = 8; v < 12; v++) { col[v * 3] = 0.34; col[v * 3 + 1] = 0.38; col[v * 3 + 2] = 0.5; }
    farGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  const farMat = toon('#ffffff', { vertexColors: true });
  const fm = new THREE.Matrix4(), fq = new THREE.Quaternion(), fp = new THREE.Vector3(), fs = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  for (const t of tileList) {
    const boxes = [];
    for (const b of t.list) { const o = footprintBox(b); if (o) boxes.push([b, o]); }
    if (!boxes.length) continue;
    const im = new THREE.InstancedMesh(farGeo, farMat, boxes.length);
    boxes.forEach(([b, o], i) => {
      fq.setFromAxisAngle(up, o.ang);
      fm.compose(fp.set(o.x, b.y0, o.z), fq, fs.set(Math.max(o.w, 1.5), Math.max(b.y1 - b.y0, 2), Math.max(o.d, 1.5)));
      im.setMatrixAt(i, fm);
      let wc;
      if (b.wc) wc = '#' + c3(b.wc).lerp(c3(PAL.walls[b.c % PAL.walls.length]), 0.35).getHexString();
      else if (b.k === 1) wc = PAL.church; else if (b.k === 2) wc = PAL.castle; else if (b.k === 3) wc = PAL.industrial;
      else wc = PAL.walls[b.c % PAL.walls.length];
      im.setColorAt(i, c3(wc));
    });
    root.add(im);
    t.far = im;
  }
  const BUILD_R = mobile ? 700 : 1300, DETAIL_R = mobile ? 150 : 250;
  const tileQueue = [];
  function buildTile(t) {
    const g = [], lines = [];
    for (const b of t.list) {
      const r = buildingGeometry(b, rng((b.p[0] * 31 + b.p[1]) | 0), T);
      g.push(r.g); lines.push(...r.ln);
    }
    t.body = new THREE.Mesh(mergeGeometries(g), bodyMat);
    t.body.castShadow = !mobile;
    t.body.receiveShadow = !mobile;
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    t.lines = new THREE.LineSegments(lg, lineMat);
    root.add(t.body, t.lines);
    if (t.far) t.far.visible = false;
    g.forEach((x) => x.dispose());
  }
  function freeTile(t) {
    root.remove(t.body, t.lines);
    t.body.geometry.dispose(); t.lines.geometry.dispose();
    t.body = t.lines = null;
    if (t.far) t.far.visible = true;
  }

  // Arbres : instances (tronc + feuillage), posées sur le relief.
  const tr = data.trees, step = mobile ? 2 : 1;
  const count = Math.floor(tr.length / 2 / step);
  const crown = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), toon('#ffffff'), count);
  const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.18, 0.25, 1, 5), toon('#5b4331'), count);
  crown.castShadow = !mobile;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const greens = ['#4a7f3a', '#3f7334', '#56883f', '#477b38'].map(c3);
  for (let i = 0; i < count; i++) {
    const x = tr[i * 2 * step] / 10, z = tr[i * 2 * step + 1] / 10, y = T.h(x, z);
    const r = 2.1 + R() * 1.5, h = 4 + R() * 3;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), R() * 6.28);
    m4.compose(p.set(x, y + h * 0.55 + r * 0.55, z), q, s.set(r, r * 0.9, r));
    crown.setMatrixAt(i, m4);
    crown.setColorAt(i, greens[i % greens.length]);
    m4.compose(p.set(x, y + h * 0.3, z), q, s.set(1, h * 0.6, 1));
    trunk.setMatrixAt(i, m4);
  }
  root.add(crown, trunk);
  onProgress(0.9);

  // Grille des toits (pas du relief) : hauteur de survol minimale au-dessus des bâtiments.
  const roofG = new Float32Array(T.cols * T.rows).fill(-1e9);
  for (const b of data.buildings) {
    rasterRings([b.p], T, (i, j) => { const k = j * T.cols + i; if (b.y1 > roofG[k]) roofG[k] = b.y1; });
    const ci = Math.round((b.p[0] / 10 - T.x0) / T.step), cj = Math.round((b.p[1] / 10 - T.z0) / T.step);
    if (ci >= 0 && cj >= 0 && ci < T.cols && cj < T.rows) { const k = cj * T.cols + ci; if (b.y1 > roofG[k]) roofG[k] = b.y1; }
  }
  function surfaceY(x, z) {
    const fi = (x - T.x0) / T.step, fj = (z - T.z0) / T.step;
    const i = Math.floor(fi), j = Math.floor(fj);
    let m = T.h(x, z);
    for (let dj = 0; dj <= 1; dj++) for (let di = 0; di <= 1; di++) {
      const ii = i + di, jj = j + dj;
      if (ii >= 0 && jj >= 0 && ii < T.cols && jj < T.rows) m = Math.max(m, roofG[jj * T.cols + ii]);
    }
    return m;
  }

  // Tuiles de bâtiments et détails de façade, construits à la demande autour de la cible.
  const detailMat = toon('#ffffff', { vertexColors: true });
  const queue = [];
  let lastSweep = -1;
  function update(tx, tz, time) {
    if (time - lastSweep > 0.4) {
      lastSweep = time;
      queue.length = 0; tileQueue.length = 0;
      for (const t of tileList) {
        const d = Math.hypot(t.cx - tx, t.cz - tz);
        if (d < BUILD_R) { if (!t.body) tileQueue.push([d, t]); }
        else if (t.body && d > BUILD_R * 1.5) freeTile(t);
      }
      tileQueue.sort((a, b) => a[0] - b[0]);
      for (const c of cells.values()) {
        const d = Math.hypot((c.cx + 0.5) * DETAIL_CELL - tx, (c.cz + 0.5) * DETAIL_CELL - tz);
        if (d < DETAIL_R) { if (!c.mesh) queue.push([d, c]); else c.mesh.visible = true; }
        else if (c.mesh) { c.mesh.visible = d < DETAIL_R * 1.3; if (d > DETAIL_R * 2.2) { c.mesh.geometry?.dispose(); root.remove(c.mesh); c.mesh = null; } }
      }
      queue.sort((a, b) => a[0] - b[0]);
    }
    // Une tuile par image, sinon un détail.
    const tj = tileQueue.shift();
    if (tj) { if (!tj[1].body) buildTile(tj[1]); return; }
    const job = queue.shift();
    if (!job) return;
    const c = job[1];
    const S = new Soup();
    const r = rng((c.cx * 7919 + c.cz * 104729) | 0);
    for (const b of c.list) facade(S, b, r);
    if (!S.pos.length) { c.mesh = new THREE.Object3D(); return; }
    c.mesh = new THREE.Mesh(S.geometry(), detailMat);
    c.mesh.castShadow = !mobile;
    root.add(c.mesh);
  }
  // On prépare tout de suite le voisinage du départ pour ne pas voir une ville vide.
  const warm = (x, z) => { for (let i = 0; i < 60; i++) update(x, z, i); };

  onProgress(1);
  return { root, terrain: T, updateDetail: update, warm, surfaceY, groundY: (x, z) => T.h(x, z) };
}
