'use strict';
/* gpt-4o 系で、一人が話し続けているあいだカードを分けない受入試験。
 * v1.49.37 までは録音1回（無音0.9秒か録音上限で切れる）ごとにカードを閉じていたので、文の切れ目で
 * 息を継ぐ話し手ではほぼ1文1枚になった。今はカードを開けたまま続きを足し、訳と読み上げはカードの中の
 * 文ごとに進める。ここでは本物の segUpdate・segCheck・segSemanticDecision を使い、確定する位置まで見る。 */
const path=require('node:path'),fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const src=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8').replace(/\r\n/g,'\n');
const lines=src.split('\n');
function block(startsWith){
  const i=lines.findIndex(l=>l.startsWith(startsWith));
  assert.ok(i>=0,'block not found: '+startsWith);
  if(/\}\s*;?\s*$/.test(lines[i])&&lines[i].split('{').length===lines[i].split('}').length)return lines[i];
  for(let j=i+1;j<lines.length;j++) if(lines[j]==='}'||lines[j]==='};') return lines.slice(i,j+1).join('\n');
  throw new Error('unterminated: '+startsWith);
}
const line=(p)=>{const l=lines.find(l=>l.startsWith(p));assert.ok(l,'line not found: '+p);return l;};

function world(o={}){
  const w={entries:[],logs:[],calls:[],now:100000};let n=0;
  const ctx={console,String,Number,Object,JSON,Math,Array,Promise,Error,isFinite,RegExp,
    Date:{now:()=>w.now},setTimeout:()=>0,clearTimeout:()=>{},setInterval:()=>0,AbortController:function(){this.abort=()=>{};},
    S:{running:true,entries:w.entries,autoMode:false},sessionGen:1,
    CFG:Object.assign({langA:'ja',langB:'en',sttProvider:'openai',sttModel:'gpt-4o-mini-transcribe',prosodyOn:false,
      segmentMode:'adaptive',segmentBoundary:'semantic'},o.cfg||{}),
    SEG:{cards:[],cardOrder:0,epoch:1,queue:[],committed:0,committedBySource:{},received:{},lastReason:''},
    addEntry:(seat,text,interim)=>{const e={id:'e'+(++n),seat,srcText:text,dstText:'',interim,srcLang:seat==='A'?'ja':'en',dstLang:seat==='A'?'en':'ja',startedAt:w.now};w.entries.push(e);return e;},
    removeEntry:(e)=>{const i=w.entries.indexOf(e);if(i>=0)w.entries.splice(i,1);if(e.segment)e.segment.cancelled=true;},
    render:()=>{},speakSrcNow:()=>{},translate:()=>{},segWake:()=>{},segObserveTempo:()=>{},TurnTrace:{text(){}},
    segReviseCommittedSource:(e,s,r)=>{if(r!==s.sourceText){s.sourceText=r;s.revised=true;}},
    segCurrentTranslation:()=>false,translationDisabled:()=>false,
    segDebt:()=>0,segPolicyFor:()=>({min:12,max:48,stability:400,silence:700,debt:8,mode:'adaptive'}),segBackpressure:()=>false,
    segSilence:()=>null,segApplyMark:()=>false,segEchoCandidate:()=>false,duoAutomaticAllowed:()=>true,
    dlog:(c,m,d)=>w.logs.push({m,d}),hasSpeechContent:(x)=>/[\p{L}\p{N}]/u.test(String(x||'')),isEcho:()=>false,
    toast:()=>{},realtimeEscape:(x)=>x,redact:(x)=>x,attachProsody:()=>{},
    langOf:(seat)=>seat==='A'?'ja':'en',micSeats:()=>['A','B'],duoShouldAutoDetectInput:()=>false,sttAutoDetect:()=>false,
    sttCall:()=>new Promise((res)=>w.calls.push(res))};
  ctx.TurnDecision={rules:(i)=>ctx.segSemanticDecision(i),boundary:(e,s,i,r)=>r};
  vm.createContext(ctx);
  vm.runInContext([block('function segEnabled()'),line('var SEG_PERIOD_WAIT_MS'),block('function segPeriodHold('),block('function segSemanticTail(text,lang){'),
    block('function segSemanticDecision(input){'),block('function segInit('),block('function segJoin('),block('function segReceiveDisplay('),
    block('function segUpdate('),block('function segDraft('),block('function segCheck('),
    block('function fourOSentenceEnds('),block('function fourOSplit('),block('function fourOJoin('),
    block('function fourOCardText('),block('function fourOFinalize('),block('function fourOPlaceAfter('),block('function fourOTailStart('),
    line('var FOURO_CARD_MAX_MS'),block('function fourOOpenText('),block('function fourOTailPending('),
    block('function FourOFileBuffer('),block('FourOFileBuffer.prototype.alive='),block('FourOFileBuffer.prototype.grouping='),
    block('FourOFileBuffer.prototype.openCard='),block('FourOFileBuffer.prototype.entryFor='),block('FourOFileBuffer.prototype.submit='),
    block('FourOFileBuffer.prototype.release='),block('FourOFileBuffer.prototype.drain='),block('FourOFileBuffer.prototype.interrupted='),
    block('FourOFileBuffer.prototype.take='),block('FourOFileBuffer.prototype.flush='),block('FourOFileBuffer.prototype.poll='),block('FourOFileBuffer.prototype.stop=')].join('\n'),ctx);
  const buf=vm.runInContext('new FourOFileBuffer({})',ctx);
  const tick=()=>w.entries.forEach(e=>{if(e.segment)ctx.segCheck(e);});
  // One recording: it ran for `ms`, was cut by `reason`, and its text comes back.
  w.clip=async(text,reason='silence',ms=4000,seat='B')=>{
    const startedAt=w.now;w.now+=ms;
    buf.submit({},seat,null,{reason,seconds:10,carry:true,startedAt,endedAt:w.now});
    w.placeholders=w.entries.length;
    w.now+=900;w.calls.shift()(text);await new Promise(r=>setImmediate(r));tick();};
  w.poll=(silent,quiet)=>{buf.poll(w.now,silent,quiet);tick();};
  w.cards=()=>w.entries.map(e=>({text:e.srcText,open:!!(e.fourOState&&e.fourOState.pending)}));
  w.committed=(e)=>e.segments.filter(s=>s.committedAt).map(s=>s.sourceText);
  w.buf=buf;w.ctx=ctx;return w;
}
const tests=[];const test=async(n,f)=>{await f();tests.push(n);};

const w0=world();
(async()=>{
await test('one speaker going on with short pauses stays in one card, and every sentence is committed as it arrives',async()=>{
  const w=world();
  await w.clip('Our economy is the envy of the world.');
  await w.clip('Our military is the most powerful on Earth.');
  await w.clip('Our technology is second to none.');
  assert.deepEqual(w.cards(),[{text:'Our economy is the envy of the world. Our military is the most powerful on Earth. Our technology is second to none.',open:true}]);
  assert.deepEqual(Array.from(w.committed(w.entries[0])),['Our economy is the envy of the world.',' Our military is the most powerful on Earth.',' Our technology is second to none.'],
    'translation and reading start per sentence, not per card');
});
await test('while a card is open, the next recording makes no placeholder card',async()=>{
  const w=world();
  await w.clip('Our economy is the envy of the world.');
  let during=null;const startedAt=w.now;w.now+=3000;
  w.buf.submit({},'B',null,{reason:'silence',seconds:10,carry:true,startedAt,endedAt:w.now});
  during=w.entries.length;w.calls.shift()('America is rising.');await new Promise(r=>setImmediate(r));
  assert.equal(during,1,'only the open card');
  assert.equal(w.entries.length,1);
  assert.ok(w.logs.some(l=>l.m==='4o-file-result'&&l.d.into==='e1'));
});
await test('an unfinished end waits for the next recording, and goes to translation after 0.9 s without voice',async()=>{
  const w=world();
  await w.clip('We lifted 1.5 million Americans out of');
  assert.deepEqual(Array.from(w.committed(w.entries[0])),[],'nothing to translate yet');
  w.poll(false,300);assert.deepEqual(Array.from(w.committed(w.entries[0])),[],'voice is back');
  w.poll(true,1000);
  assert.deepEqual(Array.from(w.committed(w.entries[0])),['We lifted 1.5 million Americans out of']);
  assert.equal(w.cards()[0].open,true,'the card itself stays open');
  assert.ok(w.logs.some(l=>l.m==='4o-tail-commit'&&l.d.reason==='audio-silence'));
  await w.clip('poverty last year alone.');
  assert.equal(w.entries.length,1);
  assert.deepEqual(Array.from(w.committed(w.entries[0])),['We lifted 1.5 million Americans out of',' poverty last year alone.']);
});
await test('text past the last sentence end is never committed while the card is open, however long it sits',async()=>{
  const w=world();
  await w.clip('It went down over 80 percent. And it will go down','limit');
  w.now+=10000;w.poll(false,100);
  assert.deepEqual(Array.from(w.committed(w.entries[0])),['It went down over 80 percent.']);
});
await test('a decimal cut by the recording limit is joined back: "1." + "5 trillion dollars." is one sentence',async()=>{
  const w=world();
  await w.clip("And this term it'll be 1.",'limit');
  assert.deepEqual(Array.from(w.committed(w.entries[0])),[]);
  await w.clip('5 trillion dollars. We inherited');
  assert.deepEqual(Array.from(w.committed(w.entries[0])),["And this term it'll be 1.5 trillion dollars."]);
});
await test('joining two results: a space after a Latin sentence end, none inside a number or Japanese',async()=>{
  const j=world().ctx.fourOJoin;
  assert.equal(j('It is done.','And then'),'It is done. And then');
  assert.equal(j('Hello,','world'),'Hello, world');
  assert.equal(j("it'll be 1.",'5 trillion'),"it'll be 1.5 trillion");
  assert.equal(j('about 1,','000 people'),'about 1,000 people');
  assert.equal(j('終わりました。','次に'),'終わりました。次に');
  assert.equal(j('We are','going'),'We are going');
});
await test('a 2 s pause closes the card; what follows starts a new one',async()=>{
  const w=world();
  await w.clip('Tourism is thriving.');
  w.poll(true,1500);assert.equal(w.cards()[0].open,true);
  w.poll(true,2000);assert.equal(w.cards()[0].open,false);
  assert.ok(w.logs.some(l=>l.m==='4o-card-final'&&l.d.reason==='audio-pause'));
  await w.clip('Restaurants are bustling.');
  assert.deepEqual(w.cards(),[{text:'Tourism is thriving.',open:false},{text:'Restaurants are bustling.',open:true}]);
});
await test('after 30 s the card closes at a sentence end; the unfinished rest opens the next card and nothing committed moves',async()=>{
  const w=world();
  await w.clip('Before I took office, we had the worst border on Earth.','limit',10000);
  await w.clip('And now we have the most secure border in history.','limit',10000);
  await w.clip('Nobody comes in unless they are invited. In the past','limit',10000);
  assert.deepEqual(w.cards(),[
    {text:'Before I took office, we had the worst border on Earth. And now we have the most secure border in history. Nobody comes in unless they are invited.',open:false},
    {text:'In the past',open:true}]);
  assert.ok(w.logs.some(l=>l.m==='4o-card-split'&&l.d.reason==='max-duration'));
  assert.deepEqual(Array.from(w.committed(w.entries[0])),['Before I took office, we had the worst border on Earth.',' And now we have the most secure border in history.',' Nobody comes in unless they are invited.']);
  assert.ok(!w.entries[0].segments.some(x=>x.revised),'no committed part was rewritten');
  await w.clip('16 months, zero illegal aliens have been admitted.');
  assert.deepEqual(w.cards()[1],{text:'In the past 16 months, zero illegal aliens have been admitted.',open:true});
});
await test('another card in between (the other seat speaks) closes the open card first',async()=>{
  const w=world();
  await w.clip('Our energy is fueling the planet.');
  w.ctx.addEntry('A','はい、そうですね。',false);
  await w.clip('America is rising.');
  assert.deepEqual(w.cards().map(c=>c.text),['Our energy is fueling the planet.','はい、そうですね。','America is rising.']);
  const quiet=world();await quiet.clip('One.');
  const other=quiet.ctx.addEntry('A','',true);other.fourOState={pending:true,reason:'recognizing'};
  quiet.poll(false,100);assert.equal(quiet.cards()[0].open,true,'the other mic has no text yet: it may be noise');
});
await test('a different language from the same seat starts a new card',async()=>{
  const w=world();
  await w.clip('Our nation is growing.');
  w.ctx.duoShouldAutoDetectInput=()=>true;
  w.ctx.duoAssignRecognizedLanguage=(who)=>{who.srcLang='ja';who.dstLang='en';return 'ja';};
  await w.clip('ありがとうございます。');
  assert.deepEqual(w.cards(),[{text:'Our nation is growing.',open:false},{text:'ありがとうございます。',open:true}]);
});
await test('for Aivis, a 4o end committed after a pause counts as the end of what was said',async()=>{
  vm.runInContext(block('function segPartEndsSentence('),w0.ctx);
  const q=(reasons,fo)=>({segment:{sourceText:'We lifted them out of',translationText:'私たちは彼らを',commitReason:reasons,end:21},card:{fourOState:fo,segment:{final:false,text:'We lifted them out of'}}});
  assert.equal(w0.ctx.segPartEndsSentence(q(['stt-final','semantic-final-tail'],{reason:'open'}),false),true);
  assert.equal(w0.ctx.segPartEndsSentence(q(['stt-final','semantic-final-tail'],undefined),false),false,'other engines are unchanged');
});
await test('stopping closes the open card; nothing waits forever',async()=>{
  const w=world();
  await w.clip('Our power is expanding and');
  w.buf.stop();
  assert.equal(w.cards()[0].open,false);
  assert.equal(w.entries[0].segment.final,true);
});
await test('with sequential reading OFF the card still closes per recording, as before',async()=>{
  const w=world({cfg:{segmentMode:'off'}});
  await w.clip('Our economy is the envy of the world.');
  await w.clip('Our military is the most powerful on Earth.');
  assert.equal(w.entries.length,2);
});
console.log(JSON.stringify({test:'4o-cards',passed:tests.length,tests}));
})().catch(e=>{console.error(e);process.exit(1);});
