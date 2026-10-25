// Souvenirs : les traces GPS des sorties (data/tracks.json, produit par tools/gpx_import.py ou tools/strava_sync.py)
// dessinées au sol, une couleur par personne. Case « Traces » dans le panneau Défis pour les masquer.
import * as THREE from 'three';

const COLORS = ['#ff6a4d', '#4d7cff', '#ffc845', '#2f9e55', '#a25dd9', '#16b5b0', '#e8648a'];
const colorOf = (who) => { let h = 0; for (const ch of who) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; };

export default {
  id: 'trails',
  async init(ctx) {
    const data = await ctx.loadJSON('data/tracks.json');
    const tracks = data.tracks ?? [];
    if (!tracks.length) return;
    const group = new THREE.Group();
    const T = ctx.city.terrain;
    const people = new Map();
    for (const t of tracks) {
      const pos = [], idx = [];
      const P = t.p.map(([lat, lon]) => ctx.toXZ(lat, lon));
      // Rééchantillonne tous les 6 m pour que le ruban suive le relief.
      const S = [];
      for (let i = 0; i < P.length - 1; i++) {
        const a = P[i], b = P[i + 1], k = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 6));
        for (let m = 0; m < k; m++) S.push([a.x + (b.x - a.x) * m / k, a.z + (b.z - a.z) * m / k]);
      }
      S.push([P[P.length - 1].x, P[P.length - 1].z]);
      for (let i = 0; i < S.length; i++) {
        const [x, z] = S[i], [px, pz] = S[Math.max(i - 1, 0)], [qx, qz] = S[Math.min(i + 1, S.length - 1)];
        const l = Math.hypot(qx - px, qz - pz) || 1, nx = -(qz - pz) / l, nz = (qx - px) / l;
        const y = Math.max(T.h(x, z), ctx.city.surfaceY(x, z) - 0.0) + 1.6; // au-dessus des toits traversés : lisible partout
        pos.push(x + nx * 1.6, y, z + nz * 1.6, x - nx * 1.6, y, z - nz * 1.6);
        if (i < S.length - 1) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: colorOf(t.who), side: THREE.DoubleSide, transparent: true, opacity: 0.9 }));
      group.add(m);
      people.set(t.who, (people.get(t.who) ?? 0) + 1);
    }
    ctx.scene.add(group);
    const board = document.querySelector('.board');
    if (board) {
      const row = document.createElement('div');
      row.className = 'trails';
      row.innerHTML = `<label><input type="checkbox" checked> Traces</label> ${[...people.keys()].map((w) => `<i style="color:${colorOf(w)}">● ${w.replace(/</g, '&lt;')}</i>`).join(' ')}`;
      row.querySelector('input').addEventListener('change', (e) => { group.visible = e.target.checked; });
      board.appendChild(row);
    }
  },
};
