import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_NOTES, bpmValue, quantize, cleanNotes, tapBpm, demoPattern, makeEvents, BandTransport } from '../dist/rhythm.js';

const near = (a, b, epsilon = 1e-9) => assert.ok(Math.abs(a - b) < epsilon, `${a} ≈ ${b}`);
class FakeAudio {
  constructor() { this.time = 0; this.calls = []; this.stops = 0; }
  now() { return this.time; }
  stopAll() { this.stops++; }
  hit(kind, at, velocity) { this.calls.push({ kind, at, velocity }); }
  bass(midi, at, duration, mood) { this.calls.push({ kind: 'bass', midi, at, duration, mood }); }
  chord(midis, at, duration, mood) { this.calls.push({ kind: 'chord', midis, at, duration, mood }); }
  hat(at, velocity) { this.calls.push({ kind: 'hat', at, velocity }); }
  click(at, accent) { this.calls.push({ kind: 'click', at, accent }); }
}
function rig() {
  const audio = new FakeAudio(), changes = [];
  const band = new BandTransport(audio, reason => changes.push(reason));
  band.settings.bpm = 120;
  return { audio, changes, band };
}
const userPattern = () => ({ bars: 1, notes: [{ kind: 'kick', beat: 0.13 }, { kind: 'snare', beat: 1.77 }], source: 'user' });

test('BPM validation bounds values, rounds, and preserves fallback on empty/invalid input', () => {
  assert.equal(bpmValue(39), 50); assert.equal(bpmValue(250), 180);
  assert.equal(bpmValue('109.7'), 110); assert.equal(bpmValue('bad', 105), 105);
  for (const x of [undefined, NaN, Infinity, '', 0, -3]) assert.equal(bpmValue(x), 92);
});

test('tap tempo uses median intervals, excludes implausible gaps, and needs two taps', () => {
  assert.equal(tapBpm([]), null); assert.equal(tapBpm([100]), null);
  assert.equal(tapBpm([0, 500, 1000, 1500, 9000]), 120);
  assert.equal(tapBpm([0, 600, 1200]), 100);
  assert.equal(tapBpm([0, 5, 10]), null);
  assert.equal(tapBpm([0, 250, 500]), 180);
});

test('quantization off/partial/full keeps notes inside loop and handles final subdivision wrap', () => {
  near(quantize(1.13, 0, 4), 1.13); near(quantize(1.13, 0.5, 4), 1.19);
  assert.equal(quantize(1.13, 1, 4), 1.25);
  assert.equal(quantize(3.99, 1, 4), 0);
  assert.equal(quantize(7.99, 1, 8), 0);
  near(quantize(1.13, -3, 4), 1.13); assert.equal(quantize(1.13, 5, 4), 1.25);
});

test('clean notes reject invalid inputs, preserve offbeats, copy records, and enforce cap', () => {
  const raw = { kind: 'snare', beat: 1.17321, extra: 'unused' };
  assert.deepEqual(cleanNotes([raw, {kind:'tom',beat:1}, {kind:'kick',beat:NaN}, {kind:'kick',beat:-1}, {kind:'kick',beat:4}], 4), [{kind:'snare',beat:1.17321}]);
  assert.equal(cleanNotes(Array.from({length: 300}, () => raw), 4).length, MAX_NOTES);
  assert.notEqual(cleanNotes([raw], 4)[0], raw);
});

test('demo has explicit demo provenance and original two-bar expansion', () => {
  const one = demoPattern(1), two = demoPattern(2);
  assert.equal(one.source, 'demo'); assert.equal(two.bars, 2);
  assert.equal(two.notes.length, one.notes.length * 2);
  assert.deepEqual(two.notes.slice(one.notes.length), one.notes.map(n => ({ ...n, beat: n.beat + 4 })));
});

test('accompaniment adds no fabricated user drums and never accompanies an empty take', () => {
  assert.deepEqual(makeEvents({bars:1, notes:[], source:'user'}, 1, 'funky'), []);
  for (const mood of ['lofi', 'funky', 'chill']) {
    const pattern = userPattern(), before = JSON.stringify(pattern);
    const events = makeEvents(pattern, 0, mood);
    const drums = events.filter(e => e.part === 'drums');
    assert.equal(drums.length, pattern.notes.length);
    drums.forEach((n,i) => { assert.equal(n.kind, pattern.notes[i].kind); near(n.beat, pattern.notes[i].beat); });
    assert.ok(events.some(e => e.kind === 'bass')); assert.ok(events.some(e => e.kind === 'chord')); assert.ok(events.some(e => e.kind === 'hat'));
    assert.equal(JSON.stringify(pattern), before);
    assert.ok(events.every(e => e.beat >= 0 && e.beat < 4));
  }
});

test('bass rhythm follows real kick onsets, and changing quantization is fully reversible', () => {
  const pattern = {bars:1, notes:[{kind:'kick',beat:.163},{kind:'snare',beat:1.81},{kind:'kick',beat:2.52}], source:'user'};
  const before = JSON.stringify(pattern);
  const raw = makeEvents(pattern, 0, 'lofi');
  const tight = makeEvents(pattern, 1, 'lofi');
  assert.deepEqual(raw.filter(e => e.kind === 'bass').map(e=>e.beat), raw.filter(e => e.kind === 'kick').map(e=>e.beat));
  assert.deepEqual(tight.filter(e => e.kind === 'bass').map(e=>e.beat), [.25,2.5]);
  assert.deepEqual(makeEvents(pattern, 0, 'lofi'), raw);
  assert.equal(JSON.stringify(pattern), before);
});

test('one-bar count-in lasts exactly four beats and rejects pre-recording taps', () => {
  const { audio, changes, band } = rig(); band.record(1);
  assert.equal(band.mode, 'countin'); near(band.recordStart, 2.08);
  audio.time = band.recordStart - 0.000001; assert.equal(band.hit('kick'), false);
  assert.equal(band.captured.length, 0);
  audio.time = band.recordStart; assert.equal(band.hit('kick'), true);
  assert.equal(band.mode, 'recording'); assert.equal(band.captured[0].beat, 0);
  audio.time = band.recordStart + 2; assert.equal(band.hit('snare'), false);
  band.tick(); assert.equal(band.mode, 'playing'); assert.equal(band.pattern.notes.length, 1);
  assert.equal(band.pattern.source, 'user'); assert.ok(changes.includes('saved'));
});

test('two-bar capture keeps exact offbeat beat values and ends at eight beats', () => {
  const { audio, band } = rig(); band.record(2);
  const at = band.recordStart + 2.123456789;
  audio.time = at; assert.equal(band.hit('snare'), true);
  const exact = (at - band.recordStart) * band.settings.bpm / 60;
  assert.equal(band.captured[0].beat, exact);
  audio.time = band.recordStart + 4 - 0.00001; band.tick(); assert.equal(band.mode, 'recording');
  audio.time = band.recordStart + 4; band.tick();
  assert.equal(band.pattern.bars, 2); assert.equal(band.pattern.notes[0].beat, exact); assert.equal(band.mode, 'playing');
});

test('empty take stays idle, never invents notes, and preserves previous take', () => {
  for (const previous of [null, userPattern(), demoPattern()]) {
    const { audio, changes, band } = rig(); band.pattern = previous; band.record(1);
    audio.time = band.recordStart + 2; band.tick();
    assert.equal(band.mode, 'idle'); assert.equal(band.pattern, previous); assert.ok(changes.includes('empty'));
    assert.equal(audio.calls.filter(e => ['kick','snare','bass','chord','hat'].includes(e.kind)).length, 0);
  }
});

test('metronome always counts in, and recording clicks only when enabled', () => {
  for (const metronome of [false,true]) {
    const { audio, band } = rig(); band.settings.metronome = metronome; band.record(1);
    for (let beat = 0; beat < 8; beat++) { audio.time = band.start + beat * .5; band.tick(); }
    assert.equal(audio.calls.filter(e => e.kind === 'click').length, metronome ? 8 : 4);
  }
});

test('stop cancels count-in and recording without committing unfinished notes', () => {
  for (const capture of [false,true]) {
    const { audio, changes, band } = rig(); const old = userPattern(); band.pattern = old; band.record(2);
    if (capture) { audio.time = band.recordStart; band.hit('snare'); }
    band.stop('hidden'); assert.equal(band.mode, 'idle'); assert.equal(band.pattern, old); assert.deepEqual(band.captured, []);
    audio.calls = []; audio.time += 100; band.tick(); assert.deepEqual(audio.calls, []);
    assert.ok(changes.includes('cancel')); assert.equal(band.reason, 'hidden');
  }
});

test('overdub plays existing actual take, appends rather than replaces, and undo restores it', () => {
  const { audio, band } = rig(); const old = userPattern(); band.pattern = old; band.record(2, true);
  assert.equal(band.bars, 1); assert.equal(band.overdub, true);
  audio.time = band.recordStart + 0.065; band.tick();
  assert.ok(audio.calls.some(e => e.kind === 'kick'));
  audio.time = band.recordStart + .5; assert.equal(band.hit('snare'), true);
  audio.time = band.recordStart + 2; band.tick();
  assert.equal(band.pattern.notes.length, 3); assert.deepEqual(band.pattern.notes.slice(0,2), old.notes);
  assert.equal(band.undo(), true); assert.equal(band.pattern, old); assert.equal(band.mode, 'idle'); assert.equal(band.undo(), false);
});

test('demo cannot masquerade as user overdub; replacing it records only new taps', () => {
  const { audio, band } = rig(); band.pattern = demoPattern(); band.record(1, true);
  assert.equal(band.overdub, false);
  audio.time = band.recordStart + .2; band.hit('snare');
  audio.time = band.recordStart + 2; band.tick();
  assert.equal(band.pattern.source, 'user'); assert.equal(band.pattern.notes.length, 1); assert.equal(band.pattern.notes[0].kind, 'snare');
});

test('new recording and overdub both enforce 128 total captured notes', () => {
  for (const base of [0, 127, 128]) {
    const { audio, band } = rig();
    if (base) band.pattern = {bars:1, source:'user', notes:Array.from({length:base}, (_,i)=>({kind:'kick',beat:i/40}))};
    band.record(1, !!base); audio.time = band.recordStart + .25;
    let accepted = 0; for (let i=0;i<200;i++) accepted += band.hit('snare') ? 1 : 0;
    assert.equal(accepted, MAX_NOTES - base);
    audio.time = band.recordStart + 2; band.tick(); assert.equal(band.pattern.notes.length, MAX_NOTES);
  }
});

test('playback schedules in audio time, loops without duplicating hits, and stops cleanly', () => {
  const { audio, band } = rig(); const p={bars:1, notes:[{kind:'kick',beat:0}], source:'user'};
  assert.equal(band.play(p), true); const start = band.start;
  assert.equal(audio.calls.filter(e=>e.kind==='kick').length, 1);
  band.tick(); assert.equal(audio.calls.filter(e=>e.kind==='kick').length, 1);
  audio.time = start + 2; band.tick(); assert.equal(audio.calls.filter(e=>e.kind==='kick').length, 2);
  near(audio.calls.filter(e=>e.kind==='kick')[1].at, start + 2);
  band.stop(); audio.calls=[]; audio.time += 10; band.tick(); assert.deepEqual(audio.calls, []);
});

test('large scheduler stalls skip stale cycles rather than bursting missed notes', () => {
  const { audio, band } = rig(); band.play(demoPattern(2)); audio.calls=[];
  audio.time = band.start + 4000 + .8; band.tick();
  assert.ok(band.cycle >= 1000); assert.ok(audio.calls.length < 10);
  assert.ok(audio.calls.every(e => e.at >= audio.time && e.at <= audio.time + .1));
});

test('transport positions respect BPM and wrap through selected bar length', () => {
  const { audio, band } = rig(); band.settings.bpm=60; band.play(demoPattern(2));
  audio.time=band.start+9.25; near(band.position(),1.25);
  band.stop(); assert.equal(band.position(),0);
  band.record(1); audio.time=band.recordStart+1.25; band.tick(); near(band.position(),1.25);
});
