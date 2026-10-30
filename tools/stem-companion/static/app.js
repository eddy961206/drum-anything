// Original local-only UI. No third-party scripts, remote assets, telemetry, or storage.
const $ = (id) => document.getElementById(id);
const STEMS = ['vocals', 'bass', 'drums', 'other'];
const LABELS = { vocals: '보컬', bass: '베이스', drums: '드럼', other: '다른 악기' };
const MODES = { all: STEMS, vocals: ['vocals'], instrumental: ['bass', 'drums', 'other'], drummer: ['vocals', 'bass', 'other'] };
const TERMINAL = new Set(['ready', 'failed', 'cancelled', 'dependency_missing']);
const STAGES = ['acquiring', 'normalizing', 'separating', 'analyzing', 'ready'];
const STATUS = { queued: '대기 중', acquiring: '가져오는 중', normalizing: '구간 정리 중', separating: '분리 중', analyzing: '분석 중', ready: '준비 완료', cancelled: '취소됨', failed: '실패', dependency_missing: '설치 / 모델 설정 필요' };
let session = null, source = 'file', job = null, operation = false, pollTimer = null, pollGeneration = 0;
let loadedId = null, loadingId = null, loadGeneration = 0, loadController = null;
let ctx = null, master = null, buffers = {}, nodes = [], gains = {}, duration = 0, offset = 0, startedAt = 0;
let playing = false, playbackLoop = true, playbackGeneration = 0, audioLoaded = false, onsets = [];
const volumes = Object.fromEntries(STEMS.map((stem) => [stem, 0.8]));
const muted = Object.fromEntries(STEMS.map((stem) => [stem, false]));

function errorText(error) { return error instanceof Error ? error.message : String(error); }
function showError(id, message = '') { $(id).textContent = message; $(id).hidden = !message; }
function listMissing(items) { return (items || []).map((v) => typeof v === 'string' ? v : JSON.stringify(v)).join(', '); }
function formatTime(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
function checkNumber(value, minimum, maximum, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${label}: ${minimum}~${maximum} 사이의 숫자를 입력해 주세요.`);
  return parsed;
}
function mediaPath(path, id) {
  // Never follow URLs supplied by an unexpected response to another host/origin.
  if (typeof path !== 'string' || !path.startsWith('/media/') || path.includes('\\')) throw new Error('잘못된 로컬 음원 경로예요.');
  const url = new URL(path, location.origin);
  if (url.origin !== location.origin || url.search || url.hash || !url.pathname.startsWith(`/media/${encodeURIComponent(id)}/`)) throw new Error('잘못된 로컬 음원 경로예요.');
  return url.pathname;
}
async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.method && options.method !== 'GET') headers.set('X-CSRF-Token', session?.csrf || '');
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin', cache: 'no-store' });
  let body;
  try { body = await response.json(); } catch { throw new Error(`로컬 서버 응답을 읽을 수 없어요 (${response.status}).`); }
  if (!response.ok) {
    const message = typeof body.error === 'string' ? body.error : body.message || JSON.stringify(body.error || body);
    throw new Error(`${message}${response.status === 403 ? ' 페이지를 새로고침해 다시 연결해 주세요.' : ''}`);
  }
  return body;
}
function renderDependencies() {
  const deps = session?.dependencies;
  const notice = $('dependencies');
  if (!deps) return;
  const available = source === 'youtube' ? (deps.youtube_ready ?? deps.ready) : deps.ready;
  const missing = [...(deps.missing || []), ...(source === 'youtube' ? (deps.youtube_missing || []) : [])];
  notice.className = `dependency-notice ${available ? 'ready' : 'missing'}`;
  notice.textContent = available ? '실행 환경 준비 완료. 파일은 이 컴퓨터에서 처리하고, 분리된 파트도 로컬에서 재생해요.' : `먼저 실행 환경을 준비해 주세요: ${listMissing(missing) || '필수 도구 또는 모델 설정이 없어요'}. README의 설치·모델 설정을 마친 뒤 서버를 다시 실행해 주세요.`;
  refreshSubmit();
}
function refreshSubmit() {
  const deps = session?.dependencies;
  const ready = source === 'youtube' ? (deps?.youtube_ready ?? deps?.ready) : deps?.ready;
  $('create-job').disabled = !ready || operation || Boolean(job);
  $('create-job').textContent = operation ? (source === 'file' ? '파일을 로컬 서버로 보내는 중…' : '작업을 요청하는 중…') : job ? '현재 작업을 삭제한 뒤 새로 시작' : '음원 분리 시작';
  $('cancel-job').disabled = operation;
  $('delete-job').disabled = operation;
}
function selectSource(value) {
  source = value;
  document.querySelectorAll('[data-source]').forEach((button) => {
    const selected = button.dataset.source === source;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  $('file-field').hidden = source !== 'file';
  $('youtube-field').hidden = source !== 'youtube';
  $('file-input').required = source === 'file';
  $('youtube-input').required = source === 'youtube';
  showError('form-error');
  renderDependencies();
}
function renderJob(value) {
  job = value;
  $('job-section').hidden = !job;
  if (!job) {
    $('player-section').hidden = true;
    refreshSubmit();
    return;
  }
  const terminal = TERMINAL.has(job.status);
  $('job-heading').textContent = job.status === 'ready' ? '네 파트가 준비됐어요' : job.status === 'cancelled' ? '작업을 취소했어요' : ['failed', 'dependency_missing'].includes(job.status) ? '작업을 마치지 못했어요' : '노래를 준비하고 있어요';
  $('job-message').textContent = job.message || STATUS[job.status] || job.status;
  $('job-badge').textContent = STATUS[job.status] || job.status;
  showError('job-error', job.error ? errorText(job.error) : '');
  $('cancel-job').hidden = terminal;
  $('delete-job').hidden = !terminal;
  const index = STAGES.indexOf(job.status);
  document.querySelectorAll('[data-stage]').forEach((element) => {
    const stageIndex = STAGES.indexOf(element.dataset.stage);
    element.classList.toggle('active', stageIndex === index);
    element.classList.toggle('done', stageIndex < index);
    element.setAttribute('aria-current', stageIndex === index ? 'step' : 'false');
  });
  if (job.status === 'ready') {
    $('player-section').hidden = false;
    if (loadedId !== job.id && loadingId !== job.id) loadAudio(job);
  }
  refreshSubmit();
}
function schedulePoll(id) {
  clearTimeout(pollTimer);
  const generation = ++pollGeneration;
  const poll = async () => {
    if (generation !== pollGeneration) return;
    try {
      const result = await api(`/api/jobs/${encodeURIComponent(id)}`);
      if (generation !== pollGeneration) return;
      renderJob(result.job || result);
      if (TERMINAL.has(job.status)) return;
    } catch (error) {
      if (generation !== pollGeneration) return;
      showError('job-error', `연결을 확인하는 중이에요: ${errorText(error)} 서버가 실행 중인지 확인해 주세요. 자동으로 다시 확인해요.`);
    }
    pollTimer = setTimeout(poll, 1200);
  };
  pollTimer = setTimeout(poll, 600);
}
async function submitJob(event) {
  event.preventDefault();
  if (operation || job || !session) return;
  showError('form-error');
  try {
    const maxDuration = Math.min(180, session.limits?.max_excerpt_seconds || 180);
    const start = checkNumber($('excerpt-start').value, 0, (session.limits?.max_source_seconds || 900) - 1, '시작 위치');
    const length = checkNumber($('excerpt-duration').value, 1, maxDuration, '연습할 길이');
    if (!$('rights-confirmed').checked) throw new Error('이용 권한과 서비스 약관을 확인한 뒤 체크해 주세요.');
    let path, options;
    if (source === 'file') {
      const file = $('file-input').files[0];
      if (!file) throw new Error('먼저 음악 파일을 선택해 주세요.');
      const limit = session.limits?.max_upload_bytes || 100 * 1024 * 1024;
      if (!file.size || file.size > limit) throw new Error(`0바이트보다 크고 ${Math.floor(limit / 1024 / 1024)} MB 이하인 파일을 선택해 주세요.`);
      const extension = (file.name.match(/\.([a-z0-9]{1,8})$/i)?.[1] || 'bin').toLowerCase();
      path = `/api/upload?${new URLSearchParams({ start_seconds: String(start), duration_seconds: String(length), rights_confirmed: '1' })}`;
      options = { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': `upload.${extension}` } };
    } else {
      const url = $('youtube-input').value.trim();
      if (!url) throw new Error('공개된 단일 YouTube 영상 주소를 입력해 주세요.');
      path = '/api/jobs';
      options = { method: 'POST', body: JSON.stringify({ youtube_url: url, start_seconds: start, duration_seconds: length, rights_confirmed: true }), headers: { 'Content-Type': 'application/json' } };
    }
    operation = true;
    refreshSubmit();
    const result = await api(path, options);
    renderJob(result.job || result);
    if (!TERMINAL.has(job.status)) schedulePoll(job.id);
  } catch (error) {
    showError('form-error', errorText(error));
    // A response can be lost after the server accepted a job; recover instead of resubmitting.
    try {
      const current = await api('/api/session');
      session = current;
      if (current.job) { renderJob(current.job); if (!TERMINAL.has(job.status)) schedulePoll(job.id); }
    } catch { /* Keep the actionable original error. */ }
  } finally { operation = false; renderDependencies(); refreshSubmit(); }
}
async function cancelJob() {
  if (!job || operation || TERMINAL.has(job.status)) return;
  operation = true;
  refreshSubmit();
  try {
    const result = await api(`/api/jobs/${encodeURIComponent(job.id)}/cancel`, { method: 'POST' });
    renderJob(result.job || result);
    if (!TERMINAL.has(job.status)) schedulePoll(job.id);
  } catch (error) { showError('job-error', errorText(error)); }
  finally { operation = false; refreshSubmit(); }
}
async function deleteJob() {
  if (!job || operation || !TERMINAL.has(job.status)) return;
  if (!window.confirm('이 작업의 가져온 음원과 분리 파일을 로컬 캐시에서 삭제할까요? 원래 선택한 음악 파일은 삭제하지 않아요.')) return;
  operation = true;
  refreshSubmit();
  try {
    await api(`/api/jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE' });
    clearTimeout(pollTimer); pollGeneration += 1;
    resetAudio();
    renderJob(null);
    $('rights-confirmed').checked = false;
    showError('form-error');
  } catch (error) { showError('job-error', errorText(error)); }
  finally { operation = false; refreshSubmit(); }
}
function audioContext() {
  if (!ctx) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) throw new Error('이 브라우저는 Web Audio를 지원하지 않아요. 최신 브라우저로 열어 주세요.');
    ctx = new AudioContext({ latencyHint: 'interactive' });
    master = ctx.createGain();
    master.gain.value = 0.72;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -8; limiter.knee.value = 12; limiter.ratio.value = 8;
    master.connect(limiter); limiter.connect(ctx.destination);
  }
  return ctx;
}
function position() {
  if (!playing || !ctx) return offset;
  const elapsed = offset + Math.max(0, ctx.currentTime - startedAt);
  return playbackLoop && duration > 0 ? elapsed % duration : Math.min(duration, elapsed);
}
function stopSources() {
  playbackGeneration += 1;
  for (const node of nodes) { node.onended = null; try { node.stop(); } catch { /* Already ended. */ } node.disconnect(); }
  for (const gain of Object.values(gains)) gain.disconnect();
  nodes = []; gains = {};
  playing = false;
  $('play').textContent = '▶'; $('play').setAttribute('aria-label', '재생');
}
function pause() { offset = position(); stopSources(); }
function resetAudio() {
  loadGeneration += 1;
  loadController?.abort(); loadController = null;
  stopSources();
  buffers = {}; duration = 0; offset = 0; onsets = []; audioLoaded = false; loadedId = null; loadingId = null;
  $('play').disabled = true; $('seek').disabled = true; $('seek').value = '0';
  $('stem-downloads').replaceChildren();
}
async function loadAudio(readyJob) {
  resetAudio();
  loadingId = readyJob.id;
  const generation = loadGeneration;
  const controller = new AbortController(); loadController = controller;
  $('audio-status').textContent = '네 파트를 로컬에서 불러오고 있어요…';
  showError('audio-error');
  try {
    const context = audioContext();
    const entries = await Promise.all(STEMS.map(async (stem) => {
      const path = mediaPath(readyJob.stems?.[stem], readyJob.id);
      const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
      if (!response.ok) throw new Error(`${LABELS[stem]} 파일을 읽지 못했어요 (${response.status}).`);
      const audio = await context.decodeAudioData(await response.arrayBuffer());
      return [stem, audio];
    }));
    if (generation !== loadGeneration || job?.id !== readyJob.id) return;
    buffers = Object.fromEntries(entries);
    duration = Math.min(...entries.map(([, buffer]) => buffer.duration));
    if (!Number.isFinite(duration) || duration <= 0 || duration > 181) throw new Error('음원 구간 길이가 올바르지 않아요.');
    const spread = Math.max(...entries.map(([, buffer]) => buffer.duration)) - duration;
    if (spread > 0.1) throw new Error('분리된 파트 길이가 서로 맞지 않아요. 다시 분리해 주세요.');
    onsets = (readyJob.onsets || []).filter((value) => Number.isFinite(value) && value >= 0 && value < duration).sort((a, b) => a - b);
    audioLoaded = true; loadedId = readyJob.id; loadingId = null;
    $('seek').max = String(duration); $('seek').disabled = false; $('play').disabled = false;
    $('total-time').textContent = formatTime(duration);
    $('audio-status').textContent = '재생을 누르면 네 파트가 함께 시작해요.';
    $('onset-count').textContent = `${onsets.length}개 추정 지점`;
    for (const stem of STEMS) {
      const link = document.createElement('a');
      link.href = mediaPath(readyJob.stems[stem], readyJob.id); link.download = `${stem}.wav`;
      link.textContent = `${LABELS[stem]} WAV 저장`; $('stem-downloads').append(link);
    }
  } catch (error) {
    if (generation !== loadGeneration || controller.signal.aborted) return;
    // Mark this attempt complete: polling must not repeatedly refetch a broken output.
    loadedId = readyJob.id; loadingId = null;
    $('audio-status').textContent = '재생 파일을 불러오지 못했어요.';
    showError('audio-error', `${errorText(error)} 서버 상태를 확인하고 페이지를 새로고침하면 다시 불러와요.`);
  }
}
function applyGains() {
  for (const stem of STEMS) {
    if (gains[stem] && ctx) gains[stem].gain.setTargetAtTime(muted[stem] ? 0 : volumes[stem], ctx.currentTime, 0.015);
    const mute = $(`mute-${stem}`);
    mute.setAttribute('aria-pressed', String(muted[stem])); mute.textContent = muted[stem] ? '꺼짐' : '켜짐';
    $(`volume-${stem}`).value = String(volumes[stem]);
    $(`value-${stem}`).textContent = `${Math.round(volumes[stem] * 100)}%`;
  }
}
function setMode(mode) {
  for (const stem of STEMS) muted[stem] = !MODES[mode].includes(stem);
  document.querySelectorAll('[data-mode]').forEach((button) => {
    const selected = button.dataset.mode === mode; button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected));
  });
  applyGains();
}
function clearMode() { document.querySelectorAll('[data-mode]').forEach((button) => { button.classList.remove('selected'); button.setAttribute('aria-pressed', 'false'); }); }
async function play() {
  if (!audioLoaded || playing) return;
  const generation = ++playbackGeneration;
  const context = audioContext();
  await context.resume();
  if (generation !== playbackGeneration || !audioLoaded) return;
  if (offset >= duration - 0.005) offset = 0;
  startedAt = context.currentTime + 0.04;
  playbackLoop = $('loop').checked;
  for (const stem of STEMS) {
    const node = context.createBufferSource();
    node.buffer = buffers[stem]; node.loop = playbackLoop; node.loopStart = 0; node.loopEnd = duration;
    const gain = context.createGain(); gain.gain.value = muted[stem] ? 0 : volumes[stem];
    node.connect(gain); gain.connect(master); gains[stem] = gain; nodes.push(node);
    node.start(startedAt, offset);
    if (!node.loop) node.stop(startedAt + duration - offset);
    if (stem === 'other') node.onended = () => {
      if (generation !== playbackGeneration) return;
      offset = duration; stopSources();
    };
  }
  playing = true;
  $('play').textContent = 'Ⅱ'; $('play').setAttribute('aria-label', '일시정지');
  $('audio-status').textContent = '로컬에서 재생 중 · 네 파트 동기 재생';
}
function buildMixer() {
  for (const stem of STEMS) {
    const container = document.createElement('div'); container.className = 'stem-control';
    const header = document.createElement('div'); header.className = 'stem-control-header';
    const label = document.createElement('label'); label.htmlFor = `volume-${stem}`; label.textContent = LABELS[stem];
    const button = document.createElement('button'); button.type = 'button'; button.id = `mute-${stem}`; button.setAttribute('aria-label', `${LABELS[stem]} 음소거`); button.setAttribute('aria-pressed', 'false'); button.textContent = '켜짐';
    button.addEventListener('click', () => { muted[stem] = !muted[stem]; clearMode(); applyGains(); });
    header.append(label, button);
    const slider = document.createElement('input'); slider.type = 'range'; slider.id = `volume-${stem}`; slider.min = '0'; slider.max = '1'; slider.step = '0.01'; slider.value = String(volumes[stem]);
    slider.addEventListener('input', () => { volumes[stem] = Number(slider.value); applyGains(); });
    const output = document.createElement('output'); output.id = `value-${stem}`; output.htmlFor = slider.id; output.textContent = '80%';
    container.append(header, slider, output); $('stem-mixer').append(container);
  }
}
async function hitPad(kind) {
  const button = $(`${kind}-pad`);
  button.classList.add('hit'); setTimeout(() => button.classList.remove('hit'), 110);
  try {
    const context = audioContext(); await context.resume();
    const at = context.currentTime;
    const envelope = context.createGain(); envelope.connect(master);
    if (kind === 'kick') {
      const oscillator = context.createOscillator(); oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(145, at); oscillator.frequency.exponentialRampToValueAtTime(48, at + 0.11);
      envelope.gain.setValueAtTime(0.0001, at); envelope.gain.exponentialRampToValueAtTime(0.9, at + 0.004); envelope.gain.exponentialRampToValueAtTime(0.0001, at + 0.28);
      oscillator.connect(envelope); oscillator.start(at); oscillator.stop(at + 0.3); oscillator.onended = () => { oscillator.disconnect(); envelope.disconnect(); };
    } else {
      const noiseBuffer = context.createBuffer(1, Math.ceil(context.sampleRate * 0.18), context.sampleRate);
      const samples = noiseBuffer.getChannelData(0); for (let index = 0; index < samples.length; index++) samples[index] = Math.random() * 2 - 1;
      const noise = context.createBufferSource(); noise.buffer = noiseBuffer;
      const filter = context.createBiquadFilter(); filter.type = 'highpass'; filter.frequency.value = 1200;
      envelope.gain.setValueAtTime(0.5, at); envelope.gain.exponentialRampToValueAtTime(0.0001, at + 0.17);
      noise.connect(filter); filter.connect(envelope); noise.start(at); noise.onended = () => { noise.disconnect(); filter.disconnect(); envelope.disconnect(); };
      const tone = context.createOscillator(); const toneGain = context.createGain(); tone.frequency.value = 185; toneGain.gain.setValueAtTime(0.17, at); toneGain.gain.exponentialRampToValueAtTime(0.0001, at + 0.1); tone.connect(toneGain); toneGain.connect(master); tone.start(at); tone.stop(at + 0.11); tone.onended = () => { tone.disconnect(); toneGain.disconnect(); };
    }
    $('pad-status').textContent = 'D = Kick · F = Snare · 타이밍 힌트와 상관없이 자유롭게 연주할 수 있어요.';
  } catch (error) { $('pad-status').textContent = errorText(error); }
}
function drawGuide() {
  const canvas = $('onset-canvas');
  if (!canvas || $('player-section').hidden) return;
  const width = canvas.clientWidth, height = canvas.clientHeight, scale = Math.min(window.devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(width * scale) || canvas.height !== Math.round(height * scale)) { canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale); }
  const pen = canvas.getContext('2d'); if (!pen) return;
  pen.setTransform(scale, 0, 0, scale, 0, 0); pen.clearRect(0, 0, width, height);
  const now = position(); const target = width * 0.25; const pixelsPerSecond = width / 8;
  pen.strokeStyle = '#47364e'; pen.lineWidth = 1; pen.beginPath(); pen.moveTo(0, 42); pen.lineTo(width, 42); pen.stroke();
  pen.strokeStyle = '#ffbf55'; pen.lineWidth = 2; pen.beginPath(); pen.moveTo(target, 10); pen.lineTo(target, height - 22); pen.stroke();
  for (const onset of onsets) {
    let delta = onset - now;
    if ($('loop').checked && duration > 0 && delta < -2 && now > duration - 6) delta += duration;
    const x = target + delta * pixelsPerSecond;
    if (x < -8 || x > width + 8) continue;
    pen.fillStyle = Math.abs(delta) < 0.09 ? '#ffcf7c' : delta < 0 ? '#6e587e' : '#c4afea';
    pen.beginPath(); pen.arc(x, 42, Math.abs(delta) < 0.09 ? 7 : 5, 0, Math.PI * 2); pen.fill();
  }
  $('elapsed').textContent = formatTime(now);
  if (document.activeElement !== $('seek')) $('seek').value = String(now);
}
function animate() { drawGuide(); requestAnimationFrame(animate); }

buildMixer();
selectSource('file');
$('source-form').addEventListener('submit', submitJob);
document.querySelectorAll('[data-source]').forEach((button) => button.addEventListener('click', () => selectSource(button.dataset.source)));
$('cancel-job').addEventListener('click', cancelJob);
$('delete-job').addEventListener('click', deleteJob);
$('play').addEventListener('click', async () => {
  try { if (playing) { pause(); $('audio-status').textContent = '일시정지'; } else await play(); }
  catch (error) { showError('audio-error', errorText(error)); }
});
$('seek').addEventListener('input', () => {
  const wasPlaying = playing; pause(); offset = Math.min(duration, Math.max(0, Number($('seek').value)));
  if (wasPlaying) play().catch((error) => showError('audio-error', errorText(error)));
});
$('loop').addEventListener('change', () => { if (playing) { pause(); play().catch((error) => showError('audio-error', errorText(error))); } });
document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));
for (const kind of ['kick', 'snare']) {
  const button = $(`${kind}-pad`);
  button.addEventListener('pointerdown', (event) => { if (event.button === 0) { event.preventDefault(); button.focus(); hitPad(kind); } });
  button.addEventListener('click', (event) => { if (event.detail === 0) hitPad(kind); });
}
document.addEventListener('keydown', (event) => {
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.target.closest('input,textarea,select,[contenteditable=true]')) return;
  const kind = { KeyD: 'kick', KeyF: 'snare' }[event.code];
  if (kind) { event.preventDefault(); hitPad(kind); }
});
window.addEventListener('pagehide', () => {
  pause(); clearTimeout(pollTimer); pollGeneration += 1;
  if (loadingId) { loadGeneration += 1; loadController?.abort(); loadingId = null; }
});
window.addEventListener('pageshow', async (event) => {
  if (!event.persisted) return;
  // Back/Forward may restore frozen JS rather than rerun module initialization.
  try {
    const current = await api('/api/session');
    session = current;
    if (!current.job || current.job.id !== job?.id) resetAudio();
    renderDependencies(); renderJob(current.job || null);
    if (job && !TERMINAL.has(job.status)) schedulePoll(job.id);
  } catch (error) {
    showError('form-error', `로컬 서버에 다시 연결하지 못했어요. ${errorText(error)}`);
    if (job && !TERMINAL.has(job.status)) schedulePoll(job.id);
  }
});
requestAnimationFrame(animate);
(async function connect() {
  try {
    session = await api('/api/session');
    $('excerpt-duration').max = String(Math.min(180, session.limits?.max_excerpt_seconds || 180));
    $('excerpt-start').max = String((session.limits?.max_source_seconds || 900) - 1);
    const limit = session.limits?.max_upload_bytes;
    $('upload-limit').textContent = `파일은 외부 서버로 업로드하지 않아요.${limit ? ` 최대 ${Math.floor(limit / 1024 / 1024)} MB.` : ''}`;
    renderDependencies();
    if (session.job) { renderJob(session.job); if (!TERMINAL.has(job.status)) schedulePoll(job.id); }
  } catch (error) {
    $('dependencies').className = 'dependency-notice missing';
    $('dependencies').textContent = `로컬 서버에 연결하지 못했어요. 서버가 실행 중인지 확인한 뒤 새로고침해 주세요. ${errorText(error)}`;
  }
})();
