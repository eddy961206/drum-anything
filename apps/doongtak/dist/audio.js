// Original, browser-generated instruments. No samples, network or microphone.
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);
const CHORDS = [
  { bass: 36, notes: [60, 64, 67, 71] },
  { bass: 33, notes: [57, 60, 64, 67] },
  { bass: 29, notes: [57, 60, 64, 69] },
  { bass: 31, notes: [55, 59, 62, 67] },
];

export class DrumAudio {
  constructor() {
    this.context = null;
    this.master = null;
    this.compressor = null;
    this.noise = null;
    this.volume = 0.62;
    this.muted = false;
    this.voices = new Set();
  }

  get currentTime() { return this.context?.currentTime ?? 0; }
  get state() { return this.context?.state ?? 'closed'; }

  async unlock() {
    if (!this.context || this.context.state === 'closed') {
      const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioContext) throw new Error('이 브라우저는 Web Audio를 지원하지 않아요. 최신 브라우저에서 열어 주세요.');
      this.context = new AudioContext({ latencyHint: 'interactive' });
      this.master = this.context.createGain();
      this.compressor = this.context.createDynamicsCompressor();
      this.compressor.threshold.value = -15;
      this.compressor.knee.value = 12;
      this.compressor.ratio.value = 5;
      this.compressor.attack.value = 0.003;
      this.compressor.release.value = 0.16;
      this.master.gain.value = this.muted ? 0 : this.volume * 0.74;
      this.master.connect(this.compressor);
      this.compressor.connect(this.context.destination);
      this.noise = this.context.createBuffer(1, this.context.sampleRate, this.context.sampleRate);
      const samples = this.noise.getChannelData(0);
      for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
    }
    // Creating and resuming happen in the initiating click/key gesture.
    if (this.context.state !== 'running') await this.context.resume();
    return this.context;
  }

  setVolume(value) {
    this.volume = clamp(Number.isFinite(Number(value)) ? Number(value) : 0.62, 0, 1);
    this._updateMaster();
  }

  setMuted(value) {
    this.muted = Boolean(value);
    this._updateMaster();
  }

  _updateMaster() {
    if (!this.master) return;
    const t = this.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume * 0.74, t, 0.015);
  }

  _ready() { return this.context?.state === 'running'; }
  _time(when) { return Math.max(this.currentTime, Number.isFinite(when) ? when : this.currentTime); }

  _voice(when, length) {
    const gate = this.context.createGain();
    gate.gain.value = 1;
    gate.connect(this.master);
    const voice = { sources: [], nodes: [gate], gate, remaining: 0, stopped: false };
    this.voices.add(voice);
    const attach = (source, nodes = []) => {
      voice.sources.push(source);
      voice.nodes.push(source, ...nodes);
      voice.remaining++;
      source.onended = () => {
        voice.remaining--;
        if (voice.remaining === 0) {
          for (const node of voice.nodes) { try { node.disconnect(); } catch {} }
          this.voices.delete(voice);
        }
      };
      source.start(when);
      source.stop(when + length);
    };
    return { gate, attach };
  }

  kick(when = this.currentTime, velocity = 0.8) {
    if (!this._ready()) return;
    const t = this._time(when);
    const v = clamp(velocity, 0.05, 1);
    const { gate, attach } = this._voice(t, 0.40);
    const oscillator = this.context.createOscillator();
    const envelope = this.context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(150, t);
    oscillator.frequency.exponentialRampToValueAtTime(48, t + 0.075);
    oscillator.frequency.exponentialRampToValueAtTime(41, t + 0.35);
    envelope.gain.setValueAtTime(0.0001, t);
    envelope.gain.exponentialRampToValueAtTime(0.82 * v, t + 0.003);
    envelope.gain.exponentialRampToValueAtTime(0.0001, t + 0.36);
    oscillator.connect(envelope).connect(gate);
    attach(oscillator, [envelope]);

    const transient = this.context.createBufferSource();
    transient.buffer = this.noise;
    const filter = this.context.createBiquadFilter();
    filter.type = 'lowpass'; filter.frequency.value = 1500;
    const tap = this.context.createGain();
    tap.gain.setValueAtTime(0.11 * v, t);
    tap.gain.exponentialRampToValueAtTime(0.0001, t + 0.019);
    transient.connect(filter).connect(tap).connect(gate);
    attach(transient, [filter, tap]);
  }

  snare(when = this.currentTime, velocity = 0.8) {
    if (!this._ready()) return;
    const t = this._time(when);
    const v = clamp(velocity, 0.05, 1);
    const { gate, attach } = this._voice(t, 0.23);
    const noise = this.context.createBufferSource();
    noise.buffer = this.noise;
    const filter = this.context.createBiquadFilter();
    filter.type = 'highpass'; filter.frequency.value = 1150;
    const tone = this.context.createBiquadFilter();
    tone.type = 'lowpass'; tone.frequency.value = 6500;
    const envelope = this.context.createGain();
    envelope.gain.setValueAtTime(0.0001, t);
    envelope.gain.exponentialRampToValueAtTime(0.41 * v, t + 0.002);
    envelope.gain.exponentialRampToValueAtTime(0.0001, t + 0.19);
    noise.connect(filter).connect(tone).connect(envelope).connect(gate);
    attach(noise, [filter, tone, envelope]);

    const body = this.context.createOscillator();
    const bodyGain = this.context.createGain();
    body.type = 'triangle';
    body.frequency.setValueAtTime(185, t);
    body.frequency.exponentialRampToValueAtTime(110, t + 0.075);
    bodyGain.gain.setValueAtTime(0.18 * v, t);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    body.connect(bodyGain).connect(gate);
    attach(body, [bodyGain]);
  }

  hat(when = this.currentTime, velocity = 0.35) {
    if (!this._ready()) return;
    const t = this._time(when);
    const { gate, attach } = this._voice(t, 0.07);
    const source = this.context.createBufferSource();
    source.buffer = this.noise;
    const filter = this.context.createBiquadFilter();
    filter.type = 'highpass'; filter.frequency.value = 6800;
    const envelope = this.context.createGain();
    envelope.gain.setValueAtTime(0.0001, t);
    envelope.gain.exponentialRampToValueAtTime(Math.max(0.0001, 0.10 * clamp(velocity, 0, 1)), t + 0.001);
    envelope.gain.exponentialRampToValueAtTime(0.0001, t + 0.047);
    source.connect(filter).connect(envelope).connect(gate);
    attach(source, [filter, envelope]);
  }

  _chord(notes, when, duration) {
    const { gate, attach } = this._voice(when, duration + 0.07);
    for (const [index, note] of notes.entries()) {
      const start = when + index * 0.006;
      for (const [partial, gain] of [[1, 0.044], [2, 0.009]]) {
        const oscillator = this.context.createOscillator();
        oscillator.type = 'sine';
        oscillator.frequency.value = hz(note) * partial;
        oscillator.detune.value = index % 2 === 0 ? -3 : 3;
        const envelope = this.context.createGain();
        envelope.gain.setValueAtTime(0.0001, when);
        envelope.gain.exponentialRampToValueAtTime(gain, start + 0.018);
        envelope.gain.exponentialRampToValueAtTime(gain * 0.23, when + duration * 0.52);
        envelope.gain.exponentialRampToValueAtTime(0.0001, when + duration);
        oscillator.connect(envelope).connect(gate);
        attach(oscillator, [envelope]);
      }
    }
  }

  _bass(note, when, duration, velocity = 1) {
    const { gate, attach } = this._voice(when, duration + 0.04);
    const oscillator = this.context.createOscillator();
    oscillator.type = 'triangle';
    oscillator.frequency.value = hz(note);
    const filter = this.context.createBiquadFilter();
    filter.type = 'lowpass'; filter.frequency.value = 240;
    const envelope = this.context.createGain();
    envelope.gain.setValueAtTime(0.0001, when);
    envelope.gain.exponentialRampToValueAtTime(0.18 * velocity, when + 0.015);
    envelope.gain.exponentialRampToValueAtTime(0.09 * velocity, when + duration * 0.45);
    envelope.gain.exponentialRampToValueAtTime(0.0001, when + duration);
    oscillator.connect(filter).connect(envelope).connect(gate);
    attach(oscillator, [filter, envelope]);
  }

  scheduleBacking(stepIndex, when, secondsPerStep) {
    if (!this._ready() || !Number.isFinite(secondsPerStep) || secondsPerStep <= 0) return;
    const step = Math.max(0, Math.trunc(stepIndex));
    const inBar = step % 8;
    const chord = CHORDS[Math.floor(step / 8) % CHORDS.length];
    const t = this._time(when);
    // Eight eighth notes per bar. A barely swung shaker supports, not replaces,
    // the player's kick and snare. No automatic kick or snare in the backing.
    this.hat(t + (inBar % 2 ? secondsPerStep * 0.045 : 0), inBar % 2 ? 0.24 : 0.42);
    if (inBar === 0) this._chord(chord.notes, t, secondsPerStep * 6.8);
    if (inBar === 0 || inBar === 4) this._bass(chord.bass, t, secondsPerStep * 1.8);
    if (inBar === 3) this._bass(chord.bass + 12, t, secondsPerStep * 0.7, 0.58);
    if (inBar === 6) this._bass(chord.bass + 7, t, secondsPerStep * 1.4, 0.72);
  }

  stopAll() {
    if (!this.context) return;
    const t = this.currentTime;
    for (const voice of this.voices) {
      if (voice.stopped) continue;
      voice.stopped = true;
      const gain = voice.gate.gain;
      if (typeof gain.cancelAndHoldAtTime === 'function') gain.cancelAndHoldAtTime(t);
      else { gain.cancelScheduledValues(t); gain.setValueAtTime(gain.value, t); }
      gain.linearRampToValueAtTime(0, t + 0.015);
      for (const source of voice.sources) { try { source.stop(t + 0.018); } catch {} }
    }
  }

  async suspend() {
    this.stopAll();
    if (this.context && this.context.state === 'running') await this.context.suspend();
  }
}
