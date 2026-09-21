#!/usr/bin/env node
/* turn trace の replayer と自動ラベル導出（Phase 0）。
 *
 * 生の会議は再現しないので、同一入力で Rules と Provider を比較する手段が無いと
 * 「20%減」「15%短縮」は測定できない。turnTraceMode=record で書き出した trace を
 * ここへ流し、RulesProvider を app.js から実物のまま読み込んで決定を再現する。
 *
 *   node turn-trace-replay.js trace.json [--json] [--boundary semantic|rule]
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

function main(){
  const args=process.argv.slice(2),file=args.find(a=>!a.startsWith('--'));
  if(!file){
    console.error('usage: node turn-trace-replay.js <trace.json> [--json] [--boundary semantic|rule]');
    process.exit(2);
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
module.exports={replay,loadRules,percentile};
