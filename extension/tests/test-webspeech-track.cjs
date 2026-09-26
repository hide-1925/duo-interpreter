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
const CODE=['var WEB_TRACK_QUICK_MS','function WebSpeechTrackEngine(','WebSpeechTrackEngine.prototype.addonTrack=',
  'WebSpeechTrackEngine.prototype.useRelay=','WebSpeechTrackEngine.prototype.dropRelay=','WebSpeechTrackEngine.prototype.quickFail=',
  'WebSpeechTrackEngine.prototype.start=','WebSpeechTrackEngine.prototype.startSameTrack=','WebSpeechTrackEngine.prototype.fail=',
  'WebSpeechTrackEngine.prototype.build=','WebSpeechTrackEngine.prototype.stop=']
  .map(p=>p.startsWith('var ')?lines.find(l=>l.startsWith(p)):block(p)).join('\n');

function world(opts={}){
  const w={clock:1000,timers:[],logs:[],toasts:[],recs:[],contexts:[]};
  class Track{constructor(id){this.id=id;this.kind='audio';this.readyState='live';}stop(){this.readyState='ended';}}
  class SR{constructor(){w.recs.push(this);this.started=[];}
    start(t){this.started.push(t);w.lastStart=t;}abort(){this.aborted=true;}stop(){}}
  class AC{constructor(o){if(opts.rateThrows&&o&&o.sampleRate)this.bad=true;this.sampleRate=o&&o.sampleRate||48000;
      this.state='suspended';this.closed=false;w.contexts.push(this);}
    createMediaStreamSource(){if(this.bad)throw new Error('rate');return {connect(){},disconnect(){}};}
    createMediaStreamDestination(){const t=new Track('relay-'+w.contexts.length);return {stream:{getAudioTracks:()=>[t]}};}
    resume(){this.state=opts.relayStuck?'suspended':'running';return Promise.resolve();}
    close(){this.closed=true;this.state='closed';return Promise.resolve();}}
  const ctx={console,String,Object,JSON,Math,Promise,Error,
    Date:{now:()=>w.clock},
    setTimeout:(f,ms)=>{w.timers.push({at:w.clock+ms,f});return w.timers.length;},clearTimeout(){},
    SR,MediaStream:function(t){this.t=t;},S:{running:true},CFG:{interimOn:false},
    window:{AudioContext:AC,__duoTabAudio:opts.addon?{isActive:()=>true}:undefined},
    dlog:(c,m,d)=>w.logs.push({m,d}),toast:(t)=>w.toasts.push(t),
    segAttachMeter(){},segDetachMeter(){},segWebEnd(){},segWebResult:()=>true,
    L:()=>({sr:'en-US'}),langOf:()=>'en',overlayChromeMajor:()=>153,removeEntry(){}};
  vm.createContext(ctx);vm.runInContext(CODE,ctx);
  w.ctx=ctx;w.Track=Track;
  w.engine=(track)=>new ctx.WebSpeechTrackEngine('B',track||new Track('tab-1'),{ownsStream:true,stream:{getTracks:()=>[]}});
  w.rec=()=>w.recs[w.recs.length-1];
  w.advance=async(ms)=>{const until=w.clock+ms;
    for(;;){w.timers.sort((a,b)=>a.at-b.at);const t=w.timers[0];if(!t||t.at>until)break;
      w.timers.shift();w.clock=t.at;t.f();for(let i=0;i<5;i++)await Promise.resolve();}
    w.clock=until;};
  /* Chrome の順：onerror → onend。 */
  w.fail=async(code,afterMs)=>{await w.advance(afterMs);const r=w.rec();r.onerror({error:code});if(r.onend)r.onend();};
  w.names=()=>w.logs.map(l=>l.m);
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
console.log(JSON.stringify({passed:tests.length,tests},null,2));
})().catch(e=>{console.error(e);process.exit(1);});
