'use strict';
/* OpenRouter の文字起こしの受入試験。
 * POST /audio/transcriptions に JSON（input_audio は base64）で送る。OpenRouter の STT には prompt が無いので、
 * OpenAI の文字起こしモデルに限って provider.options.openai.prompt で用語集を渡す。録音の形式（webm）で
 * 断られたら 16kHz の WAV に変えて1回だけ送り直す。OpenAI の 4o 系は、録音上限・末尾繰越・順番待ちを使う。 */
const path=require('node:path'),fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const src=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8').replace(/\r\n/g,'\n');
const lines=src.split('\n');
const start=lines.findIndex(l=>l.startsWith('var OR_STT_WAV'));
const end=lines.findIndex((l,i)=>i>start&&l.startsWith('function geminiSTT('));
assert.ok(start>0&&end>start,'stt block not found');
const CODE=lines.slice(start,end).join('\n')+'\n'+lines.find(l=>l.startsWith('function fourOFileModel('))+'\n'+lines[lines.findIndex(l=>l.startsWith('function fourOFileModel('))+1];
const tests=[];const test=async(n,f)=>{await f();tests.push(n);};

function world(o={}){
  const w={calls:[],logs:[],wav:0};
  const reply=o.reply||(()=>({json:{text:'こんにちは'}}));
  class OAC{constructor(ch,len,rate){this.rate=rate;this.destination={};}
    decodeAudioData(){return Promise.resolve({duration:0.5});}
    createBufferSource(){return {connect(){},start(){}};}
    startRendering(){w.wav++;return Promise.resolve({kind:'rendered',sampleRate:this.rate});}}
  const ctx={console,String,Object,JSON,Math,Array,Promise,Error,Uint8Array,Blob,
    window:{OfflineAudioContext:OAC},
    CFG:Object.assign({sttProvider:'openrouter',sttModel:'google/chirp-3',langA:'ja',langB:'en',glossary:[{s:'反攻作戦'},{s:'旅団'}]},o.cfg||{}),
    OR_BASE:'https://openrouter.ai/api/v1',
    sttKey:()=>'sk-openai-from-translation',hubKeyFor:(p,k)=>o.nokey?'':'sk-or',L:(c)=>({g:c==='ja'?'ja-JP':'en-US',en:c==='ja'?'Japanese':'English'}),
    sttAutoDetect:()=>!!o.auto,orHeaders:(k)=>({'Content-Type':'application/json',Authorization:'Bearer '+k}),
    blobToB64:(b)=>Promise.resolve(b&&b.kind==='wav'?'V0FW':'V0VCTQ=='),
    audioBufferToWav:()=>({kind:'wav'}),
    dlog:(c,m,d)=>w.logs.push({m,d}),
    fetch:(url,opt)=>{const body=JSON.parse(opt.body);w.calls.push({url,opt,body:JSON.parse(JSON.stringify(body))});const r=reply(body,w.calls.length);
      return Promise.resolve({ok:(r.status||200)<400,status:r.status||200,json:()=>Promise.resolve(r.json),text:()=>Promise.resolve(r.text||'')});},
    HUB_PRESETS:[{id:'popular'}],
    hubList:()=>Promise.resolve([{id:'openai/whisper-1'},{id:'google/chirp-3'}]),
    hubReco:()=>Promise.resolve([{id:'openai/gpt-4o-mini-transcribe'}]),
    persistSetting:()=>{},refreshProviderUI:()=>{},$:()=>({})};
  vm.createContext(ctx);vm.runInContext(CODE,ctx);w.ctx=ctx;return w;
}
const webm={type:'audio/webm;codecs=opus',kind:'webm',arrayBuffer:()=>Promise.resolve(new ArrayBuffer(8))};

(async()=>{
await test('the request is JSON with base64 audio, the recorder format and the seat language',async()=>{
  const w=world(),c=w.ctx;
  assert.equal(await c.openrouterSTT(webm,'ja',{}),'こんにちは');
  const b=w.calls[0].body;
  assert.equal(w.calls[0].url,'https://openrouter.ai/api/v1/audio/transcriptions');
  assert.deepEqual(b,{model:'google/chirp-3',temperature:0,language:'ja',input_audio:{data:'V0VCTQ==',format:'webm'}});
  assert.equal(w.calls[0].opt.headers.Authorization,'Bearer sk-or');
  assert.equal(c.sttAudioFormat({type:'audio/mp4'}),'m4a');assert.equal(c.sttAudioFormat({type:'audio/ogg'}),'ogg');
});
await test('OpenAI transcription models get the glossary through provider options; others do not',async()=>{
  const w=world({cfg:{sttModel:'openai/gpt-4o-mini-transcribe'}}),c=w.ctx;
  await c.openrouterSTT(webm,'ja',{});
  const p=w.calls[0].body.provider.options.openai.prompt;
  assert.match(p,/Transcribe verbatim/);assert.match(p,/Terminology: 反攻作戦, 旅団/);
  assert.ok(!/The speech is in/.test(p));
});
await test('with two languages in AUTO the language is left open and named in the hint',async()=>{
  const w=world({auto:true,cfg:{sttModel:'openai/whisper-1'}}),c=w.ctx;
  await c.openrouterSTT(webm,'ja',{autoLanguage:true});
  const b=w.calls[0].body;assert.equal(b.language,undefined);
  assert.match(b.provider.options.openai.prompt,/The speech is in Japanese or English\./);
});
await test('a format refusal converts to 16 kHz WAV once, and that model goes as WAV from then on',async()=>{
  const w=world({reply:(b,n)=>n===1?{status:400,text:'{"error":{"message":"Unsupported audio format: webm"}}'}:{json:{text:'OK'}}}),c=w.ctx;
  assert.equal(await c.openrouterSTT(webm,'ja',{}),'OK');
  assert.deepEqual(w.calls.map(x=>x.body.input_audio.format),['webm','wav']);
  assert.equal(w.wav,1);assert.ok(w.logs.some(l=>l.m==='openrouter-wav-retry'));
  await c.openrouterSTT(webm,'ja',{});
  assert.equal(w.calls[2].body.input_audio.format,'wav','no second webm try');
});
await test('only an OpenRouter key is sent to OpenRouter, never the translation key of another provider',async()=>{
  const w=world(),c=w.ctx;await c.openrouterSTT(webm,'ja',{});
  assert.equal(w.calls[0].opt.headers.Authorization,'Bearer sk-or');
  const k=world({nokey:true});await assert.rejects(k.ctx.openrouterSTT(webm,'ja',{}),/APIキー/);assert.equal(k.calls.length,0);
});
await test('other errors are not retried; a missing model or key is said plainly',async()=>{
  const w=world({reply:()=>({status:404,text:'model not found'})}),c=w.ctx;
  await assert.rejects(c.openrouterSTT(webm,'ja',{}),/HTTP 404/);assert.equal(w.calls.length,1);
  await assert.rejects(world({cfg:{sttModel:''}}).ctx.openrouterSTT(webm,'ja',{}),/文字起こしモデルを選んでください/);
  await assert.rejects(world({nokey:true}).ctx.openrouterSTT(webm,'ja',{}),/APIキー/);
});
await test('OpenAI 4o transcription through OpenRouter uses the recording limit, tail carry and ordered results',async()=>{
  const c=world().ctx;
  assert.equal(c.fourOFileModel('openai/gpt-4o-mini-transcribe'),true);
  assert.equal(c.fourOFileModel('openai/gpt-4o-transcribe'),true);
  assert.equal(c.fourOFileModel('openai/whisper-1'),false);
  assert.equal(c.fourOFileModel('gpt-4o-mini-transcribe'),false,'without the maker prefix it is not an OpenRouter id');
  c.CFG.sttProvider='openai';assert.equal(c.fourOFileModel('gpt-4o-mini-transcribe'),true);
});
await test('choosing OpenRouter with no model picks the most used one from its list',async()=>{
  const c=world({cfg:{sttModel:''}}).ctx;
  await c.orSttEnsure();
  assert.equal(c.CFG.sttModel,'openai/gpt-4o-mini-transcribe');
  const k=world({cfg:{sttModel:'google/chirp-3'}}).ctx;await k.orSttEnsure();
  assert.equal(k.CFG.sttModel,'google/chirp-3','a model in the list is kept');
});
console.log(JSON.stringify({test:'hub-stt',passed:tests.length,tests}));
})().catch(e=>{console.error(e);process.exit(1);});
