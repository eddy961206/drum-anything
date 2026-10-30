export const MAX_NOTES = 128;
export const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
export function bpmValue(value, fallback = 92) { const n = Number(value); return Number.isFinite(n) && n > 0 ? Math.round(clamp(n, 50, 180)) : fallback; }
export function quantize(beat, strength = 0, beats = 4) {
  const raw = ((beat % beats) + beats) % beats;
  const amount = clamp(Number(strength) || 0, 0, 1);
  return ((raw + (Math.round(raw * 4) / 4 - raw) * amount) % beats + beats) % beats;
}
export function cleanNotes(notes, beats) {
  return notes.filter(n => ['kick','snare'].includes(n.kind) && Number.isFinite(n.beat) && n.beat >= 0 && n.beat < beats).slice(0,MAX_NOTES).map(n => ({kind:n.kind,beat:n.beat}));
}
export function tapBpm(taps) {
  if (taps.length < 2) return null;
  const intervals = taps.slice(1).map((t,i)=>t-taps[i]).filter(d=>d >= 250 && d <= 1600);
  if (!intervals.length) return null;
  intervals.sort((a,b)=>a-b); const mid=Math.floor(intervals.length/2);
  const median=intervals.length%2 ? intervals[mid] : (intervals[mid-1]+intervals[mid])/2;
  return bpmValue(60000/median);
}
export function demoPattern(bars=1) {
  const notes=[];
  for(let b=0;b<bars;b++) for(const [kind,beat] of [['kick',0],['kick',1.75],['kick',2.5],['snare',1],['snare',3]]) notes.push({kind,beat:beat+b*4});
  return {bars,notes,source:'demo'};
}
export function makeEvents(pattern, strength, mood) {
  const beats=pattern.bars*4;
  const events=cleanNotes(pattern.notes,beats).map(n=>({...n,beat:quantize(n.beat,strength,beats),part:'drums'}));
  if (!events.length) return [];
  const roots=mood==='funky'?[38,43]:mood==='chill'?[45,41]:[48,43];
  for(let bar=0;bar<pattern.bars;bar++) {
    const root=roots[bar%2];
    // Prepared original harmony; bass timing follows the user's kick onsets.
    const kicks=events.filter(n=>n.kind==='kick' && n.beat>=bar*4 && n.beat<(bar+1)*4);
    const bassBeats=kicks.length?kicks.map(n=>n.beat):[bar*4,bar*4+2];
    for (const beat of [...new Set(bassBeats)]) events.push({kind:'bass',part:'bass',beat,midi:root,duration:mood==='funky'?.3:.65});
    const chord=mood==='funky'?[root+12,root+16,root+19,root+22]:[root+12,root+15,root+19,root+22];
    for(const offset of (mood==='funky'?[.5,1.75,2.5,3.5]:[0,2])) events.push({kind:'chord',part:'chords',beat:bar*4+offset,midis:chord,duration:mood==='funky'?.3:1.5});
    for(let offset=0;offset<4;offset+=.5) events.push({kind:'hat',part:'hats',beat:bar*4+offset,velocity:offset%1 ? .3:.5});
  }
  return events.sort((a,b)=>a.beat-b.beat);
}
export class BandTransport {
  constructor(audio, onChange=()=>{}) {this.audio=audio;this.onChange=onChange;this.mode='idle';this.pattern=null;this.backup=null;this.settings={bpm:92,strength:0,mood:'lofi',metronome:false};this.next=0;this.cycle=0;this.lastClick=-1;this.captured=[];this.overdub=false;}
  stop(reason='') {
    const wasRecording=['countin','recording'].includes(this.mode);
    this.audio.stopAll();this.mode='idle';this.reason=reason;this.captured=[];this.onChange(wasRecording?'cancel':'stop');
  }
  play(pattern=this.pattern) {
    this.stop(); if(!pattern?.notes.length) return false;
    this.pattern=pattern;this.events=makeEvents(pattern,this.settings.strength,this.settings.mood);this.mode='playing';this.start=this.audio.now()+.04;this.next=0;this.cycle=0;this.onChange('play');this.tick();return true;
  }
  record(bars=1,overdub=false) {
    this.stop();this.bars=overdub&&this.pattern?this.pattern.bars:(bars===2?2:1);this.overdub=overdub&&this.pattern?.source==='user';
    this.mode='countin';this.start=this.audio.now()+.08;this.recordStart=this.start+4*60/this.settings.bpm;this.lastClick=-1;this.captured=[];this.onChange('countin');this.tick();
  }
  hit(kind) {
    if(!['kick','snare'].includes(kind))return false;
    const now=this.audio.now();this.audio.hit(kind,now,.8);
    if(this.mode==='countin' && now>=this.recordStart) this.mode='recording';
    if(this.mode!=='recording')return false;
    const beat=(now-this.recordStart)*this.settings.bpm/60;
    const base=this.overdub?this.pattern.notes.length:0;
    if(beat<0||beat>=this.bars*4||this.captured.length+base>=MAX_NOTES)return false;
    this.captured.push({kind,beat});this.onChange('note');return true;
  }
  finish() {
    if(!this.captured.length){this.stop();this.onChange('empty');return;}
    this.backup=this.pattern;
    this.pattern={bars:this.bars,notes:cleanNotes([...(this.overdub?this.pattern.notes:[]),...this.captured],this.bars*4),source:'user'};
    this.captured=[];this.play();this.onChange('saved');
  }
  undo() {if(!this.backup)return false;const prior=this.backup;this.stop();this.pattern=prior;this.backup=null;this.onChange('undo');return true;}
  tick() {
    const now=this.audio.now(), spb=60/this.settings.bpm;
    if(this.mode==='countin'||this.mode==='recording') {
      if(now>=this.recordStart+this.bars*4*spb){this.finish();return;}
      if(this.mode==='countin'&&now>=this.recordStart){this.mode='recording';this.onChange('recording');}
      const maxClick=this.settings.metronome?4+this.bars*4:4;
      while(this.lastClick+1<maxClick && this.start+(this.lastClick+1)*spb<now+.09){this.lastClick++;const at=this.start+this.lastClick*spb;if(at>=now-.03)this.audio.click(Math.max(now,at),this.lastClick%4===0);}
      // Overdub hears the preserved take, never a fabricated drum pattern.
      if(this.overdub&&this.mode==='recording') {
        if(!this.overdubEvents){this.overdubEvents=makeEvents(this.pattern,this.settings.strength,this.settings.mood);this.overdubIndex=0;}
        while(this.overdubIndex<this.overdubEvents.length){const event=this.overdubEvents[this.overdubIndex],at=this.recordStart+event.beat*spb;if(at>now+.09)break;this.overdubIndex++;if(at>=now-.03)this.sound(event,Math.max(now,at),spb);}
      } else if(this.mode==='countin'){this.overdubEvents=null;this.overdubIndex=0;}
      return;
    }
    if(this.mode!=='playing')return;
    const length=this.pattern.bars*4;
    // Browser stalls skip stale cycles rather than burst every missed note.
    if(now>this.start+(this.cycle+1)*length*spb){this.cycle=Math.floor((now-this.start)/(length*spb));this.next=0;}
    let budget=512;
    while(budget-->0){const e=this.events[this.next];if(!e)break;const at=this.start+(this.cycle*length+e.beat)*spb;if(at>now+.1)break;if(at>=now-.025)this.sound(e,Math.max(now,at),spb);this.next++;if(this.next>=this.events.length){this.next=0;this.cycle++;}}
  }
  sound(e,at,spb){if(e.part==='drums')this.audio.hit(e.kind,at,.8);else if(e.kind==='bass')this.audio.bass(e.midi,at,e.duration*spb,this.settings.mood);else if(e.kind==='chord')this.audio.chord(e.midis,at,e.duration*spb,this.settings.mood);else this.audio.hat(at,e.velocity);}
  position(){const now=this.audio.now(),spb=60/this.settings.bpm;if(this.mode==='playing')return Math.max(0,(now-this.start)/spb)%(this.pattern.bars*4);if(this.mode==='recording')return Math.max(0,(now-this.recordStart)/spb);return 0;}
}
