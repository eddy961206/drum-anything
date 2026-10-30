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

async function fixture(overrides = {}) {
  const elements = new Map();
  class Element {
    constructor(id) { this.id = id; this.hidden = false; this.disabled = false; this.value = ''; this.checked = false; this.dataset = {}; this.children = []; this.attrs = {}; this.listeners = {}; this.files = []; this.classList = { toggle() {}, add() {}, remove() {} }; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    setAttribute(name, value) { this.attrs[name] = value; }
    append(...children) { for (const item of children) { this.children.push(item); if (item.id) elements.set(item.id, item); } }
    replaceChildren() { this.children = []; }
    getContext() { return null; }
    closest() { return null; }
    focus() {}
  }
  for (const id of ids) elements.set(id, new Element(id));
  elements.get('loop').checked = true;
  elements.get('excerpt-start').value = '0';
  elements.get('excerpt-duration').value = '60';
  const group = (key, values) => values.map((value) => { const element = new Element(); element.dataset[key] = value; return element; });
  const groups = { '[data-source]': group('source', ['file', 'youtube']), '[data-mode]': group('mode', ['all', 'vocals', 'instrumental', 'drummer']), '[data-stage]': group('stage', ['acquiring', 'normalizing', 'separating', 'analyzing', 'ready']) };
  const param = () => ({ value: 0, setValueAtTime(value) { this.value = value; }, setTargetAtTime(value) { this.value = value; }, exponentialRampToValueAtTime() {} });
  const node = () => ({ connect() {}, disconnect() {}, gain: param() });
  const audio = { context: null, nodes: [], downloads: 0 };
  class AudioContext {
    constructor() { this.currentTime = 0; this.destination = {}; this.sampleRate = 44100; audio.context = this; }
    createGain() { return node(); }
    createDynamicsCompressor() { return { ...node(), threshold: param(), knee: param(), ratio: param() }; }
    createBufferSource() { const source = { ...node(), start(at, offset) { this.startArgs = [at, offset]; }, stop(at) { this.stopAt = at; }, loop: false }; audio.nodes.push(source); return source; }
    resume() { return Promise.resolve(); }
    decodeAudioData() { return Promise.resolve({ duration: 3 }); }
  }
  const session = { csrf: 'ephemeral-test-token', dependencies: { ready: true, youtube_ready: false, missing: [], youtube_missing: ['Deno'] }, limits: { max_upload_bytes: 104857600, max_source_seconds: 900, max_excerpt_seconds: 180 }, job: null, ...overrides };
  const windowListeners = {}, requests = [], timers = [];
  const context = { console, URL, URLSearchParams, Headers, AbortController,
    setTimeout(callback, milliseconds) { timers.push({ callback, milliseconds }); return timers.length; }, clearTimeout() {}, requestAnimationFrame() {},
    fetch: async (url, options) => { requests.push({ url, options }); if (url === '/api/session') return { ok: true, json: async () => session }; audio.downloads += 1; return { ok: true, arrayBuffer: async () => new ArrayBuffer(2) }; },
    document: { getElementById: (id) => elements.get(id), querySelectorAll: (query) => groups[query] || [], createElement: () => new Element(), addEventListener() {}, activeElement: null },
    window: { AudioContext, addEventListener(name, callback) { windowListeners[name] = callback; }, devicePixelRatio: 1, confirm: () => true },
    location: { origin: 'http://127.0.0.1:8765' } };
  vm.createContext(context); vm.runInContext(js, context); await new Promise(setImmediate);
  return { elements, context, audio, session, requests, timers, windowListeners, run: (code) => vm.runInContext(code, context) };
}
async function ready(f) {
  f.run("job = {id: 'fixture', status: 'ready', onsets: [0.1, NaN, -1, 1.1], stems: Object.fromEntries(STEMS.map(stem => [stem, `/media/fixture/${stem}.wav`]))}");
  await f.run('loadAudio(job)');
}

test('every fixed JS element reference exists and HTML IDs are unique', () => {
  assert.equal(new Set(ids).size, ids.length);
  for (const [, id] of js.matchAll(/\$\('([^']+)'\)/g)) assert(ids.includes(id), `Missing element: ${id}`);
});
test('UI scripts use no absolute remote URL or third-party assets', () => {
  assert(!/https?:\/\/[^\s'"]+/.test(js));
  assert(!/<(?:script|link)[^>]+(?:src|href)="https?:/.test(html));
});
test('static input defaults agree with backend bounds and supported types', () => {
  assert(html.includes('max="899"')); assert(!html.includes('.wma')); assert(html.includes('.webm'));
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
test('time formatting and excerpt numeric validation', async () => {
  const f = await fixture(); assert.equal(f.run('formatTime(125)'), '2:05');
  assert.equal(f.run("checkNumber(180, 1, 180, 'duration')"), 180);
  assert.throws(() => f.run("checkNumber(NaN, 1, 180, 'duration')")); assert.throws(() => f.run("checkNumber(181, 1, 180, 'duration')")); assert.throws(() => f.run("checkNumber(-1, 0, 899, 'start')"));
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
