import {SAMPLE_NAMES, clamp, trimBounds} from './core.mjs';

const stopTracks = stream => stream?.getTracks?.().forEach(track => { try { track.stop(); } catch {} });

export class AudioEngine {
  constructor({AudioContext: Context = globalThis.AudioContext || globalThis.webkitAudioContext} = {}) {
    this.Context = Context; this.context = null; this.master = null; this.samples = [];
    this.voices = new Set(); this.maxVoices = 32; this.initializing = null;
  }
  async ready() {
    if (!this.Context) throw new Error('이 브라우저는 소리 재생을 지원하지 않아요. 최신 Chrome 또는 Safari로 열어 주세요.');
    if (!this.context || this.context.state === 'closed') {
      this.context = new this.Context();
      this.master = this.context.createGain(); this.master.gain.value = 0.75;
      if (this.context.createDynamicsCompressor) {
        this.compressor = this.context.createDynamicsCompressor();
        this.compressor.threshold.value = -12; this.compressor.knee.value = 18;
        this.compressor.ratio.value = 8; this.compressor.attack.value = 0.003;
        this.compressor.release.value = 0.12;
        this.master.connect(this.compressor); this.compressor.connect(this.context.destination);
      } else this.master.connect(this.context.destination);
      if (!this.samples.length) this.resetSamples();
    }
    if (this.context.state === 'suspended') {
      if (!this.initializing) this.initializing = this.context.resume().finally(() => { this.initializing = null; });
      await this.initializing;
    }
    if (this.context.state !== 'running') throw new Error('소리를 켜지 못했어요. 화면을 한 번 더 눌러 주세요.');
    return this;
  }
  async decode(arrayBuffer) { await this.ready(); return this.context.decodeAudioData(arrayBuffer); }
  resetSamples() {
    if (!this.context) return;
    this.stopAll();
    this.samples = SAMPLE_NAMES.map((name, index) => {
      const buffer = makeDemo(this.context, index);
      return {buffer, start: 0, end: buffer.duration, custom: false, name, gain: 1, pitch: 0};
    });
  }
  resetSample(index) {
    if (!this.context) throw new Error('먼저 소리를 켜 주세요.');
    if (!Number.isInteger(index) || index < 0 || index > 3) throw new Error('Invalid pad.');
    this.stopAll();
    const buffer = makeDemo(this.context, index);
    this.samples[index] = {buffer, start: 0, end: buffer.duration, custom: false, name: SAMPLE_NAMES[index], gain: 1, pitch: 0};
    return this.samples[index];
  }
  setSample(index, buffer, {custom = true, name = SAMPLE_NAMES[index]} = {}) {
    if (!Number.isInteger(index) || index < 0 || index > 3) throw new Error('Invalid pad.');
    if (!buffer || !Number.isFinite(buffer.duration) || buffer.duration <= 0 || buffer.duration > 30) throw new Error('30초 이하의 소리 파일을 골라 주세요.');
    this.samples[index] = {buffer, start: 0, end: Math.min(3, buffer.duration), custom, name: String(name).slice(0, 80), gain: 1, pitch: 0};
    return this.samples[index];
  }
  play(index, when = this.context?.currentTime || 0) {
    if (!this.context || this.context.state !== 'running' || !this.samples[index]) return null;
    const sample = this.samples[index], bounds = trimBounds(sample);
    if (bounds.end <= bounds.start) return null;
    if (this.voices.size >= this.maxVoices) this.releaseVoice(this.voices.values().next().value, true);
    const source = this.context.createBufferSource(), gain = this.context.createGain();
    const rate = 2 ** (clamp(sample.pitch ?? 0, -24, 24) / 12);
    const at = Math.max(this.context.currentTime, Number(when) || 0);
    const duration = (bounds.end - bounds.start) / rate;
    source.buffer = sample.buffer; source.playbackRate.value = rate;
    const volume = clamp(sample.gain ?? 1, 0, 2), fade = Math.min(0.005, duration / 3);
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(volume, at + fade);
    gain.gain.setValueAtTime(volume, Math.max(at + fade, at + duration - fade));
    gain.gain.linearRampToValueAtTime(0, at + duration);
    source.connect(gain); gain.connect(this.master);
    const voice = {source, gain}; this.voices.add(voice);
    source.onended = () => this.releaseVoice(voice, false);
    try { source.start(at, bounds.start, bounds.end - bounds.start); }
    catch (error) { this.releaseVoice(voice, true); throw error; }
    return voice;
  }
  releaseVoice(voice, stop) {
    if (!voice || !this.voices.has(voice)) return;
    this.voices.delete(voice); voice.source.onended = null;
    if (stop) { try { voice.source.stop(); } catch {} }
    try { voice.source.disconnect(); voice.gain.disconnect(); } catch {}
  }
  stopAll() { for (const voice of [...this.voices]) this.releaseVoice(voice, true); }
  exportWav(index) {
    const sample = this.samples[index];
    if (!sample) throw new Error('먼저 패드를 눌러 소리를 켜 주세요.');
    return new Blob([encodeWav(sample)], {type: 'audio/wav'});
  }
}

// Original sounds synthesized on this device; no third-party audio assets.
export function makeDemo(context, index) {
  const durations = [0.28, 0.13, 0.65, 0.4];
  const sampleRate = context.sampleRate;
  const buffer = context.createBuffer(1, Math.ceil(sampleRate * durations[index]), sampleRate);
  const data = buffer.getChannelData(0);
  let seed = 12673 + index * 131, phase = 0, previous = 0;
  const noise = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 2147483648 - 1; };
  for (let n = 0; n < data.length; n++) {
    const t = n / sampleRate; let value = 0;
    if (index === 0) { phase += 2 * Math.PI * (95 + 420 * Math.exp(-t * 35)) / sampleRate; value = Math.sin(phase) * Math.exp(-t * 20); }
    if (index === 1) { const rand = noise(); value = (rand - previous * 0.85) * Math.exp(-t * 70) * 0.8 + Math.sin(t * 2 * Math.PI * 1750) * Math.exp(-t * 100) * 0.3; previous = rand; }
    if (index === 2) { phase += 2 * Math.PI * (125 + 290 * Math.exp(-t * 8) + 12 * Math.sin(t * 44)) / sampleRate; value = (Math.sin(phase) + 0.18 * Math.sin(phase * 2)) * Math.exp(-t * 6); }
    if (index === 3) { const rand = noise(); value = (rand - previous * 0.6) * (0.22 + 0.78 * Math.max(0, Math.sin(t * 153))) * Math.exp(-t * 10); previous = rand; }
    const edge = Math.min(1, n / Math.max(1, sampleRate * 0.002), (data.length - n - 1) / Math.max(1, sampleRate * 0.008));
    data[n] = value * Math.max(0, edge) * 0.62;
  }
  return buffer;
}

export function encodeWav(sample) {
  const {buffer} = sample, {start, end} = trimBounds(sample);
  const rate = 2 ** (clamp(sample.pitch ?? 0, -24, 24) / 12);
  const frames = Math.max(1, Math.ceil((end - start) * buffer.sampleRate / rate));
  const channels = Math.max(1, Math.min(2, buffer.numberOfChannels));
  const bytes = new ArrayBuffer(44 + frames * channels * 2), view = new DataView(bytes);
  const str = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); str(8, 'WAVE'); str(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); str(36, 'data'); view.setUint32(40, frames * channels * 2, true);
  const volume = clamp(sample.gain ?? 1, 0, 2), channelData = Array.from({length: channels}, (_, c) => buffer.getChannelData(c));
  const fade = Math.max(1, Math.min(frames / 3, buffer.sampleRate * 0.005));
  for (let frame = 0; frame < frames; frame++) {
    const position = start * buffer.sampleRate + frame * rate, left = Math.floor(position), fraction = position - left;
    const edge = Math.min(1, frame / fade, (frames - frame - 1) / fade);
    for (let channel = 0; channel < channels; channel++) {
      const data = channelData[channel];
      const value = clamp(((data[Math.min(left, data.length - 1)] || 0) * (1 - fraction) + (data[Math.min(left + 1, data.length - 1)] || 0) * fraction) * volume * edge, -1, 1);
      view.setInt16(44 + (frame * channels + channel) * 2, value < 0 ? value * 32768 : value * 32767, true);
    }
  }
  return bytes;
}

export class MicController {
  constructor({getUserMedia = constraints => globalThis.navigator?.mediaDevices?.getUserMedia(constraints), MediaRecorder: Recorder = globalThis.MediaRecorder, onState = () => {}, onBlob = () => {}, onError = () => {}, setTimeout: timeout = globalThis.setTimeout, clearTimeout: clear = globalThis.clearTimeout, maxMs = 3000} = {}) {
    this.getUserMedia = getUserMedia; this.Recorder = Recorder; this.onState = onState;
    this.onBlob = onBlob; this.onError = onError; this.timeout = timeout; this.clear = clear;
    this.maxMs = clamp(maxMs, 100, 3000); this.state = 'idle'; this.generation = 0;
    this.stream = null; this.recorder = null; this.timer = null;
  }
  setState(state) { this.state = state; this.onState(state); }
  async start() {
    if (this.state !== 'idle') return false;
    const generation = ++this.generation;
    if (!this.Recorder || !this.getUserMedia) { this.onError(new Error('이 브라우저에서는 녹음할 수 없어요. 파일 가져오기를 이용해 주세요.')); return false; }
    this.setState('requesting');
    let stream;
    try {
      stream = await this.getUserMedia({audio: {echoCancellation: false, noiseSuppression: false, autoGainControl: false}, video: false});
      if (!stream) throw new Error('마이크를 사용할 수 없어요. 파일 가져오기를 이용해 주세요.');
      if (generation !== this.generation) { stopTracks(stream); return false; }
      this.stream = stream;
      const recorder = new this.Recorder(stream), chunks = [];
      this.recorder = recorder;
      recorder.ondataavailable = event => { if (generation === this.generation && event.data?.size) chunks.push(event.data); };
      recorder.onerror = event => {
        if (generation !== this.generation) return;
        const error = event.error || new Error('녹음에 실패했어요. 파일 가져오기를 이용해 주세요.');
        this.cancel(); this.onError(error);
      };
      recorder.onstop = () => {
        stopTracks(stream);
        if (generation !== this.generation) return;
        if (this.timer !== null) this.clear(this.timer);
        this.timer = null; this.stream = null; this.recorder = null;
        this.setState('idle');
        const blob = new Blob(chunks, {type: recorder.mimeType || chunks[0]?.type || 'audio/webm'});
        if (!blob.size) { this.onError(new Error('녹음된 소리가 없어요. 다시 녹음하거나 파일을 가져와 주세요.')); return; }
        this.onBlob(blob);
      };
      recorder.start(); this.setState('recording');
      this.timer = this.timeout(() => this.stop(), this.maxMs);
      return true;
    } catch (error) {
      stopTracks(stream);
      if (generation !== this.generation) return false;
      this.stream = null; this.recorder = null;
      this.setState('idle'); this.onError(error); return false;
    }
  }
  stop() {
    if (this.state === 'requesting') { this.cancel(); return; }
    if (this.state !== 'recording') return;
    if (this.timer !== null) this.clear(this.timer);
    this.timer = null; this.setState('processing');
    const recorder = this.recorder;
    try { if (recorder?.state !== 'inactive') recorder.stop(); }
    catch (error) { this.cancel(); this.onError(error); }
    finally { stopTracks(this.stream); this.stream = null; }
  }
  cancel() {
    ++this.generation;
    if (this.timer !== null) this.clear(this.timer);
    this.timer = null;
    const recorder = this.recorder; this.recorder = null;
    if (recorder) {
      recorder.ondataavailable = null; recorder.onstop = null; recorder.onerror = null;
      try { if (recorder.state !== 'inactive') recorder.stop(); } catch {}
    }
    stopTracks(this.stream); this.stream = null; this.setState('idle');
  }
}
