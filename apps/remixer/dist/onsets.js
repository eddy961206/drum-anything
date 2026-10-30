/**
 * Estimates attacks in a user-provided, already separated drum stem.
 * This is an energy-rise detector, not source separation, beat detection,
 * or kick/snare transcription. All analysis stays in this browser.
 */
export function detectOnsets(buffer, { sensitivity = 1 } = {}) {
  if (!buffer || typeof buffer.getChannelData !== 'function' ||
      !Number.isFinite(buffer.sampleRate) || buffer.sampleRate < 8000 ||
      !Number.isInteger(buffer.length) || buffer.length < 1 ||
      !Number.isInteger(buffer.numberOfChannels) || buffer.numberOfChannels < 1 ||
      buffer.numberOfChannels > 8) {
    throw new TypeError('분석할 수 있는 드럼 음원 버퍼가 필요해요.');
  }
  const duration = buffer.length / buffer.sampleRate;
  if (duration > 180.01) throw new RangeError('드럼 타이밍 분석은 3분 이하 구간으로 해주세요.');
  const amount = Number.isFinite(Number(sensitivity)) ? Math.min(2, Math.max(0.5, Number(sensitivity))) : 1;
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
  if (channels.some(channel => !channel || channel.length !== buffer.length)) {
    throw new TypeError('음원 채널의 길이를 읽을 수 없어요.');
  }

  // Separate channel energies prevent opposite-phase stereo from cancelling.
  const hop = Math.max(1, Math.round(buffer.sampleRate * 0.01));
  const frameCount = Math.ceil(buffer.length / hop);
  const energy = new Float32Array(frameCount);
  const rise = new Float32Array(frameCount);
  let peak = 0;
  for (let frame = 0; frame < frameCount; frame++) {
    const start = frame * hop;
    const end = Math.min(buffer.length, start + hop);
    let sum = 0;
    for (const channel of channels) {
      for (let sample = start; sample < end; sample++) {
        const value = channel[sample];
        // Malformed floating-point samples must not poison the envelope.
        if (Number.isFinite(value)) sum += value * value;
      }
    }
    const level = Math.sqrt(sum / ((end - start) * channels.length));
    energy[frame] = level;
    peak = Math.max(peak, level);
    rise[frame] = Math.max(0, level - (frame ? energy[frame - 1] : 0));
  }
  if (peak < 0.0001) return [];

  const candidates = [];
  const floor = Math.max(0.00012, peak * 0.018) / amount;
  const backgroundFrames = 20;
  let priorEnergy = 0;
  let priorRise = 0;
  for (let frame = 0; frame < frameCount; frame++) {
    const historyLength = Math.min(frame, backgroundFrames);
    const averageEnergy = historyLength ? priorEnergy / historyLength : 0;
    const averageRise = historyLength ? priorRise / historyLength : 0;
    const threshold = Math.max(floor, averageRise * 3.1 / amount,
      averageEnergy * 0.13 / amount, energy[frame] * 0.08 / amount);
    // Local maxima avoid treating a single attack's rising envelope as hits.
    if (rise[frame] > threshold && energy[frame] > floor * 2 &&
        rise[frame] >= (frame ? rise[frame - 1] : 0) &&
        rise[frame] > (frame + 1 < frameCount ? rise[frame + 1] : 0)) {
      candidates.push({ frame, strength: rise[frame] });
    }
    priorEnergy += energy[frame];
    priorRise += rise[frame];
    if (frame >= backgroundFrames) {
      priorEnergy -= energy[frame - backgroundFrames];
      priorRise -= rise[frame - backgroundFrames];
    }
  }

  // Within 90 ms keep the strongest rise; never manufacture a BPM/grid.
  const minimumFrames = Math.ceil(buffer.sampleRate * 0.09 / hop);
  const selected = [];
  for (const candidate of candidates) {
    const last = selected.at(-1);
    if (last && candidate.frame - last.frame < minimumFrames) {
      if (candidate.strength > last.strength) selected[selected.length - 1] = candidate;
    } else selected.push(candidate);
  }
  return selected.slice(0, 2500).map(({ frame }) => frame * hop / buffer.sampleRate);
}
