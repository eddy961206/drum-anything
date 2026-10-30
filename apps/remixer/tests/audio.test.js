import test from 'node:test';
import assert from 'node:assert/strict';
import { RemixAudio } from '../dist/audio.js';
import { bpmFromTaps, nextBeatDelay, normalizeBpm } from '../dist/timing.js';

// These tests assert timing and lifecycle contracts, not browser playback policy
// or audible quality. A real gesture and listening test are still needed.
class Param {
  constructor() { this.value = 0; this.events = []; }
  record(type, value, time) {
    assert.ok(Number.isFinite(value)); assert.ok(Number.isFinite(time));
    this.value = value; this.events.push({ type, value, time });
  }
  setValueAtTime(value, time) { this.record('set', value, time); }
  exponentialRampToValueAtTime(value, time) { assert.ok(value > 0); this.record('exp', value, time); }
  linearRampToValueAtTime(value, time) { this.record('linear', value, time); }
  setTargetAtTime(value, time) { this.record('target', value, time); }
  cancelScheduledValues(time) { this.events.push({ type: 'cancel', time }); }
}

class Node {
  constructor(context, kind) {
    this.context = context; this.kind = kind; this.connections = []; this.stopTimes = [];
    for (const key of ['gain', 'frequency', 'Q', 'threshold', 'knee', 'ratio', 'attack', 'release']) this[key] = new Param();
    context.nodes.push(this);
  }
  connect(node) { this.connections.push(node); return node; }
  disconnect() { this.disconnected = true; this.connections = []; }
  start(time, offset) { this.startTime = time; this.offset = offset; this.context.sources.push(this); }
  stop(time) { this.stopTimes.push(time); }
}

function installMock(t) {
  const previous = { AudioContext: globalThis.AudioContext, webkitAudioContext: globalThis.webkitAudioContext };
  const contexts = [];
  class Context {
    constructor(options) {
      this.options = options; this.state = 'suspended'; this.currentTime = 10;
      this.sampleRate = 8000; this.nodes = []; this.sources = [];
      this.destination = new Node(this, 'destination'); this.resumeCalls = 0;
      this.decode = async () => this.createBuffer(2, 8000 * 20, 8000);
      contexts.push(this);
    }
    createGain() { return new Node(this, 'gain'); }
    createDynamicsCompressor() { return new Node(this, 'compressor'); }
    createBiquadFilter() { return new Node(this, 'filter'); }
    createOscillator() { return new Node(this, 'oscillator'); }
    createBufferSource() { return new Node(this, 'buffer-source'); }
    createBuffer(channels, length, sampleRate) {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return { duration: length / sampleRate, length, sampleRate, numberOfChannels: channels, getChannelData: n => data[n] };
    }
    async resume() { this.resumeCalls++; this.state = 'running'; }
    async close() { this.state = 'closed'; this.closed = true; }
    async decodeAudioData(data) { return this.decode(data); }
  }
  globalThis.AudioContext = Context;
  delete globalThis.webkitAudioContext;
  t.after(() => Object.entries(previous).forEach(([k, v]) => v === undefined ? delete globalThis[k] : globalThis[k] = v));
  return contexts;
}

async function ready(t) {
  installMock(t);
  const audio = new RemixAudio();
  await audio.ensure();
  audio._commitBuffer(audio.context.createBuffer(2, 8000 * 20, 8000));
  return audio;
}

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const file = name => ({ name, size: 8, arrayBuffer: async () => new ArrayBuffer(8) });
const stems = () => Object.fromEntries(['drums', 'bass', 'other', 'vocals'].map(key => [key, file(`${key}.wav`)]));

test('next beat clock and tap tempo use song seconds and wall-clock milliseconds', () => {
  assert.equal(nextBeatDelay(0, 120), 0);
  assert.ok(Math.abs(nextBeatDelay(1.1, 120) - 0.4) < 1e-9);
  assert.ok(Math.abs(nextBeatDelay(1.1, 120, 0.2) - 0.1) < 1e-9);
  assert.equal(nextBeatDelay(0.499, 120), 0);
  assert.equal(nextBeatDelay(NaN, 120), 0);
  assert.equal(bpmFromTaps([1000, 1500, 2000, 2500]), 120);
  assert.equal(bpmFromTaps([1000, 1500, 2000, 3000, 3500]), 120);
  assert.equal(bpmFromTaps([1000]), null);
  assert.equal(bpmFromTaps([1000, 1000]), null);
  assert.equal(bpmFromTaps([1000, 1100, 1200]), null);
  assert.equal(normalizeBpm(500), 220);
  assert.equal(normalizeBpm(-1), 40);
  assert.equal(normalizeBpm(NaN), 104);
});

test('lazy audio creation, bounded mixes, distinct song filter and effect buses', async t => {
  const contexts = installMock(t);
  const audio = new RemixAudio();
  audio.setMaster(2); audio.setEffects(-1); audio.setMuffle(true);
  assert.equal(audio.trigger('kick'), null);
  assert.equal(contexts.length, 0);
  await audio.ensure(); await audio.ensure();
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].resumeCalls, 1);
  assert.equal(audio.master.gain.value, 0.76);
  assert.equal(audio.effects.gain.value, 0);
  assert.equal(audio.songFilter.frequency.value, 460);
  assert.deepEqual(audio.songFilter.connections, [audio.master]);
  assert.deepEqual(audio.effects.connections, [audio.master]);
  audio.setMuffle(false);
  assert.equal(audio.songFilter.frequency.value, 22000);
  assert.equal(audio.playing, false, 'muffle never starts transport');
});

test('single clock transport plays once, pauses at current offset and seeks without overlap', async t => {
  const audio = await ready(t);
  await Promise.all([audio.play(), audio.play()]);
  assert.equal(audio.context.sources.length, 1);
  assert.equal(audio.playing, true);
  const first = audio._source;
  audio.context.currentTime = 12.5;
  assert.equal(audio.position, 2.5);
  audio.pause();
  assert.equal(audio.position, 2.5);
  assert.equal(audio.playing, false);
  assert.equal(first.stopTimes.length, 1);
  assert.equal(first.disconnected, true);
  await audio.play();
  assert.equal(audio._source.offset, 2.5);
  const second = audio._source;
  audio.seek(7);
  assert.equal(audio.position, 7);
  assert.equal(second.stopTimes.length, 1);
  assert.equal(second.disconnected, true);
  assert.equal(audio._source.offset, 7);
  audio.stop();
  assert.equal(audio.position, 0);
  assert.equal(audio.playing, false);
});

test('pause invalidates an unresolved play promise rather than allowing ghost playback', async t => {
  const audio = await ready(t);
  const pending = deferred();
  audio.context.state = 'suspended';
  audio.context.resume = () => pending.promise;
  const play = audio.play();
  audio.pause();
  pending.resolve();
  assert.equal(await play, false);
  assert.equal(audio.playing, false);
  assert.equal(audio.context.sources.length, 0);
});

test('A/B loop maintains position over wraps and disabling it preserves position', async t => {
  const audio = await ready(t);
  audio.setLoop(2, 5, true);
  assert.equal(audio.position, 2);
  await audio.play();
  assert.equal(audio._source.loop, true);
  assert.equal(audio._source.loopStart, 2);
  assert.equal(audio._source.loopEnd, 5);
  audio.context.currentTime = 14;
  assert.equal(audio.position, 3);
  audio.setLoop(2, 5, false);
  assert.equal(audio.position, 3);
  assert.equal(audio._source.loop, false);
  audio.context.currentTime = 15;
  assert.equal(audio.position, 4);
  assert.throws(() => audio.setLoop(5, 5.1, true), /0.25/);
  assert.throws(() => audio.setLoop(10, 5, true), /0.25/);
  audio.setLoop(2, 5, true);
  audio.seek(10);
  assert.ok(audio.position < 5 && audio.position > 4.9);
});

test('quantized effects use AudioContext time, fills are short, paused previews immediate', async t => {
  const audio = await ready(t);
  audio.setBpm(120);
  await audio.play();
  audio.context.currentTime = 10.1;
  const delay = audio.trigger('fill', true);
  assert.ok(Math.abs(delay - 0.4) < 1e-9);
  assert.equal(audio.voices.size, 9);
  const effectSources = audio.context.sources.slice(1);
  assert.ok(effectSources.every(s => s.startTime >= 10.5));
  assert.ok(Math.max(...effectSources.map(s => s.startTime)) <= 11.506);
  audio.pause();
  assert.equal(audio.voices.size, 0);
  assert.ok(effectSources.every(s => s.disconnected));
  assert.ok(effectSources.every(s => s.stopTimes.at(-1) === 10.1));
  assert.equal(audio.trigger('snare', true), 0);
  assert.equal(audio.voices.size, 1);
  assert.equal(audio.playing, false);
  assert.equal(audio.trigger('unknown'), null);
});

test('BPM, alignment, seek and pause cancel pending effects; pause restores held filter', async t => {
  const audio = await ready(t);
  await audio.play();
  for (const action of [() => audio.setBpm(130), () => audio.alignBeat(), () => audio.seek(8), () => audio.pause()]) {
    audio.trigger('fill');
    assert.ok(audio.voices.size > 0);
    audio.setMuffle(true);
    action();
    assert.equal(audio.voices.size, 0);
  }
  assert.equal(audio.muffled, false);
  assert.equal(audio.songFilter.frequency.value, 22000);
  audio.cancelPendingEffects();
  assert.equal(audio.voices.size, 0);
});

test('official embed clock quantizes effects against AudioContext time without a local song', async t => {
  const audio = await ready(t);
  audio.setBpm(120);
  assert.equal(audio.playing, false);
  audio.context.currentTime = 10;
  const delay = audio.trigger('kick', true, { position: 27.1, playing: true, anchor: 0 });
  assert.ok(Math.abs(delay - 0.4) < 1e-9);
  assert.ok(Math.abs(audio.context.sources.at(-1).startTime - 10.405) < 1e-9);
  audio.cancelPendingEffects();
  const aligned = audio.trigger('snare', true, { position: 27.1, playing: true, anchor: 27 });
  assert.ok(Math.abs(aligned - 0.4) < 1e-9);
  assert.equal(audio.playing, false, 'external timing never starts the local transport');
  audio.cancelPendingEffects();
  assert.equal(audio.trigger('kick', true, { position: 27.1, playing: false, anchor: 0 }), 0);
  assert.equal(audio.trigger('kick', false, { position: 27.1, playing: true, anchor: 0 }), 0);
  assert.equal(audio.trigger('kick', true, { position: NaN, playing: true, anchor: 0 }), 0);
  audio.cancelPendingEffects();
  assert.equal(audio.voices.size, 0, 'embed pause/seek can cancel every queued voice');
});

test('finished voices and natural transport completion fully clean up', async t => {
  const audio = await ready(t);
  audio.trigger('crash');
  const sources = [...audio.context.sources];
  assert.equal(audio.voices.size, 1);
  sources.forEach(source => source.onended());
  assert.equal(audio.voices.size, 0);
  assert.ok(sources.every(source => source.disconnected));
  await audio.play();
  let ended = 0;
  audio.onend = () => ended++;
  audio.trigger('fill');
  audio._source.onended();
  assert.equal(ended, 1);
  assert.equal(audio.position, 20);
  assert.equal(audio.playing, false);
  assert.equal(audio.voices.size, 0);
  await audio.play();
  assert.equal(audio._source.offset, 0);
});

test('load errors are useful, failed load retains paused old music, and no upload happens', async t => {
  const audio = await ready(t);
  const old = audio.buffer;
  await assert.rejects(audio.loadFile({ size: 0, arrayBuffer: async () => new ArrayBuffer(0) }), /비어/);
  await assert.rejects(audio.loadFile({ size: 51 * 1024 * 1024, arrayBuffer: async () => new ArrayBuffer(0) }), /50 MB/);
  audio.context.decode = async () => { throw new Error('unsupported codec'); };
  await audio.play();
  await assert.rejects(audio.loadFile(file('bad.foo')), /MP3, WAV, M4A/);
  assert.equal(audio.buffer, old);
  assert.equal(audio.playing, false);
});

test('stale decode cannot overwrite a later song selection', async t => {
  const audio = await ready(t);
  const firstDecode = deferred();
  let calls = 0;
  audio.context.decode = () => ++calls === 1 ? firstDecode.promise : Promise.resolve(audio.context.createBuffer(1, 8000 * 6, 8000));
  const first = audio.loadFile(file('first.mp3'));
  await Promise.resolve(); await Promise.resolve();
  const second = await audio.loadFile(file('second.mp3'));
  assert.equal(second.name, 'second.mp3');
  firstDecode.resolve(audio.context.createBuffer(1, 8000 * 9, 8000));
  assert.equal(await first, null);
  assert.equal(audio.duration, 6);
});

test('original demo contains deterministic stereo audio with safe peaks, loads without autoplay', async t => {
  installMock(t);
  const audio = new RemixAudio();
  const result = await audio.loadDemo();
  assert.equal(result.name, 'Midnight Window');
  assert.equal(result.bpm, 104);
  assert.ok(result.duration > 36.9 && result.duration < 37);
  assert.equal(audio.playing, false);
  assert.equal(audio.context.sources.length, 0);
  const data = audio.buffer.getChannelData(0);
  let peak = 0, energy = 0;
  for (const value of data) { assert.ok(Number.isFinite(value)); peak = Math.max(peak, Math.abs(value)); energy += value * value; }
  assert.ok(peak > 0.2 && peak < 1);
  assert.ok(energy / data.length > 0.002);
  assert.equal(Math.abs(data[0]), 0);
  assert.equal(Math.abs(data.at(-1)), 0);
  const original = audio.buffer;
  await audio.loadDemo();
  assert.equal(audio.buffer, original, 'demo is cached rather than regenerated');
});

test('dispose cancels pending playback and clears retained audio memory', async t => {
  const audio = await ready(t);
  await audio.play();
  audio.trigger('fill');
  const context = audio.context;
  await audio.dispose();
  assert.equal(audio.buffer, null);
  assert.equal(audio._demo, null);
  assert.equal(audio.voices.size, 0);
  assert.equal(audio.playing, false);
  assert.equal(context.closed, true);
  await assert.rejects(audio.ensure(), /닫혔/);
});

test('unsupported browser fails before any partially usable audio engine', async t => {
  installMock(t);
  delete globalThis.AudioContext;
  const audio = new RemixAudio();
  await assert.rejects(audio.ensure(), /Web Audio/);
  assert.equal(audio.context, null);
});

test('four stems start at identical audio clock/offset, pause together, and seek without leaks', async t => {
  const audio = await ready(t);
  const result = await audio.loadStems(stems());
  assert.deepEqual(result, { name: '내 밴드', duration: 20, bpm: 104, stems: true });
  assert.equal(audio.buffer, audio.stemBuffers.drums);
  assert.equal(audio.playing, false);
  audio.seek(4);
  await audio.play();
  assert.equal(audio._transportNodes.length, 4);
  let entries = [...audio._transportNodes];
  assert.ok(entries.every(({ source }) => source.startTime === 10.015 && source.offset === 4));
  assert.ok(entries.every(({ source }) => Math.abs(source.stopTimes[0] - 26.015) < 1e-9));
  assert.equal(new Set(entries.map(({ source }) => source.buffer)).size, 4);
  audio.context.currentTime = 12;
  assert.ok(Math.abs(audio.position - 5.985) < 1e-9);
  audio.seek(8);
  assert.ok(entries.every(({ source, gate }) => source.disconnected && gate.disconnected));
  assert.ok(entries.every(({ source }) => source.stopTimes.at(-1) === 12));
  entries = [...audio._transportNodes];
  assert.ok(entries.every(({ source }) => source.startTime === 12.015 && source.offset === 8));
  audio.trigger('fill'); audio.setMuffle(true);
  audio.pause();
  assert.equal(audio.position, 8);
  assert.ok(entries.every(({ source, gate }) => source.disconnected && gate.disconnected));
  assert.equal(audio._transportNodes.length, 0);
  assert.equal(audio._stemGains.size, 0);
  assert.equal(audio.voices.size, 0);
  assert.equal(audio.muffled, false);
});

test('stem mix matrix ramps only gains, preserving source phase and same transport', async t => {
  const audio = await ready(t);
  await audio.loadStems(stems());
  await audio.play();
  const entries = [...audio._transportNodes];
  const modes = {
    mix: [1, 1, 1, 1], vocals: [0, 0, 0, 1],
    instrumental: [1, 1, 1, 0], drummer: [0, 1, 1, 1],
  };
  for (const [mode, expected] of Object.entries(modes)) {
    assert.equal(audio.setStemMix(mode), mode);
    assert.deepEqual(entries.map(({ gate }) => gate.gain.value), expected.map(n => n * 0.8));
    assert.deepEqual(audio._transportNodes, entries);
    assert.equal(audio.context.sources.length, 4);
    assert.ok(entries.every(({ source }) => source.stopTimes.length === 1));
  }
  assert.throws(() => audio.setStemMix('invalid'), /알 수 없는/);
  audio.pause();
  audio.setStemMix('vocals');
  await audio.play();
  assert.deepEqual(audio._transportNodes.map(({ gate }) => gate.gain.value), [0, 0, 0, 0.8]);
});

test('all stems share loop bounds and canonical natural end fires once with full cleanup', async t => {
  const audio = await ready(t);
  await audio.loadStems(stems());
  audio.setLoop(3, 8, true);
  await audio.play();
  assert.ok(audio._transportNodes.every(({ source }) => source.loop && source.loopStart === 3 && source.loopEnd === 8));
  audio.context.currentTime = 17;
  assert.ok(Math.abs(audio.position - 4.985) < 1e-9);
  audio.setLoop(3, 8, false);
  let ended = 0;
  audio.onend = () => ended++;
  const entries = [...audio._transportNodes];
  const endCallbacks = entries.map(({ source }) => source.onended);
  endCallbacks[1]();
  assert.equal(ended, 0);
  endCallbacks[0]();
  endCallbacks[2](); endCallbacks[3]();
  assert.equal(ended, 1);
  assert.equal(audio.position, 20);
  assert.equal(audio.playing, false);
  assert.ok(entries.every(({ source, gate }) => source.disconnected && gate.disconnected));
});

test('stem validation enforces file counts, compressed size, duration, alignment and decoded budget atomically', async t => {
  const audio = await ready(t);
  const oldBuffer = audio.buffer;
  await assert.rejects(audio.loadStems({ drums: file('only.wav') }), /모두/);
  const large = stems(); large.drums.size = 51 * 1024 * 1024;
  await assert.rejects(audio.loadStems(large), /50 MB/);
  const tooMuch = stems(); Object.values(tooMuch).forEach(file => file.size = 26 * 1024 * 1024);
  await assert.rejects(audio.loadStems(tooMuch), /100 MB/);
  audio.context.decode = async () => ({ duration: 181, length: 181 * 8000, numberOfChannels: 1 });
  await assert.rejects(audio.loadStems(stems()), /3분/);
  let decoded = 0;
  audio.context.decode = async () => ({ duration: ++decoded === 4 ? 20.3 : 20, length: 20 * 8000, numberOfChannels: 1 });
  await assert.rejects(audio.loadStems(stems()), /같은 시작점/);
  audio.context.decode = async () => ({ duration: 180, length: 180 * 48000, numberOfChannels: 2 });
  await assert.rejects(audio.loadStems(stems()), /256 MiB/);
  audio.context.decode = async () => { throw new Error('bad codec'); };
  await assert.rejects(audio.loadStems(stems()), /드럼 파일을 읽을 수 없어요/);
  assert.equal(audio.buffer, oldBuffer);
  assert.equal(audio.stemBuffers, null);
  assert.equal(audio.playing, false);
});

test('aligned stems use shortest duration and replacing stems with a file or demo clears them', async t => {
  const audio = await ready(t);
  let decoded = 0;
  audio.context.decode = async () => audio.context.createBuffer(1, (++decoded === 1 ? 20.2 : 20) * 8000, 8000);
  await audio.loadStems(stems());
  assert.equal(audio.buffer.duration, 20.2);
  assert.equal(audio.duration, 20);
  await audio.play();
  assert.ok(audio._transportNodes.every(({ source }) => Math.abs(source.stopTimes[0] - 30.015) < 1e-9));
  await audio.loadFile(file('whole-song.mp3'));
  assert.equal(audio.stemBuffers, null);
  assert.equal(audio.stemMix, 'mix');
  assert.equal(audio._transportNodes.length, 0);
  await audio.loadStems(stems());
  audio._demo = audio.context.createBuffer(1, 8000 * 12, 8000);
  await audio.loadDemo();
  assert.equal(audio.stemBuffers, null);
  assert.equal(audio.duration, 12);
});

test('stem decoding is sequential, atomic and cannot override a newer song selection', async t => {
  const audio = await ready(t);
  const original = audio.buffer;
  const pending = deferred();
  let calls = 0;
  audio.context.decode = () => ++calls === 1 ? pending.promise : Promise.resolve(audio.context.createBuffer(1, 8000 * 7, 8000));
  const loadingStems = audio.loadStems(stems());
  await Promise.resolve(); await Promise.resolve();
  assert.equal(calls, 1, 'next stem is not decoded before the previous finishes');
  assert.equal(audio.buffer, original, 'partial stems never replace current track');
  const latest = await audio.loadFile(file('latest.mp3'));
  assert.equal(latest.name, 'latest.mp3');
  pending.resolve(audio.context.createBuffer(1, 8000 * 20, 8000));
  assert.equal(await loadingStems, null);
  assert.equal(audio.duration, 7);
  assert.equal(audio.stemBuffers, null);
  assert.equal(calls, 2, 'superseded remaining stems are never decoded');
});
