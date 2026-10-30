/** Original synthesized voices. No recordings, network, microphone, or dependencies. */
const PARTS = ['drums', 'bass', 'chords', 'hats'];
const LIMIT = 96;
const clamp = (n, lo, hi, fallback = lo) => Number.isFinite(Number(n)) ? Math.min(hi, Math.max(lo, Number(n))) : fallback;
const hz = midi => 440 * 2 ** ((midi - 69) / 12);

export class AudioEngine {
  constructor({ contextFactory } = {}) {
    this._factory = contextFactory || (() => {
      const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Context) throw new Error('이 브라우저는 Web Audio를 지원하지 않아요.');
      return new Context({ latencyHint: 'interactive' });
    });
    this.ctx = null;
    this._pending = null;
    this._epoch = 0;
    this._closed = false;
    this._voices = new Set();
    this._volumes = { drums: 0.8, bass: 0.55, chords: 0.45, hats: 0.45, master: 0.7 };
    this._buses = {};
    this._nodes = [];
  }

  async unlock() {
    if (this._closed) throw new Error('오디오가 닫혔어요. 페이지를 새로 열어 주세요.');
    if (this._pending) return this._pending;
    const epoch = this._epoch;
    this._pending = (async () => {
      if (!this.ctx || this.ctx.state === 'closed') {
        this.ctx = this._factory();
        try { this._buildGraph(); } catch (error) {
          const broken = this.ctx;
          this.ctx = null;
          try { await broken.close(); } catch {}
          throw error;
        }
      }
      const ctx = this.ctx;
      if (ctx.state !== 'running') {
        this.stopAll();
        await ctx.resume();
      }
      if (epoch !== this._epoch || this._closed) {
        if (ctx.state !== 'closed') await ctx.suspend();
        throw new Error('오디오 시작이 취소되었어요. 다시 재생해 주세요.');
      }
      if (ctx.state !== 'running') throw new Error('소리를 시작하지 못했어요. 다시 눌러 주세요.');
      return this;
    })();
    try { return await this._pending; } finally { this._pending = null; }
  }

  _buildGraph() {
    const ctx = this.ctx;
    this._nodes = [];
    this._buses = {};
    this._onStateChange = () => { if (ctx.state !== 'running') this.stopAll(); };
    ctx.addEventListener?.('statechange', this._onStateChange);
    this._compressor = ctx.createDynamicsCompressor();
    this._compressor.threshold.value = -15;
    this._compressor.knee.value = 14;
    this._compressor.ratio.value = 5;
    this._compressor.attack.value = 0.004;
    this._compressor.release.value = 0.15;
    this._master = ctx.createGain();
    this._master.gain.value = this._volumes.master * 0.65;
    this._master.connect(this._compressor);
    this._compressor.connect(ctx.destination);
    this._nodes.push(this._master, this._compressor);
    for (const part of PARTS) {
      const bus = ctx.createGain();
      bus.gain.value = this._volumes[part];
      bus.connect(this._master);
      this._buses[part] = bus;
      this._nodes.push(bus);
    }
    // A reproducible, locally generated noise source, not a sampled recording.
    this._noise = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.5), ctx.sampleRate);
    const samples = this._noise.getChannelData(0);
    let seed = 0x41a72;
    for (let i = 0; i < samples.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      samples[i] = seed / 0x80000000 - 1;
    }
  }

  now() { return this.ctx ? this.ctx.currentTime : 0; }
  get activeVoiceCount() { return this._voices.size; }

  setVolume(part, value) {
    if (!Object.prototype.hasOwnProperty.call(this._volumes, part)) return false;
    const volume = clamp(value, 0, 1, this._volumes[part]);
    this._volumes[part] = volume;
    const node = part === 'master' ? this._master : this._buses[part];
    if (node && this.ctx && this.ctx.state !== 'closed') {
      node.gain.setTargetAtTime(volume * (part === 'master' ? 0.65 : 1), this.now(), 0.018);
    }
    return true;
  }

  _time(when) {
    if (!this.ctx || this.ctx.state !== 'running' || this._closed) return null;
    return clamp(when, this.now(), this.now() + 10, this.now());
  }

  _voice(source, nodes, when, duration) {
    while (this._voices.size >= LIMIT) this._dispose(this._voices.values().next().value, true);
    const voice = { source, nodes, disposed: false };
    this._voices.add(voice);
    source.onended = () => this._dispose(voice, false);
    try {
      source.start(when);
      source.stop(when + duration);
    } catch (error) {
      this._dispose(voice, true);
      throw error;
    }
    return true;
  }

  _dispose(voice, stop) {
    if (!voice || voice.disposed) return;
    voice.disposed = true;
    voice.source.onended = null;
    if (stop) { try { voice.source.stop(); } catch {} }
    for (const node of [voice.source, ...voice.nodes]) { try { node.disconnect(); } catch {} }
    this._voices.delete(voice);
  }

  _osc({ frequency, endFrequency, when, duration, peak, type = 'sine', part = 'drums', cutoff }) {
    const source = this.ctx.createOscillator();
    const envelope = this.ctx.createGain();
    const nodes = [envelope];
    source.type = type;
    source.frequency.setValueAtTime(frequency, when);
    if (endFrequency) source.frequency.exponentialRampToValueAtTime(endFrequency, when + Math.min(0.1, duration * 0.45));
    envelope.gain.setValueAtTime(0.0001, when);
    envelope.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), when + Math.min(0.012, duration / 8));
    envelope.gain.exponentialRampToValueAtTime(0.0001, when + duration);
    source.connect(envelope);
    if (cutoff) {
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = cutoff;
      filter.Q.value = 0.65;
      envelope.connect(filter);
      filter.connect(this._buses[part]);
      nodes.push(filter);
    } else envelope.connect(this._buses[part]);
    return this._voice(source, nodes, when, duration + 0.015);
  }

  _noiseVoice(when, duration, peak, cutoff, part, filterType = 'highpass') {
    const source = this.ctx.createBufferSource();
    source.buffer = this._noise;
    const filter = this.ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = cutoff;
    filter.Q.value = 0.7;
    const envelope = this.ctx.createGain();
    envelope.gain.setValueAtTime(Math.max(0.0001, peak), when);
    envelope.gain.exponentialRampToValueAtTime(0.0001, when + duration);
    source.connect(filter);
    filter.connect(envelope);
    envelope.connect(this._buses[part]);
    return this._voice(source, [filter, envelope], when, duration + 0.01);
  }

  hit(kind, when, velocity = 1) {
    const t = this._time(when);
    if (t === null || !['kick', 'snare'].includes(kind)) return false;
    const v = clamp(velocity, 0, 1, 1);
    if (!v) return false;
    if (kind === 'kick') return this._osc({ frequency: 145, endFrequency: 45, when: t, duration: 0.28, peak: 0.75 * v });
    this._osc({ frequency: 190, endFrequency: 125, when: t, duration: 0.095, peak: 0.18 * v, type: 'triangle' });
    return this._noiseVoice(t, 0.17, 0.36 * v, 1300, 'drums');
  }

  bass(midi, when, duration, mood = 'lofi') {
    const t = this._time(when);
    if (t === null || !Number.isFinite(midi)) return false;
    const funky = mood === 'funky';
    return this._osc({ frequency: hz(clamp(midi, 24, 64)), when: t, duration: clamp(duration, 0.07, 3, 0.3), peak: funky ? 0.25 : 0.3, type: funky ? 'sawtooth' : 'triangle', part: 'bass', cutoff: funky ? 650 : 350 });
  }

  chord(midis, when, duration, mood = 'lofi') {
    const t = this._time(when);
    if (t === null || !Array.isArray(midis)) return false;
    const notes = midis.filter(Number.isFinite).slice(0, 5);
    if (!notes.length) return false;
    const length = clamp(duration, 0.09, 5, 0.8);
    for (const midi of notes) {
      this._osc({ frequency: hz(clamp(midi, 42, 90)), when: t, duration: length, peak: 0.09 / Math.sqrt(notes.length), type: mood === 'chill' ? 'sine' : 'triangle', part: 'chords', cutoff: mood === 'funky' ? 2800 : 1300 });
    }
    return true;
  }

  hat(when, velocity = 0.5) {
    const t = this._time(when);
    if (t === null) return false;
    const v = clamp(velocity, 0, 1, 0.5);
    if (!v) return false;
    return this._noiseVoice(t, 0.055, 0.14 * v, 6500, 'hats');
  }

  click(when, accent = false) {
    const t = this._time(when);
    if (t === null) return false;
    return this._osc({ frequency: accent ? 1200 : 800, when: t, duration: 0.045, peak: 0.16, type: 'sine' });
  }

  stopAll() {
    for (const voice of [...this._voices]) this._dispose(voice, true);
  }

  async suspend() {
    this._epoch++;
    this.stopAll();
    if (this.ctx && this.ctx.state !== 'closed') await this.ctx.suspend();
  }

  async close() {
    this._epoch++;
    this._closed = true;
    this.stopAll();
    for (const node of this._nodes) { try { node.disconnect(); } catch {} }
    this._nodes = [];
    this.ctx?.removeEventListener?.('statechange', this._onStateChange);
    if (this.ctx && this.ctx.state !== 'closed') await this.ctx.close();
    this._noise = null;
  }
}
