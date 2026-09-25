'use strict';
/* 「Web会議マイク音声」ボタン1つで、字幕対象 → HTML本体 → 翻訳開始 → 会議送出 まで
 * 通す経路の受入試験。
 *
 * 起点は実測（v1.49.21・Teams）。会議へ声が届かなかった時間帯のログでは、
 * TTSがoffのまま送出を2回拒否され、有効化できた区間でも読み上げ2件がどちらも
 * webConferenceMicEnabled:false の瞬間に鳴っていた。手順が4つに分かれていて、
 * どれか1つが抜けても「押したのに届かない」になる。
 *
 * ここで縛るのは順番と「飛ばし方」と「止まり方」。前の手順が失敗したら
 * 後ろを実行しない（会議マイクだけONになる状態を作らない）。 */
const path=require('node:path'),fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const sw=fs.readFileSync(path.join(__dirname,'../service-worker.js'),'utf8').replace(/\r\n/g,'\n');
const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8').replace(/\r\n/g,'\n');
function block(src,startsWith){
  const lines=src.split('\n');
  const i=lines.findIndex(l=>l.startsWith(startsWith));
  assert.ok(i>=0,'block not found: '+startsWith);
  for(let j=i+1;j<lines.length;j++) if(lines[j]==='}'||lines[j]==='};') return lines.slice(i,j+1).join('\n');
  throw new Error('unterminated: '+startsWith);
}

const calls=[];
const ctx={console,URL,setTimeout,clearTimeout,Date,JSON,Object,String,Number,Math,parseInt,isFinite,
  CFG:{},
  chrome:{scripting:{executeScript:async()=>[{result:ctx.__startResult}]}},
  getState:async()=>ctx.__state,
  setCaptionTarget:async(tabId)=>{calls.push('caption:'+tabId);ctx.__state={...ctx.__state,targetTabId:tabId};return ctx.__state;},
  openHtmlSource:async(settings,activate)=>{calls.push('open:'+String(settings)+':'+String(activate));ctx.__state={...ctx.__state,...ctx.__afterOpen};return {ok:true};},
  conferencePublic:()=>({active:ctx.__conferenceActive,pending:false,error:''}),
  conferenceQueue:(fn)=>Promise.resolve().then(fn),
  conferenceToggle:async()=>{calls.push('conference');if(ctx.__conferenceError)throw Error(ctx.__conferenceError);ctx.__conferenceActive=true;return {ok:true};}};
const c=vm.createContext(ctx);
for(const b of [block(sw,'async function waitForHtmlSource('),
                block(sw,'async function startHtmlRecognition('),
                block(sw,'async function oneTouchStart('),
                block(app,'function sttSilenceHoldMs(){')]) vm.runInContext(b,c);

const tests=[];const test=(n,f)=>tests.push([n,f]);
function reset(over){
  calls.length=0;
  ctx.__state=Object.assign({targetTabId:null,htmlTabId:null,htmlDocumentId:null,htmlLastReceived:null,htmlRunning:false},over&&over.state||{});
  ctx.__afterOpen=(over&&over.afterOpen)||{htmlTabId:7,htmlDocumentId:'doc',htmlLastReceived:1};
  ctx.__startResult=(over&&over.startResult)||{ok:true,running:true};
  ctx.__conferenceActive=!!(over&&over.conferenceActive);
  ctx.__conferenceError=(over&&over.conferenceError)||'';
}
const steps=(r)=>r.steps.map(s=>s.step+(s.ok?'':'!')).join(',');

test('nothing set up yet: all four run, in order',async()=>{
  reset();
  const r=await c.oneTouchStart(2,{url:'popup'});
  assert.equal(r.ok,true);
  assert.equal(steps(r),'caption-target,html,start,conference');
  assert.deepEqual(calls.slice(0,2),['caption:2','open:false:false']);
  assert.equal(calls.at(-1),'conference');
});
test('the HTML tab is opened in the background, never brought to the front',async()=>{
  /* 前面に出すとポップアップが焦点を失って閉じ、残りの手順が中断される。 */
  reset();
  await c.oneTouchStart(2,{url:'popup'});
  assert.ok(calls.includes('open:false:false'),'activate must be false: '+calls.join(' '));
});
test('a step already satisfied is skipped, not repeated',async()=>{
  reset({state:{targetTabId:2,htmlTabId:7,htmlDocumentId:'doc',htmlLastReceived:1,htmlRunning:true},conferenceActive:false});
  const r=await c.oneTouchStart(2,{url:'popup'});
  assert.equal(steps(r),'caption-target,html,start,conference');
  assert.deepEqual(calls,['conference'],'only the missing step may act');
});
test('an active conference is not toggled again, which would switch it off',async()=>{
  reset({state:{targetTabId:2,htmlTabId:7,htmlDocumentId:'doc',htmlLastReceived:1,htmlRunning:true},conferenceActive:true});
  const r=await c.oneTouchStart(2,{url:'popup'});
  assert.equal(r.ok,true);
  assert.deepEqual(calls,[],'pressing it again must not tear down what is already up');
});
test('a different tab replaces the caption target',async()=>{
  reset({state:{targetTabId:5,htmlTabId:7,htmlDocumentId:'doc',htmlLastReceived:1,htmlRunning:true}});
  await c.oneTouchStart(2,{url:'popup'});
  assert.ok(calls.includes('caption:2'));
});
test('the HTML never answering stops the run before recognition and before the mic',async()=>{
  reset({afterOpen:{}});
  const r=await c.oneTouchStart(2,{url:'popup'});
  assert.equal(r.ok,false);
  assert.equal(steps(r),'caption-target,html!');
  assert.ok(!calls.includes('conference'),'the conference mic must not go on by itself');
});
test('recognition failing stops the run, so the mic never opens without audio',async()=>{
  reset({startResult:{ok:false,error:'開始条件が足りません'}});
  const r=await c.oneTouchStart(2,{url:'popup'});
  assert.equal(r.ok,false);
  assert.equal(steps(r),'caption-target,html,start!');
  assert.equal(r.steps.at(-1).detail,'開始条件が足りません');
  assert.ok(!calls.includes('conference'));
});
test('an older HTML build is reported as such, not as a silent failure',async()=>{
  reset({state:{targetTabId:2,htmlTabId:7,htmlDocumentId:'doc',htmlLastReceived:1}});
  ctx.chrome.scripting.executeScript=async(o)=>{
    /* 実際に注入される関数をそのまま通す。古い本体には window.duoExtensionStart が無い。
       注入関数はVM側で作られるので、window はこのコンテキストのものを見る。 */
    ctx.window={};
    try{ return [{result:o.func()}]; } finally { delete ctx.window; }
  };
  const r=await c.oneTouchStart(2,{url:'popup'});
  ctx.chrome.scripting.executeScript=async()=>[{result:ctx.__startResult}];
  assert.equal(r.ok,false);
  assert.match(r.steps.at(-1).detail,/更新/);
});
test('the conference error is passed through as the step that stopped',async()=>{
  reset({state:{targetTabId:2,htmlTabId:7,htmlDocumentId:'doc',htmlLastReceived:1,htmlRunning:true},
    conferenceError:'会議マイク送出は現在TeamsのWeb版に対応しています'});
  const r=await c.oneTouchStart(2,{url:'popup'});
  assert.equal(r.ok,false);
  assert.equal(steps(r),'caption-target,html,start,conference!');
  assert.match(r.steps.at(-1).detail,/Teams/);
});

/* ── 遅延に直接効く唯一の固定値 ─────────────────────────────────────────
   実測の内訳は 無音待ち0.9秒 → 転写0.69〜2.33秒 → 読み上げ先頭0.27〜0.39秒。
   転写はこちらの時間ではないので、縮められるのはここだけ。 */
test('the silence hold defaults to the value the measurements were taken at',()=>{
  ctx.CFG={};assert.equal(c.sttSilenceHoldMs(),900);
  ctx.CFG={sttSilenceHoldMs:''};assert.equal(c.sttSilenceHoldMs(),900);
  ctx.CFG={sttSilenceHoldMs:'not a number'};assert.equal(c.sttSilenceHoldMs(),900);
});
test('the silence hold is clamped, since 0 would cut on every pause',()=>{
  ctx.CFG={sttSilenceHoldMs:'0'};assert.equal(c.sttSilenceHoldMs(),200);
  ctx.CFG={sttSilenceHoldMs:'-500'};assert.equal(c.sttSilenceHoldMs(),200);
  ctx.CFG={sttSilenceHoldMs:'99999'};assert.equal(c.sttSilenceHoldMs(),2000);
  ctx.CFG={sttSilenceHoldMs:'350'};assert.equal(c.sttSilenceHoldMs(),350);
});

(async()=>{
  const names=[];
  for(const [n,f] of tests){ await f(); names.push(n); }
  console.log(JSON.stringify({passed:names.length,tests:names},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
