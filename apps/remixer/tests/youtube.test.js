import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYouTubeUrl } from '../dist/youtube.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
let sequence = 0;
async function harness(t, apiReady = false) {
  const prior = { window: globalThis.window, document: globalThis.document, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const timers = new Map(), scripts = [], players = [], mounts = new Map(); let timerId = 0;
  const parent = { appendChild(node) { node.parentNode = this; if (node.id) mounts.set(node.id, node); } };
  const mount = { id: 'youtube-player', parentNode: parent }; mounts.set(mount.id,mount);
  class MockPlayer {
    constructor(id, options) { this.id=id;this.options=options;this.calls=[];this.time=12.5;this.length=120;players.push(this); }
    cueVideoById(value) { this.calls.push(['cue',value]); }
    playVideo() { this.calls.push(['play']); }
    pauseVideo() { this.calls.push(['pause']); }
    stopVideo() { this.calls.push(['stop']); }
    seekTo(value,allowSeekAhead) { this.calls.push(['seek',value,allowSeekAhead]); this.time=value; }
    setVolume(value) { this.calls.push(['volume',value]); }
    getCurrentTime() { return this.time; } getDuration() { return this.length; } getVideoData() { return {title:'테스트 영상'}; }
    destroy() { this.calls.push(['destroy']); mounts.delete(this.id); }
    emitReady() { this.options.events.onReady({target:this}); }
    emitState(state) { this.options.events.onStateChange({data:state,target:this}); }
    emitError(code) { this.options.events.onError({data:code,target:this}); }
  }
  globalThis.window = { location: {origin:'https://private.example.com'} };
  if(apiReady) window.YT={Player:MockPlayer};
  globalThis.document = {head:{appendChild(node){scripts.push(node);}},createElement(tag){return {tagName:tag.toUpperCase(),remove(){this.removed=true;}};},getElementById(id){return mounts.get(id)||null;}};
  globalThis.setTimeout=(fn,delay)=>{const id=++timerId;timers.set(id,{fn,delay});return id;};globalThis.clearTimeout=id=>timers.delete(id);
  t.after(()=>Object.assign(globalThis,prior));
  const mod=await import(`../dist/youtube.js?test=${++sequence}`);
  return { ...mod,timers,scripts,players,MockPlayer,mounts,apiReady(){window.YT={Player:MockPlayer};window.onYouTubeIframeAPIReady();},fireTimer(){const [id,timer]=timers.entries().next().value;timers.delete(id);timer.fn();} };
}

test('strict YouTube parser accepts official single-video URL forms and ignores tracking query',()=>{
  for(const url of [
    'https://www.youtube.com/watch?v=abcDEF12_-3&si=tracker',
    'https://youtu.be/abcDEF12_-3?t=22',
    'https://m.youtube.com/shorts/abcDEF12_-3',
    'https://www.youtube.com/embed/abcDEF12_-3',
    'https://www.youtube-nocookie.com/embed/abcDEF12_-3',
    'https://music.youtube.com/watch?v=abcDEF12_-3',
    'https://www.youtube.com/live/abcDEF12_-3',
  ]) assert.equal(parseYouTubeUrl(url),'abcDEF12_-3');
});
test('strict parser rejects non-YouTube hosts, credentials, script URLs, playlist/channel and malformed IDs',()=>{
  for(const url of ['javascript:alert(1)','https://youtube.com.evil.test/watch?v=abcDEF12_-3','https://youtube.com@evil.test/watch?v=abcDEF12_-3','https://x:pw@youtube.com/watch?v=abcDEF12_-3','https://youtube.com:8443/watch?v=abcDEF12_-3','https://youtube.com/playlist?list=xyz','https://youtube.com/@someone','https://youtu.be/short','https://youtube.com/watch?v=<script>','abcDEF12_-3','https://youtu.be/abcDEF12_-3/extra','https://www.youtube.com/watch?v=abcDEF12_-3%2F']) assert.throws(()=>parseYouTubeUrl(url));
});
test('constructor and invalid load make no external request; first valid load creates only official API script',async t=>{
  const h=await harness(t); const deck=new h.YouTubeDeck();assert.equal(h.scripts.length,0);assert.equal(h.players.length,0);
  await assert.rejects(deck.load('https://notyoutube.example/watch?v=abcDEF12_-3'));assert.equal(h.scripts.length,0);
  const pending=deck.load('https://youtu.be/abcDEF12_-3');assert.equal(h.scripts.length,1);assert.equal(h.scripts[0].src,'https://www.youtube.com/iframe_api');assert.equal(h.players.length,0);
  h.apiReady();await flush();assert.equal(h.players.length,1);const player=h.players[0];assert.equal(player.options.playerVars.autoplay,0);assert.equal(player.options.playerVars.controls,1);assert.equal(player.options.playerVars.origin,'https://private.example.com');
  player.emitReady();const result=await pending;assert.equal(result.id,'abcDEF12_-3');assert.equal(deck.ready,true);assert.equal(h.timers.size,0);assert.equal(player.calls.filter(c=>c[0]==='play').length,0);assert.equal(player.calls.at(-1)[0],'cue');
});
test('concurrent loads share one API and player; stale load never cues an older selection',async t=>{
  const h=await harness(t);const deck=new h.YouTubeDeck();const first=deck.load('https://youtu.be/abcDEF12_-3');const second=deck.load('https://youtu.be/xyzABC12_-4');assert.equal(h.scripts.length,1);
  h.apiReady();await flush();assert.equal(h.players.length,1);h.players[0].emitReady();assert.equal(await first,null);assert.equal((await second).id,'xyzABC12_-4');assert.equal(h.players[0].calls.filter(c=>c[0]==='cue').length,1);
});
test('controls and state callbacks use official player; pause does not retain false playing state',async t=>{
  const h=await harness(t,true),states=[],errors=[];const deck=new h.YouTubeDeck({onState:s=>states.push(s),onError:e=>errors.push(e)});
  deck.volume(.42);const pending=deck.load('https://youtu.be/abcDEF12_-3');await flush();const player=h.players[0];player.emitReady();await pending;
  assert.deepEqual(player.calls[0],['volume',42]);deck.play();player.emitState(1);assert.equal(deck.playing,true);assert.equal(deck.position,12.5);assert.equal(deck.duration,120);assert.equal(deck.title,'테스트 영상');
  deck.pause();assert.equal(deck.playing,false);deck.seek(500);assert.deepEqual(player.calls.at(-1),['seek',120,true]);deck.volume(2);assert.deepEqual(player.calls.at(-1),['volume',100]);deck.volume(NaN);assert.deepEqual(player.calls.at(-1),['volume',100]);
  player.emitError(150);assert.match(errors[0].message,/외부 사이트/);assert.equal(errors[0].code,150);player.emitError(100);assert.match(errors[1].message,/비공개/);assert.deepEqual(states,[1]);
});
test('API network errors are recoverable and restore callback; timeout rejects instead of hanging',async t=>{
  const h=await harness(t);let oldCalls=0;const old=()=>oldCalls++;window.onYouTubeIframeAPIReady=old;
  const deck=new h.YouTubeDeck();const first=deck.load('https://youtu.be/abcDEF12_-3');h.scripts[0].onerror();await assert.rejects(first,/불러오지/);assert.equal(window.onYouTubeIframeAPIReady,old);assert.equal(h.scripts[0].removed,true);assert.equal(h.timers.size,0);
  const second=deck.load('https://youtu.be/abcDEF12_-3');assert.equal(h.scripts.length,2);h.fireTimer();await assert.rejects(second,/불러오지/);assert.equal(oldCalls,0);
});
test('player readiness timeout rejects, restores mount and ignores late readiness; retry can succeed',async t=>{
  const h=await harness(t,true);const deck=new h.YouTubeDeck();const first=deck.load('https://youtu.be/abcDEF12_-3');await flush();const old=h.players[0];h.fireTimer();await assert.rejects(first,/오래/);assert.ok(h.mounts.has('youtube-player'));old.emitReady();assert.equal(deck.ready,false);
  const second=deck.load('https://youtu.be/abcDEF12_-3');await flush();h.players[1].emitReady();await second;assert.equal(deck.ready,true);assert.equal(h.timers.size,0);
});
test('stop invalidates pending video cue; destruction cancels readiness and stale events',async t=>{
  const h=await harness(t,true);const states=[];const deck=new h.YouTubeDeck({onState:s=>states.push(s)});const first=deck.load('https://youtu.be/abcDEF12_-3');await flush();deck.stop();h.players[0].emitReady();assert.equal(await first,null);assert.equal(h.players[0].calls.some(c=>c[0]==='cue'),false);
  deck.destroy();h.players[0].emitState(1);assert.equal(deck.playing,false);assert.equal(states.length,0);await assert.rejects(deck.load('https://youtu.be/abcDEF12_-3'),/닫혔/);
  h.mounts.set('youtube-player',{parentNode:{appendChild(){}}});const next=new h.YouTubeDeck();const pending=next.load('https://youtu.be/abcDEF12_-3');await flush();next.destroy();await assert.rejects(pending,/닫혔/);assert.equal(h.timers.size,0);
});
