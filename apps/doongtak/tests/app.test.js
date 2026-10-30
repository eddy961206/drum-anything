import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as rhythm from '../dist/rhythm.js';

class Element {
  constructor(tagName = 'DIV') {
    this.tagName = tagName; this.listeners = {}; this.attributes = {}; this.style = {};
    this.children = []; this.hidden = false; this.open = false; this.disabled = false;
    this.textContent = ''; this.value = 0; this.checked = false; this.clientWidth = 800;
    this.classes = new Set();
    this.classList = { add: (...c) => c.forEach(x => this.classes.add(x)), remove: (...c) => c.forEach(x => this.classes.delete(x)), contains: c => this.classes.has(c), toggle: (c, value) => { const add = value ?? !this.classes.has(c); add ? this.classes.add(c) : this.classes.delete(c); return add; } };
  }
  set className(value) { this.classes = new Set(value.split(' ').filter(Boolean)); }
  get className() { return [...this.classes].join(' '); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  dispatch(name, event = {}) { for (const fn of this.listeners[name] || []) fn({ target: this, preventDefault() {}, ...event }); }
  append(...children) { this.children.push(...children); children.forEach(c => c.parentElement = this); }
  insertBefore(child) { this.append(child); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  getBoundingClientRect() { return { left: 10, right: 400, top: 10, bottom: 500 }; }
}
function harness() {
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  get('seconds').parentElement = new Element(); get('seconds').parentElement.parentElement = new Element();
  const document = new Element(); document.body = new Element('BODY'); document.hidden = false;
  document.getElementById = get; document.createElement = tag => new Element(tag.toUpperCase()); document.querySelector = get;
  const window = new Element();
  let nextId = 1; const intervals = new Map(), frames = new Map(), timeouts = new Map();
  class FakeAudio {
    constructor() { this.currentTime = 0; this.state = 'closed'; this.muted = false; this.volume = .65; this.scheduled = []; this.hits = []; this.stopCount = 0; this.context = new Element(); }
    async unlock() { this.state = 'running'; return this.context; }
    setVolume(value) { this.volume = value; }
    setMuted(value) { this.muted = value; }
    scheduleBacking(...args) { this.scheduled.push(args); }
    kick(...args) { this.hits.push(['kick', ...args]); }
    snare(...args) { this.hits.push(['snare', ...args]); }
    stopAll() { this.stopCount++; }
    async suspend() { this.state = 'suspended'; }
  }
  const context = vm.createContext({ ...rhythm, DrumAudio: FakeAudio, document, window, performance: { now: () => 5000 },
    setInterval: f => { const id = nextId++; intervals.set(id, f); return id; }, clearInterval: id => intervals.delete(id),
    requestAnimationFrame: f => { const id = nextId++; frames.set(id, f); return id; }, cancelAnimationFrame: id => frames.delete(id),
    setTimeout: f => { const id = nextId++; timeouts.set(id, f); return id; }, clearTimeout: id => timeouts.delete(id),
  });
  const source = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8').replace(/^import .+;\n/gm, '');
  vm.runInContext(source + '\nglobalThis.api = { state, audio, start, pause, resetRound, hit, schedule, animate, finish, nextPhrase, changeFeeling, setMode, heldKeys };', context);
  return { ...context.api, get, document, window, intervals, frames, timeouts };
}

test('transport has exactly one scheduler; pause/resume/restart cleanly own playback', async () => {
  const h = harness(); assert.equal(h.state.phase, 'ready');
  await h.start(); assert.equal(h.state.phase, 'playing'); assert.equal(h.intervals.size, 1);
  await h.start(); assert.equal(h.intervals.size, 1);
  h.audio.currentTime = h.state.origin + 1.2; h.pause();
  assert.equal(h.state.phase, 'paused'); assert.ok(Math.abs(h.state.position - 1.2) < 1e-9);
  assert.equal(h.intervals.size, 0); assert.equal(h.frames.size, 0);
  await h.start(); assert.equal(h.intervals.size, 1); assert.ok(Math.abs((h.audio.currentTime + .12 - h.state.origin) - 1.2) < 1e-9);
  h.resetRound(); assert.equal(h.state.phase, 'ready'); assert.equal(h.state.position, 0); assert.equal(h.intervals.size, 0); assert.equal(h.frames.size, 0);
});
test('manual adjustments wait for next phrase, while just-right locks auto changes', async () => {
  const h = harness(); await h.start(); const before = h.state.phrases.get(0).level;
  h.changeFeeling(1); assert.equal(h.state.adaptation.level, before); assert.equal(h.state.pending, 1);
  h.nextPhrase(1); assert.equal(h.state.adaptation.level, before + 1); assert.equal(h.state.phrases.get(0).level, before);
  h.get('just-right').dispatch('click'); assert.equal(h.state.adaptation.locked, true); assert.equal(h.state.pending, 0);
});
test('tapping is audible in preview and matched once only during a guided round', async () => {
  const h = harness(); await h.hit('kick'); assert.equal(h.audio.hits.length, 1); assert.equal(h.state.phase, 'ready');
  await h.start(); h.audio.currentTime = h.state.origin;
  await h.hit('kick'); await h.hit('kick'); const p = h.state.phrases.get(0);
  assert.equal(p.matched, 1); assert.equal(p.attempts, 2); assert.equal(h.audio.hits.length, 3);
});
test('held keys and autorepeat cannot retrigger drums', async () => {
  const h = harness(); const ev = { target: h.document.body, code: 'KeyF', repeat: false };
  h.document.dispatch('keydown', ev); h.document.dispatch('keydown', ev); h.document.dispatch('keydown', { ...ev, repeat: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.audio.hits.length, 1);
  h.document.dispatch('keyup', ev); h.document.dispatch('keydown', ev);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(h.audio.hits.length, 2);
});
test('free mode disables assessment controls without interrupting the music', async () => {
  const h = harness(); await h.start(); h.setMode('free');
  assert.equal(h.state.phase, 'playing'); assert.equal(h.get('just-right').disabled, true);
  await h.hit('snare'); assert.equal(h.state.phrases.get(0).attempts, 0);
  h.setMode('guided'); assert.equal(h.get('just-right').disabled, false);
});
test('settings, hidden tabs and 60-second completion clean up scheduled playback', async () => {
  const h = harness(); await h.start(); h.get('settings-open').dispatch('click');
  assert.equal(h.state.phase, 'paused'); assert.equal(h.get('settings-dialog').open, true); assert.equal(h.intervals.size, 0);
  h.get('settings-done').dispatch('click'); await h.start();
  h.document.hidden = true; h.document.dispatch('visibilitychange');
  assert.equal(h.state.phase, 'paused'); assert.equal(h.intervals.size, 0); assert.equal(h.audio.state, 'suspended');
  h.document.hidden = false; await h.start(); h.audio.currentTime = h.state.origin + 60; h.schedule();
  assert.equal(h.state.phase, 'done'); assert.equal(h.get('seconds').textContent, '0'); assert.equal(h.intervals.size, 0); assert.equal(h.frames.size, 0);
});
