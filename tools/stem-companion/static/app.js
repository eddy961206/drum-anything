// Local audio stays on this computer. YouTube preview runs on a separate local origin.
const $ = (id) => document.getElementById(id);
const STEMS = ['vocals', 'bass', 'drums', 'other'];
const PAD_KEYS = { KeyD: 'kick', KeyF: 'snare', KeyS: 'tom', KeyJ: 'hat', KeyK: 'open-hat', KeyL: 'crash' };
const LABELS = { vocals: '보컬', bass: '베이스', drums: '드럼', other: '다른 악기' };
const MODES = { all: STEMS, vocals: ['vocals'], instrumental: ['bass', 'drums', 'other'], drummer: ['vocals', 'bass', 'other'] };
const TERMINAL = new Set(['ready', 'failed', 'cancelled', 'dependency_missing']);
const STAGES = ['acquiring', 'normalizing', 'separating', 'analyzing', 'ready'];
const STATUS = { queued: '대기 중', acquiring: '가져오는 중', normalizing: '구간 정리 중', separating: '분리 중', analyzing: '분석 중', ready: '준비 완료', cancelled: '취소됨', failed: '실패', dependency_missing: '설치 / 모델 설정 필요' };
let session = null, source = 'file', job = null, operation = false, pollTimer = null, pollGeneration = 0;
let rangeMode = 'full', previewId = '', previewRequest = 0, previewReady = false;
let previewTime = 0, previewDuration = 0, previewTimer = null, selectionTouched = false;
const previewOrigin = `${location.protocol}//localhost:${location.port}`;
let loadedId = null, loadingId = null, loadGeneration = 0, loadController = null;
let ctx = null, master = null, nodes = [], gains = {}, duration = 0, offset = 0, startedAt = 0;
let audioJob = null, chunkSeconds = 0, chunkCount = 0, chunkCache = new Map(), chunkLoads = new Map(), scheduleTimer = null;
let playing = false, playbackLoop = true, playbackGeneration = 0, audioLoaded = false, onsets = [];
let seeking = false, resumeAfterSeek = false;
let noiseBuffer = null, openHatVoice = null;
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
  clearTimeout(scheduleTimer); scheduleTimer = null;
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
  chunkCache.clear(); chunkLoads.clear(); audioJob = null; chunkSeconds = 0; chunkCount = 0;
  duration = 0; offset = 0; onsets = []; audioLoaded = false; loadedId = null; loadingId = null; seeking = false; resumeAfterSeek = false;
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
    duration = Number(readyJob.duration);
    chunkSeconds = Number(readyJob.chunk_seconds);
    if (!Number.isFinite(duration) || duration <= 0 || duration > (session?.limits?.max_excerpt_seconds || 3600) + 0.1 ||
        !Number.isInteger(chunkSeconds) || chunkSeconds < 1 || chunkSeconds > 60) throw new Error('음원 구간 길이가 올바르지 않아요.');
    for (const stem of STEMS) mediaPath(readyJob.stems?.[stem], readyJob.id);
    audioJob = readyJob; chunkCount = Math.ceil(duration / chunkSeconds);
    await getChunk(0);
    if (generation !== loadGeneration || job?.id !== readyJob.id) return;
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
  if (previewReady) $('youtube-preview').contentWindow.postMessage({ type: 'pause', request: previewRequest }, previewOrigin);
  const generation = ++playbackGeneration;
  const context = audioContext();
  await context.resume();
  if (generation !== playbackGeneration || !audioLoaded) return;
  if (offset >= duration - 0.005) offset = 0;
  const index = Math.min(chunkCount - 1, Math.floor(offset / chunkSeconds));
  const within = offset - index * chunkSeconds;
  abortChunkLoadsExcept(index);
  $('audio-status').textContent = '재생할 부분을 준비하고 있어요…';
  const chunk = await getChunk(index);
  if (generation !== playbackGeneration || !audioLoaded) return;
  startedAt = context.currentTime + 0.04;
  playbackLoop = $('loop').checked;
  for (const stem of STEMS) {
    const gain = context.createGain(); gain.gain.value = muted[stem] ? 0 : volumes[stem];
    gain.connect(master); gains[stem] = gain;
  }
  playing = true;
  scheduleChunk(index, chunk, startedAt, within, generation);
  scheduleNext(index + 1, startedAt + chunk.length - within, generation);
  $('play').textContent = 'Ⅱ'; $('play').setAttribute('aria-label', '일시정지');
  $('audio-status').textContent = '로컬에서 재생 중 · 네 파트 동기 재생';
}

function scheduleChunk(index, chunk, at, within, generation) {
  for (const stem of STEMS) {
    const node = ctx.createBufferSource(); node.buffer = chunk.buffers[stem];
    node.connect(gains[stem]); nodes.push(node);
    node.onended = () => {
      node.disconnect(); nodes = nodes.filter((item) => item !== node);
      if (stem === 'other' && index === chunkCount - 1 && !playbackLoop && generation === playbackGeneration) {
        offset = duration; stopSources(); $('audio-status').textContent = '재생이 끝났어요.';
      }
    };
    node.start(at, within); node.stop(at + chunk.length - within);
  }
}

function scheduleNext(index, at, generation) {
  if (!playing || generation !== playbackGeneration) return;
  if (index >= chunkCount) { if (!playbackLoop) return; index = 0; }
  const delay = Math.max(0, (at - ctx.currentTime - 12) * 1000);
  scheduleTimer = setTimeout(async () => {
    try {
      const chunk = await getChunk(index);
      if (!playing || generation !== playbackGeneration) return;
      if (ctx.currentTime >= at - 0.02) {
        pause(); offset = index * chunkSeconds;
        $('audio-status').textContent = '다음 부분을 준비하고 있어요…';
        await play(); return;
      }
      scheduleChunk(index, chunk, at, 0, generation);
      scheduleNext(index + 1, at + chunk.length, generation);
    } catch (error) {
      if (generation !== playbackGeneration) return;
      pause(); $('audio-status').textContent = '재생을 멈췄어요.'; showError('audio-error', errorText(error));
    }
  }, delay);
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
    if (kind === 'kick' || kind === 'tom') {
      const oscillator = context.createOscillator(); oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(kind === 'kick' ? 145 : 220, at);
      oscillator.frequency.exponentialRampToValueAtTime(kind === 'kick' ? 48 : 92, at + (kind === 'kick' ? 0.11 : 0.17));
      envelope.gain.setValueAtTime(0.0001, at); envelope.gain.exponentialRampToValueAtTime(kind === 'kick' ? 0.9 : 0.6, at + 0.004); envelope.gain.exponentialRampToValueAtTime(0.0001, at + 0.28);
      oscillator.connect(envelope); oscillator.start(at); oscillator.stop(at + 0.3); oscillator.onended = () => { oscillator.disconnect(); envelope.disconnect(); };
    } else {
      if (!noiseBuffer) {
        noiseBuffer = context.createBuffer(1, Math.ceil(context.sampleRate * 1.3), context.sampleRate);
        const samples = noiseBuffer.getChannelData(0); for (let index = 0; index < samples.length; index++) samples[index] = Math.random() * 2 - 1;
      }
      if ((kind === 'hat' || kind === 'open-hat') && openHatVoice) {
        openHatVoice.envelope.gain.cancelScheduledValues(at);
        openHatVoice.envelope.gain.setValueAtTime(Math.max(openHatVoice.envelope.gain.value, 0.001), at);
        openHatVoice.envelope.gain.exponentialRampToValueAtTime(0.0001, at + 0.025);
        try { openHatVoice.noise.stop(at + 0.03); } catch { /* A previous hit already ended. */ }
        openHatVoice = null;
      }
      const noise = context.createBufferSource(); noise.buffer = noiseBuffer;
      const filter = context.createBiquadFilter(); filter.type = 'highpass';
      filter.frequency.value = kind === 'snare' ? 1200 : kind === 'crash' ? 3500 : 6500;
      const length = kind === 'snare' ? 0.18 : kind === 'hat' ? 0.075 : kind === 'open-hat' ? 0.55 : 1.2;
      envelope.gain.setValueAtTime(kind === 'snare' ? 0.5 : kind === 'crash' ? 0.25 : 0.28, at);
      envelope.gain.exponentialRampToValueAtTime(0.0001, at + length - 0.01);
      noise.connect(filter); filter.connect(envelope); noise.start(at); noise.stop(at + length);
      if (kind === 'open-hat') openHatVoice = { noise, envelope };
      noise.onended = () => { if (openHatVoice?.noise === noise) openHatVoice = null; noise.disconnect(); filter.disconnect(); envelope.disconnect(); };
      if (kind === 'snare') {
        const tone = context.createOscillator(); const toneGain = context.createGain(); tone.frequency.value = 185;
        toneGain.gain.setValueAtTime(0.17, at); toneGain.gain.exponentialRampToValueAtTime(0.0001, at + 0.1);
        tone.connect(toneGain); toneGain.connect(master); tone.start(at); tone.stop(at + 0.11);
        tone.onended = () => { tone.disconnect(); toneGain.disconnect(); };
      } else {
        for (const frequency of [4200, 5600, 7100]) {
          const tone = context.createOscillator(); const toneGain = context.createGain(); tone.type = 'square'; tone.frequency.value = frequency;
          toneGain.gain.value = 0.035; tone.connect(toneGain); toneGain.connect(filter); tone.start(at); tone.stop(at + length);
          tone.onended = () => { tone.disconnect(); toneGain.disconnect(); };
        }
      }
    }
    $('pad-status').textContent = 'D 킥 · F 스네어 · S 톰 · J 닫힌 하이햇 · K 열린 하이햇 · L 크래시';
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
  const drawRange = (from, to, shift = 0) => {
    let lo = 0, hi = onsets.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (onsets[mid] < from) lo = mid + 1; else hi = mid; }
    for (let index = lo; index < onsets.length && onsets[index] <= to; index++) {
      const delta = onsets[index] + shift - now, x = target + delta * pixelsPerSecond;
      if (x < -8 || x > width + 8) continue;
      pen.fillStyle = Math.abs(delta) < 0.09 ? '#ffcf7c' : delta < 0 ? '#6e587e' : '#c4afea';
      pen.beginPath(); pen.arc(x, 42, Math.abs(delta) < 0.09 ? 7 : 5, 0, Math.PI * 2); pen.fill();
    }
  };
  drawRange(Math.max(0, now - 2.2), now + 6.2);
  if ($('loop').checked && duration > 0 && now > duration - 6.2) drawRange(0, Math.max(0, now + 6.2 - duration), duration);
  $('elapsed').textContent = formatTime(now);
  if (document.activeElement !== $('seek')) $('seek').value = String(now);
}
function animate() { drawGuide(); requestAnimationFrame(animate); }

buildMixer();
selectSource('file');
selectRange('full');
$('source-form').addEventListener('submit', submitJob);
document.querySelectorAll('[data-source]').forEach((button) => button.addEventListener('click', () => selectSource(button.dataset.source)));
document.querySelectorAll('[data-range]').forEach((button) => button.addEventListener('click', () => selectRange(button.dataset.range)));
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
$('play').addEventListener('click', async () => {
  try { if (playing) { pause(); $('audio-status').textContent = '일시정지'; } else await play(); }
  catch (error) { showError('audio-error', errorText(error)); }
});
$('seek').addEventListener('input', () => {
  if (!seeking) { seeking = true; resumeAfterSeek = playing; pause(); abortChunkLoadsExcept(); }
  offset = Math.min(duration, Math.max(0, Number($('seek').value)));
  $('elapsed').textContent = formatTime(offset);
});
$('seek').addEventListener('change', () => {
  if (!seeking) return;
  seeking = false;
  if (resumeAfterSeek) play().catch((error) => showError('audio-error', errorText(error)));
  resumeAfterSeek = false;
});
$('loop').addEventListener('change', () => { if (playing) { pause(); play().catch((error) => showError('audio-error', errorText(error))); } });
document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));
for (const kind of Object.values(PAD_KEYS)) {
  const button = $(`${kind}-pad`);
  button.addEventListener('pointerdown', (event) => { if (event.button === 0) { event.preventDefault(); button.focus(); hitPad(kind); } });
  button.addEventListener('click', (event) => { if (event.detail === 0) hitPad(kind); });
}
document.addEventListener('keydown', (event) => {
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.target.closest('input,textarea,select,[contenteditable=true]')) return;
  const kind = PAD_KEYS[event.code];
  if (kind) { event.preventDefault(); hitPad(kind); }
});
window.addEventListener('pagehide', () => {
  pause(); clearTimeout(pollTimer); pollGeneration += 1;
  if (loadingId) { loadGeneration += 1; loadController?.abort(); loadingId = null; }
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  if (playing || audioLoaded) { pause(); abortChunkLoadsExcept(); $('audio-status').textContent = '탭이 숨겨져 일시정지했어요.'; }
  if (previewReady) $('youtube-preview').contentWindow.postMessage({ type: 'pause', request: previewRequest }, previewOrigin);
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
    $('excerpt-duration').max = String(session.limits?.max_excerpt_seconds || 3600);
    $('excerpt-start').max = String((session.limits?.max_source_seconds || 3600) - 1);
    const limit = session.limits?.max_upload_bytes;
    $('upload-limit').textContent = `파일은 외부 서버로 업로드하지 않아요.${limit ? ` 최대 ${Math.floor(limit / 1024 / 1024)} MB.` : ''}`;
    renderDependencies();
    if (session.job) { renderJob(session.job); if (!TERMINAL.has(job.status)) schedulePoll(job.id); }
  } catch (error) {
    $('dependencies').className = 'dependency-notice missing';
    $('dependencies').textContent = `로컬 서버에 연결하지 못했어요. 서버가 실행 중인지 확인한 뒤 새로고침해 주세요. ${errorText(error)}`;
  }
})();
