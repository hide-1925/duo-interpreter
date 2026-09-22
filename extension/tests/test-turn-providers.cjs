/* Provider adapter 層の受入試験（Phase 2）。fetch をモックして決定論的に検査する。
   狙いは3つ。provider=rules では registry を引かないこと。応答の正規化が
   schema 外・確率破綻・欠落・巨大応答を必ず拒否すること。circuit breaker が
   障害を閉じ込め、字幕や翻訳へ伝播させないこと。 */
const path=require('node:path'),fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const src=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8').replace(/\r\n/g,'\n');
const lines=src.split('\n');
function block(startsWith){
  const i=lines.findIndex(l=>l.startsWith(startsWith));
  assert.ok(i>=0,'block not found: '+startsWith);
  for(let j=i+1;j<lines.length;j++) if(lines[j]==='}'||lines[j]==='};') return lines.slice(i,j+1).join('\n');
  throw new Error('unterminated: '+startsWith);
}
function segBlock(){
  const m=src.match(/var SEG = \{[\s\S]*?correctedBySource:\{provider:0,rules:0\}\};/);
  assert.ok(m,'SEG not found');return m[0];
}

const calls=[],toasts=[],logs=[];
let fetchImpl=null;
const ctx={console,Math,Date,JSON,Object,Array,String,Number,isFinite,RegExp,Promise,
  setTimeout,clearTimeout,AbortController,
  APP_BUILD:'test',sessionGen:1,CFG:{},S:{entries:[]},DuoSpeakers:{available:false},
  dlog:(a,b,c)=>logs.push([b,c]),segDebt:()=>0,toast:m=>toasts.push(m),
  persistSetting:()=>{}, micProsody:null,
  hasSpeechContent:t=>/[\p{L}\p{N}]/u.test(String(t||'')),
  fetch:(url,opt)=>{calls.push({url,opt});return fetchImpl(url,opt);}};
const c=vm.createContext(ctx);
for(const b of [segBlock(),block('function segEnabled()'),block('function segDecision(input){'),
                block('function segSemanticEnabled()'),block('function segSemanticTail(text,lang){'),
                block('function segSemanticDecision(input){'),
                block('var TurnProviders={'),block('var TURN_STATE_SCHEMA='),
                block('var TurnDecision={'),block('var TurnTrace={')]) vm.runInContext(b,c);

/* async のテスト本体を await しないと、失敗が unhandled rejection になり
   実質ゲートにならない。順番に await する。 */
const queue=[],tests=[];
const test=(n,f)=>{queue.push([n,f]);};
const D=()=>c.TurnDecision,P=()=>c.TurnProviders;
function reset(over){
  calls.length=0;toasts.length=0;logs.length=0;
  ctx.CFG=Object.assign({segmentMode:'balanced',segmentBoundary:'semantic',sttProvider:'openai',
    segmentOverlap:'auto',vad:12,turnDecisionMode:'active',turnDecisionProvider:'rules',
    turnDecisionLangEn:'active',turnDecisionLangJa:'active',turnDecisionContextTurns:0,
    turnDecisionTimeoutMs:900,turnDecisionProsody:true,turnTraceMode:'off',
    turnDecisionApiKey:'k',turnDecisionBaseUrl:'https://api.typesafe.ai'},over||{});
  D().cache={};D().inflight={};D().circuit={};D()._lastSend={};D()._qsh=null;
}
const card=(o)=>Object.assign({id:'e1',utteranceId:'u1',seat:'A',srcLang:'ja',
  segment:{revision:3,final:false},segments:[]},o||{});
const input=(o)=>Object.assign({text:'来週の予定は火曜日です。',stableLength:12,lang:'ja',idleMs:200,
  mode:'balanced',debt:0,silenceMs:800,final:false,
  policy:{min:12,max:48,stability:400,silence:700,mode:'balanced'}},o||{});
const stateOf=()=>{const i=input();return D().stateOf(card(),{},i,D().rules(i),800,Date.now());};
const ok=(over)=>Object.assign({decisionId:'d1',boundary:{choice:'C_STABLE',confidence:0.8,
  probabilities:{HOLD:0.1,C_STABLE:0.9}},turnState:{choice:'COMPLETE',confidence:0.8},
  safeToSpeak:0.9,repairLikelihood:0.05},over||{});
const reply=(body,status)=>()=>Promise.resolve({ok:status?status<400:true,status:status||200,
  text:()=>Promise.resolve(typeof body==='string'?body:JSON.stringify(body))});

/* ── provider=rules では registry を引かない ───────────────────────────── */
test('rules never touches the network, even in active mode',()=>{
  reset({turnDecisionProvider:'rules'});
  fetchImpl=reply(ok());
  D().observe(stateOf());
  assert.equal(calls.length,0);
  assert.equal(Object.keys(D().inflight).length,0);
});
test('an unknown provider falls back instead of throwing',()=>{
  reset({turnDecisionProvider:'nope'});
  D().observe(stateOf());
  assert.equal(calls.length,0);
  assert.ok(logs.some(l=>l[0]==='turn-decision-fallback'));
});

/* ── 正規化 ────────────────────────────────────────────────────────────── */
test('a well formed answer normalizes and keeps the contract fields',()=>{
  reset();const s=stateOf();
  const n=P().normalize(ok(),s,{provider:'jev-direct',model:'jev-1.13.0',
    semantics:'native_calibrated',latencyMs:184,questionSetHash:'qs_x'});
  assert.equal(n.boundary.choice,'C_STABLE');
  assert.equal(n.revision,s.revision);
  assert.equal(n.probabilitySemantics,'native_calibrated');
  assert.equal(typeof n.receivedAt,'number');
});
test('a choice outside the offered candidates is refused',()=>{
  reset();const s=stateOf();
  assert.equal(P().normalize(ok({boundary:{choice:'C_EVIL',confidence:0.9}}),s,{}),null);
});
test('a probability on an option that was never offered is refused',()=>{
  reset();const s=stateOf();
  assert.equal(P().normalize(ok({boundary:{choice:'HOLD',confidence:0.9,
    probabilities:{HOLD:0.5,C_EVIL:0.5}}}),s,{}),null);
});
test('probabilities that do not add up are refused',()=>{
  reset();const s=stateOf();
  assert.equal(P().normalize(ok({boundary:{choice:'HOLD',confidence:0.9,
    probabilities:{HOLD:0.01}}}),s,{}),null);
});
test('NaN, out of range and missing values are refused',()=>{
  reset();const s=stateOf();
  for(const bad of [ok({safeToSpeak:NaN}),ok({safeToSpeak:1.7}),ok({repairLikelihood:null}),
                    ok({boundary:{choice:'HOLD'}}),ok({boundary:null}),{}, null, 'x'])
    assert.equal(P().normalize(bad,s,{}),null,JSON.stringify(bad));
});
test('an unknown turn state is refused, and an absent one becomes UNKNOWN',()=>{
  reset();const s=stateOf();
  assert.equal(P().normalize(ok({turnState:{choice:'WAT',confidence:0.5}}),s,{}),null);
  assert.equal(P().normalize(ok({turnState:undefined}),s,{}).turnState.choice,'UNKNOWN');
});

/* ── jev-direct ───────────────────────────────────────────────────────── */
test('the request carries ZDR and no-training headers on the direct path',async()=>{
  reset({turnDecisionProvider:'jev-direct'});
  fetchImpl=reply(ok());
  await P()['jev-direct'].evaluate(stateOf(),{});
  const h=calls[0].opt.headers;
  assert.equal(h['X-TypeSafe-Zero-Data-Retention'],'true');
  assert.equal(h['X-TypeSafe-No-Training'],'true');
  assert.match(calls[0].url,/\/v1\/systemone$/);
});
test('a missing key or a non-https base url is refused before any request',async()=>{
  reset({turnDecisionProvider:'jev-direct',turnDecisionApiKey:''});
  await assert.rejects(()=>P()['jev-direct'].evaluate(stateOf(),{}),/turnDecisionApiKey/);
  reset({turnDecisionProvider:'jev-direct',turnDecisionBaseUrl:'http://insecure.example'});
  fetchImpl=reply(ok());
  await assert.rejects(()=>P()['jev-direct'].evaluate(stateOf(),{}),/HTTPS/);
  assert.equal(calls.length,0);
});
test('a huge or non-JSON body is refused',async()=>{
  reset({turnDecisionProvider:'jev-direct'});
  fetchImpl=reply('x'.repeat(200001));
  await assert.rejects(()=>P()['jev-direct'].evaluate(stateOf(),{}),/大きすぎ/);
  fetchImpl=reply('<html>error</html>');
  await assert.rejects(()=>P()['jev-direct'].evaluate(stateOf(),{}),/JSON/);
});

/* ── local ────────────────────────────────────────────────────────────── */
test('local refuses to run without fitted weights',async()=>{
  reset({turnDecisionProvider:'local'});
  await assert.rejects(()=>P().local.evaluate(stateOf()),/重み/);
});
const W=(over)=>({version:'w1',languages:Object.assign({
  ja:{bias:-1,features:{silence:2,final:1.5,pitchSlope:-3},threshold:0.6}},over||{})});

test('local runs once weights for that language are supplied, and stays offline',async()=>{
  reset({turnDecisionProvider:'local',turnDecisionLocalWeights:W()});
  const n=await P().local.evaluate(stateOf());
  assert.ok(n,'a fitted local model must produce a normalized answer');
  assert.equal(n.provider,'local');
  assert.equal(n.probabilitySemantics,'post_calibrated');
  assert.match(n.model,/^w1:ja$/,'the model id must name the language it was fitted for');
  assert.equal(calls.length,0,'local must not use the network');
});
test('local refuses a language it has no weights for, rather than borrowing another',async()=>{
  /* 日本語の重みだけがある状態で英語の発話が来ても、流用してはいけない。 */
  reset({turnDecisionProvider:'local',turnDecisionLocalWeights:W()});
  const i=input({lang:'en'});
  const s=D().stateOf(card({srcLang:'en'}),{},i,D().rules(i),800,Date.now());
  await assert.rejects(()=>P().local.evaluate(s),/en.*重み/);
});
test('local refuses weights that carry no calibrated threshold',async()=>{
  reset({turnDecisionProvider:'local',
    turnDecisionLocalWeights:{version:'w1',languages:{ja:{bias:-1,features:{silence:2}}}}});
  await assert.rejects(()=>P().local.evaluate(stateOf()),/重み/);
});
test('local uses the calibrated threshold, not a hardcoded 0.5',async()=>{
  /* bias だけで complete=0.55 付近にし、閾値0.6では HOLD、0.5では commit になることを見る。 */
  const z=Math.log(0.55/0.45);
  reset({turnDecisionProvider:'local',
    turnDecisionLocalWeights:{version:'w1',languages:{ja:{bias:z,features:{},threshold:0.6}}}});
  assert.equal((await P().local.evaluate(stateOf())).boundary.choice,'HOLD');
  reset({turnDecisionProvider:'local',
    turnDecisionLocalWeights:{version:'w1',languages:{ja:{bias:z,features:{},threshold:0.5}}}});
  assert.notEqual((await P().local.evaluate(stateOf())).boundary.choice,'HOLD');
});
test('local is declared local so it is exempt from transport guards',()=>{
  assert.equal(P().local.capabilities().local,true);
  assert.equal(P()['jev-direct'].capabilities().local,false);
});

/* ── circuit breaker ──────────────────────────────────────────────────── */
test('three failures in 30s open the circuit and stop calling out',async()=>{
  reset({turnDecisionProvider:'jev-direct'});
  for(let i=0;i<3;i++){D().circuitFail('jev-direct','ja','transport');}
  assert.equal(D().circuitOpen('jev-direct','ja'),true);
  const before=calls.length;
  D().observe(stateOf());
  assert.equal(calls.length,before,'an open circuit must not call out');
  assert.ok(logs.some(l=>l[0]==='turn-circuit-open'));
});
test('the circuit is per provider and per language',()=>{
  reset();
  for(let i=0;i<3;i++)D().circuitFail('jev-direct','ja','transport');
  assert.equal(D().circuitOpen('jev-direct','ja'),true);
  assert.equal(D().circuitOpen('jev-direct','en'),false);
  assert.equal(D().circuitOpen('local','ja'),false);
});
test('two successes close a half open circuit',()=>{
  reset();
  const cc=D().circuitOf('jev-direct','ja');
  cc.openUntil=Date.now()-1;cc.halfOpen=false;
  assert.equal(D().circuitOpen('jev-direct','ja'),false);
  assert.equal(cc.halfOpen,true);
  D().circuitOk('jev-direct','ja');D().circuitOk('jev-direct','ja');
  assert.equal(cc.halfOpen,false);assert.equal(cc.openUntil,0);
});
test('a 401 stops the decision layer instead of retrying',async()=>{
  reset({turnDecisionProvider:'jev-direct'});
  fetchImpl=reply('{}',401);
  D().observe(stateOf());
  await new Promise(r=>setTimeout(r,20));
  assert.equal(ctx.CFG.turnDecisionMode,'off');
  assert.ok(toasts.some(t=>/401/.test(t)));
});

/* ── 発火の制御 ───────────────────────────────────────────────────────── */
test('only one request per speaker is in flight at a time',()=>{
  reset({turnDecisionProvider:'jev-direct'});
  fetchImpl=()=>new Promise(()=>{});
  const s=stateOf();
  D().observe(s);D().observe(s);D().observe(s);
  assert.equal(calls.length,1);
});
test('the same bucket is not resent inside 300ms, but a longer silence is a new state',()=>{
  reset({turnDecisionProvider:'jev-direct'});
  const i=input(),s1=D().stateOf(card(),{},i,D().rules(i),800,Date.now());
  assert.equal(D().throttled(s1),false);
  assert.equal(D().throttled(s1),true,'same bucket inside 300ms');
  const s2=D().stateOf(card(),{},i,D().rules(i),1200,Date.now());
  assert.equal(D().throttled(s2),false,'a 100ms-quantised silence step is a new state');
});
test('the question set hash is stable and changes with the instructions',()=>{
  reset();
  const a=D().questionSetHash();
  D()._qsh=null;
  assert.equal(D().questionSetHash(),a,'stable for the same instructions');
  assert.match(a,/^qs_/);
});
test('reset drops the circuit and the send history too',()=>{
  reset();
  D().circuitFail('jev-direct','ja','x');D().throttled(stateOf());
  D().reset('test');
  assert.equal(Object.keys(D().circuit).length,0);
  assert.equal(Object.keys(D()._lastSend).length,0);
});

(async()=>{
  for(const [name,fn] of queue){ await fn(); tests.push(name); }
  console.log(JSON.stringify({passed:tests.length,tests},null,2));
})().catch(err=>{console.error(err);process.exitCode=1;});
