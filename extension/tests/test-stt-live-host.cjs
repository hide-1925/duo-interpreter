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
  block('var STT_LIVE_CHOICES={'),region('function isLiveTranscribe(){','/* ── 設定欄（開発仕様書 §10）'),
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
    caps:{endpoint:'turn',stable:'tokens'},model:function(){return 'fake-rt';},performance:function(){return {level:0};},
    map:function(st,raw){return raw;}};`,ctx);
  return {w,ctx,
    host(provider){return vm.runInContext('new SttLiveHost('+JSON.stringify(provider||'fake')+',"A",null,{})',ctx);},
    tick(h,ms){w.now+=ms;h.checkBoundaries();w.entries.forEach(e=>{if(e.segment)ctx.segCheck(e);});}};
}
const J=(x)=>JSON.parse(JSON.stringify(x));
const tests=[];
const test=(name,fn)=>{fn();tests.push(name);};

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
console.log(JSON.stringify({passed:tests.length,tests},null,2));
