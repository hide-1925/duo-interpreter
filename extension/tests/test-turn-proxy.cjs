'use strict';
/* 判断層の中継（拡張側）の受入試験。

   ここが守るのは「拡張が CORS 回避の汎用踏み台にならないこと」。ページから
   任意のホストへ任意のヘッダを投げられる中継を作ると、拡張を入れているだけで
   あらゆるサイトの同一オリジン制約を迂回できてしまう。だから
     1. 中継先は利用者が明示的に許可したオリジン1つだけ
     2. HTTPS のみ
     3. 通すヘッダは allowlist だけ
     4. 頼めるのは拡張自身のページと登録済みHTML本体のタブだけ
   を1件ずつ検査する。あわせて、中継された HTTP エラーが status を保つことも見る。
   status を落とすと NEVER_RETRY（401/404 で判断層を止める）が効かなくなる。 */
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..');
const proxySrc=fs.readFileSync(path.join(root,'turn-proxy.js'),'utf8');
const relaySrc=fs.readFileSync(path.join(root,'html-source-content.js'),'utf8');
const tests=[],queue=[];
const test=(n,f)=>queue.push([n,f]);

const EXT='chrome-extension://abcdef/';

function proxyHarness(over){
  const o=Object.assign({stored:'https://api.typesafe.ai',granted:['https://api.typesafe.ai/*'],
    htmlTabId:7,status:200,body:'{"ok":1}',failFetch:null},over||{});
  const seen=[],timers=[];
  const ctx={URL,Set,Object,JSON,String,Number,Promise,AbortController,
    setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},
    clearTimeout:()=>{},
    getState:async()=>({htmlTabId:o.htmlTabId}),
    chrome:{
      runtime:{getURL:(p)=>EXT+(p||'')},
      storage:{local:{
        get:async(k)=>o.stored?{[k]:o.stored}:{},
        set:async(patch)=>{o.stored=patch.duoTurnOrigin;},
        remove:async()=>{o.stored='';}}},
      permissions:{contains:async({origins})=>origins.every(x=>o.granted.indexOf(x)>=0)}
    },
    fetch:(url,opt)=>{
      seen.push({url,opt});
      if(o.failFetch)return Promise.reject(new Error(o.failFetch));
      if(opt.signal&&opt.signal.aborted)return Promise.reject(new Error('aborted'));
      return new Promise((resolve,reject)=>{
        if(opt.signal)opt.signal.addEventListener('abort',()=>reject(new Error('aborted')));
        if(o.hang)return;
        resolve({status:o.status,text:async()=>o.body});
      });
    }
  };
  const c=vm.createContext(ctx);
  vm.runInContext(proxySrc,c);
  return {c,ctx,seen,timers,o,fire:()=>timers.forEach(t=>t.fn())};
}
const extSender={url:EXT+'app.html'};
const tabSender={tab:{id:7}};
const req=(over)=>({request:Object.assign({url:'https://api.typesafe.ai/v1/systemone',
  headers:{'Authorization':'Bearer secret-key','Content-Type':'application/json'},
  body:'{"model":"jev-latest"}'},over||{})});

/* ── 中継先の限定 ─────────────────────────────────────────────────────── */
test('an unapproved origin is refused, and the refusal says setup is missing',async()=>{
  const h=proxyHarness({stored:''});
  const r=await h.c.turnFetch(req(),extSender);
  assert.equal(r.ok,false);
  assert.equal(r.needsSetup,true,'the page must be able to tell this apart from CORS');
  assert.equal(h.seen.length,0,'and nothing may go out');
});
test('a host other than the approved one is refused even when permission covers it',async()=>{
  const h=proxyHarness({granted:['https://api.typesafe.ai/*','https://evil.test/*']});
  const r=await h.c.turnFetch(req({url:'https://evil.test/v1/systemone'}),extSender);
  assert.equal(r.ok,false);
  assert.match(r.error,/許可されていない/);
  assert.equal(h.seen.length,0,'a generic relay would make the add-on a CORS bypass for any site');
});
test('http is refused; only https is relayed',async()=>{
  const h=proxyHarness({stored:'http://api.typesafe.ai',granted:['http://api.typesafe.ai/*']});
  const r=await h.c.turnFetch(req({url:'http://api.typesafe.ai/v1/systemone'}),extSender);
  assert.equal(r.ok,false);
  assert.equal(h.seen.length,0);
});
test('a revoked permission stops the relay even though the origin is still stored',async()=>{
  const h=proxyHarness({granted:[]});
  const r=await h.c.turnFetch(req(),extSender);
  assert.equal(r.ok,false);
  assert.equal(r.needsSetup,true);
  assert.equal(h.seen.length,0);
});
test('a malformed url is refused instead of thrown',async()=>{
  const h=proxyHarness();
  const r=await h.c.turnFetch(req({url:'not a url'}),extSender);
  assert.equal(r.ok,false);
  assert.equal(h.seen.length,0);
});

/* ── 頼める相手の限定 ─────────────────────────────────────────────────── */
test('only the add-on pages and the registered HTML tab may ask for a relay',async()=>{
  const h=proxyHarness();
  assert.equal((await h.c.turnFetch(req(),extSender)).ok,true,'the add-on page may');
  assert.equal((await h.c.turnFetch(req(),tabSender)).ok,true,'the registered HTML tab may');
  const other=await h.c.turnFetch(req(),{tab:{id:99}});
  assert.equal(other.ok,false,'another tab may not');
  const page=await h.c.turnFetch(req(),{url:'https://teams.microsoft.com/'});
  assert.equal(page.ok,false,'nor a content script on some other site');
});
test('with no HTML tab registered, a tab sender cannot relay',async()=>{
  const h=proxyHarness({htmlTabId:null});
  const r=await h.c.turnFetch(req(),{tab:{id:7}});
  assert.equal(r.ok,false);
});

/* ── ヘッダと本文 ─────────────────────────────────────────────────────── */
test('only the allowlisted headers are forwarded',async()=>{
  const h=proxyHarness();
  await h.c.turnFetch(req({headers:{'Authorization':'Bearer secret-key',
    'Content-Type':'application/json','Cookie':'session=1','Origin':'https://evil.test',
    'X-Forwarded-For':'10.0.0.1','Host':'evil.test'}}),extSender);
  const sent=h.seen[0].opt.headers;
  assert.equal(sent.Authorization,'Bearer secret-key');
  assert.equal(sent['Content-Type'],'application/json');
  for(const bad of ['Cookie','Origin','X-Forwarded-For','Host'])
    assert.ok(!(bad in sent),bad+' must not be carried by the relay');
});
test('a missing content type is filled in rather than letting the server guess',async()=>{
  const h=proxyHarness();
  await h.c.turnFetch(req({headers:{'Authorization':'Bearer k'}}),extSender);
  assert.equal(h.seen[0].opt.headers['Content-Type'],'application/json');
});
test('an oversized or empty body is refused before the request goes out',async()=>{
  const h=proxyHarness();
  const big=await h.c.turnFetch(req({body:'x'.repeat(262145)}),extSender);
  assert.equal(big.ok,false);
  const empty=await h.c.turnFetch(req({body:''}),extSender);
  assert.equal(empty.ok,false);
  assert.equal(h.seen.length,0);
});
test('a header value that is not a short string is dropped, not forwarded',async()=>{
  const h=proxyHarness();
  await h.c.turnFetch(req({headers:{'Authorization':'Bearer k',
    'Content-Type':'x'.repeat(5000)}}),extSender);
  assert.equal(h.seen[0].opt.headers['Content-Type'],'application/json','the long one is dropped');
});

/* ── 応答 ─────────────────────────────────────────────────────────────── */
test('an HTTP error is relayed with its status, not turned into a failure',async()=>{
  const h=proxyHarness({status:401,body:'unauthorized'});
  const r=await h.c.turnFetch(req(),extSender);
  assert.equal(r.ok,true,'the relay succeeded; the server refused');
  assert.equal(r.status,401,'the page needs the status to stop the layer');
  assert.equal(r.text,'unauthorized');
});
test('a network failure is marked unreachable and carries no request detail',async()=>{
  const h=proxyHarness({failFetch:'getaddrinfo ENOTFOUND'});
  const r=await h.c.turnFetch(req(),extSender);
  assert.equal(r.ok,false);
  assert.equal(r.unreachable,true);
  const dump=JSON.stringify(r);
  assert.ok(!/secret-key/.test(dump),'the key must never come back out');
  assert.ok(!/jev-latest/.test(dump),'nor the request body');
});
test('the relay gives up on its own timer instead of waiting forever',async()=>{
  const h=proxyHarness({hang:true});
  const task=h.c.turnFetch(req(),extSender);
  /* turnFetch は保存値と権限を待ってから発射するので、タイマーはまだ立っていない。 */
  for(let i=0;i<12;i++)await Promise.resolve();
  assert.equal(h.timers.length,1);
  assert.equal(h.timers[0].ms,30000);
  h.fire();
  const r=await task;
  assert.equal(r.ok,false);
  assert.equal(r.unreachable,true);
  assert.match(r.error,/時間内/);
});
test('an oversized reply is refused rather than handed to the page',async()=>{
  const h=proxyHarness({body:'x'.repeat(1048577)});
  const r=await h.c.turnFetch(req(),extSender);
  assert.equal(r.ok,false);
  assert.equal(r.status,200,'the status is still reported');
});

/* ── 許可の登録 ───────────────────────────────────────────────────────── */
test('the origin can only be stored once the permission is actually held',async()=>{
  const h=proxyHarness({stored:'',granted:[]});
  await assert.rejects(()=>h.c.setTurnOrigin('https://api.typesafe.ai'),/許可/);
  assert.equal(h.o.stored,'','nothing is stored on refusal');
});
test('a stored origin is normalised to an origin and rejects credentials',async()=>{
  const h=proxyHarness({stored:''});
  const r=await h.c.setTurnOrigin('https://api.typesafe.ai/v1/systemone?x=1');
  assert.equal(r.ok,true);
  assert.equal(h.o.stored,'https://api.typesafe.ai','the path and query are dropped');
  await assert.rejects(()=>h.c.setTurnOrigin('https://user:pw@api.typesafe.ai'),/認証情報/);
  await assert.rejects(()=>h.c.setTurnOrigin('ftp://api.typesafe.ai'),/HTTPS/);
});
test('the permission state reported to the popup separates stored from granted',async()=>{
  /* vm の realm で作られた object なので deepEqual は参照違いで落ちる。項目で見る。 */
  const flat=(p)=>p.origin+'/'+p.allowed;
  assert.equal(flat(await proxyHarness({stored:''}).c.turnPermission()),'/false');
  assert.equal(flat(await proxyHarness().c.turnPermission()),'https://api.typesafe.ai/true');
  assert.equal(flat(await proxyHarness({granted:[]}).c.turnPermission()),
    'https://api.typesafe.ai/false','stored but revoked must be visible');
});
test('clearing the origin drops the stored value',async()=>{
  const h=proxyHarness();
  const r=await h.c.clearTurnOrigin();
  assert.equal(r.ok,true);
  assert.equal(h.o.stored,'');
});

/* ── ページ側の中継（内容スクリプト） ─────────────────────────────────── */
function relayHarness(reply){
  const listeners=new Map(),out=[],sent=[];
  const win={
    addEventListener(k,f){if(!listeners.has(k))listeners.set(k,new Set());listeners.get(k).add(f);},
    removeEventListener(k,f){listeners.get(k)?.delete(f);},
    dispatchEvent(e){out.push(e);for(const f of [...listeners.get(e.type)||[]])f(e);return true;}
  };
  const ctx={window:win,JSON,String,Promise,Object,
    CustomEvent:class{constructor(type,o){this.type=type;this.detail=o&&o.detail;}},
    chrome:{runtime:{
      sendMessage:async(m)=>{sent.push(m);return reply?reply(m):{ok:true,status:200,text:'{}'};},
      onMessage:{addListener(){},removeListener(){}}}}
  };
  const c=vm.createContext(ctx);
  vm.runInContext(relaySrc,c);
  const fire=(k,detail)=>{for(const f of [...listeners.get(k)||[]])f({type:k,detail:JSON.stringify(detail)});};
  const grab=(k)=>out.filter(e=>e.type===k).map(e=>JSON.parse(e.detail));
  return {win,ctx,out,sent,fire,grab,dispose:()=>ctx.window.__duoHtmlContent.dispose()};
}
test('the content script announces the relay the moment it attaches',()=>{
  const h=relayHarness();
  assert.deepEqual(h.grab('duo-turn-bridge'),[{ready:true}],
    'the page cannot see chrome.* , so it can only learn this by being told');
});
test('the page can ask whether the relay is there',()=>{
  const h=relayHarness();
  h.fire('duo-turn-hello',{});
  assert.equal(h.grab('duo-turn-bridge').length,2,'a hello is answered');
});
test('a request is forwarded to the worker and the reply comes back under the same id',async()=>{
  const h=relayHarness((m)=>({ok:true,status:200,text:'{"answers":{}}'}));
  h.fire('duo-turn-request',{id:'t1',request:{url:'https://api.typesafe.ai/v1/systemone'}});
  for(let i=0;i<8;i++)await Promise.resolve();
  assert.equal(h.sent.length,1);
  assert.equal(h.sent[0].type,'DUO_TURN_FETCH');
  const replies=h.grab('duo-turn-reply');
  assert.equal(replies.length,1);
  assert.equal(replies[0].id,'t1');
  assert.equal(replies[0].ok,true);
  assert.equal(replies[0].text,'{"answers":{}}');
});
test('a refusal keeps its flags so the page can say what is wrong',async()=>{
  const h=relayHarness(()=>({ok:false,needsSetup:true,error:'未設定'}));
  h.fire('duo-turn-request',{id:'t2',request:{url:'https://api.typesafe.ai/v1/systemone'}});
  for(let i=0;i<8;i++)await Promise.resolve();
  const r=h.grab('duo-turn-reply')[0];
  assert.equal(r.ok,false);
  assert.equal(r.needsSetup,true);
});
test('a dead worker becomes an unreachable reply, not a hang',async()=>{
  const h=relayHarness(()=>{throw new Error('Receiving end does not exist');});
  h.fire('duo-turn-request',{id:'t3',request:{url:'https://api.typesafe.ai/v1/systemone'}});
  for(let i=0;i<8;i++)await Promise.resolve();
  const r=h.grab('duo-turn-reply')[0];
  assert.equal(r.ok,false);
  assert.equal(r.unreachable,true);
});
test('an id that is not a short string is ignored',async()=>{
  const h=relayHarness();
  h.fire('duo-turn-request',{id:{},request:{url:'https://api.typesafe.ai/'}});
  h.fire('duo-turn-request',{id:'x'.repeat(81),request:{url:'https://api.typesafe.ai/'}});
  for(let i=0;i<8;i++)await Promise.resolve();
  assert.equal(h.sent.length,0);
});
test('dispose tells the page the relay is gone and stops forwarding',async()=>{
  const h=relayHarness();
  h.dispose();
  assert.deepEqual(h.grab('duo-turn-bridge').slice(-1),[{ready:false}],
    'otherwise the page waits on a relay that no longer exists');
  h.fire('duo-turn-request',{id:'t4',request:{url:'https://api.typesafe.ai/'}});
  for(let i=0;i<8;i++)await Promise.resolve();
  assert.equal(h.sent.length,0);
});

(async()=>{
  for(const [name,fn] of queue){await fn();tests.push(name);}
  console.log(JSON.stringify({passed:tests.length,tests},null,2));
})().catch(err=>{console.error(err);process.exitCode=1;});
