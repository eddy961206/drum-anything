import { DrumAudio } from './audio.js';
import { BPM, STEP_SECONDS, PHRASE_STEPS, ROUND_SECONDS, HIT_WINDOW, clampLevel, createPhrase, findNearestNote, adaptLevel } from './rhythm.js';

const $ = (id) => document.getElementById(id);
const audio = new DrumAudio();
audio.setVolume(.65);
const ui = {
  play: $('play-button'), playLabel: $('play-label'), playIcon: $('play-icon'), feedback: $('feedback'),
  grid: $('rhythm-grid'), playhead: $('playhead'), progress: $('round-progress'), elapsed: $('elapsed'),
  seconds: $('seconds'), timer: $('timer-circle'), status: $('adaptive-status'), settings: $('settings-dialog'),
  pads: { kick: $('kick-pad'), snare: $('snare-pad') },
};
const state = {
  phase: 'ready', mode: 'guided', position: 0, origin: 0, nextStep: 0, shownPhrase: -1, shownStep: -1,
  phrases: new Map(), adaptation: { level: 1, good: 0, hard: 0, locked: false }, pending: 0,
  interval: 0, frame: 0, generation: 0, starting: false, latency: 0, lastFeedback: 0,
};
const heldKeys = new Set();
const hitTimers = new Map();
const cueTimers = new Map();
const dots = [];
let watchedContext = null;

for (let step = 0; step < PHRASE_STEPS; step++) {
  const column = document.createElement('div'); column.className = 'step';
  const kick = document.createElement('span'); kick.className = 'dot';
  const snare = document.createElement('span'); snare.className = 'dot';
  column.append(kick, snare); ui.grid.insertBefore(column, ui.playhead);
  dots.push({ column, kick, snare });
}

function position() { return state.phase === 'playing' ? Math.max(0, audio.currentTime - state.origin) : state.position; }
function announce(text, force = false) {
  const now = performance.now();
  if (force || now - state.lastFeedback > 1100) { ui.feedback.textContent = text; state.lastFeedback = now; }
}
function setStatus(text) { ui.status.textContent = text; }
function resetCounters() { state.adaptation.good = 0; state.adaptation.hard = 0; }
function setLock(locked) {
  state.adaptation.locked = locked;
  $('just-right').setAttribute('aria-pressed', String(locked));
  $('auto-adapt').checked = !locked;
  resetCounters();
}
function clearPendingButtons() { $('easier-up').classList.remove('pending'); $('easier-down').classList.remove('pending'); }
function nextPhrase(index) {
  if (state.phrases.has(index)) return state.phrases.get(index);
  const before = state.adaptation.level;
  const previous = state.phrases.get(index - 1);
  if (previous && !previous.finalized) {
    previous.finalized = true;
    if (state.mode === 'guided' && !state.pending) state.adaptation = adaptLevel(state.adaptation, {
      total: previous.notes.length, matched: previous.matched, attempts: previous.attempts,
    });
  }
  if (state.pending) {
    state.adaptation.level = clampLevel(state.adaptation.level + state.pending);
    state.pending = 0; resetCounters(); clearPendingButtons();
  }
  const phrase = createPhrase(index, state.adaptation.level);
  state.phrases.set(index, phrase);
  if (before !== state.adaptation.level) {
    phrase.changeMessage = state.adaptation.level > before ? '이번 구절은 한 입만 더. 언제든 덜어도 돼.' : '이번 구절은 조금 느긋하게. 반주는 계속 함께해.';
  }
  return phrase;
}
function renderPhrase(phrase) {
  state.shownPhrase = phrase.index;
  dots.forEach((dot, i) => {
    dot.kick.className = `dot${phrase.pattern.kick.includes(i) ? ' kick-note' : ''}`;
    dot.snare.className = `dot${phrase.pattern.snare.includes(i) ? ' snare-note' : ''}`;
  });
  for (const note of phrase.notes) if (note.hit) dots[note.step][note.drum].classList.add('matched');
  if (phrase.changeMessage && state.mode === 'guided') setStatus(phrase.changeMessage);
}
function pulse(drum, kind) {
  const map = kind === 'hit' ? hitTimers : cueTimers;
  clearTimeout(map.get(drum));
  const pad = ui.pads[drum];
  pad.classList.remove(kind);
  // Re-trigger a tiny tactile animation without accumulating animation objects.
  if (kind === 'hit') void pad.offsetWidth;
  pad.classList.add(kind);
  map.set(drum, setTimeout(() => pad.classList.remove(kind), kind === 'hit' ? 130 : 160));
}
function clearPulseTimers() {
  for (const timer of [...hitTimers.values(), ...cueTimers.values()]) clearTimeout(timer);
  hitTimers.clear(); cueTimers.clear();
  Object.values(ui.pads).forEach(pad => pad.classList.remove('cue', 'hit'));
}
function stopLoops() {
  clearInterval(state.interval); cancelAnimationFrame(state.frame);
  state.interval = 0; state.frame = 0; clearPulseTimers();
}
function renderClock(elapsed) {
  const safe = Math.max(0, Math.min(ROUND_SECONDS, elapsed));
  ui.seconds.textContent = String(Math.ceil(ROUND_SECONDS - safe));
  ui.seconds.parentElement.parentElement.setAttribute('aria-label', `남은 시간 ${Math.ceil(ROUND_SECONDS - safe)}초`);
  ui.progress.value = safe;
  ui.timer.style.strokeDashoffset = String(333.01 * safe / ROUND_SECONDS);
  const sec = Math.floor(safe); ui.elapsed.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')} / 1:00`;
}
function renderTransport() {
  const playing = state.phase === 'playing';
  document.body.classList.toggle('playing', playing);
  document.body.classList.toggle('completed', state.phase === 'done');
  ui.playLabel.textContent = playing ? '잠깐 쉬기' : state.phase === 'paused' ? '이어서 연주하기' : state.phase === 'done' ? '한 번 더 둥탁' : '같이 연주하기';
  ui.playIcon.innerHTML = playing ? '<path d="M7 5h3v14H7Zm7 0h3v14h-3Z"/>' : '<path d="M7 4 20 12 7 20Z"/>';
  ui.play.disabled = state.starting;
}
function finish() {
  stopLoops(); audio.stopAll(); state.phase = 'done'; state.position = ROUND_SECONDS;
  state.generation++; renderClock(ROUND_SECONDS); renderTransport();
  announce('벌써 한 곡 했네. 더 놀아도, 여기서 끝내도 좋아.', true);
  setStatus('오늘의 둥탁은 여기까지 해도 충분해. 점수도 숙제도 없어.');
}
function schedule() {
  if (state.phase !== 'playing') return;
  const now = audio.currentTime;
  const elapsed = now - state.origin;
  if (elapsed >= ROUND_SECONDS) { finish(); return; }
  // A 25 ms lookahead loop schedules onto the audio clock, never setTimeout beats.
  // If a browser stalls, skip old notes rather than playing a burst to catch up.
  const firstFuture = Math.ceil(Math.max(0, elapsed - .035) / STEP_SECONDS);
  if (state.nextStep < firstFuture) state.nextStep = firstFuture;
  while (state.origin + state.nextStep * STEP_SECONDS < now + .12) {
    const stepTime = state.nextStep * STEP_SECONDS;
    if (stepTime >= ROUND_SECONDS - 1e-8) break;
    nextPhrase(Math.floor(state.nextStep / PHRASE_STEPS));
    audio.scheduleBacking(state.nextStep, state.origin + stepTime, STEP_SECONDS);
    state.nextStep++;
  }
}
function animate() {
  if (state.phase !== 'playing') return;
  const elapsed = position(); renderClock(elapsed);
  if (elapsed >= ROUND_SECONDS) { finish(); return; }
  const rawStep = Math.floor(elapsed / STEP_SECONDS);
  const phraseIndex = Math.floor(rawStep / PHRASE_STEPS);
  const phrase = state.phrases.get(phraseIndex);
  if (phrase && state.shownPhrase !== phraseIndex) renderPhrase(phrase);
  const step = rawStep % PHRASE_STEPS;
  const fraction = (elapsed / STEP_SECONDS) % PHRASE_STEPS;
  // Dot centers are the targets; the line moves continuously between them.
  ui.playhead.style.transform = `translateX(${((fraction + .5) / PHRASE_STEPS) * ui.grid.clientWidth}px)`;
  if (rawStep !== state.shownStep) {
    dots.forEach((d, i) => d.column.classList.toggle('current', i === step)); state.shownStep = rawStep;
    if (state.mode === 'guided' && phrase) for (const drum of ['kick', 'snare']) if (phrase.pattern[drum].includes(step)) pulse(drum, 'cue');
  }
  state.frame = requestAnimationFrame(animate);
}
async function ensureAudio() {
  await audio.unlock();
  if (watchedContext !== audio.context) {
    watchedContext = audio.context;
    audio.context.addEventListener('statechange', () => {
      if (state.phase === 'playing' && audio.state !== 'running') pause('소리가 잠깐 쉬고 있어. 버튼을 누르면 이어갈게.');
    });
  }
}
async function start() {
  if (state.starting || state.phase === 'playing' || document.hidden) return;
  if (state.phase === 'done') resetRound();
  state.starting = true; renderTransport();
  const generation = ++state.generation;
  try {
    await ensureAudio();
    if (generation !== state.generation || document.hidden) return;
    stopLoops(); audio.stopAll();
    state.origin = audio.currentTime + .12 - state.position;
    state.nextStep = Math.ceil(state.position / STEP_SECONDS);
    state.shownStep = -1; state.phase = 'playing';
    nextPhrase(Math.floor(state.nextStep / PHRASE_STEPS));
    schedule(); state.interval = setInterval(schedule, 25); state.frame = requestAnimationFrame(animate);
    announce(state.mode === 'guided' ? '움직이는 선이 점에 오면 둥, 탁. 놓쳐도 괜찮아.' : '반주는 나에게 맡겨. 손 가는 대로 둥탁!', true);
  } catch (error) {
    announce(error.message || '소리를 시작하지 못했어. 다시 한 번 눌러 줄래?', true);
  } finally {
    if (generation === state.generation) state.starting = false;
    renderTransport();
  }
}
function pause(message = '잠깐 쉬어도 좋아. 같은 자리에서 이어갈게.') {
  state.generation++; state.starting = false;
  if (state.phase === 'playing') { state.position = Math.min(ROUND_SECONDS, position()); state.phase = 'paused'; }
  stopLoops(); audio.stopAll(); heldKeys.clear(); renderTransport();
  if (state.phase === 'paused') announce(message, true);
}
function resetRound() {
  state.generation++; state.starting = false; stopLoops(); audio.stopAll();
  state.phase = 'ready'; state.position = 0; state.nextStep = 0; state.shownStep = -1;
  state.phrases.clear(); resetCounters(); heldKeys.clear();
  renderPhrase(nextPhrase(0)); dots.forEach(d => d.column.classList.remove('current'));
  renderClock(0); renderTransport();
  announce('패드를 눌러 소리를 들어봐. 준비되면 같이 시작!', true);
  setStatus(state.adaptation.locked ? '지금 느낌으로 고정했어. 원하면 언제든 바꿔도 돼.' : '어려움은 구절 사이에만 살짝. ‘딱 좋아’를 누르면 지금 그대로.');
}
async function hit(drum) {
  if (document.hidden || ui.settings.open) return;
  pulse(drum, 'hit');
  try {
    await ensureAudio();
    if (document.hidden) return;
    audio[drum](audio.currentTime, .85);
  } catch (error) { announce(error.message, true); return; }
  if (state.phase !== 'playing') { announce(drum === 'kick' ? '이게 둥. 낮고 포근한 킥.' : '이게 탁. 리듬을 살리는 스네어.'); return; }
  if (state.mode === 'free') { announce('좋아. 지금 그게 네 그루브야.'); return; }
  const elapsed = position() - state.latency;
  const nearby = [...state.phrases.values()].filter(p => Math.abs(p.index - Math.floor(elapsed / (STEP_SECONDS * PHRASE_STEPS))) <= 1);
  const match = findNearestNote(nearby, drum, elapsed);
  const phrase = match?.phrase || state.phrases.get(Math.max(0, Math.floor(position() / (STEP_SECONDS * PHRASE_STEPS))));
  if (phrase) phrase.attempts++;
  if (match) {
    match.note.hit = true; match.phrase.matched++;
    if (match.phrase.index === state.shownPhrase) dots[match.note.step][drum].classList.add('matched');
    announce(match.delta < .085 ? '딱, 잘 어울렸어.' : '좋아, 같이 가고 있어.');
  } else announce('내 박자도 좋아. 반주는 계속 함께해.');
}
function changeFeeling(delta) {
  if (state.mode !== 'guided') return;
  clearPendingButtons();
  const desired = clampLevel(state.adaptation.level + delta);
  if (desired === state.adaptation.level) {
    setStatus(delta > 0 ? '지금이 가장 풍성한 리듬이야. 마음대로 모드도 즐겨 봐.' : '지금이 가장 여유로운 리듬이야. 한 손만 쳐도 괜찮아.'); return;
  }
  // Explicit choice unlocks auto-adjustment; "just right" can pin it again.
  setLock(false);
  if (state.phase === 'playing' || state.phase === 'paused') {
    state.pending = delta; (delta > 0 ? $('easier-up') : $('easier-down')).classList.add('pending');
    setStatus(delta > 0 ? '좋아, 다음 구절부터 조금 더 얹어볼게.' : '알겠어. 다음 구절부터 조금 덜어낼게.');
  } else {
    state.adaptation.level = desired; state.pending = 0;
    state.phrases.clear(); renderPhrase(nextPhrase(0));
    setStatus(delta > 0 ? '조금 더 풍성하게 준비했어. 부담되면 바로 말해 줘.' : '조금 더 여유롭게 준비했어. 둥, 탁만 즐겨.');
  }
}
function setMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode; state.pending = 0; resetCounters(); clearPendingButtons();
  $('guided-mode').classList.toggle('selected', mode === 'guided'); $('guided-mode').setAttribute('aria-pressed', String(mode === 'guided'));
  $('free-mode').classList.toggle('selected', mode === 'free'); $('free-mode').setAttribute('aria-pressed', String(mode === 'free'));
  $('rhythm-area').hidden = mode === 'free'; $('free-message').hidden = mode !== 'free';
  document.querySelector('.feeling').classList.toggle('is-free', mode === 'free');
  ['easier-up', 'easier-down', 'just-right'].forEach(id => $(id).disabled = mode === 'free');
  // A mode switch starts a fresh measurement, not a partial phrase assessment.
  for (const phrase of state.phrases.values()) phrase.finalized = true;
  announce(mode === 'free' ? '반주 위에 마음대로. 맞고 틀린 박자는 없어.' : '주황은 둥, 초록은 탁. 점에 맞춰 가볍게!', true);
  setStatus(mode === 'free' ? '마음대로 모드에는 정답도, 난이도 조절도 없어.' : state.adaptation.locked ? '지금 느낌으로 고정했어. 원하면 언제든 바꿔도 돼.' : '어려움은 구절 사이에만 살짝. ‘딱 좋아’를 누르면 지금 그대로.');
}

ui.play.addEventListener('click', () => state.phase === 'playing' ? pause() : start());
$('restart-button').addEventListener('click', resetRound);
$('guided-mode').addEventListener('click', () => setMode('guided'));
$('free-mode').addEventListener('click', () => setMode('free'));
$('easier-up').addEventListener('click', () => changeFeeling(1));
$('easier-down').addEventListener('click', () => changeFeeling(-1));
$('just-right').addEventListener('click', () => {
  setLock(true); state.pending = 0; clearPendingButtons();
  setStatus('딱 좋은 지금으로 고정했어. 더 어렵게 만들지 않을게.');
});
for (const [drum, pad] of Object.entries(ui.pads)) {
  pad.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault(); hit(drum);
  });
  // Keyboard/screen-reader activation, without duplicating pointer taps.
  pad.addEventListener('click', event => { if (event.detail === 0) hit(drum); });
  pad.addEventListener('contextmenu', event => event.preventDefault());
}
const keyDrums = { KeyF: 'kick', KeyD: 'kick', KeyJ: 'snare', KeyK: 'snare' };
document.addEventListener('keydown', event => {
  if (event.ctrlKey || event.metaKey || event.altKey || ui.settings.open || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
  const drum = keyDrums[event.code];
  if (drum) {
    event.preventDefault();
    if (!event.repeat && !heldKeys.has(event.code)) { heldKeys.add(event.code); hit(drum); }
  } else if (event.code === 'Space' && event.target === document.body) {
    event.preventDefault(); if (!event.repeat) state.phase === 'playing' ? pause() : start();
  }
});
document.addEventListener('keyup', event => heldKeys.delete(event.code));
window.addEventListener('blur', () => heldKeys.clear());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { pause('다른 화면을 보는 동안 쉬어뒀어. 준비되면 이어가자.'); audio.suspend().catch(() => {}); }
});
window.addEventListener('pagehide', () => { pause(); audio.suspend().catch(() => {}); });
$('settings-open').addEventListener('click', () => { if (state.phase === 'playing') pause('소리를 편하게 맞춰 봐. 돌아오면 이어갈게.'); ui.settings.showModal(); });
for (const id of ['settings-close', 'settings-done']) $(id).addEventListener('click', () => ui.settings.close());
ui.settings.addEventListener('click', event => { if (event.target === ui.settings) { const r = ui.settings.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) ui.settings.close(); } });
$('volume').addEventListener('input', event => { audio.setVolume(Number(event.target.value) / 100); $('volume-value').textContent = `${event.target.value}%`; });
$('mute-button').addEventListener('click', () => { audio.setMuted(!audio.muted); $('mute-button').textContent = audio.muted ? '소리 켜기' : '소리 끄기'; $('mute-button').setAttribute('aria-pressed', String(audio.muted)); });
$('latency').addEventListener('input', event => { const value = Number(event.target.value); state.latency = value / 1000; $('latency-value').textContent = `${value > 0 ? '+' : ''}${value} ms`; });
$('auto-adapt').addEventListener('change', event => { setLock(!event.target.checked); state.pending = 0; clearPendingButtons(); setStatus(event.target.checked ? '다시 조금씩 맞춰볼게. 변화는 구절 사이에만.' : '지금 느낌으로 고정했어. 원하면 언제든 바꿔도 돼.'); });
resetRound();
