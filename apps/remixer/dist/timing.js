export const MIN_BPM = 40;
export const MAX_BPM = 220;

export function normalizeBpm(value, fallback = 104) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(n))) : fallback;
}

// Both position and anchor are seconds in the song, not wall-clock timestamps.
export function nextBeatDelay(position, bpm, anchor = 0) {
  if (![position, bpm, anchor].every(Number.isFinite) || bpm <= 0) return 0;
  const beat = 60 / bpm;
  const phase = ((position - anchor) % beat + beat) % beat;
  // A tap right on the beat should sound now, rather than one beat late.
  return phase < 0.012 || beat - phase < 0.012 ? 0 : beat - phase;
}

// performance.now() timestamps, milliseconds. Ignore one clearly missed tap.
export function bpmFromTaps(times) {
  if (!Array.isArray(times) || times.length < 2) return null;
  const intervals = times.slice(-7).slice(1).map((time, i) => time - times.slice(-7)[i]);
  if (!intervals.length || intervals.some(n => !Number.isFinite(n) || n <= 0)) return null;
  const sorted = [...intervals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const usable = intervals.filter(n => n > median * 0.65 && n < median * 1.35);
  const bpm = 60000 / (usable.reduce((sum, n) => sum + n, 0) / usable.length);
  return bpm >= MIN_BPM && bpm <= MAX_BPM ? Math.round(bpm) : null;
}
