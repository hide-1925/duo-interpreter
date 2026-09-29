'use strict';
/* gpt-live-transcribe の経路を SttLiveHost と Adapter に分けても、挙動が v1.49.39 と
 * 同じであることの検査（STTマルチプロバイダ開発仕様書 §15 INV-STT-01）。
 *
 * 同じ DataChannel の受信列と時刻を、旧実装（fixtures/gpt-live-v1.49.39.js。
 * v1.49.39 の app.js から写したもの）と今の SttLiveHost に流し、できたカード・
 * 翻訳と読み上げの呼び出し・診断の記録を突き合わせる。segment 層の有無の両方で見る。
 * 計測（live-metrics）は新しく足した記録なので比べない。
 * あわせて、delay=low のときに送る session 設定が v1.49.39 とバイト単位で同じことを見る。 */
const path=require('node:path'),fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const src=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8').replace(/\r\n/g,'\n');
const oldSrc=fs.readFileSync(path.join(__dirname,'fixtures/gpt-live-v1.49.39.js'),'utf8');
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
const SHARED=[line('var SEG_PERIOD_WAIT_MS'),block('function segPeriodHold('),block('function segEnabled()'),
  block('function segSemanticTail(text,lang){'),block('function segSemanticDecision(input){'),
  block('function segInit('),block('function segJoin('),block('function segReceiveDisplay('),
  block('function segUpdate('),block('function segDraft('),block('function segCheck(')].join('\n');
const NEW=[block('var STT_LIVE_CHOICES={'),region('function isLiveTranscribe(){','/* ── 設定欄（開発仕様書 §10）'),
  region('function segLiveClose(','function segFinalizeEntry(')].join('\n');

function world(segmentMode,impl){
  const w={entries:[],logs:[],calls:[],now:100000};let n=0;
  const ctx={console,String,Number,Object,JSON,Math,Array,Promise,Error,isFinite,RegExp,Uint32Array,
    Date:{now:()=>w.now},setTimeout:()=>0,clearTimeout:()=>{},setInterval:()=>0,clearInterval:()=>{},
    S:{running:true,entries:w.entries,autoMode:false,listenSeat:'A'},sessionGen:1,
    CFG:{langA:'ja',langB:'en',sttProvider:'openai',sttModel:'gpt-live-transcribe',prosodyOn:false,vad:35,
      segmentMode,segmentBoundary:'semantic',glossary:[],ctx:''},
    SEG:{cards:[],cardOrder:0,epoch:1,queue:[],committed:0,committedBySource:{},received:{},lastReason:''},
    addEntry:(seat,text,interim)=>{const e={id:'e'+(++n),seat,srcText:text,dstText:'',interim,srcLang:seat==='A'?'ja':'en',dstLang:seat==='A'?'en':'ja',startedAt:w.now};w.entries.push(e);return e;},
    removeEntry:(e)=>{const i=w.entries.indexOf(e);if(i>=0)w.entries.splice(i,1);if(e.segment)e.segment.cancelled=true;w.calls.push(['remove',e.id]);},
    render:()=>{},speakSrcNow:(e)=>w.calls.push(['speak',e.id,e.srcText]),translate:(e)=>w.calls.push(['translate',e.id,e.srcText]),
    segWake:()=>{},segObserveTempo:()=>{},TurnTrace:{text(){}},
    segReviseCommittedSource:(e,s,r)=>{if(r!==s.sourceText){s.sourceText=r;s.revised=true;}},
    segCurrentTranslation:()=>false,translationDisabled:()=>false,
    segDebt:()=>0,segPolicyFor:()=>({min:12,max:48,stability:400,silence:700,debt:8,mode:'balanced'}),segBackpressure:()=>false,
    segSilence:()=>w.silence===undefined?null:w.silence,segApplyMark:()=>false,segEchoCandidate:()=>false,duoAutomaticAllowed:()=>true,
    segVoice:()=>{},duoSpeakerUpdate:()=>{},duoSpeakerPaint:()=>{},duoLiveAssignSeat:()=>{},updateStatus:()=>{},
    dlog:(c,m,d)=>w.logs.push([c,m,JSON.parse(JSON.stringify(d===undefined?null:d))]),
    hasSpeechContent:(x)=>/[\p{L}\p{N}]/u.test(String(x||'')),isEcho:()=>false,
    punctuateTranscript:(t)=>String(t||''),guessSeatFromText:()=>'A',attachProsody:()=>{},micProsodySnapshot:()=>null,
    toast:(m)=>w.calls.push(['toast',m]),realtimeEscape:(x)=>x,
    langOf:(seat)=>seat==='A'?'ja':'en',micSeats:()=>['A'],duoShouldAutoDetectInput:()=>false,
    TurnDecision:null,KEYS:{},keyOf:()=>'',transKey:()=>'',sttKey:()=>'k'};
  ctx.TurnDecision={rules:(i)=>ctx.segSemanticDecision(i),boundary:(e,s,i,r)=>r,
    liveClose:()=>false,liveClosed:()=>{},liveResumed:()=>{}};
  vm.createContext(ctx);
  vm.runInContext(SHARED+'\n'+(impl==='old'?oldSrc:NEW),ctx);
  const eng=vm.runInContext(impl==='old'?"new RealtimeTranscriptionEngine('A',null,{})":"new SttLiveHost('openai','A',null,{})",ctx);
  return {w,ctx,eng,
    send(o){const data=typeof o==='string'?o:JSON.stringify(o);if(impl==='old')eng.onEvent({data});else eng.onMessage(data);},
    tick(ms){w.now+=ms;eng.checkBoundaries();w.entries.forEach(e=>{if(e.segment)ctx.segCheck(e);});}};
}
function snapshot(r){
  const entries=r.w.entries.map(e=>({id:e.id,seat:e.seat,src:e.srcText,interim:e.interim,status:e.status||null,
    startedAt:e.startedAt,audioEndedAt:e.audioEndedAt||null,
    segText:e.segment?e.segment.text:null,final:e.segment?e.segment.final:null,finalReason:e.segment?e.segment.finalReason||null:null,
    parts:(e.segments||[]).map(s=>[s.start,s.end,s.sourceText,s.committedAt||null])}));
  const logs=r.w.logs.filter(l=>l[1]!=='live-metrics');
  return JSON.parse(JSON.stringify({entries,calls:r.w.calls,logs,items:Object.keys(r.eng.items).sort()}));
}
const delta=(item,d)=>({type:'conversation.item.input_audio_transcription.delta',item_id:item,delta:d});
const done=(item,t)=>({type:'conversation.item.input_audio_transcription.completed',item_id:item,transcript:t});
const SCENARIOS={
  'one item that closes on a sentence end, then completes':(r)=>{
    r.send({type:'input_audio_buffer.speech_started',item_id:'i1',audio_start_ms:120});
    r.send(delta('i1','今日は'));r.tick(200);r.send(delta('i1','晴れです。'));
    for(let k=0;k<20;k++)r.tick(80);
    r.send({type:'input_audio_buffer.speech_stopped',item_id:'i1'});r.send(done('i1','今日は晴れです。'));r.tick(80);
  },
  'a long item that the device closes twice before a corrected completion':(r)=>{
    r.send(delta('i2','We will'));r.tick(100);r.send(delta('i2',' start the control value test.'));
    for(let k=0;k<20;k++)r.tick(80);
    r.send(delta('i2',' Then we'));r.tick(100);r.send(delta('i2',' check the stroke time'));
    for(let k=0;k<30;k++)r.tick(80);
    r.send(delta('i2',' and log it.'));for(let k=0;k<20;k++)r.tick(80);
    r.send(done('i2','We will start the control valve test. Then we check the stroke time and log it.'));
    for(let k=0;k<5;k++)r.tick(80);
  },
  'completed without deltas, a completed that extends, and noise':(r)=>{
    r.send(done('i3','こんにちは。'));r.tick(80);
    r.send(delta('i4','もしもし'));r.tick(100);r.send(done('i4','もしもし、聞こえますか。'));r.tick(80);
    r.send(delta('i5',''));r.send('not json');r.send({type:'session.updated'});r.tick(80);
    r.send({type:'error',error:{message:'rate limited'}});r.tick(80);
  },
  'two items interleave and a delta arrives after completion':(r)=>{
    r.send(delta('a','First part'));r.send(delta('b','第二の'));r.tick(100);
    r.send(delta('a',' goes here.'));r.send(delta('b','部分です'));
    for(let k=0;k<25;k++)r.tick(80);
    r.send(done('a','First part goes here.'));r.send(delta('a',' late'));r.tick(80);
    r.send(done('b','第二の部分です。'));for(let k=0;k<5;k++)r.tick(80);
  },
  'a missing item id falls back to one running item':(r)=>{
    r.send({type:'conversation.item.input_audio_transcription.delta',delta:'No id here'});
    for(let k=0;k<30;k++)r.tick(80);
    r.send({type:'conversation.item.input_audio_transcription.completed',transcript:'No id here.'});r.tick(80);
  }
};
const tests=[];
const test=(name,fn)=>{fn();tests.push(name);};
for(const mode of ['balanced','off'])for(const [name,run] of Object.entries(SCENARIOS)){
  test('parity ('+mode+'): '+name,()=>{
    const a=world(mode,'old'),b=world(mode,'new');
    run(a);run(b);
    const sa=snapshot(a),sb=snapshot(b);
    assert.ok(sa.logs.length>0,'the scenario must produce log lines');
    assert.deepEqual(sb.entries,sa.entries,'cards differ');
    assert.deepEqual(sb.calls,sa.calls,'translate/speak/toast calls differ');
    assert.deepEqual(sb.logs,sa.logs,'diagnostic log lines differ');
    assert.deepEqual(sb.items,sa.items,'open items differ');
  });
}
test('the session sent with delay=low is byte-identical to v1.49.39',()=>{
  for(const setup of [{cfg:{},seat:'A'},{cfg:{ctx:'Steam turbine meeting',glossary:[{s:'MSV'},{s:'control valve'},{s:'<bad>'}]},seat:'B'},
                      {cfg:{langA:'ja-JP',langB:'en-US'},seat:null,auto:true}]){
    const a=world('balanced','old'),b=world('balanced','new');
    for(const r of [a,b]){Object.assign(r.ctx.CFG,setup.cfg);if(setup.auto){r.ctx.S.autoMode=true;r.ctx.micSeats=()=>['A','B'];}}
    const oldCfg=vm.runInContext('new RealtimeTranscriptionEngine('+JSON.stringify(setup.seat)+',null,{}).config()',a.ctx);
    b.ctx.CFG.sttLiveDelay='low';
    const newCfg=vm.runInContext('STT_LIVE_PROVIDERS.openai.session(new SttLiveHost("openai",'+JSON.stringify(setup.seat)+',null,{}))',b.ctx);
    assert.equal(JSON.stringify(newCfg),JSON.stringify(oldCfg));
  }
});
test('the delay setting reaches the session and falls back to low when unknown',()=>{
  const b=world('balanced','new');
  const run=(v)=>{b.ctx.CFG.sttLiveDelay=v;return vm.runInContext('STT_LIVE_PROVIDERS.openai.session(new SttLiveHost("openai","A",null,{})).audio.input.transcription.delay',b.ctx);};
  for(const v of ['minimal','low','medium','high','xhigh'])assert.equal(run(v),v);
  assert.equal(run('fastest'),'low');assert.equal(run(undefined),'low');
});
console.log(JSON.stringify({passed:tests.length,tests},null,2));
