'use strict';
/* gpt-4o 系（録音ファイルAPI）でニュース音声を読み上げた記録から直した3点の受入試験。
 *
 * 起点は v1.49.29 の記録（gpt-4o-mini-transcribe、言語A・B とも日本語、言語切替 AUTO、
 * 共有音声、Aivis 話速 1.8、Prosody TTS反映 ON、adaptive）。
 * - 言語を伝えずに送っていて、日本語の音声がウクライナ語・トルコ語・韓国語で返ったカードが4枚。
 * - 読み上げが30秒近く遅れている最中にも、Prosody が 0.82倍・0.9倍で話速を落としていた。
 * - 読み上げ待ちのカードが9〜16枚ある場面でも、Prosody が1枚ずつ違うため Aivis への要求が
 *   64回中60回1枚ずつになり、直近60秒の要求が最大25回（上限10回）に達していた。 */
const path=require('node:path'),fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const src=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8').replace(/\r\n/g,'\n');
const lines=src.split('\n');
function block(startsWith){
  const i=lines.findIndex(l=>l.startsWith(startsWith));
  assert.ok(i>=0,'block not found: '+startsWith);
  for(let j=i;j<lines.length;j++) if(lines[j]==='}'||lines[j]==='};'||lines[j]==='];'||(j===i&&/\}\s*$/.test(lines[j])&&!/\{\s*$/.test(lines[j])&&lines[j].split('{').length===lines[j].split('}').length))
    return lines.slice(i,j+1).join('\n');
  throw new Error('unterminated: '+startsWith);
}
const line=(p)=>{const l=lines.find(l=>l.startsWith(p));assert.ok(l,'line not found: '+p);return l;};
const tests=[];const test=(n,f)=>{f();tests.push(n);};

/* ---------- 言語を伝えるか ---------- */
function sttWorld(o={}){
  const sent=[];
  function FormData(){this.fields=[];}
  FormData.prototype.append=function(k,v){this.fields.push([k,v]);};
  const ctx={console,String,Object,JSON,Math,Promise,Error,Array,FormData,
    CFG:Object.assign({langA:'ja',langB:'ja',sttProvider:'openai',sttModel:'gpt-4o-mini-transcribe',glossary:[],srcA:'mic',srcB:'display'},o.cfg||{}),
    S:{autoMode:o.auto!==false},duoSession:{presetId:'web'},
    AudioEndpointManager:{forView:()=>({enabled:true,type:'system-audio'})},
    STT_BASE:{openai:'https://stt.example/v1'},sttKey:()=>'k',chk:(r)=>r,dlog:()=>{},
    defaultSttModel:()=>'gpt-4o-mini-transcribe',persistSetting:()=>{},
    fetch:(url,opt)=>{sent.push({url,fd:opt.body});return Promise.resolve({text:''});}};
  vm.createContext(ctx);
  vm.runInContext([block('var LANGS = ['),line('function L(code)'),block('function micSeats('),
    block('function duoShouldAutoDetectInput('),block('function sttAutoDetect('),block('function sttCall(')].join('\n'),ctx);
  const call=(seat)=>{const auto=ctx.duoShouldAutoDetectInput(seat);
    ctx.sttCall({type:'audio/webm'},seat==='A'?ctx.CFG.langA:ctx.CFG.langB,{autoLanguage:auto});
    const fd=sent[sent.length-1].fd,get=(k)=>fd.fields.filter(f=>f[0]===k).map(f=>f[1]);
    return {auto,language:get('language')[0]||null,prompt:get('prompt')[0]||''};};
  return {ctx,call};
}
test('AUTO with both seats in Japanese still tells 4o the language is Japanese',()=>{
  const r=sttWorld().call('B');
  assert.equal(r.auto,false,'nothing to guess when both languages are the same');
  assert.equal(r.language,'ja');
  assert.ok(!/The speech is in/.test(r.prompt),'no two-language hint');
});
test('AUTO with two different languages leaves the language open, but names the two in the prompt',()=>{
  const r=sttWorld({cfg:{langA:'ja',langB:'en'}}).call('B');
  assert.equal(r.auto,true);
  assert.equal(r.language,null,'language is not sent');
  assert.match(r.prompt,/The speech is in Japanese or English\./);
  assert.match(r.prompt,/Transcribe verbatim/,'the verbatim instruction stays');
});
test('without AUTO the seat language is sent as before',()=>{
  const r=sttWorld({auto:false,cfg:{langA:'ja',langB:'en'}}).call('B');
  assert.equal(r.auto,false);assert.equal(r.language,'en');
  assert.ok(!/The speech is in/.test(r.prompt));
});
test('two people sharing one mic in AUTO: guessed only when their languages differ',()=>{
  const same=sttWorld({cfg:{srcB:'mic'}}),diff=sttWorld({cfg:{srcB:'mic',langB:'en'}});
  assert.equal(same.ctx.sttAutoDetect({}),false);
  assert.equal(diff.ctx.sttAutoDetect({}),true);
});

/* ---------- 遅れているあいだは Prosody で遅くしない ---------- */
function bodyWorld(){
  const ctx={console,String,Object,JSON,Math,parseFloat,parseInt,isNaN,
    CFG:{aivisRate:'1.8',aivisEmo:'1.65',aivisTempo:'1.6',aivisVol:'1',aivisBreak:'0.4',aivisNorm:true,aivisDict:''},
    SEG:{dispatchRate:1},
    aivisModelFor:()=>'model',aivisSpeakerFor:()=>'spk',aivisStyleFor:()=>'1',
    prosodyMapForTts:(p)=>p?{rate:p.rate,dynamics:p.dynamics||1,volume:p.volume||1}:null};
  vm.createContext(ctx);
  vm.runInContext([block('function prosodyRound('),line('function prosodyClamp('),block('var AIVIS_DEFAULTS = '),
    block('function aivisBody(')].join('\n'),ctx);
  return ctx;
}
test('a slow prosody reading is held at 1 while adaptive is catching up',()=>{
  const c=bodyWorld(),slow={rate:0.82,dynamics:1.1};
  assert.equal(c.aivisBody('x','B','mp3',slow).speaking_rate,1.476,'keeping up: prosody still slows (1.8 × 0.82)');
  c.SEG.dispatchRate=1.08;
  const b=c.aivisBody('x','B','mp3',slow);
  assert.equal(b.speaking_rate,1.944,'catching up: 1.8 × 1 × 1.08');
  assert.equal(b._prosodyRateHeld,0.82,'what was held back is kept for the log');
  assert.equal(b.tempo_dynamics,1.76,'dynamics still follow prosody (1.6 × 1.1)');
});
test('a faster prosody reading still applies while catching up, capped at 2',()=>{
  const c=bodyWorld();c.SEG.dispatchRate=1.04;
  const b=c.aivisBody('x','B','mp3',{rate:1.15});
  assert.equal(b.speaking_rate,2);assert.equal(b._prosodyRateHeld,undefined);
});

/* ---------- 遅れているあいだは Prosody の違いでまとめ送りを止めない ---------- */
function groupWorld(debt){
  const ctx={console,String,Object,JSON,Math,Date:{now:()=>100000},
    CFG:{ttsSrc:false},SEG:{queue:[],epoch:1,dispatchRate:1},
    segEarlierOpen:()=>false,segManualJobValid:()=>true,segAudioAllowed:()=>true,segDebt:()=>debt,
    aivisBody:(t,seat,fmt,prosody)=>({seat,rate:prosody?prosody.rate:null})};
  vm.createContext(ctx);
  vm.runInContext([line('var SEG_SENTENCE_WAIT_MAX_MS'),block('function segSentenceWaitLeft('),line('var SEG_AIVIS_LOOSE_DEBT'),
    line('function segAivisVoiceKey('),block('function segAivisGroup('),block('function segPartEndsSentence(')].join('\n'),ctx);
  let n=0;
  const job=(text,rate)=>{const card={id:'e'+(++n),seat:'B',srcLang:'ja',dstLang:'ja',origin:{s:1},speaker:null,prosody:{rate},
      segment:{cancelled:false,lastUpdate:0}};
    const j={card,epoch:1,cancelled:false,segment:{seq:1,sourceText:text,translationText:text,translationReady:true,translationError:false,
      translatedAt:0,committedAt:0,commitReason:[],audio:{}}};ctx.SEG.queue.push(j);return j;};
  return {ctx,job};
}
test('keeping up: cards whose prosody differs are still sent one by one',()=>{
  const w=groupWorld(1),a=w.job('ロシア軍の部隊が前進しました。',0.9);w.job('反攻作戦が続いています。',1.3);
  const g=w.ctx.segAivisGroup(a,false,100000,false);
  assert.equal(g.group.length,1);assert.equal(g.loose,false);
});
test('behind by 4 s or more: they go in one request, read with the first card\'s prosody',()=>{
  const w=groupWorld(5),a=w.job('ロシア軍の部隊が前進しました。',0.9);w.job('反攻作戦が続いています。',1.3);w.job('無人機の攻撃もありました。',1);
  const g=w.ctx.segAivisGroup(a,false,100000,false);
  assert.equal(g.group.length,3);assert.equal(g.loose,true);
  assert.equal(g.target,'ロシア軍の部隊が前進しました。 反攻作戦が続いています。 無人機の攻撃もありました。');
});
test('behind: a different voice or seat still splits the request',()=>{
  const w=groupWorld(9),a=w.job('一つ目です。',1),b=w.job('二つ目です。',1);b.card.seat='A';
  assert.equal(w.ctx.segAivisGroup(a,false,100000,false).group.length,1);
});

/* ---------- 無音で切れた切れ端を次の結果につなぐ ---------- */
function bufWorld(o={}){
  const w={entries:[],logs:[],calls:[],now:1000};let n=0;
  const ctx={console,String,Number,Object,JSON,Math,Array,Promise,Error,isFinite,
    Date:{now:()=>w.now},setTimeout:()=>0,clearTimeout:()=>{},AbortController:function(){this.abort=()=>{};},
    S:{running:true,entries:w.entries,autoMode:false},sessionGen:1,
    CFG:Object.assign({langA:'ja',langB:'ja',sttModel:'gpt-4o-mini-transcribe',prosodyOn:false},o.cfg||{}),
    addEntry:(seat,text,interim)=>{const e={id:'e'+(++n),seat,srcText:text,interim,srcLang:'ja',dstLang:'ja'};w.entries.push(e);return e;},
    removeEntry:(e)=>{const i=w.entries.indexOf(e);if(i>=0)w.entries.splice(i,1);},
    render:()=>{},segEnabled:()=>false,segInit:()=>{},segUpdate:()=>{},speakSrcNow:()=>{},translate:()=>{},
    dlog:(c,m,d)=>w.logs.push({m,d}),hasSpeechContent:(x)=>!!String(x).trim(),isEcho:()=>false,
    toast:()=>{},realtimeEscape:(x)=>x,redact:(x)=>x,attachProsody:()=>{},
    langOf:()=>'ja',micSeats:()=>['A'],duoShouldAutoDetectInput:()=>false,sttAutoDetect:()=>false,
    sttCall:()=>new Promise((res)=>w.calls.push(res))};
  vm.createContext(ctx);
  vm.runInContext([block('function fourOSentenceEnds('),block('function fourOSplit('),block('function fourOJoin('),
    block('function fourOCardText('),block('function fourOFinalize('),block('function fourOPlaceAfter('),block('function fourOTailStart('),
    block('function FourOFileBuffer('),block('FourOFileBuffer.prototype.alive='),block('FourOFileBuffer.prototype.submit='),
    block('FourOFileBuffer.prototype.release='),block('FourOFileBuffer.prototype.drain='),block('FourOFileBuffer.prototype.poll=')].join('\n'),ctx);
  const buf=vm.runInContext('new FourOFileBuffer({})',ctx);
  w.clip=async(text,reason,carry=true)=>{buf.submit({},'B',null,{reason,seconds:6,carry,startedAt:w.now-2000,endedAt:w.now});
    w.calls.shift()(text);await new Promise(r=>setImmediate(r));};
  w.cards=()=>w.entries.map(e=>({text:e.srcText,open:!!(e.fourOState&&e.fourOState.pending)}));
  w.buf=buf;return w;
}
const atest=async(n,f)=>{await f();tests.push(n);};
const bufTests=(async()=>{
await atest('a silence cut without a sentence end waits and joins the next result into the same card',async()=>{
  const w=bufWorld();
  await w.clip('まずその','silence');
  assert.deepEqual(w.cards(),[{text:'まずその',open:true}],'shown right away, still open');
  await w.clip('組織改革ですけど、旅団を中心にしていました。','silence');
  assert.deepEqual(w.cards(),[{text:'まずその組織改革ですけど、旅団を中心にしていました。',open:false}]);
  const held=w.logs.filter(l=>l.m==='4o-tail-held');
  assert.equal(held.length,1);assert.equal(held[0].d.cut,'silence');
});
await atest('a silence cut that ends a sentence closes the card at once, as before',async()=>{
  const w=bufWorld();
  await w.clip('地雷を次々と見つけて、爆破処理していきます。','silence');
  assert.deepEqual(w.cards(),[{text:'地雷を次々と見つけて、爆破処理していきます。',open:false}]);
  await w.clip('ウクライナメディアは、','silence');
  assert.deepEqual(w.cards().map(c=>c.open),[false,true]);
});
await atest('sentences are closed and only the unfinished rest waits',async()=>{
  const w=bufWorld();
  await w.clip('全体が一つのオーケストラだ。ビバルディ作戦には、','silence');
  assert.deepEqual(w.cards(),[{text:'全体が一つのオーケストラだ。',open:false},{text:'ビバルディ作戦には、',open:true}]);
});
await atest('the waiting rest is closed after 0.9 s without voice in the next recording',async()=>{
  const w=bufWorld();
  await w.clip('一方で、','silence');
  w.buf.poll(w.now,false);assert.equal(w.cards()[0].open,true,'voice is back: keep waiting');
  w.buf.poll(w.now,true);assert.deepEqual(w.cards(),[{text:'一方で、',open:false}]);
});
await atest('with carry off, every silence cut is its own card as before',async()=>{
  const w=bufWorld();
  await w.clip('まずその','silence',false);await w.clip('組織改革です。','silence',false);
  assert.deepEqual(w.cards(),[{text:'まずその',open:false},{text:'組織改革です。',open:false}]);
});
await atest('on a timed cut a final period is still not trusted',async()=>{
  const w=bufWorld();
  await w.clip('ロシア軍は地雷原で防御している。','limit');
  assert.deepEqual(w.cards(),[{text:'ロシア軍は地雷原で防御している。',open:true}]);
});
})();

/* ---------- 声の無い録音は上限で切っても送らない ---------- */
test('a recording that never had voice is not sent when the time limit cuts it',()=>{
  const l=lines.find(x=>/self\.cut\(.*'limit'\)/.test(x));
  assert.ok(l,'limit cut line');assert.match(l,/self\.cut\(self\.voice,'limit'\)/);
});

bufTests.then(()=>{
console.log(JSON.stringify({test:'4o-tuning',passed:tests.length}));
}).catch(e=>{console.error(e);process.exit(1);});
