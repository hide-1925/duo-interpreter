'use strict';
/* ElevenLabs・AssemblyAI・Soniox の Adapter の契約（STTマルチプロバイダ開発仕様書 §5・付録A2）。
 *
 * 受信列は各社の公式 SDK の型（@elevenlabs/types 0.24.0、assemblyai 4.41.5、@soniox/node 2.3.0）
 * から作ったもの。実機の記録ではない（実機での確認は 受入確認手順.md）。
 * Adapter は DOM・翻訳・読み上げ・判断層・カードに触れない（INV-STT-02）。この検査は、
 * それらの関数が無い vm で Adapter を動かすので、呼べば ReferenceError で落ちる。 */
const path=require('node:path'),fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const src=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8').replace(/\r\n/g,'\n');
const lines=src.split('\n');
function block(startsWith){
  const i=lines.findIndex(l=>l.startsWith(startsWith));
  assert.ok(i>=0,'block not found: '+startsWith);
  for(let j=i+1;j<lines.length;j++) if(lines[j]==='}'||lines[j]==='};') return lines.slice(i,j+1).join('\n');
  throw new Error('unterminated: '+startsWith);
}
function region(from,to){
  const a=lines.findIndex(l=>l.startsWith(from)),b=lines.findIndex((l,i)=>i>a&&l.startsWith(to));
  assert.ok(a>=0&&b>a,'region not found: '+from+' .. '+to);
  return lines.slice(a,b).join('\n');
}
/* sttLiveChoice から STT_LIVE_PROVIDERS の終わりまで（Host は入れない）。 */
const CODE=[block('var STT_LIVE_CHOICES={'),region('function sttLiveChoice(prop,raw){','/* ストリーミング型 STT のカード・区切り・計測・停止')].join('\n');
function world(cfg){
  const ctx={console,String,Number,Object,JSON,Math,Array,Error,isFinite,RegExp,Float32Array,Int16Array,Uint8Array,URLSearchParams,
    btoa:(s)=>Buffer.from(s,'binary').toString('base64'),
    S:{autoMode:false,listenSeat:'A'},
    CFG:Object.assign({langA:'ja',langB:'en',sttModel:'',glossary:[{s:'control valve'},{s:'MSV'},{s:'A very long technical term that exceeds'}],ctx:'Steam turbine meeting'},cfg||{}),
    KEYS:{},micSeats:()=>['A'],langOf:(seat)=>seat==='A'?'ja':'en',duoShouldAutoDetectInput:()=>false,sttKey:()=>''};
  vm.createContext(ctx);vm.runInContext(CODE,ctx);
  return ctx;
}
const J=(x)=>JSON.parse(JSON.stringify(x));
const feed=(a,msgs)=>{const st={};return {st,out:msgs.map(m=>J(a.map(st,typeof m==='string'?m:JSON.stringify(m))))};};
const host={seat:'A'};
const tests=[];
const test=(name,fn)=>{fn();tests.push(name);};

/* ── ElevenLabs ───────────────────────────────────────────── */
test('elevenlabs: partial_transcript replaces the text, never appends (計画書§26)',()=>{
  const c=world(),a=c.STT_LIVE_PROVIDERS.elevenlabs;
  const {out}=feed(a,[{message_type:'session_started',session_id:'s',config:{}},
    {message_type:'partial_transcript',text:'私は'},{message_type:'partial_transcript',text:'私は今日'},
    {message_type:'partial_transcript',text:'私は今日'},{message_type:'partial_transcript',text:'私は今日東京へ'}]);
  assert.deepEqual(out[0],[{type:'status',reason:'open',key:'el1'}]);
  assert.deepEqual(out.slice(1).map(e=>e.map(x=>x.text)),[['私は'],['私は今日'],[],['私は今日東京へ']]);
  assert.ok(out.slice(1).flat().every(x=>x.type==='partial'&&x.key==='el1'));
});
test('elevenlabs: committed_transcript closes the segment and the next one gets a new key',()=>{
  const c=world(),a=c.STT_LIVE_PROVIDERS.elevenlabs;
  const {out}=feed(a,[{message_type:'partial_transcript',text:'Hello'},{message_type:'committed_transcript',text:'Hello.'},
    {message_type:'committed_transcript_with_timestamps',text:'Hello.',language_code:'en',words:[]},{message_type:'partial_transcript',text:'Next'}]);
  assert.deepEqual(out[1],[{type:'committed',key:'el1',text:'Hello.',closeReason:'vad'},{type:'endpoint',key:'el1',reason:'vad'}]);
  assert.deepEqual(out[2],[]);
  assert.equal(out[3][0].key,'el2');
});
test('elevenlabs: errors are classified; only auth and config stop retrying',()=>{
  const c=world(),a=c.STT_LIVE_PROVIDERS.elevenlabs;
  const {out}=feed(a,[{message_type:'auth_error',error:'Invalid token'},{message_type:'rate_limited',error:'slow down'}]);
  assert.equal(out[0][0].type,'error');assert.equal(out[0][0].message,'Invalid token');
  assert.equal(a.classify(out[0][0]),'auth');assert.equal(a.classify(out[1][0]),'rate');
  assert.equal(a.classify({code:'quota_exceeded'}),'config');assert.equal(a.classify({code:1006}),'transient');
});
test('elevenlabs: the four VAD values are always sent, and only one language is pinned',()=>{
  const c=world({sttElevenLabsVadSilenceSecs:'0.5'}),a=c.STT_LIVE_PROVIDERS.elevenlabs;
  const opts=J(a.options(host));
  assert.deepEqual(Object.keys(opts).filter(k=>/vad|duration/.test(k)).sort(),
    ['min_silence_duration_ms','min_speech_duration_ms','vad_silence_threshold_secs','vad_threshold']);
  assert.equal(opts.vad_silence_threshold_secs,0.5);assert.equal(opts.vad_threshold,0.4);
  assert.equal(opts.language_code,'ja');assert.equal(opts.audio_format,'pcm_16000');
  assert.deepEqual(opts.keyterms,['control valve','MSV'],'at most 20 characters each (SDK limit)');
  const u=new URL(a.url(opts,{secret:'temp-token'}));
  assert.equal(u.origin+u.pathname,'wss://api.elevenlabs.io/v1/speech-to-text/realtime');
  assert.equal(u.searchParams.get('token'),'temp-token');assert.equal(u.searchParams.get('model_id'),'scribe_v2_realtime');
  assert.deepEqual(u.searchParams.getAll('keyterms'),['control valve','MSV']);
  c.S.autoMode=true;c.micSeats=()=>['A','B'];
  assert.equal(J(a.options(host)).language_code,undefined,'two languages: let the service detect');
});
test('elevenlabs: audio goes as input_audio_chunk with base64 PCM; commit only in manual mode',()=>{
  const c=world(),a=c.STT_LIVE_PROVIDERS.elevenlabs,pcm=new Int16Array([0,1,-1,32767,-32768]);
  const m=JSON.parse(a.frame(pcm));
  assert.equal(m.message_type,'input_audio_chunk');assert.equal(m.commit,false);assert.equal(m.sample_rate,16000);
  assert.deepEqual([...new Int16Array(new Uint8Array(Buffer.from(m.audio_base_64,'base64')).buffer)],[0,1,-1,32767,-32768]);
  const st={};a.init(st,{commit_strategy:'vad'});assert.equal(a.commit(st),null);
  a.init(st,{commit_strategy:'manual'});
  assert.deepEqual(JSON.parse(a.commit(st)),{message_type:'input_audio_chunk',audio_base_64:'',commit:true,sample_rate:16000});
  const {out}=feed(a,[]);assert.deepEqual(out,[]);
  const st2={manual:true};assert.equal(J(a.map(st2,JSON.stringify({message_type:'committed_transcript',text:'x'})))[0].closeReason,'manual');
});
/* ── AssemblyAI ───────────────────────────────────────────── */
test('assemblyai: partial turns, then end_of_turn commits once; the segment key is turn_order, not the text',()=>{
  const c=world(),a=c.STT_LIVE_PROVIDERS.assemblyai;
  const turn=(o,tx,eot,fmt)=>({type:'Turn',turn_order:o,turn_is_formatted:!!fmt,end_of_turn:!!eot,transcript:tx,end_of_turn_confidence:0.9,words:[],language_code:'ja'});
  const {out}=feed(a,[{type:'Begin',id:'x',expires_at:0},turn(0,'今日は',0),turn(0,'今日は晴れ',0),turn(0,'今日は晴れです',1),
    turn(0,'今日は晴れです。',1,1),turn(1,'今日は晴れです',0),{type:'Termination',audio_duration_seconds:1,session_duration_seconds:1}]);
  assert.equal(out[0][0].reason,'open');
  assert.deepEqual(out[1],[{type:'partial',key:'t0',text:'今日は',stableChars:null,language:'ja'}]);
  assert.deepEqual(out[3][0],{type:'committed',key:'t0',text:'今日は晴れです',language:'ja',closeReason:'end-of-turn'});
  assert.equal(out[3][1].type,'endpoint');
  assert.equal(out[4][0].type,'status','a second end_of_turn for the same turn is only logged');
  assert.equal(out[5][0].key,'t1','the same words in a new turn are a new segment');
  assert.equal(out[6][0].reason,'closed');
});
test('assemblyai: server errors and close codes are classified from the SDK table',()=>{
  const c=world(),a=c.STT_LIVE_PROVIDERS.assemblyai;
  const {out}=feed(a,[{type:'Error',error_code:4001,error:'Not Authorized'}]);
  assert.equal(out[0][0].type,'error');assert.equal(a.classify(out[0][0]),'auth');
  assert.equal(a.classify({code:4029}),'rate');assert.equal(a.classify({code:3008}),'transient');
  assert.equal(a.classify({code:3007}),'config');assert.equal(a.classify({code:1006}),'transient');
});
test('assemblyai: mode is sent, overrides only when chosen, language_codes only for 3.5 Pro',()=>{
  const c=world(),a=c.STT_LIVE_PROVIDERS.assemblyai;
  let o=J(a.options(host));
  assert.equal(o.speech_model,'universal-3-5-pro');assert.equal(o.mode,'balanced');assert.equal(o.continuous_partials,true);
  assert.equal(o.encoding,'pcm_s16le');assert.equal(o.sample_rate,16000);
  assert.ok(!('min_turn_silence' in o)&&!('max_turn_silence' in o)&&!('interruption_delay' in o),'Duo does not hold the mode presets');
  assert.deepEqual(o.language_codes,['ja']);assert.deepEqual(o.keyterms_prompt,['control valve','MSV','A very long technical term that exceeds']);
  c.CFG.sttAssemblyAiMinTurnSilenceMs='128';c.CFG.sttAssemblyAiMode='min_latency';
  o=J(a.options(host));assert.equal(o.min_turn_silence,128);assert.equal(o.mode,'min_latency');assert.ok(!('max_turn_silence' in o));
  const u=new URL(a.url(o,{secret:'tok'}));
  assert.equal(u.origin+u.pathname,'wss://streaming.assemblyai.com/v3/ws');
  assert.equal(u.searchParams.get('token'),'tok');assert.equal(u.searchParams.get('language_codes'),'["ja"]');
  assert.equal(u.searchParams.get('continuous_partials'),'true');
  c.CFG.sttModel='universal-3-6-pro';assert.ok(!('language_codes' in J(a.options(host))));
  assert.equal(a.bye(),'{"type":"Terminate"}');
  const pcm=new Int16Array([5,6,7]);const f=a.frame(pcm);assert.equal(f.byteLength,6);assert.deepEqual([...new Int16Array(f)],[5,6,7]);
});
/* ── Soniox ──────────────────────────────────────────────── */
test('soniox: final tokens are the stable prefix, non-final tokens are replaced, <end> commits without the marker',()=>{
  const c=world(),a=c.STT_LIVE_PROVIDERS.soniox;
  const tok=(t,f,l)=>({text:t,is_final:!!f,confidence:0.9,language:l||'en'});
  const {out}=feed(a,[
    {tokens:[tok('The',0),tok(' control',0)],final_audio_proc_ms:0,total_audio_proc_ms:100},
    {tokens:[tok('The',1),tok(' control',1),tok(' value',0)]},
    {tokens:[tok(' valve',1),tok(' opens',0)]},
    {tokens:[tok(' opens',1),tok('.',1),tok('<end>',1),tok(' Then',0)]},
    {tokens:[tok('<fin>',1)],finished:true}]);
  assert.deepEqual(out[0],[{type:'partial',key:'s1',text:'The control',stableChars:0,language:null}]);
  assert.deepEqual(out[1],[{type:'partial',key:'s1',text:'The control value',stableChars:11,language:'en'}]);
  assert.deepEqual(out[2].map(e=>[e.text,e.stableChars]),[['The control valve opens',17]]);
  assert.deepEqual(out[3][0],{type:'committed',key:'s1',text:'The control valve opens.',language:'en',closeReason:'semantic'});
  assert.deepEqual(out[3][1],{type:'endpoint',key:'s1',reason:'semantic'});
  assert.deepEqual(out[3][2],{type:'partial',key:'s2',text:'Then',stableChars:0,language:null},'the leading space of a new segment is dropped');
  /* 非確定の " Then" は確定しないまま消えた。区間の全文は空に戻る（Host がカードを消す）。 */
  assert.deepEqual(out[4].map(e=>e.type+':'+(e.reason||JSON.stringify(e.text))),['endpoint:finalize','partial:""','status:finished']);
  assert.ok(!JSON.stringify(out).includes('<end>')&&!JSON.stringify(out).includes('<fin>'));
});
test('soniox: the config message carries the temporary key and the v5 endpoint controls',()=>{
  const c=world({sttSonioxEndpointLevel:'2',sttSonioxEndpointSensitivity:'0.3',sttSonioxMaxEndpointDelayMs:'1500'}),a=c.STT_LIVE_PROVIDERS.soniox;
  const o=J(a.options(host));
  assert.equal(o.model,'stt-rt-v5');assert.equal(o.enable_endpoint_detection,true);assert.equal(o.audio_format,'pcm_s16le');
  assert.equal(o.endpoint_latency_adjustment_level,2);assert.equal(o.endpoint_sensitivity,0.3);assert.equal(o.max_endpoint_delay_ms,1500);
  assert.deepEqual(o.language_hints,['ja']);
  assert.deepEqual(o.context,{terms:['control valve','MSV','A very long technical term that exceeds'],text:'Steam turbine meeting'});
  const hello=JSON.parse(a.hello(o,{secret:'temp-key'}));
  assert.equal(hello.api_key,'temp-key');assert.equal(a.url(o,{secret:'temp-key'}),'wss://stt-rt.soniox.com/transcribe-websocket');
  c.CFG.sttModel='stt-rt-v3';const v3=J(a.options(host));
  assert.ok(!('endpoint_latency_adjustment_level' in v3)&&!('endpoint_sensitivity' in v3),'v5-only controls are not sent to other models');
  assert.equal(a.bye(),'');
});
test('soniox: errors carry the numeric code and are classified',()=>{
  const c=world(),a=c.STT_LIVE_PROVIDERS.soniox;
  const {out}=feed(a,[{error_code:401,error_message:'Invalid API key'}]);
  assert.deepEqual(out[0],[{type:'error',key:'',code:'401',message:'Invalid API key'}]);
  assert.equal(a.classify(out[0][0]),'auth');assert.equal(a.classify({code:429}),'rate');assert.equal(a.classify({code:503}),'transient');
});
/* ── 全社共通 ────────────────────────────────────────────── */
test('every adapter declares what the host needs, and partial text is never cumulative across keys',()=>{
  const c=world();
  for(const id of ['elevenlabs','assemblyai','soniox']){
    const a=c.STT_LIVE_PROVIDERS[id];
    for(const f of ['model','performance','options','credential','url','hello','frame','bye','classify','map','connect','close','stats'])
      assert.equal(typeof a[f],'function',id+'.'+f);
    assert.equal(a.transport,'websocket');assert.equal(a.caps.endpoint,'turn');
    assert.deepEqual(J(a.map({},'not json')),[],id+' ignores what it cannot parse');
  }
  assert.equal(c.STT_LIVE_PROVIDERS.openai.transport,'webrtc');
});
test('the performance object uses each provider\'s own parameter names (計画書§37)',()=>{
  const c=world(),P=c.STT_LIVE_PROVIDERS;
  assert.deepEqual(Object.keys(J(P.openai.performance())),['delay']);
  assert.deepEqual(Object.keys(J(P.elevenlabs.performance())),['commit_strategy','vad_silence_threshold_secs','vad_threshold','min_speech_duration_ms','min_silence_duration_ms']);
  assert.deepEqual(Object.keys(J(P.assemblyai.performance())),['mode']);
  assert.deepEqual(Object.keys(J(P.soniox.performance())),['endpoint_latency_adjustment_level','endpoint_sensitivity','max_endpoint_delay_ms']);
});
test('every pull-down stays inside the ranges the official SDKs check (付録A2)',()=>{
  const c=world(),C=c.STT_LIVE_CHOICES,nums=(p)=>C[p].values.map(v=>v[0]).filter(v=>v!=='').map(Number);
  const within=(p,lo,hi)=>nums(p).forEach(v=>assert.ok(v>=lo&&v<=hi,p+' '+v+' outside '+lo+'..'+hi));
  within('sttElevenLabsVadSilenceSecs',0.3,3.0);within('sttElevenLabsVadThreshold',0.1,0.9);
  within('sttElevenLabsMinSpeechMs',50,2000);within('sttElevenLabsMinSilenceMs',50,2000);
  within('sttSonioxEndpointLevel',0,3);within('sttSonioxEndpointSensitivity',-1,1);within('sttSonioxMaxEndpointDelayMs',500,3000);
  within('sttChunkMs',50,1000);
  assert.deepEqual(J(C.sttLiveDelay.values.map(v=>v[0])),['minimal','low','medium','high','xhigh']);
  assert.deepEqual(J(C.sttAssemblyAiMode.values.map(v=>v[0])),['min_latency','balanced','max_accuracy']);
  /* D-5: 既定は公式の既定値（gpt-live の delay だけ今の low）。計画書の値も選べる。 */
  assert.deepEqual(J([C.sttLiveDelay.def,C.sttElevenLabsVadSilenceSecs.def,C.sttAssemblyAiMode.def,C.sttSonioxEndpointLevel.def,C.sttSonioxEndpointSensitivity.def,C.sttSonioxMaxEndpointDelayMs.def]),
    ['low','1.5','balanced','0','0','2000']);
  assert.ok(nums('sttElevenLabsVadSilenceSecs').includes(0.5)&&C.sttAssemblyAiMode.values.some(v=>v[0]==='min_latency'));
  assert.equal(C.sttCardClose.def,'first','D-6');
});
console.log(JSON.stringify({passed:tests.length,tests},null,2));
