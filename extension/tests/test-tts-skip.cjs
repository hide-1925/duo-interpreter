'use strict';
/* 読み上げなかった理由を、言い分けられているかの受入試験。
 *
 * 起点は実測（v1.49.23・HTML単独）。読み上げ対象が「相手(B)の発言のみ」のところへ、
 * 打ち込んだ日本語が自分(A)扱いで入り、4件とも読み上げられなかった。診断には
 * not-selected-or-empty とだけ出ていて、「対象外」なのか「本文が空」なのか
 * 区別できず、画面にも何も出ていなかった（speak() 側には3回で案内する仕組みが
 * あるのに、逐次読み上げの経路には無かった）。 */
const path=require('node:path'),fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const src=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8').replace(/\r\n/g,'\n');
const lines=src.split('\n');
function block(startsWith){
  const i=lines.findIndex(l=>l.startsWith(startsWith));
  assert.ok(i>=0,'block not found: '+startsWith);
  for(let j=i+1;j<lines.length;j++) if(lines[j]==='}'||lines[j]==='};') return lines.slice(i,j+1).join('\n');
  throw new Error('unterminated: '+startsWith);
}
const toasts=[],logs=[];
const ctx={console,String,Object,JSON,
  CFG:{},S:{running:false},
  ttsSkipStreak:0,ttsSkipHinted:false,
  ttsProv:()=>({enabled:ctx.__ttsOn}),
  duoAutomaticAllowed:()=>ctx.__conferenceAllows,
  ttsLoopRisk:()=>ctx.__loopRisk,
  toast:(m)=>toasts.push(m),
  dlog:(...a)=>logs.push(a)};
const c=vm.createContext(ctx);
for(const b of [block('function whoLabel(){'),block('function segSkipWhy(e,s,j){'),block('function segSkipNotice(e,why){')])
  vm.runInContext(b,c);

const tests=[];const test=(n,f)=>{f();tests.push(n);};
function reset(over){
  ctx.CFG=Object.assign({ttsSrc:true,ttsWho:'B2A',preventSelfRecognition:true},over||{});
  ctx.S={running:false};ctx.__ttsOn=true;ctx.__conferenceAllows=true;ctx.__loopRisk=false;
  c.ttsSkipStreak=0;c.ttsSkipHinted=false;toasts.length=0;logs.length=0;
}
const part=(text)=>({sourceText:text,translationText:''});

test('the case that was reported: a typed A line under B2A is named as the target setting',()=>{
  reset();
  assert.equal(c.segSkipWhy({seat:'A',typed:true},part('あふぁふぁ'),{}),'tts-target-B2A');
});
test('the other direction is named the same way',()=>{
  reset({ttsWho:'A2B'});
  assert.equal(c.segSkipWhy({seat:'B'},part('hello'),{}),'tts-target-A2B');
});
test('an empty part is empty, not a target problem',()=>{
  reset();
  assert.equal(c.segSkipWhy({seat:'A'},part('   '),{}),'empty');
});
test('translation mode reads the translation, so an empty translation is empty',()=>{
  reset({ttsSrc:false,ttsWho:'both'});
  assert.equal(c.segSkipWhy({seat:'A'},{sourceText:'こんにちは',translationText:''},{}),'empty');
});
test('read-aloud switched off is its own reason',()=>{
  reset({ttsWho:'both'});ctx.__ttsOn=false;
  assert.equal(c.segSkipWhy({seat:'A'},part('こんにちは'),{}),'tts-off');
});
test('the conference original-only mode is its own reason',()=>{
  reset({ttsWho:'both'});ctx.__conferenceAllows=false;
  assert.equal(c.segSkipWhy({seat:'A'},part('こんにちは'),{}),'conference-original-only');
});
test('the self-recognition guard is its own reason, and only while running',()=>{
  reset({ttsWho:'both'});ctx.__loopRisk=true;
  assert.equal(c.segSkipWhy({seat:'A'},part('こんにちは'),{}),'not-selected','stopped: the guard does not apply');
  ctx.S.running=true;
  assert.equal(c.segSkipWhy({seat:'A'},part('こんにちは'),{}),'self-recognition-guard');
});
test('typed text is explained the first time, because the user asked for it explicitly',()=>{
  reset();
  c.segSkipNotice({seat:'A',typed:true},'tts-target-B2A');
  assert.equal(toasts.length,1);
  assert.match(toasts[0],/自分\(A\)/);
  assert.match(toasts[0],/相手\(B\)の発言のみ/);
  assert.match(toasts[0],/読み上げ対象/);
});
test('spoken text keeps the old patience: three in a row before a word',()=>{
  reset();
  c.segSkipNotice({seat:'A'},'tts-target-B2A');
  c.segSkipNotice({seat:'A'},'tts-target-B2A');
  assert.equal(toasts.length,0);
  c.segSkipNotice({seat:'A'},'tts-target-B2A');
  assert.equal(toasts.length,1);
});
test('the hint is said once, not on every line',()=>{
  reset();
  for(let n=0;n<5;n++)c.segSkipNotice({seat:'A',typed:true},'tts-target-B2A');
  assert.equal(toasts.length,1);
  assert.equal(logs.filter(a=>a[1]==='skip').length,5,'every skip is still logged');
});
test('reasons other than the target setting never raise the hint',()=>{
  reset();
  for(const why of ['empty','tts-off','conference-original-only','self-recognition-guard','translation-error'])
    c.segSkipNotice({seat:'A',typed:true},why);
  assert.equal(toasts.length,0);
});

console.log(JSON.stringify({passed:tests.length,tests},null,2));
