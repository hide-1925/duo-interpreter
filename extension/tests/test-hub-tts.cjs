'use strict';
/* OpenRouter・Groq の読み上げの受入試験。
 * OpenRouter の /audio/speech は mp3 か pcm（既定 pcm）で返す。Gemini の TTS は PCM しか返さないと
 * 外部の実装に記録がある。返った中身の頭と content-type で形を見分け、生の PCM は WAV に包んで鳴らす。
 * Groq の Orpheus は英語とアラビア語だけ。 */
const path=require('node:path'),fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const src=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8').replace(/\r\n/g,'\n');
const lines=src.split('\n');
const start=lines.findIndex(l=>l.startsWith('/* ---------------- OpenRouter・Groq の読み上げ'));
const end=lines.findIndex((l,i)=>i>start&&l.startsWith('/* Windows用 OpenAI PCM連続再生'));
assert.ok(start>0&&end>start,'tts block not found');
const CODE=lines.slice(start,end).join('\n');
const tests=[];const test=async(n,f)=>{await f();tests.push(n);};
const tick=()=>new Promise(r=>setImmediate(r));

function world(o={}){
  const w={calls:[],logs:[],played:[],fallback:[],browser:[],toasts:[]};
  const reply=o.reply||(()=>({bytes:new Uint8Array([1,2,3,4,5,6])}));
  const models={'google/gemini-3.8-flash-tts':{id:'google/gemini-3.8-flash-tts',voices:['Kore','Puck','Zephyr']},
    'openai/gpt-4o-mini-tts':{id:'openai/gpt-4o-mini-tts',voices:['alloy','ash']}};
  const ctx={console,String,Object,JSON,Math,Array,Promise,Error,TypeError,Uint8Array,ArrayBuffer,DataView,Blob,parseInt,
    Date:{now:()=>5000},setTimeout:()=>0,
    CFG:Object.assign({orTtsModel:'google/gemini-3.8-flash-tts',orVoiceA:'',orVoiceB:'',groqTtsModel:'canopylabs/orpheus-v1-english',groqVoiceA:'',groqVoiceB:'',langA:'ja',langB:'en'},o.cfg||{}),
    KEYS:{},window:{},OR_BASE:'https://openrouter.ai/api/v1',STT_BASE:{groq:'https://api.groq.com/openai/v1'},
    hubKeyFor:(p)=>o.nokey?'':p==='groq'?'gsk':'sk-or',
    hubFind:(p,k,id)=>models[id]||null,hubCached:()=>null,
    orHeaders:(k,j)=>({'Content-Type':'application/json',Authorization:'Bearer '+k,'X-Title':'Duo Interpreter'}),
    prosodyMapForTts:()=>o.pmap||null,prosodyClamp:(v,a,b)=>Math.max(a,Math.min(b,v)),prosodyRound:(v,n)=>Math.round(v*1000)/1000,
    logProsodyMap:()=>{},dlog:(c,m,d)=>w.logs.push({m,d}),toast:(m)=>w.toasts.push(m),realtimeEscape:(s)=>String(s),
    L:(c)=>({tts:c+'-X',name:c==='ja'?'日本語':'English'}),
    ttsGuard:()=>{const f=()=>{f.done=true;};f.holdPhase=()=>{};return f;},
    playBlob:(b,f,tag,opt)=>w.played.push({b,tag,opt}),
    ttsFallback:(text,lang,why)=>w.fallback.push({text,lang,why}),
    browserSpeak:(text,lang,p,done)=>{w.browser.push({text,lang});done&&done();},
    fetch:(url,opt)=>{w.calls.push({url,opt,body:JSON.parse(opt.body)});const r=reply(url,opt);
      if(r instanceof Error)return Promise.reject(r);
      return Promise.resolve({ok:(r.status||200)<400,status:r.status||200,headers:{get:(k)=>k==='content-type'?(r.ct||''):null},
        text:()=>Promise.resolve(r.text||''),arrayBuffer:()=>Promise.resolve(r.bytes.buffer.slice(0))});}};
  vm.createContext(ctx);vm.runInContext(CODE,ctx);w.ctx=ctx;return w;
}
const head=(blob)=>blob.arrayBuffer().then(b=>new Uint8Array(b));

(async()=>{
await test('what comes back is told apart by its first bytes: WAV and MP3 are kept, raw PCM is wrapped as 24 kHz WAV',async()=>{
  const c=world().ctx;
  const wav=c.hubAudioBlob(new Uint8Array([0x52,0x49,0x46,0x46,0,0]).buffer,'');assert.equal(wav.kind,'wav');
  assert.equal(c.hubAudioBlob(new Uint8Array([0x49,0x44,0x33,4]).buffer,'').kind,'mp3');
  assert.equal(c.hubAudioBlob(new Uint8Array([0xFF,0xFB,0x90,0]).buffer,'').kind,'mp3');
  assert.equal(c.hubAudioBlob(new Uint8Array([1,2]).buffer,'audio/mpeg').kind,'mp3');
  const pcm=c.hubAudioBlob(new Uint8Array([1,2,3,4,5]).buffer,'audio/pcm');
  assert.equal(pcm.kind,'pcm');assert.equal(pcm.rate,24000);
  const u8=await head(pcm.blob),dv=new DataView(u8.buffer);
  assert.equal(String.fromCharCode(...u8.slice(0,4)),'RIFF');assert.equal(dv.getUint32(24,true),24000);
  assert.equal(dv.getUint16(22,true),1,'mono');assert.equal(dv.getUint32(40,true),4,'odd trailing byte dropped');
  assert.equal(c.hubAudioBlob(new Uint8Array([1,2]).buffer,'audio/pcm;rate=16000').rate,16000);
});
await test('OpenRouter: pcm is asked with the seat voice from the model list; playback speed carries the prosody rate',async()=>{
  const w=world({pmap:{rate:1.15,volume:1.1}}),c=w.ctx;
  c.orSpeak('こんにちは','ja','A',{});c.orSpeak('はい','ja','B',{});await tick();await tick();
  assert.deepEqual(w.calls.map(x=>[x.url,x.body.voice,x.body.response_format,x.body.speed]),
    [['https://openrouter.ai/api/v1/audio/speech','Kore','pcm',undefined],['https://openrouter.ai/api/v1/audio/speech','Puck','pcm',undefined]]);
  assert.equal(w.played.length,2);assert.equal(w.played[0].tag,'openrouter');
  assert.equal(w.played[0].opt.playbackRate,1.15);assert.equal(w.played[0].opt.gain,1.1);
  const ok=w.logs.find(l=>l.m==='openrouter-ok').d;assert.equal(ok.kind,'pcm');assert.equal(ok.rate,24000);assert.equal(ok.voice,'Kore');
});
await test('OpenRouter with an OpenAI voice model: speed goes to the API instead of playback',async()=>{
  const w=world({cfg:{orTtsModel:'openai/gpt-4o-mini-tts',orVoiceB:'ash'},pmap:{rate:1.2,volume:1}}),c=w.ctx;
  c.orSpeak('Hi','en','B',{});await tick();await tick();
  assert.equal(w.calls[0].body.speed,1.2);assert.equal(w.calls[0].body.voice,'ash');
  assert.equal(w.played[0].opt.playbackRate,1);
});
await test('OpenRouter failures fall back to the browser voice; a browser block is named; 429 pauses the provider',async()=>{
  const w=world({reply:()=>new TypeError('Failed to fetch')}),c=w.ctx;
  c.orSpeak('テスト','ja','A',null);await tick();await tick();
  assert.equal(w.browser.length,1);assert.match(w.toasts[0],/ブラウザから呼べませんでした/);
  const r=world({reply:()=>({status:429,text:'rate limited'})}),rc=r.ctx;
  rc.orSpeak('テスト','ja','A',null);await tick();await tick();await tick();
  assert.equal(r.browser.length,1);assert.ok(rc.OR_TTS_BLOCK_UNTIL>5000);
  const k=world({nokey:true});k.ctx.orSpeak('テスト','ja','A',null);
  assert.equal(k.calls.length,0);assert.equal(k.fallback[0].why,'未設定');
});
await test('Groq reads only its language; others go to the browser voice without a request',async()=>{
  const w=world({reply:()=>({bytes:new Uint8Array([0x52,0x49,0x46,0x46,1,2,3,4]),ct:'audio/wav'})}),c=w.ctx;
  c.groqSpeak('こんにちは','ja','A',null);
  assert.equal(w.calls.length,0);assert.equal(w.fallback[0].why,'Groqの声が無い言語');
  c.groqSpeak('Hello','en','A',null);c.groqSpeak('Yes','en','B',null);await tick();await tick();
  assert.deepEqual(w.calls.map(x=>[x.url,x.body.model,x.body.voice,x.body.response_format]),
    [['https://api.groq.com/openai/v1/audio/speech','canopylabs/orpheus-v1-english','autumn','wav'],
     ['https://api.groq.com/openai/v1/audio/speech','canopylabs/orpheus-v1-english','hannah','wav']]);
  assert.equal(w.calls[0].opt.headers.Authorization,'Bearer gsk');
  assert.equal(w.played[0].tag,'groq');
  const a=world({cfg:{groqTtsModel:'canopylabs/orpheus-arabic-saudi'}}).ctx;
  assert.equal(a.groqTtsLang('canopylabs/orpheus-arabic-saudi'),'ar');assert.equal(a.groqTtsVoice('A'),'fahad');
});
await test('trying a voice model plays one sample with that model\'s first voice',async()=>{
  const w=world(),c=w.ctx;
  c.Audio=function(){this.play=()=>Promise.resolve();};c.URL={createObjectURL:()=>'blob:x'};
  const res=await c.hubTryTts('openrouter','openai/gpt-4o-mini-tts');
  assert.match(res,/pcm・24000Hz/);
  assert.equal(w.calls[0].body.model,'openai/gpt-4o-mini-tts');assert.equal(w.calls[0].body.voice,'alloy');
  assert.match(w.calls[0].body.input,/会議/);
});
console.log(JSON.stringify({test:'hub-tts',passed:tests.length,tests}));
})().catch(e=>{console.error(e);process.exit(1);});
