'use strict';
/* Aivis の先読みと、文末待ちの上限の受入試験。
 *
 * 起点は実測。読み上げは1件ずつで、次の部分の合成は前の音が鳴り終わってから頼んでいた。
 * Aivis の最初の音まで0.2〜0.5秒（v1.49.26 の記録で aivis-first 760件、leadMs 150）なので、
 * 部分が替わるたびにその分の無音が挟まる。文末待ち（sentence-boundary）は平均3.4秒・最長15秒。 */
const path=require('node:path'),fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const src=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8').replace(/\r\n/g,'\n');
const lines=src.split('\n');
function block(startsWith){
  const i=lines.findIndex(l=>l.startsWith(startsWith));
  assert.ok(i>=0,'block not found: '+startsWith);
  for(let j=i+1;j<lines.length;j++) if(lines[j]==='}'||lines[j]==='};') return lines.slice(i,j+1).join('\n');
  throw new Error('unterminated: '+startsWith);
}
const line=(p)=>{const l=lines.find(l=>l.startsWith(p));assert.ok(l,'line not found: '+p);return l;};
const CODE=[line('var SEG_SENTENCE_WAIT_MAX_MS'),block('function segSentenceWaitLeft('),block('function segAivisGroup('),
  block('function segPartEndsSentence('),block('function segQueueCompare('),
  line('var AIVIS_PREFETCH_LEAD_MS'),line('var AIVIS_PREFETCH=null'),line('var AIVIS_PREFETCH_STATS'),line('function aivisPrefetchMode('),
  block('function aivisPrefetchDrop('),block('function aivisPrefetchTake('),block('function aivisPrefetchPlanned('),
  block('function segPrefetchPlan('),block('function aivisPrefetchStart('),block('function aivisPrefetchTick(')].join('\n');

function world(over={}){
  const w={clock:100000,logs:[],fetches:[]};
  const ctx={console,String,Number,Object,JSON,Math,Promise,Error,
    Date:{now:()=>w.clock},
    SEG:{queue:[],active:null,epoch:1,dispatchRate:1,cardOrder:0},
    CFG:Object.assign({ttsSrc:false,aivisStream:true,aivisPrefetch:'on'},over.cfg||{}),
    ttsGen:5,AIVIS_URL:'https://aivis.example/synth',
    window:{ReadableStream:function(){}},AbortController:function(){this.aborted=false;this.abort=()=>{this.aborted=true;};},
    dlog:(c,m,d)=>w.logs.push({c,m,d}),
    segEarlierOpen:()=>!!over.earlierOpen,segManualJobValid:()=>true,segAudioAllowed:()=>over.allowed!==false,
    segAivisVoiceKey:()=>'voice',ttsProv:()=>({segmentJapaneseBatch:true}),
    ttsShortSkipFor:()=>over.backchannel?'filler':'',segDebt:()=>0,segSilence:()=>null,segOverlapFor:()=>over.overlap||'allow',
    segPolicyFor:()=>({silence:700}),TurnDecision:{applies:()=>!!over.floor,floorHold:()=>over.floor?'safe-to-speak':null},
    aivisFallbackWait:()=>0,aivisRateWait:()=>over.rateWait||0,ttsRateWaitMs:()=>0,
    aivisWindowWait:()=>0,AIVIS_RATE:{sent:new Array(over.sent||0).fill(1)},
    aivisKey:()=>'k',aivisModelFor:()=>'m',ttsAudioCtx:()=>({}),ttsCtxCanRoute:()=>true,
    segAdaptiveState:()=>({rate:1.05}),
    aivisBody:(text,seat,fmt,prosody)=>({text,seat,fmt,rate:ctx.SEG.dispatchRate}),
    aivisLimitedFetch:(url,opt,life)=>{const f={url,opt,life};f.promise=new Promise((res,rej)=>{f.resolve=res;f.reject=rej;});
      w.fetches.push(f);return f.promise;}};
  vm.createContext(ctx);vm.runInContext(CODE,ctx);
  vm.runInContext('this.P=()=>AIVIS_PREFETCH;this.setTail=(t)=>{AIVIS_STREAM_TAIL=t;};this.stats=()=>AIVIS_PREFETCH_STATS;',ctx);
  w.ctx=ctx;
  let order=0;
  w.card=(o={})=>Object.assign({id:'e'+(++order),seat:'B',srcLang:'en',dstLang:'ja',origin:null,speaker:null,prosody:null,
    segment:{order:order,cancelled:false,final:false,lastUpdate:0,text:'',mode:'balanced'}},o);
  w.job=(card,seq,text,o={})=>{const j=Object.assign({card,epoch:1,cancelled:false,
    segment:Object.assign({seq,sourceText:'src'+seq,translationText:text,translationReady:true,translationError:false,
      translatedAt:w.clock,committedAt:w.clock,end:0,commitReason:[],dispatched:false,audio:{}},o.segment||{})},o.job||{});
    ctx.SEG.queue.push(j);return j;};
  w.playing=(j,remain,recvDone=true)=>{ctx.SEG.active=j;j.group=[j];w.ctx.setTail({gen:ctx.ttsGen,recvDone,remainMs:()=>remain});};
  w.names=()=>w.logs.map(l=>l.m);
  return w;
}
const tests=[];const test=async(n,f)=>{await f();tests.push(n);};
(async()=>{
await test('the sentence wait counts from when the part became readable, and stops at 1.2 s',async()=>{
  const w=world(),c=w.ctx,e=w.card();const j=w.job(e,1,'今日は会議があって',{segment:{translatedAt:w.clock-900}});
  assert.equal(c.segSentenceWaitLeft(j,w.clock,true),300,'900 ms of the 1200 ms were spent while the previous part played');
  assert.equal(j.sentenceWaitAt,undefined,'a dry look does not start the clock');
  assert.equal(c.segSentenceWaitLeft(j,w.clock,false),300);
  assert.equal(j.sentenceWaitAt,w.clock-900);
  assert.equal(c.segSentenceWaitLeft(j,w.clock+400,false),-100);
  assert.equal(w.names().filter(n=>n==='tts-wait-capped').length,1);
  c.segSentenceWaitLeft(j,w.clock+800,false);
  assert.equal(w.names().filter(n=>n==='tts-wait-capped').length,1,'logged once');
});
await test('a part without a sentence end waits while the card grows, until the cap',async()=>{
  const w=world(),c=w.ctx,e=w.card();e.segment.lastUpdate=w.clock-200;
  const j=w.job(e,1,'今日は会議があって');
  assert.equal(c.segAivisGroup(j,false,w.clock,false).wait,true);
  assert.equal(c.segAivisGroup(j,false,w.clock+1300,false).wait,false,'past 1.2 s it is read as it is');
  e.segment.lastUpdate=w.clock-1600;
  assert.equal(c.segAivisGroup(j,false,w.clock,false).wait,false,'a card that stopped growing is not waited for');
});
await test('ready parts are grouped up to the last sentence end',async()=>{
  const w=world(),c=w.ctx,e=w.card();e.segment.lastUpdate=w.clock;
  const a=w.job(e,1,'議題は三つです。'),b=w.job(e,2,'まず予算を'),d=w.job(e,3,'確認します。'),f=w.job(e,4,'次に');
  const g=c.segAivisGroup(a,false,w.clock,false);
  assert.equal(g.wait,false);assert.deepEqual(Array.from(g.group,q=>q.segment.seq),[1,2,3]);
  assert.equal(g.target,'議題は三つです。 まず予算を 確認します。');
});
await test('no prefetch while the current audio is still arriving, or while more than the lead is left',async()=>{
  const w=world(),c=w.ctx,e=w.card();const a=w.job(e,1,'今日は会議があります。');w.job(e,2,'議題は三つです。');
  w.playing(a,800,false);c.aivisPrefetchTick(w.clock);assert.equal(w.fetches.length,0,'receiving');
  w.playing(a,c.AIVIS_PREFETCH_LEAD_MS+1);c.aivisPrefetchTick(w.clock);assert.equal(w.fetches.length,0,'too early');
  w.playing(a,c.AIVIS_PREFETCH_LEAD_MS);c.aivisPrefetchTick(w.clock);assert.equal(w.fetches.length,1);
  c.aivisPrefetchTick(w.clock+80);assert.equal(w.fetches.length,1,'one at a time');
});
await test('the prefetch asks for the part after the playing group, with the rate it will be sent at',async()=>{
  const w=world(),c=w.ctx,e=w.card({segment:{order:1,mode:'adaptive',cancelled:false,final:false,lastUpdate:0}});
  const a=w.job(e,1,'今日は会議があります。'),b=w.job(e,2,'議題は三つです。');
  w.playing(a,500);c.aivisPrefetchTick(w.clock);
  const f=w.fetches[0],body=JSON.parse(f.opt.body);
  assert.equal(body.text,'議題は三つです。');assert.equal(body.rate,1.05,'the adaptive rate goes into the body');
  assert.equal(c.SEG.dispatchRate,1,'the shared rate is restored');
  assert.equal(f.url,c.AIVIS_URL);assert.equal(f.opt.headers.Authorization,'Bearer k');
  assert.ok(!f.life.finish,'no playback lock is taken for a prefetch');
  assert.equal(c.P().jobs[0],b);
  const log=w.logs.find(l=>l.m==='aivis-prefetch').d;
  assert.equal(log.remainMs,500);assert.ok(!('text' in log),'the text is not logged twice');
});
await test('the plan declines what segPump would not send now',async()=>{
  const cases={untranslated:{job:{segment:{translationReady:false}}},error:{job:{segment:{translationError:true}}},
    empty:{text:'  '},backchannel:{over:{backchannel:true}},notAllowed:{over:{allowed:false}},
    rateLimited:{over:{rateWait:3000}},streamOff:{over:{cfg:{aivisStream:false}}},earlierOpen:{over:{earlierOpen:true}},
    floor:{over:{floor:true}},avoid:{over:{overlap:'avoid'}},browserTts:{job:{job:{forceBrowserTts:true}}},
    manualNext:{job:{job:{manual:true}}}};
  for(const [name,k] of Object.entries(cases)){
    const w=world(k.over||{}),c=w.ctx,e=w.card();const a=w.job(e,1,'今日は会議があります。');
    w.job(e,2,k.text!==undefined?k.text:'議題は三つです。',(k.job&&k.job)||{});
    w.playing(a,500);c.aivisPrefetchTick(w.clock);
    assert.equal(w.fetches.length,0,name);
  }
  const w=world(),c=w.ctx,e=w.card();const a=w.job(e,1,'今日は会議があります。',{job:{manual:true}});w.job(e,2,'議題は三つです。');
  w.playing(a,500);c.aivisPrefetchTick(w.clock);assert.equal(w.fetches.length,0,'nothing is prefetched behind a manual replay');
});
await test('a part still waiting for its sentence end is not prefetched',async()=>{
  const w=world(),c=w.ctx,e=w.card();e.segment.lastUpdate=w.clock;
  const a=w.job(e,1,'今日は会議があります。');w.job(e,2,'議題は三つあって');
  w.playing(a,500);c.aivisPrefetchTick(w.clock);assert.equal(w.fetches.length,0);
});
await test('the prefetched response is handed over only for the exact same body',async()=>{
  const w=world(),c=w.ctx,e=w.card();const a=w.job(e,1,'今日は会議があります。');w.job(e,2,'議題は三つです。');
  w.playing(a,500);c.aivisPrefetchTick(w.clock);
  const key=c.P().key;
  assert.equal(c.aivisPrefetchTake(key+' '),null);assert.equal(c.P(),null);
  assert.equal(c.stats().drops['body-changed'],1);
  w.fetches.length=0;c.aivisPrefetchTick(w.clock);
  w.clock+=300;const p=c.aivisPrefetchTake(c.P().key);
  assert.ok(p);assert.equal(c.P(),null);assert.equal(c.stats().hit,1);
  const hit=w.logs.filter(l=>l.m==='aivis-prefetch-hit').pop().d;assert.equal(hit.ageMs,300);assert.equal(hit.headersReady,false);
});
await test('a stop between prefetch and dispatch discards it',async()=>{
  const w=world(),c=w.ctx,e=w.card();const a=w.job(e,1,'今日は会議があります。');w.job(e,2,'議題は三つです。');
  w.playing(a,500);c.aivisPrefetchTick(w.clock);const key=c.P().key,ctrl=c.P().ctrl;
  c.ttsGen++;assert.equal(c.aivisPrefetchTake(key),null);assert.equal(c.stats().drops.stopped,1);assert.equal(ctrl.aborted,true);
});
await test('segPump reuses the prefetched group while its texts are unchanged',async()=>{
  const w=world(),c=w.ctx,e=w.card();const a=w.job(e,1,'今日は会議があります。'),b=w.job(e,2,'議題は三つです。');
  w.playing(a,500);c.aivisPrefetchTick(w.clock);
  const late=w.job(e,3,'まず予算を確認します。');
  c.SEG.active=null;c.SEG.queue.splice(0,1);
  const g=c.aivisPrefetchPlanned(b,false);
  assert.ok(g,'still valid');assert.deepEqual(Array.from(g.group,q=>q.segment.seq),[2],'a part that arrived later is left for the next request');
  assert.equal(g.rate,1);assert.equal(g.target,'議題は三つです。');
  assert.ok(c.P(),'kept for aivisSpeakStream to take');
});
await test('a retranslated part or a different head discards the prefetch',async()=>{
  let w=world(),c=w.ctx,e=w.card();let a=w.job(e,1,'今日は会議があります。'),b=w.job(e,2,'議題は三つです。');
  w.playing(a,500);c.aivisPrefetchTick(w.clock);
  b.segment.translationText='議題は3つです。';
  assert.equal(c.aivisPrefetchPlanned(b,false),null);assert.equal(c.stats().drops['text-changed'],1);
  w=world();c=w.ctx;e=w.card();a=w.job(e,1,'今日は会議があります。');b=w.job(e,2,'議題は三つです。');
  w.playing(a,500);c.aivisPrefetchTick(w.clock);
  assert.equal(c.aivisPrefetchPlanned(a,false),null);assert.equal(c.stats().drops['plan-changed'],1);
});
await test('an unused, stale or switched-off prefetch is dropped by the tick',async()=>{
  const reasons={};
  for(const [why,act] of Object.entries({expired:(w,c)=>{w.clock+=c.AIVIS_PREFETCH_MAX_AGE_MS+1;},
      reset:(w,c)=>{c.SEG.epoch++;},stopped:(w,c)=>{c.ttsGen++;},unused:(w,c)=>{c.P().jobs[0].segment.dispatched=true;},
      off:(w,c)=>{c.CFG.aivisPrefetch='off';}})){
    const w=world(),c=w.ctx,e=w.card();const a=w.job(e,1,'今日は会議があります。');w.job(e,2,'議題は三つです。');
    w.playing(a,500);c.aivisPrefetchTick(w.clock);assert.ok(c.P());
    act(w,c);c.aivisPrefetchTick(w.clock);
    assert.equal(c.P(),null,why);reasons[why]=c.stats().drops[why];
  }
  assert.deepEqual(reasons,{expired:1,reset:1,stopped:1,unused:1,off:1});
});
await test('a dropped prefetch whose answer already came is closed without reading it',async()=>{
  const w=world(),c=w.ctx,e=w.card();const a=w.job(e,1,'今日は会議があります。');w.job(e,2,'議題は三つです。');
  w.playing(a,500);c.aivisPrefetchTick(w.clock);
  let cancelled=false;w.fetches[0].resolve({body:{cancel:()=>{cancelled=true;return Promise.resolve();}}});
  await Promise.resolve();c.aivisPrefetchDrop('test');
  for(let i=0;i<4;i++)await Promise.resolve();
  assert.equal(cancelled,true);
});
await test('with 8 of the 10 requests of the last minute used, parts are batched as before',async()=>{
  let w=world({sent:8}),c=w.ctx,e=w.card();let a=w.job(e,1,'今日は会議があります。');w.job(e,2,'議題は三つです。');
  w.playing(a,500);c.aivisPrefetchTick(w.clock);c.aivisPrefetchTick(w.clock+80);
  assert.equal(w.fetches.length,0);assert.equal(c.stats().budget,1,'counted once per playing part');
  assert.equal(w.names().filter(n=>n==='aivis-prefetch-skip').length,1);
  w=world({sent:7});c=w.ctx;e=w.card();a=w.job(e,1,'今日は会議があります。');w.job(e,2,'議題は三つです。');
  w.playing(a,500);c.aivisPrefetchTick(w.clock);assert.equal(w.fetches.length,1,'7 used: the prefetch is the 8th');
});
await test('the setting is on unless it says off',async()=>{
  for(const [v,m] of [[undefined,'on'],['on','on'],['off','off'],['nonsense','on']]){
    const w=world({cfg:{aivisPrefetch:v}});assert.equal(w.ctx.aivisPrefetchMode(),m,String(v));}
  const w=world({cfg:{aivisPrefetch:'off'}}),c=w.ctx,e=w.card();const a=w.job(e,1,'今日は会議があります。');w.job(e,2,'議題は三つです。');
  w.playing(a,500);c.aivisPrefetchTick(w.clock);assert.equal(w.fetches.length,0);
});
await test('the stream takes the prefetch by its exact body and keeps the one-at-a-time lock',async()=>{
  const fn=block('function aivisSpeakStream(');
  assert.match(fn,/var bodyJson = JSON\.stringify\(body\), pre = aivisPrefetchTake\(bodyJson\);/);
  assert.match(fn,/if \(pre\)\{ finish\.armPhase\('synthesis', guardMs\); armStreamWatchdog\(\); \}/);
  assert.match(fn,/tail\.recvDone = true;/);
  assert.match(fn,/if \(AIVIS_STREAM_TAIL === tail\) AIVIS_STREAM_TAIL = null;/);
  assert.match(block('function segPump(){'),/^  if\(SEG\.active\|\|ttsIsBusy\(\)\)return;/m,'playback is still one at a time');
  assert.match(block('function stopSpeaking(why){'),/ttsGen\+\+;[^\n]*\n  aivisPrefetchDrop\('stopped'\);/);
});
console.log(JSON.stringify({passed:tests.length,tests},null,2));
})().catch(e=>{console.error(e);process.exit(1);});
