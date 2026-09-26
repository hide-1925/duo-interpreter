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

const peeked={count:0},dlogs=[];
const ctx={
  console,Math,Date,JSON,Object,Array,String,Number,isFinite,RegExp,
  APP_BUILD:'test-build', sessionGen:1,
  /* peek だけを検査するので、コンストラクタは prototype の置き場として空で足りる。 */
  ProsodyAnalyzer:function(){},
  CFG:{}, S:{entries:[]}, DuoSpeakers:{available:false},
  /* 解析器の解決は engines を見る。gate では常に空にして共有マイクへ落とす。 */
  engines:[],
  /* commit-retouch を検査したいので記録する。 */
  dlog:(...a)=>dlogs.push(a),
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
                block('function prosodyAnalyzerFor(seat){'),
                block('function prosodyRound('),
                block('function prosodyClamp('),
                block('function prosodyMean('),
                block('function prosodyPercentile('),
                block('function prosodyMedian('),
                block('function prosodyStd('),
                block('ProsodyAnalyzer.prototype.peek=function(windowMs){'),
                block('var TURN_STATE_SCHEMA='),
                block('function segCorrectionCounts(e){'),
                block('function segReviseCommittedSource(e,s,replacement,revision){'),
                block('var TurnDecision={'),
                block('var TurnTrace={')]) vm.runInContext(b,c);

/* 1行で書かれた定数は block() では終端が取れないので、行ごと入れる。 */
function constLine(name){
  const m=new RegExp('^var '+name+'=[^\\n]*$','m').exec(src);
  assert.ok(m,'constant not found: '+name);
  return m[0];
}
for(const name of ['TURN_FLOOR_HINT_MS','TURN_FLOOR_SAFE_MAX']) vm.runInContext(constLine(name),c);

const tests=[];
const test=(n,f)=>{f();tests.push(n);};
const D=()=>c.TurnDecision, T=()=>c.TurnTrace;

function reset(over){
  ctx.CFG=Object.assign({segmentMode:'balanced',segmentBoundary:'semantic',sttProvider:'openai',
    segmentOverlap:'auto',vad:12,turnDecisionMode:'off',turnDecisionProvider:'rules',
    turnDecisionLangEn:'shadow',turnDecisionLangJa:'shadow',turnDecisionContextTurns:0,
    turnFloorMaxWaitMs:3000,turnFloorExpiry:'speak',turnFloorSafeToSpeak:true,turnTraceMode:'off',
    turnDecisionCommitWaitMs:300,turnDecisionHoldMaxWaitMs:2000,
    turnDecisionMaxAsksPerRevision:3,turnDecisionProsody:true},over||{});
  peeked.count=0; D().cache={}; D().inflight={}; D().sessionSalt=null;
  D()._confirm={}; D()._lastSend={}; D()._asks={}; D()._recent={}; D().circuit={}; T().reset();
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
      if(cand.kind!=='C_FULL') assert.ok(cand.offset<=st,cand.id+'@'+cand.offset+' > '+st);
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
  const d=D().pick(s,{boundary:{choice:'HOLD',confidence:0.9,probabilities:{HOLD:0.9}}});
  assert.equal(d.length,0); assert.equal(d.waiting,'provider-hold'); assert.equal(d.source,'provider');
});
test('a valid choice commits exactly at the candidate offset and is tagged provider',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  /* 日本語の音響guardは450msなので、それを満たす無音を渡す。 */
  const i=input(),s=D().stateOf(card(),{},i,D().rules(i),900,Date.now());
  /* 同一 offset の候補は重複排除されるので、先頭の候補を使う。 */
  const cand=s.candidateBoundaries[0],probs={HOLD:0.02};probs[cand.id]=0.98;
  /* rule も同じ位置を選んでいるので、2回確認は要らない。 */
  const d=D().pick(s,{boundary:{choice:cand.id,confidence:0.9,probabilities:probs},
    turnState:{choice:'COMPLETE',confidence:0.9},safeToSpeak:0.95,repairLikelihood:0.01},
    {length:cand.offset,reasons:['semantic-sentence','stable']});
  assert.equal(d.length,cand.offset); assert.equal(d.source,'provider');
});

/* ── 閾値は confidence ではなく probabilities に置く ────────────────────── */
/* 公式の confidence は選択肢数 N に依存する統計量で、式は
   (N × p_max − 1) / (N − 1)。/primitives/choice の実例（4択で p_max=0.40 →
   confidence 0.20）が式と小数点以下まで一致するので、近似ではなく定義である。
   boundary_choice の N は HOLD＋候補で毎回変わる（候補の上限を外したのでなお
   さら変わる）ため、固定の confidence 下限は「Duo が何件候補を作ったか」で合否
   が変わる。turn_state は4択固定なので confidence を使ってよい。 */
const docConfidence=(probs)=>{
  const vals=Object.values(probs),n=vals.length,peak=Math.max(...vals);
  return Math.max(0,Math.min(1,(n*peak-1)/(n-1)));
};

test('the documented confidence statistic moves with the option count, not just certainty',()=>{
  /* 同じ p_max でも候補数が違えば confidence が違う。これが固定下限を使えない理由。 */
  const two=docConfidence({HOLD:0.3,A:0.7});
  const six=docConfidence({HOLD:0.3,A:0.7,B:0,C:0,D:0,E:0});
  assert.ok(six>two+0.15,'N=6 ('+six.toFixed(2)+') must read far higher than N=2 ('+two.toFixed(2)+')');
  /* 0.60 の下限だと、確信は同じでも候補数で合否が割れる。 */
  assert.ok(two<0.60&&six>0.60,'a fixed 0.60 floor would split the same certainty');
});

test('the boundary gate ignores confidence and reads the probabilities',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangEn:'active'});
  const i=input({lang:'en',stableLength:12}),s=D().stateOf(card({srcLang:'en'}),{},i,D().rules(i),900,Date.now());
  const id=s.candidateBoundaries[0].id;
  /* confidence を 0 にしても、確率が閾値を満たしていれば commit する。 */
  const probs={HOLD:0.05};probs[id]=0.95;
  const d=D().pick(s,{boundary:{choice:id,confidence:0,probabilities:probs},
    turnState:{choice:'COMPLETE',confidence:0.9},safeToSpeak:0.9,repairLikelihood:0.02},null);
  assert.ok(d,'a low confidence with a concentrated probability must still commit');
  assert.equal(d.length,s.candidateBoundaries[0].offset);
  /* 逆に confidence が高くても、選ばれた候補の確率が低ければ Rules へ落とす。 */
  const weak={HOLD:0.05};weak[id]=0.40;
  assert.equal(D().pick(s,{boundary:{choice:id,confidence:0.99,probabilities:weak},
    turnState:{choice:'COMPLETE',confidence:0.9},safeToSpeak:0.9,repairLikelihood:0.02},null),null);
});

test('a strong HOLD probability waits even when another option was chosen',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangEn:'active'});
  const i=input({lang:'en',stableLength:12}),s=D().stateOf(card({srcLang:'en'}),{},i,D().rules(i),900,Date.now());
  const id=s.candidateBoundaries[0].id,probs={HOLD:0.45};probs[id]=0.55;
  const d=D().pick(s,{boundary:{choice:id,confidence:0.5,probabilities:probs},
    turnState:{choice:'COMPLETE',confidence:0.9},safeToSpeak:0.9,repairLikelihood:0.02},null);
  assert.equal(d.length,0); assert.equal(d.waiting,'provider-hold');
});

test('CONTINUING and SELF_REPAIR hold; UNKNOWN falls back to rules',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangEn:'active'});
  const i=input({lang:'en',stableLength:12}),s=D().stateOf(card({srcLang:'en'}),{},i,D().rules(i),900,Date.now());
  const id=s.candidateBoundaries[0].id,probs={HOLD:0.05};probs[id]=0.95;
  const base={boundary:{choice:id,confidence:0.9,probabilities:probs},safeToSpeak:0.9,repairLikelihood:0.02};
  for(const st of ['CONTINUING','SELF_REPAIR']){
    const d=D().pick(s,Object.assign({},base,{turnState:{choice:st,confidence:0.9}}),null);
    assert.equal(d.length,0,st); assert.match(d.waiting,/provider-/);
  }
  assert.equal(D().pick(s,Object.assign({},base,{turnState:{choice:'UNKNOWN',confidence:0.9}}),null),null);
});

test('a low turn_state confidence falls back, since that option count is fixed',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangEn:'active'});
  const i=input({lang:'en',stableLength:12}),s=D().stateOf(card({srcLang:'en'}),{},i,D().rules(i),900,Date.now());
  const id=s.candidateBoundaries[0].id,probs={HOLD:0.05};probs[id]=0.95;
  assert.equal(D().pick(s,{boundary:{choice:id,confidence:0.9,probabilities:probs},
    turnState:{choice:'COMPLETE',confidence:0.3},safeToSpeak:0.9,repairLikelihood:0.02},null),null);
});

test('a likely self-repair waits, because a wrong spoken translation cannot be undone',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangEn:'active'});
  const i=input({lang:'en',stableLength:12}),s=D().stateOf(card({srcLang:'en'}),{},i,D().rules(i),900,Date.now());
  const id=s.candidateBoundaries[0].id,probs={HOLD:0.05};probs[id]=0.95;
  const d=D().pick(s,{boundary:{choice:id,confidence:0.9,probabilities:probs},
    turnState:{choice:'COMPLETE',confidence:0.9},safeToSpeak:0.9,repairLikelihood:0.9},null);
  assert.equal(d.waiting,'provider-repair');
});

test('the acoustic guard is per language and an unknown meter waits for final',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangEn:'active',turnDecisionLangJa:'active'});
  const mk=(lang,silence,final)=>{
    const i=input({lang,stableLength:12,final});
    return D().stateOf(card({srcLang:lang}),{},i,D().rules(i),silence,Date.now());
  };
  const answer=(s)=>{const id=s.candidateBoundaries[0].id,p={HOLD:0.03};p[id]=0.97;
    return {boundary:{choice:id,confidence:0.9,probabilities:p},
      turnState:{choice:'COMPLETE',confidence:0.9},safeToSpeak:0.95,repairLikelihood:0.01};};
  /* 英語は 250ms、日本語は 450ms から。 */
  let s=mk('en',300,false); assert.ok(D().pick(s,answer(s),null),'en at 300ms should pass');
  s=mk('ja',300,false); assert.equal(D().pick(s,answer(s),null),null,'ja at 300ms should not');
  s=mk('ja',500,false); assert.ok(D().pick(s,answer(s),null),'ja at 500ms should pass');
  /* meter 不明は final まで待つ。 */
  s=mk('en',null,false); assert.equal(D().pick(s,answer(s),null),null,'unknown meter, not final');
  s=mk('en',null,true);  assert.ok(D().pick(s,answer(s),null),'unknown meter but final');
});

test('Japanese needs two agreeing decisions when the rules disagree',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const i=input({stableLength:12}),s=D().stateOf(card(),{},i,D().rules(i),900,Date.now());
  const id=s.candidateBoundaries[0].id,probs={HOLD:0.02};probs[id]=0.98;
  const hit={boundary:{choice:id,confidence:0.9,probabilities:probs},
    turnState:{choice:'COMPLETE',confidence:0.9},safeToSpeak:0.95,repairLikelihood:0.01};
  /* rule が別の位置を出しているときは1回目は確認待ち、2回目で commit。 */
  const other={length:3,reasons:['x']};
  const first=D().pick(s,hit,other);
  assert.equal(first.waiting,'provider-confirming');
  assert.ok(D().pick(s,hit,other).length>0,'the second agreeing decision commits');
  /* rule が同じ位置なら確認は要らない。 */
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  assert.ok(D().pick(s,hit,{length:s.candidateBoundaries[0].offset,reasons:[]}).length>0);
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

/* ── 全体モードは上限 ──────────────────────────────────────────────────── */
/* 以前は言語別の設定が全体を飛び越えられた。全体を shadow にしても日本語を
   active にしていれば日本語だけ動作へ反映され、「shadow なら動作は変わらない」
   という前提が崩れる。小さいほうを採る。 */
test('a per-language mode cannot escalate past the global mode',()=>{
  reset({turnDecisionMode:'shadow',turnDecisionLangJa:'active',turnDecisionLangEn:'assist'});
  assert.equal(D().modeFor('ja'),'shadow','global shadow must cap a per-language active');
  assert.equal(D().modeFor('en'),'shadow');
  assert.equal(D().applies('ja'),false,'and it must not reach behaviour');
  assert.equal(D().observes('ja'),true,'but it still observes');
});
test('a per-language mode can still be lower than the global mode',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'shadow',turnDecisionLangEn:'off'});
  assert.equal(D().modeFor('ja'),'shadow','the smaller of the two wins');
  assert.equal(D().modeFor('en'),'off');
  assert.equal(D().applies('ja'),false);
});
test('off at the top still silences everything',()=>{
  reset({turnDecisionMode:'off',turnDecisionLangJa:'active',turnDecisionLangEn:'active'});
  assert.equal(D().modeFor('ja'),'off');
  assert.equal(D().observes('ja'),false);
});

/* ── INV-09 floor 待ちの上限 ────────────────────────────────────────────── */
/* 以前のこの検査は「保持する理由が無くても時計が回り、3秒で expiry が発火する」
   ことを正しいとして固定していた。読み上げ待ちは実測で20〜40秒に達するので、
   expiry=drop のままでは保持した覚えのない音声を理由なく捨てる。 */
test('the floor arms no timer while it has no reason to hold',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active',turnFloorExpiry:'drop'});
  const now=Date.now(),job={card:card(),segment:{id:'s1'}};
  assert.equal(D().floorHold(job,250,now),null,'Phase 3 is not implemented, so nothing holds');
  assert.equal(D().floor(job,250,now),null);
  assert.equal(job.floorSince,0,'a timer must not run while nothing is being held');
  /* 読み上げ待ちが長引いても、保持していない job が捨てられてはならない。 */
  assert.equal(D().floor(job,250,now+40000),null,'a long TTS queue is not a floor expiry');
});
test('INV-09 once the floor really holds, the wait is bounded and the expiry fires',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const now=Date.now(),job={card:card(),segment:{id:'s1'}},real=D().floorHold;
  D().floorHold=function(){return 'test-speaker-floor';};   /* Phase 3 の代役 */
  try{
    assert.equal(D().floor(job,250,now).action,'hold');
    assert.equal(job.floorSince,now);
    assert.equal(D().floor(job,250,now+2999).action,'hold');
    assert.equal(D().floor(job,250,now+3000).action,'speak');
    reset({turnDecisionMode:'active',turnDecisionLangJa:'active',turnFloorExpiry:'drop'});
    D().floorHold=function(){return 'test-speaker-floor';};
    const j2={card:card(),segment:{id:'s2'},floorSince:now};
    assert.equal(D().floor(j2,250,now+5000).action,'drop');
  } finally { D().floorHold=real; }
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

/* ── adaptive が見る訂正率 ──────────────────────────────────────────────── */
test('off scopes the correction rate to rules, which equals the totals',()=>{
  reset();
  /* offのあいだは全commitがrules由来になるので、合計値と一致しなければならない。 */
  c.SEG.committedBySource={provider:7,rules:40}; c.SEG.correctedBySource={provider:5,rules:4};
  const n=c.segCorrectionCounts(card());
  assert.equal(n.committed,40); assert.equal(n.corrected,4);
});
test('active scopes the correction rate to the provider, dropping rules-era residue',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  c.SEG.committedBySource={provider:7,rules:40}; c.SEG.correctedBySource={provider:5,rules:4};
  const n=c.segCorrectionCounts(card());
  assert.equal(n.committed,7); assert.equal(n.corrected,5);
});
test('a language left on rules keeps reading the rules counters even when global is active',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangEn:'active',turnDecisionLangJa:'shadow'});
  c.SEG.committedBySource={provider:7,rules:40}; c.SEG.correctedBySource={provider:5,rules:4};
  assert.equal(c.segCorrectionCounts(card({srcLang:'ja'})).committed,40);
  assert.equal(c.segCorrectionCounts(card({srcLang:'en'})).committed,7);
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

/* ── 音響をどの解析器から読むか ───────────────────────────────────────────
   共有マイク固定だったため、タブ音声・VB-CABLE・画面共有だけで通訳しているあいだ
   音響が常に空だった。v1.49.19 の gpt-live-transcribe 記録では Pitch=未検出 のまま
   provider が6件決めており、判断層は音響なしで答えていた。 */
const fakeAnalyzer=(over)=>Object.assign({closed:false,reads:0,tag:'',
  peek(ms){this.reads++;return {available:true,terminalPitchSlope:-0.2,quality:0.7,tag:this.tag};}},over||{});

test('the layer reads the analyzer of the seat that is speaking, not only the microphone',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const mine=fakeAnalyzer({tag:'seatA'}),other=fakeAnalyzer({tag:'seatB'});
  ctx.engines=[{seat:'B',prosody:other},{seat:'A',prosody:mine}];
  const got=D().prosodyOf(card({seat:'A'}));
  ctx.engines=[];
  assert.equal(got&&got.tag,'seatA',"the other seat's analyzer must not answer for this one");
  assert.equal(mine.reads,1);
  assert.equal(other.reads,0);
  assert.equal(peeked.count,0,'the shared microphone is the fallback, not the first choice');
});
test('a seatless engine answers when no seat matches, which is how AUTO runs',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const auto=fakeAnalyzer({tag:'auto'});
  ctx.engines=[{prosody:auto}];
  const got=D().prosodyOf(card({seat:'A'}));
  ctx.engines=[];
  assert.equal(got&&got.tag,'auto');
});
test('a dead engine and a closed analyzer are skipped, never read',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const gone=fakeAnalyzer({tag:'dead'}),shut=fakeAnalyzer({tag:'closed',closed:true});
  ctx.engines=[{seat:'A',prosody:gone,dead:true},{seat:'A',prosody:shut}];
  const got=D().prosodyOf(card({seat:'A'}));
  ctx.engines=[];
  assert.ok(got&&!got.tag,'it must fall through to the shared microphone');
  assert.equal(gone.reads,0);assert.equal(shut.reads,0);
  assert.equal(peeked.count,1);
});
test('off reads no analyzer at all, engine or microphone (INV-08)',()=>{
  reset();
  const an=fakeAnalyzer({tag:'seatA'});
  ctx.engines=[{seat:'A',prosody:an}];
  const i=input(),rule=D().rules(i);
  D().boundary(card({seat:'A'}),{},i,rule,null,Date.now());
  ctx.engines=[];
  assert.equal(an.reads,0);
  assert.equal(peeked.count,0);
});

/* 訂正率は判断層の安全性を測る基準の数字。末尾繰越の結合で末尾に空白が1つ付くだけで
   訂正として数えていたため、実測ログ（v1.49.6）では 0% から 13.3% に跳ねていた。
   ここが騒がしいと Rules と Jev の比較そのものが濁る。 */
test('a whitespace-only revision is not a correction',()=>{
  c.SEG.corrected=0;c.SEG.correctedBySource={provider:0,rules:0};
  const s={seq:1,sourceText:'この天候点というのが、高気圧の縁から偏西風に乗り換えるタイミングなんですね。',
    decisionSource:'rules',translationReady:true,translationRevision:1};
  c.segReviseCommittedSource({id:'e4'},s,s.sourceText+' ',3);
  assert.equal(c.SEG.corrected,0,'a trailing space is not a correction');
  assert.equal(c.SEG.correctedBySource.rules,0);
  assert.equal(s.correctionCount,undefined,'and does not bump the per-part count');
  assert.equal(s.sourceText,'この天候点というのが、高気圧の縁から偏西風に乗り換えるタイミングなんですね。 ',
    'but the text is still updated');
  assert.equal(s.sourceRevision,3,'and the revision advances');
  assert.equal(s.translationReady,true,'re-translating for a space is waste');
  assert.equal(s.translationRevision,1);
  assert.ok(dlogs.some(l=>l[1]==='commit-retouch'),'and it is still visible in the log');
});
test('a change to the words is still a correction',()=>{
  c.SEG.corrected=0;c.SEG.correctedBySource={provider:0,rules:0};
  const s={seq:1,sourceText:'転換点と言うんですけれども',decisionSource:'rules',
    translationReady:true,translationRevision:1};
  c.segReviseCommittedSource({id:'e2'},s,'転向点と言うんですけれども',4);
  assert.equal(c.SEG.corrected,1);
  assert.equal(c.SEG.correctedBySource.rules,1);
  assert.equal(s.correctionCount,1);
  assert.equal(s.translationReady,false,'the translation has to be redone');
});
test('whitespace inside the words is still a correction',()=>{
  c.SEG.corrected=0;c.SEG.correctedBySource={provider:0,rules:0};
  const s={seq:1,sourceText:'東京と勝浦',decisionSource:'rules',translationReady:true};
  c.segReviseCommittedSource({id:'e7'},s,'東京 と 勝浦',5);
  assert.equal(c.SEG.corrected,1,'only leading and trailing whitespace is exempt');
});
test('an identical revision is still ignored entirely',()=>{
  c.SEG.corrected=0;
  const s={seq:1,sourceText:'同じ',decisionSource:'rules',sourceRevision:1};
  c.segReviseCommittedSource({id:'e1'},s,'同じ',9);
  assert.equal(c.SEG.corrected,0);
  assert.equal(s.sourceRevision,1,'nothing is touched at all');
});
/* ── assist は「待て」だけを採る ───────────────────────────────────────
   実測（英語24件・日本語25件）で Jev が Rules より前で切れと言った回数は0だった。
   価値は待つ側に全部あるので、assist では切る位置を Rules のままにする。
   外したときの被害が「少し待つ」だけに収まり、turnFloorMaxWaitMs で頭打ちになる。 */
const enPick=(over)=>{
  const i=input({lang:'en',stableLength:12});
  const s=D().stateOf(card({srcLang:'en'}),{},i,D().rules(i),900,Date.now());
  const cand=s.candidateBoundaries[0],probs={};
  probs[cand.id]=0.95;probs.HOLD=0.05;
  const hit=Object.assign({boundary:{choice:cand.id,confidence:0.9,probabilities:probs},
    turnState:{choice:'COMPLETE',confidence:0.9,probabilities:{COMPLETE:0.9}},
    safeToSpeak:0.9,repairLikelihood:0.01},over||{});
  return {s,hit,cand};
};

test('assist leaves the cut to the rules while active adopts it',()=>{
  reset({turnDecisionMode:'assist',turnDecisionLangEn:'assist'});
  const {s,hit,cand}=enPick();
  assert.equal(D().pick(s,hit,null,true),null,'assist must not move the position');
  const d=D().pick(s,hit,null,false);
  assert.ok(d&&d.length===cand.offset,'active still adopts the position');
});
test('assist still adopts HOLD, which is the whole point of it',()=>{
  reset({turnDecisionMode:'assist',turnDecisionLangEn:'assist'});
  const {s}=enPick();
  const d=D().pick(s,{boundary:{choice:'HOLD',confidence:0.9,probabilities:{HOLD:0.9}}},null,true);
  assert.ok(d,'a HOLD must reach the caller');
  assert.equal(d.length,0);
  assert.equal(d.waiting,'provider-hold');
  assert.equal(d.source,'provider');
});
test('assist still waits on CONTINUING, SELF_REPAIR and a likely restatement',()=>{
  reset({turnDecisionMode:'assist',turnDecisionLangEn:'assist'});
  for(const st of ['CONTINUING','SELF_REPAIR']){
    const {s,hit}=enPick({turnState:{choice:st,confidence:0.9,probabilities:{}}});
    const d=D().pick(s,hit,null,true);
    assert.ok(d&&d.length===0,st+' must still hold in assist');
    assert.equal(d.waiting,'provider-'+st.toLowerCase());
  }
  const {s,hit}=enPick({repairLikelihood:0.9});
  const d=D().pick(s,hit,null,true);
  assert.ok(d&&d.length===0);
  assert.equal(d.waiting,'provider-repair');
});
test('assist never emits provider-confirming, which would delay a cut it will not take',()=>{
  /* ヒステリシスは「別の位置を採る」ためのもの。採らないなら待つ理由が無い。 */
  reset({turnDecisionMode:'assist',turnDecisionLangJa:'assist'});   /* ja は confirm 2回 */
  const i=input(),s=D().stateOf(card(),{},i,D().rules(i),900,Date.now());
  const cand=s.candidateBoundaries[0],probs={};probs[cand.id]=0.95;probs.HOLD=0.02;
  const hit={boundary:{choice:cand.id,confidence:0.9,probabilities:probs},
    turnState:{choice:'COMPLETE',confidence:0.9,probabilities:{}},
    safeToSpeak:0.9,repairLikelihood:0.01};
  assert.equal(D().pick(s,hit,null,true),null,'no waiting, no commit — the rules decide');
  const active=D().pick(s,hit,null,false);
  assert.ok(active&&active.waiting==='provider-confirming','active still confirms first');
});
test('a position assist discarded is not counted as applied',()=>{
  reset({turnDecisionMode:'assist',turnDecisionLangEn:'assist'});
  D().stats.applied=0;
  const {s,hit}=enPick();
  D().pick(s,hit,null,true);
  assert.equal(D().stats.applied,0,'the diagnostics must not claim a decision that was dropped');
  D().pick(s,hit,null,false);
  assert.equal(D().stats.applied,1);
});
test('boundary routes assist through hold-only and keeps the rules length',()=>{
  reset({turnDecisionMode:'assist',turnDecisionLangJa:'assist'});
  const e=card(),seg={},i=input(),rule=D().rules(i),now=Date.now();
  const st=D().stateOf(e,seg,i,rule,900,now),cand=st.candidateBoundaries[0];
  const probs={};probs[cand.id]=0.95;probs.HOLD=0.02;
  D().cache[D().key(st)]={sessionId:st.sessionId,utteranceId:st.utteranceId,revision:st.revision,
    boundary:{choice:cand.id,confidence:0.9,probabilities:probs},
    turnState:{choice:'COMPLETE',confidence:0.9,probabilities:{}},
    safeToSpeak:0.9,repairLikelihood:0.01,decisionId:'d1'};
  const d=D().boundary(e,seg,i,rule,900,now);
  assert.equal(d,rule,'assist must hand back the rules result itself');
});

/* ── 床：commit のときに既に払った safe_to_speak を読む ─────────────────
   新しく問い合わせない。noul は 0.5 が「判断がつかない」なので、境目はその下に置く。 */
const floorJob=(s2s,age)=>({card:card(),segment:{seq:1,
  floorHint:s2s===null?null:{safeToSpeak:s2s,at:Date.now()-(age||0)}},floorSince:0});

test('the floor holds when the model said starting now would talk over the speaker',()=>{
  reset({turnDecisionMode:'assist',turnDecisionLangJa:'assist'});
  const f=D().floor(floorJob(0.10),250,Date.now(),'avoid');
  assert.ok(f,'a clear false must reach the pump');
  assert.equal(f.action,'hold');
  assert.equal(f.reason,'safe-to-speak');
});
test('the floor stays out of it when the operator chose to allow overlap',()=>{
  /* 同時通訳は元の話者へ重ねて読むのが普通で、allow はその明示的な選択。 */
  reset({turnDecisionMode:'assist',turnDecisionLangJa:'assist'});
  assert.equal(D().floor(floorJob(0.05),250,Date.now(),'allow'),null);
  assert.ok(D().floor(floorJob(0.05),250,Date.now(),'avoid'),'but avoid is where it belongs');
});
test('an undecided answer is not treated as a reason to wait',()=>{
  reset({turnDecisionMode:'assist',turnDecisionLangJa:'assist'});
  assert.equal(D().floor(floorJob(0.5),250,Date.now(),'avoid'),null,'0.5 means undecided, not false');
  assert.equal(D().floor(floorJob(0.9),250,Date.now(),'avoid'),null);
});
test('an answer that went stale in the queue is not used',()=>{
  /* 答えは commit 時点の音響と待ち行列から出ている。待ち行列で数秒経っていれば
     もうその場面の話ではない。実測では commit から再生まで6〜13秒あった。 */
  reset({turnDecisionMode:'assist',turnDecisionLangJa:'assist'});
  assert.ok(D().floor(floorJob(0.1,c.TURN_FLOOR_HINT_MS-50),250,Date.now(),'avoid'),'fresh enough');
  assert.equal(D().floor(floorJob(0.1,c.TURN_FLOOR_HINT_MS+50),250,Date.now(),'avoid'),null,'too old');
});
test('with no answer the floor says nothing rather than guessing',()=>{
  reset({turnDecisionMode:'assist',turnDecisionLangJa:'assist'});
  assert.equal(D().floor(floorJob(null),250,Date.now(),'avoid'),null);
});
test('the floor can be switched off on its own',()=>{
  reset({turnDecisionMode:'assist',turnDecisionLangJa:'assist',turnFloorSafeToSpeak:false});
  assert.equal(D().floor(floorJob(0.05),250,Date.now(),'avoid'),null);
});
test('off and shadow never reach the floor at all',()=>{
  for(const mode of ['off','shadow']){
    reset({turnDecisionMode:mode,turnDecisionLangJa:mode});
    const job=floorJob(0.05);
    assert.equal(D().floor(job,250,Date.now(),'avoid'),null,mode);
    assert.equal(job.floorSince,0,mode+' must not start a timer either');
  }
});
test('the hold ends at the configured ceiling, never later (INV-09)',()=>{
  reset({turnDecisionMode:'assist',turnDecisionLangJa:'assist',turnFloorMaxWaitMs:3000});
  const now=Date.now(),job=floorJob(0.05);
  job.floorSince=now-3001;
  const f=D().floor(job,250,now,'avoid');
  assert.equal(f.action,'speak','the default releases the audio');
  assert.equal(f.reason,'floor-max-wait');
  ctx.CFG.turnFloorExpiry='drop';
  job.floorSince=now-3001;
  assert.equal(D().floor(job,250,now,'avoid').action,'drop');
});
test('boundary leaves the answer on the part, so the floor never asks again',()=>{
  reset({turnDecisionMode:'assist',turnDecisionLangJa:'assist'});
  const e=card(),seg={},i=input(),rule=D().rules(i),now=Date.now();
  const st=D().stateOf(e,seg,i,rule,900,now);
  D().cache[D().key(st)]={sessionId:st.sessionId,utteranceId:st.utteranceId,revision:st.revision,
    boundary:{choice:'HOLD',confidence:0.9,probabilities:{HOLD:0.9}},
    turnState:{choice:'CONTINUING',confidence:0.9,probabilities:{}},
    safeToSpeak:0.12,repairLikelihood:0.01,decisionId:'d9'};
  D().boundary(e,seg,i,rule,900,now);
  assert.ok(seg.floorHint,'the part carries the answer forward');
  assert.equal(seg.floorHint.safeToSpeak,0.12);
  assert.equal(seg.floorHint.at,now);
  assert.equal(seg.floorHint.decisionId,'d9');
});

/* ── INV-10 有界の待ち ─────────────────────────────────────────────────────
   質問は commit と同じ tick で飛ぶ。待たなければ答えは必ず一手遅れ、
   録音分割RESTのように確定文が一度に届く経路では一度も採用されない
   （v1.49.18 実測 送信51／応答51／適用0）。待つ相手と上限を検査する。 */
const inflightFor=(st,over)=>({abort:null,revision:st.revision,at:Date.now(),
  key:D().key(st),...(over||{})});

test('nothing is in flight with the rules provider, so active never waits',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const i=input(),rule=D().rules(i);
  assert.equal(D().boundary(card(),{},i,rule,250,Date.now()),rule);
});
test('the commit waits only while this exact state is in flight',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const e=card(),seg={},i=input(),rule=D().rules(i),now=Date.now();
  const st=D().stateOf(e,seg,i,rule,250,now);
  D().inflight[st.speakerKey]=inflightFor(st);
  const held=D().boundary(e,seg,i,rule,250,now);
  assert.equal(held.length,0,'no boundary is taken while waiting');
  assert.equal(held.waiting,'provider-pending');
  assert.equal(held.source,'provider');
  /* 別の文の答えを待っても意味がない。 */
  const other={},seg2={};
  D().inflight[st.speakerKey]=inflightFor(st,{key:'someone-elses-question'});
  assert.equal(D().boundary(e,seg2,i,rule,250,now),rule,'a different question is not ours to wait for');
  assert.ok(!other.decisionWaitUntil);
});
test('the wait is capped, and Rules commits once it expires',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const e=card(),seg={},i=input(),rule=D().rules(i),now=Date.now();
  const st=D().stateOf(e,seg,i,rule,250,now);
  D().inflight[st.speakerKey]=inflightFor(st);
  assert.equal(D().boundary(e,seg,i,rule,250,now).waiting,'provider-pending');
  assert.equal(seg.decisionWaitUntil,now+300,'the deadline is set once, from the first tick');
  assert.equal(D().boundary(e,seg,i,rule,250,now+299).waiting,'provider-pending');
  assert.equal(D().boundary(e,seg,i,rule,250,now+300),rule,'at the cap the rule result passes through');
  assert.equal(D().boundary(e,seg,i,rule,250,now+5000),rule);
});
test('a value of 0 disables the wait entirely',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active',turnDecisionCommitWaitMs:0});
  const e=card(),seg={},i=input(),rule=D().rules(i),now=Date.now();
  const st=D().stateOf(e,seg,i,rule,250,now);
  D().inflight[st.speakerKey]=inflightFor(st);
  assert.equal(D().boundary(e,seg,i,rule,250,now),rule);
  assert.ok(!seg.decisionWaitUntil);
});
test('the wait is clamped to 1000ms however large the setting is',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active',turnDecisionCommitWaitMs:99999});
  const e=card(),seg={},i=input(),rule=D().rules(i),now=Date.now();
  const st=D().stateOf(e,seg,i,rule,250,now);
  D().inflight[st.speakerKey]=inflightFor(st);
  D().boundary(e,seg,i,rule,250,now);
  assert.equal(seg.decisionWaitUntil,now+1000);
});
test('off and shadow never wait, whatever is in flight (INV-08)',()=>{
  for(const mode of ['off','shadow']){
    reset({turnDecisionMode:mode,turnDecisionLangJa:mode==='off'?'active':'shadow'});
    const e=card(),seg={},i=input(),rule=D().rules(i),now=Date.now();
    const st=D().stateOf(e,seg,i,rule,250,now);
    D().inflight[st.speakerKey]=inflightFor(st);
    assert.equal(D().boundary(e,seg,i,rule,250,now),rule,mode);
    assert.ok(!seg.decisionWaitUntil,mode);
  }
});
test('once the answer lands the wait ends and the provider boundary is taken',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const e=card(),seg={},i=input(),rule=D().rules(i),now=Date.now();
  const st=D().stateOf(e,seg,i,rule,900,now);
  D().inflight[st.speakerKey]=inflightFor(st);
  assert.equal(D().boundary(e,seg,i,rule,900,now).waiting,'provider-pending');
  const cand=(st.candidateBoundaries||[])[0];
  assert.ok(cand,'the fixture must offer a candidate to choose');
  const probs={HOLD:0.05};probs[cand.id]=0.95;
  D().cache[D().key(st)]={sessionId:st.sessionId,utteranceId:st.utteranceId,revision:st.revision,
    boundary:{choice:cand.id,confidence:0.9,probabilities:probs},
    turnState:{choice:'COMPLETE',confidence:0.9,probabilities:{}},
    safeToSpeak:0.9,repairLikelihood:0.01,decisionId:'d10'};
  delete D().inflight[st.speakerKey];
  const out=D().boundary(e,seg,i,rule,900,now+80);
  assert.equal(out.length,cand.offset,'the answer that arrived is the one that decides');
  assert.equal(out.source,'provider');
});

/* ── INV-11 「待て」にも上限 ───────────────────────────────────────────────
   答えは「同じ文の同じ revision」に紐づく。revision は新しいテキストが来たときだけ
   進むので、認識が止まると止まった瞬間の HOLD が期限なく残り、そのカードは確定も
   翻訳も読み上げもされない（v1.49.19実測 stabilityMs 112557／83967）。 */
const holdCard=(over)=>card(Object.assign({segment:{revision:3,final:false}},over||{}));
function holdSetup(over){
  const e=holdCard(),seg={start:0},i=input(),rule=D().rules(i),now=Date.now();
  const st=D().stateOf(e,seg,i,rule,900,now);
  D().cache[D().key(st)]=Object.assign({sessionId:st.sessionId,utteranceId:st.utteranceId,
    revision:st.revision,boundary:{choice:'HOLD',confidence:0.9,probabilities:{HOLD:0.9}},
    turnState:{choice:'CONTINUING',confidence:0.9,probabilities:{}},
    safeToSpeak:0.9,repairLikelihood:0.01,decisionId:'d11'},over||{});
  return {e,seg,i,rule,now,st};
}

test('a HOLD is taken, then bounded, and Rules decides at the ceiling (INV-11)',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const {e,seg,i,rule,now}=holdSetup(),from=dlogs.length;
  const said=name=>dlogs.slice(from).filter(a=>a[1]===name).length;
  assert.equal(D().boundary(e,seg,i,rule,900,now).waiting,'provider-hold');
  assert.equal(e.segment.holdSince,now,'the clock starts on the first held tick');
  assert.equal(D().boundary(e,seg,i,rule,900,now+1999).waiting,'provider-hold');
  assert.equal(D().boundary(e,seg,i,rule,900,now+2000),rule,'at the cap the rules decide');
  assert.ok(e.segment.holdOver,'the give-up is remembered for this prefix');
  assert.equal(D().boundary(e,seg,i,rule,900,now+2080),rule,'and stays given up, without new logs');
  assert.equal(said('turn-decision-hold'),1,'one line per hold, not per tick');
  assert.equal(said('turn-decision-hold-expired'),1);
});
test('the clock is per committed prefix, so growing text does not restart it',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const {e,seg,i,rule,now}=holdSetup();
  D().boundary(e,seg,i,rule,900,now);
  /* 新しいテキストが来ると版が進み、その版の答えはまだ無い。Rules がそのまま通る
     tick で時計を戻すと、Realtime のように200msごとに版が進む経路では上限が効かない。 */
  e.segment.revision=4;
  const longer=input({text:input().text+'あと一言。',stableLength:12});
  assert.equal(D().boundary(e,seg,longer,rule,900,now+1000),rule,'no answer yet, so Rules pass through');
  assert.equal(e.segment.holdSince,now,'the INV-11 clock keeps running across revisions');
  e.segment.revision=3;
  assert.equal(D().boundary(e,seg,i,rule,900,now+2000),rule,'the ceiling still lands at 2s');
});
test('a commit that moves the pending tail gives the next part a fresh clock',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const {e,seg,i,rule,now}=holdSetup();
  D().boundary(e,seg,i,rule,900,now);
  assert.equal(e.segment.holdSince,now);
  const next={start:12};
  D().boundary(e,next,i,rule,900,now+500);
  assert.equal(e.segment.holdSince,now+500,'the clock restarts for the new part');
  assert.equal(e.segment.holdStart,12);
});
test('0 refuses the provider wait outright and never holds a commit',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active',turnDecisionHoldMaxWaitMs:0});
  const {e,seg,i,rule,now}=holdSetup();
  assert.equal(D().boundary(e,seg,i,rule,900,now),rule);
  assert.ok(!e.segment.holdSince);
});
test('the ceiling is clamped to 10s however large the setting is',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active',turnDecisionHoldMaxWaitMs:99999});
  const {e,seg,i,rule,now}=holdSetup();
  D().boundary(e,seg,i,rule,900,now);
  assert.equal(D().boundary(e,seg,i,rule,900,now+9999).waiting,'provider-hold');
  assert.equal(D().boundary(e,seg,i,rule,900,now+10000),rule);
});
test('off and shadow never start the hold clock (INV-08)',()=>{
  for(const mode of ['off','shadow']){
    reset({turnDecisionMode:mode,turnDecisionLangJa:mode==='off'?'active':'shadow'});
    const {e,seg,i,rule,now}=holdSetup();
    assert.equal(D().boundary(e,seg,i,rule,900,now),rule,mode);
    assert.ok(!e.segment.holdSince,mode);
  }
});
test('a position taken by the provider clears the clock instead of expiring it',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const e=holdCard(),seg={start:0},i=input(),rule=D().rules(i),now=Date.now();
  const st=D().stateOf(e,seg,i,rule,900,now),cand=st.candidateBoundaries[0];
  const probs={HOLD:0.05};probs[cand.id]=0.95;
  D().cache[D().key(st)]={sessionId:st.sessionId,utteranceId:st.utteranceId,revision:st.revision,
    boundary:{choice:cand.id,confidence:0.9,probabilities:probs},
    turnState:{choice:'COMPLETE',confidence:0.9,probabilities:{}},
    safeToSpeak:0.9,repairLikelihood:0.01,decisionId:'d12'};
  e.segment.holdSince=now-5000;e.segment.holdOver=true;
  const out=D().boundary(e,seg,i,rule,900,now);
  assert.equal(out.length,cand.offset);
  assert.equal(e.segment.holdSince,0,'committing is progress, so the clock is put away');
});

/* ── 往復の回数は revision で数える ───────────────────────────────────────
   bucket は無音を100ms刻みで量子化するので、テキストが凍ったまま無音だけが伸びる
   状態は「新しいstate」として通り続ける（v1.49.19実測 187秒で433件／406秒で1251件、
   内容は同一）。revision が進まないなら聞き直しても判断は変わらない。 */
test('the same revision is asked at most the configured number of times',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const e=card(),seg={},i=input(),rule=D().rules(i),now=Date.now();
  const st=D().stateOf(e,seg,i,rule,900,now),from=dlogs.length;
  assert.equal(D().asksExhausted(st),false,'the first ask always goes');
  assert.equal(D().asksExhausted(st),false);
  assert.equal(D().asksExhausted(st),false);
  assert.equal(D().asksExhausted(st),true,'the fourth is refused at a limit of 3');
  assert.equal(D().asksExhausted(st),true);
  assert.equal(dlogs.slice(from).filter(a=>a[1]==='turn-decision-ask-capped').length,1,
    'said once, not every tick');
});
test('a new revision gets a fresh budget',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const e=card(),seg={},i=input(),rule=D().rules(i),now=Date.now();
  const st=D().stateOf(e,seg,i,rule,900,now);
  for(let n=0;n<4;n++)D().asksExhausted(st);
  assert.equal(D().asksExhausted(st),true);
  const e2=card({segment:{revision:4,final:false}});
  const st2=D().stateOf(e2,seg,i,rule,900,now);
  assert.equal(D().asksExhausted(st2),false,'new text is new information');
});
test('the limit is at least 1 and at most 20',()=>{
  reset({turnDecisionMode:'active',turnDecisionMaxAsksPerRevision:0});
  assert.equal(D().maxAsks(),1,'asking zero times would switch the provider off silently');
  reset({turnDecisionMode:'active',turnDecisionMaxAsksPerRevision:99999});
  assert.equal(D().maxAsks(),20);
});
test('one answer counts as one application, however many ticks read it',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  D().stats.applied=0;D().stats.holdTicks=0;
  const {e,seg,i,rule,now}=holdSetup();
  for(let n=0;n<5;n++)D().boundary(e,seg,i,rule,900,now+n*80);
  assert.equal(D().stats.applied,1,'the counter must be comparable with the number sent');
  assert.equal(D().stats.holdTicks,5,'the tick count is kept, under its own name');
});

/* ── 打ち込んだ文は発話ではない ─────────────────────────────────────────
   v1.49.23 実測：入力1件ごとに Jev へ3往復し、HOLD（0.34〜0.39）で 2.0〜2.1秒
   止めてから確定していた。話し終わりを判定する相手がいない。 */
test('typed text never reaches the decision layer, even in active',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const e=card({typed:true}),seg={start:0},i=input(),rule=D().rules(i),now=Date.now();
  const st=D().stateOf(card(),seg,i,rule,null,now);
  D().cache[D().key(st)]={sessionId:st.sessionId,utteranceId:st.utteranceId,revision:st.revision,
    boundary:{choice:'HOLD',confidence:0.9,probabilities:{HOLD:0.9}},decisionId:'typed'};
  /* 鍵を作るために上で stateOf を呼んだ分は数えない。 */
  const from=dlogs.length;peeked.count=0;
  assert.equal(D().boundary(e,seg,i,rule,null,now),rule,'the rules result itself, unchanged');
  assert.equal(dlogs.slice(from).filter(a=>/^turn-decision/.test(a[1])).length,0,'no request, no wait, no hold');
  assert.ok(!e.segment.holdSince,'the INV-11 clock is never started');
  assert.equal(peeked.count,0,'no acoustics are read for it either');
});
test('spoken text on the same card shape still goes through the layer',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const e=card(),seg={start:0},i=input(),rule=D().rules(i),now=Date.now();
  const st=D().stateOf(e,seg,i,rule,900,now);
  D().cache[D().key(st)]={sessionId:st.sessionId,utteranceId:st.utteranceId,revision:st.revision,
    boundary:{choice:'HOLD',confidence:0.9,probabilities:{HOLD:0.9}},decisionId:'spoken'};
  assert.equal(D().boundary(e,seg,i,rule,900,now).waiting,'provider-hold','the bypass is for typed text only');
});

/* ── 息継ぎを切り所の候補にする（v1.49.26）────────────────────────────
   v1.49.25 実測：話し言葉の文末（〜んじゃないの／〜だぜ／〜っけ）を規則が拾えず、
   112字の長さ打切りが2回。うち1回は「、」で終わり、読み上げがさらに4.7秒待った。
   Web Speech のカードでは、空白を直した「、」の位置を「。で終わる」「？で終わる」の
   2択で候補に出し、判断層に選ばせる。 */
const BREATH='そんなに強いなら日本は1人で作れちゃうんじゃないの、そこがまた面白いところでな、日本は';
const breathInput=(over)=>input(Object.assign({text:BREATH,stableLength:BREATH.length,breaths:true},over||{}));
test('breaths on a Web Speech card become paired statement and question candidates',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const i=breathInput(),cands=D().candidatesOf(i,{length:0});
  const first=BREATH.indexOf('、')+1;
  const at=cands.filter(c=>c.offset===first).map(c=>c.kind).sort().join(',');
  assert.equal(at,'C_PAUSE_Q,C_PAUSE_S','one position, two readings');
  assert.equal(cands.find(c=>c.id==='C_PAUSE_Q_'+first).left.slice(-4),'ないの、');
});
test('no breath candidates for other recognisers, where a comma is a real comma',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const cands=D().candidatesOf(breathInput({breaths:false}),{length:0});
  assert.equal(cands.filter(c=>/^C_PAUSE/.test(c.kind)).length,0);
});
test('breath candidates stay inside the stable prefix and off structural positions',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const first=BREATH.indexOf('、')+1,second=BREATH.indexOf('、',first)+1;
  let cands=D().candidatesOf(breathInput({stableLength:first+2}),{length:0});
  assert.ok(!cands.some(c=>c.offset===second),'past the stable prefix is not offered');
  cands=D().candidatesOf(breathInput(),{length:first});
  assert.ok(!cands.some(c=>c.offset===first&&/^C_PAUSE/.test(c.kind)),
    'the rules answer already sits there; a second option for the same cut would split the probability');
});
const pauseHit=(st,kind,offset,over)=>{
  const id=kind+'_'+offset,probs={HOLD:0.03};probs[id]=0.93;
  return Object.assign({sessionId:st.sessionId,utteranceId:st.utteranceId,revision:st.revision,
    boundary:{choice:id,confidence:0.9,probabilities:probs},
    turnState:{choice:'CONTINUING',confidence:0.9,probabilities:{CONTINUING:0.9,COMPLETE:0.1}},
    safeToSpeak:0.2,repairLikelihood:0.02,decisionId:'p1',probabilitySemantics:'native_calibrated'},over||{});
};
test('a question at a breath is cut with a question mark, while the speaker is still talking',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const i=breathInput(),rule=D().rules(i),first=BREATH.indexOf('、')+1;
  const st=D().stateOf(card(),{},i,rule,120,Date.now());
  D()._confirm={};
  let out=D().pick(st,pauseHit(st,'C_PAUSE_Q',first),rule,false);
  assert.equal(out.waiting,'provider-confirming','Japanese still needs the answer twice');
  out=D().pick(st,pauseHit(st,'C_PAUSE_Q',first),rule,false);
  assert.equal(out.length,first);
  assert.equal(out.mark,'？');
  assert.deepEqual(Array.from(out.reasons),['provider-C_PAUSE_Q','stable']);
});
test('a statement at a breath is cut with a full stop',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const i=breathInput(),rule=D().rules(i),second=BREATH.indexOf('、',BREATH.indexOf('、')+1)+1;
  const st=D().stateOf(card(),{},i,rule,120,Date.now());
  D().pick(st,pauseHit(st,'C_PAUSE_S',second),rule,false);
  const out=D().pick(st,pauseHit(st,'C_PAUSE_S',second),rule,false);
  assert.equal(out.mark,'。');
});
/* 文中の切り所で「話し終わったか」を問うと、話し続ける相手では毎回止まる。 */
test('an inner cut is not held because the utterance as a whole is continuing',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const i=breathInput(),rule=D().rules(i),first=BREATH.indexOf('、')+1;
  const st=D().stateOf(card(),{},i,rule,50,Date.now());
  D().pick(st,pauseHit(st,'C_PAUSE_S',first),rule,false);
  const out=D().pick(st,pauseHit(st,'C_PAUSE_S',first),rule,false);
  assert.equal(out.length,first,'CONTINUING and 50 ms of silence do not block a cut that has speech after it');
});
test('the end of the text still needs the speaker to have finished',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const t='来週の予定は火曜日です。',i=input({text:t,stableLength:t.length}),rule=D().rules(i);
  const st=D().stateOf(card(),{},i,rule,900,Date.now()),cand=st.candidateBoundaries.find(c=>c.offset===t.length);
  const probs={HOLD:0.03};probs[cand.id]=0.93;
  const hit={sessionId:st.sessionId,utteranceId:st.utteranceId,revision:st.revision,
    boundary:{choice:cand.id,confidence:0.9,probabilities:probs},
    turnState:{choice:'CONTINUING',confidence:0.9,probabilities:{CONTINUING:0.9}},
    safeToSpeak:0.5,repairLikelihood:0.02,decisionId:'end'};
  assert.equal(D().pick(st,hit,rule,false).waiting,'provider-continuing','unchanged for the tail');
  const st2=D().stateOf(card(),{},i,rule,100,Date.now());
  hit.turnState={choice:'COMPLETE',confidence:0.9,probabilities:{COMPLETE:0.95,CONTINUING:0.02}};
  assert.equal(D().pick(st2,hit,rule,false),null,'and the silence guard still applies at the tail');
});
test('the stable edge is not a punctuation point, so it keeps the finished-speaking gate',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const i=breathInput({stableLength:30}),rule=D().rules(i);
  const st=D().stateOf(card(),{},i,rule,900,Date.now()),cand=st.candidateBoundaries.find(c=>c.kind==='C_STABLE');
  assert.ok(cand&&/\S/.test(cand.right),'the edge has unsettled speech after it');
  const probs={HOLD:0.03};probs[cand.id]=0.93;
  const hit={sessionId:st.sessionId,utteranceId:st.utteranceId,revision:st.revision,
    boundary:{choice:cand.id,confidence:0.9,probabilities:probs},
    turnState:{choice:'CONTINUING',confidence:0.9,probabilities:{CONTINUING:0.9}},
    safeToSpeak:0.5,repairLikelihood:0.02,decisionId:'edge'};
  assert.equal(D().pick(st,hit,rule,false).waiting,'provider-continuing');
});
test('a self-repair still holds even an inner cut',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const i=breathInput(),rule=D().rules(i),first=BREATH.indexOf('、')+1;
  const st=D().stateOf(card(),{},i,rule,50,Date.now());
  const out=D().pick(st,pauseHit(st,'C_PAUSE_S',first,{turnState:{choice:'SELF_REPAIR',confidence:0.9}}),rule,false);
  assert.equal(out.waiting,'provider-self_repair');
});
/* ── 文中の切り所の答えは版をまたいで使う ─────────────────────────────
   途中結果が0.2秒ごとに伸びる相手では、往復のあいだに必ず版が変わる。
   選んだ切り所の前後が同じなら、判断の材料は変わっていない。 */
const remember=(st,hit)=>{D()._recent[st.speakerKey]={hit,sessionId:st.sessionId,
  utteranceId:st.utteranceId,segmentStart:st.segmentStart,cands:st.candidateBoundaries};};
const grown=(extra,rev,over)=>{const t=BREATH+extra;
  return {e:card({segment:{revision:rev,final:false}}),i:breathInput(Object.assign({text:t,stableLength:t.length},over||{}))};};
test('an inner answer is used on later revisions while its context is unchanged',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const first=BREATH.indexOf('、')+1,i=breathInput(),rule=D().rules(i);
  const st=D().stateOf(card(),{start:0},i,rule,50,Date.now());
  remember(st,pauseHit(st,'C_PAUSE_Q',first));
  const g=grown('ちゃんと自分の',9),r2=D().rules(g.i);
  let out=D().boundary(g.e,{start:0},g.i,r2,50,Date.now());
  out=D().boundary(g.e,{start:0},g.i,r2,50,Date.now());
  assert.equal(out.length,first,'the answer from revision 3 applies at revision 9');
  assert.equal(out.mark,'？');
});
test('a changed context, a HOLD or a tail answer is not carried',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const first=BREATH.indexOf('、')+1,i=breathInput(),rule=D().rules(i);
  const st=D().stateOf(card(),{start:0},i,rule,50,Date.now());
  remember(st,pauseHit(st,'C_PAUSE_Q',first));
  const t='そんなに強いなら日本は1人で作れちゃうんじゃないか、そこがまた面白いところでな、日本は';
  const other=breathInput({text:t,stableLength:t.length});
  assert.equal(D().carried(D().stateOf(card({segment:{revision:9}}),{start:0},other,D().rules(other),50,Date.now())),null,
    'the recogniser revised the words before the cut');
  const hold={sessionId:st.sessionId,utteranceId:st.utteranceId,revision:st.revision,
    boundary:{choice:'HOLD',confidence:0.9,probabilities:{HOLD:0.9}},decisionId:'h'};
  remember(st,hold);
  const g=grown('ちゃんと',9);
  assert.equal(D().carried(D().stateOf(g.e,{start:0},g.i,D().rules(g.i),50,Date.now())),null,'HOLD is about the tail');
});
test('an answer is not carried once a commit moves the part start, or into another utterance',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const first=BREATH.indexOf('、')+1,i=breathInput(),rule=D().rules(i);
  const st=D().stateOf(card(),{start:0},i,rule,50,Date.now());
  remember(st,pauseHit(st,'C_PAUSE_Q',first));
  const g=grown('ちゃんと',9);
  assert.equal(D().carried(D().stateOf(g.e,{start:5},g.i,D().rules(g.i),50,Date.now())),null,'offsets are measured from the part start');
  assert.equal(D().carried(D().stateOf(card({utteranceId:'u2',segment:{revision:9}}),{start:0},g.i,D().rules(g.i),50,Date.now())),null);
  assert.ok(D().carried(D().stateOf(g.e,{start:0},g.i,D().rules(g.i),50,Date.now())),'and is carried when nothing moved');
});
test('reset forgets carried answers',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  D()._recent={x:1};D().reset('test');
  assert.deepEqual(Object.keys(D()._recent),[]);
});

/* 確定した本文は待っても伸びない。HOLD に従うと上限まで読み上げが遅れるだけ。 */
test('a HOLD does not hold text the recogniser has already finalized',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangJa:'active'});
  const t='来週の予定は火曜日です',i=input({text:t,stableLength:t.length,final:true}),rule=D().rules(i),now=Date.now();
  const e=card(),st=D().stateOf(e,{start:0},i,rule,900,now);
  D().cache[D().key(st)]={sessionId:st.sessionId,utteranceId:st.utteranceId,revision:st.revision,
    boundary:{choice:'HOLD',confidence:0.9,probabilities:{HOLD:0.9}},turnState:{choice:'CONTINUING',confidence:0.9},
    safeToSpeak:0.2,repairLikelihood:0.4,decisionId:'fin'};
  const out=D().boundary(e,{start:0},i,rule,900,now);
  assert.equal(out.length,rule.length,'the rules commit goes through');
  assert.ok(!e.segment.holdSince,'no hold clock is started');
  const j=input({text:t,stableLength:t.length,final:false}),r2=D().rules(j),e2=card(),st2=D().stateOf(e2,{start:0},j,r2,900,now);
  D().cache[D().key(st2)]=Object.assign({},D().cache[D().key(st)],{revision:st2.revision});
  assert.equal(D().boundary(e2,{start:0},j,r2,900,now).length,0,'text still coming is held as before');
});

/* ── gpt-live のカードを閉じる判断（INV-13）─────────────────────────────
   固定の待ち（0.65／0.95／1.5秒）で閉じていた。turn_state が「話し終わった」と
   はっきり答えていれば短くできる。既定は記録だけ。 */
const liveCard=(over)=>card(Object.assign({srcLang:'en',utteranceId:'u9',segment:{revision:7,final:false}},over||{}));
const turnAnswer=(e,ts,over)=>{D()._turn={};D()._turn[e.utteranceId]=Object.assign({revision:e.segment.revision,lang:e.srcLang,
  ts:ts,repair:0.02,semantics:'native_calibrated',at:Date.now()},over||{});};
const COMPLETE={choice:'COMPLETE',confidence:0.9,probabilities:{COMPLETE:0.93,CONTINUING:0.04,SELF_REPAIR:0.02,UNKNOWN:0.01}};
test('live close follows the language mode, and never acts outside active',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangEn:'active',turnDecisionLiveClose:'on'});
  assert.equal(D().liveCloseMode('en'),'active');
  reset({turnDecisionMode:'active',turnDecisionLangEn:'shadow',turnDecisionLiveClose:'on'});
  assert.equal(D().liveCloseMode('en'),'shadow','a shadow language only records');
  reset({turnDecisionMode:'active',turnDecisionLangEn:'active'});
  assert.equal(D().liveCloseMode('en'),'shadow','the default is to record only');
  reset({turnDecisionMode:'active',turnDecisionLangEn:'active',turnDecisionLiveClose:'off'});
  assert.equal(D().liveCloseMode('en'),'off');
  reset({turnDecisionMode:'off',turnDecisionLangEn:'active',turnDecisionLiveClose:'on'});
  assert.equal(D().liveCloseMode('en'),'off','with the layer off there are no answers to read');
});
test('a clear COMPLETE with silence closes the card early in active',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangEn:'active',turnDecisionLiveClose:'on'});
  const e=liveCard();turnAnswer(e,COMPLETE);
  assert.equal(D().liveClose(e,350,400,Date.now()),true);
  const x={};D().liveClosed(e,x,'turn-complete',{idle:950},350,Date.now());
  assert.equal(D().stats.liveCloseEarly>=1,true);
  assert.ok(x.earlyClosedAt>0,'the item remembers the early close to notice a continuation');
  assert.ok(dlogs.some(a=>a[1]==='turn-live-close'&&a[2].savedMs===600));
});
test('shadow records what would have happened and does not close',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangEn:'active'});
  D().stats.liveCloseWould=0;D().stats.liveCloseSavedN=0;D().stats.liveCloseSavedMs=0;
  const e=liveCard(),t0=Date.now();turnAnswer(e,COMPLETE);
  assert.equal(D().liveClose(e,350,400,t0),false,'the closing time is unchanged');
  assert.equal(D().stats.liveCloseWould,1);
  D().liveClose(e,430,480,t0+80);
  assert.equal(D().stats.liveCloseWould,1,'counted once per revision, not per tick');
  D().liveClosed(e,{},'audio-pause',{idle:950},950,t0+600);
  assert.equal(D().stats.liveCloseSavedMs,600,'saved is the time between the answer and the policy close');
  assert.ok(dlogs.some(a=>a[1]==='turn-live-close-shadow'&&a[2].policyReason==='audio-pause'));
});
test('anything short of a clear COMPLETE leaves the fixed wait alone',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangEn:'active',turnDecisionLangJa:'active',turnDecisionLiveClose:'on'});
  const e=liveCard(),now=Date.now();
  turnAnswer(e,{choice:'CONTINUING',confidence:0.9,probabilities:{CONTINUING:0.9}});
  assert.equal(D().liveClose(e,350,400,now),false,'continuing');
  turnAnswer(e,{choice:'COMPLETE',confidence:0.5,probabilities:{COMPLETE:0.7,CONTINUING:0.25}});
  assert.equal(D().liveClose(e,350,400,now),false,'COMPLETE but not sure enough');
  turnAnswer(e,COMPLETE,{repair:0.4});
  assert.equal(D().liveClose(e,350,400,now),false,'a restatement is likely');
  turnAnswer(e,COMPLETE);
  assert.equal(D().liveClose(e,200,400,now),false,'text stopped only 200 ms ago');
  assert.equal(D().liveClose(e,350,null,now),false,'no microphone level: stopping text alone is not the end of speech');
  assert.equal(D().liveClose(e,350,100,now),false,'still making sound');
  turnAnswer(e,COMPLETE,{revision:6});
  assert.equal(D().liveClose(e,350,400,now),false,'the answer is about older text');
  const j=liveCard({srcLang:'ja'});turnAnswer(j,{choice:'COMPLETE',confidence:0.9,probabilities:{COMPLETE:0.88,CONTINUING:0.05}});
  assert.equal(D().liveClose(j,500,500,now),false,'Japanese needs 0.9');
  turnAnswer(e,{choice:'COMPLETE',confidence:0.9,probabilities:{COMPLETE:0.88,CONTINUING:0.05}},{semantics:'uncalibrated'});
  assert.equal(D().liveClose(e,350,400,now),false,'an uncalibrated route needs more');
});
test('speech that continues after the answer is counted, punctuation alone is not',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangEn:'active'});
  D().stats.liveCloseResumed=0;
  const e=liveCard(),t0=Date.now();turnAnswer(e,COMPLETE);
  D().liveClose(e,350,400,t0);
  D().liveResumed(e,{},t0+200,'.');
  assert.equal(D().stats.liveCloseResumed,0,'a trailing full stop is not more speech');
  D().liveResumed(e,{},t0+300,' and then');
  assert.equal(D().stats.liveCloseResumed,1);
  assert.equal(e.segment.liveCloseAt,0);
  const x={earlyClosedAt:t0};
  D().liveResumed(liveCard({segment:undefined}),x,t0+900,'more words');
  assert.equal(D().stats.liveCloseResumed,2,'after an early close the continuation lands on a new card');
});
test('an arriving answer is remembered per utterance and reset clears it',()=>{
  reset({turnDecisionMode:'active',turnDecisionLangEn:'active'});
  const st={utteranceId:'u5',revision:3,sourceLanguage:'en'};
  D().noteTurn(st,{turnState:COMPLETE,repairLikelihood:0.1,probabilitySemantics:'native_calibrated'});
  assert.equal(D()._turn.u5.revision,3);
  assert.equal(D()._turn.u5.ts.choice,'COMPLETE');
  D().reset('test');
  assert.deepEqual(Object.keys(D()._turn),[]);
});

console.log(JSON.stringify({passed:tests.length,tests},null,2));
