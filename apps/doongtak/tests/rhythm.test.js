import test from 'node:test';
import assert from 'node:assert/strict';
import { patternFor, createPhrase, findNearestNote, adaptLevel, clampLevel, HIT_WINDOW, STEP_SECONDS } from '../dist/rhythm.js';

test('patterns increase gently and copied arrays do not mutate originals', () => {
  const counts = [0, 1, 2, 3].map(l => { const p = patternFor(l); return p.kick.length + p.snare.length; });
  assert.deepEqual(counts, [4, 8, 9, 11]);
  const changed = patternFor(1); changed.kick.push(99); assert.equal(patternFor(1).kick.includes(99), false);
  assert.equal(clampLevel(-3), 0); assert.equal(clampLevel(8), 3);
});
test('target search is forgiving, drum-specific, and never reuses a hit', () => {
  const phrase = createPhrase(0, 1);
  assert.equal(findNearestNote([phrase], 'kick', HIT_WINDOW - .001)?.note.step, 0);
  assert.equal(findNearestNote([phrase], 'kick', HIT_WINDOW + .001), null);
  assert.equal(findNearestNote([phrase], 'snare', 0), null);
  phrase.notes.find(n => n.drum === 'kick' && n.step === 0).hit = true;
  assert.equal(findNearestNote([phrase], 'kick', 0), null);
});
test('target search crosses phrase boundaries and selects nearest', () => {
  const prev = createPhrase(0, 3), next = createPhrase(1, 3);
  const result = findNearestNote([prev, next], 'kick', 16 * STEP_SECONDS - .05);
  assert.equal(result.phrase.index, 1); assert.equal(result.note.step, 0);
});
test('auto adaptation requires two strong phrases, and advances only one level', () => {
  const s = { level: 1, good: 0, hard: 0, locked: false };
  const stats = { matched: 8, total: 8, attempts: 8 };
  const one = adaptLevel(s, stats); assert.equal(one.level, 1); assert.equal(one.good, 1);
  const two = adaptLevel(one, stats); assert.equal(two.level, 2); assert.equal(two.good, 0);
  assert.deepEqual(s, { level: 1, good: 0, hard: 0, locked: false });
});
test('struggling phrases lower level, but silence, spam and locks do not raise it', () => {
  const s = { level: 1, good: 0, hard: 0, locked: false };
  const tough = { matched: 1, total: 8, attempts: 5 };
  assert.equal(adaptLevel(adaptLevel(s, tough), tough).level, 0);
  assert.equal(adaptLevel({ ...s, good: 1 }, { matched: 8, total: 8, attempts: 30 }).level, 1);
  assert.equal(adaptLevel({ ...s, hard: 1 }, { matched: 0, total: 8, attempts: 0 }).level, 1);
  assert.equal(adaptLevel({ ...s, locked: true, good: 1 }, { matched: 8, total: 8, attempts: 8 }).level, 1);
});
test('last phrase omits notes past 60 seconds', () => {
  const final = createPhrase(10, 3); assert.ok(final.notes.length > 0); assert.ok(final.notes.every(n => n.time < 60));
  assert.equal(createPhrase(11, 3).notes.length, 0);
});
