// Défis entre potes : une zone sur la carte, un compteur de passages par personne, un classement.
// Définitions : data/challenges.json. Registre des exploits : data/events.json (source de vérité, versionnée).
// En jeu, entrer dans une zone sous son prénom ajoute un exploit local, à exporter vers events.json.
import * as THREE from 'three';

const NAME_KEY = 'nantes-world-by';
const LOCAL_KEY = 'nantes-world-events-v1';
const COOLDOWN = 90; // s entre deux comptages d'un même défi (il faut sortir de la zone et revenir)

const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* navigation privée */ } };

const st = { defs: [], base: [], local: read(LOCAL_KEY, []), zones: [], inside: new Map(), last: new Map(), el: null };

function scores(challengeId) {
  const sum = new Map();
  for (const e of [...st.base, ...st.local]) {
    if (e.challenge !== challengeId) continue;
    sum.set(e.who, (sum.get(e.who) ?? 0) + (e.n ?? 1));
  }
  return [...sum.entries()].sort((a, b) => b[1] - a[1]);
}

function render(ctx) {
  const who = localStorage.getItem(NAME_KEY) || '';
  const medals = ['👑', '🥈', '🥉'];
  st.el.innerHTML = `<h4>Défis</h4>
    <label class="who">Moi : <input value="${who.replace(/"/g, '&quot;')}" placeholder="ton prénom" maxlength="20"></label>
    ${st.defs.map((d) => {
      const rows = scores(d.id);
      return `<div class="ch"><b>${d.emoji} ${d.title}</b>
        <ol>${rows.length ? rows.slice(0, 5).map(([n, c], i) => `<li>${medals[i] ?? ''} ${n.replace(/</g, '&lt;')} <i>${c} ${d.unit || '×'}</i></li>`).join('') : '<li>Personne encore…</li>'}</ol></div>`;
    }).join('')}
    <button class="copy">Copier mes exploits</button>`;
  st.el.querySelector('input').addEventListener('change', (e) => { try { localStorage.setItem(NAME_KEY, e.target.value.trim()); } catch { /* ok */ } });
  st.el.querySelector('.copy').addEventListener('click', async () => {
    if (!st.local.length) return ctx.ui.toast('Aucun exploit local à copier.');
    await navigator.clipboard.writeText(JSON.stringify(st.local, null, 2));
    ctx.ui.toast('Exploits copiés : colle-les à Benjamin (ou dans data/events.json).');
  });
}

export default {
  id: 'challenges',
  async init(ctx) {
    const [defs, events] = await Promise.all([ctx.loadJSON('data/challenges.json'), ctx.loadJSON('data/events.json')]);
    st.defs = defs.challenges ?? [];
    st.base = events.events ?? [];
    st.el = document.createElement('aside');
    st.el.className = 'board';
    document.body.appendChild(st.el);
    for (const d of st.defs) {
      const { x, z } = ctx.toXZ(d.lat, d.lon);
      // Colonne lumineuse + anneau au sol, pour repérer la zone de loin.
      const col = new THREE.Color(d.color || '#ffc845');
      const g = new THREE.Group();
      g.position.set(x, ctx.city.terrain.h(x, z), z);
      g.add(new THREE.Mesh(new THREE.RingGeometry(d.radius - 1.5, d.radius, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.85, side: THREE.DoubleSide })).translateY(0.6));
      g.add(new THREE.Mesh(new THREE.CylinderGeometry(d.radius * 0.5, d.radius * 0.5, 160, 20, 1, true), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false })).translateY(80));
      ctx.scene.add(g);
      st.zones.push({ d, x, z, g });
    }
    render(ctx);
  },
  update(ctx, dt) {
    const who = localStorage.getItem(NAME_KEY);
    const now = performance.now() / 1000;
    for (const z of st.zones) {
      z.g.children[0].rotation.y += dt * 0.6;
      // En vol, il faut descendre sous maxAlt (m au-dessus du sol) pour que le passage compte.
      const inside = Math.hypot(ctx.walker.pos.x - z.x, ctx.walker.pos.y - z.z) < z.d.radius && ctx.walker.agl < (z.d.maxAlt ?? 1e9);
      const was = st.inside.get(z.d.id) ?? false;
      st.inside.set(z.d.id, inside);
      if (!inside || was) continue;
      // Entrée dans la zone : on compte si un prénom est renseigné et si le délai est passé.
      if (!who) { ctx.ui.toast(`${z.d.emoji} ${z.d.title} — entre ton prénom dans « Défis » pour compter tes passages.`); continue; }
      if (now - (st.last.get(z.d.id) ?? -1e9) < COOLDOWN) continue;
      st.last.set(z.d.id, now);
      st.local.push({ challenge: z.d.id, who, date: new Date().toISOString().slice(0, 10), n: 1 });
      write(LOCAL_KEY, st.local);
      ctx.ui.toast(`${z.d.emoji} +1 ${z.d.title} pour ${who} !`);
      ctx.ui.burst?.(z.x, z.z, z.d.color);
      render(ctx);
    }
  },
};
