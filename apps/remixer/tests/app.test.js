import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as timing from '../dist/timing.js';
import {parseYouTubeUrl} from '../dist/youtube.js';

class Element {
  constructor(tagName = 'DIV') {
    this.tagName = tagName; this.listeners = {}; this.attributes = {}; this.hidden = false; this.disabled = false;
    this.value = ''; this.textContent = ''; this.clientWidth = 500; this.clientHeight = 66;
    this.style = { setProperty() {} }; this.classes = new Set();
    this.classList = { add: (...names) => names.forEach(n => this.classes.add(n)), remove: (...names) => names.forEach(n => this.classes.delete(n)), contains: n => this.classes.has(n), toggle: (n, set) => { const on = set ?? !this.classes.has(n); on ? this.classes.add(n) : this.classes.delete(n); return on; } };
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  dispatch(name, event = {}) { for (const callback of this.listeners[name] || []) callback({ target: this, button: 0, detail: 0, preventDefault() {}, ...event }); }
  focus() {} setPointerCapture() {} click() { this.dispatch('click'); }
  getContext() { return { setTransform() {}, clearRect() {}, fillRect() {}, beginPath() {}, arc() {}, fill() {} }; }
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const elements = new Map(); const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const document = new Element(); document.body = new Element('BODY'); document.hidden = false; document.getElementById = get;
  const window = new Element(); window.devicePixelRatio = 1;
  for (const id of ['seek', 'master', 'effects', 'bpm', 'audio-file']) get(id).tagName = 'INPUT';
  for (const id of ['play','pad-fill','pad-crash','pad-kick','pad-muffle','pad-snare']) get(id).tagName = 'BUTTON';
  get('bpm').value = 104; get('seek').max = 37; get('master').max = get('effects').max = 100; get('master').value = 65; get('effects').value = 70;
  let now = 0, id = 0; const frames = new Map(), timers = new Map();
  class FakeAudio {
    constructor() { this.buffer = null; this.duration = 0; this.position = 0; this.bpm = 104; this.playing = false; this.hits = []; this.ensureCount = 0; this.cancelCount = 0; this.pauseCount = 0; this.muffled = false; }
    async ensure() { this.ensureCount++; if (this.ensureWait) await this.ensureWait; }
    async loadDemo() { this.stemBuffers=null; this.buffer = { getChannelData: () => new Float32Array(320) }; this.duration = 36.923; this.position = 0; this.bpm = 104; return { name: 'Midnight Window', duration: this.duration, bpm: 104 }; }
    async loadFile(file) { if (file.bad) throw Error('지원하지 않는 음악 파일'); this.stemBuffers=null; this.buffer = { getChannelData: () => new Float32Array(320) }; this.duration = 55; this.position = 0; return { name: file.name, duration: 55, bpm: this.bpm }; }
    async loadStems(files) { this.stemBuffers=Object.fromEntries(Object.keys(files).map(k=>[k,{getChannelData:()=>new Float32Array(320)}])); this.buffer=this.stemBuffers.drums;this.duration=40;return {name:'내 밴드',duration:40,bpm:this.bpm,stems:true}; }
    setStemMix(mode) {this.stemMix=mode;}
    async play() { this.playing = true; return true; }
    pause() { this.pauseCount++; this.playing = false; this.muffled = false; this.cancelPendingEffects(); }
    seek(value) { this.position = value; this.cancelPendingEffects(); }
    trigger(kind, quantized, externalClock) { this.hits.push({kind, quantized, externalClock}); return quantized && this.playing ? .2 : 0; }
    setMuffle(value) { this.muffled = value; }
    setMaster(value) { this.masterLevel = value; } setEffects(value) { this.effectsLevel = value; }
    setBpm(value) { this.bpm = timing.normalizeBpm(value, this.bpm); return this.bpm; }
    alignBeat() { this.anchor = this.position; }
    cancelPendingEffects() { this.cancelCount++; }
    setLoop(a,b,enabled) { this.loop = { a,b,enabled }; }
  }
  const decks = [];
  class FakeYouTube {
    constructor(options) {this.options=options;this.position=0;this.playing=false;this.duration=100;this.videoId=null;decks.push(this);}
    async load(url) {this.videoId=parseYouTubeUrl(url);this.options.onReady(this);return {id:this.videoId};}
    play(){this.playing=true;this.options.onState(1);} pause(){this.playing=false;} volume(value){this.volumeLevel=value;}
    emit(number){this.playing=number===1;this.options.onState(number);}
  }
  const context = vm.createContext({ ...timing, parseYouTubeUrl, YouTubeDeck:FakeYouTube, detectOnsets:()=>[.3,.8,1.6], RemixAudio: FakeAudio, document, window, performance: { now: () => now },
    setTimeout: (fn, delay) => { const n = ++id; timers.set(n, {fn,delay}); return n; }, clearTimeout: n => timers.delete(n),
    requestAnimationFrame: fn => { const n = ++id; frames.set(n, fn); return n; }, cancelAnimationFrame: n => frames.delete(n) });
  const source = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8').replace(/^import .+;\n/gm, '');
  vm.runInContext(source + '\nglobalThis.api = {audio,state,togglePlay,pause,changeTrack,hit,holdMuffle,releaseMuffle,tapTempo,setQuantized,setLoopPoint,heldKeys,muffleHolds,setSourceMode,loadYouTube,loadStems,setStemMix,setGuided};', context);
  return {...context.api, get, document, window, frames, timers, decks, setNow: value => now = value};
}

test('initial page is silent, no audio context or autoplay; play starts original demo with single frame loop', async () => {
  const h = harness(); assert.equal(h.audio.ensureCount, 0); assert.equal(h.audio.playing, false); assert.equal(h.frames.size, 0);
  await h.togglePlay(); assert.equal(h.audio.playing, true); assert.equal(h.state.source, 'demo'); assert.equal(h.frames.size, 1);
  assert.equal(h.get('duration').textContent, '0:36'); assert.equal(h.get('track-title').textContent, 'Midnight Window');
  await h.togglePlay(); assert.equal(h.audio.playing, false); assert.equal(h.frames.size, 0);
  await h.togglePlay(); assert.equal(h.frames.size, 1);
});
test('one keyboard press triggers once; repeat is ignored, inputs retain typing, pointer click is not duplicated', async () => {
  const h = harness(); const event = {target:h.document.body, code:'KeyF',repeat:false};
  h.document.dispatch('keydown',event); h.document.dispatch('keydown',event); h.document.dispatch('keydown',{...event,repeat:true}); await flush(); assert.equal(h.audio.hits.length,1);
  h.document.dispatch('keyup',event); h.document.dispatch('keydown',event); await flush(); assert.equal(h.audio.hits.length,2);
  h.document.dispatch('keyup',event); h.document.dispatch('keydown',{...event,target:h.get('bpm')}); await flush(); assert.equal(h.audio.hits.length,2);
  h.get('pad-crash').dispatch('pointerdown',{pointerId:1}); h.get('pad-crash').dispatch('click',{detail:1}); await flush(); assert.equal(h.audio.hits.length,3);
});
test('muffle release before audio resume cannot leave filter stuck; multiple held pointers release independently', async () => {
  const h = harness(); let resume; h.audio.ensureWait = new Promise(resolve => { resume=resolve; });
  const hold = h.holdMuffle('pointer-1'); h.releaseMuffle('pointer-1'); resume(); await hold; assert.equal(h.audio.muffled,false);
  h.audio.ensureWait = null; await h.holdMuffle('pointer-1'); await h.holdMuffle('pointer-2'); assert.equal(h.audio.muffled,true);
  h.releaseMuffle('pointer-1'); assert.equal(h.audio.muffled,true); h.releaseMuffle('pointer-2'); assert.equal(h.audio.muffled,false);
});
test('hidden tab pauses, cancels frames/scheduled hits, releases filter; resume is never automatic', async () => {
  const h=harness(); await h.togglePlay(); await h.holdMuffle('key-KeyK'); await h.hit('fill'); assert.equal(h.timers.size,1);
  h.document.hidden=true; h.document.dispatch('visibilitychange'); assert.equal(h.audio.playing,false); assert.equal(h.audio.muffled,false); assert.equal(h.frames.size,0); assert.equal(h.timers.size,0);
  h.document.hidden=false; h.document.dispatch('visibilitychange'); assert.equal(h.audio.playing,false);
});
test('pending unlock does not start audio or pad after pause or tab hiding', async () => {
  const h=harness(); let resolve; h.audio.ensureWait=new Promise(r=>resolve=r); const pending=h.togglePlay();
  h.pause(); resolve(); await pending; assert.equal(h.audio.playing,false); assert.equal(h.state.playPending,false);
  h.audio.ensureWait=null; let resolveHit; h.audio.ensureWait=new Promise(r=>resolveHit=r); const hit=h.hit('fill'); h.document.hidden=true; h.document.dispatch('visibilitychange'); resolveHit(); await hit; assert.equal(h.audio.hits.length,0);
});
test('restart while unlock pending resets pending flag and does not start stale playback', async () => {
  const h=harness(); let resolve; h.audio.ensureWait=new Promise(r=>resolve=r); const pending=h.togglePlay(); h.get('restart').dispatch('click'); resolve(); await pending;
  assert.equal(h.audio.playing,false); assert.equal(h.state.playPending,false);
});
test('file loading is local, file names remain text; errors retain existing track and playback stays user-initiated', async () => {
  const h=harness(); await h.changeTrack({name:'<img src=x onerror=bad()>.mp3'}); assert.equal(h.get('track-title').textContent,'<img src=x onerror=bad()>.mp3'); assert.equal(h.state.source,'local'); assert.equal(h.audio.playing,false); assert.equal(h.get('demo').hidden,false);
  await h.changeTrack({name:'bad.bin',bad:true}); assert.equal(h.get('error').hidden,false); assert.match(h.get('error').textContent,/지원/); assert.equal(h.state.loading,false); assert.equal(h.get('play').disabled,false);
  await h.changeTrack(); assert.equal(h.state.source,'demo'); assert.equal(h.get('demo').hidden,true);
});
test('tap derives manual bpm and aligns beat phase only while playing; timing toggle cancels queued effects', async () => {
  const h=harness(); await h.togglePlay(); h.audio.position=5;
  for(const now of [0,500,1000,1500]) {h.setNow(now);h.tapTempo();} assert.equal(h.audio.bpm,120); assert.equal(h.audio.anchor,5);
  h.setQuantized(false); await h.hit('kick'); assert.equal(h.audio.hits.at(-1).quantized,false); assert.equal(h.get('immediate').getAttribute('aria-pressed'),'true');
  h.setQuantized(true); assert.equal(h.get('next-beat').getAttribute('aria-pressed'),'true'); assert.ok(h.audio.cancelCount>=2);
});
test('A/B looping requires a valid interval, uses current transport, and can be cleared', async () => {
  const h=harness(); h.setLoopPoint('a'); assert.equal(h.state.loopA,null);
  await h.togglePlay(); h.audio.position=4; h.setLoopPoint('a'); h.audio.position=4.1; h.setLoopPoint('b'); assert.equal(h.get('loop-toggle').disabled,true);
  h.audio.position=8;h.setLoopPoint('b');assert.equal(h.get('loop-toggle').disabled,false);h.get('loop-toggle').dispatch('click');assert.deepEqual(h.audio.loop,{a:4,b:8,enabled:true});
  h.get('loop-clear').dispatch('click'); assert.equal(h.state.loopEnabled,false); assert.equal(h.state.loopA,null);
});
test('native focused button Space is not hijacked; muffle focused keyboard hold releases on blur', async () => {
  const h=harness();h.document.dispatch('keydown',{target:h.get('play'),code:'Space'});await flush();assert.equal(h.audio.ensureCount,0);
  h.document.dispatch('keydown',{target:h.get('pad-muffle'),code:'Space'});await flush();assert.equal(h.audio.muffled,true);h.window.dispatch('blur');assert.equal(h.audio.muffled,false);assert.equal(h.heldKeys.size,0);
});
test('static shell has Korean metadata, local assets only, four primary pads, and reduced-motion/responsive rules', () => {
  const html=readFileSync(new URL('../dist/index.html',import.meta.url),'utf8'); const css=readFileSync(new URL('../dist/style.css',import.meta.url),'utf8');
  assert.match(html,/<html lang="ko">/);assert.equal((html.match(/class="pad pad-/g)||[]).length,4);assert.doesNotMatch(html,/<script[^>]+src="https?:/);assert.match(html,/role="alert"/);assert.match(css,/prefers-reduced-motion/);assert.match(css,/@media\(max-width:700px\)/);
  const script=readFileSync(new URL('../dist/app.js',import.meta.url),'utf8');assert.doesNotMatch(script,/fetch\(|XMLHttpRequest|getUserMedia|sendBeacon|localStorage/);
});

test('YouTube mode makes no connection until valid URL submitted, disables impossible filter and loop, cues not plays', async () => {
  const h=harness(); h.setSourceMode('youtube'); assert.equal(h.decks.length,0); assert.equal(h.get('pad-muffle').disabled,true); assert.equal(h.get('loop-a').disabled,true); assert.equal(h.get('loop-toggle').disabled,true);
  await h.holdMuffle('key-KeyK'); assert.equal(h.audio.ensureCount,0);
  h.get('youtube-url').value='https://example.com/watch?v=abcdefghijk'; await h.loadYouTube(); assert.equal(h.decks.length,0); assert.equal(h.get('error').hidden,false);
  h.get('youtube-url').value='https://youtu.be/abcdefghijk'; await h.loadYouTube(); assert.equal(h.decks.length,1); assert.equal(h.decks[0].playing,false); assert.equal(h.get('youtube-stage').hidden,false);
  h.decks[0].position=9.4;h.decks[0].emit(1); await h.hit('kick'); assert.equal(h.audio.hits.at(-1).externalClock.position,9.4);assert.equal(h.audio.playing,false);
  h.get('master').value=40;h.get('master').dispatch('input');assert.equal(h.decks[0].volumeLevel,.4);
  h.setSourceMode('local');assert.equal(h.decks[0].playing,false);assert.equal(h.get('pad-muffle').disabled,false);assert.equal(h.frames.size,0);
});
test('YouTube pause/buffering/hidden tab cancels queued pads, source switch cannot start hidden embed', async () => {
  const h=harness();h.get('youtube-url').value='https://youtu.be/abcdefghijk';await h.loadYouTube();const deck=h.decks[0];deck.emit(1);await h.hit('fill');deck.emit(3);assert.equal(h.frames.size,0);assert.equal(h.timers.size,0);
  deck.emit(1);h.document.hidden=true;h.document.dispatch('visibilitychange');assert.equal(deck.playing,false);assert.equal(h.frames.size,0);
  h.document.hidden=false;h.setSourceMode('local');deck.emit(1);assert.equal(deck.playing,false);
});
test('stem upload requires all four local files, defaults to drummer mix, and guide is estimated/optional', async () => {
  const h=harness();h.setSourceMode('stems');await h.loadStems();assert.equal(h.get('error').hidden,false);assert.equal(h.audio.stemBuffers,undefined);
  for(const key of ['drums','bass','other','vocals'])h.get('stem-'+key).files=[{name:key+'.wav'}];await h.loadStems();
  assert.equal(h.state.source,'stems');assert.equal(h.audio.stemMix,'drummer');assert.equal(h.audio.playing,false);assert.equal(h.get('guide-section').hidden,false);assert.equal(h.get('guide-lane').hidden,true);assert.match(h.get('guide-detail').textContent,/추정/);
  h.setGuided(true);assert.equal(h.state.guided,true);assert.equal(h.state.quantized,false);assert.equal(h.get('guide-lane').hidden,false);
  h.setStemMix('vocals');assert.equal(h.audio.stemMix,'vocals');assert.equal(h.get('mix-vocals').getAttribute('aria-pressed'),'true');
  h.setSourceMode('youtube');assert.equal(h.get('guide-section').hidden,true);h.setGuided(true);assert.equal(h.get('guide-section').hidden,true);
  await h.changeTrack();assert.equal(h.state.onsets.length,0);assert.equal(h.get('guide-section').hidden,true);assert.equal(h.get('stems-load').disabled,false);
});
