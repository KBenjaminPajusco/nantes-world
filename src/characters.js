import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { toon, outline } from './toon.js?v=20261025164024';

// Personnages : petites figurines stylisées (tête ronde, cheveux, torse évasé, mains, chaussures),
// et agents IA à tête-écran. Chaque membre est un seul maillage à couleurs par sommet :
// autant d'objets à dessiner qu'avant, pour beaucoup plus de détail.
const HAIR = ['#2b1d16', '#4a3020', '#7a4b2a', '#c9a15a', '#1d2533', '#8a3b25'];
const SKIN = ['#f2c9a0', '#e5b48a', '#c98f62', '#8f5b3c', '#f6d4b6'];
const SHOES = '#2b3240';
let made = 0; // fait varier cheveux et peau d'un personnage à l'autre

// Pièce colorée prête à être fusionnée (position, normale, couleur).
function part(geometry, color) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
  const c = new THREE.Color(color), n = g.attributes.position.count, col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}
function piece(parts, w = 0.035) {
  const mesh = new THREE.Mesh(mergeGeometries(parts), toon('#ffffff', { vertexColors: true }));
  mesh.castShadow = mesh.receiveShadow = true;
  if (w) outline(mesh, w);
  return mesh;
}

export function person({ shirt = '#ff6a4d', skin = null, pants = '#2d3a4f', hair = null, agent = false } = {}) {
  const k = made++;
  skin ??= SKIN[k % SKIN.length];
  hair ??= HAIR[(k * 7 + 3) % HAIR.length];
  const limb = agent ? '#cfd6e0' : skin;
  const g = new THREE.Group();

  // Jambes (pivot à la hanche) : pantalon fuselé et chaussure.
  const leg = (s) => {
    const p = new THREE.Group();
    p.position.set(s * 0.14, 0.95, 0);
    p.add(piece([
      part(new THREE.CylinderGeometry(0.11, 0.085, 0.82, 6).translate(0, -0.43, 0), pants),
      part(new THREE.BoxGeometry(0.19, 0.13, 0.34).translate(0, -0.88, 0.05), SHOES),
    ]));
    g.add(p);
    return p;
  };
  // Bras (pivot à l'épaule) : manche, avant-bras, main ; longueur 0,72 jusqu'au bout des doigts.
  const arm = (s) => {
    const p = new THREE.Group();
    p.position.set(s * 0.33, 1.6, 0);
    p.add(piece([
      part(new THREE.CylinderGeometry(0.09, 0.08, 0.3, 6).translate(0, -0.13, 0), agent ? '#9aa3ad' : shirt),
      part(new THREE.CylinderGeometry(0.068, 0.062, 0.36, 6).translate(0, -0.45, 0), limb),
      part(new THREE.IcosahedronGeometry(0.08, 0).translate(0, -0.66, 0), limb),
    ]));
    g.add(p);
    return p;
  };
  g.userData.legs = [leg(-1), leg(1)];
  g.userData.arms = [arm(-1), arm(1)];

  // Corps : bassin, torse évasé, épaules arrondies, cou, puis la tête.
  const body = [
    part(new THREE.CylinderGeometry(0.24, 0.23, 0.2, 8).translate(0, 0.98, 0), pants),
    part(new THREE.CylinderGeometry(0.27, 0.22, 0.6, 8).translate(0, 1.36, 0), shirt),
    part(new THREE.SphereGeometry(0.28, 8, 3, 0, Math.PI * 2, 0, Math.PI / 2).scale(1.15, 0.45, 0.8).translate(0, 1.64, 0), shirt),
  ];
  if (agent) {
    body.push(
      part(new THREE.CylinderGeometry(0.07, 0.08, 0.14, 6).translate(0, 1.74, 0), '#9aa3ad'),
      part(new THREE.BoxGeometry(0.62, 0.48, 0.46).translate(0, 1.98, 0), '#e9edf2'),
      part(new THREE.BoxGeometry(0.5, 0.34, 0.02).translate(0, 1.98, 0.235), '#1d2533'),
      part(new THREE.CylinderGeometry(0.02, 0.02, 0.3, 4).translate(0, 2.37, 0), '#9aa3ad'),
    );
  } else {
    body.push(
      part(new THREE.CylinderGeometry(0.08, 0.09, 0.14, 6).translate(0, 1.74, 0), skin),
      part(new THREE.IcosahedronGeometry(0.27, 2).translate(0, 1.99, 0), skin),
      // Cheveux : calotte un peu reculée, qui dégage le front.
      part(new THREE.SphereGeometry(0.29, 8, 4, 0, Math.PI * 2, 0, Math.PI * 0.5).rotateX(-0.35).translate(0, 2.02, -0.03), hair),
    );
  }
  g.add(piece(body, 0.04));
  if (!agent) {
    // Les yeux, sans contour (sinon le liseré les grossit en lunettes).
    g.add(piece([
      part(new THREE.SphereGeometry(0.032, 6, 4).scale(1, 1.3, 0.6).translate(-0.09, 1.99, 0.262), '#1d2533'),
      part(new THREE.SphereGeometry(0.032, 6, 4).scale(1, 1.3, 0.6).translate(0.09, 1.99, 0.262), '#1d2533'),
    ], 0));
  }
  if (agent) {
    // Les yeux de l'écran restent lumineux.
    for (const s of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.02), new THREE.MeshBasicMaterial({ color: '#5ff2ff' }));
      eye.position.set(s * 0.11, 2.0, 0.25);
      g.add(eye);
    }
  }
  return g;
}
