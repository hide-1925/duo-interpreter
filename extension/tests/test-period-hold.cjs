'use strict';
/* 英語の「.」で文を切る位置の受入試験。
 * v1.49.37 の記録（gpt-live-transcribe・英語の演説）で、区切りの規則が次の3か所を文の終わりとして確定した。
 * - "And this term it'll be 1." → 続きは "5 trillion dollars." で、訳は「1兆ドルになるでしょう。 1兆5000億ドルです。」
 * - " U.S." → 「アメリカ」だけが1片になり、続けて「米国株式市場…」
 * - "…in Washington, D.C." → 後ろの ", it was riddled with crime" を訳すときに前の文を訳し直し、同じ文が2回読まれた */
const path=require('node:path'),fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const src=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8').replace(/\r\n/g,'\n');
const lines=src.split('\n');
function block(startsWith){
  const i=lines.findIndex(l=>l.startsWith(startsWith));
  assert.ok(i>=0,'block not found: '+startsWith);
  for(let j=i;j<lines.length;j++) if(lines[j]==='}'||lines[j]==='};') return lines.slice(i,j+1).join('\n');
  throw new Error('unterminated: '+startsWith);
}
const line=(p)=>{const l=lines.find(l=>l.startsWith(p));assert.ok(l,'line not found: '+p);return l;};
const ctx={console,String,Object,JSON,Math,Array,RegExp,hasSpeechContent:t=>/[\p{L}\p{N}]/u.test(String(t||''))};
vm.createContext(ctx);
vm.runInContext([line('var SEG_PERIOD_WAIT_MS'),block('function segPeriodHold('),block('function segSemanticTail(text,lang){'),
  block('function segSemanticDecision(input){'),block('function segDecision(input){'),block('function fourOSentenceEnds('),block('function fourOSplit('),
  'function SttLiveHost(){}',block('SttLiveHost.prototype.boundaryContext=')].join('\n'),ctx);
const tests=[];const test=(n,f)=>{f();tests.push(n);};
const P={min:12,max:48,stability:400,silence:700,debt:8};
const sem=(text,o={})=>ctx.segSemanticDecision(Object.assign({text,stableLength:text.length,policy:P,lang:'en-US',idleMs:354,silenceMs:-1,final:false},o));
const plain=(text,o={})=>ctx.segDecision(Object.assign({text,stableLength:text.length,policy:P,mode:'balanced',idleMs:354,silenceMs:-1,debt:0,final:false},o));
const at=(t,needle)=>t.indexOf(needle)+needle.length;

test('which periods are not a sentence end',()=>{
  const h=(t,n)=>ctx.segPeriodHold(t,at(t,n));
  assert.equal(h(' U.S. stock markets',' U.S.'),'skip');
  assert.equal(h('in Washington, D.C.','D.C.'),'wait');
  assert.equal(h("it'll be 1.",'1.'),'wait');
  assert.equal(h('said Mr. Smith','Mr.'),'skip');
  assert.equal(h('fruit, e.g. apples','e.g.'),'skip');
  assert.equal(h('We grew in 2024. Then','2024.'),'','a number followed by the next sentence ends it');
  assert.equal(h('Take plan B. Then','B.'),'','one capital letter is not an initialism');
  assert.equal(h('The answer is no. We','no.'),'');
  assert.equal(h('It works.','works.'),'');
});
test('"1." at the end waits for the next characters, and "1.5 trillion dollars." then goes as one sentence',()=>{
  const a=sem(" And this term it'll be 1.");
  assert.equal(a.length,0);assert.equal(a.waiting,'ambiguous-period');
  const t=" And this term it'll be 1.5 trillion dollars. We inherited";
  assert.equal(sem(t).length,at(t,'dollars.'));
  assert.deepEqual(Array.from(sem(t).reasons),['semantic-sentence','stable']);
});
test('"U.S." and "D.C." are not cut; the sentence ends at its own period',()=>{
  assert.equal(sem(' U.S.').length,0);
  const t=' U.S. stock markets have set 80 all-time records. And';
  assert.equal(sem(t).length,at(t,'records.'));
  const d=' More importantly, when I arrived on January 20th of last year in Washington, D.C.';
  assert.equal(sem(d).length,0,'waits at D.C.');
  const d2=d+', it was riddled with crime. And now';
  assert.equal(sem(d2).length,at(d2,'crime.'));
});
test('a sentence that really ends with a number or initialism is released after 1.2 s without new text, or at the final result',()=>{
  const t=' We grew by 3 percent in 2024.';
  assert.equal(sem(t,{idleMs:1100}).length,0);
  const r=sem(t,{idleMs:1200});assert.equal(r.length,t.length);assert.ok(Array.from(r.reasons).includes('period-idle'));
  assert.equal(sem(' I moved to the U.S.',{final:true}).length,' I moved to the U.S.'.length);
});
test('the plain (non-semantic) rules skip the same periods',()=>{
  const t='The U.S. economy is strong. Next';
  assert.equal(plain(t).length,at(t,'strong.'));
  assert.equal(plain("And this term it'll be 1.").length,0);
  assert.equal(plain("And this term it'll be 1.",{idleMs:1300}).length,"And this term it'll be 1.".length);
});
test('gpt-4o results: an initialism is not a sentence end, and a trailing number waits for the next result',()=>{
  const t='Prices in the U.S. rose sharply. And the';
  assert.deepEqual(Array.from(ctx.fourOSentenceEnds(t)),[at(t,'sharply. ')]);
  const s=ctx.fourOSplit("And this term it'll be 1.",true,true);
  assert.equal(s.ready,'');assert.equal(s.tail,"And this term it'll be 1.");
  assert.equal(ctx.fourOSplit('日本語はそのままです。',true,true).ready,'日本語はそのままです。');
});
test('gpt-live cards: an ambiguous period at the end gets the ordinary wait, a real one the short wait',()=>{
  const b=ctx.SttLiveHost.prototype.boundaryContext;
  assert.equal(b(' in Washington, D.C.','en'),'neutral');
  assert.equal(b(" it'll be 1.",'en'),'neutral');
  assert.equal(b(' crime went down.','en'),'strong');
});
console.log(JSON.stringify({test:'period-hold',passed:tests.length,tests}));
