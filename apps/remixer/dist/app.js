import { RemixAudio } from './audio.js';
import { bpmFromTaps } from './timing.js';
import { YouTubeDeck, parseYouTubeUrl } from './youtube.js';
import { detectOnsets } from './onsets.js';

const $ = id => document.getElementById(id);
const audio = new RemixAudio();
const state = { source: 'demo', mode: 'local', youtubeAnchor: 0, youtubeLast: null, onsets: [], guided: false, stemMix: 'drummer', loading: false, playPending: false, quantized: true,
  generation: 0, loadGeneration: 0, frame: 0, taps: [], loopA: null, loopB: null,
  loopEnabled: false, seeking: false, waveform: [], waveformWidth: 0 };
let youtube = null;
const heldKeys = new Set();
const muffleHolds = new Set();
const flashes = new Map();
const padNames = { fill: '짧은 필인', crash: '크래시', kick: '킥', snare: '스네어' };
const keyPads = { KeyF: 'fill', KeyJ: 'crash', KeyD: 'kick', KeyS: 'snare', KeyK: 'muffle' };

function timeLabel(seconds) {
  const n = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}
function say(text) { $('status').textContent = text; }
function errorMessage(error) { $('error').textContent = error?.message || '소리를 준비하지 못했어요. 다시 한 번 눌러 주세요.'; $('error').hidden = false; }
function setLoading(value) {
  state.loading = value; $('play').disabled = value; $('stems-load').disabled = value; $('stems-load').textContent = value ? '음원 준비 중…' : '내 밴드 준비하기'; document.body.classList.toggle('loading', value);
}
function clearError() { $('error').hidden = true; $('error').textContent = ''; }
function rangeFill(input) {
  const max = Number(input.max) || 100, min = Number(input.min) || 0;
  input.style.setProperty('--percent', `${Math.max(0, Math.min(100, (Number(input.value) - min) / (max - min) * 100))}%`);
}
function isPlaying() { return state.mode === 'youtube' ? Boolean(youtube?.playing) : audio.playing; }
function renderTransport() {
  $('play').classList.toggle('playing', audio.playing);
  $('play').setAttribute('aria-label', audio.playing ? '일시정지' : '노래 재생');
  $('play').setAttribute('aria-busy', String(state.playPending));
  if (!state.seeking) {
    $('seek').value = audio.position;
    $('current-time').textContent = timeLabel(audio.position);
    $('seek').setAttribute('aria-valuetext', `${Math.floor(audio.position / 60)}분 ${Math.floor(audio.position % 60)}초`);
    rangeFill($('seek'));
  }
  drawWaveform(); drawGuide();
}
function cancelFrames() { if (state.frame) cancelAnimationFrame(state.frame); state.frame = 0; }
function animate() {
  state.frame = 0;
  renderTransport();
  if (state.mode === 'youtube' && youtube?.playing) {
    const sample = { position: youtube.position, time: performance.now() / 1000 };
    if (state.youtubeLast && Math.abs((sample.position - state.youtubeLast.position) - (sample.time - state.youtubeLast.time)) > .7) { audio.cancelPendingEffects(); releaseAll(); }
    state.youtubeLast = sample;
  }
  if (isPlaying() && !document.hidden) state.frame = requestAnimationFrame(animate);
}
function beginAnimation() { cancelFrames(); animate(); }
function releaseAll() {
  heldKeys.clear(); muffleHolds.clear(); audio.setMuffle(false);
  for (const timer of flashes.values()) clearTimeout(timer);
  flashes.clear();
  for (const kind of ['fill', 'crash', 'kick', 'snare', 'muffle']) {
    $(`pad-${kind}`).classList.remove('active', 'queued');
  }
  $('pad-muffle').setAttribute('aria-pressed', 'false'); $('tap').classList.remove('tapped');
}
function pause(message = '잠깐 쉬는 중. 다시 ▶를 누르면 이어서 재생돼요.') {
  state.generation++; state.playPending = false;
  audio.pause(); youtube?.pause(); state.youtubeLast = null; releaseAll(); cancelFrames(); renderTransport(); say(message);
}
async function togglePlay() {
  clearError();
  if (state.mode === 'youtube') {
    if (!youtube?.videoId) { say('먼저 YouTube 링크를 불러오고 영상의 ▶를 눌러주세요.'); return; }
    if (youtube.playing) pause(); else youtube.play();
    return;
  }
  if (audio.playing || state.playPending) { pause(); return; }
  if (state.loading) return;
  const generation = ++state.generation;
  state.playPending = true; renderTransport();
  try {
    await audio.ensure();
    if (generation !== state.generation || document.hidden) return;
    if (!audio.buffer) {
      const result = await audio.loadDemo();
      if (!result || generation !== state.generation || document.hidden) return;
      acceptTrack(result, 'demo');
    }
    await audio.play();
    if (generation !== state.generation || document.hidden) { audio.pause(); return; }
    say('후렴이 오면 필인 한 번. 지금은 마음대로 두드려도 좋아요.');
    beginAnimation();
  } catch (error) { errorMessage(error); }
  finally { if (generation === state.generation) { state.playPending = false; renderTransport(); } }
}
function acceptTrack(result, source) {
  state.source = source; state.taps = [];
  $('track-title').textContent = result.name;
  $('track-detail').textContent = source === 'demo' ? `직접 만든 데모 · ${result.bpm} BPM` : source === 'stems' ? '동기화된 4개 음원 · 원래 드럼은 꺼뒀어요' : '내 기기에서만 재생 · BPM은 직접 맞춰요';
  $('demo').hidden = source === 'demo';
  $('bpm').value = audio.bpm;
  $('seek').max = result.duration; $('duration').textContent = timeLabel(result.duration);
  if (source !== 'stems') { state.onsets = []; state.guided = false; $('stem-mix').hidden = true; }
  clearLoop(false); buildWaveform(); renderGuide(); renderTransport();
}
async function changeTrack(file = null) {
  setSourceMode('local');
  const request = ++state.loadGeneration;
  pause('음악을 준비하고 있어요…'); clearError(); setLoading(true);
  try {
    const result = file ? await audio.loadFile(file) : await audio.loadDemo();
    if (!result || request !== state.loadGeneration) return;
    acceptTrack(result, file ? 'local' : 'demo');
    say(file ? '준비됐어요. ▶를 누르고 노래 박자에 맞춰 4번 탭해보세요.' : '데모가 준비됐어요. ▶를 눌러 가볍게 시작해요.');
  } catch (error) { if (request === state.loadGeneration) { errorMessage(error); say('다른 음악 파일을 골라주세요. 기존 노래는 그대로 있어요.'); } }
  finally {
    if (request === state.loadGeneration) { setLoading(false); renderTransport(); }
  }
}
function flash(kind, delay = 0) {
  const pad = $(`pad-${kind}`);
  clearTimeout(flashes.get(kind));
  pad.classList.remove('active', 'queued');
  if (delay > 0.025) pad.classList.add('queued');
  else pad.classList.add('active');
  flashes.set(kind, setTimeout(() => {
    pad.classList.remove('queued'); pad.classList.add('active');
    flashes.set(kind, setTimeout(() => { pad.classList.remove('active'); flashes.delete(kind); }, 160));
  }, Math.max(0, delay * 1000)));
}
async function hit(kind) {
  if (state.loading) return;
  const generation = state.generation;
  clearError();
  try {
    await audio.ensure();
    if (generation !== state.generation || document.hidden) return;
    const externalClock = state.mode === 'youtube' ? {position: youtube?.position || 0, playing: Boolean(youtube?.playing), anchor: state.youtubeAnchor} : null;
    const delay = audio.trigger(kind, state.quantized, externalClock);
    if (delay === null) return;
    flash(kind, delay);
    say(isPlaying() ? (delay > .025 ? `${padNames[kind]}, 다음 박자에!` : `${padNames[kind]}! 좋으면 한 번 더.`) : '패드 소리 미리 듣기. ▶를 누르면 노래와 함께 놀 수 있어요.');
  } catch (error) { errorMessage(error); }
}
async function holdMuffle(token) {
  if (state.loading || state.mode === 'youtube') return;
  muffleHolds.add(token);
  const generation = state.generation;
  try {
    await audio.ensure();
    if (!muffleHolds.has(token) || generation !== state.generation || document.hidden) return;
    audio.setMuffle(true); $('pad-muffle').classList.add('active'); $('pad-muffle').setAttribute('aria-pressed', 'true');
    say('노래를 살짝 먹먹하게. 손을 떼면 다시 탁 트여요.');
  } catch (error) { muffleHolds.delete(token); errorMessage(error); }
}
function releaseMuffle(token) {
  muffleHolds.delete(token);
  if (muffleHolds.size) return;
  audio.setMuffle(false); $('pad-muffle').classList.remove('active'); $('pad-muffle').setAttribute('aria-pressed', 'false');
}
function setQuantized(value) {
  state.quantized = value; audio.cancelPendingEffects(); releaseAll();
  $('next-beat').classList.toggle('selected', value); $('next-beat').setAttribute('aria-pressed', String(value));
  $('immediate').classList.toggle('selected', !value); $('immediate').setAttribute('aria-pressed', String(!value));
  say(value ? '다음 박자에 맞춰 들어가요. 박자가 어긋나면 탭으로 맞춰요.' : '누르는 순간 소리가 나요. 타이밍도 내 마음대로.');
}
function tapTempo() {
  const now = performance.now();
  if (state.taps.length && now - state.taps.at(-1) > 2400) state.taps = [];
  state.taps.push(now); state.taps = state.taps.slice(-7);
  const bpm = bpmFromTaps(state.taps);
  if (bpm !== null) { audio.setBpm(bpm); $('bpm').value = audio.bpm; }
  for (const kind of ['fill','crash','kick','snare']) { clearTimeout(flashes.get(kind)); flashes.delete(kind); $(`pad-${kind}`).classList.remove('queued','active'); }
  if (isPlaying()) { if (state.mode === 'youtube') { state.youtubeAnchor = youtube.position; audio.cancelPendingEffects(); } else audio.alignBeat(); }
  $('tap').classList.add('tapped'); clearTimeout(flashes.get('tap'));
  flashes.set('tap', setTimeout(() => { $('tap').classList.remove('tapped'); flashes.delete('tap'); }, 110));
  say(bpm === null ? '같은 간격으로 몇 번 더 탭해보세요.' : `${audio.bpm} BPM · ${isPlaying() ? '방금 누른 순간에 박자를 맞췄어요.' : '재생 중 탭하면 노래와 박자 위치도 맞춰져요.'}`);
}
function renderLoop() {
  $('a-time').textContent = state.loopA === null ? '—' : timeLabel(state.loopA);
  $('b-time').textContent = state.loopB === null ? '—' : timeLabel(state.loopB);
  $('loop-toggle').disabled = state.mode === 'youtube' || !(state.loopA !== null && state.loopB !== null && state.loopB - state.loopA >= .25);
  $('loop-toggle').setAttribute('aria-pressed', String(state.loopEnabled));
  $('loop-toggle').textContent = state.loopEnabled ? '반복 끄기' : '반복 켜기';
}
function clearLoop(updateAudio = true) {
  state.loopA = null; state.loopB = null; state.loopEnabled = false;
  if (updateAudio) audio.setLoop(0, audio.duration, false);
  renderLoop();
}
function setLoopPoint(which) {
  if (state.mode === 'youtube') return;
  if (!audio.buffer) { say('먼저 노래를 재생한 뒤 반복 구간을 찍어주세요.'); return; }
  if (state.loopEnabled) { audio.setLoop(0, audio.duration, false); state.loopEnabled = false; }
  state[which === 'a' ? 'loopA' : 'loopB'] = audio.position;
  if (state.loopA !== null && state.loopB !== null && state.loopB - state.loopA < .25) say('B는 A보다 최소 0.25초 뒤에 찍어주세요.');
  else say(which === 'a' ? '시작 A를 찍었어요. 끝에서 B를 눌러주세요.' : '끝 B를 찍었어요. 반복 켜기를 누르면 그 구간으로 돌아가요.');
  renderLoop();
}
function buildWaveform() {
  state.waveform = [];
  if (!audio.buffer) return;
  const samples = audio.buffer.getChannelData(0), count = 160, block = Math.max(1, Math.floor(samples.length / count));
  for (let i = 0; i < count; i++) {
    let peak = 0;
    const end = Math.min(samples.length, (i + 1) * block), step = Math.max(1, Math.floor(block / 160));
    for (let j = i * block; j < end; j += step) peak = Math.max(peak, Math.abs(samples[j]));
    state.waveform.push(peak);
  }
  const peak = Math.max(...state.waveform, .01); state.waveform = state.waveform.map(n => n / peak);
}
function drawWaveform() {
  const canvas = $('waveform'), width = canvas.clientWidth || 500, height = canvas.clientHeight || 66;
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(width * pixelRatio) || canvas.height !== Math.round(height * pixelRatio)) { canvas.width = Math.round(width * pixelRatio); canvas.height = Math.round(height * pixelRatio); }
  const ctx = canvas.getContext('2d'); if (!ctx) return;
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0); ctx.clearRect(0, 0, width, height);
  const bars = Math.max(20, Math.floor(width / 5));
  const progress = audio.duration ? audio.position / audio.duration : 0;
  for (let i = 0; i < bars; i++) {
    const value = state.waveform.length ? state.waveform[Math.floor(i / bars * state.waveform.length)] : .14 + .52 * Math.abs(Math.sin(i * .27) * Math.cos(i * .71)) + .15 * Math.abs(Math.sin(i * 1.13));
    const h = Math.max(4, value * (height - 9));
    ctx.fillStyle = i / bars <= progress ? '#c6afea' : '#5d506e';
    ctx.fillRect(i * width / bars + 1, (height - h) / 2, Math.max(1.5, width / bars - 2.5), h);
  }
}

function setSourceMode(mode) {
  if (state.mode !== mode) pause();
  state.mode = mode; clearError(); state.taps = [];
  const isYouTube = mode === 'youtube';
  $('stems-panel').hidden = mode !== 'stems';
  $('source-stems').classList.toggle('selected', mode === 'stems'); $('source-stems').setAttribute('aria-pressed', String(mode === 'stems'));
  $('local-player').hidden = isYouTube; $('youtube-panel').hidden = !isYouTube;
  $('source-local').classList.toggle('selected', mode === 'local'); $('source-local').setAttribute('aria-pressed', String(mode === 'local'));
  $('source-youtube').classList.toggle('selected', isYouTube); $('source-youtube').setAttribute('aria-pressed', String(isYouTube));
  $('pad-muffle').disabled = isYouTube;
  $('muffle-description').textContent = isYouTube ? 'YouTube에서는 사용할 수 없어요' : '누르고 있다 떼면 원래대로';
  for (const id of ['loop-a','loop-b','loop-clear']) $(id).disabled = isYouTube;
  renderLoop(); if (isYouTube) $('loop-toggle').disabled = true;
  $('timing-help').textContent = isYouTube ? 'YouTube는 수동 박자예요. 재생 중 4번 탭해서 맞춰요. 영상과 패드 사이에 지연이 있을 수 있어요.' : '박자가 어긋나면 노래에 맞춰 4번 탭해요. 자동 분석이 아니라, 내가 맞추는 박자예요.';
  renderGuide();
  say(isYouTube ? '링크를 불러온 뒤 영상 안의 ▶를 눌러주세요.' : '▶를 누르고 좋아하는 부분에 한 방 얹어보세요.');
}
async function loadYouTube(event) {
  event?.preventDefault(); clearError();
  let url = $('youtube-url').value;
  try { parseYouTubeUrl(url); } catch(error) { errorMessage(error); return; }
  pause(); setSourceMode('youtube'); $('youtube-stage').hidden = false;
  $('youtube-load').disabled = true; $('youtube-hint').textContent = 'YouTube 공식 플레이어를 불러오는 중…';
  if (!youtube) youtube = new YouTubeDeck({ elementId:'youtube-player',
    onState: number => {
      if (state.mode !== 'youtube' || document.hidden) { if (number === 1) youtube.pause(); return; }
      state.youtubeLast = null;
      if (number === 1) { say('영상과 함께 자유롭게! T키나 박자 탭으로 간격을 맞춰요.'); beginAnimation(); }
      else { audio.cancelPendingEffects(); releaseAll(); cancelFrames(); }
    }, onError: error => { errorMessage(error); audio.cancelPendingEffects(); releaseAll(); $('youtube-hint').textContent = '다른 영상을 불러오거나 내 파일로 놀아보세요.'; },
    onReady: () => youtube.volume(Number($('master').value) / 100)
  });
  try {
    const result = await youtube.load(url);
    if (!result) return;
    state.youtubeAnchor = 0;
    $('youtube-hint').textContent = '준비됐어요. 영상 안의 ▶를 누르면 시작해요. 패드는 원곡 위에 더해져요.';
    say('영상의 ▶를 누른 뒤, 노래에 맞춰 박자를 4번 탭해요.');
  } catch(error) { errorMessage(error); $('youtube-hint').textContent = '플레이어를 준비하지 못했어요. 연결을 확인하고 다시 불러와주세요.'; }
  finally { $('youtube-load').disabled = false; }
}
async function loadStems() {
  const files = Object.fromEntries(['drums','bass','other','vocals'].map(kind => [kind, $(`stem-${kind}`).files?.[0]]));
  if (Object.values(files).some(file => !file)) { errorMessage(new Error('드럼·베이스·나머지 악기·보컬 파일을 모두 골라주세요.')); return; }
  const request = ++state.loadGeneration; pause('분리된 파일들을 같은 타임라인에 준비하고 있어요…'); clearError();
  setLoading(true);
  try {
    const result = await audio.loadStems(files);
    if (!result || request !== state.loadGeneration) return;
    state.onsets = detectOnsets(audio.stemBuffers.drums);
    state.guided = false; audio.setStemMix('drummer'); state.stemMix = 'drummer';
    acceptTrack(result, 'stems'); $('stem-mix').hidden = false; setStemMix('drummer'); renderGuide();
    say(`내가 드러머 모드가 준비됐어요. ▶로 시작해요. 추정 타이밍 ${state.onsets.length}개는 따라치기에서 볼 수 있어요.`);
  } catch(error) { if (request === state.loadGeneration) errorMessage(error); }
  finally { if (request === state.loadGeneration) { setLoading(false); renderTransport(); } }
}
function setStemMix(mode) {
  if (!audio.stemBuffers) return;
  audio.setStemMix(mode); state.stemMix = mode;
  const labels = {mix:'모든 소리 함께',vocals:'보컬만 재생',instrumental:'보컬 없이 악기만',drummer:'원래 드럼 없이 내가 드러머'};
  for (const [id,value] of [['mix-all','mix'],['mix-vocals','vocals'],['mix-instrumental','instrumental'],['mix-drummer','drummer']]) {
    $(id).classList.toggle('selected', mode === value); $(id).setAttribute('aria-pressed', String(mode === value));
  }
  $('track-detail').textContent = `동기화된 4개 음원 · ${labels[mode]}`;
  say(`${labels[mode]}. 소리만 바뀌고, 노래 위치는 그대로예요.`);
}
function renderGuide() {
  const available = state.source === 'stems' && Boolean(audio.stemBuffers) && state.mode !== 'youtube';
  $('guide-section').hidden = !available; $('guided-mode').disabled = !state.onsets.length;
  $('guide-lane').hidden = !available || !state.guided; $('guide-tip').hidden = !available || !state.guided;
  $('guide-detail').textContent = state.onsets.length ? `드럼 소리 시작점 ${state.onsets.length}개 추정 · 킥/스네어 구분 아님 · 정확한 악보 아님` : '뚜렷한 드럼 시작점을 찾지 못했어요. 자유롭게 연주해보세요.';
  $('free-mode').classList.toggle('selected', !state.guided); $('free-mode').setAttribute('aria-pressed', String(!state.guided));
  $('guided-mode').classList.toggle('selected', state.guided); $('guided-mode').setAttribute('aria-pressed', String(state.guided));
  drawGuide();
}
function setGuided(value) {
  if (value && (!state.onsets.length || state.mode === 'youtube')) return;
  state.guided = value;
  if (value) setQuantized(false);
  renderGuide(); say(value ? '점이 선에 오면 가볍게 톡. 실제 손 타이밍대로 소리가 나도록 ‘즉시’로 바꿨어요.' : '힌트 없이 내 느낌대로. 노래를 즐겨요.');
}
function drawGuide() {
  if (!state.guided || state.mode === 'youtube') return;
  const canvas = $('guide-canvas'), width = canvas.clientWidth || 600, height = 70;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== height * ratio) { canvas.width = Math.round(width * ratio); canvas.height = height * ratio; }
  const ctx = canvas.getContext('2d'); if (!ctx) return;
  ctx.setTransform(ratio,0,0,ratio,0,0); ctx.clearRect(0,0,width,height);
  const position = audio.position;
  for (const at of state.onsets) {
    const delta = at-position; if (delta < -1.2 || delta > 2.8) continue;
    const x = width * (.3 + delta / 4);
    ctx.fillStyle = Math.abs(delta) < .085 ? '#ffca73' : delta < 0 ? '#584167' : '#c3a7e6';
    ctx.beginPath(); ctx.arc(x,28,Math.abs(delta)<.085?7:5,0,Math.PI*2); ctx.fill();
  }
}
$('source-stems').addEventListener('click', () => setSourceMode('stems'));
$('stems-load').addEventListener('click', loadStems);
for (const [id,mode] of [['mix-all','mix'],['mix-vocals','vocals'],['mix-instrumental','instrumental'],['mix-drummer','drummer']]) $(id).addEventListener('click', () => setStemMix(mode));
$('free-mode').addEventListener('click', () => setGuided(false)); $('guided-mode').addEventListener('click', () => setGuided(true));
$('source-local').addEventListener('click', () => setSourceMode('local'));
$('source-youtube').addEventListener('click', () => setSourceMode('youtube'));
$('youtube-form').addEventListener('submit', loadYouTube);
$('play').addEventListener('click', togglePlay);
$('load-file').addEventListener('click', () => $('audio-file').click());
$('audio-file').addEventListener('change', event => { const file = event.target.files?.[0]; if (file) changeTrack(file); event.target.value = ''; });
$('demo').addEventListener('click', () => changeTrack());
$('restart').addEventListener('click', () => { state.generation++; state.playPending = false; releaseAll(); audio.seek(0); renderTransport(); say(state.loopEnabled ? '반복 구간 처음으로 돌아왔어요.' : '처음으로 돌아왔어요.'); });
$('seek').addEventListener('input', event => { state.seeking = true; $('current-time').textContent = timeLabel(event.target.value); rangeFill(event.target); });
$('seek').addEventListener('change', event => { state.generation++; state.playPending = false; releaseAll(); audio.seek(Number(event.target.value)); state.seeking = false; renderTransport(); });
$('bpm').addEventListener('change', event => { state.taps = []; event.target.value = audio.setBpm(Number(event.target.value)); releaseAll(); say('패드 간격만 바뀌어요. 원곡의 재생 속도는 그대로예요.'); });
$('tap').addEventListener('click', tapTempo);
$('next-beat').addEventListener('click', () => setQuantized(true)); $('immediate').addEventListener('click', () => setQuantized(false));
for (const kind of ['fill', 'crash', 'kick', 'snare', 'muffle']) {
  const pad = $(`pad-${kind}`);
  pad.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault(); pad.focus({ preventScroll: true });
    if (kind === 'muffle') { pad.setPointerCapture(event.pointerId); holdMuffle(`pointer-${event.pointerId}`); }
    else hit(kind);
  });
  if (kind === 'muffle') {
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) pad.addEventListener(name, event => releaseMuffle(`pointer-${event.pointerId}`));
  }
  // Native keyboard/assistive clicks have detail 0; pointer clicks were handled above.
  pad.addEventListener('click', event => {
    if (event.detail !== 0) return;
    if (kind !== 'muffle') hit(kind);
    else { holdMuffle('accessible-pulse'); setTimeout(() => releaseMuffle('accessible-pulse'), 600); }
  });
  pad.addEventListener('contextmenu', event => event.preventDefault());
}
$('master').addEventListener('input', event => { audio.setMaster(Number(event.target.value) / 100); youtube?.volume(Number(event.target.value) / 100); $('master-value').textContent = `${event.target.value}%`; rangeFill(event.target); });
$('effects').addEventListener('input', event => { audio.setEffects(Number(event.target.value) / 100); $('effects-value').textContent = `${event.target.value}%`; rangeFill(event.target); });
$('more').addEventListener('click', () => { const expanded = $('more').getAttribute('aria-expanded') !== 'true'; $('more').setAttribute('aria-expanded', String(expanded)); $('advanced').hidden = !expanded; });
$('loop-a').addEventListener('click', () => setLoopPoint('a')); $('loop-b').addEventListener('click', () => setLoopPoint('b'));
$('loop-clear').addEventListener('click', () => { clearLoop(); say('반복 구간을 지웠어요.'); });
$('loop-toggle').addEventListener('click', () => { try { state.loopEnabled = !state.loopEnabled; audio.setLoop(state.loopA, state.loopB, state.loopEnabled); renderLoop(); renderGuide(); renderTransport(); say(state.loopEnabled ? '이 부분만 반복해요. 손이 편해질 때까지 놀아보세요.' : '반복을 껐어요. 노래가 계속 이어져요.'); } catch (error) { state.loopEnabled = false; renderLoop(); errorMessage(error); } });
document.addEventListener('keydown', event => {
  if (event.ctrlKey || event.metaKey || event.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) || event.target.isContentEditable) return;
  const muffleFocus = event.target === $('pad-muffle') && ['Space', 'Enter'].includes(event.code);
  const kind = muffleFocus ? 'muffle' : keyPads[event.code];
  if (!kind && event.code !== 'KeyT' && event.code !== 'Space') return;
  if (event.code === 'Space' && event.target.tagName === 'BUTTON' && !muffleFocus) return;
  event.preventDefault(); if (event.repeat || heldKeys.has(event.code)) return; heldKeys.add(event.code);
  if (kind === 'muffle') holdMuffle(`key-${event.code}`); else if (kind) hit(kind); else if (event.code === 'KeyT') tapTempo(); else togglePlay();
});
document.addEventListener('keyup', event => { heldKeys.delete(event.code); releaseMuffle(`key-${event.code}`); });
window.addEventListener('blur', releaseAll);
document.addEventListener('visibilitychange', () => { if (document.hidden) pause('다른 화면으로 이동해서 잠시 멈췄어요. ▶로 다시 시작해요.'); });
window.addEventListener('pagehide', () => pause());
window.addEventListener('resize', () => { drawWaveform(); drawGuide(); });
audio.onend = () => { state.generation++; state.playPending = false; releaseAll(); cancelFrames(); renderTransport(); say('한 곡 끝! ▶로 다시 듣거나 내 음악을 불러와 보세요.'); };
audio.setMaster(.65); audio.setEffects(.7);
for (const id of ['seek', 'master', 'effects']) rangeFill($(id));
renderLoop(); renderGuide(); renderTransport();
