// Local audio stays on this computer. YouTube preview runs on a separate local origin.
const $ = (id) => document.getElementById(id);
const STEMS = ['vocals', 'bass', 'drums', 'other'];
const PAD_KEYS = { KeyD: 'kick', KeyF: 'snare', KeyS: 'tom', KeyJ: 'hat', KeyK: 'open-hat', KeyL: 'crash' };
const PAD_SAMPLES = {
  kick: { file: 'kick.m4a', gain: 3.5, offset: 0.005, length: 1.0 },
  snare: { file: 'snare.m4a', gain: 0.9, offset: 0.008, length: 1.2 },
  tom: { file: 'tom.flac', gain: 1.5, offset: 0.006, length: 1.2 },
  hat: { file: 'hat.m4a', gain: 5.5, offset: 0, length: 0.35 },
  'open-hat': { file: 'open-hat.m4a', gain: 3.2, offset: 0, length: 2.0 },
  crash: { file: 'crash.m4a', gain: 3.5, offset: 0, length: 4.0 },
};
const LABELS = { vocals: '보컬', bass: '베이스', drums: '드럼', other: '다른 악기' };
const MODES = { all: STEMS, vocals: ['vocals'], instrumental: ['bass', 'drums', 'other'], guide: STEMS, drummer: ['vocals', 'bass', 'other'] };
const GUIDE_DRUMS = 0.3;
// Lanes follow drum notation from top to bottom: cymbals, snare/toms, kick.
const LANES = {
  cymbal: { label: '심벌', keys: 'J · K · L', color: '#93d3b8' },
  snare: { label: '스네어·톰', keys: 'F · S', color: '#c4afea' },
  kick: { label: '킥', keys: 'D', color: '#ffbf55' },
  any: { label: '타이밍', keys: '아무 패드', color: '#c4afea' },
};
const LANE_SETS = { kick: ['kick'], 'kick-snare': ['snare', 'kick'], all: ['cymbal', 'snare', 'kick'] };
const PAD_LANE = { kick: 'kick', snare: 'snare', tom: 'snare', hat: 'cymbal', 'open-hat': 'cymbal', crash: 'cymbal' };
// General MIDI percussion notes sent by most electronic kits. Ride uses the closed hat sound.
const MIDI_NOTES = { 35: 'kick', 36: 'kick', 37: 'snare', 38: 'snare', 39: 'snare', 40: 'snare', 41: 'tom', 43: 'tom', 45: 'tom', 47: 'tom', 48: 'tom', 50: 'tom',
  42: 'hat', 44: 'hat', 51: 'hat', 53: 'hat', 59: 'hat', 46: 'open-hat', 49: 'crash', 52: 'crash', 55: 'crash', 57: 'crash' };
const WINDOW = { perfect: 0.045, good: 0.1 }; // Real seconds either side of a note.
const GRADE_COLORS = { perfect: '#ffd77a', good: '#c4afea', miss: '#ff8f8f', extra: '#8a7d99' };
const PAD_HINT = 'D 킥 · F 스네어 · S 톰 · J 닫힌 하이햇 · K 열린 하이햇 · L 크래시 · Space 재생';
const TERMINAL = new Set(['ready', 'failed', 'cancelled', 'dependency_missing']);
const STAGES = ['acquiring', 'normalizing', 'separating', 'analyzing', 'ready'];
const STATUS = { queued: '대기 중', acquiring: '가져오는 중', normalizing: '구간 정리 중', separating: '분리 중', analyzing: '분석 중', ready: '준비 완료', cancelled: '취소됨', failed: '실패', dependency_missing: '설치 / 모델 설정 필요' };
let session = null, source = 'file', job = null, audioChoice = 'demo', operation = false, pollTimer = null, pollGeneration = 0;
let rangeMode = 'full', previewId = '', previewRequest = 0, previewReady = false;
let previewTime = 0, previewDuration = 0, previewTimer = null, selectionTouched = false;
const previewOrigin = `${location.protocol}//localhost:${location.port}`;
let loadedId = null, loadingId = null, loadGeneration = 0, loadController = null;
let ctx = null, master = null, padMaster = null, nodes = [], gains = {}, duration = 0, offset = 0, startedAt = 0;
let audioJob = null, chunkSeconds = 0, chunkCount = 0, chunkCache = new Map(), chunkLoads = new Map(), scheduleTimer = null;
let playing = false, starting = false, playbackLoop = true, playbackGeneration = 0, audioLoaded = false, onsets = [];
let seeking = false, resumeAfterSeek = false;
let loopMode = 'full', repeatStart = 0, repeatEnd = 0, playbackStart = 0, playbackEnd = 0;
let loopEditing = false, resumeAfterLoop = false;
let padBytesPromise = null, padBuffersPromise = null, padBuffers = null, openHatVoice = null;
let rate = 1, mixMode = 'all', notes = {}, laneSet = 'all', judgeMode = 'pads', latencyMs = 0;
let pass = null, lastPass = null, passHistory = [], passNumber = 0, lastJudge = 0, lastTake = null, replay = null, effects = [];
let calibration = null, midiAccess = null;
const replayVoices = new Set();
const volumes = Object.fromEntries(STEMS.map((stem) => [stem, 0.8]));
const muted = Object.fromEntries(STEMS.map((stem) => [stem, false]));

function errorText(error) { return error instanceof Error ? error.message : String(error); }
function showError(id, message = '') { $(id).textContent = message; $(id).hidden = !message; }
function listMissing(items) { return (items || []).map((v) => typeof v === 'string' ? v : JSON.stringify(v)).join(', '); }
function formatTime(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
  return `${hours ? `${hours}:${String(minutes).padStart(2, '0')}` : minutes}:${String(seconds % 60).padStart(2, '0')}`;
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
  notice.textContent = available ? '실행 환경 준비 완료. 파일은 이 컴퓨터에서 처리하고, 분리된 파트도 로컬에서 재생해요.' : session?.bundled_demo
    ? '기본 샘플은 바로 연주할 수 있어요. 새 곡을 분리하려면 README에서 필요한 도구와 모델을 설정해 주세요.'
    : `먼저 실행 환경을 준비해 주세요: ${listMissing(missing) || '필수 도구 또는 모델 설정이 없어요'}. README의 설치·모델 설정을 마친 뒤 서버를 다시 실행해 주세요.`;
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
  if (source === 'youtube') queuePreview(); else closePreview();
  updateSelection();
  showError('form-error');
  renderDependencies();
}

function selectRange(value) {
  rangeMode = value;
  document.querySelectorAll('[data-range]').forEach((button) => {
    const selected = button.dataset.range === rangeMode;
    button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected));
  });
  $('range-selection').hidden = rangeMode !== 'excerpt';
  $('excerpt-start').required = rangeMode === 'excerpt';
  $('excerpt-duration').required = rangeMode === 'excerpt';
  updateSelection();
}

function youtubeVideoId(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 2048 || /[\x00-\x20]/.test(text)) throw new Error('YouTube 영상 주소를 확인해 주세요.');
  let url;
  try { url = new URL(text); } catch { throw new Error('YouTube 영상 주소를 확인해 주세요.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw new Error('공개된 단일 YouTube 영상 주소만 사용할 수 있어요.');
  const seen = new Set();
  if (url.search && url.search.slice(1).split('&').some((part) => !part.includes('='))) throw new Error('영상 주소를 확인해 주세요.');
  for (const key of url.searchParams.keys()) {
    if (!['v', 't', 'si', 'feature'].includes(key) || seen.has(key)) throw new Error('재생목록이 아닌 영상 하나의 주소를 넣어 주세요.');
    seen.add(key);
  }
  let id = '';
  if (url.hostname === 'youtu.be' && !seen.has('v')) id = url.pathname.slice(1);
  else if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) {
    if (url.pathname === '/watch') id = url.searchParams.get('v') || '';
    else if (url.pathname.startsWith('/shorts/') && !seen.has('v')) id = url.pathname.slice(8);
  }
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error('공개된 단일 YouTube 영상 주소를 넣어 주세요.');
  return id;
}

function closePreview() {
  clearTimeout(previewTimer); previewRequest += 1; previewReady = false;
  previewId = ''; previewTime = 0; previewDuration = 0; selectionTouched = false;
  $('youtube-preview').removeAttribute('src'); $('youtube-preview-area').hidden = true;
  updateSelection();
}

function queuePreview() {
  clearTimeout(previewTimer);
  let id;
  try { id = youtubeVideoId($('youtube-input').value); }
  catch { closePreview(); return; }
  if (id === previewId) return;
  closePreview();
  previewTimer = setTimeout(() => {
    if (source !== 'youtube') return;
    previewId = id; previewRequest += 1; previewReady = false;
    $('youtube-preview-status').textContent = 'YouTube 플레이어를 준비하고 있어요.';
    $('youtube-preview-area').hidden = false;
    $('youtube-preview').src = `${previewOrigin}/youtube-preview.html`;
  }, 400);
}

function setSelection(start, end) {
  if (!(previewDuration >= 1)) return;
  const limit = Math.min(previewDuration, session?.limits?.max_source_seconds || 3600);
  start = Math.max(0, Math.min(Number(start) || 0, limit - 1));
  end = Math.max(start + 1, Math.min(Number(end) || 0, limit));
  $('range-start').max = String(Math.max(0, limit - 1)); $('range-start').value = String(start);
  $('range-end').max = String(limit); $('range-end').value = String(end);
  $('excerpt-start').value = String(Math.round(start * 10) / 10);
  $('excerpt-duration').value = String(Math.round((end - start) * 10) / 10);
  updateSelection();
}

function updateSelection() {
  const visible = source === 'youtube' && rangeMode === 'excerpt' && previewDuration >= 1;
  $('visual-selection').hidden = !visible;
  if (!visible) return;
  const start = Number($('range-start').value) || 0, end = Number($('range-end').value) || 0;
  const limit = Math.min(previewDuration, session?.limits?.max_source_seconds || 3600);
  $('selection-label').textContent = `${formatTime(start)} – ${formatTime(end)} (${formatTime(end - start)})`;
  $('selection-fill').style.left = `${start / limit * 100}%`;
  $('selection-fill').style.width = `${(end - start) / limit * 100}%`;
  for (const id of ['set-start-current', 'set-end-current', 'preview-selection']) $(id).disabled = !previewReady;
}

function previewMessage(event) {
  if (event.origin !== previewOrigin || event.source !== $('youtube-preview').contentWindow || !event.data) return;
  const data = event.data;
  if (data.type === 'preview-ready' && previewId) {
    event.source.postMessage({ type: 'load', id: previewId, request: previewRequest }, previewOrigin);
  } else if (data.request === previewRequest && data.type === 'player-ready') {
    previewReady = true; updateSelection();
  } else if (data.request === previewRequest && data.type === 'state' && data.id === previewId) {
    previewTime = Number.isFinite(data.time) ? Math.max(0, data.time) : 0;
    const nextDuration = Number.isFinite(data.duration) ? Math.max(0, data.duration) : 0;
    if (nextDuration && nextDuration !== previewDuration) {
      previewDuration = nextDuration;
      const start = selectionTouched ? Number($('excerpt-start').value) : 0;
      const length = selectionTouched ? Number($('excerpt-duration').value) : Math.min(30, nextDuration);
      setSelection(start, start + length);
    }
    const limit = session?.limits?.max_source_seconds || 3600;
    $('youtube-preview-status').textContent = previewDuration > limit ? `영상이 ${formatTime(limit)}을 넘어 분리할 수 없어요.` : previewDuration ? `영상 ${formatTime(previewTime)} / ${formatTime(previewDuration)} · 재생하면서 구간을 고를 수 있어요.` : '영상을 재생하면 길이와 현재 위치가 표시돼요.';
    updateSelection();
  } else if (data.request === previewRequest && data.type === 'error') {
    previewReady = false; updateSelection();
    $('youtube-preview-status').textContent = `${data.message} 아래 숫자로 구간을 입력할 수 있어요.`;
  }
}
function selectedAudio() {
  if (audioChoice === 'job') return job?.status === 'ready' ? job : null;
  return session?.bundled_demo || null;
}

function renderAudioChoice() {
  const demo = session?.bundled_demo, readyJob = job?.status === 'ready' ? job : null;
  if (audioChoice === 'job' && !readyJob) audioChoice = 'demo';
  if (audioChoice === 'demo' && !demo && readyJob) audioChoice = 'job';
  const selected = selectedAudio();
  $('demo-welcome').hidden = !demo;
  if (demo) $('demo-name').textContent = `${demo.title} · ${demo.artist}`;
  document.querySelectorAll('[data-audio-choice]').forEach((button) => {
    const choice = button.dataset.audioChoice;
    button.hidden = choice === 'demo' ? !demo : !readyJob;
    const active = choice === audioChoice;
    button.classList.toggle('selected', active); button.setAttribute('aria-pressed', String(active));
  });
  $('audio-choice').hidden = !selected;
  $('player-section').hidden = !selected;
  if (!selected) {
    if (audioJob || loadingId || audioLoaded) resetAudio();
    return;
  }
  $('track-title').textContent = audioChoice === 'demo' ? `${demo.title} · ${demo.artist}` : '내가 분리한 곡';
  if (loadedId !== selected.id && loadingId !== selected.id) loadAudio(selected);
}

function selectAudioChoice(choice) {
  if ((choice === 'demo' && session?.bundled_demo) || (choice === 'job' && job?.status === 'ready')) {
    audioChoice = choice;
    renderAudioChoice();
  }
}

function renderJob(value) {
  const previousJob = job;
  job = value;
  if (job?.status === 'ready' && (previousJob?.id !== job.id || previousJob?.status !== 'ready')) audioChoice = 'job';
  $('job-section').hidden = !job;
  if (!job) {
    renderAudioChoice();
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
  renderAudioChoice();
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
    const maxDuration = session.limits?.max_excerpt_seconds || 3600;
    const start = rangeMode === 'full' ? 0 : checkNumber($('excerpt-start').value, 0, (session.limits?.max_source_seconds || 3600) - 1, '시작 위치');
    const length = rangeMode === 'full' ? 'full' : checkNumber($('excerpt-duration').value, 1, maxDuration, '연습할 길이');
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
      youtubeVideoId(url);
      path = '/api/jobs';
      options = { method: 'POST', body: JSON.stringify({ youtube_url: url, start_seconds: start, duration_seconds: length, rights_confirmed: true }), headers: { 'Content-Type': 'application/json' } };
    }
    operation = true;
    refreshSubmit();
    if (source === 'youtube' && previewReady) $('youtube-preview').contentWindow.postMessage({ type: 'pause', request: previewRequest }, previewOrigin);
    const result = await api(path, options);
    renderJob(result.job || result);
    if (!TERMINAL.has(job.status)) schedulePoll(job.id);
  } catch (error) {
    showError('form-error', errorText(error));
    // A response can be lost after the server accepted a job; recover instead of resubmitting.
    try {
      const current = await api('/api/session');
      session = current;
      renderJob(current.job || null);
      if (job && !TERMINAL.has(job.status)) schedulePoll(job.id);
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
    padMaster = ctx.createGain(); padMaster.gain.value = Number($('pad-volume').value); padMaster.connect(master);
  }
  return ctx;
}
function songAt(contextTime) {
  if (!playing || !ctx) return offset;
  const elapsed = offset + Math.max(0, contextTime - startedAt) * rate;
  const span = playbackEnd - playbackStart;
  return playbackLoop && span > 0 ? playbackStart + ((elapsed - playbackStart) % span + span) % span : Math.min(duration, elapsed);
}
function position() { return songAt(ctx?.currentTime ?? 0); }
// The device outputs a scheduled sample a little after ctx.currentTime. Judge against what the player hears.
function heardContextTime(eventTime) {
  const now = performance.now();
  const at = Number.isFinite(eventTime) && eventTime > 0 && eventTime <= now && now - eventTime < 1000 ? eventTime : now;
  const stamp = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null;
  if (stamp?.contextTime > 0 && stamp.performanceTime > 0) {
    const heard = stamp.contextTime + (at - stamp.performanceTime) / 1000;
    // Ignore a timestamp from a different clock; a real output delay is well under half a second.
    if (heard <= ctx.currentTime + 0.05 && heard >= ctx.currentTime - 0.5 - (now - at) / 1000) return heard;
  }
  return ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0) - (now - at) / 1000;
}
function heardPosition() { return playing && ctx ? songAt(heardContextTime()) : offset; }
// Hits and misses share one clock that also removes the player's calibrated delay.
function judgeClock(eventTime) { return playing && ctx ? songAt(heardContextTime(eventTime) - latencyMs / 1000) : offset; }
function stopSources() {
  playbackGeneration += 1;
  clearTimeout(scheduleTimer); scheduleTimer = null;
  for (const node of nodes) { node.onended = null; try { node.stop(); } catch { /* Already ended. */ } node.disconnect(); }
  for (const gain of Object.values(gains)) gain.disconnect();
  for (const voice of replayVoices) { try { voice.stop(); } catch { /* Already ended. */ } }
  nodes = []; gains = {}; replayVoices.clear();
  playing = false; starting = false;
  $('play').textContent = '▶'; $('play').setAttribute('aria-label', '재생');
}
function pause() { offset = position(); stopSources(); }
function resetAudio() {
  loadGeneration += 1;
  loadController?.abort(); loadController = null;
  stopSources();
  chunkCache.clear(); chunkLoads.clear(); audioJob = null; chunkSeconds = 0; chunkCount = 0;
  duration = 0; offset = 0; onsets = []; audioLoaded = false; loadedId = null; loadingId = null; seeking = false; resumeAfterSeek = false;
  repeatStart = 0; repeatEnd = 0; loopEditing = false; resumeAfterLoop = false;
  notes = {}; pass = null; lastPass = null; passHistory = []; lastTake = null; replay = null; effects = [];
  $('play').disabled = true; $('seek').disabled = true; $('seek').value = '0';
  $('stem-downloads').replaceChildren();
  renderStage();
}
async function loadAudio(readyJob) {
  resetAudio();
  loadingId = readyJob.id;
  const generation = loadGeneration;
  const controller = new AbortController(); loadController = controller;
  $('audio-status').textContent = '네 파트를 로컬에서 불러오고 있어요…';
  showError('audio-error');
  try {
    duration = Number(readyJob.duration);
    chunkSeconds = Number(readyJob.chunk_seconds);
    if (!Number.isFinite(duration) || duration <= 0 || duration > (session?.limits?.max_excerpt_seconds || 3600) + 0.1 ||
        !Number.isInteger(chunkSeconds) || chunkSeconds < 1 || chunkSeconds > 60) throw new Error('음원 구간 길이가 올바르지 않아요.');
    for (const stem of STEMS) mediaPath(readyJob.stems?.[stem], readyJob.id);
    audioJob = readyJob; chunkCount = Math.ceil(duration / chunkSeconds);
    await getChunk(0);
    if (generation !== loadGeneration || selectedAudio()?.id !== readyJob.id) return;
    onsets = cleanTimes(readyJob.onsets);
    const lanes = Object.fromEntries(['cymbal', 'snare', 'kick'].map((lane) => [lane, cleanTimes(readyJob.notes?.[lane])]));
    // Older results only have onsets: keep one timing lane instead of inventing drum types.
    notes = Object.values(lanes).some((list) => list.length) ? lanes : { any: onsets };
    audioLoaded = true; loadedId = readyJob.id; loadingId = null;
    setRepeatBounds(0, duration); updateLoopControls();
    $('seek').max = String(duration); $('seek').disabled = false; $('play').disabled = false;
    $('total-time').textContent = formatTime(duration);
    $('audio-status').textContent = '재생을 누르면 네 파트가 함께 시작해요.';
    $('onset-count').textContent = notes.any ? `${onsets.length}개 추정 지점` : `킥 ${notes.kick.length} · 스네어 ${notes.snare.length} · 심벌 ${notes.cymbal.length}`;
    $('note-source').textContent = notes.any ? '이 결과에는 드럼 종류 정보가 없어 타이밍만 보여줘요. 새로 분리하면 킥·스네어·심벌 레인이 생겨요.'
      : '분리된 드럼의 낮은·중간·높은 소리로 킥, 스네어·톰, 심벌 위치를 추정했어요. 실제 악보와 다를 수 있어요.';
    renderStage();
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

async function getChunk(index) {
  if (!audioJob || !Number.isInteger(index) || index < 0 || index >= chunkCount) throw new Error('재생 구간이 올바르지 않아요.');
  if (chunkCache.has(index)) {
    const value = chunkCache.get(index); chunkCache.delete(index); chunkCache.set(index, value); return value;
  }
  if (chunkLoads.has(index)) return chunkLoads.get(index).promise;
  const requestedJob = audioJob, generation = loadGeneration, parentSignal = loadController.signal;
  const controller = new AbortController(), signal = controller.signal;
  const abort = () => controller.abort();
  parentSignal.addEventListener('abort', abort, { once: true });
  if (parentSignal.aborted) controller.abort();
  const request = Promise.all(STEMS.map(async (stem) => {
    const path = `/media/${encodeURIComponent(requestedJob.id)}/chunks/${index}/${stem}.wav`;
    const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin', signal });
    if (!response.ok) throw new Error(`${LABELS[stem]} 재생 구간을 읽지 못했어요 (${response.status}).`);
    return [stem, await audioContext().decodeAudioData(await response.arrayBuffer())];
  })).then((entries) => {
    if (generation !== loadGeneration || audioJob?.id !== requestedJob.id || signal.aborted) throw new Error('이전 재생 요청이 취소됐어요.');
    const lengths = entries.map(([, buffer]) => buffer.duration), actual = Math.min(...lengths);
    const expected = Math.min(chunkSeconds, duration - index * chunkSeconds);
    if (!Number.isFinite(actual) || Math.abs(actual - expected) > 0.1 || Math.max(...lengths) - actual > 0.1) throw new Error('분리된 파트 길이가 서로 맞지 않아요.');
    const value = { buffers: Object.fromEntries(entries), length: actual };
    chunkCache.set(index, value);
    while (chunkCache.size > 3) chunkCache.delete(chunkCache.keys().next().value);
    return value;
  }).finally(() => {
    parentSignal.removeEventListener('abort', abort);
    if (chunkLoads.get(index)?.promise === request) chunkLoads.delete(index);
  });
  chunkLoads.set(index, { promise: request, controller });
  return request;
}

function abortChunkLoadsExcept(index = -1) {
  for (const [key, entry] of chunkLoads) if (key !== index) { entry.controller.abort(); chunkLoads.delete(key); }
}
function stemLevel(stem) { return muted[stem] ? 0 : volumes[stem] * (mixMode === 'guide' && stem === 'drums' ? GUIDE_DRUMS : 1); }
function applyGains() {
  for (const stem of STEMS) {
    if (gains[stem] && ctx) gains[stem].gain.setTargetAtTime(stemLevel(stem), ctx.currentTime, 0.015);
    const mute = $(`mute-${stem}`);
    mute.setAttribute('aria-pressed', String(muted[stem])); mute.textContent = muted[stem] ? '꺼짐' : '켜짐';
    $(`volume-${stem}`).value = String(volumes[stem]);
    $(`value-${stem}`).textContent = `${Math.round(volumes[stem] * 100)}%`;
  }
}
function setRepeatBounds(start, end) {
  if (!(duration > 0)) return;
  const minimum = Math.min(1, duration);
  repeatStart = Math.max(0, Math.min(Number(start) || 0, duration - minimum));
  repeatEnd = Math.max(repeatStart + minimum, Math.min(Number(end) || 0, duration));
  $('loop-start').max = String(duration - minimum); $('loop-start').value = String(repeatStart);
  $('loop-end').max = String(duration); $('loop-end').value = String(repeatEnd);
  $('loop-label').textContent = `${formatTime(repeatStart)} – ${formatTime(repeatEnd)}`;
}
function updateLoopControls() {
  document.querySelectorAll('[data-loop-mode]').forEach((button) => {
    const selected = button.dataset.loopMode === loopMode;
    button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected));
  });
  $('loop-section').hidden = loopMode !== 'section';
  for (const id of ['loop-start', 'loop-end', 'loop-start-current', 'loop-end-current']) $(id).disabled = !audioLoaded;
}
function selectLoopMode(mode) {
  const wasPlaying = playing || starting; pause(); loopMode = mode; $('loop').checked = true; updateLoopControls();
  if (wasPlaying) play().catch((error) => showError('audio-error', errorText(error)));
}
function setMode(mode) {
  mixMode = mode;
  for (const stem of STEMS) muted[stem] = !MODES[mode].includes(stem);
  document.querySelectorAll('[data-mode]').forEach((button) => {
    const selected = button.dataset.mode === mode; button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected));
  });
  applyGains();
}
function clearMode() { mixMode = null; document.querySelectorAll('[data-mode]').forEach((button) => { button.classList.remove('selected'); button.setAttribute('aria-pressed', 'false'); }); }
async function play() {
  if (!audioLoaded || playing || starting) return;
  if (previewReady) $('youtube-preview').contentWindow.postMessage({ type: 'pause', request: previewRequest }, previewOrigin);
  const generation = ++playbackGeneration;
  starting = true;
  $('play').textContent = 'Ⅱ'; $('play').setAttribute('aria-label', '일시정지');
  $('audio-status').textContent = '재생할 부분을 준비하고 있어요…';
  try {
    const context = audioContext();
    await context.resume();
    if (generation !== playbackGeneration || !audioLoaded) return;
    playbackLoop = !replay && $('loop').checked;
    playbackStart = replay ? replay.take.start : playbackLoop && loopMode === 'section' ? repeatStart : 0;
    playbackEnd = replay ? replay.take.end : playbackLoop && loopMode === 'section' ? repeatEnd : duration;
    if (replay) offset = Math.min(Math.max(offset, playbackStart), playbackEnd - 0.05);
    else if (playbackLoop && (offset < playbackStart || offset >= playbackEnd - 0.005)) offset = playbackStart;
    else if (offset >= duration - 0.005) offset = 0;
    const index = Math.min(chunkCount - 1, Math.floor(offset / chunkSeconds));
    const within = offset - index * chunkSeconds;
    abortChunkLoadsExcept(index);
    const chunk = await getChunk(index);
    if (generation !== playbackGeneration || !audioLoaded) return;
    startedAt = context.currentTime + 0.04;
    for (const stem of STEMS) {
      const gain = context.createGain(); gain.gain.value = stemLevel(stem);
      gain.connect(master); gains[stem] = gain;
    }
    starting = false; playing = true;
    updatePass(); // A pass starts where playback starts, even before the first animation frame.
    const piece = scheduleChunk(index, chunk, startedAt, within, generation);
    scheduleNext(piece.end, startedAt + piece.length / rate, generation);
    scheduleReplay();
    $('audio-status').textContent = replay ? '방금 친 내 드럼을 밴드와 함께 들려주는 중' : `로컬에서 재생 중 · 네 파트 동기 재생${rate !== 1 ? ` · ${Math.round(rate * 100)}% 속도` : ''}`;
  } catch (error) {
    if (generation !== playbackGeneration) return;
    stopSources();
    $('audio-status').textContent = '재생을 멈췄어요.';
    throw error;
  }
}

function scheduleChunk(index, chunk, at, within, generation) {
  const chunkStart = index * chunkSeconds;
  const end = Math.min(chunkStart + chunkSeconds, playbackEnd, duration);
  const length = Math.min(end - chunkStart - within, chunk.length - within);
  if (!(length > 0)) throw new Error('반복 구간이 올바르지 않아요.');
  for (const stem of STEMS) {
    const node = ctx.createBufferSource(); node.buffer = chunk.buffers[stem]; node.playbackRate.value = rate;
    node.connect(gains[stem]); nodes.push(node);
    node.onended = () => {
      node.disconnect(); nodes = nodes.filter((item) => item !== node);
      if (stem === 'other' && end >= playbackEnd - 0.001 && !playbackLoop && generation === playbackGeneration) finishPlayback();
    };
    node.start(at, within, length); node.stop(at + length / rate);
  }
  return { end, length };
}

function scheduleNext(songPosition, at, generation) {
  if (!playing || generation !== playbackGeneration) return;
  if (playbackLoop && songPosition >= playbackEnd - 0.001) songPosition = playbackStart;
  else if (!playbackLoop && songPosition >= playbackEnd - 0.001) return;
  const index = Math.min(chunkCount - 1, Math.floor(songPosition / chunkSeconds));
  const within = songPosition - index * chunkSeconds;
  const delay = Math.max(0, (at - ctx.currentTime - 12) * 1000);
  scheduleTimer = setTimeout(async () => {
    try {
      const chunk = await getChunk(index);
      if (!playing || generation !== playbackGeneration) return;
      if (ctx.currentTime >= at - 0.02) {
        pause(); offset = songPosition;
        $('audio-status').textContent = '다음 부분을 준비하고 있어요…';
        await play(); return;
      }
      const piece = scheduleChunk(index, chunk, at, within, generation);
      scheduleNext(piece.end, at + piece.length / rate, generation);
    } catch (error) {
      if (generation !== playbackGeneration) return;
      pause(); $('audio-status').textContent = '재생을 멈췄어요.'; showError('audio-error', errorText(error));
    }
  }, delay);
}
function finishPlayback() {
  const wasReplay = Boolean(replay);
  offset = playbackEnd; stopSources();
  if (wasReplay) { replay = null; renderReplay(); $('audio-status').textContent = '내 연주 다시 듣기가 끝났어요.'; return; }
  scanMisses(playbackEnd); finishPass();
  $('audio-status').textContent = '재생이 끝났어요.';
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
function loadPadBytes() {
  if (!padBytesPromise) {
    padBytesPromise = Promise.all(Object.entries(PAD_SAMPLES).map(async ([kind, sample]) => {
      const response = await fetch(`/samples/${sample.file}`, { cache: 'force-cache', credentials: 'same-origin' });
      if (!response.ok) throw new Error(`${kind} 드럼 소리를 불러오지 못했어요.`);
      return [kind, await response.arrayBuffer()];
    })).then(Object.fromEntries).catch((error) => { padBytesPromise = null; throw error; });
  }
  return padBytesPromise;
}

function preparePadBuffers(context) {
  if (!padBuffersPromise) {
    padBuffersPromise = loadPadBytes().then(async (bytes) => {
      padBuffers = Object.fromEntries(await Promise.all(Object.entries(bytes).map(async ([kind, data]) => [kind, await context.decodeAudioData(data)])));
      return padBuffers;
    }).catch((error) => { padBuffersPromise = null; padBytesPromise = null; throw error; });
  }
  return padBuffersPromise;
}

function velocityGain(velocity) { return Math.min(1.3, (Math.max(1, Math.min(127, velocity)) / 100) ** 1.4); }
function playVoice(kind, at, velocity = 100, scheduled = false) {
  const sample = PAD_SAMPLES[kind], buffer = padBuffers?.[kind];
  if (!buffer || !ctx) return;
  if ((kind === 'hat' || kind === 'open-hat') && openHatVoice) {
    openHatVoice.gain.gain.cancelScheduledValues(at);
    openHatVoice.gain.gain.setValueAtTime(Math.max(openHatVoice.gain.gain.value, 0.001), at);
    openHatVoice.gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.025);
    try { openHatVoice.node.stop(at + 0.03); } catch { /* A previous hit already ended. */ }
    openHatVoice = null;
  }
  const start = Math.min(sample.offset, Math.max(0, buffer.duration - 0.001));
  const length = Math.min(sample.length, buffer.duration - start);
  if (!(length > 0)) throw new Error('드럼 소리 길이가 올바르지 않아요.');
  const voice = ctx.createBufferSource(), gain = ctx.createGain(), level = sample.gain * velocityGain(velocity);
  voice.buffer = buffer; voice.connect(gain); gain.connect(padMaster);
  gain.gain.setValueAtTime(level, at);
  gain.gain.setValueAtTime(level, at + Math.max(0, length - 0.08));
  gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
  voice.start(at, start, length);
  if (kind === 'open-hat') openHatVoice = { node: voice, gain };
  if (scheduled) replayVoices.add(voice);
  voice.onended = () => { replayVoices.delete(voice); if (openHatVoice?.node === voice) openHatVoice = null; voice.disconnect(); gain.disconnect(); };
}

async function hitPad(kind, { velocity = 100, timeStamp } = {}) {
  const button = $(`${kind}-pad`);
  button.classList.add('hit'); setTimeout(() => button.classList.remove('hit'), 110);
  try {
    const context = audioContext();
    const resumed = context.resume(); // Start the unlock during the user's gesture.
    // Read the clock before any await: a hit counts when it was struck, not when its sound is ready.
    if (calibration) calibrationTap(heardContextTime(timeStamp));
    else if (playing && !replay && audioLoaded) markHit(kind, judgeClock(timeStamp), velocity);
    await preparePadBuffers(context); await resumed;
    if (document.hidden) return;
    playVoice(kind, context.currentTime, velocity);
    $('pad-status').textContent = PAD_HINT;
  } catch (error) { $('pad-status').textContent = errorText(error); }
}

function cleanTimes(values) { return (Array.isArray(values) ? values : []).filter((value) => Number.isFinite(value) && value >= 0 && value < duration).sort((a, b) => a - b); }
function lowerBound(list, value) {
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid] < value) lo = mid + 1; else hi = mid; }
  return lo;
}
function visibleLanes() { return notes.any ? ['any'] : LANE_SETS[laneSet]; }

// One pass is one run through the song or one repeat of the loop. Judgments never cross passes.
function newPass(start) {
  pass = { start, end: start, limit: playbackLoop ? playbackEnd : duration, judged: {}, cursor: {}, carry: [], perfect: 0, good: 0, miss: 0, combo: 0, maxCombo: 0, offsets: [], hits: [] };
  for (const lane of Object.keys(notes)) { pass.judged[lane] = new Map(); pass.cursor[lane] = lowerBound(notes[lane], start - 0.001); }
  lastJudge = start; renderScore();
}
function applyGrade(lane, index, grade, delta) {
  pass.judged[lane].set(index, grade); pass[grade] += 1;
  if (grade === 'miss') pass.combo = 0;
  else { pass.combo += 1; pass.maxCombo = Math.max(pass.maxCombo, pass.combo); pass.offsets.push(delta); }
  renderScore();
}
function scanMisses(limit) {
  if (!pass || judgeMode === 'off') return;
  for (const lane of visibleLanes()) {
    const list = notes[lane] || [];
    let index = pass.cursor[lane] ?? 0;
    for (; index < list.length && list[index] < Math.min(limit, pass.limit); index++) {
      if (!pass.judged[lane].has(index) && list[index] >= pass.start - 0.001) { applyGrade(lane, index, 'miss', 0); addEffect(lane, 'miss'); }
    }
    pass.cursor[lane] = index;
  }
}
function accuracyOf(item) {
  const total = item.perfect + item.good + item.miss;
  return total ? Math.round(100 * (item.perfect + 0.6 * item.good) / total) : null;
}
function finishPass() {
  if (!pass) return;
  // A stop just after a loop restarts leaves a sliver of a pass; keep showing the last real one.
  const hits = pass.hits.filter((hit) => hit.t >= pass.start).sort((a, b) => a.t - b.t);
  if (hits.length >= 3 || (hits.length && lastTake?.songId !== loadedId)) {
    lastTake = { songId: loadedId, start: pass.start, end: Math.min(pass.limit, Math.max(pass.end, hits.at(-1).t) + 0.6), hits };
  }
  const counted = pass.perfect + pass.good + pass.miss;
  if (judgeMode !== 'off' && counted >= 4) {
    passNumber += 1; passHistory.push({ number: passNumber, accuracy: accuracyOf(pass) });
    if (passHistory.length > 8) passHistory.shift();
  }
  if (counted >= 4 || !lastPass) lastPass = pass;
  pass = null;
  renderScore(); renderHistory(); renderReplay();
}
function wrapPass(start) {
  const carry = pass?.carry || [];
  finishPass(); newPass(start);
  for (const item of carry) applyGrade(item.lane, item.index, item.grade, item.delta);
}
function updatePass() {
  if (!playing || replay || !audioLoaded) return;
  const now = judgeClock();
  if (!pass) newPass(now);
  else if (now < lastJudge - 0.25 || now > lastJudge + 1.5) {
    if (playbackLoop && now < lastJudge && lastJudge > playbackEnd - 0.5 && now < playbackStart + 0.5) { scanMisses(playbackEnd); wrapPass(playbackStart); }
    else { finishPass(); newPass(now); }
  }
  pass.end = Math.max(pass.end, now); pass.limit = playbackLoop ? playbackEnd : duration;
  scanMisses(now - WINDOW.good * rate);
  lastJudge = now;
}
function markHit(kind, time, velocity) {
  updatePass();
  if (!pass) return;
  const span = playbackLoop ? playbackEnd - playbackStart : 0;
  // A hit struck just before the loop restarted belongs just before this new pass.
  const t = span > 0 && time > playbackEnd - 0.5 && lastJudge < playbackStart + 0.5 ? time - span : time;
  pass.hits.push({ t, kind, velocity });
  if (pass.hits.length === 1) renderReplay();
  const result = judgeHit(kind, t);
  if (!result) return;
  addEffect(result.lane, result.grade, result.delta);
  if (result.grade !== 'extra') flashGrade(kind, result.grade);
}
function judgeHit(kind, t) {
  if (judgeMode === 'off' || !pass) return null;
  const lanes = notes.any ? ['any'] : visibleLanes().filter((lane) => judgeMode === 'timing' || lane === PAD_LANE[kind]);
  const reach = WINDOW.good * rate, span = playbackLoop ? playbackEnd - playbackStart : 0;
  // Near the loop end an early hit can be meant for the first note of the next repeat.
  const targets = span > 0 && t > playbackEnd - reach ? [[t, false], [t - span, true]] : [[t, false]];
  let best = null;
  for (const lane of lanes) {
    const list = notes[lane];
    for (const [time, carry] of targets) {
      for (let index = lowerBound(list, time - reach); index < list.length && list[index] <= time + reach; index++) {
        const note = list[index], delta = (time - note) / rate;
        const taken = carry ? note < playbackStart || pass.carry.some((item) => item.lane === lane && item.index === index)
          : pass.judged[lane].has(index) || note < pass.start - 0.001 || note >= pass.limit;
        if (!taken && (!best || Math.abs(delta) < Math.abs(best.delta))) best = { lane, index, delta, carry };
      }
    }
  }
  if (!best) return { grade: 'extra', lane: notes.any ? 'any' : visibleLanes().includes(PAD_LANE[kind]) ? PAD_LANE[kind] : null, delta: 0 };
  best.grade = Math.abs(best.delta) <= WINDOW.perfect ? 'perfect' : 'good';
  if (best.carry) pass.carry.push(best); else applyGrade(best.lane, best.index, best.grade, best.delta);
  return best;
}
function addEffect(lane, grade, delta = 0) {
  if (!lane) return;
  const ms = Math.round(Math.abs(delta) * 1000);
  const text = grade === 'perfect' ? '정확' : grade === 'good' ? `${delta > 0 ? '늦음 +' : '빠름 −'}${ms}ms` : grade === 'miss' ? '놓침' : '';
  effects.push({ lane, grade, text, born: performance.now() });
  if (effects.length > 40) effects.shift();
}
const gradeTimers = {};
function flashGrade(kind, grade) {
  const button = $(`${kind}-pad`);
  button.dataset.grade = grade;
  clearTimeout(gradeTimers[kind]); gradeTimers[kind] = setTimeout(() => { delete button.dataset.grade; }, 220);
}

function tendencyText(item) {
  if (judgeMode === 'off') return '채점이 꺼져 있어요. 재생 중에 친 패드는 다시 듣기용으로만 기록해요.';
  if (!item || item.offsets.length < 3) {
    const target = judgeMode === 'pads' && !notes.any ? '같은 색 레인의 패드를' : '아무 패드나';
    return `${playing ? '' : '재생하고 '}노트가 지금 선에 닿을 때 ${target} 치면 빠름·늦음을 알려줘요.`;
  }
  const mean = item.offsets.reduce((sum, value) => sum + value, 0) / item.offsets.length;
  const spread = Math.sqrt(item.offsets.reduce((sum, value) => sum + (value - mean) ** 2, 0) / item.offsets.length);
  const ms = Math.round(mean * 1000);
  const lean = ms > 15 ? `평균 ${ms}ms 늦게 치는 편이에요` : ms < -15 ? `평균 ${-ms}ms 서두르는 편이에요` : `평균 ${ms > 0 ? '+' : ''}${ms}ms, 박자가 안정적이에요`;
  return `${lean} · 흔들림 ±${Math.round(spread * 1000)}ms${item === pass ? '' : ` · 최고 콤보 ${item.maxCombo}`}`;
}
function renderScore() {
  const shown = pass || lastPass, accuracy = shown ? accuracyOf(shown) : null;
  $('score-accuracy').textContent = accuracy === null ? '–' : `${accuracy}%`;
  $('score-combo').textContent = String(shown?.combo || 0);
  $('score-combo-best').textContent = shown?.maxCombo ? `콤보 · 최고 ${shown.maxCombo}` : '콤보';
  $('score-perfect').textContent = String(shown?.perfect || 0);
  $('score-good').textContent = String(shown?.good || 0);
  $('score-miss').textContent = String(shown?.miss || 0);
  $('score-tendency').textContent = tendencyText(shown);
}
function renderHistory() {
  const box = $('pass-history');
  box.replaceChildren();
  if (!passHistory.length) { box.textContent = '곡이 끝나거나 반복 구간이 한 바퀴 돌면 정확도가 쌓여요.'; return; }
  const best = Math.max(...passHistory.map((item) => item.accuracy));
  for (const item of passHistory) {
    const chip = document.createElement('span');
    chip.className = item.accuracy === best ? 'pass best' : 'pass';
    chip.textContent = `${item.number}회 ${item.accuracy}%`;
    box.append(chip);
  }
}
function renderReplay() {
  const ready = Boolean(lastTake && audioLoaded && lastTake.songId === loadedId && lastTake.end - lastTake.start > 0.5);
  $('replay-take').disabled = !ready && !replay && !pass?.hits.length;
  $('replay-take').textContent = replay ? '다시 듣기 멈추기' : '방금 내 연주 듣기';
  $('replay-take').setAttribute('aria-pressed', String(Boolean(replay)));
  $('take-info').textContent = ready ? `${formatTime(lastTake.start)}–${formatTime(lastTake.end)} · ${lastTake.hits.length}타` : '재생 중에 친 패드를 기록해 두었다가 밴드와 함께 들려줘요.';
}
function renderStage() {
  const groups = { '[data-lanes]': (button) => button.dataset.lanes === laneSet, '[data-judge]': (button) => button.dataset.judge === judgeMode, '[data-rate]': (button) => Number(button.dataset.rate) === rate };
  for (const [query, isSelected] of Object.entries(groups)) document.querySelectorAll(query).forEach((button) => {
    const selected = isSelected(button);
    button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected));
  });
  document.querySelectorAll('[data-lanes]').forEach((button) => { button.disabled = Boolean(notes.any); });
  $('latency').value = String(latencyMs);
  $('latency-value').textContent = `${latencyMs > 0 ? '+' : ''}${latencyMs}ms`;
  renderScore(); renderHistory(); renderReplay();
}
function resetScore() {
  finishPass(); // Keep the hits for replay even though the score starts over.
  lastPass = null; passHistory = []; passNumber = 0; effects = []; renderStage();
}
function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('drummer-settings') || '{}');
    if (LANE_SETS[saved.laneSet]) laneSet = saved.laneSet;
    if (['pads', 'timing', 'off'].includes(saved.judgeMode)) judgeMode = saved.judgeMode;
    if (Number.isFinite(saved.latencyMs)) latencyMs = Math.max(-150, Math.min(250, Math.round(saved.latencyMs)));
  } catch { /* Blocked storage only loses these conveniences. */ }
}
function saveSettings() {
  try { localStorage.setItem('drummer-settings', JSON.stringify({ laneSet, judgeMode, latencyMs })); } catch { /* Blocked storage only loses these conveniences. */ }
}
function selectRate(value) {
  if (!Number.isFinite(value) || value === rate) return;
  const wasPlaying = playing || starting; pause(); rate = value; renderStage();
  if (wasPlaying) play().catch((error) => showError('audio-error', errorText(error)));
}

async function toggleReplay() {
  if (replay) { stopReplay(); pause(); $('audio-status').textContent = '다시 듣기를 멈췄어요.'; return; }
  if (playing || starting) pause();
  finishPass();
  if (!lastTake || !audioLoaded || lastTake.songId !== loadedId || lastTake.end - lastTake.start <= 0.5) { renderReplay(); return; }
  replay = { take: lastTake };
  offset = lastTake.start; setMode('drummer'); renderReplay();
  try { await play(); } catch (error) { stopReplay(); showError('audio-error', errorText(error)); }
}
function stopReplay() {
  if (!replay) return;
  replay = null;
  for (const voice of replayVoices) { try { voice.stop(); } catch { /* Already ended. */ } }
  replayVoices.clear(); renderReplay();
}
// Replay is linear, so every recorded hit goes on the audio clock at once instead of waiting for frames.
function scheduleReplay() {
  if (!replay || !playing || !ctx) return;
  for (const hit of replay.take.hits) {
    if (hit.t >= offset && hit.t < playbackEnd) playVoice(hit.kind, startedAt + (hit.t - offset) / rate, hit.velocity, true);
  }
}

async function startCalibration() {
  if (calibration) return;
  stopReplay();
  if (playing || starting) { pause(); $('audio-status').textContent = '지연 보정을 위해 일시정지했어요.'; }
  $('calibration').hidden = false;
  try {
    const context = audioContext(); await context.resume();
    const first = context.currentTime + 0.5, clicks = Array.from({ length: 12 }, (_, index) => first + index * 0.6);
    calibration = { clicks, offsets: [], used: new Set(), voices: clicks.map((at, index) => click(at, index % 4 === 0)),
      timer: setTimeout(() => finishCalibration(), (clicks.at(-1) - context.currentTime + 0.6) * 1000) };
    $('calibrate').disabled = true;
    $('calibration-status').textContent = '딸깍 소리가 12번 나요. 셋째 소리부터 소리에 딱 맞춰 아무 패드나 키를 눌러 주세요.';
  } catch (error) { $('calibration-status').textContent = errorText(error); }
}
function click(at, accent) {
  const tone = ctx.createOscillator(), gain = ctx.createGain();
  tone.frequency.value = accent ? 1760 : 1320;
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(accent ? 0.5 : 0.32, at + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
  tone.connect(gain); gain.connect(master); tone.start(at); tone.stop(at + 0.06);
  tone.onended = () => { tone.disconnect(); gain.disconnect(); };
  return tone;
}
function calibrationTap(heard) {
  const { clicks, offsets, used } = calibration;
  let index = 0;
  for (let i = 1; i < clicks.length; i++) if (Math.abs(clicks[i] - heard) < Math.abs(clicks[index] - heard)) index = i;
  const delta = heard - clicks[index];
  if (index < 2 || used.has(index) || Math.abs(delta) > 0.25) return;
  used.add(index); offsets.push(delta);
  $('calibration-status').textContent = `${offsets.length}번 맞췄어요 · 방금 소리보다 ${Math.round(Math.abs(delta) * 1000)}ms ${delta >= 0 ? '늦게' : '빠르게'}`;
}
function finishCalibration(cancelled = false) {
  if (!calibration) { $('calibration').hidden = true; return; }
  clearTimeout(calibration.timer);
  if (cancelled) for (const voice of calibration.voices) { try { voice.stop(); } catch { /* Already ended. */ } }
  const offsets = calibration.offsets.slice().sort((a, b) => a - b);
  calibration = null; $('calibrate').disabled = false;
  if (cancelled) { $('calibration').hidden = true; return; }
  if (offsets.length < 5) { $('calibration-status').textContent = `${offsets.length}번만 맞았어요. 5번 이상 맞춰야 보정할 수 있어요. 다시 해 볼까요?`; return; }
  const middle = offsets.length >> 1, median = offsets.length % 2 ? offsets[middle] : (offsets[middle - 1] + offsets[middle]) / 2;
  latencyMs = Math.max(-150, Math.min(250, Math.round(median * 200) * 5));
  saveSettings(); renderStage();
  $('calibration-status').textContent = `소리보다 평균 ${Math.round(Math.abs(median) * 1000)}ms ${median >= 0 ? '늦게' : '빠르게'} 들어와서 보정값을 ${latencyMs > 0 ? '+' : ''}${latencyMs}ms로 맞췄어요.`;
}

async function connectMidi() {
  if (midiAccess) { bindMidi(); return; }
  if (typeof navigator === 'undefined' || typeof navigator.requestMIDIAccess !== 'function') {
    $('midi-status').textContent = '이 브라우저는 MIDI 연결을 지원하지 않아요. Chrome이나 Edge에서 열어 주세요.';
    return;
  }
  $('midi-connect').disabled = true;
  $('midi-status').textContent = '브라우저의 MIDI 장치 권한 요청을 확인해 주세요.';
  try {
    audioContext().resume().catch(() => {}); // Unlock audio during this click; MIDI hits are not user gestures.
    midiAccess = await navigator.requestMIDIAccess({ sysex: false });
    midiAccess.onstatechange = bindMidi;
    bindMidi();
  } catch (error) { $('midi-status').textContent = `MIDI 장치에 연결하지 못했어요. ${errorText(error)}`; }
  finally { $('midi-connect').disabled = false; }
}
function bindMidi() {
  const names = [];
  for (const input of midiAccess.inputs.values()) {
    input.onmidimessage = midiMessage;
    if (input.state !== 'disconnected') names.push(input.name || 'MIDI 입력');
  }
  $('midi-connect').classList.toggle('connected', names.length > 0);
  $('midi-connect').textContent = names.length ? '전자드럼 연결됨' : '전자드럼 연결 · MIDI';
  $('midi-status').textContent = names.length ? `${names.join(', ')} · 치는 세기까지 반영해요. 라이드는 닫힌 하이햇 소리로 나요.`
    : 'MIDI 권한은 받았지만 연결된 장치가 없어요. 장치를 꽂으면 자동으로 연결해요.';
}
function midiMessage(event) {
  const [status, note, velocity] = event.data || [];
  if ((status & 0xf0) !== 0x90 || !velocity) return;
  const kind = MIDI_NOTES[note];
  return kind ? hitPad(kind, { velocity, timeStamp: event.timeStamp }) : undefined;
}
async function togglePlay() {
  try {
    if (playing || starting) { stopReplay(); pause(); finishPass(); $('audio-status').textContent = '일시정지'; }
    else await play();
  } catch (error) { showError('audio-error', errorText(error)); }
}

function drawGuide() {
  const canvas = $('onset-canvas');
  if (!canvas || $('player-section').hidden) return;
  const lanes = visibleLanes(), narrow = canvas.clientWidth < 560;
  const cssHeight = `${22 + lanes.length * (narrow ? 44 : 54)}px`;
  if (canvas.style.height !== cssHeight) canvas.style.height = cssHeight;
  const width = canvas.clientWidth, height = canvas.clientHeight, scale = Math.min(window.devicePixelRatio || 1, 2);
  if (!width || !height) return;
  if (canvas.width !== Math.round(width * scale) || canvas.height !== Math.round(height * scale)) { canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale); }
  const pen = canvas.getContext('2d'); if (!pen) return;
  pen.setTransform(scale, 0, 0, scale, 0, 0); pen.clearRect(0, 0, width, height);
  const now = heardPosition(), gutter = narrow ? 62 : 86, nowX = gutter + Math.max(34, (width - gutter) * 0.14);
  const perSecond = (width - nowX) / (3.2 * rate); // About 3.2 seconds of real time ahead at any speed.
  const top = 11, laneHeight = (height - 22) / lanes.length, clock = performance.now();
  const loopFrom = loopMode === 'section' ? repeatStart : 0, loopTo = loopMode === 'section' ? repeatEnd : duration;
  const ahead = (width - nowX) / perSecond, behind = (nowX - gutter) / perSecond;
  const wraps = !replay && $('loop').checked && loopTo > loopFrom && now >= loopFrom && now < loopTo && now + ahead > loopTo;
  pen.textBaseline = 'middle'; pen.textAlign = 'left';
  lanes.forEach((lane, row) => {
    const y = top + row * laneHeight, mid = y + laneHeight / 2, info = LANES[lane], list = notes[lane] || [], judged = pass?.judged[lane];
    pen.fillStyle = row % 2 ? '#211a2b' : '#271f32'; pen.fillRect(0, y, width, laneHeight);
    pen.fillStyle = info.color; pen.font = `700 ${narrow ? 11 : 12}px Arial, sans-serif`; pen.fillText(info.label, 11, mid - 7);
    pen.fillStyle = '#9c8fac'; pen.font = `${narrow ? 9 : 10}px Arial, sans-serif`; pen.fillText(info.keys, 11, mid + 8);
    pen.save(); pen.beginPath(); pen.rect(gutter, y, width - gutter, laneHeight); pen.clip();
    const drawFrom = (from, to, shift) => {
      for (let index = lowerBound(list, from); index < list.length && list[index] <= to; index++) {
        const grade = shift ? null : judged?.get(index);
        if (grade && grade !== 'miss') continue; // Hit notes turn into the ring effect.
        const delta = (list[index] + shift - now) / rate, x = nowX + (list[index] + shift - now) * perSecond, close = Math.abs(delta) < 0.06;
        const w = close ? 16 : 12, h = laneHeight * (close ? 0.64 : 0.52);
        pen.globalAlpha = grade === 'miss' ? 0.5 : delta < -0.12 ? 0.28 : 1;
        pen.fillStyle = grade === 'miss' ? GRADE_COLORS.miss : close ? '#fff1c9' : info.color;
        pen.beginPath();
        if (pen.roundRect) pen.roundRect(x - w / 2, mid - h / 2, w, h, 5); else pen.rect(x - w / 2, mid - h / 2, w, h);
        pen.fill();
      }
      pen.globalAlpha = 1;
    };
    drawFrom(now - behind, Math.min(now + ahead, wraps ? loopTo : Infinity), 0);
    if (wraps) drawFrom(loopFrom, loopFrom + now + ahead - loopTo, loopTo - loopFrom);
    pen.restore();
  });
  if (wraps) {
    const x = nowX + (loopTo - now) * perSecond;
    pen.strokeStyle = '#d6c3ff'; pen.setLineDash([4, 4]); pen.lineWidth = 1;
    pen.beginPath(); pen.moveTo(x, top); pen.lineTo(x, height - 11); pen.stroke(); pen.setLineDash([]);
  }
  pen.fillStyle = '#3c3048'; pen.fillRect(gutter - 1, top, 1, height - 22);
  pen.strokeStyle = '#ffbf55'; pen.lineWidth = 2;
  pen.beginPath(); pen.moveTo(nowX, 4); pen.lineTo(nowX, height - 12); pen.stroke();
  pen.fillStyle = '#ffbf55'; pen.font = '9px Arial, sans-serif'; pen.textAlign = 'center'; pen.fillText('지금', nowX, height - 5); pen.textAlign = 'left';
  effects = effects.filter((effect) => clock - effect.born < 650);
  for (const effect of effects) {
    const row = lanes.indexOf(effect.lane);
    if (row < 0) continue;
    const age = (clock - effect.born) / 650, mid = top + row * laneHeight + laneHeight / 2, color = GRADE_COLORS[effect.grade];
    pen.globalAlpha = 1 - age; pen.strokeStyle = color; pen.lineWidth = 2.5;
    pen.beginPath(); pen.arc(nowX, mid, 8 + age * (effect.grade === 'perfect' ? 22 : 14), 0, Math.PI * 2); pen.stroke();
    if (effect.text) { pen.fillStyle = color; pen.font = `700 ${narrow ? 11 : 12}px Arial, sans-serif`; pen.fillText(effect.text, nowX + 14, mid - laneHeight * 0.3 - age * 6); }
    pen.globalAlpha = 1;
  }
}
function tick() {
  updatePass();
  const now = position();
  $('elapsed').textContent = formatTime(now);
  if (document.activeElement !== $('seek')) $('seek').value = String(now);
}
function animate() { tick(); drawGuide(); requestAnimationFrame(animate); }

buildMixer();
loadSettings();
selectSource('file');
selectRange('full');
updateLoopControls();
renderStage();
try { preparePadBuffers(audioContext()).catch((error) => { $('pad-status').textContent = errorText(error); }); }
catch (error) { $('pad-status').textContent = errorText(error); }
$('source-form').addEventListener('submit', submitJob);
document.querySelectorAll('[data-source]').forEach((button) => button.addEventListener('click', () => selectSource(button.dataset.source)));
document.querySelectorAll('[data-range]').forEach((button) => button.addEventListener('click', () => selectRange(button.dataset.range)));
document.querySelectorAll('[data-audio-choice]').forEach((button) => button.addEventListener('click', () => selectAudioChoice(button.dataset.audioChoice)));
$('open-demo').addEventListener('click', () => { selectAudioChoice('demo'); $('player-section').scrollIntoView({ block: 'start' }); });
$('youtube-input').addEventListener('input', queuePreview);
window.addEventListener('message', previewMessage);
$('range-start').addEventListener('input', () => { selectionTouched = true; const start = Number($('range-start').value); setSelection(start, Math.max(start + 1, Number($('range-end').value))); });
$('range-end').addEventListener('input', () => { selectionTouched = true; const end = Number($('range-end').value); setSelection(Math.min(Number($('range-start').value), end - 1), end); });
for (const id of ['excerpt-start', 'excerpt-duration']) $(id).addEventListener('input', () => {
  selectionTouched = true;
  const start = Number($('excerpt-start').value), length = Number($('excerpt-duration').value);
  if (previewDuration >= 1 && Number.isFinite(start) && Number.isFinite(length) && start >= 0 && length >= 1 && start + length <= previewDuration) {
    $('range-start').value = String(start); $('range-end').value = String(start + length); updateSelection();
  }
});
$('set-start-current').addEventListener('click', () => { selectionTouched = true; setSelection(previewTime, Math.max(previewTime + 1, Number($('range-end').value))); });
$('set-end-current').addEventListener('click', () => { selectionTouched = true; setSelection(Math.min(Number($('range-start').value), previewTime - 1), previewTime); });
$('preview-selection').addEventListener('click', () => {
  if (previewReady) $('youtube-preview').contentWindow.postMessage({ type: 'seek', request: previewRequest, time: Number($('range-start').value) }, previewOrigin);
});
$('cancel-job').addEventListener('click', cancelJob);
$('delete-job').addEventListener('click', deleteJob);
$('play').addEventListener('click', togglePlay);
$('seek').addEventListener('input', () => {
  if (!seeking) { seeking = true; stopReplay(); resumeAfterSeek = playing || starting; pause(); abortChunkLoadsExcept(); }
  offset = Math.min(duration, Math.max(0, Number($('seek').value)));
  $('elapsed').textContent = formatTime(offset);
});
$('seek').addEventListener('change', () => {
  if (!seeking) return;
  seeking = false;
  if (resumeAfterSeek) play().catch((error) => showError('audio-error', errorText(error)));
  resumeAfterSeek = false;
});
$('loop').addEventListener('change', () => {
  const wasPlaying = playing || starting; pause(); updateLoopControls();
  if (wasPlaying) play().catch((error) => showError('audio-error', errorText(error)));
});
document.querySelectorAll('[data-loop-mode]').forEach((button) => button.addEventListener('click', () => selectLoopMode(button.dataset.loopMode)));
for (const id of ['loop-start', 'loop-end']) {
  $(id).addEventListener('input', () => {
    if (!loopEditing) { loopEditing = true; resumeAfterLoop = playing || starting; pause(); }
    const start = Number($('loop-start').value), end = Number($('loop-end').value);
    if (id === 'loop-start') setRepeatBounds(start, Math.max(start + 1, end));
    else setRepeatBounds(Math.min(start, end - 1), end);
  });
  $(id).addEventListener('change', () => {
    if (!loopEditing) return;
    loopEditing = false;
    if (resumeAfterLoop) play().catch((error) => showError('audio-error', errorText(error)));
    resumeAfterLoop = false;
  });
}
$('loop-start-current').addEventListener('click', () => {
  const now = position(), wasPlaying = playing || starting; pause(); setRepeatBounds(now, Math.max(now + 1, repeatEnd));
  if (wasPlaying) play().catch((error) => showError('audio-error', errorText(error)));
});
$('loop-end-current').addEventListener('click', () => {
  const now = position(), wasPlaying = playing || starting; pause(); setRepeatBounds(Math.min(repeatStart, now - 1), now);
  if (wasPlaying) play().catch((error) => showError('audio-error', errorText(error)));
});
document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));
document.querySelectorAll('[data-rate]').forEach((button) => button.addEventListener('click', () => selectRate(Number(button.dataset.rate))));
document.querySelectorAll('[data-lanes]').forEach((button) => button.addEventListener('click', () => { laneSet = button.dataset.lanes; saveSettings(); resetScore(); }));
document.querySelectorAll('[data-judge]').forEach((button) => button.addEventListener('click', () => { judgeMode = button.dataset.judge; saveSettings(); resetScore(); }));
$('replay-take').addEventListener('click', toggleReplay);
$('reset-score').addEventListener('click', resetScore);
$('latency').addEventListener('input', () => {
  latencyMs = Math.max(-150, Math.min(250, Math.round(Number($('latency').value) || 0)));
  saveSettings(); renderStage();
});
$('calibrate').addEventListener('click', startCalibration);
$('calibration-cancel').addEventListener('click', () => finishCalibration(true));
$('midi-connect').addEventListener('click', connectMidi);
for (const kind of Object.values(PAD_KEYS)) {
  const button = $(`${kind}-pad`);
  button.addEventListener('pointerdown', (event) => { if (event.button === 0) { event.preventDefault(); button.focus(); hitPad(kind, { timeStamp: event.timeStamp }); } });
  button.addEventListener('click', (event) => { if (event.detail === 0) hitPad(kind); });
}
$('pad-volume').addEventListener('input', () => {
  const value = Math.max(0, Math.min(1, Number($('pad-volume').value)));
  $('pad-volume-value').textContent = `${Math.round(value * 100)}%`;
  if (padMaster && ctx) padMaster.gain.setTargetAtTime(value, ctx.currentTime, 0.015);
});
document.addEventListener('keydown', (event) => {
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.target.closest('input,textarea,select,[contenteditable=true]')) return;
  // Space plays or pauses unless a control that Space activates has focus. Pads keep it for the transport.
  if (event.code === 'Space' && (event.target === document.body || event.target.closest('.pad'))) { event.preventDefault(); togglePlay(); return; }
  const kind = PAD_KEYS[event.code];
  if (kind) { event.preventDefault(); hitPad(kind, { timeStamp: event.timeStamp }); }
});
document.addEventListener('keyup', (event) => { if (event.code === 'Space' && event.target.closest?.('.pad')) event.preventDefault(); });
window.addEventListener('pagehide', () => {
  stopReplay(); finishCalibration(true);
  pause(); clearTimeout(pollTimer); pollGeneration += 1;
  if (loadingId) { loadGeneration += 1; loadController?.abort(); loadingId = null; }
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  stopReplay(); finishCalibration(true);
  if (playing || audioLoaded) { pause(); finishPass(); abortChunkLoadsExcept(); $('audio-status').textContent = '탭이 숨겨져 일시정지했어요.'; }
  if (previewReady) $('youtube-preview').contentWindow.postMessage({ type: 'pause', request: previewRequest }, previewOrigin);
});
window.addEventListener('pageshow', async (event) => {
  if (!event.persisted) return;
  // Back/Forward may restore frozen JS rather than rerun module initialization.
  try {
    const current = await api('/api/session');
    session = current;
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
    $('excerpt-duration').max = String(session.limits?.max_excerpt_seconds || 3600);
    $('excerpt-start').max = String((session.limits?.max_source_seconds || 3600) - 1);
    const limit = session.limits?.max_upload_bytes;
    $('upload-limit').textContent = `파일은 외부 서버로 업로드하지 않아요.${limit ? ` 최대 ${Math.floor(limit / 1024 / 1024)} MB.` : ''}`;
    renderDependencies();
    renderJob(session.job || null);
    if (job && !TERMINAL.has(job.status)) schedulePoll(job.id);
  } catch (error) {
    $('dependencies').className = 'dependency-notice missing';
    $('dependencies').textContent = `로컬 서버에 연결하지 못했어요. 서버가 실행 중인지 확인한 뒤 새로고침해 주세요. ${errorText(error)}`;
  }
})();
