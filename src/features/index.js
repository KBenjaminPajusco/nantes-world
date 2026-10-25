// Registre des fonctionnalités « blagues et défis » : un module par idée, branché ici.
// Un module exporte { id, init(ctx), update(ctx, dt) }. Voir .claude/skills/nantes-map-feature/SKILL.md.
import challenges from './challenges.js?v=20261025163310';
import trails from './trails.js?v=20261025163310';

const FEATURES = [challenges, trails];

export async function initFeatures(ctx) {
  for (const f of FEATURES) {
    try { await f.init?.(ctx); } catch (err) { console.error(`[feature ${f.id}]`, err); }
  }
}

export function updateFeatures(ctx, dt) {
  for (const f of FEATURES) {
    try { f.update?.(ctx, dt); } catch (err) { console.error(`[feature ${f.id}]`, err); f.update = null; }
  }
}
