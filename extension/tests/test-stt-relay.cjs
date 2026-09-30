'use strict';
/* 一時資格情報の発行経路 relay と broker（STTマルチプロバイダ開発仕様書 §8.3・§8.4）。

   relay で守るのは「拡張が CORS 回避の汎用踏み台にならないこと」。ページが渡せるのは
   会社名とキーだけで、発行元の URL・メソッド・ヘッダ・本文は拡張の表で決まる。
     1. 中継先は stt-relay.js の表の固定 URL だけ（ページの url・headers・body は無視）
     2. 呼べるのは拡張自身のページと、登録済みの HTML 本体のタブだけ
     3. 表の要求は、直接（direct）のときに Adapter が送るものと同じ
   broker で守るのは、Cookie を送らないこと、各社のキーをページが持たなくてよいこと、
   Broker の応答の本文を文言と記録に入れないこと、URL の形（HTTPS・認証情報とクエリなし）。 */
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..');
const proxySrc=fs.readFileSync(path.join(root,'turn-proxy.js'),'utf8');
const relaySrc=fs.readFileSync(path.join(root,'stt-relay.js'),'utf8');
const contentSrc=fs.readFileSync(path.join(root,'html-source-content.js'),'utf8');
const src=fs.readFileSync(path.join(root,'app.js'),'utf8').replace(/\r\n/g,'\n');
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
const tests=[],queue=[];
const test=(n,f)=>queue.push([n,f]);
const EXT='chrome-extension://abcdef/';
const KEY='long-lived-account-key-0123456789';
const J=(x)=>JSON.parse(JSON.stringify(x));

/* ── 拡張の側（stt-relay.js）──────────────────────────────────────────── */
function sw(over){
  const o=Object.assign({htmlTabId:7,status:200,body:'{"api_key":"tmp-1","token":"tmp-1"}'},over||{});
  const seen=[],timers=[];
  const ctx={URL,Set,Object,JSON,String,Number,Promise,AbortController,
    setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimeout:()=>{},
    getState:async()=>({htmlTabId:o.htmlTabId}),
    chrome:{runtime:{getURL:(p)=>EXT+(p||'')},storage:{local:{get:async()=>({})}},permissions:{contains:async()=>false}},
    fetch:(url,init)=>{
      seen.push({url,init});
      if(o.failFetch)return Promise.reject(new TypeError(o.failFetch));
      return new Promise((resolve,reject)=>{
        init.signal.addEventListener('abort',()=>reject(new Error('aborted')));
        if(o.hang)return;
        resolve({status:o.status,text:async()=>o.body});
      });
    }};
  const c=vm.createContext(ctx);
  vm.runInContext(proxySrc,c);vm.runInContext(relaySrc,c);
  return {c,seen,timers,fire:()=>timers.forEach(t=>t.fn())};
}
const extPage={url:EXT+'app.html'},htmlTab={tab:{id:7},url:'https://hide-1925.github.io/duo-interpreter/'};
const ask=(h,request,sender)=>h.c.sttRelayToken({type:'DUO_STT_TOKEN',request},sender===undefined?extPage:sender);

test('soniox: the fixed issuer, Bearer key, the fixed body, and no cookies',async()=>{
  const h=sw(),r=await ask(h,{provider:'soniox',key:KEY});
  assert.deepEqual(J(r),{ok:true,status:200,text:'{"api_key":"tmp-1","token":"tmp-1"}'});
  assert.equal(h.seen.length,1);const {url,init}=h.seen[0];
  assert.equal(url,'https://api.soniox.com/v1/auth/temporary-api-key');
  assert.equal(init.method,'POST');assert.equal(init.credentials,'omit');assert.equal(init.cache,'no-store');
  assert.deepEqual(J(init.headers),{Authorization:'Bearer '+KEY,'Content-Type':'application/json'});
  assert.deepEqual(JSON.parse(init.body),{usage_type:'transcribe_websocket',expires_in_seconds:60,single_use:true});
});
test('assemblyai and elevenlabs: their own issuers and header names, no body',async()=>{
  const h=sw();
  await ask(h,{provider:'assemblyai',key:KEY});await ask(h,{provider:'elevenlabs',key:KEY});
  assert.equal(h.seen[0].url,'https://streaming.assemblyai.com/v3/token?expires_in_seconds=60');
  assert.equal(h.seen[0].init.method,'GET');assert.deepEqual(J(h.seen[0].init.headers),{Authorization:KEY});
  assert.ok(!('body' in h.seen[0].init));
  assert.equal(h.seen[1].url,'https://api.elevenlabs.io/v1/single-use-token/realtime_scribe');
  assert.equal(h.seen[1].init.method,'POST');assert.deepEqual(J(h.seen[1].init.headers),{'xi-api-key':KEY});
});
test('a URL, headers, method or body sent by the page are ignored',async()=>{
  const h=sw();
  await ask(h,{provider:'soniox',key:KEY,url:'https://evil.test/steal',method:'DELETE',
    headers:{Cookie:'sid=1',Origin:'https://evil.test','X-Forwarded-For':'1.2.3.4'},body:'{"usage_type":"all"}'});
  assert.equal(h.seen[0].url,'https://api.soniox.com/v1/auth/temporary-api-key');
  assert.equal(h.seen[0].init.method,'POST');
  assert.deepEqual(Object.keys(h.seen[0].init.headers).sort(),['Authorization','Content-Type']);
  assert.equal(JSON.parse(h.seen[0].init.body).usage_type,'transcribe_websocket');
});
test('companies outside the table, including OpenAI and prototype names, are refused without a request',async()=>{
  const h=sw();
  for(const provider of ['openai','groq','__proto__','constructor','toString','hasOwnProperty','',null,42]){
    const r=await ask(h,{provider,key:KEY});
    assert.equal(r.ok,false,String(provider));assert.equal(r.denied,true,String(provider));
  }
  assert.equal(h.seen.length,0);
});
test('only the extension page and the registered HTML tab may ask',async()=>{
  const h=sw();
  assert.equal((await ask(h,{provider:'soniox',key:KEY},htmlTab)).ok,true,'the registered HTML tab');
  for(const s of [{tab:{id:9},url:'https://teams.microsoft.com/'},{url:'https://evil.test/'},{},null]){
    const r=await ask(h,{provider:'soniox',key:KEY},s);assert.equal(r.ok,false);assert.equal(r.denied,true);
  }
  assert.equal(h.seen.length,1,'a Teams tab or any other page gets nothing out');
  const none=sw({htmlTabId:null});
  assert.equal((await ask(none,{provider:'soniox',key:KEY},{tab:{id:7}})).ok,false,'no registered HTML tab, no relay');
});
test('a key that is empty, too long or contains whitespace is refused',async()=>{
  const h=sw();
  for(const key of ['',' ','a'.repeat(513),'abc\ndef','abc def','x\r\nCookie: y',null,{},['k']]){
    const r=await ask(h,{provider:'assemblyai',key});assert.equal(r.denied,true,JSON.stringify(key));
  }
  assert.equal(h.seen.length,0);
});
test('the provider\'s HTTP status is passed through for the page to word',async()=>{
  const h=sw({status:401,body:'{"error":"invalid key"}'}),r=await ask(h,{provider:'soniox',key:KEY});
  assert.deepEqual(J(r),{ok:true,status:401,text:'{"error":"invalid key"}'});
});
test('network failure, timeout and an oversized reply are reported without a status',async()=>{
  let r=await ask(sw({failFetch:'Failed to fetch'}),{provider:'soniox',key:KEY});
  assert.equal(r.ok,false);assert.equal(r.unreachable,true);assert.equal(r.status,0);
  const h=sw({hang:true}),p=ask(h,{provider:'soniox',key:KEY});await new Promise(r=>setImmediate(r));
  assert.equal(h.timers[0].ms,12000);h.fire();r=await p;
  assert.equal(r.unreachable,true);assert.match(r.error,/時間内/);
  r=await ask(sw({body:'x'.repeat(16385)}),{provider:'soniox',key:KEY});assert.equal(r.ok,false);assert.match(r.error,/大きすぎ/);
});
test('the relay never logs: no console or storage writes in stt-relay.js',()=>{
  assert.ok(!/console\.|chrome\.storage|dlog\(/.test(relaySrc),'the key and the reply must not be recorded');
});

/* ── 表が直接（direct）の要求と同じであること ─────────────────────────────── */
const PAGE=[lines.find(l=>l.startsWith('var STT_FALLBACK_TARGETS=')),block('var STT_LIVE_CHOICES={'),
  region('function isLiveTranscribe(){','/* ── 設定欄（開発仕様書 §10）'),block('var TurnBridge={')].join('\n');
function page(o){
  o=o||{};
  const logs=[],events=[],listeners=new Map();
  const win={addEventListener(k,f){if(!listeners.has(k))listeners.set(k,new Set());listeners.get(k).add(f);},
    removeEventListener(k,f){listeners.get(k)?.delete(f);},
    dispatchEvent(e){events.push(e);for(const f of [...listeners.get(e.type)||[]])f(e);return true;}};
  const ctx={console,String,Number,Object,JSON,Math,Array,Promise,Error,TypeError,isFinite,RegExp,URL,URLSearchParams,
    Float32Array,Int16Array,Uint8Array,AbortController,Date,setTimeout,clearTimeout,setInterval:()=>0,clearInterval:()=>{},
    btoa:(s)=>Buffer.from(s,'binary').toString('base64'),window:win,
    CustomEvent:class{constructor(type,init){this.type=type;this.detail=init&&init.detail;}},
    fetch:o.fetch||(()=>Promise.reject(new Error('direct fetch must not be used'))),
    S:{running:true,autoMode:false,listenSeat:'A'},sessionGen:1,
    CFG:Object.assign({langA:'ja',langB:'en',sttModel:'',glossary:[],ctx:'',sttProvider:'soniox'},o.cfg||{}),
    KEYS:Object.assign({'stt:soniox':KEY,'stt:assemblyai':KEY,'stt:elevenlabs':KEY},o.keys||{}),
    keyOf:(p)=>String(ctx.KEYS[p]||'').trim(),
    micSeats:()=>['A'],langOf:()=>'ja',duoShouldAutoDetectInput:()=>false,sttKey:()=>KEY,
    dlog:(c,m,d)=>logs.push(JSON.stringify([c,m,d])),toast:()=>{},realtimeEscape:(x)=>x};
  vm.createContext(ctx);vm.runInContext(PAGE,ctx);
  if(o.bridge){
    /* 内容スクリプトの代わり。名乗り、要求を受け、返事を返す。 */
    win.addEventListener('duo-stt-token-request',(e)=>{
      const d=JSON.parse(e.detail);o.bridge.seen.push(d.request);
      Promise.resolve(o.bridge.reply(d.request)).then(r=>win.dispatchEvent(new ctx.CustomEvent('duo-turn-reply',{detail:JSON.stringify(Object.assign({id:d.id},r))})));
    });
    vm.runInContext('TurnBridge.wire()',ctx);
    win.dispatchEvent(new ctx.CustomEvent('duo-turn-bridge',{detail:JSON.stringify({ready:true,stt:o.bridge.stt!==false})}));
  }
  const host=(p)=>{const h=new ctx.SttLiveHost(p||'soniox','A',{getAudioTracks:()=>[{readyState:'live',muted:false}]},{});h.startedAt=Date.now();return h;};
  return {ctx,logs,events,host};
}
test('the relay table sends exactly what the page sends directly',async()=>{
  const p=page(),calls=[];
  const host={request:(stage,url,opts)=>{calls.push({url,opts});return Promise.resolve({token:'t',api_key:'k'});}};
  const table=vm.runInContext('STT_RELAY_ISSUERS',sw().c);
  for(const id of ['elevenlabs','assemblyai','soniox']){
    calls.length=0;await p.ctx.STT_LIVE_PROVIDERS[id].credential(host,KEY);
    const d=calls[0],t=table[id],direct=J(d.opts.headers);
    assert.equal(t.url,d.url,id+' url');assert.equal(t.method,d.opts.method,id+' method');
    assert.equal(direct[t.header],t.prefix+KEY,id+' key header');
    assert.equal(t.body,d.opts.body||null,id+' body');
    assert.deepEqual(Object.keys(direct).filter(k=>k!==t.header&&k!=='Content-Type'),[],id+' no other headers');
  }
  assert.deepEqual(Object.keys(table).sort(),['assemblyai','elevenlabs','soniox']);
});

/* ── 内容スクリプト（html-source-content.js）──────────────────────────────── */
function content(reply){
  const listeners=new Map(),out=[],sent=[];
  const win={addEventListener(k,f){if(!listeners.has(k))listeners.set(k,new Set());listeners.get(k).add(f);},
    removeEventListener(k,f){listeners.get(k)?.delete(f);},
    dispatchEvent(e){out.push(e);for(const f of [...listeners.get(e.type)||[]])f(e);return true;}};
  const ctx={window:win,JSON,String,Promise,Object,CustomEvent:class{constructor(type,o){this.type=type;this.detail=o&&o.detail;}},
    chrome:{runtime:{sendMessage:async(m)=>{sent.push(m);return reply?reply(m):{ok:true,status:200,text:'{"api_key":"t"}'};},
      onMessage:{addListener(){},removeListener(){}}}}};
  vm.createContext(ctx);vm.runInContext(contentSrc,ctx);
  const fire=(k,detail)=>{for(const f of [...listeners.get(k)||[]])f({type:k,detail:typeof detail==='string'?detail:JSON.stringify(detail)});};
  const grab=(k)=>out.filter(e=>e.type===k).map(e=>JSON.parse(e.detail));
  const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
  return {sent,fire,grab,settle,dispose:()=>ctx.window.__duoHtmlContent.dispose()};
}
test('the content script passes on only the company and the key, and answers on duo-turn-reply',async()=>{
  const h=content();
  h.fire('duo-stt-token-request',{id:'s1',request:{provider:'soniox',key:KEY,url:'https://evil.test',headers:{Cookie:'x'}}});
  await h.settle();
  assert.deepEqual(J(h.sent),[{type:'DUO_STT_TOKEN',request:{provider:'soniox',key:KEY}}]);
  assert.deepEqual(h.grab('duo-turn-reply'),[{id:'s1',ok:true,status:200,text:'{"api_key":"t"}',unreachable:false,denied:false}]);
});
test('the content script passes a refusal through and ignores malformed or oversized requests',async()=>{
  const h=content(()=>({ok:false,denied:true,error:'この会社の一時キーは中継しません'}));
  h.fire('duo-stt-token-request',{id:'s2',request:{provider:'openai',key:KEY}});await h.settle();
  assert.equal(h.grab('duo-turn-reply')[0].denied,true);
  h.fire('duo-stt-token-request',{id:{},request:{provider:'soniox',key:KEY}});
  h.fire('duo-stt-token-request',{id:'s3'});
  h.fire('duo-stt-token-request','x'.repeat(4001));
  await h.settle();assert.equal(h.sent.length,1);
  h.dispose();h.fire('duo-stt-token-request',{id:'s4',request:{provider:'soniox',key:KEY}});await h.settle();
  assert.equal(h.sent.length,1,'nothing is forwarded after dispose');
});

/* ── ページの側：relay ───────────────────────────────────────────────── */
test('relay: the host asks the extension, and the temporary key comes back as from a direct request',async()=>{
  const b={seen:[],reply:()=>({ok:true,status:200,text:'{"api_key":"tmp-relay-000111"}'})};
  const p=page({cfg:{sttCredentialRoute:'relay'},bridge:b}),h=p.host('soniox');
  const cred=await h.credential(KEY,{});
  assert.equal(cred.secret,'tmp-relay-000111');
  assert.deepEqual(J(b.seen),[{provider:'soniox',key:KEY}],'the page sends the company and the key, nothing else');
  assert.ok(p.logs.some(l=>/live-token-request.*"route":"relay"/.test(l)));
  assert.ok(!p.logs.join('\n').includes(KEY),'the key is not logged');
});
test('relay: the provider\'s 401 is worded as a key problem; a refusal is a setting problem',async()=>{
  let p=page({cfg:{sttCredentialRoute:'relay'},bridge:{seen:[],reply:()=>({ok:true,status:401,text:'{"error":"bad"}'})}});
  await assert.rejects(p.host('soniox').credential(KEY,{}),(e)=>/キーが無効か/.test(e.message)&&e.status===401&&p.ctx.sttLiveErrorClass(e)==='auth');
  p=page({cfg:{sttCredentialRoute:'relay'},bridge:{seen:[],reply:()=>({ok:false,denied:true,error:'この経路からは中継できません'})}});
  await assert.rejects(p.host('soniox').credential(KEY,{}),(e)=>e.errorClass==='config');
  p=page({cfg:{sttCredentialRoute:'relay'},bridge:{seen:[],reply:()=>({ok:false,unreachable:true,status:0,error:'Failed to fetch'})}});
  await assert.rejects(p.host('soniox').credential(KEY,{}),(e)=>/拡張の中継でも Soniox/.test(e.message)&&p.ctx.sttLiveErrorClass(e)==='transient');
});
test('relay: no extension, or an extension too old to relay, stops with a setting message and sends nothing',async()=>{
  let p=page({cfg:{sttCredentialRoute:'relay'}});
  await assert.rejects(p.host('soniox').credential(KEY,{}),(e)=>/HTML本体がアドオンに接続されていません/.test(e.message)&&e.errorClass==='config');
  const b={seen:[],stt:false,reply:()=>({ok:true,status:200,text:'{}'})};
  p=page({cfg:{sttCredentialRoute:'relay'},bridge:b});
  await assert.rejects(p.host('soniox').credential(KEY,{}),(e)=>/1\.4\.54/.test(e.message)&&e.errorClass==='config');
  assert.equal(b.seen.length,0);
});
test('relay is not used for OpenAI (gpt-live stays direct)',()=>{
  const p=page({cfg:{sttCredentialRoute:'relay'}});
  assert.equal(p.ctx.sttCredentialRoute('openai'),'direct');assert.equal(p.ctx.sttCredentialRoute('soniox'),'relay');
});

/* ── ページの側：broker ──────────────────────────────────────────────── */
test('broker: POST {URL}/token/stt/{company} with the model, no cookies and no company key',async()=>{
  const seen=[];
  const p=page({cfg:{sttCredentialRoute:'broker',sttBrokerUrl:'https://broker.example.com/duo'},keys:{'stt:soniox':''},
    fetch:(url,init)=>{seen.push({url,init});return Promise.resolve({ok:true,status:200,headers:{get:()=>''},json:()=>Promise.resolve({token:'tmp-broker-000222',expires_at:'2026-09-30T00:01:00Z'})});}});
  assert.equal(p.ctx.sttLiveReady('soniox'),true,'no company key is needed on the page');
  const h=p.host('soniox'),cred=await h.credential('',{});
  assert.equal(cred.secret,'tmp-broker-000222');
  assert.equal(seen[0].url,'https://broker.example.com/duo/token/stt/soniox');
  assert.equal(seen[0].init.method,'POST');assert.equal(seen[0].init.credentials,'omit');
  assert.deepEqual(J(seen[0].init.headers),{'Content-Type':'application/json'});
  assert.deepEqual(JSON.parse(seen[0].init.body),{model:'stt-rt-v5'});
  assert.ok(p.ctx.STT_LIVE_SECRETS.includes('tmp-broker-000222'),'redacted like any temporary credential');
  assert.ok(!p.logs.join('\n').includes('tmp-broker-000222'));
});
test('broker: a start without any company key reaches the broker; the WebSocket gets the broker token',async()=>{
  const p=page({cfg:{sttCredentialRoute:'broker',sttBrokerUrl:'https://broker.example.com'},keys:{'stt:soniox':''},
    fetch:()=>Promise.resolve({ok:true,status:200,headers:{get:()=>''},json:()=>Promise.resolve({token:'tmp-broker-000333'})})});
  const h=p.host('soniox');let opened=null;h.openSocket=(url,hello)=>{opened={url,hello};return Promise.resolve();};
  await h.start();
  assert.equal(JSON.parse(opened.hello).api_key,'tmp-broker-000333');
});
test('broker: refusals and failures are worded without the broker\'s reply body',async()=>{
  const reply=(status,body)=>page({cfg:{sttCredentialRoute:'broker',sttBrokerUrl:'https://broker.example.com'},
    fetch:()=>Promise.resolve({ok:false,status,headers:{get:()=>''},text:()=>Promise.resolve(body)})});
  let p=reply(401,'internal: user alice@corp not in group stt-users');
  await assert.rejects(p.host('assemblyai').credential(KEY,{}),(e)=>/Token Broker が AssemblyAI の一時キーの発行を断りました（HTTP 401）/.test(e.message)&&!/alice/.test(e.message));
  assert.ok(!p.logs.join('\n').includes('alice'));
  p=reply(404,'no such provider');
  await assert.rejects(p.host('soniox').credential(KEY,{}),(e)=>/受け取れませんでした（HTTP 404）/.test(e.message)&&p.ctx.sttLiveErrorClass(e)==='config');
  p=page({cfg:{sttCredentialRoute:'broker',sttBrokerUrl:'https://broker.example.com'},fetch:()=>Promise.reject(new TypeError('Failed to fetch'))});
  await assert.rejects(p.host('soniox').credential(KEY,{}),(e)=>/Token Broker へ届きません（CORS の可能性/.test(e.message)&&e.unreachable===true);
  p=page({cfg:{sttCredentialRoute:'broker',sttBrokerUrl:'https://broker.example.com'},
    fetch:()=>Promise.resolve({ok:true,status:200,headers:{get:()=>''},json:()=>Promise.resolve({secret:'wrong-field'})})});
  await assert.rejects(p.host('soniox').credential(KEY,{}),(e)=>/token がありません/.test(e.message)&&e.errorClass==='config');
});
test('broker: the URL must be HTTPS without credentials, query or fragment',async()=>{
  const n=page().ctx.sttBrokerNormalize;
  assert.equal(n('https://broker.example.com/duo/'),'https://broker.example.com/duo');
  assert.equal(n(' https://broker.example.com '),'https://broker.example.com');
  for(const bad of ['http://broker.example.com','https://user:pw@broker.example.com','https://broker.example.com/?key=secret',
    'https://broker.example.com/#x','javascript:alert(1)','broker.example.com','',null])assert.equal(n(bad),'',String(bad));
  const p=page({cfg:{sttCredentialRoute:'broker',sttBrokerUrl:''}});
  await assert.rejects(p.host('soniox').credential(KEY,{}),(e)=>/URL が未設定/.test(e.message)&&e.errorClass==='config');
});
test('broker for gpt-live: the session goes to the broker, and its secret is used for the SDP exchange',async()=>{
  const seen=[];
  const p=page({cfg:{sttCredentialRoute:'broker',sttBrokerUrl:'https://broker.example.com',sttProvider:'openai'},
    fetch:(url,init)=>{seen.push({url,init});return Promise.resolve({ok:true,status:200,headers:{get:()=>''},json:()=>Promise.resolve({token:'ek_broker_000444'})});}});
  const a=p.ctx.STT_LIVE_PROVIDERS.openai,h=p.host('openai');let peer=null;
  a.peer=(host,secret)=>{peer=secret;return Promise.resolve();};
  await a.connect(h,'',{readyState:'live',muted:false});
  assert.equal(seen[0].url,'https://broker.example.com/token/stt/openai');
  const body=JSON.parse(seen[0].init.body);
  assert.equal(body.model,'gpt-live-transcribe');assert.equal(body.session.audio.input.transcription.model,'gpt-live-transcribe');
  assert.equal(peer,'ek_broker_000444');
});
test('direct stays the default and sends nothing to the extension or a broker',async()=>{
  const seen=[];
  const p=page({fetch:(url)=>{seen.push(url);return Promise.resolve({ok:true,status:200,headers:{get:()=>''},json:()=>Promise.resolve({api_key:'t-direct'})});}});
  assert.equal(p.ctx.sttCredentialRoute('soniox'),'direct');
  assert.equal((await p.host('soniox').credential(KEY,{})).secret,'t-direct');
  assert.deepEqual(seen,['https://api.soniox.com/v1/auth/temporary-api-key']);
  assert.ok(!p.events.some(e=>e.type==='duo-stt-token-request'));
});

(async()=>{
  for(const [name,fn] of queue){await fn();tests.push(name);}
  console.log(JSON.stringify({passed:tests.length,tests},null,2));
})().catch(err=>{console.error(err);process.exitCode=1;});
