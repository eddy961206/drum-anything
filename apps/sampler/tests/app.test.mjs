import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = name => readFileSync(new URL(`../dist/${name}`, import.meta.url), 'utf8');
const html = read('index.html');
const css = read('styles.css');
const tags = (tag, source = html) => [...source.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'g'))].map(match => match[1]);
const attr = (tag, key) => new RegExp(`(?:^|\\s)${key}="([^"]*)"`).exec(tag)?.[1];
const ids = tags('[a-z][a-z0-9-]*').map(tag => attr(tag, 'id')).filter(Boolean);

// These are DOM/source contracts, not a claim of rendered browser verification.
test('document has Korean language, viewport and local ES module entrypoint', () => {
  assert.match(html, /<html lang="ko">/);
  assert.match(html, /name="viewport" content="width=device-width,initial-scale=1"/);
  assert.match(html, /<script type="module" src="app\.mjs"><\/script>/);
  assert.equal(new Set(ids).size, ids.length, 'DOM IDs must be unique');
  for (const tag of [...tags('script'), ...tags('link')]) {
    const path = attr(tag, 'src') ?? attr(tag, 'href');
    if (!path) continue;
    assert.ok(!/^(https?:)?\/\//.test(path), 'No remote dependency or font');
    assert.ok(existsSync(fileURLToPath(new URL(`../dist/${path}`, import.meta.url))), `${path} exists`);
  }
});

test('four accessible pads and separate edit buttons expose expected keyboard shortcuts', () => {
  const padTags = tags('button').filter(tag => attr(tag, 'data-pad') !== undefined);
  assert.equal(padTags.length, 4);
  assert.deepEqual(padTags.map(tag => attr(tag, 'data-pad')), ['0', '1', '2', '3']);
  padTags.forEach((tag, index) => assert.match(attr(tag, 'aria-label'), new RegExp(['A', 'S', 'D', 'F'][index])));
  assert.equal(tags('button').filter(tag => attr(tag, 'data-edit') !== undefined).length, 4);
  assert.ok(!/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*<button\b/.test(html), 'Buttons are not nested');
});

test('editor exposes explicit recording, file fallback, trimming and per-sample WAV export', () => {
  for (const id of ['record', 'import', 'file', 'trim-start', 'trim-end', 'preview', 'export', 'reset-sample']) {
    assert.ok(ids.includes(id), `Required editor control ${id}`);
  }
  const file = tags('input').find(tag => attr(tag, 'id') === 'file');
  assert.equal(attr(file, 'type'), 'file');
  assert.match(attr(file, 'accept'), /audio\/\*/);
  assert.match(html, /녹음 버튼을 눌러야 마이크 권한을 요청/);
  assert.match(html, /8MB.*12초/);
  assert.match(html, /WAV 저장/);
  assert.match(html, /이 패드 기본 소리로/);
});

test('transport, pattern clearing and sample reset are separate controls', () => {
  for (const id of ['transport', 'clear-pattern', 'demo-pattern', 'sequence']) assert.ok(ids.includes(id));
  const tempo = tags('input').find(tag => attr(tag, 'id') === 'bpm');
  assert.equal(attr(tempo, 'min'), '50');
  assert.equal(attr(tempo, 'max'), '180');
  assert.equal(attr(tempo, 'value'), '104');
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /16칸 비트 편집/);
});

test('privacy and transient-memory limitations are visible, not only in README', () => {
  assert.match(html, /업로드하지 않아요/);
  assert.match(html, /이 탭의 메모리에만/);
  assert.match(html, /새로고침하거나 닫으면 사라져요/);
  assert.match(html, /간직할 소리는 WAV로 저장/);
  assert.match(html, /직접 만든 합성음/);
});

test('responsive, keyboard focus and reduced-motion styling are included', () => {
  assert.match(css, /@media\(max-width:760px\)/);
  assert.match(css, /grid-template-columns:repeat\(2,1fr\)/);
  assert.match(css, /overflow-x:auto/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.match(css, /touch-action:manipulation/);
});

test('application modules contain no network or persistent-storage operation', () => {
  const source = ['app.mjs', 'audio.mjs', 'core.mjs'].map(read).join('\n');
  assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/);
  assert.doesNotMatch(source, /\b(?:localStorage|sessionStorage|indexedDB)\b/);
  assert.doesNotMatch(source, /document\.cookie\s*=/);
  assert.doesNotMatch(source, /navigator\.sendBeacon\s*\(/);
});

test('app lifecycle guards include repeat suppression, hidden-page cleanup and replacement confirmation', () => {
  const source = read('app.mjs');
  assert.match(source, /event\.repeat/);
  assert.match(source, /event\.target\.isContentEditable/);
  assert.match(source, /MAX_FILE_BYTES\s*=\s*8\s*\*\s*1024\s*\*\s*1024/);
  assert.match(source, /MAX_FILE_SECONDS\s*=\s*12/);
  assert.match(source, /addEventListener\('visibilitychange'/);
  assert.match(source, /addEventListener\('pagehide'/);
  assert.match(source, /addEventListener\('beforeunload'/);
  assert.match(source, /window\.confirm\(/);
  assert.match(source, /mic\.cancel\(/);
  assert.equal((source.match(/mic\.start\(/g) || []).length, 1, 'Only one explicit microphone-start call site');
  const recordHandler = source.slice(source.indexOf("$('record').addEventListener('click'"), source.indexOf("$('import').addEventListener('click'"));
  assert.match(recordHandler, /mic\.start\(/, 'Mic starts only in record-button handler');
});

import vm from 'node:vm';

function mountApp() {
  const registry = new Map(), documentEvents = new Map(), windowEvents = new Map();
  class Node {
    constructor(id = '') {
      this.id = id; this.dataset = {}; this.events = new Map(); this.attributes = new Map(); this.children = [];
      this.style = { setProperty() {} }; this.value = ''; this.files = []; this.tagName = 'BUTTON'; this.isContentEditable = false;
      const classes = new Set(); this.classList = { add: x => classes.add(x), remove: x => classes.delete(x), toggle: (x, force) => force ? classes.add(x) : classes.delete(x) };
    }
    addEventListener(type, fn) { this.events.set(type, fn); }
    async emit(type, event = {}) { await this.events.get(type)?.({target: this, preventDefault() {}, detail: 0, ...event}); }
    setAttribute(k, v) { this.attributes.set(k, v); }
    getAttribute(k) { return this.attributes.get(k); }
    append(...nodes) { nodes.forEach(node => { this.children.push(node); if (node.id) registry.set(node.id, node); }); }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    closest() { return this.card ?? this; }
    focus() {} scrollIntoView() {} getContext() { return null; } click() {} remove() {}
  }
  ids.forEach(id => registry.set(id, new Node(id)));
  registry.get('bpm').value = '104';
  const pads = Array.from({length: 4}, (_, i) => { const n = new Node(); n.dataset.pad = String(i); n.card = new Node(); return n; });
  const edits = Array.from({length: 4}, (_, i) => { const n = new Node(); n.dataset.edit = String(i); return n; });
  const document = {
    hidden: false, body: new Node(), getElementById: id => registry.get(id),
    createElement: () => new Node(), createTextNode: text => ({textContent: text}),
    querySelectorAll: selector => selector === '[data-pad]' ? pads : selector === '[data-edit]' ? edits : [],
    querySelector: selector => pads[Number(/data-pad="(\d)"/.exec(selector)?.[1] ?? 0)],
    addEventListener: (name, fn) => documentEvents.set(name, fn)
  };
  let engine, mic, sequence;
  class AudioEngine {
    constructor() { engine = this; this.samples = []; this.hits = []; this.stops = 0; this.readyCalls = 0; }
    async ready() { this.readyCalls++; if (!this.samples.length) this.samples = Array.from({length:4}, () => ({custom:false,start:0,end:1,buffer:{duration:1,getChannelData:()=>new Float32Array(10)}})); }
    play(index) { this.hits.push(index); }
    stopAll() { this.stops++; }
  }
  class MicController {
    constructor(options) { mic = this; this.options = options; this.state = 'idle'; this.starts = 0; this.cancels = 0; }
    async start() { this.starts++; this.state = 'requesting'; this.options.onState(this.state); }
    stop() { this.state = 'idle'; }
    cancel() { this.cancels++; this.state = 'idle'; this.options.onState(this.state); }
  }
  class Sequencer {
    constructor(audio, options) { sequence = this; this.options = options; this.starts = 0; }
    stop() { this.options.onStop(); }
    start() { this.starts++; }
    setBpm(value) { this.bpm = value; }
  }
  const context = {navigator:{mediaDevices:{getUserMedia(){}}}, MediaRecorder:class {}, document, window:{confirm:()=>true,addEventListener:(name,fn)=>windowEvents.set(name,fn)}, AudioEngine, MicController, Sequencer, setTimeout:()=>1, clearTimeout(){}, URL, console, Blob};
  vm.runInNewContext(read('app.mjs').replace(/^import .*;\n/gm, ''), context);
  return {registry,document,documentEvents,windowEvents,pads,edits,engine,mic,sequence,window:context.window};
}

test('mock DOM initializes 64 steps without activating audio or microphone', () => {
  const app = mountApp();
  assert.equal([...app.registry.keys()].filter(id => id.startsWith('step-')).length, 64);
  assert.equal(app.engine.readyCalls, 0);
  assert.equal(app.mic.starts, 0);
});

test('mock DOM pad/keyboard play and pattern-clear preserve samples', async () => {
  const app = mountApp();
  await app.pads[2].emit('pointerdown', {pointerType:'touch'});
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(app.engine.hits, [2]);
  await app.documentEvents.get('keydown')({repeat:true,code:'KeyA',target:{tagName:'BODY'},preventDefault(){}});
  assert.deepEqual(app.engine.hits, [2]);
  app.engine.samples[0].custom = true;
  await app.registry.get('clear-pattern').emit('click');
  assert.equal(app.engine.samples[0].custom, true);
  assert.equal(app.registry.get('step-0-0').getAttribute('aria-pressed'), 'false');
});

test('mock DOM recording requires explicit click and hidden-page event cancels capture', async () => {
  const app = mountApp();
  await app.registry.get('record').emit('click');
  assert.equal(app.mic.starts, 1);
  app.document.hidden = true;
  app.documentEvents.get('visibilitychange')();
  assert.equal(app.mic.state, 'idle');
  assert.ok(app.mic.cancels >= 2);
  assert.ok(app.engine.stops >= 2);
});


test('mock DOM oversized import is rejected before audio decoding or replacement', async () => {
  const app = mountApp();
  await app.registry.get('import').emit('click');
  app.registry.get('file').files = [{size: 8 * 1024 * 1024 + 1}];
  await app.registry.get('file').emit('change');
  assert.equal(app.engine.readyCalls, 1, 'Audio is unlocked from explicit import gesture only');
  assert.equal(app.engine.samples.some(sample => sample.custom), false);
  assert.match(app.registry.get('status').textContent, /8MB/);
});

test('mock DOM rejected replacement confirmation never starts a microphone', async () => {
  const app = mountApp();
  await app.engine.ready();
  app.engine.samples[0].custom = true;
  app.window.confirm = () => false;
  await app.registry.get('record').emit('click');
  assert.equal(app.mic.starts, 0);
  assert.equal(app.engine.samples[0].custom, true);
});

test('mock DOM beforeunload requests warning for user sounds and stops capture', async () => {
  const app = mountApp();
  await app.engine.ready();
  app.engine.samples[0].custom = true;
  let prevented = false;
  const event = {preventDefault() { prevented = true; }};
  app.windowEvents.get('beforeunload')(event);
  assert.equal(prevented, true);
  assert.equal(event.returnValue, '');
  assert.equal(app.mic.state, 'idle');
});


test('mock DOM rejects a stale file chooser after switching pads', async () => {
  const app = mountApp();
  await app.registry.get('import').emit('click');
  await app.edits[1].emit('click');
  app.registry.get('file').files = [{size: 512, name: 'sound.wav'}];
  await app.registry.get('file').emit('change');
  assert.match(app.registry.get('status').textContent, /선택한 패드가 바뀌어/);
  assert.equal(app.engine.samples[1].custom, false);
});

test('mock DOM held Enter on focused pad suppresses native repeat activation', async () => {
  const app = mountApp();
  let prevented = false;
  await app.pads[0].emit('keydown', {repeat:true, key:'Enter', preventDefault(){prevented=true;}});
  assert.equal(prevented, true);
  assert.equal(app.engine.hits.length, 0);
});
