import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

// Rampe 3 tons partagée : c'est elle qui donne le rendu cel shading.
const gradient = (() => {
  const data = new Uint8Array([90, 170, 255]);
  const tex = new THREE.DataTexture(data, data.length, 1, THREE.RedFormat);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
})();

const cache = new Map();

// Vent dans les feuillages : un léger balancement, propre à chaque arbre (phase tirée de sa position) et fait de
// plusieurs rafales superposées, donc jamais synchrone. Seuls les sommets en hauteur bougent (le tronc reste planté).
export const WIND = { value: 0 };
const WIND_GLSL = /* glsl */`
  uniform float uWind;
  vec3 windOffset(vec3 wp) {
    float h = clamp((wp.y - 2.4) / 6.0, 0.0, 1.4);
    float ph = dot(wp.xz, vec2(0.071, 0.053));
    float g = sin(uWind * 1.3 + ph) * 0.55 + sin(uWind * 2.9 + ph * 2.3) * 0.25 + sin(uWind * 0.41 + ph * 0.37) * 0.4;
    return vec3(0.35 * g, 0.0, 0.6 * (g + 0.45)) * h * 0.3;
  }
`;
const windCache = new Map();
function toonWind(color, opts) {
  const key = color + JSON.stringify(opts);
  if (windCache.has(key)) return windCache.get(key);
  const { flatShading, ...params } = opts;
  const m = new THREE.MeshToonMaterial({ color, gradientMap: gradient, ...params });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uWind = WIND;
    sh.vertexShader = sh.vertexShader
      .replace('void main() {', WIND_GLSL + '\nvoid main() {')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  transformed += windOffset((modelMatrix * vec4(transformed, 1.0)).xyz);');
  };
  m.customProgramCacheKey = () => 'wind';
  windCache.set(key, m);
  return m;
}

export function toon(color, opts = {}) {
  const key = color + JSON.stringify(opts);
  if (!opts.map && cache.has(key)) return cache.get(key);
  const { flatShading, ...params } = opts; // MeshToonMaterial n'a pas d'ombrage plat : l'option est ignorée
  const m = new THREE.MeshToonMaterial({ color, gradientMap: gradient, ...params });
  if (!opts.map) cache.set(key, m);
  return m;
}

const outlineMats = new Map();
function outlineMaterial(thickness, color, wind = false) {
  const key = thickness + ':' + color + (wind ? ':wind' : '');
  if (outlineMats.has(key)) return outlineMats.get(key);
  const m = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uThick: { value: thickness }, uWind: WIND },
    vertexShader: /* glsl */`
      uniform float uThick;
      ${wind ? WIND_GLSL : ''}
      void main() {
        vec3 p = position + normal * uThick;
        ${wind ? 'p += windOffset((modelMatrix * vec4(position, 1.0)).xyz); // le contour suit le feuillage' : ''}
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      void main() { gl_FragColor = vec4(uColor, 1.0); }`,
    side: THREE.BackSide,
  });
  outlineMats.set(key, m);
  return m;
}

// Contour "inverted hull" : on gonfle une copie de la géométrie le long de normales lissées.
export function outline(mesh, thickness = 0.06, color = '#1d2533', wind = false) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', mesh.geometry.getAttribute('position').clone());
  if (mesh.geometry.index) g.setIndex(mesh.geometry.index.clone());
  const merged = mergeVertices(g, 1e-3);
  merged.computeVertexNormals();
  const o = new THREE.Mesh(merged, outlineMaterial(thickness, color, wind));
  o.castShadow = false;
  o.receiveShadow = false;
  mesh.add(o);
  return o;
}

// Mesh toon avec ombres et contour en un appel.
export function solid(geometry, color, { outlineWidth = 0.06, flat = true, cast = true, receive = true, wind = false } = {}) {
  const mat = (wind ? toonWind : toon)(color, flat ? { flatShading: true } : {});
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  if (outlineWidth > 0) outline(mesh, outlineWidth, '#1d2533', wind);
  return mesh;
}

// Petit PRNG déterministe : le monde est identique à chaque visite.
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const PALETTE = {
  sea: '#3f9fd1',
  seaDeep: '#2c7fb8',
  foam: '#f4fbff',
  sand: '#f1d8a6',
  grass: '#8cc56b',
  grassDark: '#5f9e4f',
  rock: '#9aa3ad',
  wood: '#a8754b',
  hull: '#f6f1e7',
  deck: '#dfe4ea',
  accent: '#ff6a4d',
  sail: '#fbf6ea',
  foil: '#2b3240',
  stage: '#ffc845',
  job: '#ff6a4d',
  sport: '#4d7cff',
};
