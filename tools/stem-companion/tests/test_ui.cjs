'use strict';
// Dependency-free static/DOM/AudioContext mocks: no browser, media downloads, or models.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../static/index.html'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8');
const ids = [...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);

async function fixture(overrides = {}, { navigator = {} } = {}) {
  const elements = new Map();
  class Element {
    constructor(id) { this.id = id; this.hidden = false; this.disabled = false; this.value = ''; this.checked = false; this.dataset = {}; this.children = []; this.attrs = {}; this.listeners = {}; this.files = []; this.style = {}; this.contentWindow = { postMessage() {} }; this.classList = { toggle() {}, add() {}, remove() {} }; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    setAttribute(name, value) { this.attrs[name] = value; }
    removeAttribute(name) { delete this.attrs[name]; }
    append(...children) { for (const item of children) { this.children.push(item); if (item.id) elements.set(item.id, item); } }
    replaceChildren() { this.children = []; }
    getContext() { return null; }
    closest() { return null; }
    focus() {}
  }
  for (const id of ids) elements.set(id, new Element(id));
  elements.get('loop').checked = true;
  elements.get('pad-volume').value = '0.8';
  elements.get('excerpt-start').value = '0';
  elements.get('excerpt-duration').value = '60';
  const group = (key, values) => values.map((value) => { const element = new Element(); element.dataset[key] = value; return element; });
  const groups = { '[data-source]': group('source', ['file', 'youtube']), '[data-range]': group('range', ['full', 'excerpt']), '[data-audio-choice]': group('audioChoice', ['demo', 'job']), '[data-loop-mode]': group('loopMode', ['full', 'section']), '[data-mode]': group('mode', ['all', 'vocals', 'instrumental', 'guide', 'drummer']), '[data-stage]': group('stage', ['acquiring', 'normalizing', 'separating', 'analyzing', 'ready']),
    '[data-lanes]': group('lanes', ['kick', 'kick-snare', 'all']), '[data-judge]': group('judge', ['pads', 'timing', 'off']), '[data-rate]': group('rate', ['1', '0.85', '0.7', '0.5']) };
  const param = () => ({ value: 0, setValueAtTime(value) { this.value = value; }, setTargetAtTime(value) { this.value = value; }, exponentialRampToValueAtTime() {}, cancelScheduledValues() {} });
  const node = () => ({ connect() {}, disconnect() {}, gain: param() });
  const audio = { context: null, nodes: [], downloads: 0, sampleDownloads: 0, duration: 3, started: 0 };
  class AudioContext {
    constructor() { this.currentTime = 0; this.destination = {}; this.sampleRate = 44100; audio.context = this; }
    createGain() { return node(); }
    createDynamicsCompressor() { return { ...node(), threshold: param(), knee: param(), ratio: param() }; }
    createBufferSource() { const source = { ...node(), playbackRate: param(), start(at, offset) { this.startArgs = [at, offset]; audio.started++; }, stop(at) { this.stopAt = at; }, loop: false }; audio.nodes.push(source); return source; }
    createBuffer(channels, length) { return { getChannelData: () => new Float32Array(length) }; }
    createOscillator() { return { ...node(), frequency: param(), start() { audio.started++; }, stop() {} }; }
    createBiquadFilter() { return { ...node(), frequency: param() }; }
    resume() { return Promise.resolve(); }
    decodeAudioData(data) { return Promise.resolve({ duration: data.fakeDuration || 3 }); }
  }
  const session = { csrf: 'ephemeral-test-token', dependencies: { ready: true, youtube_ready: false, missing: [], youtube_missing: ['Deno'] }, limits: { max_upload_bytes: 104857600, max_source_seconds: 3600, max_excerpt_seconds: 3600 }, job: null, ...overrides };
  const windowListeners = {}, documentListeners = {}, requests = [], timers = [], clock = { now: 1000 };
  const context = { console, URL, URLSearchParams, Headers, AbortController, performance: { now: () => clock.now }, navigator,
    setTimeout(callback, milliseconds) { timers.push({ callback, milliseconds }); return timers.length; }, clearTimeout() {}, requestAnimationFrame() {},
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url === '/api/session') return { ok: true, json: async () => session };
      if (url === '/api/jobs') return { ok: true, json: async () => ({ id: 'submitted', status: 'queued' }) };
      if (String(url).startsWith('/samples/')) { audio.sampleDownloads += 1; return { ok: true, arrayBuffer: async () => new ArrayBuffer(2) }; }
      audio.downloads += 1;
      const index = Number(String(url).match(/\/chunks\/(\d+)\//)?.[1] || 0);
      return { ok: true, arrayBuffer: async () => { const data = new ArrayBuffer(2); data.fakeDuration = Math.min(20, audio.duration - index * 20); return data; } };
    },
    document: { body: new Element('body'), getElementById: (id) => elements.get(id), querySelectorAll: (query) => groups[query] || [], createElement: () => new Element(), addEventListener(name, callback) { documentListeners[name] = callback; }, activeElement: null },
    window: { AudioContext, addEventListener(name, callback) { windowListeners[name] = callback; }, devicePixelRatio: 1, confirm: () => true },
    location: new URL('http://127.0.0.1:8765/') };
  vm.createContext(context); vm.runInContext(js, context); await new Promise(setImmediate);
  return { elements, context, audio, session, requests, timers, windowListeners, documentListeners, clock, groups, run: (code) => vm.runInContext(code, context) };
}
async function ready(f, duration = 3) {
  f.audio.duration = duration;
  f.run(`audioChoice = 'job'; job = {id: 'fixture', status: 'ready', duration: ${duration}, chunk_seconds: 20, onsets: [0.1, NaN, -1, 1.1], stems: Object.fromEntries(STEMS.map(stem => [stem, \`/media/fixture/\${stem}.wav\`]))}`);
  await f.run('loadAudio(job)');
}

test('every fixed JS element reference exists and HTML IDs are unique', () => {
  assert.equal(new Set(ids).size, ids.length);
  for (const [, id] of js.matchAll(/\$\('([^']+)'\)/g)) assert(ids.includes(id), `Missing element: ${id}`);
});
test('main UI loads only local scripts; YouTube preview is isolated', () => {
  assert(!/https?:\/\/[^\s'"]+/.test(js));
  assert(!/<(?:script|link)[^>]+(?:src|href)="https?:/.test(html));
});
test('static input defaults agree with backend bounds and supported types', () => {
  assert(html.includes('max="3599"')); assert(!html.includes('.wma')); assert(html.includes('.webm'));
});
test('local file works without YouTube-only dependencies', async () => {
  const f = await fixture(); assert.equal(f.elements.get('create-job').disabled, false);
  f.run("selectSource('youtube')"); assert.equal(f.elements.get('create-job').disabled, true); assert(f.elements.get('dependencies').textContent.includes('Deno'));
  f.run("selectSource('file')"); assert.equal(f.elements.get('create-job').disabled, false);
});
test('missing base dependencies disable creation', async () => {
  const f = await fixture({ dependencies: { ready: false, youtube_ready: false, missing: ['ffmpeg'] } });
  assert.equal(f.elements.get('create-job').disabled, true); assert(f.elements.get('dependencies').textContent.includes('ffmpeg'));
});
test('bundled song loads and plays without the separation tools', async () => {
  const demo = { id: 'sample', status: 'ready', title: '기본 곡', artist: '연주자', duration: 3, chunk_seconds: 20, onsets: [0.1], stems: Object.fromEntries(['vocals', 'bass', 'drums', 'other'].map((s) => [s, `/media/sample/${s}.wav`])) };
  const f = await fixture({ dependencies: { ready: false, youtube_ready: false, missing: ['ffmpeg'] }, bundled_demo: demo });
  await new Promise(setImmediate);
  assert.equal(f.elements.get('player-section').hidden, false);
  assert.equal(f.elements.get('play').disabled, false);
  assert.equal(f.elements.get('track-title').textContent, '기본 곡 · 연주자');
  assert(f.elements.get('dependencies').textContent.includes('기본 샘플은 바로 연주'));
  await f.run('play()');
  assert.equal(f.audio.nodes.length, 4);
});
test('a completed user song can switch to and from the bundled song', async () => {
  const demo = { id: 'sample', status: 'ready', title: '기본 곡', artist: '연주자', duration: 3, chunk_seconds: 20, onsets: [], stems: Object.fromEntries(['vocals', 'bass', 'drums', 'other'].map((s) => [s, `/media/sample/${s}.wav`])) };
  const f = await fixture({ bundled_demo: demo }); await new Promise(setImmediate);
  f.run("renderJob({id:'fixture', status:'ready', duration:3, chunk_seconds:20, onsets:[], stems:Object.fromEntries(STEMS.map(s => [s, `/media/fixture/${s}.wav`]))})");
  await new Promise(setImmediate);
  assert.equal(f.elements.get('track-title').textContent, '내가 분리한 곡');
  assert.equal(f.run('loadedId'), 'fixture');
  f.run("selectAudioChoice('demo')"); await new Promise(setImmediate);
  assert.equal(f.run('loadedId'), 'sample');
  f.run("selectAudioChoice('job')"); await new Promise(setImmediate);
  assert.equal(f.run('loadedId'), 'fixture');
  f.run('renderJob(null)'); await new Promise(setImmediate);
  assert.equal(f.run('loadedId'), 'sample');
});
test('time formatting and excerpt numeric validation', async () => {
  const f = await fixture(); assert.equal(f.run('formatTime(125)'), '2:05');
  assert.equal(f.run('formatTime(3600)'), '1:00:00');
  assert.equal(f.run("checkNumber(3600, 1, 3600, 'duration')"), 3600);
  assert.throws(() => f.run("checkNumber(NaN, 1, 3600, 'duration')")); assert.throws(() => f.run("checkNumber(3601, 1, 3600, 'duration')")); assert.throws(() => f.run("checkNumber(-1, 0, 3599, 'start')"));
});
test('YouTube preview accepts only the same single-video URLs as the backend', async () => {
  const f = await fixture();
  assert.equal(f.run("youtubeVideoId('https://youtu.be/AbCdEf_12-3?si=ok')"), 'AbCdEf_12-3');
  for (const url of ['https://youtube.com/watch?v=AbCdEf_12-3&list=abc', 'https://evil.test/watch?v=AbCdEf_12-3', 'http://youtu.be/AbCdEf_12-3']) {
    assert.throws(() => f.run(`youtubeVideoId(${JSON.stringify(url)})`));
  }
});
test('whole-song selection sends the full source instead of a three-minute excerpt', async () => {
  const f = await fixture({ dependencies: { ready: true, youtube_ready: true, missing: [], youtube_missing: [] } });
  f.elements.get('youtube-input').value = 'https://www.youtube.com/watch?v=AbCdEf_12-3';
  f.elements.get('rights-confirmed').checked = true;
  f.run("selectSource('youtube'); selectRange('full')");
  await f.run('submitJob({preventDefault(){}})');
  const request = f.requests.find((item) => item.url === '/api/jobs');
  assert.equal(JSON.parse(request.options.body).duration_seconds, 'full');
  assert.equal(JSON.parse(request.options.body).start_seconds, 0);
});
test('media paths reject remote origins, traversal, other job IDs and queries', async () => {
  const f = await fixture(); assert.equal(f.run("mediaPath('/media/abc/drums.wav', 'abc')"), '/media/abc/drums.wav');
  for (const value of ['https://evil.example/drums.wav', '//evil.example/drums.wav', '/media/abc/../../secret', '/media/other/drums.wav', '/media/abc/drums.wav?url=bad']) assert.throws(() => f.run(`mediaPath(${JSON.stringify(value)}, 'abc')`));
});
test('active and failed jobs expose accurate actions instead of fake progress', async () => {
  const f = await fixture(); f.run("renderJob({id:'abc',status:'separating',message:'real stage'})");
  assert.equal(f.elements.get('create-job').disabled, true); assert.equal(f.elements.get('cancel-job').hidden, false); assert.equal(f.elements.get('delete-job').hidden, true); assert.equal(f.elements.get('job-message').textContent, 'real stage');
  f.run("renderJob({id:'abc',status:'failed',error:'failed fixture'})");
  assert.equal(f.elements.get('cancel-job').hidden, true); assert.equal(f.elements.get('delete-job').hidden, false); assert.equal(f.elements.get('job-error').textContent, 'failed fixture');
});
test('drummer mode mutes only original drums', async () => {
  const f = await fixture(); f.run("setMode('drummer')");
  assert.equal(f.elements.get('mute-drums').attrs['aria-pressed'], 'true');
  for (const stem of ['vocals', 'bass', 'other']) assert.equal(f.elements.get(`mute-${stem}`).attrs['aria-pressed'], 'false');
});
test('ready audio decodes four local stems and filters invalid onset hints', async () => {
  const f = await fixture(); await ready(f);
  assert.equal(f.run('audioLoaded'), true); assert.equal(f.audio.downloads, 4); assert.equal(f.run('onsets.length'), 2); assert.equal(f.elements.get('stem-downloads').children.length, 4);
});
test('four sources start at the same scheduled audio-context time', async () => {
  const f = await fixture(); await ready(f); await f.run('play()');
  assert.equal(f.audio.nodes.length, 4); assert(f.audio.nodes.every((node) => node.startArgs[0] === 0.04 && node.startArgs[1] === 0));
  f.audio.context.currentTime = 1.04; assert.equal(f.run('position()'), 1);
});
test('long audio schedules the next four chunks on the same clock and bounds cached buffers', async () => {
  const f = await fixture(); await ready(f, 61); await f.run('play()');
  const timer = f.timers.find((item) => item.milliseconds > 8000 && item.milliseconds < 8100);
  assert(timer); f.audio.context.currentTime = 8.1; await timer.callback();
  assert.equal(f.audio.nodes.length, 8);
  assert(f.audio.nodes.slice(4).every((node) => Math.abs(node.startArgs[0] - 20.04) < 0.001 && node.startArgs[1] === 0));
  await f.run('getChunk(2)'); await f.run('getChunk(3)');
  assert(f.run('chunkCache.size') <= 3);
});
test('a selected loop crosses a chunk boundary and returns to its chosen start', async () => {
  const f = await fixture(); await ready(f, 61);
  f.run("selectLoopMode('section'); setRepeatBounds(15, 23); offset = 15");
  await f.run('play()');
  assert(f.audio.nodes.slice(0, 4).every((node) => node.startArgs[1] === 15 && Math.abs(node.stopAt - 5.04) < 0.001));
  const first = f.timers.find((item) => item.milliseconds === 0); await first.callback();
  assert(f.audio.nodes.slice(4, 8).every((node) => Math.abs(node.startArgs[0] - 5.04) < 0.001 && node.startArgs[1] === 0 && Math.abs(node.stopAt - 8.04) < 0.001));
  const next = f.timers.filter((item) => item.milliseconds === 0).at(-1); await next.callback();
  assert(f.audio.nodes.slice(8, 12).every((node) => Math.abs(node.startArgs[0] - 8.04) < 0.001 && node.startArgs[1] === 15));
  f.audio.context.currentTime = 10.04; assert(Math.abs(f.run('position()') - 17) < 0.001);
});
test('pausing while a chunk loads cancels it and cannot start stale audio', async () => {
  const f = await fixture(); await ready(f, 61); await f.run('play()');
  const timer = f.timers.find((item) => item.milliseconds > 8000 && item.milliseconds < 8100);
  f.audio.context.currentTime = 8.1;
  f.context.fetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  const pending = timer.callback();
  f.run('pause(); abortChunkLoadsExcept()');
  await pending;
  assert.equal(f.run('playing'), false); assert.equal(f.audio.nodes.length, 4);
});
test('changing loop mode while a seek loads keeps playback requested', async () => {
  const f = await fixture(); await ready(f, 61); await f.run('play()');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  f.context.fetch = async (url) => {
    await gate;
    const index = Number(String(url).match(/\/chunks\/(\d+)\//)[1]);
    return { ok: true, arrayBuffer: async () => { const data = new ArrayBuffer(2); data.fakeDuration = Math.min(20, 61 - index * 20); return data; } };
  };
  const seek = f.elements.get('seek');
  seek.value = '41'; seek.listeners.input(); seek.listeners.change();
  await new Promise(setImmediate);
  f.run("selectLoopMode('section')");
  assert.equal(f.elements.get('play').attrs['aria-label'], '일시정지');
  release(); await new Promise(setImmediate);
  assert.equal(f.run('playing'), true);
  assert.equal(f.audio.nodes.length, 8);
  assert(f.audio.nodes.slice(4).every((node) => node.startArgs[1] === 1));
});
test('all six drum pads create sound voices and closed hat stops the open hat', async () => {
  const f = await fixture();
  for (const pad of ['kick', 'snare', 'tom', 'hat', 'open-hat', 'crash']) {
    const before = f.audio.started; await f.run(`hitPad(${JSON.stringify(pad)})`);
    assert(f.audio.started > before, `${pad} did not start an audio voice`);
  }
  await f.run("hitPad('open-hat')");
  const open = f.run('openHatVoice.node');
  await f.run("hitPad('hat')");
  assert.equal(f.run('openHatVoice'), null); assert(open.stopAt < 0.1);
});
test('pad volume changes the drum bus independently of the stem mixer', async () => {
  const f = await fixture();
  f.elements.get('pad-volume').value = '0.3'; f.elements.get('pad-volume').listeners.input();
  assert.equal(f.run('padMaster.gain.value'), 0.3);
  assert.equal(f.elements.get('pad-volume-value').textContent, '30%');
  assert.equal(f.run('volumes.vocals'), 0.8);
});
test('live mode gain changes and pause/resume preserve alignment', async () => {
  const f = await fixture(); await ready(f); await f.run('play()'); f.audio.context.currentTime = 1.04;
  f.run("setMode('drummer')"); assert.equal(f.run('gains.drums.gain.value'), 0); assert.equal(f.run('gains.vocals.gain.value'), 0.8);
  f.run('pause()'); assert.equal(f.run('offset'), 1); assert.equal(f.run('playing'), false);
  await f.run('play()'); assert(f.audio.nodes.slice(4).every((node) => node.startArgs[1] === 1));
});
test('repeat clock wraps and nonrepeat sources receive aligned stop times', async () => {
  const f = await fixture(); await ready(f); await f.run('play()'); f.audio.context.currentTime = 4.04; assert(Math.abs(f.run('position()') - 1) < 0.00001);
  f.run('pause(); offset = 2; $("loop").checked = false'); await f.run('play()');
  assert(f.audio.nodes.slice(4).every((node) => node.loop === false && Math.abs(node.stopAt - 5.08) < 0.00001));
});
test('reset removes source nodes, buffers and local download links', async () => {
  const f = await fixture(); await ready(f); await f.run('play()'); f.run('resetAudio()');
  assert.equal(f.run('nodes.length'), 0); assert.equal(f.run('audioLoaded'), false); assert.equal(f.elements.get('stem-downloads').children.length, 0); assert.equal(f.elements.get('play').disabled, true);
});
test('pause invalidates a pending audio resume to prevent stale playback', async () => {
  const f = await fixture(); await ready(f); let release;
  f.audio.context.resume = () => new Promise((resolve) => { release = resolve; });
  const pending = f.run('play()'); f.run('pause()'); release(); await pending;
  assert.equal(f.run('playing'), false); assert.equal(f.audio.nodes.length, 0);
});
test('the pause button cancels playback while audio is starting', async () => {
  const f = await fixture(); await ready(f); let release;
  f.audio.context.resume = () => new Promise((resolve) => { release = resolve; });
  const button = f.elements.get('play'), pending = button.listeners.click();
  assert.equal(button.attrs['aria-label'], '일시정지');
  await button.listeners.click(); release(); await pending;
  assert.equal(button.attrs['aria-label'], '재생'); assert.equal(f.audio.nodes.length, 0);
});
test('bfcache pageshow refreshes session and resumes active job polling', async () => {
  const f = await fixture(); f.session.job = { id: 'abc', status: 'separating', message: 'fixture' }; f.run("renderJob({id:'abc',status:'separating'})");
  f.windowListeners.pagehide(); const before = f.requests.length;
  await f.windowListeners.pageshow({ persisted: true });
  assert.equal(f.requests.length, before + 1); assert.equal(f.run('job.id'), 'abc'); assert(f.timers.some((timer) => timer.milliseconds === 600));
});
test('bfcache pageshow clears a job deleted in another local tab', async () => {
  const f = await fixture(); await ready(f); f.windowListeners.pagehide(); f.session.job = null;
  await f.windowListeners.pageshow({ persisted: true });
  assert.equal(f.run('job'), null); assert.equal(f.run('audioLoaded'), false); assert.equal(f.elements.get('player-section').hidden, true);
});

test('turning repeat off after a full loop preserves the audible position', async () => {
  const f = await fixture(); await ready(f); await f.run('play()'); f.audio.context.currentTime = 4.04;
  f.elements.get('loop').checked = false;
  f.run('pause()'); assert(Math.abs(f.run('offset') - 1) < 0.00001);
  await f.run('play()'); assert(f.audio.nodes.slice(4).every((node) => node.loop === false && Math.abs(node.startArgs[1] - 1) < 0.00001));
});

async function lanesReady(f, notes, duration = 10) {
  f.audio.duration = duration;
  f.run(`audioChoice = 'job'; job = {id: 'lanes', status: 'ready', duration: ${duration}, chunk_seconds: 20, onsets: [1, 2], notes: ${JSON.stringify(notes)}, stems: Object.fromEntries(STEMS.map(stem => [stem, \`/media/lanes/\${stem}.wav\`]))}`);
  await f.run('loadAudio(job)');
}
// The mock device has no output delay, so this is the song time the player hears.
function hear(f, songTime) {
  f.audio.context.currentTime = f.run('startedAt') + (songTime - f.run('offset')) / f.run('rate');
  f.run('tick()');
}
const KIT = { kick: [1, 2, 3, 4], snare: [1.5, 2.5], cymbal: [] };

test('drum lanes load from the job and older results fall back to one timing lane', async () => {
  const f = await fixture(); await lanesReady(f, { kick: [1, 3], snare: [2, NaN, 99], cymbal: [] });
  assert.equal(f.run('notes.kick.length'), 2); assert.equal(f.run('notes.snare.length'), 1);
  assert.equal(f.elements.get('onset-count').textContent, '킥 2 · 스네어 1 · 심벌 0');
  assert.deepEqual([...f.run('visibleLanes()')], ['cymbal', 'snare', 'kick']);
  const old = await fixture(); await ready(old);
  assert.deepEqual([...old.run('visibleLanes()')], ['any']); assert.equal(old.run('notes.any.length'), 2);
  assert(old.groups['[data-lanes]'].every((button) => button.disabled));
});
test('hits are graded on the matching lane, misses are counted and timing tendency is reported', async () => {
  const f = await fixture(); await lanesReady(f, KIT); await f.run('play()');
  hear(f, 1.01); await f.run("hitPad('kick')");
  hear(f, 1.52); await f.run("hitPad('tom')");
  hear(f, 2.07); await f.run("hitPad('kick')");
  hear(f, 2.5); await f.run("hitPad('hat')");
  hear(f, 2.7);
  assert.deepEqual([f.run('pass.perfect'), f.run('pass.good'), f.run('pass.miss')], [2, 1, 1]);
  assert.equal(f.elements.get('score-accuracy').textContent, '65%');
  assert.equal(f.run('pass.combo'), 0); assert.equal(f.run('pass.maxCombo'), 3);
  assert.deepEqual([...f.run('pass.offsets')].map((value) => Math.round(value * 1000)), [10, 20, 70]);
  assert.equal(f.run('pass.hits.length'), 4);
  assert(f.elements.get('score-tendency').textContent.includes('33ms 늦게'));
});
test('timing-only scoring accepts any pad and the kick lane filter ignores other notes', async () => {
  const f = await fixture(); await lanesReady(f, KIT);
  f.groups['[data-judge]'][1].listeners.click(); f.groups['[data-lanes]'][0].listeners.click();
  assert.equal(f.run('judgeMode'), 'timing'); assert.deepEqual([...f.run('visibleLanes()')], ['kick']);
  await f.run('play()');
  hear(f, 1); await f.run("hitPad('crash')");
  hear(f, 2); hear(f, 2.7);
  assert.equal(f.run('pass.perfect'), 1); assert.equal(f.run('pass.miss'), 1);
  f.groups['[data-judge]'][2].listeners.click(); hear(f, 3.5);
  assert.equal(f.run('pass.miss'), 0); assert(f.elements.get('score-tendency').textContent.includes('꺼져'));
});
test('calibrated input delay moves the judging clock', async () => {
  const f = await fixture(); await lanesReady(f, KIT);
  f.elements.get('latency').value = '50'; f.elements.get('latency').listeners.input();
  assert.equal(f.elements.get('latency-value').textContent, '+50ms');
  await f.run('play()'); hear(f, 1.06); await f.run("hitPad('kick')");
  assert.equal(f.run('pass.perfect'), 1); assert.equal(Math.round(f.run('pass.offsets[0]') * 1000), 10);
});
test('a looped section scores each repeat and carries an early downbeat into the next one', async () => {
  const f = await fixture(); await lanesReady(f, { kick: [2, 2.5, 3, 3.5], snare: [], cymbal: [] });
  f.run("selectLoopMode('section'); setRepeatBounds(2, 4); offset = 2"); await f.run('play()');
  for (const t of [2, 2.5, 3, 3.5, 3.97]) { hear(f, t); await f.run("hitPad('kick')"); }
  f.audio.context.currentTime = f.run('startedAt') + 2.02; f.run('tick()');
  assert.equal(f.run('passHistory.length'), 1); assert.equal(f.run('passHistory[0].accuracy'), 100);
  assert.equal(f.run('pass.start'), 2); assert.equal(f.run('pass.perfect'), 1); assert.equal(f.run('pass.judged.kick.has(0)'), true);
  assert.equal(f.run('lastTake.hits.length'), 5); assert.equal(f.run('lastTake.end'), 4);
  assert.equal(f.elements.get('pass-history').children[0].textContent, '1회 100%');
});
test('slow practice scales the shared audio clock and every source', async () => {
  const f = await fixture(); await ready(f, 61);
  f.groups['[data-rate]'][3].listeners.click(); assert.equal(f.run('rate'), 0.5);
  await f.run('play()');
  assert(f.audio.nodes.every((node) => node.playbackRate.value === 0.5 && Math.abs(node.stopAt - 40.04) < 0.001));
  f.audio.context.currentTime = 1.04; assert(Math.abs(f.run('position()') - 0.5) < 1e-9);
  const timer = f.timers.find((item) => item.milliseconds > 28000 && item.milliseconds < 28100);
  assert(timer); f.audio.context.currentTime = 28.1; await timer.callback();
  assert(f.audio.nodes.slice(4).every((node) => Math.abs(node.startArgs[0] - 40.04) < 0.001));
});
test('replay plays recorded hits at their song times with the original drums muted, then stops', async () => {
  const f = await fixture(); await lanesReady(f, KIT); await f.run('play()');
  hear(f, 1); await f.run("hitPad('kick')"); hear(f, 1.5); await f.run("hitPad('snare')"); hear(f, 2);
  await f.run('togglePlay()');
  assert.equal(f.elements.get('replay-take').disabled, false);
  const before = f.audio.nodes.length;
  await f.run('toggleReplay()');
  assert.equal(f.run('muted.drums'), true); assert.equal(f.run('playbackLoop'), false);
  assert.equal(f.run('lastTake.start'), 0); assert(Math.abs(f.run('playbackEnd') - 2.6) < 1e-9);
  const start = f.run('startedAt'), voices = f.audio.nodes.slice(before + 4);
  assert.deepEqual(voices.map((voice) => Math.round((voice.startArgs[0] - start) * 1000)), [1000, 1500]);
  f.run('pause()'); assert(voices.every((voice) => 'stopAt' in voice), 'pausing must cancel scheduled replay hits');
  await f.run('play()'); assert.equal(f.run('replay') !== null, true);
  f.audio.nodes.at(-3).onended();
  assert.equal(f.run('replay'), null); assert.equal(f.run('playing'), false);
  assert.equal(f.elements.get('audio-status').textContent, '내 연주 다시 듣기가 끝났어요.');
});
test('guide mode keeps the original drums quietly underneath', async () => {
  const f = await fixture(); await ready(f); await f.run('play()');
  f.run("setMode('guide')");
  assert(Math.abs(f.run('gains.drums.gain.value') - 0.24) < 1e-9); assert.equal(f.run('gains.vocals.gain.value'), 0.8);
});
test('MIDI note-ons from an electronic kit play pads; note-offs are ignored', async () => {
  const input = { name: 'TD-17', state: 'connected', onmidimessage: null };
  const access = { inputs: new Map([['1', input]]), onstatechange: null };
  const f = await fixture({}, { navigator: { requestMIDIAccess: async () => access } });
  await f.run('connectMidi()');
  assert(f.elements.get('midi-status').textContent.includes('TD-17'));
  const before = f.audio.started;
  await input.onmidimessage({ data: [0x99, 36, 127], timeStamp: 1000 });
  assert.equal(f.audio.started, before + 1);
  await input.onmidimessage({ data: [0x89, 36, 0], timeStamp: 1000 }); await input.onmidimessage({ data: [0x99, 38, 0], timeStamp: 1000 });
  assert.equal(f.audio.started, before + 1);
  assert(Math.abs(f.run('velocityGain(127)') - 1.3) < 1e-9); assert.equal(f.run('velocityGain(100)'), 1);
  const none = await fixture(); await none.run('connectMidi()');
  assert(none.elements.get('midi-status').textContent.includes('지원하지 않아요'));
});
test('sound calibration sets the input delay from the median tap offset', async () => {
  const f = await fixture(); await f.run('startCalibration()');
  const clicks = [...f.run('calibration.clicks')];
  assert.equal(clicks.length, 12);
  for (const [index, late] of [[0, 0.3], [2, 0.03], [3, 0.04], [4, 0.04], [5, 0.05], [6, 0.04], [7, 0.28]]) {
    f.audio.context.currentTime = clicks[index] + late; await f.run("hitPad('snare')");
  }
  assert.equal(f.run('calibration.offsets.length'), 5);
  f.run('finishCalibration()');
  assert.equal(f.run('latencyMs'), 40); assert.equal(f.elements.get('latency-value').textContent, '+40ms');
  assert(f.elements.get('calibration-status').textContent.includes('+40ms'));
});
test('Space plays and pauses unless a text field has focus', async () => {
  const f = await fixture(); await ready(f);
  const press = (target) => f.documentListeners.keydown({ code: 'Space', target, repeat: false, preventDefault() {} });
  await press(f.context.document.body); await new Promise(setImmediate);
  assert.equal(f.run('playing'), true);
  press({ closest: (query) => (query.startsWith('input') ? {} : null) });
  assert.equal(f.run('playing'), true);
  await press(f.context.document.body); assert.equal(f.run('playing'), false);
});
test('stopping just after a loop restarts keeps the last full repeat on the board and for replay', async () => {
  const f = await fixture(); await lanesReady(f, { kick: [2, 2.5, 3, 3.5], snare: [], cymbal: [] });
  f.run("selectLoopMode('section'); setRepeatBounds(2, 4); offset = 2"); await f.run('play()');
  for (const t of [2, 2.5, 3, 3.5]) { hear(f, t); await f.run("hitPad('kick')"); }
  f.audio.context.currentTime = f.run('startedAt') + 2.1; f.run('tick()'); await f.run("hitPad('kick')");
  await f.run('togglePlay()');
  assert.equal(f.elements.get('score-accuracy').textContent, '100%');
  assert.equal(f.run('lastTake.hits.length'), 4); assert.equal(f.run('lastTake.start'), 2);
});
