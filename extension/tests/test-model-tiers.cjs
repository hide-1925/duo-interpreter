'use strict';
/* 翻訳モデル（OpenAI）の初期表示の受入試験。
 * 初期表示（主要）は 5.6系の luna・terra・sol と、6系の日付なしモデル。
 * 日付付きのスナップショットと、5.6系のほかの版は「その他」に回す。 */
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
/* 内蔵リストは本物をそのまま使う（並び順と備考もここから来る） */
const provStart=lines.findIndex(l=>l.startsWith('var PROVIDERS = {'));
const provEnd=lines.findIndex((l,i)=>i>provStart&&l==='};');
const ctx={console,String,Object,JSON,Math,Array};
vm.createContext(ctx);
vm.runInContext([lines.slice(provStart,provEnd+1).join('\n'),block('function normList('),block('function knownNoteFor('),
  block('function sortByCuratedOrder('),line('function hubProviderOk('),line('var OPENAI_PRIMARY_56'),line('function modelIdDated('),block('function openaiPrimaryModel('),
  block('function tierModels(')].join('\n'),ctx);
const ids=(arr)=>Array.from(arr,m=>m.id);
const tests=[];const test=(n,f)=>{f();tests.push(n);};

test('before a list is fetched, the initial view is the three 5.6 models',()=>{
  const t=ctx.tierModels(ctx.PROVIDERS.openai.models,'openai');
  assert.deepEqual(ids(t.primary),['gpt-5.6-luna','gpt-5.6-terra','gpt-5.6-sol']);
  assert.ok(ids(t.rest).includes('gpt-5.5')&&ids(t.rest).includes('gpt-4o-mini'));
});
test('a fetched list shows luna, terra, sol and every undated gpt-6 model, and nothing else',()=>{
  const fetched=['gpt-4o-mini','gpt-5.5','gpt-5.6-luna','gpt-5.6-luna-2026-08-14','gpt-5.6-terra','gpt-5.6-sol','gpt-5.6-pro',
    'gpt-6-luna','gpt-6-luna-2026-09-10','gpt-6-sol','gpt-6-stra','gpt-6.1-sol','gpt-6-sol-0910','gpt-60-x'];
  const t=ctx.tierModels(fetched,'openai');
  assert.deepEqual(ids(t.primary),['gpt-5.6-luna','gpt-5.6-terra','gpt-5.6-sol','gpt-6-luna','gpt-6-sol','gpt-6-stra','gpt-6.1-sol']);
  assert.deepEqual(ids(t.rest).sort(),['gpt-4o-mini','gpt-5.5','gpt-5.6-luna-2026-08-14','gpt-5.6-pro','gpt-6-luna-2026-09-10','gpt-6-sol-0910','gpt-60-x'].sort());
});
test('the built-in notes still follow the fetched ids',()=>{
  const t=ctx.tierModels(['gpt-5.6-luna','gpt-6-sol'],'openai');
  assert.match(t.primary[0].note,/同時通訳におすすめ/);
});
test('dated ids are recognized in both forms',()=>{
  assert.equal(ctx.modelIdDated('gpt-6-luna-2026-09-10'),true);
  assert.equal(ctx.modelIdDated('gpt-4-0613'),true);
  assert.equal(ctx.modelIdDated('gpt-6-luna'),false);
  assert.equal(ctx.modelIdDated('gpt-6.1'),false);
});
test('other providers are not split',()=>{
  const t=ctx.tierModels(['grok-4','grok-3-mini'],'xai');
  assert.deepEqual(ids(t.primary),['grok-4','grok-3-mini']);assert.equal(t.rest.length,0);
});

console.log(JSON.stringify({test:'model-tiers',passed:tests.length}));
