import test from 'node:test';
import assert from 'node:assert/strict';
import { detectOnsets } from '../dist/onsets.js';

function buffer(seconds = 4, sampleRate = 24000, channelCount = 1) {
  const channels = Array.from({ length: channelCount }, () => new Float32Array(Math.round(seconds * sampleRate)));
  return { sampleRate, numberOfChannels: channelCount, length: channels[0].length,
    duration: seconds, getChannelData: channel => channels[channel], channels };
}
function attack(audio, at, { gain = 0.7, decay = 0.07, frequency = 83 } = {}) {
  for (let i = Math.round(at * audio.sampleRate); i < audio.length; i++) {
    const t = i / audio.sampleRate - at;
    if (t > decay * 8) break;
    const value = gain * Math.exp(-t / decay) * Math.sin(2 * Math.PI * frequency * t);
    for (let channel = 0; channel < audio.numberOfChannels; channel++) audio.channels[channel][i] += value * (channel % 2 ? -1 : 1);
  }
}
function near(actual, expected, tolerance = 0.025) {
  assert.equal(actual.length, expected.length, `${actual} vs ${expected}`);
  actual.forEach((time, i) => assert.ok(Math.abs(time - expected[i]) <= tolerance, `${time} not near ${expected[i]}`));
}

test('silence and almost-silent samples do not invent a rhythm', () => {
  const audio = buffer(); assert.deepEqual(detectOnsets(audio), []);
  audio.channels[0].fill(1e-7); assert.deepEqual(detectOnsets(audio), []);
});
test('drum-like attacks retain their actual irregular timing rather than a BPM grid', () => {
  const audio = buffer(); const times = [0.13, 0.66, 1.42, 2.17, 3.31];
  times.forEach(at => attack(audio, at)); near(detectOnsets(audio), times);
});
test('opposite-phase stereo energy does not cancel attack detection', () => {
  const audio = buffer(3, 44100, 2); const times = [0.25, 0.83, 1.58, 2.46];
  times.forEach(at => attack(audio, at)); near(detectOnsets(audio), times);
});
test('a single ringing hit is deduplicated, while distinct close hits are retained', () => {
  const audio = buffer(2); attack(audio, 0.2, {decay:0.25});
  near(detectOnsets(audio), [0.2]);
  const separate = buffer(2); [0.1,0.25,0.4,0.55,0.7].forEach(at => attack(separate, at, {decay:0.025}));
  near(detectOnsets(separate), [0.1,0.25,0.4,0.55,0.7]);
});
test('steady noise is not turned into a stream of spurious attacks', () => {
  const audio = buffer(8); let seed = 7;
  for (let i = 0; i < audio.length; i++) {seed = (Math.imul(seed,1664525)+1013904223)>>>0;audio.channels[0][i] = (seed / 2147483648 - 1) * 0.1;}
  const events = detectOnsets(audio); assert.ok(events.length <= 2, String(events));
});
test('results are deterministic, finite, ordered, and at least 90ms apart', () => {
  const audio = buffer(4); for (let time = 0.2;time < 3.8; time += 0.06) attack(audio,time,{gain:time%0.3+0.3,decay:0.008});
  const result = detectOnsets(audio); assert.deepEqual(result,detectOnsets(audio));
  assert.ok(result.length > 5); assert.ok(result.every(Number.isFinite));
  result.slice(1).forEach((time,i) => assert.ok(time-result[i] >= 0.09-1e-8));
});
test('invalid or oversized buffers fail clearly and never silently analyze a different section', () => {
  for (const invalid of [null, {}, {sampleRate:0,length:2,numberOfChannels:1,getChannelData(){}}]) assert.throws(() => detectOnsets(invalid), /버퍼/);
  const long = {sampleRate:8000,length:181*8000,numberOfChannels:1,getChannelData(){throw Error('must not allocate/read');}};
  assert.throws(()=>detectOnsets(long),/3분/);
  const broken = buffer();broken.getChannelData=()=>new Float32Array(3);assert.throws(()=>detectOnsets(broken),/채널/);
});
test('bounded sensitivity and malformed samples do not produce nonfinite timestamps', () => {
  const audio=buffer();attack(audio,0.4);audio.channels[0][10]=NaN;audio.channels[0][20]=Infinity;
  for (const sensitivity of [0,1,100,NaN]) assert.ok(detectOnsets(audio,{sensitivity}).every(Number.isFinite));
});
