import test from 'node:test';
import assert from 'node:assert/strict';
import {AudioEngine, MicController, encodeWav} from '../dist/audio.mjs';

class Param { constructor(){this.value=0;this.events=[];} setValueAtTime(...args){this.events.push(args);} linearRampToValueAtTime(...args){this.events.push(args);} }
class Node { constructor(){this.gain=new Param();this.playbackRate=new Param();this.disconnected=false;this.stopped=false;} connect(){} disconnect(){this.disconnected=true;} start(...args){this.started=args;} stop(){this.stopped=true;} }
class Context {
  constructor(){this.currentTime=0;this.sampleRate=8000;this.state='suspended';this.destination={};this.sources=[];this.resumes=0;}
  async resume(){this.resumes++;this.state='running';}
  createGain(){return new Node();}
  createBufferSource(){const node=new Node();this.sources.push(node);return node;}
  createBuffer(channels,length,sampleRate){const data=Array.from({length:channels},()=>new Float32Array(length));return {numberOfChannels:channels,length,sampleRate,duration:length/sampleRate,getChannelData:i=>data[i]};}
  async decodeAudioData(){return this.createBuffer(1,8000,8000);}
}
test('audio requires explicit ready and generates four original finite samples',async()=>{
  const engine=new AudioEngine({AudioContext:Context}); assert.equal(engine.context,null); assert.deepEqual(engine.samples,[]);
  await engine.ready(); assert.equal(engine.context.state,'running');assert.equal(engine.samples.length,4);
  for(const sample of engine.samples){assert.equal(sample.custom,false);assert.ok(sample.buffer.getChannelData(0).every(Number.isFinite));assert.ok(sample.buffer.getChannelData(0).some(n=>Math.abs(n)>.05));}
});
test('play supports trim pitch gain, cleans onended, and limits voices',async()=>{
  const engine=await new AudioEngine({AudioContext:Context}).ready();
  engine.samples[0].start=.01;engine.samples[0].end=.1;engine.samples[0].pitch=12;
  const voice=engine.play(0,1);assert.deepEqual(voice.source.started,[1,.01,.09000000000000001]);assert.equal(voice.source.playbackRate.value,2);
  voice.source.onended();assert.equal(engine.voices.size,0);assert.ok(voice.source.disconnected);
  for(let i=0;i<100;i++)engine.play(0);assert.equal(engine.voices.size,32);
  engine.stopAll();assert.equal(engine.voices.size,0);assert.ok(engine.context.sources.every(node=>node.disconnected));
});
test('setting samples validates length and exports selected trim as PCM WAV',async()=>{
  const engine=await new AudioEngine({AudioContext:Context}).ready(),buffer=engine.context.createBuffer(1,16000,8000);
  buffer.getChannelData(0).fill(.5);engine.setSample(1,buffer,{name:'cup'});
  assert.equal(engine.samples[1].custom,true);engine.samples[1].start=.25;engine.samples[1].end=.75;
  const blob=engine.exportWav(1),view=new DataView(await blob.arrayBuffer());
  assert.equal(blob.type,'audio/wav');assert.equal(blob.size,44+4000*2);assert.equal(view.getUint32(24,true),8000);assert.equal(view.getUint16(22,true),1);
  assert.throws(()=>engine.setSample(0,{duration:31}));
  engine.samples[1].pitch=12;assert.equal(encodeWav(engine.samples[1]).byteLength,44+2000*2);
});
test('reopening a closed audio context does not erase custom samples',async()=>{
  const engine=await new AudioEngine({AudioContext:Context}).ready(); const custom=engine.context.createBuffer(1,8000,8000);
  engine.setSample(0,custom,{name:'mine'});engine.context.state='closed';await engine.ready();
  assert.equal(engine.samples[0].buffer,custom);assert.equal(engine.samples[0].custom,true);
});

class Recorder {
  constructor(stream){this.stream=stream;this.state='inactive';this.mimeType='audio/webm';Recorder.instances.push(this);}
  start(){this.state='recording';}
  stop(){this.state='inactive';this.stopCalled=true;}
  finish(){this.ondataavailable?.({data:new Blob(['sample'],{type:this.mimeType})});this.onstop?.();}
}
Recorder.instances=[];
const deferred=()=>{let resolve,reject;const promise=new Promise((res,rej)=>{resolve=res;reject=rej;});return {promise,resolve,reject};};
function micFixture(getUserMedia) {
  const track={stops:0,stop(){this.stops++;}},stream={getTracks:()=>[track]},timers=new Map(),states=[],blobs=[],errors=[];let id=0,calls=0;
  const mic=new MicController({getUserMedia:constraints=>{calls++;assert.equal(constraints.video,false);return getUserMedia?getUserMedia():Promise.resolve(stream);},MediaRecorder:Recorder,onState:s=>states.push(s),onBlob:b=>blobs.push(b),onError:e=>errors.push(e),setTimeout:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},clearTimeout:i=>timers.delete(i)});
  return {mic,track,stream,timers,states,blobs,errors,get calls(){return calls;}};
}
test('microphone is never requested on construction and duplicate start is guarded',async()=>{
  const pending=deferred(),f=micFixture(()=>pending.promise);assert.equal(f.calls,0);
  const first=f.mic.start();assert.equal(f.calls,1);assert.equal(await f.mic.start(),false);
  pending.resolve(f.stream);assert.equal(await first,true);assert.equal(f.mic.state,'recording');
  assert.equal(f.timers.size,1);assert.equal([...f.timers.values()][0].ms,3000);f.mic.cancel();
});
test('late permission after cancellation stops every track without recording',async()=>{
  const pending=deferred(),f=micFixture(()=>pending.promise),before=Recorder.instances.length;
  const start=f.mic.start();f.mic.cancel();pending.resolve(f.stream);assert.equal(await start,false);
  assert.ok(f.track.stops>=1);assert.equal(Recorder.instances.length,before);assert.equal(f.mic.state,'idle');assert.equal(f.blobs.length,0);
});
test('denied permission returns to idle and provides actionable error hook',async()=>{
  const error=new Error('denied');error.name='NotAllowedError';const f=micFixture(()=>Promise.reject(error));
  assert.equal(await f.mic.start(),false);assert.equal(f.mic.state,'idle');assert.deepEqual(f.errors,[error]);assert.equal(f.timers.size,0);
});
test('stop cuts microphone tracks before asynchronous recording completion',async()=>{
  const f=micFixture();await f.mic.start();const recorder=f.mic.recorder;f.mic.stop();
  assert.ok(f.track.stops>=1);assert.equal(f.mic.state,'processing');assert.equal(f.blobs.length,0);assert.equal(f.timers.size,0);
  recorder.finish();assert.equal(f.blobs.length,1);assert.equal(f.mic.state,'idle');assert.equal(f.mic.stream,null);
});
test('3 second cap stops tracks and completes one take',async()=>{
  const f=micFixture();await f.mic.start();const recorder=f.mic.recorder;[...f.timers.values()][0].fn();
  assert.equal(recorder.stopCalled,true);assert.ok(f.track.stops>=1);recorder.finish();assert.equal(f.blobs.length,1);
});
test('cancellation discards recording and ignores queued callbacks',async()=>{
  const f=micFixture();await f.mic.start();const recorder=f.mic.recorder,oldStop=recorder.onstop,oldData=recorder.ondataavailable;
  f.mic.cancel();oldData({data:new Blob(['stale'])});oldStop();assert.equal(f.blobs.length,0);assert.equal(f.mic.state,'idle');assert.ok(f.track.stops>=1);
});
test('new request survives resolution of old cancelled permission request',async()=>{
  const old=deferred(),latest=deferred();let count=0;const f=micFixture(()=>++count===1?old.promise:latest.promise);
  const first=f.mic.start();f.mic.cancel();const second=f.mic.start();old.resolve(f.stream);assert.equal(await first,false);assert.equal(f.mic.state,'requesting');
  const freshTrack={stopped:false,stop(){this.stopped=true;}},freshStream={getTracks:()=>[freshTrack]};latest.resolve(freshStream);assert.equal(await second,true);assert.equal(f.mic.stream,freshStream);f.mic.cancel();assert.equal(freshTrack.stopped,true);
});
test('recorder errors stop capture and return to usable idle state',async()=>{
  const f=micFixture();await f.mic.start();f.mic.recorder.onerror({error:new Error('encoder error')});
  assert.equal(f.mic.state,'idle');assert.ok(f.track.stops>=1);assert.equal(f.errors.length,1);assert.equal(f.timers.size,0);
});
test('missing recorder has no permission side effect',async()=>{
  let calls=0;const errors=[];const mic=new MicController({MediaRecorder:null,getUserMedia:()=>{calls++;},onError:e=>errors.push(e)});
  assert.equal(await mic.start(),false);assert.equal(calls,0);assert.equal(errors.length,1);
});
test('resetSample restores only the selected pad and preserves other personal sounds',async()=>{
  const engine=await new AudioEngine({AudioContext:Context}).ready(),one=engine.context.createBuffer(1,8000,8000),two=engine.context.createBuffer(1,4000,8000);
  engine.setSample(0,one,{name:'one'});engine.setSample(1,two,{name:'two'});
  const other=engine.samples[1];engine.resetSample(0);
  assert.equal(engine.samples[0].custom,false);assert.equal(engine.samples[0].name,'뽁');assert.notEqual(engine.samples[0].buffer,one);
  assert.equal(engine.samples[1],other);assert.equal(engine.samples[1].buffer,two);assert.throws(()=>engine.resetSample(4));
});
