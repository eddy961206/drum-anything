// Browser-local musical primitives. No network, storage, or dependencies.
export const PAD_COUNT = 4;
export const STEP_COUNT = 16;
export const SAMPLE_NAMES = ['뽁', '딱', '보잉', '바스락'];
export const clamp = (value, min, max) => Math.max(min, Math.min(max, Number.isFinite(Number(value)) ? Number(value) : min));
export const clampBpm = value => clamp(value, 50, 180);
export const blankPattern = () => Array.from({length: PAD_COUNT}, () => Array(STEP_COUNT).fill(false));
export function demoPattern(variant = 0) {
  const result = blankPattern();
  const hits = variant % 3 === 1
    ? [[0, 6, 8, 14], [4, 12], [3, 11, 15], [2, 5, 10, 13]]
    : variant % 3 === 2
      ? [[0, 8, 10], [4, 12, 15], [6, 14], [2, 3, 6, 10, 11, 14]]
      : [[0, 4, 8, 12], [4, 12], [7, 15], [2, 6, 10, 14]];
  hits.forEach((row, index) => row.forEach(step => { result[index][step] = true; }));
  return result;
}
export function trimBounds(sample) {
  const duration = Math.max(0, Number(sample?.buffer?.duration) || 0);
  const minLength = Math.min(0.02, duration);
  const start = clamp(sample?.start ?? 0, 0, Math.max(0, duration - minLength));
  return {start, end: clamp(sample?.end ?? duration, start + minLength, duration)};
}
export function validatePattern(pattern) {
  return Array.isArray(pattern) && pattern.length === PAD_COUNT && pattern.every(row => Array.isArray(row) && row.length === STEP_COUNT);
}

// One audio-context clock drives both sounds and the visible playhead.
export class Sequencer {
  constructor(engine, {onStep = () => {}, onStop = () => {}, setInterval: interval = globalThis.setInterval, clearInterval: clear = globalThis.clearInterval} = {}) {
    this.engine = engine; this.onStep = onStep; this.onStop = onStop;
    this.interval = interval; this.clear = clear;
    this.playing = false; this.timer = null; this.pending = [];
    this.bpm = 104; this.pattern = blankPattern(); this.nextStep = 0;
  }
  start(pattern = this.pattern, bpm = this.bpm) {
    if (!validatePattern(pattern)) throw new Error('A pattern needs 4 rows of 16 steps.');
    if (!this.engine.context || this.engine.context.state !== 'running') throw new Error('Audio is not ready.');
    if (this.playing) return false;
    this.pattern = pattern; this.setBpm(bpm); this.playing = true;
    this.pending = []; this.nextStep = 0; this.nextTime = this.engine.context.currentTime + 0.035;
    this.tick(); this.timer = this.interval(() => this.tick(), 25);
    return true;
  }
  setBpm(value) { this.bpm = clampBpm(value); return this.bpm; }
  tick() {
    if (!this.playing) return;
    const now = this.engine.context.currentTime;
    if (this.engine.context.state === 'suspended' || this.engine.context.state === 'closed') { this.stop(); return; }
    // Never replay a backlog after system sleep or a stalled main thread.
    if (this.nextTime < now - 0.12) { this.nextTime = now + 0.035; this.pending = []; }
    let count = 0;
    while (this.nextTime < now + 0.085 && count++ < STEP_COUNT) {
      const step = this.nextStep;
      for (let row = 0; row < PAD_COUNT; row++) if (this.pattern[row][step]) this.engine.play(row, this.nextTime);
      this.pending.push({step, time: this.nextTime});
      this.nextTime += 60 / this.bpm / 4;
      this.nextStep = (step + 1) % STEP_COUNT;
    }
    while (this.pending.length && this.pending[0].time <= now) this.onStep(this.pending.shift().step);
  }
  stop() {
    const wasPlaying = this.playing;
    this.playing = false;
    if (this.timer !== null) this.clear(this.timer);
    this.timer = null; this.pending = []; this.nextStep = 0;
    this.engine.stopAll(); this.onStep(-1);
    if (wasPlaying) this.onStop();
  }
}
