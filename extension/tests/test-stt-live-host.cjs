'use strict';
/* SttLiveHost（ストリーミング型 STT の共通部分）の検査。STTマルチプロバイダ開発仕様書 §6・§11・§15。
 * - partial は区間の全文。書き換えのときも閉じたカードを壊さず、残りを開いているカードへ出す
 * - 計測（TTFP・TTTR・PRR）は本文を持たず、時刻と字数だけで記録する
 * - 新しい Provider は自分のキーだけを使い、翻訳のキーを借りない（INV-STT-07）
 * - 性能設定は選択肢に無い値を既定へ戻す
 * Provider の接続は偽の Adapter（fake）で置き換え、受信を直接流す。 */
const path=require('node:path'),fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const src=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8').replace(/\r\n/g,'\n');
const lines=src.split('\n');
function block(startsWith){
  const i=lines.findIndex(l=>l.startsWith(startsWith));
  assert.ok(i>=0,'block not found: '+startsWith);
  if(/\}\s*;?\s*$/.test(lines[i])&&lines[i].split('{').length===lines[i].split('}').length)return lines[i];
  for(let j=i+1;j<lines.length;j++) if(lines[j]==='}'||lines[j]==='};') return lines.slice(i,j+1).join('\n');
  throw new Error('unterminated: '+startsWith);
}
const line=(p)=>{const l=lines.find(l=>l.startsWith(p));assert.ok(l,'line not found: '+p);return l;};
function region(from,to){
  const a=lines.findIndex(l=>l.startsWith(from)),b=lines.findIndex((l,i)=>i>a&&l.startsWith(to));
  assert.ok(a>=0&&b>a,'region not found: '+from+' .. '+to);
  return lines.slice(a,b).join('\n');
}
const CODE=[line('var SEG_PERIOD_WAIT_MS'),block('function segPeriodHold('),block('function segEnabled()'),
  block('function segSemanticTail(text,lang){'),block('function segSemanticDecision(input){'),
  block('function segInit('),block('function segJoin('),block('function segReceiveDisplay('),
  block('function segUpdate('),block('function segDraft('),block('function segCheck('),
  lines.find(l=>l.startsWith('var STT_FALLBACK_TARGETS=')),block('var STT_LIVE_CHOICES={'),region('function isLiveTranscribe(){','/* ── 設定欄（開発仕様書 §10）'),
  region('function segLiveClose(','function segFinalizeEntry(')].join('\n');

function world(segmentMode){
  const w={entries:[],logs:[],calls:[],now:100000};let n=0;
  const ctx={console,String,Number,Object,JSON,Math,Array,Promise,Error,isFinite,RegExp,Uint32Array,
    Date:{now:()=>w.now},setTimeout:()=>0,clearTimeout:()=>{},setInterval:()=>0,clearInterval:()=>{},
    S:{running:true,entries:w.entries,autoMode:false,listenSeat:'A'},sessionGen:1,
    CFG:{langA:'ja',langB:'en',sttProvider:'openai',sttModel:'gpt-live-transcribe',prosodyOn:false,vad:35,
      segmentMode,segmentBoundary:'semantic',glossary:[],ctx:''},
    SEG:{cards:[],cardOrder:0,epoch:1,queue:[],committed:0,committedBySource:{},received:{},lastReason:''},
    addEntry:(seat,text,interim)=>{const e={id:'e'+(++n),seat,srcText:text,dstText:'',interim,srcLang:seat==='A'?'en':'ja',dstLang:seat==='A'?'ja':'en',startedAt:w.now};w.entries.push(e);return e;},
    removeEntry:(e)=>{const i=w.entries.indexOf(e);if(i>=0)w.entries.splice(i,1);if(e.segment)e.segment.cancelled=true;},
    /* 本物の render は duoSttTiming で最初の partial の時刻を付ける。 */
    render:(e)=>{if(e.srcText&&!e.firstPartialAt)e.firstPartialAt=w.now;},
    speakSrcNow:()=>{},translate:(e)=>w.calls.push(['translate',e.id,e.srcText]),
    segWake:()=>{},segObserveTempo:()=>{},TurnTrace:{text(){}},
    segReviseCommittedSource:(e,s,r)=>{if(r!==s.sourceText){s.sourceText=r;s.revised=true;}},
    segCurrentTranslation:()=>false,translationDisabled:()=>false,
    segDebt:()=>0,segPolicyFor:()=>({min:12,max:48,stability:400,silence:700,debt:8,mode:'balanced'}),segBackpressure:()=>false,
    segSilence:()=>null,segApplyMark:()=>false,segEchoCandidate:()=>false,duoAutomaticAllowed:()=>true,
    segVoice:()=>{},duoSpeakerUpdate:()=>{},duoSpeakerPaint:()=>{},duoLiveAssignSeat:()=>{},updateStatus:()=>{},
    dlog:(c,m,d)=>w.logs.push({c,m,d:JSON.parse(JSON.stringify(d===undefined?null:d))}),
    hasSpeechContent:(x)=>/[\p{L}\p{N}]/u.test(String(x||'')),isEcho:()=>false,
    punctuateTranscript:(t)=>String(t||''),guessSeatFromText:()=>'A',attachProsody:()=>{},micProsodySnapshot:()=>null,
    toast:()=>{},realtimeEscape:(x)=>x,
    langOf:(seat)=>seat==='A'?'en':'ja',micSeats:()=>['A'],duoShouldAutoDetectInput:()=>false,
    KEYS:{},keyOf:(p)=>String(ctx.KEYS[p]||'').trim(),transKey:()=>'translation-key-value',
    sttKey:()=>String(ctx.KEYS['stt:'+ctx.CFG.sttProvider]||'').trim()||ctx.keyOf(ctx.CFG.sttProvider)||ctx.transKey()};
  ctx.TurnDecision={rules:(i)=>ctx.segSemanticDecision(i),boundary:(e,s,i,r)=>r,
    liveClose:()=>false,liveClosed:()=>{},liveResumed:()=>{}};
  vm.createContext(ctx);
  vm.runInContext(CODE,ctx);
  /* 偽の Adapter。受信はすでに正規化イベントの配列として渡す。 */
  vm.runInContext(`STT_LIVE_PROVIDERS.fake={id:'fake',label:'Fake',defaultModel:'fake-rt',transport:'websocket',
    caps:{endpoint:'turn',stable:'tokens'},model:function(){return 'fake-rt';},performance:function(){return {level:0};},classify:function(){return 'transient';},
    map:function(st,raw){return raw;}};`,ctx);
  return {w,ctx,
    host(provider){return vm.runInContext('new SttLiveHost('+JSON.stringify(provider||'fake')+',"A",null,{})',ctx);},
    tick(h,ms){w.now+=ms;h.checkBoundaries();w.entries.forEach(e=>{if(e.segment)ctx.segCheck(e);});}};
}
const J=(x)=>JSON.parse(JSON.stringify(x));
const tests=[];
/* 自動フォールバックの検査は Promise を待つので、すべての検査を順に鎖でつなぐ。 */
let chain=Promise.resolve();
const test=(name,fn)=>{chain=chain.then(()=>fn()).then(()=>{tests.push(name);});};

test('a partial that rewrites shown text replaces it instead of appending (segment layer on)',()=>{
  const r=world('balanced'),h=r.host();
  h.onMessage([{type:'partial',key:'s1',text:'control value',stableChars:0}]);r.tick(h,100);
  h.onMessage([{type:'partial',key:'s1',text:'control valve opens',stableChars:8}]);r.tick(h,100);
  assert.equal(r.w.entries.length,1);
  assert.equal(r.w.entries[0].segment.text,'control valve opens');
  h.onMessage([{type:'committed',key:'s1',text:'control valve opens.'},{type:'endpoint',key:'s1',reason:'semantic'}]);
  for(let k=0;k<5;k++)r.tick(h,80);
  assert.equal(r.w.entries[0].segment.text,'control valve opens.');
  assert.equal(r.w.entries[0].segment.final,true);
  assert.deepEqual(Object.keys(h.items),[]);
});
test('a rewrite before a card the device already closed is mapped, not duplicated',()=>{
  const r=world('balanced'),h=r.host();
  h.onMessage([{type:'partial',key:'s1',text:'We start the test.'}]);
  for(let k=0;k<25;k++)r.tick(h,80);           /* closes on the text timeout (no meter) */
  assert.equal(r.w.entries[0].segment.final,true,'the first card must have closed');
  h.onMessage([{type:'partial',key:'s1',text:'We start the test. Then stop'}]);r.tick(h,80);
  h.onMessage([{type:'partial',key:'s1',text:'We started the test. Then stop it'}]);r.tick(h,80);
  assert.equal(r.w.entries.length,2);
  assert.equal(r.w.entries[1].segment.text,' Then stop it');
  h.onMessage([{type:'committed',key:'s1',text:'We started the test. Then stop it.'}]);
  for(let k=0;k<5;k++)r.tick(h,80);
  assert.deepEqual(r.w.entries.map(e=>e.segment.text),['We started the test.',' Then stop it.']);
});
test('a rewrite with the segment layer off keeps the finalized part and shows the rest',()=>{
  const r=world('off'),h=r.host();
  h.onMessage([{type:'partial',key:'t',text:'Hello there'}]);r.tick(h,100);
  h.onMessage([{type:'partial',key:'t',text:'Hello, there!'}]);r.tick(h,100);
  assert.equal(r.w.entries[0].srcText,'Hello, there!');
  h.onMessage([{type:'committed',key:'t',text:'Hello, there!'}]);r.tick(h,80);
  assert.deepEqual(J(r.w.calls),[['translate','e1','Hello, there!']]);
});
test('metrics: TTFP, TTTR and the partial revision rate are measured from the device speech start',()=>{
  const r=world('balanced'),h=r.host();
  h.boundaryAn={};h.lastVoiceAt=r.w.now-1000;          /* a meter exists; silence before */
  r.ctx.sttLiveVoice(h,r.w.now);h.lastVoiceAt=r.w.now;  /* speech starts now */
  const t0=r.w.now;
  r.w.now+=300;h.onMessage([{type:'partial',key:'k',text:'I want to'}]);
  r.w.now+=200;h.onMessage([{type:'partial',key:'k',text:'I want to know the'}]);
  r.w.now+=200;h.onMessage([{type:'partial',key:'k',text:'I want to go to the station.'}]);
  h.boundaryAn=null;
  for(let k=0;k<30;k++)r.tick(h,80);
  const m=r.w.logs.filter(l=>l.m==='live-metrics').map(l=>l.d);
  assert.equal(m.length,1,'one metrics row per card');
  assert.equal(m[0].ttfp,300);
  assert.ok(m[0].tttr>=300&&m[0].tttr<=3200,'tttr is the first commit after speech start: '+m[0].tttr);
  assert.equal(m[0].partials,3);
  assert.equal(m[0].revisions,1,'"know the" was replaced once');
  assert.equal(m[0].prr,+(8/'I want to go to the station.'.length).toFixed(3));
  assert.equal(m[0].provider,'fake');
  assert.ok(!JSON.stringify(m[0]).includes('station'),'metrics never carry the text');
  assert.equal(r.w.now>t0,true);
});
test('metrics wait for the first commit before recording TTTR, and give up after 10 seconds',()=>{
  const r=world('balanced'),h=r.host();
  const e=r.ctx.addEntry('A','',true);r.ctx.sttLiveMetricsOpen(h,e);e.segment={};e.segments=[];
  r.ctx.sttLiveMetricsClose(h,e,'semantic',false);
  assert.equal(r.w.logs.filter(l=>l.m==='live-metrics').length,0,'still waiting for a commit');
  r.w.now+=10001;r.ctx.sttLiveMetricsFlush(h,r.w.now,false);
  const m=r.w.logs.filter(l=>l.m==='live-metrics').map(l=>l.d);
  assert.equal(m.length,1);assert.equal(m[0].tttr,null);
});
test('a new provider never borrows the translation key or another company key',()=>{
  const r=world('balanced');
  r.ctx.KEYS.openai='openai-key-value';
  assert.equal(r.ctx.sttLiveKey('assemblyai'),'');
  assert.equal(r.ctx.sttLiveKey('soniox'),'');
  assert.equal(r.ctx.sttLiveKey('elevenlabs'),'');
  r.ctx.KEYS.eleven='eleven-tts-key';
  assert.equal(r.ctx.sttLiveKey('elevenlabs'),'eleven-tts-key','same company: the TTS key may be used');
  r.ctx.KEYS['stt:elevenlabs']='eleven-stt-key';
  assert.equal(r.ctx.sttLiveKey('elevenlabs'),'eleven-stt-key');
  r.ctx.KEYS['stt:soniox']=' soniox-key ';
  assert.equal(r.ctx.sttLiveKey('soniox'),'soniox-key');
  r.ctx.CFG.sttProvider='openai';
  assert.equal(r.ctx.sttLiveKey('openai'),'openai-key-value','OpenAI keeps its old lookup');
});
test('performance settings fall back to the default when the stored value is not an option',()=>{
  const r=world('balanced'),c=r.ctx.STT_LIVE_CHOICES;
  for(const [prop,spec] of Object.entries(c)){
    assert.equal(r.ctx.sttLiveChoice(prop,'no-such-value'),spec.def,prop);
    assert.ok(spec.values.some(v=>v[0]===spec.def),prop+' default must be one of its options');
    for(const v of spec.values)assert.equal(r.ctx.sttLiveChoice(prop,v[0]),v[0]);
  }
});
test('messages that arrive after stop do not reach the adapter or the cards',()=>{
  const r=world('balanced'),h=r.host();let mapped=0;
  h.adapter={...h.adapter,map:(st,raw)=>{mapped++;return raw;},close(){}};
  h.stop();
  h.onMessage([{type:'partial',key:'x',text:'late'}]);
  assert.equal(mapped,0);assert.equal(r.w.entries.length,0);
});
/* ── Phase 2〜4：カードを閉じる合図・つなぎ・切断 ───────────────────────── */
test('card close "provider": the device waits for the provider instead of its own text timeout',()=>{
  const r=world('balanced');r.ctx.CFG.sttCardClose='provider';const h=r.host();
  assert.equal(h.cardClose,'provider');
  h.onMessage([{type:'partial',key:'s1',text:'We start the test.'}]);
  for(let k=0;k<25;k++)r.tick(h,80);
  assert.equal(r.w.entries[0].segment.final,false,'first would have closed at 1.25 s; provider waits');
  h.onMessage([{type:'committed',key:'s1',text:'We start the test.',closeReason:'semantic'},{type:'endpoint',key:'s1',reason:'semantic'}]);
  r.tick(h,80);
  assert.equal(r.w.entries[0].segment.final,true);
});
test('card close "provider": a stalled card still closes after the 6 s safety valve',()=>{
  const r=world('balanced');r.ctx.CFG.sttCardClose='provider';const h=r.host();
  h.onMessage([{type:'partial',key:'s1',text:'and then'}]);
  for(let k=0;k<70;k++)r.tick(h,80);
  assert.equal(r.w.entries[0].segment.final,false);
  for(let k=0;k<10;k++)r.tick(h,80);
  assert.equal(r.w.entries[0].segment.final,true);
});
test('card close "provider" is not offered where the provider has no per-utterance endpoint',()=>{
  const r=world('balanced');r.ctx.CFG.sttCardClose='provider';
  assert.equal(r.host('openai').cardClose,'first','gpt-live completed can be very late');
  r.ctx.CFG.sttElevenLabsCommitStrategy='manual';
  assert.equal(r.host('elevenlabs').cardClose,'first','manual commit means Duo gives the boundary');
  r.ctx.CFG.sttElevenLabsCommitStrategy='vad';
  assert.equal(r.host('elevenlabs').cardClose,'provider');
  r.ctx.CFG.sttCardClose='bogus';assert.equal(r.host().cardClose,'first');
});
test('card close "duo": provider segments are joined and only the device closes the card',()=>{
  const r=world('balanced');r.ctx.CFG.sttCardClose='duo';const h=r.host();
  h.onMessage([{type:'partial',key:'s1',text:'The valve'}]);r.tick(h,80);
  h.onMessage([{type:'committed',key:'s1',text:'The valve opens.'},{type:'endpoint',key:'s1',reason:'semantic'}]);r.tick(h,80);
  assert.equal(r.w.entries.length,1);assert.equal(r.w.entries[0].segment.final,false,'the provider endpoint does not close it');
  h.onMessage([{type:'partial',key:'s2',text:'Then'}]);r.tick(h,80);
  assert.equal(r.w.entries[0].segment.text,'The valve opens. Then','joined with one space');
  for(let k=0;k<45;k++)r.tick(h,80);          /* "Then" reads as continuing: the 3 s wait */
  assert.equal(r.w.entries[0].segment.final,true);
  h.onMessage([{type:'committed',key:'s2',text:'Then stop.'}]);for(let k=0;k<30;k++)r.tick(h,80);
  assert.deepEqual(r.w.entries.map(e=>e.segment.text),['The valve opens. Then',' stop.']);
  assert.equal(h.stitched.base,'','once everything is in closed cards the joined text starts over');
});
test('card close "duo": a card the device closed early is corrected by the provider\'s final text',()=>{
  const r=world('balanced');r.ctx.CFG.sttCardClose='duo';const h=r.host();
  h.onMessage([{type:'partial',key:'s1',text:'control value'}]);
  for(let k=0;k<30;k++)r.tick(h,80);
  assert.equal(r.w.entries[0].segment.final,true);
  h.onMessage([{type:'committed',key:'s1',text:'control valve.'}]);r.tick(h,80);
  assert.equal(r.w.entries.length,1,'no empty card for the corrected tail');
  assert.equal(r.w.entries[0].segment.text,'control valve.');
});
test('a card whose provisional text is withdrawn is removed rather than left empty',()=>{
  const r=world('balanced'),h=r.host('soniox');
  h.onMessage(JSON.stringify({tokens:[{text:'Hel',is_final:false}]}));
  assert.equal(r.w.entries.length,1);
  h.onMessage(JSON.stringify({tokens:[]}));
  assert.equal(r.w.entries.length,0);
});
test('soniox through the host: tokens become one card per <end>, without the markers',()=>{
  const r=world('balanced'),h=r.host('soniox'),t=(x,f)=>({text:x,is_final:!!f,confidence:1});
  h.onMessage(JSON.stringify({tokens:[t('The'),t(' control')]}));r.tick(h,80);
  h.onMessage(JSON.stringify({tokens:[t('The',1),t(' control',1),t(' valve',1),t(' opens.',1),t('<end>',1),t(' Then',0)]}));
  for(let k=0;k<3;k++)r.tick(h,80);
  assert.deepEqual(r.w.entries.map(e=>[e.segment.text,e.segment.final]),[['The control valve opens.',true],['Then',false]]);
  assert.ok(!r.w.entries.some(e=>/<end>|<fin>/.test(e.segment.text)));
});
test('errors: auth and config are shown; others are only remembered for the reconnect decision',()=>{
  const r=world('balanced'),h=r.host(),toasts=[];r.ctx.toast=(m)=>toasts.push(m);
  h.adapter=Object.assign({},h.adapter,{classify:(e)=>e.code==='bad-key'?'auth':'transient'});
  h.onMessage([{type:'error',code:'blip',message:'hiccup'}]);
  assert.equal(toasts.length,0);assert.equal(h.lastErrorClass,'transient');
  h.onMessage([{type:'error',code:'bad-key',message:'nope'}]);
  assert.equal(toasts.length,1);assert.equal(h.lastErrorClass,'auth');
  const fail=r.w.logs.filter(l=>l.m==='live-FAIL').map(l=>l.d);
  assert.equal(fail[1].errorClass,'auth');assert.equal(fail[1].provider,'fake');
});
test('an unexpected close closes the open card and reconnects at most 3 times a minute',()=>{
  const r=world('balanced'),h=r.host(),toasts=[],timers=[];
  r.ctx.toast=(m)=>toasts.push(m);r.ctx.setTimeout=(f,ms)=>{timers.push(ms);return timers.length;};
  h.onMessage([{type:'partial',key:'s1',text:'half a sentence'}]);
  h.onSocketClose({code:1006,reason:''});
  assert.equal(r.w.entries[0].segment.final,true,'the text so far is kept as a closed card');
  assert.equal(r.w.entries[0].segment.finalReason,'reconnect');
  h.onSocketClose({code:1006,reason:''});h.onSocketClose({code:1006,reason:''});
  assert.deepEqual(timers,[500,1000,2000]);
  h.onSocketClose({code:1006,reason:''});
  assert.equal(timers.length,3,'no fourth attempt within a minute');
  assert.match(toasts[toasts.length-1],/3回/);
  r.w.now+=61000;h.onSocketClose({code:1006,reason:''});assert.equal(timers.length,4,'the window slides');
});
test('a close after an auth or config error does not reconnect',()=>{
  const r=world('balanced'),h=r.host(),toasts=[],timers=[];
  r.ctx.toast=(m)=>toasts.push(m);r.ctx.setTimeout=(f,ms)=>{timers.push(ms);return 1;};
  h.lastErrorClass='auth';h.onSocketClose({code:1000,reason:''});
  assert.equal(timers.length,0);assert.match(toasts[0],/キーか権限/);
});
test('joining provider segments puts a space only between words of space-separated languages',()=>{
  const r=world('balanced'),j=r.ctx.sttLiveJoin;
  assert.equal(j('The valve opens.','Then'),'The valve opens. Then');
  assert.equal(j('今日は晴れです。','明日は'),'今日は晴れです。明日は');
  assert.equal(j('control valve','の stroke'),'control valveの stroke');
  assert.equal(j('Hello ','world'),'Hello world');assert.equal(j('','x'),'x');assert.equal(j('x',''),'x');
});
/* ── 自動フォールバック（§14.3・D-3）─────────────────────────────────
   本物の Adapter の connect と close だけを差し替え、つながる・つながらないを決める。 */
function fbWorld(opts){
  const r=world('balanced'),c=r.ctx,calls=[],toasts=[];
  c.toast=(m)=>toasts.push(m);
  c.CFG.sttProvider=opts.primary||'soniox';c.CFG.sttModel='';
  Object.assign(c.CFG,opts.cfg||{});
  Object.assign(c.KEYS,opts.keys||{'stt:soniox':'soniox-account-key','stt:assemblyai':'aai-account-key','stt:elevenlabs':'el-account-key','stt:openai':'openai-account-key'});
  for(const id of ['openai','elevenlabs','assemblyai','soniox']){
    const a=c.STT_LIVE_PROVIDERS[id];
    a.connect=function(host,key){calls.push([id,key]);const o=(opts.result||{})[id];
      if(!o)return Promise.resolve();
      const e=new Error(id+' failed');Object.assign(e,o);return Promise.reject(e);};
    a.close=function(){calls.push([id,'close']);};
  }
  const track={readyState:'live',muted:false};
  const host=(h)=>vm.runInContext('new SttLiveHost('+JSON.stringify(opts.primary||'soniox')+',"A",{getAudioTracks:function(){return [__track];}},'+JSON.stringify(h||{})+')',Object.assign(c,{__track:track}));
  return {r,c,calls,toasts,host,logs:()=>r.w.logs.filter(l=>/live-fallback/.test(l.m))};
}
const ON={sttAutoFallback:'on',sttFallback1:'assemblyai',sttFallback2:'openai',sttFallback3:'elevenlabs'};
test('fallback OFF (the default): a failed start stops with the chosen provider\'s error',async()=>{
  const f=fbWorld({result:{soniox:{status:503}}}),h=f.host();
  assert.deepEqual(J(h.plan),['soniox']);
  await assert.rejects(h.start(),/soniox failed/);
  assert.deepEqual(J(f.calls.filter(x=>x[1]!=='close')),[['soniox','soniox-account-key']]);
  assert.equal(h.provider,'soniox');assert.equal(f.logs().length,0);
});
test('fallback ON: a transient failure moves to the first backup, which then carries the session',async()=>{
  const f=fbWorld({cfg:ON,result:{soniox:{status:503}}}),h=f.host();
  assert.deepEqual(J(h.plan),['soniox','assemblyai','openai','elevenlabs']);
  await h.start();
  assert.equal(h.provider,'assemblyai');assert.equal(h.adapter,f.c.STT_LIVE_PROVIDERS.assemblyai);
  assert.deepEqual(J(f.calls),[['soniox','soniox-account-key'],['soniox','close'],['soniox','close'],['assemblyai','aai-account-key']]);
  const l=f.logs()[0].d;assert.equal(l.from,'soniox');assert.equal(l.to,'assemblyai');assert.equal(l.errorClass,'transient');
  assert.equal(l.model,'universal-3-5-pro','a backup uses its own default model, not the model field of the chosen provider');
  assert.deepEqual(J(f.c.STT_LIVE_STATS.switches),['soniox→assemblyai']);
  assert.match(f.c.sttLiveMsg('mic',h),/^Soniox につながらないため、自動フォールバックで AssemblyAI に切り替えました。<br>AssemblyAI のストリーミング認識を開始しました$/);
  assert.equal(f.c.CFG.sttProvider,'soniox','the setting is not rewritten: the next start begins with the chosen provider');
});
test('fallback ON: rate limits and an unreachable issuer (CORS or network) also move on',async()=>{
  let f=fbWorld({cfg:ON,result:{soniox:{status:429}}}),h=f.host();await h.start();assert.equal(h.provider,'assemblyai');
  f=fbWorld({cfg:ON,result:{soniox:{unreachable:true}}});h=f.host();await h.start();assert.equal(h.provider,'assemblyai');
});
test('fallback ON: auth and config errors of the chosen provider never switch (D-3)',async()=>{
  for(const o of [{status:401},{status:403},{status:400},{errorClass:'config'}]){
    const f=fbWorld({cfg:ON,result:{soniox:o}}),h=f.host();
    await assert.rejects(h.start(),/soniox failed/);assert.equal(h.provider,'soniox');assert.equal(f.logs().length,0);
  }
  const f=fbWorld({cfg:ON,keys:{'stt:assemblyai':'aai-account-key'}}),h=f.host();
  await assert.rejects(h.start(),/キーが未設定/);assert.equal(h.provider,'soniox','a missing key of the chosen provider is a setting error');
});
test('fallback ON: backups without a key are skipped, and OpenAI never receives another provider\'s key',async()=>{
  const f=fbWorld({cfg:ON,keys:{'stt:soniox':'soniox-account-key','stt:elevenlabs':'el-account-key'},result:{soniox:{status:503}}}),h=f.host();
  assert.equal(f.c.sttKey(),'soniox-account-key','sttKey() reads the chosen provider\'s field');
  assert.equal(f.c.sttLiveKey('openai'),'','so OpenAI as a backup must not use it');
  await h.start();
  assert.equal(h.provider,'elevenlabs');
  assert.deepEqual(J(f.calls.filter(x=>x[1]!=='close')),[['soniox','soniox-account-key'],['elevenlabs','el-account-key']]);
  assert.deepEqual(f.logs().filter(l=>l.m==='live-fallback-skip').map(l=>l.d.provider),['assemblyai','openai']);
  f.c.KEYS.openai='openai-translation-key';assert.equal(f.c.sttLiveKey('openai'),'openai-translation-key','the OpenAI translation key may be used');
  assert.match(f.c.sttFallbackNotice(),/assemblyai|AssemblyAI/);
});
test('fallback ON: a backup that fails for any reason hands over to the next; the last error names the chain',async()=>{
  let f=fbWorld({cfg:ON,result:{soniox:{status:503},assemblyai:{status:401}}}),h=f.host();
  await h.start();assert.equal(h.provider,'openai');assert.deepEqual(J(h.tried),['soniox','assemblyai','openai']);
  f=fbWorld({cfg:ON,result:{soniox:{status:503},assemblyai:{status:503},openai:{status:500},elevenlabs:{status:429}}});h=f.host();
  await assert.rejects(h.start(),/自動フォールバックで Soniox→AssemblyAI→OpenAI gpt-live→ElevenLabs を試しましたが、つながりませんでした（最後：elevenlabs failed）/);
});
test('fallback ON: "none", duplicates and the chosen provider are dropped from the order',()=>{
  const f=fbWorld({cfg:{sttAutoFallback:'on',sttFallback1:'soniox',sttFallback2:'',sttFallback3:'assemblyai'}});
  assert.deepEqual(J(f.host().plan),['soniox','assemblyai']);
  f.c.CFG.sttFallback2='bogus';assert.deepEqual(J(f.host().plan),['soniox','assemblyai'],'values outside the list are ignored');
  f.c.CFG.sttAutoFallback='off';assert.deepEqual(J(f.host().plan),['soniox']);
});
test('fallback ON: after 3 reconnects in a minute the session moves to the backup instead of stopping',async()=>{
  const f=fbWorld({cfg:ON}),h=f.host(),timers=[];f.c.setTimeout=(fn,ms)=>{timers.push(ms);return timers.length;};
  await h.start();assert.equal(h.provider,'soniox');
  f.c.STT_LIVE_PROVIDERS.soniox.map=(st,raw)=>raw;      /* 受信は正規化イベントのまま流す */
  h.onMessage([{type:'partial',key:'s1',text:'half a sentence'}]);
  for(let k=0;k<3;k++)h.onSocketClose({code:1006,reason:''});
  assert.deepEqual(timers,[500,1000,2000]);assert.equal(f.r.w.entries[0].segment.finalReason,'reconnect');
  h.onSocketClose({code:1006,reason:''});
  assert.equal(h.provider,'assemblyai');assert.match(f.toasts[f.toasts.length-1],/Soniox から AssemblyAI へ切り替えます/);
  assert.deepEqual(J(h.reconnects),[],'the backup gets its own reconnect budget');
  await Promise.resolve();await Promise.resolve();await Promise.resolve();
  assert.match(f.toasts[f.toasts.length-1],/自動フォールバックで AssemblyAI に切り替えました/);
});
test('fallback ON: an auth close of the chosen provider still stops; a bench (fallback:false) never switches',async()=>{
  let f=fbWorld({cfg:ON}),h=f.host();await h.start();
  h.lastErrorClass='auth';h.onSocketClose({code:1008,reason:''});
  assert.equal(h.provider,'soniox');assert.match(f.toasts[f.toasts.length-1],/キーか権限/);
  f=fbWorld({cfg:ON,result:{soniox:{status:503}}});h=f.host({fallback:false});
  await assert.rejects(h.start(),/soniox failed/);assert.equal(h.provider,'soniox');
});
test('fallback ON: gpt-live whose WebRTC connection fails mid-session moves on; OFF keeps the old message',async()=>{
  let f=fbWorld({primary:'openai',cfg:ON}),h=f.host();await h.start();
  assert.equal(h.lost('transient',{liveStage:'peer'}),true);assert.equal(h.provider,'assemblyai');
  f=fbWorld({primary:'openai'});h=f.host();await h.start();
  assert.equal(h.lost('transient',{liveStage:'peer'}),false);assert.equal(h.provider,'openai');
});
test('fallback ON with a Token Broker: backups need no key on the page and are not skipped',async()=>{
  const f=fbWorld({cfg:Object.assign({sttCredentialRoute:'broker',sttBrokerUrl:'https://broker.example.com'},ON),keys:{},result:{soniox:{status:503}}}),h=f.host();
  await h.start();
  assert.equal(h.provider,'assemblyai');assert.deepEqual(J(f.calls.filter(x=>x[1]!=='close')),[['soniox',''],['assemblyai','']]);
  assert.equal(f.logs().filter(l=>l.m==='live-fallback-skip').length,0);
});
test('diagnostics: the order, missing keys and the switches of this session',async()=>{
  const f=fbWorld({cfg:ON,keys:{'stt:soniox':'soniox-account-key','stt:assemblyai':'aai-account-key'},result:{soniox:{status:503}}});
  f.c.isLiveTranscribe=()=>false;
  await f.host().start();
  assert.equal(f.c.sttLiveFallbackSummary(),'ON / 順 soniox → assemblyai → openai(キーなし) → elevenlabs(キーなし) / 切替 soniox→assemblyai');
  f.c.CFG.sttAutoFallback='off';assert.equal(f.c.sttLiveFallbackSummary(),'OFF');
});
chain.then(()=>console.log(JSON.stringify({passed:tests.length,tests},null,2))).catch(err=>{console.error(err);process.exit(1);});
