import test from 'node:test';
import assert from 'node:assert/strict';
import { DrumAudio } from '../dist/audio.js';

// These mocks verify scheduling/lifecycle contracts, not audible quality or
// browser autoplay policy. A real gesture + listening check still matters.
class MockParam {
  constructor() { this.value = 0; this.events = []; }
  record(method, value, time) {
    assert.ok(Number.isFinite(value));
    assert.ok(Number.isFinite(time));
    this.value = value;
    this.events.push({ method, value, time });
  }
  setValueAtTime(value, time) { this.record('set', value, time); }
  exponentialRampToValueAtTime(value, time) {
    assert.ok(value > 0, 'exponential audio envelopes must remain positive');
    this.record('exponential', value, time);
  }
  linearRampToValueAtTime(value, time) { this.record('linear', value, time); }
  setTargetAtTime(value, time) { this.record('target', value, time); }
  cancelScheduledValues(time) { this.events.push({ method: 'cancel', time }); }
  cancelAndHoldAtTime(time) { this.events.push({ method: 'hold', time }); }
}

class MockNode {
  constructor(context, kind) {
    this.context = context;
    this.kind = kind;
    this.connections = [];
    this.disconnected = false;
    this.stopTimes = [];
    for (const key of ['gain', 'frequency', 'detune', 'threshold', 'knee', 'ratio', 'attack', 'release']) {
      this[key] = new MockParam();
    }
    context.nodes.push(this);
  }
  connect(node) { this.connections.push(node); return node; }
  disconnect() { this.disconnected = true; this.connections.length = 0; }
  start(time) { this.startTime = time; this.context.sources.push(this); }
  stop(time) { this.stopTimes.push(time); }
}

function installAudioMock(t) {
  const previous = {
    AudioContext: globalThis.AudioContext,
    webkitAudioContext: globalThis.webkitAudioContext,
  };
  const contexts = [];
  class MockAudioContext {
    constructor(options) {
      this.options = options;
      this.state = 'suspended';
      this.currentTime = 1;
      this.sampleRate = 48000;
      this.nodes = [];
      this.sources = [];
      this.destination = new MockNode(this, 'destination');
      this.resumeCalls = 0;
      this.suspendCalls = 0;
      contexts.push(this);
    }
    createGain() { return new MockNode(this, 'gain'); }
    createDynamicsCompressor() { return new MockNode(this, 'compressor'); }
    createOscillator() { return new MockNode(this, 'oscillator'); }
    createBiquadFilter() { return new MockNode(this, 'filter'); }
    createBufferSource() { return new MockNode(this, 'buffer-source'); }
    createBuffer(channels, length, sampleRate) {
      assert.equal(channels, 1);
      assert.equal(sampleRate, this.sampleRate);
      const data = new Float32Array(length);
      return { getChannelData: () => data };
    }
    async resume() { this.resumeCalls++; this.state = 'running'; }
    async suspend() { this.suspendCalls++; this.state = 'suspended'; }
  }
  globalThis.AudioContext = MockAudioContext;
  delete globalThis.webkitAudioContext;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  return contexts;
}

test('audio unlock is lazy, gesture-resumable and does not create duplicate contexts', async (t) => {
  const contexts = installAudioMock(t);
  const audio = new DrumAudio();
  assert.equal(audio.state, 'closed');
  assert.equal(audio.currentTime, 0);
  audio.kick(); audio.snare(); audio.hat();
  assert.equal(contexts.length, 0);
  await audio.unlock();
  await audio.unlock();
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].options.latencyHint, 'interactive');
  assert.equal(contexts[0].resumeCalls, 1);
  assert.equal(audio.state, 'running');
  assert.equal(audio.currentTime, 1);
  assert.deepEqual(audio.master.connections, [audio.compressor]);
  assert.deepEqual(audio.compressor.connections, [audio.context.destination]);
});

test('volume is bounded, mute is reversible, and settings apply before unlock', async (t) => {
  installAudioMock(t);
  const audio = new DrumAudio();
  audio.setVolume(2); assert.equal(audio.volume, 1);
  audio.setVolume(-1); assert.equal(audio.volume, 0);
  audio.setVolume(NaN); assert.equal(audio.volume, 0.62);
  audio.setVolume('0.4'); assert.equal(audio.volume, 0.4);
  audio.setMuted(true);
  await audio.unlock();
  assert.equal(audio.master.gain.value, 0);
  audio.setMuted(false);
  assert.equal(audio.master.gain.value, 0.4 * 0.74);
  audio.setVolume(1);
  assert.equal(audio.master.gain.value, 0.74);
  audio.setMuted(true);
  assert.equal(audio.master.gain.value, 0);
});

test('backing supports the player without automatic kick or snare', async (t) => {
  installAudioMock(t);
  const audio = new DrumAudio();
  await audio.unlock();
  const calls = { hat: [], chord: [], bass: [] };
  audio.kick = () => assert.fail('backing must not replace the player’s kick');
  audio.snare = () => assert.fail('backing must not replace the player’s snare');
  audio.hat = (...args) => calls.hat.push(args);
  audio._chord = (...args) => calls.chord.push(args);
  audio._bass = (...args) => calls.bass.push(args);
  const step = 60 / 88 / 2;
  for (let i = 0; i < 32; i++) audio.scheduleBacking(i, 1 + i * step, step);
  assert.equal(calls.hat.length, 32);
  assert.equal(calls.chord.length, 4);
  assert.equal(calls.bass.length, 16);
  assert.equal(new Set(calls.chord.map(([notes]) => notes.join(','))).size, 4);
  assert.equal(calls.chord[0][1], 1);
  assert.equal(calls.chord[1][1], 1 + 8 * step);
  assert.ok(calls.hat[1][0] > 1 + step, 'offbeat hats have gentle swing');
  audio.scheduleBacking(0, 1, 0);
  audio.scheduleBacking(0, 1, NaN);
  assert.equal(calls.hat.length, 32, 'invalid timing does not schedule audio');
});

test('85 generated sources schedule, cancel, and fully disconnect on completion', async (t) => {
  installAudioMock(t);
  const audio = new DrumAudio();
  await audio.unlock();
  audio.kick(); audio.snare(); audio.hat(1, 0);
  const step = 60 / 88 / 2;
  for (let i = 0; i < 32; i++) audio.scheduleBacking(i, 1 + i * step, step);
  const { sources } = audio.context;
  assert.equal(sources.length, 85);
  assert.equal(audio.voices.size, 55);
  assert.ok(sources.every(source => source.startTime >= audio.currentTime));
  assert.ok(sources.every(source => source.stopTimes[0] > source.startTime));
  const voiceNodes = [...audio.voices].flatMap(voice => voice.nodes);
  const gates = [...audio.voices].map(voice => voice.gate);
  audio.stopAll();
  audio.stopAll();
  assert.ok(sources.every(source => source.stopTimes.length === 2), 'stop is idempotent');
  assert.ok(sources.every(source => source.stopTimes[1] === 1.018));
  assert.ok(gates.every(gate => gate.gain.events.some(event => event.method === 'linear' && event.value === 0)));
  for (const source of sources) source.onended();
  assert.equal(audio.voices.size, 0);
  assert.ok(voiceNodes.every(node => node.disconnected));
});

test('suspend stops queued voices and unlock resumes the same context', async (t) => {
  const contexts = installAudioMock(t);
  const audio = new DrumAudio();
  await audio.suspend(); // Safe before any user gesture.
  await audio.unlock();
  audio.kick(10);
  await audio.suspend();
  assert.equal(audio.state, 'suspended');
  assert.equal(contexts[0].suspendCalls, 1);
  assert.ok(contexts[0].sources.every(source => source.stopTimes.at(-1) === 1.018));
  const count = contexts[0].sources.length;
  audio.snare();
  assert.equal(contexts[0].sources.length, count, 'no voices created while suspended');
  await audio.unlock();
  assert.equal(audio.state, 'running');
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].resumeCalls, 2);
});

test('unsupported Web Audio reports a useful rejection instead of a partial engine', async (t) => {
  installAudioMock(t);
  delete globalThis.AudioContext;
  const audio = new DrumAudio();
  await assert.rejects(audio.unlock(), /Web Audio/);
  assert.equal(audio.context, null);
  assert.equal(audio.state, 'closed');
});
