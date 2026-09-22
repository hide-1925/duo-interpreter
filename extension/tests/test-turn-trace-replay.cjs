/* replayer の受入試験。replayer が信用できなければ Phase 0 の baseline も
   Phase 2 の shadow 比較も成立しないので、まず「記録時の Rules の決定を
   再現できる」ことを検査する。 */
const path=require('node:path'),assert=require('node:assert/strict');
const {replay,percentile}=require(path.join(__dirname,'../tools/turn-trace-replay.js'));
const APP=path.join(__dirname,'../app.js');

const tests=[];const test=(n,f)=>{f();tests.push(n);};

/* raw 付きの trace を組む。turnDecisionRawLog=on で記録した形。 */
function decisionRow(t,text,stable,over){
  return {t,kind:'decision',data:Object.assign({utteranceId:'u1',revision:1,speakerKey:'seat:A',
    lang:'ja',chars:text.length,stable,silenceMs:800,lastDeltaMs:200,final:false,
    raw:text,candidates:[],prosody:null,rule:{length:0,reasons:[],waiting:''}},over||{})};
}
function trace(rows,over){
  return Object.assign({schema:'duo.turn-trace.v1',build:'test',recordedAt:'2026-09-21T00:00:00Z',
    config:{segmentMode:'balanced',segmentBoundary:'semantic',turnDecisionMode:'off'},
    counters:{committed:0,corrected:0,committedBySource:{provider:0,rules:0},correctedBySource:{provider:0,rules:0}},
    dropped:0,rows},over||{});
}
/* 記録時の rule.length は、同じ入力を RulesProvider へ通して求める。 */
const {loadRules}=require(path.join(__dirname,'../tools/turn-trace-replay.js'));
const rules=loadRules(APP);
function withTruth(row){
  const a=row.data;
  const out=rules.decide({text:a.raw,stableLength:a.stable,lang:a.lang,idleMs:a.lastDeltaMs,
    mode:'balanced',debt:0,silenceMs:a.silenceMs===null?-1:a.silenceMs,final:a.final,
    policy:{min:12,max:48,stability:400,silence:700,mode:'balanced'}},'semantic');
  a.rule={length:out.length,reasons:out.reasons,waiting:out.waiting||''};
  return row;
}

test('a trace recorded with raw text reproduces every rule decision',()=>{
  const rows=[
    withTruth(decisionRow(1000,'来週の予定は火曜日です。',12)),
    withTruth(decisionRow(2000,'来週の予定についてですが',12)),
    withTruth(decisionRow(3000,'えっと、その、やっぱり',11)),
    withTruth(decisionRow(4000,'値は3.14です',8))
  ];
  const r=replay(trace(rows),{appPath:APP});
  assert.equal(r.replay.checked,4);
  assert.equal(r.replay.reproduced,4,JSON.stringify(r.replay.mismatched));
  assert.equal(r.replay.reproducible,1);
});

test('a trace without raw text is reported as unreplayable, not silently scored',()=>{
  const row=decisionRow(1000,'来週の予定は火曜日です。',12);
  delete row.data.raw;
  const r=replay(trace([row]),{appPath:APP});
  assert.equal(r.replay.reproduced,0);
  assert.equal(r.replay.mismatched[0].why,'raw text not recorded');
});

test('premature labels come from speech continuing inside the window',()=>{
  const commit=withTruth(decisionRow(1000,'来週の予定は火曜日です。',12));
  assert.ok(commit.data.rule.length>0,'fixture must actually commit');
  const rows=[commit,
    {t:1300,kind:'stt',data:{cardId:'e1',utteranceId:'u1',seat:'A',lang:'ja',chars:20,final:false}}];
  const r=replay(trace(rows),{appPath:APP});
  assert.equal(r.commits,1);
  assert.equal(r.labels.premature,1);
  assert.equal(r.labels.prematureRate,1);
});

test('speech resuming after the window is not counted as premature',()=>{
  const commit=withTruth(decisionRow(1000,'来週の予定は火曜日です。',12));
  const rows=[commit,
    {t:1000+900,kind:'stt',data:{cardId:'e1',utteranceId:'u1',seat:'A',lang:'ja',chars:20,final:false}}];
  assert.equal(replay(trace(rows),{appPath:APP}).labels.premature,0);
});

test('a final update does not count as the speaker carrying on',()=>{
  const commit=withTruth(decisionRow(1000,'来週の予定は火曜日です。',12));
  const rows=[commit,
    {t:1200,kind:'stt',data:{cardId:'e1',utteranceId:'u1',seat:'A',lang:'ja',chars:20,final:true}}];
  assert.equal(replay(trace(rows),{appPath:APP}).labels.premature,0);
});

test('first-audio latency reports p50 and p95, not just p50',()=>{
  const rows=[10,20,30,40,500].map((d,i)=>({t:1000+i,kind:'first-audio',
    data:{cardId:'e'+i,segmentId:'s'+i,startedAt:0,endedAt:1000,at:1000+d}}));
  const L=replay(trace(rows),{appPath:APP}).lastAudioToFirstAudioMs;
  assert.equal(L.n,5); assert.equal(L.p50,30); assert.ok(L.p95>=400);
});

test('holds are counted separately from commits',()=>{
  const hold=withTruth(decisionRow(1000,'来週の予定についてですが',12));
  assert.equal(hold.data.rule.length,0,'fixture must hold');
  assert.ok(hold.data.rule.waiting,'fixture must record a waiting reason');
  const r=replay(trace([hold]),{appPath:APP});
  assert.equal(r.commits,0); assert.equal(r.holds,1);
});

test('percentile is stable on a single value and on an empty set',()=>{
  assert.equal(percentile([],0.5),null);
  assert.equal(percentile([42],0.95),42);
});

/* ── 重み学習（--fit）─────────────────────────────────────────────────── */
const {samplesOf,languagesIn,fit,score,pickThreshold,runFit,FEATURES}=require(path.join(__dirname,'../tools/turn-trace-replay.js'));
const fs2=require('fs');

/* 学習用に、完結／継続がはっきり分かれる合成 trace を作る。 */
function fitTrace(n,lang){
  const rows=[];
  for(let i=0;i<n;i++){
    const complete=i%2===0;
    const t=i*2000;
    rows.push({t,kind:'decision',data:{utteranceId:'u'+i,revision:1,speakerKey:'seat:A',lang:lang||'ja',
      chars:12,stable:12,silenceMs:complete?900:120,lastDeltaMs:complete?800:100,final:false,
      candidates:[],raw:'来週の予定は火曜日です。',
      prosody:{terminalPitchSlope:complete?-0.25:0.15,terminalEnergyDrop:complete?12:1,
        internalPauseRatio:complete?0.05:0.4,tempoVariability:complete?0.1:0.6,quality:0.8},
      rule:{length:complete?12:0,reasons:[],waiting:complete?'':'continuing-phrase'}}});
    /* 継続側は窓内に次の delta を置く=premature ラベルになる。 */
    if(!complete)rows.push({t:t+300,kind:'stt',data:{cardId:'e',utteranceId:'u'+i,seat:'A',lang:'ja',chars:20,final:false}});
  }
  return trace(rows);
}

test('fit refuses to produce weights from too little data',()=>{
  const out=runFit(fitTrace(10),[]);
  assert.ok(out.error,'少量データでは重みを出さないこと');
  assert.match(out.skipped.ja.reason,/足りません/);
  assert.equal(Object.keys(out.languages).length,0);
});

test('languages present in a trace are detected, region tags stripped',()=>{
  const rows=fitTrace(4,'ja').rows.concat(fitTrace(4,'en-US').rows);
  assert.deepEqual(languagesIn(trace(rows)),['en','ja']);
});

test('samples are filtered per language, so ja and en never mix',()=>{
  const rows=fitTrace(20,'ja').rows.concat(fitTrace(20,'en').rows);
  const t=trace(rows);
  assert.equal(samplesOf(t,'ja').length,20);
  assert.equal(samplesOf(t,'en').length,20);
  assert.equal(samplesOf(t).length,40,'no language means every sample');
});

test('a two-language meeting yields one model per language, never a shared one',()=>{
  const rows=fitTrace(200,'ja').rows.concat(fitTrace(200,'en').rows);
  const out=runFit(trace(rows),['--precision','0.95']);
  assert.ok(!out.error,JSON.stringify(out.skipped));
  assert.deepEqual(Object.keys(out.languages).sort(),['en','ja']);
  for(const l of ['ja','en']){
    assert.equal(typeof out.languages[l].bias,'number');
    assert.ok(out.languages[l].threshold>0&&out.languages[l].threshold<1,'a calibrated threshold per language');
    assert.ok(out.languages[l].calibration.precision>=0.95);
  }
  assert.equal(out.languages.ja.features.silence!==undefined,true);
});

test('one language can pass while the other is skipped for lack of data',()=>{
  const rows=fitTrace(200,'ja').rows.concat(fitTrace(12,'en').rows);
  const out=runFit(trace(rows),['--precision','0.95']);
  assert.deepEqual(Object.keys(out.languages),['ja']);
  assert.ok(out.skipped.en,'en must be reported as skipped, not silently dropped');
  assert.match(out.skipped.en.reason,/足りません/);
});

test('a holdout with only one label is refused instead of fitted',()=>{
  /* 完結だけの trace。precision は形式上1.0になるが、学習として無意味なので止める。 */
  const rows=[];
  for(let i=0;i<200;i++) rows.push({t:i*2000,kind:'decision',data:{utteranceId:'u'+i,revision:1,
    speakerKey:'seat:A',lang:'ja',chars:12,stable:12,silenceMs:900,lastDeltaMs:800,final:false,
    candidates:[],raw:'来週の予定は火曜日です。',prosody:null,rule:{length:12,reasons:[],waiting:''}}});
  const out=runFit(trace(rows),[]);
  assert.ok(out.skipped.ja,'片方のラベルだけなら学習しないこと');
  assert.match(out.skipped.ja.reason,/片方のラベル/);
});

test('fit separates complete from continuing and reaches the precision target',()=>{
  const out=runFit(fitTrace(200),['--precision','0.95']);
  assert.ok(!out.error,JSON.stringify(out));
  const m=out.languages.ja;
  assert.equal(typeof m.bias,'number');
  for(const f of FEATURES) assert.equal(typeof m.features[f],'number','missing weight: '+f);
  assert.ok(m.calibration.precision>=0.95,'holdout precision '+m.calibration.precision);
  assert.ok(m.calibration.recall>0,'recall must not be zero');
});

test('fit records what it was fitted on, so a stale model is detectable',()=>{
  const out=runFit(fitTrace(200),[]);
  assert.equal(out.languages.ja.fittedOn.train+out.languages.ja.fittedOn.holdout,200);
  assert.match(out.version,/^local-\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(out.fittedOn.languages,['ja']);
});

test('the fitted feature list matches the one the app scores with',()=>{
  /* 学習側と推論側で並びがずれると、係数が別の特徴へ当たる。両方を突き合わせる。 */
  const app=fs2.readFileSync(path.join(__dirname,'../app.js'),'utf8').replace(/\r\n/g,'\n');
  const m=app.match(/features:function\(state\)\{[\s\S]*?return \{bias:1,([\s\S]*?)\};/);
  assert.ok(m,'TurnProviders.local.features not found');
  const inApp=(m[1].match(/^\s*([A-Za-z]+):/gm)||[]).map(x=>x.trim().replace(':',''));
  for(const f of FEATURES) assert.ok(inApp.includes(f),'app side is missing feature: '+f);
  for(const f of inApp) assert.ok(FEATURES.includes(f),'fitter is missing feature: '+f);
});

test('the fitted model scores a clear complete above a clear continuing',()=>{
  const out=runFit(fitTrace(200),[]);
  const model={bias:out.languages.ja.bias,features:out.languages.ja.features};
  const hi=score(model,{silence:0.9,meterKnown:1,lastDelta:0.8,final:0,stableRatio:1,
    pitchSlope:-0.25,energyDrop:0.3,pauseRatio:0.05,tempoVar:0.1,prosodyQuality:0.8});
  const lo=score(model,{silence:0.12,meterKnown:1,lastDelta:0.1,final:0,stableRatio:1,
    pitchSlope:0.15,energyDrop:0.025,pauseRatio:0.4,tempoVar:0.6,prosodyQuality:0.8});
  assert.ok(hi>lo,'complete '+hi.toFixed(3)+' must score above continuing '+lo.toFixed(3));
});

console.log(JSON.stringify({passed:tests.length,tests},null,2));
