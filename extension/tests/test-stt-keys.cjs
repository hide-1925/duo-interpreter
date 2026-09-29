'use strict';
/* 一時資格情報と鍵の扱い（STTマルチプロバイダ開発仕様書 §8・INV-STT-07）。
 * - 長期のキーは発行元にだけ、その会社の決めたヘッダで送る。WebSocket の URL・最初のメッセージには一時資格情報だけ
 * - 一時資格情報は診断ログの伏せ字に入る（URL の token=、Soniox の api_key）
 * - ブラウザから届かない（CORS の可能性）とキーの問題を別の文言にする（D-2 の判断材料）
 * - 接続の記録にキーも一時資格情報も入らない */
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
const CODE=[block('var STT_LIVE_CHOICES={'),region('function isLiveTranscribe(){','/* ── 設定欄（開発仕様書 §10）'),
  block('function knownSecrets('),block('function redact(')].join('\n');
const LONG='long-lived-account-key-0123456789';
function world(fetchImpl){
  const logs=[];
  const ctx={console,String,Number,Object,JSON,Math,Array,Promise,Error,TypeError,isFinite,RegExp,Float32Array,Int16Array,Uint8Array,URLSearchParams,
    Date,setTimeout,clearTimeout,setInterval:()=>0,clearInterval:()=>{},
    btoa:(s)=>Buffer.from(s,'binary').toString('base64'),fetch:fetchImpl||(()=>Promise.reject(new Error('no fetch'))),
    S:{running:true,autoMode:false,listenSeat:'A'},sessionGen:1,EMBED:{},
    CFG:{langA:'ja',langB:'en',sttModel:'',glossary:[],ctx:'',sttProvider:'soniox'},
    KEYS:{'stt:soniox':LONG,'stt:assemblyai':LONG,'stt:elevenlabs':LONG},
    micSeats:()=>['A'],langOf:()=>'ja',duoShouldAutoDetectInput:()=>false,sttKey:()=>LONG,
    dlog:(c,m,d)=>logs.push(JSON.stringify([c,m,d])),toast:()=>{},realtimeEscape:(x)=>x};
  vm.createContext(ctx);vm.runInContext(CODE,ctx);
  return {ctx,logs};
}
const tests=[];
const test=async(name,fn)=>{await fn();tests.push(name);};

(async()=>{
await test('each provider sends the long-lived key only to its own issuer, with that company\'s header',async()=>{
  const {ctx}=world(),calls=[];
  const host={request:(stage,url,opts)=>{calls.push({stage,url,opts});return Promise.resolve({token:'t',api_key:'k'});}};
  const P=ctx.STT_LIVE_PROVIDERS;
  await P.elevenlabs.credential(host,LONG);await P.assemblyai.credential(host,LONG);await P.soniox.credential(host,LONG);
  assert.equal(calls[0].url,'https://api.elevenlabs.io/v1/single-use-token/realtime_scribe');
  assert.equal(calls[0].opts.method,'POST');assert.equal(calls[0].opts.headers['xi-api-key'],LONG);
  assert.equal(calls[1].url,'https://streaming.assemblyai.com/v3/token?expires_in_seconds=60');
  assert.equal(calls[1].opts.method,'GET');assert.equal(calls[1].opts.headers.Authorization,LONG,'AssemblyAI takes the raw key, no Bearer');
  assert.equal(calls[2].url,'https://api.soniox.com/v1/auth/temporary-api-key');
  assert.equal(calls[2].opts.headers.Authorization,'Bearer '+LONG);
  assert.deepEqual(JSON.parse(calls[2].opts.body),{usage_type:'transcribe_websocket',expires_in_seconds:60,single_use:true});
  assert.ok(calls.every(c=>c.stage==='token'));
});
await test('the WebSocket URL and the first message carry only the temporary credential',async()=>{
  const {ctx}=world(),P=ctx.STT_LIVE_PROVIDERS,host={seat:'A'},cred={secret:'temporary-credential-xyz'};
  for(const id of ['elevenlabs','assemblyai','soniox']){
    const a=P[id],o=a.options(host),wire=a.url(o,cred)+'\n'+(a.hello(o,cred)||'');
    assert.ok(!wire.includes(LONG),id+' leaks the long-lived key');
    assert.ok(wire.includes(cred.secret),id+' must use the temporary credential');
  }
});
await test('temporary credentials are redacted in diagnostics, in URLs and in the Soniox config',async()=>{
  const {ctx}=world();
  ctx.sttLiveSecretAdd('registered-temp-token-000111');
  assert.ok(ctx.knownSecrets().includes('registered-temp-token-000111'));
  const a=ctx.redact('wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&token=registered-temp-token-000111');
  assert.ok(!a.includes('registered-temp-token-000111'));
  const b=ctx.redact('wss://streaming.assemblyai.com/v3/ws?token=never-registered-but-shaped&speech_model=universal-3-5-pro');
  assert.ok(!b.includes('never-registered-but-shaped'),'the token= shape rule catches unregistered ones');
  const c=ctx.redact('{"api_key":"soniox-temp-abcdef12345","model":"stt-rt-v5"}');
  assert.ok(!c.includes('soniox-temp-abcdef12345'));
  assert.ok(ctx.redact('key '+LONG).indexOf(LONG)<0,'the account key itself is redacted too');
});
await test('unreachable issuer (CORS) and a rejected key produce different messages',async()=>{
  const cors=world(()=>Promise.reject(new TypeError('Failed to fetch')));
  const h=new cors.ctx.SttLiveHost('soniox','A',null,{});h.startedAt=Date.now();
  await assert.rejects(()=>cors.ctx.STT_LIVE_PROVIDERS.soniox.credential(h,LONG),(e)=>/CORS/.test(e.message)&&e.unreachable===true&&e.liveStage==='token');
  const denied=world(()=>Promise.resolve({ok:false,status:401,headers:{get:()=>''},text:()=>Promise.resolve('bad key')}));
  const h2=new denied.ctx.SttLiveHost('soniox','A',null,{});h2.startedAt=Date.now();
  await assert.rejects(()=>denied.ctx.STT_LIVE_PROVIDERS.soniox.credential(h2,LONG),(e)=>/キーが無効か/.test(e.message)&&e.status===401&&!/CORS/.test(e.message));
  /* gpt-live は v1.49.39 の文言のまま（原因の書き換えをしない）。 */
  const oa=world(()=>Promise.reject(new TypeError('Failed to fetch')));
  const h3=new oa.ctx.SttLiveHost('openai','A',null,{});
  await assert.rejects(()=>h3.request('secret','https://api.openai.com/v1/realtime/client_secrets',{},1000,true),(e)=>e.message==='Failed to fetch');
});
await test('the connect log and the token log carry options and status, never a key or credential',async()=>{
  const ok=world(()=>Promise.resolve({ok:true,status:200,headers:{get:()=>'req-1'},json:()=>Promise.resolve({api_key:'fake-temporary-credential-1'})}));
  const h=new ok.ctx.SttLiveHost('soniox','A',{getAudioTracks:()=>[{readyState:'live',muted:false}]},{});h.startedAt=Date.now();
  h.openSocket=()=>Promise.resolve();
  ok.ctx.CFG.glossary=[{s:'ProjectNightjar'},{s:'MSV'}];ok.ctx.CFG.ctx='Confidential merger call';
  await h.connectSocket(LONG,{readyState:'live',muted:false});
  const all=ok.logs.join('\n');
  assert.ok(all.includes('live-connect')&&all.includes('live-token-response'));
  assert.ok(!all.includes(LONG)&&!all.includes('fake-temporary-credential-1'));
  assert.ok(!all.includes('ProjectNightjar')&&!all.includes('Confidential merger'),'glossary terms and context are logged as counts only');
  assert.ok(/"terms":2/.test(all),'the count is still there');
  assert.ok(ok.ctx.STT_LIVE_SECRETS.includes('fake-temporary-credential-1'),'the credential is registered for redaction');
});
console.log(JSON.stringify({passed:tests.length,tests},null,2));
})().catch(e=>{console.error(e);process.exit(1);});
