/* Phase 1 の受入試験。判断層の Policy を provider 結果をモックして決定論的に検査する。
   狙いは一点に絞られる: turnDecisionMode=off のとき boundary/floor が v1.47.1 と
   同一の値を返し、判断層のための計算も一切走らないこと（INV-08 / §15 OFF互換）。
   モデルの挙動テストはここに置かない。別スイートで夜間に回す。 */
const path=require('node:path'),fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');

const src=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');

/* 必要な最上位ブロックだけを取り出す。app.js 全体は DOM に触るため読み込めない。
   関数とオブジェクトは列0の } / }; で閉じる規約なので、それを終端に使う。 */
function block(startsWith){
  const lines=src.split('\n');
  const i=lines.findIndex(l=>l.startsWith(startsWith));
  assert.ok(i>=0,'block not found: '+startsWith);
  for(let j=i+1;j<lines.length;j++) if(lines[j]==='}'||lines[j]==='};') return lines.slice(i,j+1).join('\n');
  throw new Error('unterminated block: '+startsWith);
}
/* SEG は行末で閉じるので終端を明示する。 */
function segBlock(){
  const m=src.match(/var SEG = \{[\s\S]*?correctedBySource:\{provider:0,rules:0\}\};/);
  assert.ok(m,'SEG block not found');
  return m[0];
}

const peeked={count:0};
const ctx={
  console,Math,Date,JSON,Object,Array,String,Number,isFinite,RegExp,
  APP_BUILD:'test-build', sessionGen:1,
  /* peek だけを検査するので、コンストラクタは prototype の置き場として空で足りる。 */
  ProsodyAnalyzer:function(){},
  CFG:{}, S:{entries:[]}, DuoSpeakers:{available:false},
  dlog:()=>{},
  segDebt:()=>0,
  hasSpeechContent:t=>/[\p{L}\p{N}]/u.test(String(t||'')),
  /* peek が呼ばれたかを数える。off のとき 0 でなければ計算が漏れている。 */
  micProsody:{peek(ms){peeked.count++;return {available:true,terminalPitchSlope:-0.1,quality:0.8};}}
};
const c=vm.createContext(ctx);
for(const b of [segBlock(),
                block('function segEnabled()'),
                block('function segDecision(input){'),
                block('function segSemanticEnabled()'),
                block('function segSemanticTail(text,lang){'),
                block('function segSemanticDecision(input){'),
                block('function prosodyRound('),
                block('function prosodyClamp('),
                block('function prosodyMean('),
                block('function prosodyPercentile('),
                block('function prosodyMedian('),
                block('function prosodyStd('),
                block('ProsodyAnalyzer.prototype.peek=function(windowMs){'),
                block('var TURN_STATE_SCHEMA='),
                block('var TurnDecision={'),
                block('var TurnTrace={')]) vm.runInContext(b,c);

const tests=[];
const test=(n,f)=>{f();tests.push(n);};
const D=()=>c.TurnDecision, T=()=>c.TurnTrace;

function reset(over){
  ctx.CFG=Object.assign({segmentMode:'balanced',segmentBoundary:'semantic',sttProvider:'openai',
    segmentOverlap:'auto',vad:12,turnDecisionMode:'off',turnDecisionProvider:'rules',
    turnDecisionLangEn:'shadow',turnDecisionLangJa:'shadow',turnDecisionContextTurns:0,
    turnFloorMaxWaitMs:3000,turnFloorExpiry:'speak',turnTraceMode:'off',
    turnDecisionProsody:true},over||{});
  peeked.count=0; D().cache={}; D().inflight={}; D().sessionSalt=null; T().reset();
}
const card=(over)=>Object.assign({id:'e1',utteranceId:'u1',seat:'A',srcLang:'ja',dstLang:'en',
  segment:{revision:3,final:false},segments:[]},over||{});
const input=(over)=>Object.assign({text:'来週の予定は火曜日です。',stableLength:12,lang:'ja',
  idleMs:200,mode:'balanced',debt:0,silenceMs:-1,final:false,
  policy:{min:12,max:48,stability:400,silence:700,mode:'balanced'}},over||{});

/* ── OFF 互換。ここが落ちたら Phase 1 は出荷できない ────────────────────── */
test('off returns the RulesProvider result itself, not a copy',()=>{
  reset();
  const i=input(),rule=D().rules(i);
  assert.equal(D().boundary(card(),{},i,rule,null,Date.now()),rule);
});
test('off keeps identity for every language, even with en/ja set to active',()=>{
  reset({turnDecisionLangEn:'active',turnDecisionLangJa:'active'});
  for(const lang of ['ja','en','de','it','zh','mixed','']){
    const i=input({lang}),rule=D().rules(i);
    assert.equal(D().boundary(card({srcLang:lang}),{},i,rule,250,Date.now()),rule,lang);
  }
});
test('off never calls the prosody peek',()=>{
  reset({turnDecisionLangJa:'active'});
  const i=input();
  D().boundary(card(),{},i,D().rules(i),250,Date.now());
  assert.equal(peeked.count,0);
  assert.equal(D().prosodyOf('ja'),null);
});
test('prosody is peeked when observing, so the text-only model gets the acoustics',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const i=input();
  D().boundary(card(),{},i,D().rules(i),250,Date.now());
  assert.ok(peeked.count>0,'an observing decision must supply prosody');
});
test('prosody stays off when turnDecisionProsody is disabled',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active',turnDecisionProsody:false});
  assert.equal(D().prosodyOf('ja'),null);
  assert.equal(peeked.count,0);
});
test('off leaves the floor with no opinion and no timer',()=>{
  reset({turnDecisionLangJa:'active'});
  const job={card:card(),segment:{id:'s1'}};
  assert.equal(D().floor(job,250,Date.now()),null);
  assert.equal(job.floorSince,0);
});
test('off records no trace rows',()=>{
  reset({turnDecisionLangJa:'active'});
  const i=input();
  D().boundary(card(),{},i,D().rules(i),250,Date.now());
  T().voice('A',0.5); T().text(card(),'あいうえお',false);
  assert.equal(T().rows.length,0);
});

/* ── INV-08 判断の不在はゼロコスト ──────────────────────────────────────── */
test('INV-08 active with an empty cache still returns the rule result unchanged',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const i=input(),rule=D().rules(i);
  assert.equal(D().boundary(card(),{},i,rule,250,Date.now()),rule);
});
test('shadow observes but never changes the outcome',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'shadow',turnTraceMode:'record'});
  const i=input(),rule=D().rules(i);
  assert.equal(D().boundary(card(),{},i,rule,250,Date.now()),rule);
  assert.ok(T().rows.some(r=>r.kind==='decision'));   /* 記録はする */
});

/* ── 言語別 mode ────────────────────────────────────────────────────────── */
test('language routing: only en and ja can leave rules; others stay off',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangEn:'active',turnDecisionLangJa:'assist'});
  assert.equal(D().modeFor('en-US'),'active');
  assert.equal(D().modeFor('ja'),'assist');
  for(const l of ['de','it','zh','mixed','']) assert.equal(D().modeFor(l),'off',l);
});
test('global off overrides every per-language setting',()=>{
  reset({turnDecisionMode:'off',turnDecisionLangEn:'active',turnDecisionLangJa:'active'});
  assert.equal(D().modeFor('en'),'off'); assert.equal(D().modeFor('ja'),'off');
});

/* ── 契約: silenceMs の null 表現 ───────────────────────────────────────── */
test('meter unknown reaches the contract as null, never as 0 or -1',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const i=input(),s=D().stateOf(card(),{},i,D().rules(i),null,Date.now());
  assert.equal(s.silenceMs,null);
  assert.equal(s.evidence.meterAvailable,false);
  assert.equal(i.silenceMs,-1);            /* Rules 側の内部規約は保つ */
});
test('a real silence of 0 ms is distinguishable from unknown',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const s=D().stateOf(card(),{},input(),{length:0,reasons:[]},0,Date.now());
  assert.equal(s.silenceMs,0);
  assert.equal(s.evidence.meterAvailable,true);
});

/* ── 境界候補の安全性 ───────────────────────────────────────────────────── */
test('candidates never point past the stable prefix',()=>{
  reset();
  for(const st of [0,3,7,12]){
    const i=input({stableLength:st});
    for(const cand of D().candidatesOf(i,D().rules(i)))
      if(cand.id!=='C_FULL') assert.ok(cand.offset<=st,cand.id+'@'+cand.offset+' > '+st);
  }
});
test('pick refuses a choice that is not among the candidates',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const i=input(),s=D().stateOf(card(),{},i,D().rules(i),250,Date.now());
  assert.equal(D().pick(s,{boundary:{choice:'C_NOT_OFFERED',confidence:0.99}}),null);
});
test('pick refuses an offset beyond the stable prefix',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const i=input({stableLength:4}),s=D().stateOf(card(),{},i,D().rules(i),250,Date.now());
  s.candidateBoundaries.push({id:'C_EVIL',offset:999,why:'injected'});
  assert.equal(D().pick(s,{boundary:{choice:'C_EVIL',confidence:0.99}}),null);
});
test('HOLD becomes an explicit wait, not a commit',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const i=input(),s=D().stateOf(card(),{},i,D().rules(i),250,Date.now());
  const d=D().pick(s,{boundary:{choice:'HOLD',confidence:0.9}});
  assert.equal(d.length,0); assert.equal(d.waiting,'provider-hold'); assert.equal(d.source,'provider');
});
test('a valid choice commits exactly at the candidate offset and is tagged provider',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const i=input(),s=D().stateOf(card(),{},i,D().rules(i),250,Date.now());
  const cand=s.candidateBoundaries.find(x=>x.id==='C_STABLE');
  const d=D().pick(s,{boundary:{choice:'C_STABLE',confidence:0.9}});
  assert.equal(d.length,cand.offset); assert.equal(d.source,'provider');
});

/* ── プライバシー ───────────────────────────────────────────────────────── */
test('speakerKey falls back to the seat and never carries a raw id',()=>{
  reset();
  assert.equal(D().speakerKeyOf(card()),'seat:A');
  const k=D().speakerKeyOf(card({speaker:{id:'meeting:yamada-taro'}}));
  assert.ok(k.startsWith('spk:'));
  assert.ok(!k.includes('yamada'));
});
test('context turns default to none, so no meeting text is bundled',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const s=D().stateOf(card(),{},input(),{length:0,reasons:[]},250,Date.now());
  assert.equal(s.recentTurns.length,0);
});
test('current text is capped at 800 characters, tail first',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const long='あ'.repeat(2000);
  const s=D().stateOf(card(),{},input({text:long,stableLength:2000}),{length:0,reasons:[]},250,Date.now());
  assert.equal(s.currentText.length,800);
  assert.ok(long.endsWith(s.currentText));
});
test('raw transcript stays out of the trace unless explicitly enabled',()=>{
  reset({turnTraceMode:'record'});
  T().text(card(),'秘密の話',false);
  assert.equal(T().rows[0].data.raw,undefined);
  reset({turnTraceMode:'record',turnDecisionRawLog:true});
  T().text(card(),'秘密の話',false);
  assert.equal(T().rows[0].data.raw,'秘密の話');
});

/* ── INV-09 floor 待ちの上限 ────────────────────────────────────────────── */
test('INV-09 the floor wait is bounded and the expiry action always fires',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const now=Date.now(),job={card:card(),segment:{id:'s1'}};
  assert.equal(D().floor(job,250,now),null);
  assert.equal(job.floorSince,now);
  assert.equal(D().floor(job,250,now+2999),null);
  assert.equal(D().floor(job,250,now+3000).action,'speak');
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active',turnFloorExpiry:'drop'});
  const j2={card:card(),segment:{id:'s2'},floorSince:now};
  assert.equal(D().floor(j2,250,now+5000).action,'drop');
});

/* ── stale ─────────────────────────────────────────────────────────────── */
test('a cached answer for an older revision is dropped, not applied',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const i=input(),s=D().stateOf(card(),{},i,D().rules(i),250,Date.now());
  D().cache[D().key(s)]={sessionId:s.sessionId,utteranceId:s.utteranceId,revision:s.revision-1,
    boundary:{choice:'C_STABLE',confidence:0.99}};
  assert.equal(D().read(s),null);
});
test('reset drops the cache and the salt so a new session cannot inherit them',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  D().speakerKeyOf(card({speaker:{id:'x'}}));
  D().cache['k']={revision:1};
  D().reset('test');
  assert.equal(Object.keys(D().cache).length,0); assert.equal(D().sessionSalt,null);
});

/* ── カウンタ分離 ───────────────────────────────────────────────────────── */
test('commit and correction counters exist per decision source',()=>{
  for(const k of ['provider','rules']){
    assert.equal(c.SEG.committedBySource[k],0,'committedBySource.'+k);
    assert.equal(c.SEG.correctedBySource[k],0,'correctedBySource.'+k);
  }
});

/* ── prosody peek が非破壊であること ────────────────────────────────────── */
test('peek reads the tail without consuming the frame buffer',()=>{
  const now=Date.now(),frames=[];
  for(let i=0;i<40;i++) frames.push({t:now-1200+i*30,rms:0.05,db:-40+(i>30?-12:0),pitch:180-(i>30?40:0),voice:true,threshold:0.012});
  const an={closed:false,frames,source:'openai'};
  const before=frames.length;
  const r=c.ProsodyAnalyzer.prototype.peek.call(an,1500);
  assert.equal(an.frames.length,before,'peek must not reset frames');
  assert.equal(r.available,true);
  assert.ok(r.terminalPitchSlope<0,'a falling tail must read as a negative slope');
  assert.ok(r.terminalEnergyDrop>0,'a decaying tail must read as a positive drop');
});
test('peek reports unavailable instead of guessing on a short window',()=>{
  const an={closed:false,frames:[{t:Date.now(),rms:0.05,db:-40,pitch:180,voice:true}]};
  assert.equal(c.ProsodyAnalyzer.prototype.peek.call(an,1500).available,false);
});

console.log(JSON.stringify({passed:tests.length,tests},null,2));
