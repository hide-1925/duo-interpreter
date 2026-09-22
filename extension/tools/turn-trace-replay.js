#!/usr/bin/env node
/* turn trace の replayer と自動ラベル導出（Phase 0）。
 *
 * 生の会議は再現しないので、同一入力で Rules と Provider を比較する手段が無いと
 * 「20%減」「15%短縮」は測定できない。turnTraceMode=record で書き出した trace を
 * ここへ流し、RulesProvider を app.js から実物のまま読み込んで決定を再現する。
 *
 *   node turn-trace-replay.js trace.json [--json] [--boundary semantic|rule]
 *   node turn-trace-replay.js trace.json --fit [--out weights.json]
 *                                    [--precision 0.98] [--min 50]
 *
 * 自動ラベル: commit 後に原文訂正が入った、または同一話者が 800ms 以内に発話を
 * 続けた commit を premature とみなす。人手ラベルなしで baseline が出る。 */
'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');

const PREMATURE_CONTINUE_MS=800;

function loadRules(appPath){
  const src=fs.readFileSync(appPath,'utf8').replace(/\r\n/g,'\n'),lines=src.split('\n');
  const block=start=>{
    const i=lines.findIndex(l=>l.startsWith(start));
    if(i<0)throw new Error('block not found: '+start);
    for(let j=i+1;j<lines.length;j++) if(lines[j]==='}'||lines[j]==='};') return lines.slice(i,j+1).join('\n');
    throw new Error('unterminated: '+start);
  };
  const ctx={console,Math,Date,JSON,Object,Array,String,Number,RegExp,CFG:{},
    hasSpeechContent:t=>/[\p{L}\p{N}]/u.test(String(t||''))};
  const c=vm.createContext(ctx);
  for(const b of [block('function segDecision(input){'),
                  block('function segSemanticTail(text,lang){'),
                  block('function segSemanticDecision(input){')]) vm.runInContext(b,c);
  return {ctx,decide:(input,boundary)=>boundary==='semantic'?c.segSemanticDecision(input):c.segDecision(input)};
}

function percentile(values,q){
  if(!values.length)return null;
  const a=values.slice().sort((x,y)=>x-y),i=(a.length-1)*q,lo=Math.floor(i),hi=Math.ceil(i);
  return Math.round(lo===hi?a[lo]:a[lo]+(a[hi]-a[lo])*(i-lo));
}

function replay(trace,opts){
  const rules=loadRules(opts.appPath);
  const boundary=opts.boundary||trace.config&&trace.config.segmentBoundary||'semantic';
  const rows=trace.rows||[];
  const decisions=rows.filter(r=>r.kind==='decision');
  const stt=rows.filter(r=>r.kind==='stt');
  const firstAudio=rows.filter(r=>r.kind==='first-audio');

  /* 記録時の Rules の決定を、いま読み込んだ RulesProvider で再現できるか。
     これが合わなければ replayer が信用できないので、他の数字も読まない。 */
  let reproduced=0,mismatched=[];
  for(const d of decisions){
    const a=d.data,input={text:a.raw!==undefined?a.raw:null,stableLength:a.stable,lang:a.lang,
      idleMs:a.lastDeltaMs,mode:trace.config&&trace.config.segmentMode||'balanced',debt:0,
      silenceMs:a.silenceMs===null?-1:a.silenceMs,final:a.final,
      policy:{min:12,max:48,stability:400,silence:700,mode:'balanced'}};
    if(input.text===null){mismatched.push({t:d.t,why:'raw text not recorded'});continue;}
    const out=rules.decide(input,boundary);
    if(out.length===a.rule.length)reproduced++;
    else mismatched.push({t:d.t,expected:a.rule.length,got:out.length,reasons:out.reasons});
  }

  /* 自動ラベル。trace の commit 列と後続の発話から premature を導く。 */
  const commits=decisions.filter(d=>d.data.rule.length>0);
  let premature=0;
  for(const cm of commits){
    const after=stt.find(s=>s.t>cm.t&&s.t-cm.t<=PREMATURE_CONTINUE_MS&&
      s.data.utteranceId===cm.data.utteranceId&&!s.data.final);
    if(after)premature++;
  }

  const latencies=firstAudio.map(f=>f.data.endedAt&&f.data.at?f.data.at-f.data.endedAt:null).filter(v=>v!==null);
  const holds=decisions.filter(d=>d.data.rule.waiting);

  return {
    build:trace.build,recordedAt:trace.recordedAt,config:trace.config||{},boundary,
    rows:rows.length,droppedRows:trace.dropped||0,
    decisions:decisions.length,commits:commits.length,holds:holds.length,
    replay:{reproduced,checked:decisions.length,mismatched:mismatched.slice(0,10),
      reproducible:decisions.length?+(reproduced/decisions.length).toFixed(4):null},
    labels:{premature,prematureRate:commits.length?+(premature/commits.length).toFixed(4):null,
      window:PREMATURE_CONTINUE_MS},
    counters:trace.counters||{},
    lastAudioToFirstAudioMs:{n:latencies.length,p50:percentile(latencies,0.5),p95:percentile(latencies,0.95)}
  };
}

/* LocalModelProvider の重みを trace から学習する（§9.1）。閾値を手置きせず、
 * 自動ラベルから合成器のウェイトを当てる。ロジスティック回帰をバッチ勾配降下で
 * 解くだけの素朴な実装で、特徴量は app.js の TurnProviders.local.features と
 * 同じ並びにする。学習と holdout を半分ずつに割り、holdout の precision を出す。 */
const FEATURES=['silence','meterKnown','lastDelta','final','stableRatio',
  'pitchSlope','energyDrop','pauseRatio','tempoVar','prosodyQuality'];

function featuresOf(d){
  const p=d.prosody||{},sil=d.silenceMs,last=d.lastDeltaMs;
  const chars=d.chars||0;
  return {
    silence:sil===null||sil===undefined?0:Math.min(sil,2000)/1000,
    meterKnown:sil===null||sil===undefined?0:1,
    lastDelta:last===null||last===undefined?0:Math.min(last,3000)/1000,
    final:d.final?1:0,
    stableRatio:chars?(d.stable||0)/chars:0,
    pitchSlope:typeof p.terminalPitchSlope==='number'?p.terminalPitchSlope:0,
    energyDrop:typeof p.terminalEnergyDrop==='number'?Math.min(p.terminalEnergyDrop,40)/40:0,
    pauseRatio:typeof p.internalPauseRatio==='number'?p.internalPauseRatio:0,
    tempoVar:typeof p.tempoVariability==='number'?p.tempoVariability:0,
    prosodyQuality:typeof p.quality==='number'?p.quality:0
  };
}

/* ラベル: その decision のあとPREMATURE窓内に同一発話の継続が無ければ「完結」。
 * 自動ラベルなので人手の注釈は要らないが、その分ノイズが乗る前提で扱う。 */
function samplesOf(trace,lang){
  const rows=trace.rows||[],stt=rows.filter(r=>r.kind==='stt');
  const want=lang?String(lang).split('-')[0]:null;
  return rows.filter(r=>r.kind==='decision'&&
      (!want||String(r.data.lang||'').split('-')[0]===want)).map(r=>{
    const continued=stt.some(s=>s.t>r.t&&s.t-r.t<=PREMATURE_CONTINUE_MS&&
      s.data.utteranceId===r.data.utteranceId&&!s.data.final);
    return {x:featuresOf(r.data),y:continued?0:1};
  });
}

/* trace に現れた言語。話者Aと話者Bで言語が違う会議では2つ以上になる。 */
function languagesIn(trace){
  const set=new Set();
  for(const r of (trace.rows||[]))
    if(r.kind==='decision'&&r.data.lang) set.add(String(r.data.lang).split('-')[0]);
  return Array.from(set).sort();
}

function fit(samples,opts){
  opts=opts||{};
  const iters=opts.iters||4000,lr=opts.lr||0.2,l2=opts.l2||1e-3;
  let bias=0;const w={};for(const f of FEATURES)w[f]=0;
  for(let it=0;it<iters;it++){
    let gb=0;const g={};for(const f of FEATURES)g[f]=0;
    for(const s of samples){
      let z=bias;for(const f of FEATURES)z+=w[f]*(s.x[f]||0);
      const err=1/(1+Math.exp(-z))-s.y;
      gb+=err;for(const f of FEATURES)g[f]+=err*(s.x[f]||0);
    }
    const n=Math.max(1,samples.length);
    bias-=lr*gb/n;
    for(const f of FEATURES)w[f]-=lr*(g[f]/n+l2*w[f]);
  }
  return {bias,features:w};
}

function score(model,x){
  let z=model.bias;for(const f of FEATURES)z+=model.features[f]*(x[f]||0);
  return 1/(1+Math.exp(-z));
}

/* precision 目標から閾値を逆算する。目標を満たす最小の閾値を採る（§9.1 手順3）。 */
function pickThreshold(model,samples,targetPrecision){
  let best=null;
  for(let th=0.50;th<=0.99;th+=0.01){
    let tp=0,fp=0,pos=0;
    for(const s of samples){
      if(s.y===1)pos++;
      if(score(model,s.x)>=th){ if(s.y===1)tp++;else fp++; }
    }
    const precision=tp+fp?tp/(tp+fp):1, recall=pos?tp/pos:0;
    if(precision>=targetPrecision){best={threshold:+th.toFixed(2),precision:+precision.toFixed(4),
      recall:+recall.toFixed(4),tp,fp};break;}
  }
  return best;
}

function runFit(trace,args){
  const arg=(name,def)=>{const i=args.indexOf(name);return i>=0&&args[i+1]!==undefined?args[i+1]:def;};
  const target=Number(arg('--precision',0.98));
  const minPer=Number(arg('--min',50));
  const langs=languagesIn(trace);
  const out={version:'local-'+new Date().toISOString().slice(0,10),
    fittedOn:{trace:trace.recordedAt||null,build:trace.build||null,languages:langs},
    targetPrecision:target,minSamplesPerLanguage:minPer,languages:{},skipped:{}};
  if(!langs.length){out.error='trace に decision が1件もありません。';return out;}

  /* 言語ごとに独立して学習する。公式ドキュメントが「日本語の本番ワークロードは
   * 英語の閾値を流用せず独自のラベル付き評価が必要」と明記しており、ja と en を
   * 混ぜた1つのモデルはその注意をそのまま踏み抜く（仕様書 §9.3）。
   * 片方だけ条件を満たすこともある。その場合はその言語だけ出す。 */
  for(const lang of langs){
    const all=samplesOf(trace,lang);
    if(all.length<minPer){
      out.skipped[lang]={decisions:all.length,need:minPer,
        reason:'学習に足りません。この言語の decision を '+minPer+'件以上集めてください。'};
      continue;
    }
    /* 時系列なので前半で学習し後半で評価する。シャッフルすると同一発話が両側へ漏れる。 */
    const cut=Math.floor(all.length/2),train=all.slice(0,cut),hold=all.slice(cut);
    const pos=hold.filter(s=>s.y===1).length;
    if(!pos||pos===hold.length){
      out.skipped[lang]={decisions:all.length,
        reason:'holdout が片方のラベルだけです。完結と継続の両方を含む会議が必要です。'};
      continue;
    }
    const model=fit(train);
    const picked=pickThreshold(model,hold,target);
    if(!picked){
      out.skipped[lang]={decisions:all.length,
        reason:'holdout で目標 precision '+target+' に達する閾値がありません。データを増やすか目標を見直してください。'};
      continue;
    }
    out.languages[lang]={
      bias:+model.bias.toFixed(5),
      features:Object.fromEntries(FEATURES.map(f=>[f,+model.features[f].toFixed(5)])),
      threshold:picked.threshold,
      calibration:{targetPrecision:target,precision:picked.precision,recall:picked.recall,
        tp:picked.tp,fp:picked.fp},
      fittedOn:{train:train.length,holdout:hold.length,
        completeRate:+(pos/hold.length).toFixed(4)}
    };
  }
  if(!Object.keys(out.languages).length)
    out.error='どの言語も学習条件を満たしませんでした。'+JSON.stringify(out.skipped);
  return out;
}

function main(){
  const args=process.argv.slice(2),file=args.find(a=>!a.startsWith('--'));
  if(!file){
    console.error('usage: node turn-trace-replay.js <trace.json> [--json] [--boundary semantic|rule]');
    process.exit(2);
  }
  if(args.includes('--fit')){
    const trace=JSON.parse(fs.readFileSync(file,'utf8'));
    const out=runFit(trace,args);
    const oi=args.indexOf('--out');
    if(oi>=0&&args[oi+1]){fs.writeFileSync(args[oi+1],JSON.stringify(out,null,2));
      console.log('wrote '+args[oi+1]);}
    console.log(JSON.stringify(out,null,2));
    if(out.error||out.calibration&&out.calibration.error)process.exitCode=1;
    return;
  }
  const bi=args.indexOf('--boundary');
  const report=replay(JSON.parse(fs.readFileSync(file,'utf8')),
    {appPath:path.join(__dirname,'../app.js'),boundary:bi>=0?args[bi+1]:null});
  if(args.includes('--json')){console.log(JSON.stringify(report,null,2));return;}

  const r=report;
  console.log('trace      '+r.rows+' rows'+(r.droppedRows?' ('+r.droppedRows+' dropped)':'')+'  build '+r.build);
  console.log('mode       segment='+r.config.segmentMode+' boundary='+r.boundary+' turnDecision='+r.config.turnDecisionMode);
  console.log('decisions  '+r.decisions+'  commits '+r.commits+'  holds '+r.holds);
  console.log('replay     '+r.replay.reproduced+'/'+r.replay.checked+' reproduced'+
    (r.replay.reproducible!==null?' ('+(r.replay.reproducible*100).toFixed(1)+'%)':''));
  if(r.replay.mismatched.length){
    console.log('           first mismatches:');
    for(const m of r.replay.mismatched)console.log('             t='+m.t+' '+(m.why||('expected '+m.expected+' got '+m.got)));
  }
  console.log('premature  '+r.labels.premature+'/'+r.commits+
    (r.labels.prematureRate!==null?' ('+(r.labels.prematureRate*100).toFixed(1)+'%)':'')+
    '  window '+r.labels.window+'ms');
  const L=r.lastAudioToFirstAudioMs;
  console.log('firstAudio n='+L.n+'  p50='+(L.p50===null?'-':L.p50+'ms')+'  p95='+(L.p95===null?'-':L.p95+'ms'));
  if(r.counters.committedBySource)
    console.log('bySource   committed '+JSON.stringify(r.counters.committedBySource)+
      '  corrected '+JSON.stringify(r.counters.correctedBySource));
}
if(require.main===module)main();
module.exports={replay,loadRules,percentile,samplesOf,languagesIn,fit,score,pickThreshold,runFit,FEATURES};
