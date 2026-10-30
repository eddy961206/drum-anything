import { nextBeatDelay, normalizeBpm } from './timing.js';

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const bounded = (n, fallback) => Number.isFinite(Number(n)) ? clamp(Number(n), 0, 1) : fallback;
const hz = midi => 440 * 2 ** ((midi - 69) / 12);
const DEMO_BPM = 104;
const DEMO_NAME = 'Midnight Window';
const STEM_KEYS = ['drums', 'bass', 'other', 'vocals'];
const STEM_LABELS = { drums: '드럼', bass: '베이스', other: '나머지 악기', vocals: '보컬' };
const STEM_MIXES = {
  mix: { drums: 1, bass: 1, other: 1, vocals: 1 },
  vocals: { drums: 0, bass: 0, other: 0, vocals: 1 },
  instrumental: { drums: 1, bass: 1, other: 1, vocals: 0 },
  drummer: { drums: 0, bass: 1, other: 1, vocals: 1 },
};

// Every sound is synthesized here. No remote requests, microphones, or samples.
export class RemixAudio {
  constructor() {
    this.context = null;
    this.master = null;
    this.effects = null;
    this.songFilter = null;
    this.compressor = null;
    this.noise = null;
    this.buffer = null;
    this.stemBuffers = null;
    this.stemMix = 'mix';
    this._stemDuration = 0;
    this.bpm = DEMO_BPM;
    this.beatAnchor = 0;
    this.masterLevel = 0.72;
    this.effectsLevel = 0.68;
    this.muffled = false;
    this.voices = new Set();
    this.onend = null;
    this._playing = false;
    this._source = null;
    this._songGate = null;
    this._transportNodes = [];
    this._stemGains = new Map();
    this._offset = 0;
    this._startedAt = 0;
    this._playRequest = 0;
    this._loadRequest = 0;
    this._demo = null;
    this._disposed = false;
    this._loop = { a: 0, b: 0, enabled: false };
  }

  get duration() { return this.stemBuffers ? this._stemDuration : this.buffer?.duration || 0; }
  get playing() { return this._playing; }
  get currentTime() { return this.context?.currentTime || 0; }
  get position() {
    let position = this._offset + (this._playing ? Math.max(0, this.currentTime - this._startedAt) : 0);
    const { a, b, enabled } = this._loop;
    if (enabled && b > a && position >= b) position = a + ((position - a) % (b - a));
    return clamp(position, 0, this.duration);
  }

  async ensure() {
    if (this._disposed) throw new Error('오디오가 닫혔어요. 페이지를 새로 열어 주세요.');
    if (!this.context) {
      const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioContext) throw new Error('이 브라우저는 Web Audio를 지원하지 않아요. 최신 Chrome 또는 Safari에서 열어 주세요.');
      const context = new AudioContext({ latencyHint: 'interactive' });
      this.context = context;
      this.master = context.createGain();
      this.effects = context.createGain();
      this.songFilter = context.createBiquadFilter();
      this.songFilter.type = 'lowpass';
      this.songFilter.frequency.value = this.muffled ? 460 : 22000;
      this.songFilter.Q.value = 0.55;
      this.compressor = context.createDynamicsCompressor();
      this.compressor.threshold.value = -12;
      this.compressor.knee.value = 12;
      this.compressor.ratio.value = 4;
      this.compressor.attack.value = 0.003;
      this.compressor.release.value = 0.17;
      this.master.gain.value = this.masterLevel * 0.76;
      this.effects.gain.value = this.effectsLevel * 0.68;
      this.songFilter.connect(this.master);
      this.effects.connect(this.master);
      this.master.connect(this.compressor);
      this.compressor.connect(context.destination);
      this.noise = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
      const data = this.noise.getChannelData(0);
      // Fixed seed makes the original generated sound reproducible.
      let seed = 19970817;
      for (let i = 0; i < data.length; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        data[i] = seed / 2147483648 - 1;
      }
    }
    // This is the only audio-unlock entry point and must be called from a gesture.
    if (this.context.state !== 'running') await this.context.resume();
    return this.context;
  }

  async loadDemo() {
    const request = ++this._loadRequest;
    this.pause();
    await this.ensure();
    if (request !== this._loadRequest || this._disposed) return null;
    if (!this._demo) this._demo = this._makeDemo();
    this._commitBuffer(this._demo);
    this.setBpm(DEMO_BPM);
    return { name: DEMO_NAME, duration: this.duration, bpm: this.bpm };
  }

  async loadFile(file) {
    const request = ++this._loadRequest;
    this.pause();
    if (!file || typeof file.arrayBuffer !== 'function') throw new Error('음악 파일을 선택해 주세요.');
    if (!Number.isFinite(file.size) || file.size <= 0) throw new Error('비어 있는 파일은 재생할 수 없어요.');
    if (file.size > 50 * 1024 * 1024) throw new Error('50 MB 이하의 음악 파일을 골라 주세요.');
    await this.ensure();
    try {
      const data = await file.arrayBuffer();
      if (request !== this._loadRequest || this._disposed) return null;
      const buffer = await this.context.decodeAudioData(data);
      if (request !== this._loadRequest || this._disposed) return null;
      if (!buffer?.duration || !Number.isFinite(buffer.duration)) throw new Error('empty');
      this._commitBuffer(buffer);
      return { name: file.name || '내 음악', duration: this.duration, bpm: this.bpm };
    } catch (error) {
      if (request !== this._loadRequest || this._disposed) return null;
      throw new Error('이 파일을 읽을 수 없어요. 브라우저가 지원하는 MP3, WAV, M4A 파일을 다시 골라 주세요.', { cause: error });
    }
  }

  async loadStems(files) {
    const request = ++this._loadRequest;
    this.pause();
    let totalBytes = 0;
    for (const key of STEM_KEYS) {
      const file = files?.[key];
      if (!file || typeof file.arrayBuffer !== 'function') throw new Error('드럼·베이스·나머지 악기·보컬 파일을 모두 골라 주세요.');
      if (!Number.isFinite(file.size) || file.size <= 0) throw new Error(`${STEM_LABELS[key]} 파일이 비어 있어요.`);
      if (file.size > 50 * 1024 * 1024) throw new Error('스템 파일은 각각 50 MB 이하로 골라 주세요.');
      totalBytes += file.size;
    }
    if (totalBytes > 100 * 1024 * 1024) throw new Error('네 파일의 합계는 100 MB 이하여야 해요.');
    await this.ensure();
    const decoded = {};
    let decodedBytes = 0;
    for (const key of STEM_KEYS) {
      if (request !== this._loadRequest || this._disposed) return null;
      let buffer;
      try {
        const data = await files[key].arrayBuffer();
        if (request !== this._loadRequest || this._disposed) return null;
        buffer = await this.context.decodeAudioData(data);
      } catch (error) {
        if (request !== this._loadRequest || this._disposed) return null;
        throw new Error(`${STEM_LABELS[key]} 파일을 읽을 수 없어요. 지원되는 MP3, WAV, M4A 파일을 골라 주세요.`, { cause: error });
      }
      if (request !== this._loadRequest || this._disposed) return null;
      if (!buffer?.duration || !Number.isFinite(buffer.duration)) throw new Error(`${STEM_LABELS[key]} 파일에 재생할 소리가 없어요.`);
      if (buffer.duration > 180) throw new Error('스템은 각각 3분 이하의 구간으로 준비해 주세요.');
      decodedBytes += buffer.length * buffer.numberOfChannels * 4;
      if (!Number.isFinite(decodedBytes) || decodedBytes > 256 * 1024 * 1024) throw new Error('풀어 놓은 오디오가 256 MiB를 넘어요. 구간을 줄이거나 낮은 샘플레이트로 내보내 주세요.');
      decoded[key] = buffer;
    }
    const durations = STEM_KEYS.map(key => decoded[key].duration);
    if (Math.max(...durations) - Math.min(...durations) > 0.25) throw new Error('네 파일의 길이가 달라요. 같은 시작점·끝점으로 맞춰 내보낸 스템을 골라 주세요. (길이 차이 0.25초 이하)');
    // Commit atomically only after all validation: failed loads keep old music.
    this._commitBuffer(decoded.drums);
    this.stemBuffers = decoded;
    this._stemDuration = Math.min(...durations);
    this._loop.b = this.duration;
    this.stemMix = 'mix';
    return { name: '내 밴드', duration: this.duration, bpm: this.bpm, stems: true };
  }

  _commitBuffer(buffer) {
    this.pause();
    this.stemBuffers = null;
    this._stemDuration = 0;
    this.stemMix = 'mix';
    this.buffer = buffer;
    this._offset = 0;
    this.beatAnchor = 0;
    this._loop = { a: 0, b: buffer.duration, enabled: false };
  }

  async play() {
    const request = ++this._playRequest;
    await this.ensure();
    if (request !== this._playRequest || this._disposed) return false;
    if (this._playing) return true;
    if (!this.buffer) {
      if (!this._demo) this._demo = this._makeDemo();
      this.buffer = this._demo;
      this.bpm = DEMO_BPM;
      this._loop = { a: 0, b: this.duration, enabled: false };
    }
    if (this._offset >= this.duration - 0.001) this._offset = this._loop.enabled ? this._loop.a : 0;
    this._startTransport();
    return true;
  }

  _startTransport() {
    if (!this.buffer || this._disposed) return;
    // Four sources share a slightly future boundary so node construction cannot
    // push a later stem into the next audio render quantum.
    const now = this.currentTime + (this.stemBuffers ? 0.015 : 0);
    const tracks = this.stemBuffers ? STEM_KEYS.map(key => [key, this.stemBuffers[key]]) : [[null, this.buffer]];
    this._transportNodes = [];
    this._stemGains.clear();
    for (const [key, buffer] of tracks) {
      const source = this.context.createBufferSource();
      const gate = this.context.createGain();
      source.buffer = buffer;
      source.loop = this._loop.enabled;
      source.loopStart = this._loop.a;
      source.loopEnd = this._loop.b;
      gate.gain.setValueAtTime(0, now);
      gate.gain.linearRampToValueAtTime(0.8 * (key ? STEM_MIXES[this.stemMix][key] : 1), now + 0.008);
      source.connect(gate).connect(this.songFilter);
      this._transportNodes.push({ source, gate, key });
      if (key) this._stemGains.set(key, gate);
    }
    this._source = this._transportNodes[0].source;
    this._songGate = this._transportNodes[0].gate;
    this._startedAt = now;
    this._playing = true;
    for (const { source, gate } of this._transportNodes) {
      source.onended = () => {
        try { source.disconnect(); gate.disconnect(); } catch {}
        if (source !== this._source) return;
        this._offset = this.duration;
        this._stopTransport();
        this.cancelPendingEffects();
        this.setMuffle(false);
        if (typeof this.onend === 'function') this.onend();
      };
      source.start(now, this._offset);
      // Aligned stems may differ by a codec tail. End all at the shortest stem.
      if (this.stemBuffers && !this._loop.enabled) source.stop(now + this.duration - this._offset);
    }
  }

  _stopTransport() {
    const nodes = this._transportNodes;
    this._source = null;
    this._songGate = null;
    this._transportNodes = [];
    this._stemGains.clear();
    this._playing = false;
    for (const { source, gate } of nodes) {
      source.onended = null;
      try { source.stop(this.currentTime); } catch {}
      try { source.disconnect(); gate.disconnect(); } catch {}
    }
  }

  setStemMix(mode) {
    if (!Object.hasOwn(STEM_MIXES, mode)) throw new Error('알 수 없는 스템 믹스예요.');
    this.stemMix = mode;
    for (const [key, gate] of this._stemGains) this._ramp(gate.gain, 0.8 * STEM_MIXES[mode][key], 0.025);
    return this.stemMix;
  }

  pause() {
    ++this._playRequest;
    this._offset = this.position;
    this._stopTransport();
    this.cancelPendingEffects();
    this.setMuffle(false);
  }

  stop() { this.pause(); this._offset = this._loop.enabled ? this._loop.a : 0; }

  seek(seconds) {
    if (!Number.isFinite(Number(seconds))) return;
    const wasPlaying = this._playing;
    this.pause();
    let target = clamp(Number(seconds), 0, this.duration);
    if (this._loop.enabled) target = clamp(target, this._loop.a, this._loop.b - 0.001);
    this._offset = target;
    if (wasPlaying && this._offset < this.duration) this._startTransport();
  }

  setLoop(a, b, enabled) {
    const start = clamp(Number(a) || 0, 0, this.duration);
    const end = clamp(Number(b) || 0, 0, this.duration);
    if (enabled && end - start < 0.25) throw new Error('반복 구간은 0.25초 이상으로 잡아 주세요.');
    const position = this.position;
    const wasPlaying = this._playing;
    this.pause();
    this._loop = { a: start, b: end, enabled: Boolean(enabled && end > start) };
    this._offset = this._loop.enabled && (position < start || position >= end) ? start : position;
    if (wasPlaying && this._offset < this.duration) this._startTransport();
    return { ...this._loop };
  }

  setBpm(value) {
    this.bpm = normalizeBpm(value, this.bpm);
    this.cancelPendingEffects();
    return this.bpm;
  }

  alignBeat() {
    this.beatAnchor = this.position;
    this.cancelPendingEffects();
    return this.beatAnchor;
  }

  setMaster(value) {
    this.masterLevel = bounded(value, this.masterLevel);
    this._ramp(this.master?.gain, this.masterLevel * 0.76);
  }

  setEffects(value) {
    this.effectsLevel = bounded(value, this.effectsLevel);
    this._ramp(this.effects?.gain, this.effectsLevel * 0.68);
  }

  setMuffle(value) {
    this.muffled = Boolean(value);
    this._ramp(this.songFilter?.frequency, this.muffled ? 460 : 22000, 0.025);
  }

  _ramp(param, value, tau = 0.015) {
    if (!param || !this.context) return;
    param.cancelScheduledValues(this.currentTime);
    param.setTargetAtTime(value, this.currentTime, tau);
  }

  trigger(kind, quantized = true, externalClock = null) {
    if (!this.context || this.context.state !== 'running' || this._disposed) return null;
    if (!['fill', 'crash', 'kick', 'snare'].includes(kind)) return null;
    // An official embedded player can supply only its public playback clock.
    // Its audio stays in the embed: we never fetch, capture, or process it.
    const clock = externalClock === null
      ? { position: this.position, playing: this._playing, anchor: this.beatAnchor }
      : externalClock;
    const delay = quantized && clock.playing
      ? nextBeatDelay(clock.position, this.bpm, Number.isFinite(clock.anchor) ? clock.anchor : 0)
      : 0;
    const at = this.currentTime + delay + 0.005;
    // Cap simultaneous voices, including future scheduled fills, for touch spam.
    if (this.voices.size > 60) this.cancelPendingEffects();
    if (kind === 'fill') {
      const beat = 60 / this.bpm;
      this._kick(at, 0.8);
      [[0, 0.65], [0.5, 0.68], [1, 0.76], [1.25, 0.68], [1.5, 0.8], [1.75, 0.9]].forEach(([step, v]) => this._snare(at + beat * step, v));
      this._crash(at + beat * 2, 0.76);
      this._kick(at + beat * 2, 0.85);
    } else if (kind === 'kick') this._kick(at, 0.9);
    else if (kind === 'snare') this._snare(at, 0.9);
    else this._crash(at, 0.85);
    return delay;
  }

  _voice(when, length) {
    const gate = this.context.createGain();
    gate.gain.value = 1;
    gate.connect(this.effects);
    const voice = { sources: [], nodes: [gate], gate, remaining: 0, stopped: false };
    this.voices.add(voice);
    const attach = (source, nodes = []) => {
      voice.sources.push(source);
      voice.nodes.push(source, ...nodes);
      voice.remaining++;
      source.onended = () => {
        voice.remaining--;
        if (voice.remaining <= 0) this._disposeVoice(voice);
      };
      source.start(when);
      source.stop(when + length);
    };
    return { gate, attach };
  }

  _disposeVoice(voice) {
    for (const node of voice.nodes) { try { node.disconnect(); } catch {} }
    this.voices.delete(voice);
  }

  _kick(t, v) {
    const { gate, attach } = this._voice(t, 0.42);
    const oscillator = this.context.createOscillator();
    const envelope = this.context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(145, t);
    oscillator.frequency.exponentialRampToValueAtTime(48, t + 0.08);
    oscillator.frequency.exponentialRampToValueAtTime(40, t + 0.38);
    envelope.gain.setValueAtTime(0.0001, t);
    envelope.gain.exponentialRampToValueAtTime(0.92 * v, t + 0.003);
    envelope.gain.exponentialRampToValueAtTime(0.0001, t + 0.39);
    oscillator.connect(envelope).connect(gate);
    attach(oscillator, [envelope]);
  }

  _snare(t, v) {
    const { gate, attach } = this._voice(t, 0.24);
    const source = this.context.createBufferSource();
    source.buffer = this.noise;
    const filter = this.context.createBiquadFilter();
    filter.type = 'highpass'; filter.frequency.value = 1200;
    const envelope = this.context.createGain();
    envelope.gain.setValueAtTime(0.0001, t);
    envelope.gain.exponentialRampToValueAtTime(0.46 * v, t + 0.002);
    envelope.gain.exponentialRampToValueAtTime(0.0001, t + 0.21);
    source.connect(filter).connect(envelope).connect(gate);
    attach(source, [filter, envelope]);
    const tone = this.context.createOscillator();
    const toneGain = this.context.createGain();
    tone.type = 'triangle';
    tone.frequency.setValueAtTime(190, t);
    tone.frequency.exponentialRampToValueAtTime(120, t + 0.09);
    toneGain.gain.setValueAtTime(0.16 * v, t);
    toneGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
    tone.connect(toneGain).connect(gate);
    attach(tone, [toneGain]);
  }

  _crash(t, v) {
    const { gate, attach } = this._voice(t, 1.45);
    const source = this.context.createBufferSource();
    source.buffer = this.noise;
    const filter = this.context.createBiquadFilter();
    filter.type = 'highpass'; filter.frequency.value = 5600;
    const envelope = this.context.createGain();
    envelope.gain.setValueAtTime(0.0001, t);
    envelope.gain.exponentialRampToValueAtTime(0.34 * v, t + 0.004);
    envelope.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
    source.connect(filter).connect(envelope).connect(gate);
    attach(source, [filter, envelope]);
    for (const frequency of [830, 1173, 1667, 2357]) {
      const oscillator = this.context.createOscillator();
      const gain = this.context.createGain();
      oscillator.type = 'sine'; oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.018 * v, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      oscillator.connect(gain).connect(gate);
      attach(oscillator, [gain]);
    }
  }

  cancelPendingEffects() {
    if (!this.context) return;
    for (const voice of [...this.voices]) {
      if (voice.stopped) continue;
      voice.stopped = true;
      const gain = voice.gate.gain;
      gain.cancelScheduledValues(this.currentTime);
      gain.setValueAtTime(0, this.currentTime);
      for (const source of voice.sources) {
        source.onended = null;
        try { source.stop(this.currentTime); } catch {}
      }
      this._disposeVoice(voice);
    }
  }

  async dispose() {
    ++this._loadRequest;
    this.pause();
    this._disposed = true;
    this.buffer = null;
    this._demo = null;
    this.noise = null;
    this.stemBuffers = null;
    this._stemDuration = 0;
    for (const node of [this.songFilter, this.effects, this.master, this.compressor]) {
      try { node?.disconnect(); } catch {}
    }
    if (this.context && this.context.state !== 'closed') await this.context.close();
  }

  _makeDemo() {
    // Compact, original 16-bar composition; render once into local memory.
    const rate = 22050;
    const beat = 60 / DEMO_BPM;
    const duration = beat * 64;
    const buffer = this.context.createBuffer(2, Math.ceil(duration * rate), rate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    let seed = 908144;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2147483648 - 1; };
    const add = (start, length, synth, pan = 0) => {
      const offset = Math.round(start * rate);
      const count = Math.min(Math.ceil(length * rate), left.length - offset);
      const l = Math.sqrt((1 - pan) / 2), r = Math.sqrt((1 + pan) / 2);
      for (let i = 0; i < count; i++) {
        const sample = synth(i / rate, i / count);
        left[offset + i] += sample * l;
        right[offset + i] += sample * r;
      }
    };
    const chordSet = [[45, 57, 60, 64, 67], [41, 57, 60, 64, 69], [48, 55, 60, 64, 67], [43, 55, 59, 62, 69]];
    const melody = [0, 2, 1, 3, 2, 1, 3, 0];
    for (let bar = 0; bar < 16; bar++) {
      const chord = chordSet[bar % 4];
      const chorus = bar >= 8;
      for (let n = 1; n < chord.length; n++) {
        const f = hz(chord[n]);
        add(bar * 4 * beat, 3.85 * beat, (t, u) => {
          const env = Math.min(1, t / 0.035) * Math.sin(Math.PI * u) ** 0.65;
          return 0.048 * env * (Math.sin(2 * Math.PI * f * t) + 0.22 * Math.sin(2 * Math.PI * f * 2.003 * t));
        }, (n - 2.5) * 0.25);
      }
      for (const step of [0, 1.5, 2, 3]) {
        const f = hz(chord[0] - 12 + (step === 1.5 ? 12 : 0));
        add((bar * 4 + step) * beat, beat * 0.76, (t, u) => {
          const env = Math.min(1, t / 0.008) * (1 - u) ** 1.7;
          return 0.24 * env * (Math.sin(2 * Math.PI * f * t) + 0.15 * Math.sin(2 * Math.PI * f * 2 * t));
        });
      }
      for (let step = 0; step < 8; step++) {
        const time = (bar * 4 + step / 2) * beat;
        add(time, 0.045, (t, u) => random() * (1 - u) ** 3 * (step % 2 ? 0.025 : 0.04), step % 2 ? 0.4 : -0.4);
        if (step % 2 === 0) add(time, 0.28, (t, u) => Math.sin(2 * Math.PI * (44 * t + 1.3 * (1 - Math.exp(-t * 35)))) * Math.exp(-t * 15) * (chorus ? 0.32 : 0.22));
        if (step === 2 || step === 6) add(time, 0.15, (t, u) => (random() * 0.075 + Math.sin(2 * Math.PI * 165 * t) * 0.025) * (1 - u) ** 2);
        if (chorus || step % 2 === 0) {
          const f = hz(chord[1 + melody[(step + bar) % melody.length]] + 12);
          add(time + beat * 0.015, beat * 0.64, (t, u) => {
            const env = Math.min(1, t / 0.006) * Math.exp(-u * 5);
            return (chorus ? 0.065 : 0.035) * env * (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(2 * Math.PI * f * 3 * t));
          }, step % 2 ? 0.32 : -0.32);
        }
      }
    }
    // Gentle edge ramps prevent loop/restart clicks; retain ample headroom.
    for (let i = 0; i < left.length; i++) {
      const edge = Math.min(1, i / (rate * 0.01), (left.length - 1 - i) / (rate * 0.08));
      left[i] = Math.tanh(left[i] * 1.7) * edge;
      right[i] = Math.tanh(right[i] * 1.7) * edge;
    }
    return buffer;
  }
}
