'use strict';
/* OpenRouter・Groq のモデル選び（機能別の一覧・おすすめ）と、翻訳の呼び出しの合わせ込みの受入試験。
 *
 * 起点は現状の調べ：OpenRouter は翻訳でしか選べず、一覧は名前だけで振り分けた数百件が1列に並び、
 * キー確認はキー無しでも返る GET /models を見ていたので、間違ったキーでも「接続できました」になった。
 * 推論モデルの推論も止めていなかった。 */
const path=require('node:path'),fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const src=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8').replace(/\r\n/g,'\n');
const lines=src.split('\n');
const start=lines.findIndex(l=>l.startsWith('/* ---------------- OpenRouter・Groq のモデル選び'));
const end=lines.findIndex((l,i)=>i>start&&l.startsWith('function classifyModels('));
assert.ok(start>0&&end>start,'hub module not found');
const HUB_CODE=lines.slice(start,end).join('\n');
function block(startsWith){
  const i=lines.findIndex(l=>l.startsWith(startsWith));
  assert.ok(i>=0,'block not found: '+startsWith);
  for(let j=i;j<lines.length;j++) if(lines[j]==='}'||lines[j]==='};') return lines.slice(i,j+1).join('\n');
  throw new Error('unterminated: '+startsWith);
}
const tests=[];const test=async(n,f)=>{await f();tests.push(n);};

function world(o={}){
  const w={calls:[],logs:[],mem:{}};
  const reply=o.reply||((url,opt)=>({ok:true,status:200,json:{data:[]}}));
  const ctx={console,String,Number,Object,JSON,Math,Array,Promise,Error,TypeError,isFinite,parseFloat,encodeURIComponent,btoa:(s)=>Buffer.from(s,'binary').toString('base64'),
    Date:{now:()=>1000000},location:{origin:'https://hide-1925.github.io'},
    CFG:Object.assign({orRoute:'latency',orZdr:false,provider:'openrouter',model:'',langA:'ja',langB:'en',sttProvider:'openai',sttModel:''},o.cfg||{}),
    KEYS:Object.assign({},o.keys||{}),
    store:{get:(k,d)=>k in w.mem?w.mem[k]:d,set:(k,v)=>{w.mem[k]=v;}},
    dlog:(c,m,d)=>w.logs.push({m,d}),
    STT_BASE:{groq:'https://api.groq.com/openai/v1'},
    PROVIDERS:{openrouter:{models:[{id:'deepseek/deepseek-v4.1-flash'}]},groq:{base:'https://api.groq.com/openai/v1',models:['llama-3.3-70b-versatile']}},
    L:(c)=>({en:c==='ja'?'Japanese':'English'}),
    realtimeEscape:(s)=>String(s),
    chk:(r)=>{if(!r.ok){const e=new Error('HTTP '+r.status);e.status=r.status;throw e;}return r.json();},
    fetch:(url,opt)=>{opt=opt||{};w.calls.push({url,opt,body:opt.body?JSON.parse(opt.body):null});
      const r=reply(url,opt);if(r instanceof Error)return Promise.reject(r);
      return Promise.resolve({ok:r.ok!==false,status:r.status||200,headers:{get:(k)=>(r.headers||{})[k.toLowerCase()]||null},
        json:()=>Promise.resolve(r.json),text:()=>Promise.resolve(r.text||''),arrayBuffer:()=>Promise.resolve(new ArrayBuffer(r.bytes||0))});}};
  ctx.keyOf=(p)=>(ctx.KEYS[p]||'').trim();
  vm.createContext(ctx);
  vm.runInContext(HUB_CODE+'\n'+[block('function normList('),block('function sortByCuratedOrder('),block('function hubTier('),block('function hubTryTranslate('),block('function orProbeKey(')].join('\n'),ctx);
  w.ctx=ctx;return w;
}
const OR_MODEL=(id,extra={})=>Object.assign({id,name:id.toUpperCase(),created:10,architecture:{input_modalities:['text'],output_modalities:['text']},
  pricing:{prompt:'0.0000002',completion:'0.0000008'},supported_parameters:['temperature','reasoning']},extra);

(async()=>{
await test('the OpenRouter list is asked per function by output_modalities, without the key',async()=>{
  const w=world({keys:{openrouter:'sk-or-1'},reply:(url)=>({json:{data:[OR_MODEL('a/x')]}})}),c=w.ctx;
  await c.hubList('openrouter','text',true);await c.hubList('openrouter','stt',true);await c.hubList('openrouter','tts',true);
  assert.deepEqual(w.calls.map(x=>x.url.split('?')[1]),['output_modalities=text','output_modalities=transcription','output_modalities=speech']);
  w.calls.forEach(x=>{assert.equal(x.opt.headers.Authorization,undefined,'the public list is fetched without the key');
    assert.equal(x.opt.headers['HTTP-Referer'],'https://hide-1925.github.io');assert.equal(x.opt.headers['X-Title'],'Duo Interpreter');});
});
await test('a list is kept for 24 h and fetched again only when forced',async()=>{
  const w=world({reply:()=>({json:{data:[OR_MODEL('a/x')]}})}),c=w.ctx;
  await c.hubList('openrouter','text',false);await c.hubList('openrouter','text',false);
  assert.equal(w.calls.length,1);
  await c.hubList('openrouter','text',true);assert.equal(w.calls.length,2);
});
await test('model details: price, free, reasoning, voices, maker',async()=>{
  const c=world().ctx;
  const m=c.hubNormOR(OR_MODEL('deepseek/deepseek-v4.1-flash',{reasoning:{mandatory:false,supported_efforts:['high','low','none']}}));
  assert.equal(m.author,'deepseek');assert.equal(m.free,false);assert.deepEqual(Array.from(m.reasoning.efforts),['high','low','none']);
  assert.match(c.hubPriceText(m,'text'),/入力 \$0\.200・出力 \$0\.800/);
  const f=c.hubNormOR(OR_MODEL('g/gemma:free',{pricing:{prompt:'0',completion:'0'}}));assert.equal(f.free,true);
  const t=c.hubNormOR(OR_MODEL('google/gemini-3.8-flash-tts',{supported_voices:['Kore','Puck'],architecture:{input_modalities:['text'],output_modalities:['speech']}}));
  assert.deepEqual(Array.from(t.voices),['Kore','Puck']);assert.ok(c.hubBadges(t).includes('声 2種'));
});
await test('recommendations: top 3 by server-side sort; translation narrowed to its category; audio uses popularity for quality',async()=>{
  const w=world({reply:()=>({json:{data:[OR_MODEL('a/1'),OR_MODEL('a/2')]}})}),c=w.ctx;
  const [speed,quality]=c.HUB_PRESETS;
  const got=await c.hubReco('openrouter','text',speed,true);
  assert.equal(got.length,2);
  assert.match(w.calls[0].url,/output_modalities=text&sort=latency-low-to-high&limit=3&category=translation$/);
  await c.hubReco('openrouter','tts',quality,true);
  assert.match(w.calls[1].url,/output_modalities=speech&sort=most-popular&limit=3$/);
  await c.hubReco('openrouter','text',quality,true);
  assert.match(w.calls[2].url,/sort=intelligence-high-to-low/);
});
await test('Groq: the list needs the key and is split by name; recommendations only list models the account has',async()=>{
  const w=world({keys:{groq:'gsk-1'},reply:()=>({json:{data:[{id:'whisper-large-v3-turbo',owned_by:'OpenAI'},{id:'llama-3.1-8b-instant',owned_by:'Meta'},
    {id:'canopylabs/orpheus-v1-english',owned_by:'Canopy Labs'},{id:'meta-llama/llama-guard-4-12b',owned_by:'Meta'},{id:'openai/gpt-oss-120b',owned_by:'OpenAI'}]}})}),c=w.ctx;
  const text=await c.hubList('groq','text',true);
  assert.deepEqual(Array.from(text,m=>m.id),['llama-3.1-8b-instant','openai/gpt-oss-120b'],'no whisper, no tts, no guard');
  assert.equal(w.calls[0].opt.headers.Authorization,'Bearer gsk-1');
  assert.deepEqual(Array.from(await c.hubList('groq','stt',true),m=>m.id),['whisper-large-v3-turbo']);
  assert.deepEqual(Array.from(await c.hubList('groq','tts',true),m=>m.id),['canopylabs/orpheus-v1-english']);
  const reco=await c.hubReco('groq','text',c.HUB_PRESETS[1],true);
  assert.deepEqual(Array.from(reco,m=>m.id),['openai/gpt-oss-120b'],'curated ids missing from the account are left out');
  await assert.rejects(world().ctx.hubList('groq','text',true),/APIキー/);
});
await test('OpenRouter translation: reasoning off, lowest when it cannot be off; temperature only where accepted; route and data policy',async()=>{
  const w=world({cfg:{orRoute:'latency',orZdr:true}}),c=w.ctx;
  c.HUB.lists['openrouter:text']={at:1000000,models:[
    c.hubNormOR(OR_MODEL('a/think',{reasoning:{mandatory:false}})),
    c.hubNormOR(OR_MODEL('a/must',{reasoning:{mandatory:true,supported_efforts:['high','medium','minimal']},supported_parameters:['reasoning']})),
    c.hubNormOR(OR_MODEL('a/plain'))]};
  const b1=c.orChatTune({temperature:0.2},'a/think');
  assert.deepEqual(JSON.parse(JSON.stringify(b1)),{temperature:0.2,reasoning:{effort:'none'},provider:{sort:'latency',zdr:true,data_collection:'deny'}});
  const b2=c.orChatTune({temperature:0.2},'a/must');
  assert.equal(b2.reasoning.effort,'minimal');assert.equal(b2.temperature,undefined,'temperature is not in its parameters');
  c.CFG.orRoute='auto';c.CFG.orZdr=false;
  const b3=c.orChatTune({temperature:0.2},'a/plain');
  assert.deepEqual(JSON.parse(JSON.stringify(b3)),{temperature:0.2});
  const b4=c.orChatTune({temperature:0.2},'unknown/model');
  assert.deepEqual(JSON.parse(JSON.stringify(b4)),{temperature:0.2},'without model details nothing new is sent');
});
await test('Groq translation: gpt-oss thinks little, Qwen3 does not think, reasoning stays out of the text',async()=>{
  const c=world().ctx;
  assert.equal(c.groqChatTune({},'openai/gpt-oss-120b').reasoning_effort,'low');
  const q=c.groqChatTune({},'qwen/qwen3-32b');assert.equal(q.reasoning_effort,'none');assert.equal(q.reasoning_format,'hidden');
  assert.deepEqual(JSON.parse(JSON.stringify(c.groqChatTune({},'llama-3.3-70b-versatile'))),{});
  assert.equal(c.stripThink('<think>考え中</think>\nHello.'),'Hello.');
  assert.equal(c.stripThink('<think>途中で切れた'),'');
  assert.equal(c.stripThink('そのまま'),'そのまま');
});
await test('the key check asks GET /key with the key, so a wrong key is not reported as working',async()=>{
  const ok=world({reply:()=>({json:{data:{is_free_tier:false,limit_remaining:12.5}}})});
  assert.match(await ok.ctx.orProbeKey('sk-or-1'),/有料・残り \$12\.5/);
  assert.match(ok.calls[0].url,/\/key$/);assert.equal(ok.calls[0].opt.headers.Authorization,'Bearer sk-or-1');
  const bad=world({reply:()=>({ok:false,status:401,text:'No auth credentials found'})});
  await assert.rejects(bad.ctx.orProbeKey('wrong'),/HTTP 401/);
});
await test('the main list keeps the built-in models, the recommendations and the current one; the rest waits behind "others"',async()=>{
  const c=world({cfg:{model:'x/current'}}).ctx;
  c.HUB.reco['openrouter:text:speed']={at:1000000,models:[{id:'a/fast'}]};
  const t=c.hubTier([{id:'z/other'},{id:'a/fast'},{id:'deepseek/deepseek-v4.1-flash'},{id:'x/current'}],'openrouter');
  assert.deepEqual(Array.from(t.primary,m=>m.id).sort(),['a/fast','deepseek/deepseek-v4.1-flash','x/current']);
  assert.deepEqual(Array.from(t.rest,m=>m.id),['z/other']);
});
await test('trying a model translates one sample sentence with the same tuning',async()=>{
  const w=world({keys:{openrouter:'sk-or-1'},reply:()=>({json:{choices:[{message:{content:'<think>x</think>Let us start.'}}]}})}),c=w.ctx;
  assert.equal(await c.hubTryTranslate('openrouter','a/plain'),'Let us start.');
  const call=w.calls[0];assert.match(call.url,/openrouter\.ai\/api\/v1\/chat\/completions$/);
  assert.match(call.body.messages[0].content,/into English/);assert.match(call.body.messages[1].content,/会議/);
  assert.deepEqual(call.body.provider,{sort:'latency'});
});
await test('the connection test runs the four checks one by one and names a browser block as such',async()=>{
  let active=0,maxActive=0;
  const w=world({keys:{openrouter:'sk-or-1'},reply:(url)=>{
    if(/\/models\?output_modalities=speech/.test(url))return {json:{data:[OR_MODEL('google/gemini-3.8-flash-tts',{supported_voices:['Kore']})]}};
    if(/\/models\?output_modalities=transcription/.test(url))return {json:{data:[OR_MODEL('openai/whisper-1')]}};
    if(/\/key$/.test(url))return {json:{data:{is_free_tier:true}}};
    if(/chat\/completions/.test(url))return {json:{provider:'DeepSeek',choices:[{message:{content:'OK'}}]}};
    if(/audio\/speech/.test(url))return new TypeError('Failed to fetch');
    if(/audio\/transcriptions/.test(url))return {json:{text:''}};
    return {json:{}};}}),c=w.ctx;
  const origFetch=c.fetch;c.fetch=(u,o)=>{active++;maxActive=Math.max(maxActive,active);return origFetch(u,o).finally(()=>{active--;});};
  const rs=await c.orConnectionTest();
  assert.equal(maxActive,1,'one request at a time');
  assert.deepEqual(Array.from(rs,r=>r.ok),[true,true,false,true]);
  assert.match(rs[2].detail,/ブラウザから呼べませんでした/);
  const speech=w.calls.find(x=>/audio\/speech/.test(x.url)).body;
  assert.deepEqual(JSON.parse(JSON.stringify(speech)),{model:'google/gemini-3.8-flash-tts',input:'テスト',response_format:'pcm',voice:'Kore'});
  const stt=w.calls.find(x=>/audio\/transcriptions/.test(x.url)).body;
  assert.equal(stt.input_audio.format,'wav');assert.equal(stt.language,'ja');
  assert.equal(Buffer.from(stt.input_audio.data,'base64').slice(0,4).toString(),'RIFF');
  assert.match(c.orTestSummary(),/キー OK .*読み上げ NG/);
});
await test('latency is the fastest provider median; values of 20 or more are read as ms',async()=>{
  const w=world({reply:()=>({json:{data:{endpoints:[{latency_last_30m:{p50:640}},{latency_last_30m:{p50:410}},{latency:null}]}}})});
  assert.equal(await w.ctx.hubLatency('a/x'),0.41);
  assert.match(w.calls[0].url,/\/models\/a\/x\/endpoints$/);
  const s=world({reply:()=>({json:{data:{endpoints:[{latency_last_30m:{p50:0.8}}]}}})});
  assert.equal(await s.ctx.hubLatency('b/y'),0.8);
});
console.log(JSON.stringify({test:'model-hub',passed:tests.length,tests}));
})().catch(e=>{console.error(e);process.exit(1);});
