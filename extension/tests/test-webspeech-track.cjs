'use strict';
/* 共有音声 Track の Web Speech が、開始直後の network で回り続けないかの受入試験。
 *
 * 起点は実測（v1.49.26・アドオンの字幕表示＋Web Speech）。アドオンのタブ音声の Track を
 * 渡すと、開始から約0.15秒で network が返り、再起動しても同じだった（22回）。同じ Chrome で
 * 画面共有の Track は認識できていた。gpt 系は同じタブ音声で動いた。 */
const path=require('node:path'),fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const src=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8').replace(/\r\n/g,'\n');
const lines=src.split('\n');
function block(startsWith){
  const i=lines.findIndex(l=>l.startsWith(startsWith));
  assert.ok(i>=0,'block not found: '+startsWith);
  for(let j=i+1;j<lines.length;j++) if(lines[j]==='}'||lines[j]==='};') return lines.slice(i,j+1).join('\n');
  throw new Error('unterminated: '+startsWith);
}
const CODE=['var WEB_TRACK_QUICK_MS','var WEB_TRACK_STALL_MS','function WebSpeechTrackEngine(',
  'WebSpeechTrackEngine.prototype.watch=','WebSpeechTrackEngine.prototype.checkStall=','WebSpeechTrackEngine.prototype.addonTrack=',
  'WebSpeechTrackEngine.prototype.useRelay=','WebSpeechTrackEngine.prototype.dropRelay=','WebSpeechTrackEngine.prototype.quickFail=',
  'WebSpeechTrackEngine.prototype.start=','WebSpeechTrackEngine.prototype.startSameTrack=','WebSpeechTrackEngine.prototype.fail=',
  'WebSpeechTrackEngine.prototype.build=','WebSpeechTrackEngine.prototype.stop=']
  .map(p=>p.startsWith('var ')?lines.find(l=>l.startsWith(p)):block(p)).join('\n');

function world(opts={}){
  const w={clock:1000,timers:[],logs:[],toasts:[],recs:[],contexts:[]};
  class Track{constructor(id){this.id=id;this.kind='audio';this.readyState='live';}stop(){this.readyState='ended';}}
  class SR{constructor(){w.recs.push(this);this.started=[];}
    start(t){this.started.push(t);w.lastStart=t;}
    abort(){this.aborted=(this.aborted||0)+1;if(!opts.hung){const r=this;Promise.resolve().then(()=>{if(r.onerror)r.onerror({error:'aborted'});if(r.onend)r.onend();});}}stop(){}}
  class AC{constructor(o){if(opts.rateThrows&&o&&o.sampleRate)this.bad=true;this.sampleRate=o&&o.sampleRate||48000;
      this.state='suspended';this.closed=false;w.contexts.push(this);}
    createMediaStreamSource(){if(this.bad)throw new Error('rate');return {connect(){},disconnect(){}};}
    createMediaStreamDestination(){const t=new Track('relay-'+w.contexts.length);return {stream:{getAudioTracks:()=>[t]}};}
    resume(){this.state=opts.relayStuck?'suspended':'running';return Promise.resolve();}
    close(){this.closed=true;this.state='closed';return Promise.resolve();}}
  const ctx={console,String,Object,JSON,Math,Promise,Error,
    Date:{now:()=>w.clock},
    setTimeout:(f,ms)=>{const t={at:w.clock+ms,f};w.timers.push(t);return t;},clearTimeout(t){const i=w.timers.indexOf(t);if(i>=0)w.timers.splice(i,1);},
    setInterval:(f,ms)=>{const t={at:w.clock+ms,f,every:ms};w.timers.push(t);return t;},clearInterval(t){const i=w.timers.indexOf(t);if(i>=0)w.timers.splice(i,1);},
    SEG:{voice:{}},
    SR,MediaStream:function(t){this.t=t;},S:{running:true},CFG:{interimOn:false},
    window:{AudioContext:AC,__duoTabAudio:opts.addon?{isActive:()=>true}:undefined},
    dlog:(c,m,d)=>w.logs.push({m,d}),toast:(t)=>w.toasts.push(t),
    segAttachMeter(){},segDetachMeter(){},segWebEnd(){},segWebResult:()=>true,
    L:()=>({sr:'en-US',name:'English'}),langOf:()=>'en',overlayChromeMajor:()=>153,removeEntry(){}};
  vm.createContext(ctx);vm.runInContext(CODE,ctx);
  w.ctx=ctx;w.Track=Track;
  w.engine=(track)=>new ctx.WebSpeechTrackEngine('B',track||new Track('tab-1'),{ownsStream:true,stream:{getTracks:()=>[]}});
  w.rec=()=>w.recs[w.recs.length-1];
  w.advance=async(ms)=>{const until=w.clock+ms;
    for(;;){w.timers.sort((a,b)=>a.at-b.at);const t=w.timers[0];if(!t||t.at>until)break;
      w.timers.shift();w.clock=t.at;if(t.every){t.at+=t.every;w.timers.push(t);}t.f();for(let i=0;i<5;i++)await Promise.resolve();}
    w.clock=until;};
  /* Chrome の順：onerror → onend。 */
  w.fail=async(code,afterMs)=>{await w.advance(afterMs);const r=w.rec();r.onerror({error:code});if(r.onend)r.onend();};
  w.names=()=>w.logs.map(l=>l.m);
  /* 入力レベル。segAttachMeter が80msごとに書く SEG.voice の代わり。 */
  w.sound=(on)=>{w.soundOn=on;};
  const tick={at:w.clock+80,every:80,f:()=>{ctx.SEG.voice.B={talking:!!w.soundOn,at:w.clock,last:w.soundOn?w.clock:0};}};w.timers.push(tick);
  return w;
}

const tests=[];const test=async(n,f)=>{await f();tests.push(n);};
(async()=>{
await test('a quick network loop on the tab track switches to a mono relay track',async()=>{
  const w=world({addon:true});const e=w.engine();e.start();
  assert.equal(w.lastStart.id,'tab-1');
  await w.fail('network',150);await w.advance(470);
  assert.equal(w.lastStart.id,'tab-1','one quick failure is not enough to switch');
  await w.fail('network',150);
  assert.ok(e.relay,'the second quick failure makes a relay');
  assert.equal(w.contexts[0].sampleRate,16000);
  await w.advance(820);
  assert.match(String(w.lastStart.id),/^relay-/,'the restart passes the relay track');
  const start=w.logs.filter(l=>l.m==='track-start').pop().d;
  assert.equal(start.relay,true);assert.equal(start.addon,true);
  assert.equal(e.track.id,'tab-1','the original track is still the one checked for liveness');
});
await test('when the relay also fails quickly the engine stops and says why',async()=>{
  const w=world({addon:true});const e=w.engine();e.start();
  await w.fail('network',150);await w.advance(470);
  await w.fail('network',150);await w.advance(820);
  await w.fail('network',150);await w.advance(1170);
  await w.fail('network',150);
  assert.equal(e.dead,true);
  assert.equal(w.recs.length,1,'one recognizer is reused');
  const starts=w.names().filter(n=>n==='track-start').length;
  await w.advance(10000);
  assert.equal(w.names().filter(n=>n==='track-start').length,starts,'no more restarts after stopping');
  assert.equal(w.toasts.length,1);
  assert.match(w.toasts[0],/アドオンのタブ音声/);assert.match(w.toasts[0],/network/);
  assert.match(w.toasts[0],/gpt-4o-mini-transcribe/);assert.match(w.toasts[0],/画面共有/);
  assert.equal(w.contexts[0].closed,true,'the relay context is closed');
  const f=w.logs.find(l=>l.m==='track-FAIL').d;assert.equal(f.relay,true);assert.equal(f.addon,true);
});
await test('a screen-share track gets the generic message',async()=>{
  const w=world({addon:false});const e=w.engine();e.start();
  for(const wait of [470,820,1170]){await w.fail('network',150);await w.advance(wait);}
  await w.fail('network',150);
  assert.equal(e.dead,true);assert.doesNotMatch(w.toasts[0],/アドオン/);assert.match(w.toasts[0],/ネットワーク/);
});
await test('once speech was heard, network errors keep the old retry and never stop',async()=>{
  const w=world({addon:true});const e=w.engine();e.start();
  await w.advance(300);w.rec().onresult({resultIndex:0,results:[]});
  assert.ok(w.names().includes('track-heard'));
  let wait=470;
  for(let i=0;i<8;i++){await w.fail('network',150);await w.advance(wait);wait=Math.min(3000,wait+350);}
  assert.equal(e.dead,false);assert.equal(e.relay,null);assert.equal(w.toasts.length,0);
  assert.equal(w.lastStart.id,'tab-1');
});
await test('a slow network error is not a start-up failure and resets the count',async()=>{
  const w=world({addon:true});const e=w.engine();e.start();
  await w.fail('network',150);await w.advance(470);
  await w.fail('network',4000);await w.advance(820);
  await w.fail('network',150);await w.advance(1170);
  assert.equal(e.relay,null,'quick, slow, quick is not two quick failures in a row');
  await w.fail('network',150);
  assert.ok(e.relay);
});
await test('no-speech and aborted do not count',async()=>{
  const w=world({addon:true});const e=w.engine();e.start();
  await w.fail('network',150);await w.advance(470);
  for(let i=0;i<3;i++){await w.fail('no-speech',100);await w.advance(200);}
  assert.equal(e.relay,null);
});
await test('a relay context that will not run stops instead of feeding silence',async()=>{
  const w=world({addon:true,relayStuck:true});const e=w.engine();e.start();
  await w.fail('network',150);await w.advance(470);
  await w.fail('network',150);await w.advance(820);
  assert.equal(e.dead,true);assert.match(w.toasts[0],/アドオンのタブ音声/);
});
await test('a context that refuses 16 kHz falls back to its own rate',async()=>{
  const w=world({addon:true,rateThrows:true});const e=w.engine();e.start();
  await w.fail('network',150);await w.advance(470);
  await w.fail('network',150);
  assert.ok(e.relay);assert.equal(e.relay.ctx.sampleRate,48000);assert.equal(w.contexts[0].closed,true);
});
await test('stop releases the relay',async()=>{
  const w=world({addon:true});const e=w.engine();e.start();
  await w.fail('network',150);await w.advance(470);
  await w.fail('network',150);await w.advance(820);
  const relayTrack=e.relay.track;e.stop();
  assert.equal(relayTrack.readyState,'ended');assert.equal(w.contexts[0].closed,true);assert.equal(e.relay,null);
});
await test('permission errors still stop at once with the old message',async()=>{
  const w=world({addon:true});const e=w.engine();e.start();
  await w.fail('not-allowed',100);
  assert.equal(e.dead,true);assert.match(w.toasts[0],/not-allowed/);assert.match(w.toasts[0],/VB-CABLE/);
});
await test('sound without any result for 10 s restarts the recognizer and logs why',async()=>{
  const w=world({addon:false});const e=w.engine();e.start();w.sound(true);
  await w.advance(9000);assert.equal(w.names().filter(n=>n==='track-stall').length,0,'not yet');
  await w.advance(1600);
  const st=w.logs.find(l=>l.m==='track-stall');assert.ok(st,'stalled');
  assert.ok(st.d.soundRatio>=0.9);assert.equal(st.d.everHeard,false);
  assert.equal(w.rec().aborted,1);
  const rs=w.logs.filter(l=>l.m==='track-restart').pop();assert.ok(rs,'the abort ends the run and restarts it');
  assert.equal(rs.d.why,'stall');assert.equal(rs.d.results,0);assert.ok(rs.d.aliveMs>=10000);
  await w.advance(200);assert.equal(w.names().filter(n=>n==='track-start').length,2,'started again on the same track');
  assert.equal(w.lastStart.id,'tab-1');assert.equal(e.dead,false);
});
await test('results keep it running; silence never triggers a restart',async()=>{
  let w=world(),e=w.engine();e.start();w.sound(true);
  for(let i=0;i<8;i++){await w.advance(3000);w.rec().onresult({resultIndex:0,results:[]});}
  assert.equal(w.names().filter(n=>n==='track-stall').length,0,'a result every 3 s is a working recognizer');
  w=world();e=w.engine();e.start();w.sound(false);await w.advance(30000);
  assert.equal(w.names().filter(n=>n==='track-stall').length,0,'silence is left to Chrome (no-speech)');
  w=world();e=w.engine();e.start();
  for(let i=0;i<60;i++){w.sound(i%3===0);await w.advance(500);}
  assert.equal(w.names().filter(n=>n==='track-stall').length,0,'sound a third of the time is not enough');
});
await test('two stalls in a row show one hint about the language',async()=>{
  const w=world();const e=w.engine();e.start();w.sound(true);
  await w.advance(10600);assert.equal(w.toasts.length,0,'one stall is not enough to blame the language');
  await w.advance(21000);
  assert.equal(w.names().filter(n=>n==='track-stall').length,2);
  assert.equal(w.toasts.length,1);assert.match(w.toasts[0],/相手\(B\)の言語/);assert.match(w.toasts[0],/English/);
});
await test('sound that never becomes text (music) is retried less and less often',async()=>{
  const w=world();const e=w.engine();e.start();w.sound(true);
  const stallTimes=[];let last=0;
  for(let t=0;t<200000;t+=500){await w.advance(500);const n=w.names().filter(x=>x==='track-stall').length;
    if(n>last){stallTimes.push(w.clock);last=n;}}
  const waited=w.logs.filter(l=>l.m==='track-stall').map(l=>l.d.waitedMs);
  assert.deepEqual(waited.slice(0,5),[10000,20000,40000,60000,60000]);
  w.rec().onresult({resultIndex:0,results:[]});
  const before=w.names().filter(x=>x==='track-stall').length;
  await w.advance(10600);
  assert.equal(w.names().filter(x=>x==='track-stall').length,before+1,'a result resets the wait to 10 s');
  assert.equal(w.logs.filter(l=>l.m==='track-stall').pop().d.waitedMs,10000);
});
await test('a recognizer that does not end after abort is rebuilt',async()=>{
  const w=world({hung:true});const e=w.engine();e.start();w.sound(true);
  await w.advance(10600);assert.equal(w.recs.length,1);
  await w.advance(1600);
  assert.ok(w.names().includes('track-rebuild'));assert.equal(w.recs.length,2,'a new recognizer');
  assert.equal(w.recs[1].started[0].id,'tab-1');assert.equal(w.recs[0].onend,null,'the old one is detached');
});
await test('the restart log says what Chrome detected in that run',async()=>{
  const w=world();const e=w.engine();e.start();
  await w.advance(300);w.rec().onsoundstart();await w.advance(200);w.rec().onspeechstart();
  await w.advance(8000);w.rec().onerror({error:'no-speech'});w.rec().onend();
  const rs=w.logs.filter(l=>l.m==='track-restart').pop().d;
  assert.equal(rs.why,'no-speech');assert.equal(rs.soundAfterMs,300);assert.equal(rs.speechAfterMs,500);assert.equal(rs.results,0);
});
await test('stop and fail end the watchdog',async()=>{
  let w=world();let e=w.engine();e.start();w.sound(true);e.stop();await w.advance(30000);
  assert.equal(w.names().filter(n=>n==='track-stall').length,0);
  w=world();e=w.engine();e.start();w.sound(true);await w.fail('not-allowed',100);await w.advance(30000);
  assert.equal(w.names().filter(n=>n==='track-stall').length,0);
});
console.log(JSON.stringify({passed:tests.length,tests},null,2));
})().catch(e=>{console.error(e);process.exit(1);});
