'use strict';
/* Groq の翻訳モデルの受入試験。Groq は 2026年8月16日で Llama 3.1 8B Instant／3.3 70B Versatile の
 * 提供を終えた（LiteLLM のモデル一覧にも、翻訳に使える Groq のモデルは gpt-oss-20b・gpt-oss-120b・qwen3.8-27b
 * しか無い）。内蔵の一覧の先頭（＝既定）が Llama のままだと、一覧を取り直す前の翻訳が失敗する。 */
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
const provStart=lines.findIndex(l=>l.startsWith('var PROVIDERS = {'));
const provEnd=lines.findIndex((l,i)=>i>provStart&&l==='};');
const recoStart=lines.findIndex(l=>l.startsWith('var GROQ_RECO = {'));
const recoEnd=lines.findIndex((l,i)=>i>recoStart&&l==='};');
function world(cfg){
  const saved={};
  const ctx={console,String,Object,JSON,Math,Array,CFG:Object.assign({},cfg),persistSetting:(k,v)=>{saved[k]=v;}};
  vm.createContext(ctx);
  vm.runInContext([lines.slice(provStart,provEnd+1).join('\n'),lines.slice(recoStart,recoEnd+1).join('\n'),block('function normList('),
    line('var GROQ_RETIRED'),line('var GROQ_MODEL_FIXED'),block('function groqRetiredModelFix('),line('function firstId('),line('function defaultModel(')].join('\n'),ctx);
  return {ctx,saved};
}
const tests=[];const test=(n,f)=>{f();tests.push(n);};
const RETIRED=/^llama-3\.[13]-/;

test('the built-in Groq list starts with the fastest current model and has no retired Llama',()=>{
  const {ctx}=world({});
  const ids=Array.from(ctx.normList(ctx.PROVIDERS.groq.models),m=>m.id);
  assert.deepEqual(ids,['openai/gpt-oss-20b','openai/gpt-oss-120b','qwen/qwen3.8-27b']);
  assert.equal(ctx.defaultModel('groq'),'openai/gpt-oss-20b');
});
test('Groq recommendations name only current models; speed puts gpt-oss-20b first',()=>{
  const {ctx}=world({});
  Object.keys(ctx.GROQ_RECO.text).forEach(k=>ctx.GROQ_RECO.text[k].forEach(id=>assert.ok(!RETIRED.test(id),k+': '+id)));
  assert.equal(ctx.GROQ_RECO.text.speed[0],'openai/gpt-oss-20b');
  assert.equal(ctx.GROQ_RECO.stt.speed[0],'whisper-large-v3-turbo');
});
test('a saved retired Groq model is replaced with gpt-oss-20b and stored',()=>{
  const w=world({provider:'groq',model:'llama-3.3-70b-versatile'});
  assert.equal(w.ctx.groqRetiredModelFix(),true);
  assert.equal(w.ctx.CFG.model,'openai/gpt-oss-20b');assert.equal(w.saved.model,'openai/gpt-oss-20b');
  assert.deepEqual(JSON.parse(JSON.stringify(w.ctx.GROQ_MODEL_FIXED)),{from:'llama-3.3-70b-versatile',to:'openai/gpt-oss-20b'});
  const w2=world({provider:'groq',model:'llama-3.1-8b-instant'});assert.equal(w2.ctx.groqRetiredModelFix(),true);
});
test('nothing else is touched: current Groq models, and Llama on other providers',()=>{
  const a=world({provider:'groq',model:'openai/gpt-oss-120b'});assert.equal(a.ctx.groqRetiredModelFix(),false);assert.equal(a.ctx.CFG.model,'openai/gpt-oss-120b');
  const b=world({provider:'openrouter',model:'meta-llama/llama-3.3-70b-instruct'});assert.equal(b.ctx.groqRetiredModelFix(),false);
  const c=world({provider:'together',model:'llama-3.3-70b-versatile'});assert.equal(c.ctx.groqRetiredModelFix(),false);
  assert.deepEqual(a.saved,{});assert.deepEqual(b.saved,{});
});
console.log(JSON.stringify({test:'groq-models',passed:tests.length,tests}));
