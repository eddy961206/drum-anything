import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioEngine } from '../dist/audio.js';

class Param {
  constructor() { this.value = 0; this.calls = []; }
  setValueAtTime(v, t) { this.calls.push(['set', v, t]); }
  exponentialRampToValueAtTime(v, t) { assert.ok(v > 0); this.calls.push(['ramp', v, t]); }
  setTargetAtTime(v, t, c) { this.calls.push(['target', v, t, c]); }
}
class Node {
  constructor(context) {
    this.ctx = context; this.connections = []; this.disconnected = false;
    for (const param of ['gain', 'frequency', 'Q', 'threshold', 'knee', 'ratio', 'attack', 'release']) this[param] = new Param();
  }
  connect(node) { this.connections.push(node); }
  disconnect() { this.disconnected = true; this.connections = []; }
  start(t) { this.started = t; this.ctx.started.push(this); }
  stop(t) { this.stopped = t ?? this.ctx.currentTime; this.stopCount = (this.stopCount || 0) + 1; }
  end() { this.onended?.(); }
}
class Context {
  constructor() { this.state = 'suspended'; this.currentTime = 3; this.sampleRate = 8000; this.destination = {}; this.nodes = []; this.started = []; this.listeners = new Set(); this.resumes = 0; }
  node() { const n = new Node(this); this.nodes.push(n); return n; }
  createGain() { return this.node(); }
  createDynamicsCompressor() { return this.node(); }
  createOscillator() { return this.node(); }
  createBiquadFilter() { return this.node(); }
  createBufferSource() { return this.node(); }
  createBuffer(channels, count) { const data = new Float32Array(count); return { getChannelData: () => data }; }
  addEventListener(type, listener) { this.listeners.add(listener); }
  removeEventListener(type, listener) { this.listeners.delete(listener); }
  changeState(state) { this.state = state; for (const l of this.listeners) l(); }
  async resume() { this.resumes++; this.changeState('running'); }
  async suspend() { this.changeState('suspended'); }
  async close() { this.changeState('closed'); }
}
function setup() { const ctx = new Context(); return { ctx, engine: new AudioEngine({ contextFactory: () => ctx }) }; }

test('audio is lazy and safe before first gesture; concurrent unlock shares context', async () => {
  let count = 0; const ctx = new Context();
  const engine = new AudioEngine({ contextFactory: () => { count++; return ctx; } });
  assert.equal(count, 0);
  assert.equal(engine.hit('kick'), false);
  assert.equal(engine.bass(36, 0, 0.2), false);
  assert.equal(engine.now(), 0);
  await Promise.all([engine.unlock(), engine.unlock(), engine.unlock()]);
  assert.equal(count, 1); assert.equal(ctx.resumes, 1); assert.equal(engine.now(), 3);
});

test('all original voices schedule in audio time and naturally clean every voice node', async () => {
  const { ctx, engine } = setup(); await engine.unlock();
  engine.hit('kick', 3.2); engine.hit('snare', 3.3);
  for (const mood of ['lofi', 'funky', 'chill']) {
    engine.bass(36, 3.4, 0.3, mood); engine.chord([60, 64, 67], 3.5, 0.7, mood);
  }
  engine.hat(3.6); engine.click(3.7, true);
  assert.equal(engine.activeVoiceCount, 17);
  assert.ok(ctx.started.every(n => Number.isFinite(n.started) && n.started >= ctx.currentTime && n.stopped > n.started));
  const voiceNodes = ctx.nodes.slice(6);
  for (const n of [...ctx.started]) n.end();
  assert.equal(engine.activeVoiceCount, 0);
  assert.ok(voiceNodes.every(n => n.disconnected));
});

test('stopAll silences future sources immediately; repeat cleanup is safe', async () => {
  const { ctx, engine } = setup(); await engine.unlock();
  engine.hit('kick', 9); engine.chord([60, 64, 67], 8, 3);
  assert.equal(engine.activeVoiceCount, 4);
  engine.stopAll(); engine.stopAll();
  assert.equal(engine.activeVoiceCount, 0);
  assert.ok(ctx.started.every(n => n.disconnected && n.stopped === ctx.currentTime && n.onended === null));
});

test('96-source cap bounds rapid taps and evicts oldest scheduled sound', async () => {
  const { ctx, engine } = setup(); await engine.unlock();
  for (let i = 0; i < 300; i++) engine.hit('snare');
  assert.equal(engine.activeVoiceCount, 96);
  assert.ok(ctx.started[0].disconnected);
  engine.stopAll(); assert.equal(engine.activeVoiceCount, 0);
});

test('volume clamps and zero mute work before/after unlock without changing scheduling', async () => {
  const { ctx, engine } = setup();
  assert.equal(engine.setVolume('bass', 3), true); assert.equal(engine.setVolume('not-a-part', 1), false);
  assert.equal(engine.setVolume('toString', 1), false); assert.equal(engine.setVolume('__proto__', 1), false);
  await engine.unlock();
  assert.equal(engine._buses.bass.gain.value, 1);
  engine.setVolume('bass', -4); assert.equal(engine._buses.bass.gain.calls.at(-1)[1], 0);
  engine.setVolume('master', 9); assert.equal(engine._master.gain.calls.at(-1)[1], 0.65);
  engine.hit('kick'); assert.equal(ctx.started.length, 1);
});

test('invalid and oversized inputs are bounded; unknown hits and zero velocity are silent', async () => {
  const { ctx, engine } = setup(); await engine.unlock();
  assert.equal(engine.hit('tom'), false); assert.equal(engine.hit('kick', 3, 0), false);
  assert.equal(engine.hat(3, 0), false); assert.equal(engine.bass(NaN, 3, 1), false);
  assert.equal(engine.chord([NaN, Infinity], 3, 1), false);
  engine.chord(new Array(100).fill(60), -9, 999);
  assert.equal(ctx.started.length, 5);
  assert.ok(ctx.started.every(n => n.started === 3 && n.stopped < 8.1));
});

test('browser interruption clears pending voices and resume starts clean', async () => {
  const { ctx, engine } = setup(); await engine.unlock();
  engine.hit('kick', 6); ctx.changeState('interrupted');
  assert.equal(engine.activeVoiceCount, 0); assert.equal(engine.hit('kick'), false);
  await engine.unlock(); assert.equal(engine.activeVoiceCount, 0); assert.equal(engine.hit('kick'), true);
  await engine.suspend(); assert.equal(engine.activeVoiceCount, 0); assert.equal(ctx.state, 'suspended');
});

test('suspend during pending resume cancels startup instead of leaving background audio', async () => {
  const { ctx, engine } = setup(); let resolve;
  ctx.resume = () => new Promise(r => { resolve = () => { ctx.changeState('running'); r(); }; });
  const pending = engine.unlock(); await engine.suspend(); resolve();
  await assert.rejects(pending, /취소/); assert.equal(ctx.state, 'suspended');
});

test('resume failure can retry; close releases graph and cannot reopen', async () => {
  const { ctx, engine } = setup(); let first = true;
  ctx.resume = async () => { if (first) { first = false; throw new Error('blocked'); } ctx.changeState('running'); };
  await assert.rejects(engine.unlock(), /blocked/); await engine.unlock();
  engine.hit('kick'); await engine.close(); await engine.close();
  assert.equal(ctx.state, 'closed'); assert.equal(engine.activeVoiceCount, 0);
  assert.equal(ctx.listeners.size, 0); assert.ok(ctx.nodes.every(n => n.disconnected));
  await assert.rejects(engine.unlock(), /닫혔/);
});
