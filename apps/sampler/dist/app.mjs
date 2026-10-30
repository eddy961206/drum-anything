import { AudioEngine, MicController } from './audio.mjs';
import { Sequencer } from './core.mjs';

const $ = id => document.getElementById(id);
const names = ['뽁', '딱', '보잉', '바스락'];
const colors = ['var(--yellow)', 'var(--coral)', 'var(--blue)', 'var(--lilac)'];
const keys = ['KeyA', 'KeyS', 'KeyD', 'KeyF'];
const engine = new AudioEngine();
const pattern = Array.from({ length: 4 }, () => Array(16).fill(false));
const flashTimers = new Map();
let selected = 0;
let operation = 0;
let transportOperation = 0;
let capturePad = 0;
let captureOperation = 0;
let loading = false;
let importing = false;
let fileIntent = null;
let playing = false;
let demoNumber = 0;
let audioInitialised = false;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_FILE_SECONDS = 12;
const MIN_TRIM = 0.03;

function status(message, error = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', error);
}
function flash(index) {
  const card = document.querySelector(`[data-pad="${index}"]`).closest('.pad-card');
  clearTimeout(flashTimers.get(index));
  card.classList.add('hit');
  flashTimers.set(index, setTimeout(() => card.classList.remove('hit'), 110));
}
function setPlaying(value) {
  playing = value;
  $('transport').setAttribute('aria-pressed', String(value));
  $('transport-icon').textContent = value ? 'Ⅱ' : '▶';
  $('transport-text').textContent = value ? '멈춤' : '재생';
  $('play-state').textContent = value ? '우리 집 밴드, 연주 중.' : '마음에 드는 네모부터.';
}
const sequencer = new Sequencer(engine, {
  onStep(step) {
    document.querySelectorAll('.step.current').forEach(el => el.classList.remove('current'));
    if (step < 0) return;
    for (let row = 0; row < 4; row++) {
      $(`step-${row}-${step}`).classList.add('current');
      if (pattern[row][step]) flash(row);
    }
  },
  onStop() { setPlaying(false); }
});
function stopPlayback() {
  transportOperation++;
  sequencer.stop();
  engine.stopAll();
  setPlaying(false);
}
async function ready() {
  await engine.ready();
  if (!audioInitialised) {
    audioInitialised = true;
    refreshEditor();
  }
}
function captureBusy() {
  return mic.state !== 'idle' || loading || importing;
}
async function hit(index) {
  if (captureBusy()) return status('녹음·가져오기가 끝나면 다시 두드려 주세요.');
  const token = operation;
  try {
    await ready();
    if (token !== operation || document.hidden || captureBusy()) return;
    engine.play(index);
    flash(index);
  } catch {
    status('소리를 시작하지 못했어요. 브라우저의 소리 설정을 확인하고 다시 눌러 주세요.', true);
  }
}
function makeGrid() {
  const grid = $('sequence');
  grid.append(document.createElement('span'));
  for (let step = 0; step < 16; step++) {
    const number = document.createElement('span');
    number.className = 'step-number';
    number.textContent = String(step + 1);
    number.setAttribute('aria-hidden', 'true');
    grid.append(number);
  }
  for (let row = 0; row < 4; row++) {
    const label = document.createElement('span');
    label.className = 'row-label';
    label.style.setProperty('--color', colors[row]);
    const dot = document.createElement('span');
    dot.className = 'row-dot'; dot.setAttribute('aria-hidden', 'true');
    label.append(dot, document.createTextNode(names[row]));
    grid.append(label);
    for (let step = 0; step < 16; step++) {
      const button = document.createElement('button');
      button.id = `step-${row}-${step}`;
      button.className = `step${step > 0 && step % 4 === 0 ? ' group-start' : ''}`;
      button.style.setProperty('--color', colors[row]);
      button.setAttribute('aria-label', `${names[row]} ${step + 1}번째 칸`);
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => {
        pattern[row][step] = !pattern[row][step];
        renderPattern();
        if (!playing && pattern[row][step]) void hit(row);
      });
      button.addEventListener('keydown', event => {
        const offsets = { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0] };
        const offset = offsets[event.key];
        if (!offset) return;
        event.preventDefault();
        $(`step-${(row + offset[0] + 4) % 4}-${(step + offset[1] + 16) % 16}`).focus();
      });
      grid.append(button);
    }
  }
}
function renderPattern() {
  pattern.forEach((row, i) => row.forEach((value, j) => $(`step-${i}-${j}`).setAttribute('aria-pressed', String(value))));
}
function fillDemo() {
  const demos = [
    [[0, 8], [4, 12], [6, 14], [2, 6, 10, 14]],
    [[0, 7, 10], [4, 12], [3, 11, 15], [0, 2, 6, 8, 10, 14]],
    [[0, 8, 11], [4, 12, 15], [2, 7, 14], [2, 6, 10, 13]]
  ];
  const chosen = demos[demoNumber++ % demos.length];
  for (let row = 0; row < 4; row++) for (let step = 0; step < 16; step++) pattern[row][step] = chosen[row].includes(step);
  renderPattern();
}
function confirmReplace(index) {
  return !engine.samples[index]?.custom || window.confirm('이 패드의 내 소리를 바꿀까요? 저장하지 않은 기존 소리는 사라져요. 취소한 뒤 WAV로 먼저 저장할 수 있어요.');
}
function updateCaptureUI(state) {
  const pending = state === 'requesting';
  const recording = state === 'recording';
  $('record').classList.toggle('recording', recording);
  $('record-text').textContent = pending ? '요청 취소' : recording ? '녹음 끝내기' : state === 'processing' || loading ? '소리 준비 중…' : '3초 녹음';
  $('record').disabled = state === 'processing' || loading || importing;
  $('import').disabled = state !== 'idle' || loading || importing;
  $('reset-sample').disabled = state !== 'idle' || loading || importing;
  if (pending) status('마이크 허용을 기다려요. 필요 없다면 요청 취소를 눌러 주세요.');
  if (recording) status('지금 녹음 중! 3초 뒤 자동으로 끝나요. 먼저 끝내도 좋아요.');
}
const mic = new MicController({
  maxMs: 3000,
  onState: updateCaptureUI,
  async onBlob(blob) {
    const token = captureOperation;
    const index = capturePad;
    if (token !== operation || document.hidden) return;
    loading = true;
    updateCaptureUI('processing');
    try {
      await ready();
      const buffer = await engine.decode(await blob.arrayBuffer());
      if (token !== operation || document.hidden) return;
      engine.setSample(index, buffer, { custom: true, name: '내 녹음' });
      refreshEditor();
      status(`${index + 1}번 패드에 내 소리를 담았어요. 시작·끝을 잘라서 두드려 보세요!`);
    } catch {
      if (token === operation) status('녹음 소리를 읽지 못했어요. 다시 녹음하거나 파일 가져오기를 이용해 주세요.', true);
    } finally {
      if (token === operation) { loading = false; updateCaptureUI('idle'); }
    }
  },
  onError(error) {
    loading = false;
    const denied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError';
    status(denied ? '마이크 권한이 없어요. 주소창에서 마이크를 허용하거나, 파일 가져오기로 내 소리를 넣어 주세요.' : '이 브라우저에서 녹음을 시작하지 못했어요. 파일 가져오기로 WAV·MP3 등 짧은 소리를 넣을 수 있어요.', true);
    updateCaptureUI('idle');
  }
});
function cancelOperation() {
  operation++;
  mic.cancel();
  loading = false;
  importing = false;
  updateCaptureUI('idle');
}
function refreshEditor() {
  const sample = engine.samples[selected];
  $('editor-title').replaceChildren(document.createTextNode(`${selected + 1}번 소리 바꾸기 `));
  const small = document.createElement('small'); small.textContent = `(${names[selected]})`;
  $('editor-title').append(small);
  document.querySelectorAll('[data-edit]').forEach(el => el.setAttribute('aria-pressed', String(Number(el.dataset.edit) === selected)));
  engine.samples.forEach((item, index) => { $(`origin-${index}`).textContent = item.custom ? item.name : '기본 소리'; });
  if (!sample?.buffer) return;
  const length = sample.buffer.duration;
  $('duration').textContent = `${length.toFixed(2)}초`;
  $('trim-start').max = String(Math.max(0, length - MIN_TRIM));
  $('trim-end').max = String(length);
  $('trim-end').min = String(Math.min(MIN_TRIM, length));
  $('trim-start').value = String(sample.start);
  $('trim-end').value = String(sample.end);
  refreshTrim(); drawWaveform(sample.buffer);
}
function refreshTrim() {
  const sample = engine.samples[selected];
  if (!sample?.buffer) return;
  $('start-value').value = `${sample.start.toFixed(2)}초`;
  $('end-value').value = `${sample.end.toFixed(2)}초`;
  $('trim-window').style.left = `${sample.start / sample.buffer.duration * 100}%`;
  $('trim-window').style.right = `${(1 - sample.end / sample.buffer.duration) * 100}%`;
}
function drawWaveform(buffer) {
  const canvas = $('waveform');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const data = buffer.getChannelData(0), width = canvas.width, height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = '#b69e69'; ctx.lineWidth = 2; ctx.beginPath();
  for (let x = 0; x < width; x += 3) {
    const from = Math.floor(x / width * data.length), to = Math.max(from + 1, Math.floor((x + 3) / width * data.length));
    let peak = 0;
    for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(data[i]));
    const h = Math.max(1, peak * height * .46);
    ctx.moveTo(x, height / 2 - h); ctx.lineTo(x, height / 2 + h);
  }
  ctx.stroke();
}

makeGrid(); fillDemo();
for (const button of document.querySelectorAll('[data-pad]')) {
  button.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault(); button.focus({ preventScroll: true });
    void hit(Number(button.dataset.pad));
  });
  button.addEventListener('click', event => { if (event.detail === 0) void hit(Number(button.dataset.pad)); });
  button.addEventListener('keydown', event => {
    if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault();
  });
}
for (const button of document.querySelectorAll('[data-edit]')) {
  button.addEventListener('click', async () => {
    const hadPending = captureBusy();
    fileIntent = null;
    cancelOperation();
    selected = Number(button.dataset.edit);
    refreshEditor();
    if (hadPending) status('진행 중이던 녹음·가져오기는 취소했어요. 기존 소리는 그대로예요.');
    try { await ready(); refreshEditor(); } catch { status('소리 기능을 사용할 수 없는 브라우저예요.', true); }
    $('editor-title').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}
document.addEventListener('keydown', event => {
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
  const index = keys.indexOf(event.code);
  if (index < 0) return;
  event.preventDefault(); void hit(index);
});
$('transport').addEventListener('click', async () => {
  if (playing) { stopPlayback(); return; }
  if (captureBusy()) return status('녹음·가져오기가 끝나면 밴드를 시작할 수 있어요.');
  const token = ++transportOperation;
  setPlaying(true);
  try {
    await ready();
    if (token !== transportOperation || document.hidden || captureBusy()) return;
    sequencer.start(pattern, Number($('bpm').value));
  } catch {
    if (token === transportOperation) { setPlaying(false); status('재생을 시작하지 못했어요. 브라우저 소리 설정을 확인해 주세요.', true); }
  }
});
$('bpm').addEventListener('change', () => {
  const value = Math.round(Math.max(50, Math.min(180, Number($('bpm').value) || 104)));
  $('bpm').value = String(value); sequencer.setBpm(value);
});
$('clear-pattern').addEventListener('click', () => { stopPlayback(); pattern.forEach(row => row.fill(false)); renderPattern(); status('비트만 비웠어요. 담아 둔 소리는 그대로예요.'); });
$('demo-pattern').addEventListener('click', () => { fillDemo(); status('다른 추천 비트를 놓았어요. 내 소리는 바뀌지 않아요.'); });
$('record').addEventListener('click', async () => {
  if (mic.state === 'recording') { mic.stop(); return; }
  if (mic.state === 'requesting') { cancelOperation(); status('마이크 요청을 취소했어요. 권한 창이 남아 있다면 닫아도 돼요.'); return; }
  if (captureBusy() || !confirmReplace(selected)) return;
  fileIntent = null;
  stopPlayback(); cancelOperation(); capturePad = selected; captureOperation = operation;
  const token = operation;
  loading = true; updateCaptureUI('processing');
  try {
    // Unlock audio in the explicit click gesture, not after the recording ends.
    await ready();
    if (token !== operation || document.hidden) return;
    loading = false; updateCaptureUI('idle');
    await mic.start();
  } catch {
    if (token === operation) { loading = false; updateCaptureUI('idle'); status('소리를 준비하지 못했어요. 브라우저의 소리 설정을 확인해 주세요.', true); }
  }
});
$('import').addEventListener('click', () => {
  if (captureBusy() || !confirmReplace(selected)) return;
  // Start audio unlock in this gesture; keep file.click synchronous for mobile pickers.
  void ready().catch(() => status('브라우저가 소리를 준비하지 못했어요. 오디오 설정을 확인해 주세요.', true));
  fileIntent = { index: selected, sample: engine.samples[selected] };
  $('file').value = ''; $('file').click();
});
$('file').addEventListener('change', async () => {
  const file = $('file').files?.[0];
  const intent = fileIntent; fileIntent = null;
  if (!file) return;
  if (!intent || intent.index !== selected || intent.sample !== engine.samples[selected] || captureBusy()) return status('선택한 패드가 바뀌어 파일 가져오기를 취소했어요. 다시 파일을 골라 주세요.');
  if (file.size > MAX_FILE_BYTES) return status('8MB 이하의 짧은 소리 파일을 골라 주세요.', true);
  stopPlayback(); cancelOperation(); importing = true;
  const token = operation, index = selected;
  updateCaptureUI('idle'); status('내 기기 안에서 소리를 읽고 있어요. 업로드하지 않아요.');
  try {
    await ready();
    const buffer = await engine.decode(await file.arrayBuffer());
    if (token !== operation || document.hidden) return;
    if (buffer.duration > MAX_FILE_SECONDS || buffer.duration < MIN_TRIM) throw new RangeError('duration');
    engine.setSample(index, buffer, { custom: true, name: file.name });
    refreshEditor(); status(`${index + 1}번에 소리를 담았어요. 쓸 부분을 골라 보세요.`);
  } catch (error) {
    if (token === operation) status(error instanceof RangeError ? '0.03초 이상 12초 이하의 파일을 골라 주세요. 기존 소리는 그대로예요.' : '이 파일을 읽지 못했어요. WAV 또는 브라우저가 지원하는 오디오 파일을 골라 주세요.', true);
  } finally {
    if (token === operation) { importing = false; updateCaptureUI('idle'); }
    $('file').value = '';
  }
});
for (const side of ['start', 'end']) $('trim-' + side).addEventListener('input', () => {
  const sample = engine.samples[selected]; if (!sample?.buffer) return;
  if (side === 'start') sample.start = Math.min(Number($('trim-start').value), sample.end - MIN_TRIM);
  else sample.end = Math.max(Number($('trim-end').value), sample.start + MIN_TRIM);
  sample.start = Math.max(0, sample.start); sample.end = Math.min(sample.buffer.duration, sample.end);
  $('trim-start').value = String(sample.start); $('trim-end').value = String(sample.end); refreshTrim();
});
$('preview').addEventListener('click', () => void hit(selected));
$('reset-sample').addEventListener('click', async () => {
  if (captureBusy() || !confirmReplace(selected)) return;
  const token = operation, index = selected;
  try {
    await ready(); if (token !== operation) return;
    engine.resetSample(index); refreshEditor(); status(`${index + 1}번 패드만 기본 소리로 되돌렸어요. 비트는 그대로예요.`);
  } catch { status('기본 소리로 되돌리지 못했어요.', true); }
});
$('export').addEventListener('click', async () => {
  if (captureBusy()) return status('소리가 준비된 뒤에 저장해 주세요.');
  const index = selected;
  try {
    await ready(); const blob = engine.exportWav(index);
    const url = URL.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = url; anchor.download = `sound-${index + 1}.wav`;
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status('WAV 다운로드를 요청했어요. 브라우저의 다운로드 목록을 확인해 주세요.');
  } catch { status('WAV를 만들지 못했어요. 소리를 먼저 준비해 주세요.', true); }
});
function quietDown() {
  const pending = captureBusy();
  cancelOperation(); stopPlayback();
  if (pending) status('화면을 떠나 녹음·가져오기를 취소했어요. 기존 소리는 그대로예요.');
}
document.addEventListener('visibilitychange', () => { if (document.hidden) quietDown(); });
window.addEventListener('pagehide', quietDown);
window.addEventListener('beforeunload', event => {
  quietDown();
  if (engine.samples.some(sample => sample.custom)) { event.preventDefault(); event.returnValue = ''; }
});
if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
  $('record-help').textContent = '이 브라우저에서는 녹음을 사용할 수 없어요. 파일 가져오기로 내 소리를 넣어 주세요.';
}
