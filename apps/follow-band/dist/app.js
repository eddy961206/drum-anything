import {AudioEngine} from './audio.js';
import {BandTransport,bpmValue,tapBpm,quantize,demoPattern,MAX_NOTES} from './rhythm.js';
const $=id=>document.getElementById(id);
const audio=new AudioEngine();
const state={epoch:0,pending:false,frame:0,taps:[],savedUser:null,muted:new Set(),held:new Set(),flashTimers:new Map()};
const transport=new BandTransport(audio,changed);
const moodCopy={lofi:'둥근 베이스, 포근한 작은 합주.',funky:'짧은 베이스, 통통 튀는 엇박 코드.',chill:'느긋한 여운, 넓게 퍼지는 코드.'};
function notice(message,error=false){$('notice').textContent=message;$('notice').classList.toggle('error',error);}
function isRecording(){return ['countin','recording'].includes(transport.mode);}
function changed(event){
  if(event==='saved'){state.savedUser=transport.pattern;notice('이 박자는 내가 만든 것! 밴드와 반복 중이에요. 겹쳐 녹음도 해보세요.');}
  if(event==='empty')notice('이번엔 담긴 박자가 없어요. 이전 리듬은 그대로 두었어요. 다시 가볍게 해봐요.');
  if(event==='undo'){state.savedUser=transport.pattern?.source==='user'?transport.pattern:null;notice('이전 테이크로 돌아왔어요. 재생을 누르면 처음부터 들어요.');}
  render();
}
function render(){
  const mode=transport.mode, rec=isRecording(), has=Boolean(transport.pattern?.notes.length);
  $('status').textContent=state.pending?'소리 준비 중…':mode==='countin'?'네 박자 뒤, 시작!':mode==='recording'?'내 박자 담는 중':mode==='playing'?(transport.pattern.source==='demo'?'예시 밴드 연주 중':'내 밴드 연주 중'):has?'리듬이 준비됐어요':'준비됐어요';
  $('substatus').textContent=rec?'쿵 / 탁, 원하는 순간에 두드려요.':mode==='playing'?'함께 두드려도 좋아요. 녹음할 때만 저장돼요.':'패드는 언제든 연주할 수 있어요.';
  $('record').textContent=rec?'취소하고 돌아가기':'●  내 리듬 녹음';
  $('record').disabled=state.pending;
  $('play').disabled=!has||rec||state.pending;
  $('play').textContent=mode==='playing'?'Ⅱ':'▶';$('play').setAttribute('aria-label',mode==='playing'?'재생 멈춤, 리듬 유지':'현재 리듬 처음부터 재생');
  $('stop').disabled=mode==='idle'&&!state.pending;
  $('overdub').disabled=rec||state.pending||transport.pattern?.source!=='user'||transport.pattern.notes.length>=MAX_NOTES;
  $('undo').disabled=rec||state.pending||!transport.backup;
  $('export').disabled=rec||state.pending||transport.pattern?.source!=='user';
  for(const id of ['bpm','bars','quantize','tap-tempo','metronome'])$(id).disabled=rec||state.pending;
  document.querySelectorAll('[data-mood]').forEach(b=>{b.disabled=rec||state.pending;b.setAttribute('aria-pressed',String(b.dataset.mood===transport.settings.mood));});
  $('demo').disabled=rec||state.pending;
  $('demo').textContent=transport.pattern?.source==='demo'&&state.savedUser?'↩  내 리듬으로 돌아가기':'▶  예시 밴드 듣기';
  $('record-progress').hidden=!rec;$('playhead').hidden=!['playing','recording'].includes(mode);
  drawPattern();
}
function visiblePattern(){if(isRecording())return {bars:transport.bars,notes:[...(transport.overdub?transport.pattern.notes:[]),...transport.captured],source:'recording'};return transport.pattern||{bars:Number($('bars').value),notes:[],source:'empty'};}
function drawPattern(){
  const pattern=visiblePattern(), beats=pattern.bars*4;
  $('pattern-name').textContent=pattern.source==='empty'?'아직 녹음한 리듬이 없어요':pattern.source==='demo'?`오리지널 예시 · ${pattern.bars}마디`:pattern.source==='recording'?`내 박자 기록 중 · ${pattern.bars}마디`:`내가 만든 리듬 · ${pattern.bars}마디`;
  $('note-count').textContent=`${pattern.notes.length}음${isRecording()?` / 최대 ${MAX_NOTES}`:''}`;
  $('lanes').style.setProperty('--steps',beats*4);
  $('kick-lane').replaceChildren();$('snare-lane').replaceChildren();
  for(const n of pattern.notes){const note=document.createElement('i');note.className=`note ${n.kind==='snare'?'snare-note':''}`;note.style.left=`${quantize(n.beat,transport.settings.strength,beats)/beats*100}%`;note.title=`${n.kind==='kick'?'쿵':'탁'} · ${(n.beat+1).toFixed(2)}박`;$(n.kind+'-lane').appendChild(note);}
  $('lanes').setAttribute('aria-label',pattern.notes.length?`${pattern.source==='demo'?'예시':'내 리듬'}, ${pattern.bars}마디. ${pattern.notes.map(n=>(n.kind==='kick'?'쿵':'탁')+' '+(n.beat+1).toFixed(2)+'박').join(', ')}`:'아직 녹음한 리듬이 없습니다');
  document.querySelectorAll('.ticks span').forEach((el,i)=>el.textContent=String(i*(beats/4)+1));
}
function animate(){
  state.frame=0;
  if(transport.mode==='idle')return;
  if(audio.ctx&&audio.ctx.state!=='running'){stop('소리가 중단됐어요. 재생을 눌러 다시 시작해요.');return;}
  transport.tick();
  if(transport.mode==='idle')return;
  if(isRecording()){
    const now=audio.now(),spb=60/transport.settings.bpm;
    if(transport.mode==='countin'){$('count-label').textContent='4박을 센 뒤 녹음 시작';$('count-number').textContent=String(Math.max(1,Math.ceil((transport.recordStart-now)/spb)));$('progress-fill').style.width=`${Math.min(100,Math.max(0,(now-transport.start)/(spb*4)*100))}%`;}
    else{const elapsed=transport.position();$('count-label').textContent=transport.overdub?'기존 리듬 위에 겹쳐 녹음 중':'지금 두드리면 담겨요';$('count-number').textContent=String(Math.max(1,Math.ceil(transport.bars*4-elapsed)));$('progress-fill').style.width=`${elapsed/(transport.bars*4)*100}%`;}
  }
  const beats=(isRecording()?transport.bars:transport.pattern?.bars||1)*4;
  $('playhead').style.left=`${Math.min(100,transport.position()/beats*100)}%`;
  state.frame=requestAnimationFrame(animate);
}
function frames(){if(!state.frame&&transport.mode!=='idle')state.frame=requestAnimationFrame(animate);}
function clearInputs(){state.held.clear();for(const [kind,timer] of state.flashTimers){clearTimeout(timer);$(kind).classList.remove('flash');}state.flashTimers.clear();}
function stop(message='멈췄어요. 리듬은 그대로예요. 재생하면 처음부터 시작해요.'){
  state.epoch++;state.pending=false;transport.stop();if(state.frame)cancelAnimationFrame(state.frame);state.frame=0;clearInputs();notice(message);render();
}
async function startAction(action){
  if(state.pending)return;
  const epoch=++state.epoch;state.pending=true;render();
  try{await audio.unlock();if(epoch!==state.epoch||document.hidden)return;state.pending=false;action();frames();render();}
  catch(error){if(epoch===state.epoch){state.pending=false;transport.stop();notice(error.message||'소리를 켜지 못했어요. 다시 눌러 주세요.',true);render();}}
}
async function hit(kind){
  const epoch=state.epoch;
  try{await audio.unlock();if(epoch!==state.epoch||document.hidden)return;const saved=transport.hit(kind);$(kind).classList.add('flash');clearTimeout(state.flashTimers.get(kind));state.flashTimers.set(kind,setTimeout(()=>{$(kind).classList.remove('flash');state.flashTimers.delete(kind);},100));if(isRecording()&&!saved&&transport.mode==='recording'&&visiblePattern().notes.length>=MAX_NOTES)notice('이번 루프는 128음까지 담았어요. 다음 테이크에서 이어 놀아요.');}
  catch(error){if(epoch===state.epoch)notice(error.message||'소리를 켜지 못했어요.',true);}
}
function changedSetting(){if(transport.mode==='playing')stop('설정을 바꿨어요. 재생을 눌러 새 소리로 들어요.');drawPattern();}
$('demo').addEventListener('click',()=>startAction(()=>{
  if(transport.pattern?.source==='user')state.savedUser=transport.pattern;
  const back=transport.pattern?.source==='demo'&&state.savedUser;
  transport.play(back||demoPattern(Number($('bars').value)));
  notice(back?'내 리듬으로 돌아왔어요.':'이건 미리 만든 오리지널 예시예요. 내 리듬 녹음을 누르면 내가 주인공!');
}));
$('play').addEventListener('click',()=>transport.mode==='playing'?stop():startAction(()=>transport.play()));
$('stop').addEventListener('click',()=>stop(isRecording()?'녹음을 취소했어요. 이전 리듬은 그대로예요.':undefined));
$('record').addEventListener('click',()=>isRecording()?stop('녹음을 취소했어요. 이전 리듬은 그대로예요.'):startAction(()=>{transport.record(Number($('bars').value));notice('4박을 센 다음 시작! 끝나면 내가 친 박자가 자동으로 반복돼요.');}));
$('overdub').addEventListener('click',()=>startAction(()=>{transport.record(transport.pattern.bars,true);notice('4박 뒤에 기존 리듬 위로 새 박자만 더해요.');}));
$('undo').addEventListener('click',()=>{stop();transport.undo();});
$('bpm').addEventListener('change',()=>{$('bpm').value=bpmValue($('bpm').value,transport.settings.bpm);transport.settings.bpm=Number($('bpm').value);state.taps=[];changedSetting();});
$('bars').addEventListener('change',()=>{drawPattern();notice('다음 새 녹음의 길이만 바꿨어요. 기존 리듬 길이는 유지돼요.');});
$('quantize').addEventListener('change',()=>{transport.settings.strength=Number($('quantize').value);changedSetting();notice('원래 두드린 시간은 남아 있어요. ‘그대로’를 고르면 보정 없이 재생해요.');});
$('metronome').addEventListener('change',()=>transport.settings.metronome=$('metronome').checked);
$('tap-tempo').addEventListener('click',()=>{const now=performance.now();if(state.taps.length&&now-state.taps.at(-1)>1800)state.taps=[];state.taps.push(now);state.taps=state.taps.slice(-6);const bpm=tapBpm(state.taps);if(bpm){transport.settings.bpm=bpm;$('bpm').value=bpm;changedSetting();notice(`두드린 속도: ${bpm} BPM. 녹음의 박자는 이 속도를 따라가요.`);}else notice('같은 속도로 두세 번 더 눌러주세요.');});
document.querySelectorAll('[data-mood]').forEach(button=>button.addEventListener('click',()=>{transport.settings.mood=button.dataset.mood;$('mood-note').textContent=moodCopy[button.dataset.mood];changedSetting();render();}));
for(const part of ['bass','chords','hats','master']){const slider=$(part+'-volume');audio.setVolume(part,Number(slider.value)/100);slider.addEventListener('input',()=>audio.setVolume(part,state.muted.has(part)?0:Number(slider.value)/100));}
document.querySelectorAll('[data-mute]').forEach(button=>button.addEventListener('click',()=>{const part=button.dataset.mute;if(state.muted.has(part))state.muted.delete(part);else state.muted.add(part);button.setAttribute('aria-pressed',String(state.muted.has(part)));button.textContent=state.muted.has(part)?'꺼짐':'켜짐';audio.setVolume(part,state.muted.has(part)?0:Number($(part+'-volume').value)/100);}));
for(const kind of ['kick','snare']){
  $(kind).addEventListener('pointerdown',event=>{if(event.button!==0&&event.pointerType!=='touch')return;event.preventDefault();$(kind).focus({preventScroll:true});hit(kind);});
  $(kind).addEventListener('click',event=>{if(event.detail===0)hit(kind);});
}
document.addEventListener('keydown',event=>{if(event.code==='Escape'){event.preventDefault();stop();return;}if(event.repeat||state.held.has(event.code)||event.ctrlKey||event.metaKey||event.altKey)return;if(['INPUT','SELECT','TEXTAREA'].includes(event.target.tagName)||event.target.isContentEditable)return;const kind={KeyF:'kick',KeyJ:'snare'}[event.code];if(kind){event.preventDefault();state.held.add(event.code);hit(kind);}});
document.addEventListener('keyup',event=>state.held.delete(event.code));
window.addEventListener('blur',clearInputs);
document.addEventListener('visibilitychange',()=>{if(document.hidden){stop('다른 화면으로 이동해 멈췄어요. 돌아와서 재생해 주세요.');audio.suspend().catch(()=>{});}});
window.addEventListener('pagehide',()=>{stop();audio.suspend().catch(()=>{});});
$('export').addEventListener('click',()=>{if(transport.pattern?.source!=='user')return;const data={format:'follow-my-rhythm-band',version:1,bpm:transport.settings.bpm,bars:transport.pattern.bars,quantization:transport.settings.strength,mood:transport.settings.mood,notes:transport.pattern.notes};const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='my-rhythm.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);notice('두드린 원래 시간과 설정을 JSON 파일로 저장했어요. 오디오 녹음은 아니에요.');});
render();
