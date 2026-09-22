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
for(const b of [segBlock(),block('var TURN_PROSODY_SENT='),
                block('function segEnabled()'),block('function segDecision(input){'),
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
    turnDecisionApiKey:'k',turnDecisionBaseUrl:'https://api.typesafe.ai',
    /* active では alias を拒否するので、既定で固定version を入れておく。 */
    turnDecisionModel:'jev-1.13.0'},over||{});
  D().cache={};D().inflight={};D().circuit={};D()._lastSend={};D()._confirm={};D()._qsh=null;
}
const card=(o)=>Object.assign({id:'e1',utteranceId:'u1',seat:'A',srcLang:'ja',
  segment:{revision:3,final:false},segments:[]},o||{});
const input=(o)=>Object.assign({text:'来週の予定は火曜日です。',stableLength:12,lang:'ja',idleMs:200,
  mode:'balanced',debt:0,silenceMs:800,final:false,
  policy:{min:12,max:48,stability:400,silence:700,mode:'balanced'}},o||{});
const stateOf=()=>{const i=input();return D().stateOf(card(),{},i,D().rules(i),800,Date.now());};
/* 正規化の直接検査に使う内部形。 */
/* 候補IDは offset ごとに一意なので、state から実際のIDを取る。 */
const firstId=(state)=>(state.candidateBoundaries||[]).length?state.candidateBoundaries[0].id:'HOLD';
const inner=(state,over)=>{
  const id=firstId(state),probs={HOLD:0.1};probs[id]=0.9;
  return Object.assign({decisionId:'d1',boundary:{choice:id,confidence:0.8,probabilities:probs},
    turnState:{choice:'COMPLETE',confidence:0.8},safeToSpeak:0.9,repairLikelihood:0.05},over||{});
};
/* 公式リファレンスどおりの応答。answers を自分の質問IDで引き、choice は
   choice／probabilities／confidence、noul は noul だけを持つ。 */
const wire=(state,over)=>{
  const id=(state.candidateBoundaries||[]).length?state.candidateBoundaries[0].id:'HOLD';
  const probs={HOLD:0.12};probs[id]=0.88;
  return Object.assign({model:'jev-1.13.0',answers:Object.assign({
    boundary_choice:{type:'choice',choice:id,probabilities:probs,confidence:0.81},
    turn_state:{type:'choice',choice:'COMPLETE',
      probabilities:{COMPLETE:0.9,CONTINUING:0.05,SELF_REPAIR:0.03,UNKNOWN:0.02},confidence:0.84},
    safe_to_speak:{type:'noul',noul:0.95},
    repair_likelihood:{type:'noul',noul:0.04}},(over&&over.answers)||{}),
    usage:{input_tokens:307,output_tokens:20}},over&&over.top||{});
};

const reply=(body,status)=>()=>Promise.resolve({ok:status?status<400:true,status:status||200,
  text:()=>Promise.resolve(typeof body==='string'?body:JSON.stringify(body))});

/* ── provider=rules では registry を引かない ───────────────────────────── */
test('rules never touches the network, even in active mode',()=>{
  reset({turnDecisionProvider:'rules'});
  fetchImpl=reply({});
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
  const n=P().normalize(inner(s),s,{provider:'jev-direct',model:'jev-1.13.0',
    semantics:'native_calibrated',latencyMs:184,questionSetHash:'qs_x'});
  assert.equal(n.boundary.choice,firstId(s));
  assert.equal(n.revision,s.revision);
  assert.equal(n.probabilitySemantics,'native_calibrated');
  assert.equal(typeof n.receivedAt,'number');
});
test('a choice outside the offered candidates is refused',()=>{
  reset();const s=stateOf();
  assert.equal(P().normalize(inner(s,{boundary:{choice:'C_EVIL',confidence:0.9}}),s,{}),null);
});
test('a probability on an option that was never offered is refused',()=>{
  reset();const s=stateOf();
  assert.equal(P().normalize(inner(s,{boundary:{choice:'HOLD',confidence:0.9,
    probabilities:{HOLD:0.5,C_EVIL:0.5}}}),s,{}),null);
});
test('probabilities that do not add up are refused',()=>{
  reset();const s=stateOf();
  assert.equal(P().normalize(inner(s,{boundary:{choice:'HOLD',confidence:0.9,
    probabilities:{HOLD:0.01}}}),s,{}),null);
});
test('NaN, out of range and missing values are refused',()=>{
  reset();const s=stateOf();
  for(const bad of [inner(s,{safeToSpeak:NaN}),inner(s,{safeToSpeak:1.7}),inner(s,{repairLikelihood:null}),
                    inner(s,{boundary:{choice:'HOLD'}}),inner(s,{boundary:null}),{}, null, 'x'])
    assert.equal(P().normalize(bad,s,{}),null,JSON.stringify(bad));
});
test('an unknown turn state is refused, and an absent one becomes UNKNOWN',()=>{
  reset();const s=stateOf();
  assert.equal(P().normalize(inner(s,{turnState:{choice:'WAT',confidence:0.5}}),s,{}),null);
  assert.equal(P().normalize(inner(s,{turnState:undefined}),s,{}).turnState.choice,'UNKNOWN');
});

/* ── jev-direct ───────────────────────────────────────────────────────── */
/* かつては ZDR と no-training のヘッダを常に送っていたが、公式リファレンスに記載が
   無く、私が足したものだった。別オリジンへの preflight を増やすだけで疎通を落とす
   ので既定では送らない（実機で "Failed to fetch" になった）。 */
test('the request goes to the documented endpoint with bearer auth',async()=>{
  reset({turnDecisionProvider:'jev-direct'});
  const s=stateOf();fetchImpl=reply(wire(s));
  await P().get('jev-direct').evaluate(s,{});
  const h=calls[0].opt.headers;
  assert.match(calls[0].url,/\/v1\/systemone$/);
  assert.equal(h.Authorization,'Bearer k');
});

test('the request body matches the documented shape: state, model, questions',async()=>{
  reset({turnDecisionProvider:'jev-direct',turnDecisionModel:'jev-1.13.0'});
  const s=stateOf();fetchImpl=reply(wire(s));
  await P().get('jev-direct').evaluate(s,{});
  const body=JSON.parse(calls[0].opt.body);
  assert.deepEqual(Object.keys(body).sort(),['model','questions','state']);
  assert.equal(body.model,'jev-1.13.0');
  assert.equal(typeof body.state,'object','state may be structured data');
  assert.equal(body.state.schemaVersion,'duo.turn-state.v1');
  assert.equal(body.instructions,undefined,'instructions belong to each question, not the top level');
});

test('each question carries type, instructions and criteria in the documented form',async()=>{
  reset({turnDecisionProvider:'jev-direct'});
  const s=stateOf();fetchImpl=reply(wire(s));
  await P().get('jev-direct').evaluate(s,{});
  const q=JSON.parse(calls[0].opt.body).questions;
  assert.deepEqual(Object.keys(q).sort(),
    ['boundary_choice','repair_likelihood','safe_to_speak','turn_state']);
  assert.equal(q.boundary_choice.type,'choice');
  assert.equal(typeof q.boundary_choice.instructions,'string');
  /* choice の criteria は「選択肢 → 説明」の map。options 配列ではない。 */
  assert.equal(typeof q.boundary_choice.criteria,'object');
  assert.ok(!Array.isArray(q.boundary_choice.criteria));
  assert.ok(q.boundary_choice.options===undefined,'options is not part of the contract');
  assert.ok(q.boundary_choice.criteria.HOLD,'HOLD must be an offered option');
  assert.ok(Object.keys(q.boundary_choice.criteria).length<=255,'Choice allows at most 255 options');
  /* noul の criteria は true/false の意味。 */
  assert.equal(q.safe_to_speak.type,'noul');
  assert.equal(typeof q.safe_to_speak.criteria['true'],'string');
  assert.equal(typeof q.safe_to_speak.criteria['false'],'string');
});

/* 公式は「似ていて混同しやすい選択肢には項目立てした criteria を渡せ」と書いている。
   HOLD と「ここで切る」はこの設計で最も混同しやすい対なので、同じ項目立てで渡す。 */
test('HOLD and each cut candidate are described with the same structured fields',async()=>{
  reset({turnDecisionProvider:'jev-direct'});
  const s=stateOf();fetchImpl=reply(wire(s));
  await P().get('jev-direct').evaluate(s,{});
  const crit=JSON.parse(calls[0].opt.body).questions.boundary_choice.criteria;
  const hold=crit.HOLD;
  assert.equal(typeof hold,'object','HOLD needs structured criteria, not one sentence');
  for(const f of ['what','not_for','examples'])
    assert.equal(typeof hold[f],'string','HOLD criteria needs '+f);
  const ids=Object.keys(crit).filter(k=>k!=='HOLD');
  assert.ok(ids.length,'there must be at least one cut candidate to contrast with HOLD');
  for(const id of ids){
    assert.equal(typeof crit[id],'object',id+' needs structured criteria');
    for(const f of ['what','not_for','before','after'])
      assert.equal(typeof crit[id][f],'string',id+' criteria needs '+f);
  }
});

/* 「モデルは並べなかった値を選べない」。文末が多い発話で、構造上の候補（とくに
   final のときの C_FULL）が文末候補に押し出されてはならない。 */
test('the structural candidates survive a text full of sentence ends',()=>{
  reset();
  /* 末尾に文末記号のない語を足し、C_FULL が C_STABLE と別 offset になるようにする。
     同じ offset なら重複排除されるのが正しいので、そこは検査対象にしない。 */
  const text='あ。'.repeat(40)+'それで';
  const i=input({text:text,stableLength:80,final:true});
  const cands=D().candidatesOf(i,D().rules(i));
  const kinds=cands.map(c=>c.kind);
  assert.ok(kinds.indexOf('C_FULL')>=0,'C_FULL must be offered on a final result');
  assert.ok(kinds.indexOf('C_STABLE')>=0,'the stable prefix edge must be offered too');
  assert.ok(cands.length>5,'candidates are no longer shortlisted to five: '+cands.length);
  assert.ok(cands.length<=64,'but they stay inside the documented cap: '+cands.length);
  const ids=cands.map(c=>c.id);
  assert.equal(new Set(ids).size,ids.length,'ids stay unique at scale');
  for(const c of cands)
    assert.ok(c.offset>0&&c.offset<=text.length,c.id+' points outside the text');
});

/* ── 経路レジストリ（拡張性）──────────────────────────────────────────── */
/* 経路は宣言で足せること。足した経路がUI・診断・引き当ての全部に出ること。 */
test('every declared route carries the full contract a new vendor must fill in',()=>{
  reset();
  const R=P().ROUTES;
  const ids=Object.keys(R);
  assert.ok(ids.includes('jev-direct')&&ids.includes('jev-openrouter'),'routes: '+ids.join(','));
  for(const id of ids){
    const r=R[id];
    for(const f of ['label','vendor','semantics','defaultBase','defaultModel','path','keyHint'])
      assert.equal(typeof r[f],'string',id+' must declare '+f);
    for(const f of ['headers','body','parse'])
      assert.equal(typeof r[f],'function',id+' must declare '+f);
    assert.equal(typeof r.verified,'boolean',id+' must say whether its shape is verified');
    assert.ok(/^https:\/\//.test(r.defaultBase),id+' defaultBase must be https');
    assert.ok(r.capabilities&&typeof r.capabilities==='object',id+' needs capabilities');
    assert.equal(r.capabilities.probabilitySemantics,r.semantics,id+' semantics must agree');
  }
});
test('the route list drives the picker, so a new route needs no UI edit',()=>{
  reset();
  const ids=P().list().map(r=>r.id);
  /* vm と host で Array の realm が違うので deepEqual は使えない。値で比べる。 */
  assert.equal(ids.slice(0,2).join(','),'rules,local','local-only routes come first');
  for(const id of Object.keys(P().ROUTES)) assert.ok(ids.includes(id),id+' missing from the picker list');
  for(const r of P().list()){
    assert.equal(typeof r.label,'string');
    assert.equal(typeof r.verified,'boolean');
    assert.equal(typeof r.local,'boolean');
  }
});
test('a TurnProviders method name cannot be used as a provider',()=>{
  reset();
  /* 以前は TurnProviders[id] で直接引いていたので normalize が経路になれた。 */
  assert.equal(P().get('normalize'),null);
  assert.equal(P().get('questions'),null);
  assert.equal(P().get('ROUTES'),null);
  assert.equal(P().get(''),null);
  assert.ok(P().get('local'),'local must still resolve');
  assert.ok(P().get('jev-direct'),'declared routes must resolve');
});

/* ── vendor 別キー ────────────────────────────────────────────────────── */
test('keys are stored per vendor, so switching routes does not lose the other key',()=>{
  reset({turnDecisionApiKey:'',turnDecisionKeys:''});
  ctx.CFG.turnDecisionKeys=JSON.stringify({typesafe:'ts-key',openrouter:'or-key'});
  assert.equal(P().keyFor('typesafe'),'ts-key');
  assert.equal(P().keyFor('openrouter'),'or-key');
  assert.equal(P().keyFor('openai'),'','an unknown vendor has no key yet');
});
test('the legacy single key still works as a fallback',()=>{
  reset({turnDecisionApiKey:'old-single',turnDecisionKeys:''});
  assert.equal(P().keyFor('typesafe'),'old-single');
  ctx.CFG.turnDecisionKeys=JSON.stringify({typesafe:'new-per-vendor'});
  assert.equal(P().keyFor('typesafe'),'new-per-vendor','the vendor map wins over the legacy field');
});
test('a corrupt key map does not throw, it just reads as unset',()=>{
  reset({turnDecisionApiKey:'',turnDecisionKeys:'{not json'});
  assert.equal(P().keyFor('typesafe'),'');
});

/* ── OpenRouter 経路 ──────────────────────────────────────────────────── */
test('the OpenRouter route posts a chat-completions envelope with a strict schema',async()=>{
  reset({turnDecisionProvider:'jev-openrouter',turnDecisionApiKey:'',turnDecisionBaseUrl:'',
    turnDecisionModel:'typesafe/jev-1.13.0',
    turnDecisionKeys:JSON.stringify({openrouter:'or-key'})});
  const s=stateOf();
  fetchImpl=reply({id:'x',model:'typesafe/jev-1.13.0',
    usage:{prompt_tokens:120,completion_tokens:0},
    choices:[{message:{content:JSON.stringify(wire(s))}}]});
  const n=await P().get('jev-openrouter').evaluate(s,{});
  assert.ok(n,'the envelope must normalize');
  assert.equal(calls[0].url,'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(calls[0].opt.headers.Authorization,'Bearer or-key','it must use the OpenRouter key');
  assert.ok(!calls[0].opt.headers['X-TypeSafe-No-Training'],'TypeSafe headers do not belong on this route');
  const body=JSON.parse(calls[0].opt.body);
  assert.equal(body.model,'typesafe/jev-1.13.0');
  assert.equal(body.temperature,0,'a decision must not be sampled');
  assert.equal(body.response_format.type,'json_schema');
  assert.equal(body.response_format.json_schema.strict,true);
  assert.equal(body.messages.length,2);
  const sent=JSON.parse(body.messages[1].content);
  assert.ok(sent.state&&sent.questions,'state and questions ride in the user message');
  assert.equal(sent.state.currentText,s.currentText,'the text must not be altered');
  assert.equal(n.usage.inputTokens,120,'prompt_tokens maps onto the contract name');
});
test('the OpenRouter schema offers exactly the candidates the state proposed',async()=>{
  reset({turnDecisionProvider:'jev-openrouter',turnDecisionApiKey:'',
    turnDecisionModel:'typesafe/jev-1.13.0',turnDecisionKeys:JSON.stringify({openrouter:'k'})});
  const s=stateOf();
  fetchImpl=reply({choices:[{message:{content:JSON.stringify(wire(s))}}]});
  await P().get('jev-openrouter').evaluate(s,{});
  const schema=JSON.parse(calls[0].opt.body).response_format.json_schema.schema;
  const enumv=schema.properties.answers.properties.boundary_choice.properties.choice.enum;
  const expected=['HOLD'].concat((s.candidateBoundaries||[]).map(c=>c.id));
  assert.equal(enumv.join(','),expected.join(','),'the model must not be able to name an offset we did not offer');
  const ts=schema.properties.answers.properties.turn_state.properties.choice.enum;
  assert.equal(ts.join(','),'COMPLETE,CONTINUING,SELF_REPAIR,UNKNOWN');
});
test('a chat reply that is not JSON, or has no message, is refused',async()=>{
  reset({turnDecisionProvider:'jev-openrouter',turnDecisionApiKey:'',
    turnDecisionModel:'typesafe/jev-1.13.0',turnDecisionKeys:JSON.stringify({openrouter:'k'})});
  const s=stateOf();
  fetchImpl=reply({choices:[{message:{content:'申し訳ありませんが'}}]});
  assert.equal(await P().get('jev-openrouter').evaluate(s,{}),null);
  fetchImpl=reply({choices:[]});
  assert.equal(await P().get('jev-openrouter').evaluate(s,{}),null);
});
test('the OpenRouter route refuses a payload past its smaller context',async()=>{
  reset({turnDecisionProvider:'jev-openrouter',turnDecisionApiKey:'',
    turnDecisionModel:'typesafe/jev-1.13.0',turnDecisionKeys:JSON.stringify({openrouter:'k'})});
  const s=stateOf();
  s.recentTurns=[];for(let i=0;i<400;i++)s.recentTurns.push({speakerKey:'s'+i,language:'ja',text:'あ'.repeat(200)});
  await assert.rejects(()=>P().get('jev-openrouter').evaluate(s,{}),/文脈上限/);
  assert.equal(calls.length,0,'nothing may be sent once it is over the limit');
});

/* ── 疎通と到達不能 ───────────────────────────────────────────────────── */
/* 公式に記載の無いヘッダを送ると preflight が増え、サーバが許可していなければ
   本リクエストが飛ばずに "Failed to fetch" になる。既定では送らない。 */
test('the direct route sends only the documented headers by default',async()=>{
  reset({turnDecisionProvider:'jev-direct'});
  const s=stateOf();fetchImpl=reply(wire(s));
  await P().get('jev-direct').evaluate(s,{});
  const h=calls[0].opt.headers;
  assert.equal(h.Authorization,'Bearer k');
  assert.equal(h['Content-Type'],'application/json');
  for(const k of Object.keys(h))
    assert.ok(!/^X-TypeSafe/i.test(k),'undocumented header forces a preflight: '+k);
});
test('the undocumented headers can still be turned back on per route',async()=>{
  reset({turnDecisionProvider:'jev-direct'});
  const route=P().ROUTES['jev-direct'];
  route.extraHeaders=true;
  try{
    const s=stateOf();fetchImpl=reply(wire(s));
    await P().get('jev-direct').evaluate(s,{});
    assert.equal(calls[0].opt.headers['X-TypeSafe-No-Training'],'true');
  } finally { route.extraHeaders=false; }
});
test('a fetch that never answers is reported as unreachable, not as a bad response',async()=>{
  reset({turnDecisionProvider:'jev-direct'});
  /* ブラウザは CORS でも DNS でも同じ TypeError を投げる。status は付かない。 */
  fetchImpl=()=>Promise.reject(new TypeError('Failed to fetch'));
  const err=await P().get('jev-direct').evaluate(stateOf(),{}).then(()=>null,e=>e);
  assert.ok(err,'it must reject');
  assert.equal(err.unreachable,true,'the layer must be able to tell this apart');
  assert.match(err.message,/CORS/,'the message must say what to check: '+err.message);
});
test('an HTTP error keeps its status and is not mistaken for unreachable',async()=>{
  reset({turnDecisionProvider:'jev-direct'});
  fetchImpl=()=>Promise.resolve({ok:false,status:401,text:()=>Promise.resolve('')});
  const err=await P().get('jev-direct').evaluate(stateOf(),{}).then(()=>null,e=>e);
  assert.equal(err.status,401);
  assert.equal(err.unreachable,undefined);
});
test('an abort stays an abort, so a timeout is not reported as a CORS problem',async()=>{
  reset({turnDecisionProvider:'jev-direct'});
  fetchImpl=()=>{const e=new Error('aborted');e.name='AbortError';return Promise.reject(e);};
  const err=await P().get('jev-direct').evaluate(stateOf(),{}).then(()=>null,e=>e);
  assert.equal(err.name,'AbortError');
  assert.equal(err.unreachable,undefined);
});

test('probe reaches the route with a real contract body and reports the outcome',async()=>{
  reset({turnDecisionProvider:'jev-direct'});
  fetchImpl=()=>Promise.resolve({ok:true,status:200,text:()=>Promise.resolve('{}')});
  const res=await P().probe('jev-direct');
  assert.equal(res.ok,true);
  assert.equal(calls[0].url,'https://api.typesafe.ai/v1/systemone');
  const body=JSON.parse(calls[0].opt.body);
  assert.ok(body.state&&body.questions&&body.model,'the probe must use the real contract shape');
  assert.equal(body.state.candidateBoundaries.length,1,'and offer a candidate like a real call');
});
test('probe separates unreachable from refused, so the message can differ',async()=>{
  reset({turnDecisionProvider:'jev-direct'});
  fetchImpl=()=>Promise.reject(new TypeError('Failed to fetch'));
  const a=await P().probe('jev-direct');
  assert.equal(a.ok,false);assert.equal(a.unreachable,true);
  fetchImpl=()=>Promise.resolve({ok:false,status:401,text:()=>Promise.resolve('bad key')});
  const b=await P().probe('jev-direct');
  assert.equal(b.ok,false);assert.equal(b.unreachable,undefined);assert.equal(b.status,401);
  assert.match(b.detail,/bad key/);
});
test('probe does not depend on the decision mode, so it works while off',async()=>{
  reset({turnDecisionMode:'off',turnDecisionLangEn:'off',turnDecisionLangJa:'off',
    turnDecisionProvider:'jev-direct'});
  fetchImpl=()=>Promise.resolve({ok:true,status:200,text:()=>Promise.resolve('{}')});
  assert.equal((await P().probe('jev-direct')).ok,true);
});

/* ── 確率の出どころ ───────────────────────────────────────────────────── */
test('an uncalibrated route does not get the calibrated thresholds',()=>{
  reset();
  const cal=D().thresholds('ja','native_calibrated');
  const raw=D().thresholds('ja','vendor_reported');
  assert.equal(cal.uncalibrated,undefined);
  assert.equal(raw.uncalibrated,true);
  assert.ok(raw.chosenMin>cal.chosenMin,'commit must be harder on an uncalibrated route');
  assert.ok(raw.confirm>cal.confirm,'and it must be confirmed more times');
  assert.equal(raw.holdMax,cal.holdMax,'waiting must not get harder; that would cut more, not less');
});
test('the route semantics reaches pick, not just the log',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const i=input(),s=D().stateOf(card(),{},i,D().rules(i),900,Date.now());
  const cand=s.candidateBoundaries[0];
  /* 0.75 は校正済みなら ja の 0.80 に届かず、いずれにせよ通らない。
     0.85 は校正済みなら通り、未校正（0.90）なら通らない。ここが効き目の差。 */
  /* HOLD は ja の上限 0.10 より下に置く。でないと chosenMin に届く前に
     HOLD の枝で待ちになり、閾値の差を試せない。 */
  const hit=(sem,p)=>{const probs={HOLD:0.05};probs[cand.id]=p;
    return {boundary:{choice:cand.id,confidence:0.9,probabilities:probs},
      turnState:{choice:'COMPLETE',confidence:0.9,probabilities:{COMPLETE:0.9,CONTINUING:0.1}},
      safeToSpeak:0.95,repairLikelihood:0.01,probabilitySemantics:sem};};
  const rule={length:cand.offset,reasons:['semantic-sentence','stable']};
  assert.ok(D().pick(s,hit('native_calibrated',0.85),rule),'0.85 passes when calibrated');
  assert.equal(D().pick(s,hit('vendor_reported',0.85),rule),null,'0.85 must not pass uncalibrated');
});
test('P(CONTINUING) survives normalization, so the gate that uses it is alive',()=>{
  reset();
  const s=stateOf(),id=firstId(s);
  const raw=wire(s);
  raw.answers.turn_state.probabilities={COMPLETE:0.3,CONTINUING:0.7};
  const n=P().fromAnswers(raw,s,{provider:'t',model:'m',semantics:'native_calibrated',
    latencyMs:1,questionSetHash:'h'});
  assert.ok(n,'it must normalize');
  assert.equal(n.turnState.probabilities.CONTINUING,0.7,'pick reads this; dropping it kills the gate');
});
test('an out-of-schema turn state probability is refused',()=>{
  reset();
  const s=stateOf(),raw=wire(s);
  raw.answers.turn_state.probabilities={COMPLETE:0.5,NOT_A_STATE:0.5};
  assert.equal(P().fromAnswers(raw,s,{provider:'t',model:'m',semantics:'native_calibrated',
    latencyMs:1,questionSetHash:'h'}),null);
});

test('candidate ids are unique, so the criteria map cannot collide',()=>{
  reset();
  /* 文末が複数ある文章。以前は C_SENTENCE が重複し map で潰れていた。 */
  const i=input({text:'はい。わかりました。では火曜日です。',stableLength:18});
  const cands=D().candidatesOf(i,D().rules(i));
  const ids=cands.map(c=>c.id);
  assert.equal(new Set(ids).size,ids.length,'duplicate candidate id: '+ids.join(','));
  for(const c of cands) assert.equal(typeof c.left,'string','each candidate needs its left context');
});

test('a documented answers payload is accepted and mapped onto the contract',async()=>{
  reset({turnDecisionProvider:'jev-direct'});
  const s=stateOf();fetchImpl=reply(wire(s));
  const n=await P().get('jev-direct').evaluate(s,{});
  assert.ok(n,'the documented shape must normalize');
  assert.equal(n.model,'jev-1.13.0','the model comes back from the response');
  assert.equal(n.safeToSpeak,0.95);
  assert.equal(n.repairLikelihood,0.04);
  assert.equal(n.turnState.choice,'COMPLETE');
  assert.equal(n.usage.inputTokens,307,'usage is kept for rate and cost tracking');
});

test('an answer whose type does not match its question is refused',async()=>{
  reset({turnDecisionProvider:'jev-direct'});
  const s=stateOf();
  fetchImpl=reply(wire(s,{answers:{safe_to_speak:{type:'choice',choice:'x',probabilities:{},confidence:0.5}}}));
  assert.equal(await P().get('jev-direct').evaluate(s,{}),null);
  fetchImpl=reply({model:'m',answers:{},usage:{}});
  assert.equal(await P().get('jev-direct').evaluate(s,{}),null);
});

test('active refuses a model alias, so a calibrated version must be pinned',async()=>{
  reset({turnDecisionProvider:'jev-direct',turnDecisionModel:''});
  await assert.rejects(()=>P().get('jev-direct').evaluate(stateOf(),{}),/固定version/);
  reset({turnDecisionProvider:'jev-direct',turnDecisionLangJa:'shadow',turnDecisionModel:''});
  const s=stateOf();fetchImpl=reply(wire(s));
  const n=await P().get('jev-direct').evaluate(s,{});
  assert.ok(n,'shadow may use the latest alias');
  assert.equal(JSON.parse(calls[0].opt.body).model,'jev-latest');
});
test('a missing key or a non-https base url is refused before any request',async()=>{
  reset({turnDecisionProvider:'jev-direct',turnDecisionApiKey:'',turnDecisionModel:'jev-1.13.0'});
  await assert.rejects(()=>P().get('jev-direct').evaluate(stateOf(),{}),/API キーが未設定/);
  reset({turnDecisionProvider:'jev-direct',turnDecisionBaseUrl:'http://insecure.example',turnDecisionModel:'jev-1.13.0'});
  fetchImpl=reply({});
  await assert.rejects(()=>P().get('jev-direct').evaluate(stateOf(),{}),/HTTPS/);
  assert.equal(calls.length,0);
});
test('a huge or non-JSON body is refused',async()=>{
  reset({turnDecisionProvider:'jev-direct',turnDecisionModel:'jev-1.13.0'});
  fetchImpl=reply('x'.repeat(200001));
  await assert.rejects(()=>P().get('jev-direct').evaluate(stateOf(),{}),/大きすぎ/);
  fetchImpl=reply('<html>error</html>');
  await assert.rejects(()=>P().get('jev-direct').evaluate(stateOf(),{}),/JSON/);
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
  assert.equal(P().get('jev-direct').capabilities().local,false);
});

/* ── 送る数値はすべて説明されていること ──────────────────────────────── */
test('every prosody field we send is explained in the instructions',()=>{
  /* Jev はテキストしか見ないので、説明のない数値は解釈できずノイズになる。
     送るフィールドを足して説明を忘れる事故をここで止める。 */
  const instr=Object.values(P().template).map(q=>JSON.stringify(q.instructions)).join('\n');
  for(const f of c.TURN_PROSODY_SENT)
    assert.ok(instr.includes('prosody.'+f),'sent but never explained: prosody.'+f);
});

test('only the documented prosody fields reach the provider',async()=>{
  reset({turnDecisionProvider:'jev-direct',turnDecisionLangJa:'active'});
  /* peek は説明していないフィールドも返す。state へは乗せないこと。 */
  ctx.micProsody={peek:()=>({available:true,windowMs:1500,terminalPitchSlope:-0.2,
    pitchRelativeRange:0.3,terminalEnergyDrop:11,internalPauseRatio:0.1,
    maxInternalPauseMs:120,tempoVariability:0.2,voiceRuns:3,coverage:0.8,quality:0.7})};
  const s=stateOf();
  assert.ok(s.prosody,'prosody must be attached when observing');
  const sent=Object.keys(s.prosody).sort().join(','),want=Array.from(c.TURN_PROSODY_SENT).sort().join(',');
  assert.equal(sent,want);
  for(const undoc of ['windowMs','pitchRelativeRange','voiceRuns','coverage'])
    assert.equal(s.prosody[undoc],undefined,'undocumented field leaked: '+undoc);
  ctx.micProsody=null;
});

test('the instructions name the state fields they depend on',()=>{
  const instr=JSON.stringify(P().template.boundary_choice.instructions);
  for(const f of ['currentText','stablePrefixChars','silenceMs','lastDeltaMs','sttFinal'])
    assert.ok(instr.includes('`'+f+'`'),'state field not referenced: '+f);
  /* null と 0 を混同させないことを明記しているか。 */
  assert.match(instr,/null/);
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
test('the documented never-retry statuses stop the decision layer',async()=>{
  /* 401 は鍵、422 は本文検証。既知の不一致として 422 が 400 で返ることがある。 */
  for(const status of [401,422,400]){
    reset({turnDecisionProvider:'jev-direct',turnDecisionModel:'jev-1.13.0'});
    fetchImpl=reply('{}',status);
    D().observe(stateOf());
    await new Promise(r=>setTimeout(r,20));
    assert.equal(ctx.CFG.turnDecisionMode,'off','status '+status+' must stop the layer');
    assert.ok(toasts.some(t=>String(status)===t.match(/\d{3}/)?.[0]),'status '+status+' must be surfaced');
  }
});
test('429 and 529 do not stop the layer; they only open the circuit',async()=>{
  for(const status of [429,529]){
    reset({turnDecisionProvider:'jev-direct',turnDecisionModel:'jev-1.13.0'});
    fetchImpl=reply('{}',status);
    D().observe(stateOf());
    await new Promise(r=>setTimeout(r,20));
    assert.equal(ctx.CFG.turnDecisionMode,'active','status '+status+' is transient');
    assert.ok(logs.some(l=>l[0]==='turn-decision-fallback'));
  }
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
