import test from 'node:test';
import assert from 'node:assert/strict';
import {blankPattern, demoPattern, trimBounds, clampBpm, validatePattern, Sequencer} from '../dist/core.mjs';

test('patterns have independent rows and exactly 4 × 16 cells', () => {
  const pattern = blankPattern(); pattern[0][0] = true;
  assert.equal(pattern[1][0], false); assert.ok(validatePattern(pattern));
  assert.equal(validatePattern([[true]]), false);
  for (let i = 0; i < 3; i++) { const demo = demoPattern(i); assert.ok(validatePattern(demo)); assert.ok(demo.flat().some(Boolean)); }
});
test('BPM and trim boundaries are finite and safe', () => {
  assert.equal(clampBpm(400), 180); assert.equal(clampBpm(-1), 50); assert.equal(clampBpm(NaN), 50);
  assert.deepEqual(trimBounds({buffer:{duration:1},start:2,end:-1}), {start:0.98,end:1});
  assert.deepEqual(trimBounds({buffer:{duration:0.01},start:0,end:0}), {start:0,end:0.01});
});
function fixture() {
  const calls = [], steps = [], timers = new Map(); let id = 0, stopped = 0;
  const engine = {context:{currentTime:0,state:'running'},play:(row,time)=>calls.push({row,time}),stopAll:()=>stopped++};
  const seq = new Sequencer(engine,{onStep:step=>steps.push(step),setInterval:fn=>{timers.set(++id,fn);return id;},clearInterval:key=>timers.delete(key)});
  return {seq,engine,calls,steps,timers,get stopped(){return stopped;}};
}
test('single clock schedules exact sixteenths and playhead does not run early', () => {
  const f=fixture(), pattern=blankPattern(); pattern[0].fill(true);
  f.seq.start(pattern,120); assert.equal(f.timers.size,1); assert.equal(f.calls.length,1);
  assert.deepEqual(f.steps,[]); assert.equal(f.calls[0].time,0.035);
  f.engine.context.currentTime=.04; f.seq.tick(); assert.deepEqual(f.steps,[0]);
  f.engine.context.currentTime=.13; f.seq.tick(); assert.equal(f.calls[1].time,.16);
  f.engine.context.currentTime=.165; f.seq.tick(); assert.deepEqual(f.steps,[0,1]);
});
test('rapid start is idempotent; stop clears queued sounds and visuals',()=>{
  const f=fixture(); f.seq.start(demoPattern(),104); assert.equal(f.seq.start(demoPattern(),104),false);
  assert.equal(f.timers.size,1); f.seq.stop(); assert.equal(f.timers.size,0); assert.equal(f.stopped,1);
  assert.equal(f.steps.at(-1),-1); assert.equal(f.seq.pending.length,0); assert.equal(f.seq.playing,false);
});
test('edits use the live pattern reference',()=>{
  const f=fixture(), pattern=blankPattern(); f.seq.start(pattern,120); pattern[3][1]=true;
  f.engine.context.currentTime=.1; f.seq.tick(); assert.deepEqual(f.calls,[{row:3,time:.16}]);
});
test('long stalls cannot trigger a burst of stale notes',()=>{
  const f=fixture(), pattern=blankPattern(); pattern.forEach(row=>row.fill(true));
  f.seq.start(pattern,180); const before=f.calls.length;
  f.engine.context.currentTime=600; f.seq.tick();
  assert.ok(f.calls.length-before<=8); assert.ok(f.calls.slice(before).every(call=>call.time>=600));
});
test('suspended audio clock stops rather than retaining a runaway interval',()=>{
  const f=fixture(); f.seq.start(demoPattern()); f.engine.context.state='suspended'; f.seq.tick();
  assert.equal(f.seq.playing,false); assert.equal(f.timers.size,0);
});
test('tempo changes stay clamped without introducing another timer',()=>{
  const f=fixture(); f.seq.start(demoPattern()); f.seq.setBpm(200); assert.equal(f.seq.bpm,180); assert.equal(f.timers.size,1);
});
test('start rejects a suspended clock without leaking an interval',()=>{
  const f=fixture();f.engine.context.state='suspended';assert.throws(()=>f.seq.start(demoPattern()));
  assert.equal(f.timers.size,0);assert.equal(f.seq.playing,false);
});
