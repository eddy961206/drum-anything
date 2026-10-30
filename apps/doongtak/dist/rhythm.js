/** Pure timing/pattern helpers, also exercised by node --test. */
export const BPM = 88;
export const STEP_SECONDS = 60 / BPM / 2;
export const PHRASE_STEPS = 16;
export const ROUND_SECONDS = 60;
export const HIT_WINDOW = 0.19;
export const MAX_LEVEL = 3;
const patterns = [
  { kick: [0, 8], snare: [4, 12] },
  { kick: [0, 4, 8, 12], snare: [2, 6, 10, 14] },
  { kick: [0, 4, 7, 8, 12], snare: [2, 6, 10, 14] },
  { kick: [0, 3, 4, 7, 8, 12, 15], snare: [2, 6, 10, 14] },
];
export function clampLevel(level) { return Math.max(0, Math.min(MAX_LEVEL, Math.round(level))); }
export function patternFor(level) { const p = patterns[clampLevel(level)]; return { kick: [...p.kick], snare: [...p.snare] }; }
export function createPhrase(index, level) {
  const pattern = patternFor(level);
  const start = index * PHRASE_STEPS * STEP_SECONDS;
  const notes = Object.entries(pattern).flatMap(([drum, steps]) => steps.map(step => ({ drum, step, time: start + step * STEP_SECONDS, hit: false }))).filter(n => n.time < ROUND_SECONDS - 1e-8);
  return { index, level, pattern, notes, attempts: 0, matched: 0, finalized: false };
}
export function findNearestNote(phrases, drum, time, window = HIT_WINDOW) {
  let best = null; let distance = window;
  for (const phrase of phrases) for (const note of phrase.notes) {
    const delta = Math.abs(note.time - time);
    if (note.drum === drum && !note.hit && delta <= distance) { best = { note, phrase, delta }; distance = delta; }
  }
  return best;
}
/** Two consecutive clear phrases are required; silence never triggers a change. */
export function adaptLevel(state, stats) {
  const next = { ...state };
  if (state.locked || stats.attempts < 3 || stats.total === 0) return { ...next, good: 0, hard: 0 };
  const completion = stats.matched / stats.total;
  const precision = stats.matched / stats.attempts;
  next.good = completion >= .85 && precision >= .72 ? state.good + 1 : 0;
  next.hard = completion < .45 && precision < .6 ? state.hard + 1 : 0;
  if (next.good >= 2) { next.level = clampLevel(state.level + 1); next.good = 0; next.hard = 0; }
  if (next.hard >= 2) { next.level = clampLevel(state.level - 1); next.good = 0; next.hard = 0; }
  return next;
}
