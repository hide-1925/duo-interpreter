'use strict';
/* 読み上げ側の上限の見え方の受入試験。

   Aivis は公表された固定値（60秒10回）で、上限待ちと再試行を持っている。OpenAI は
   アカウントの usage tier で上限が決まるので、公表値を読んでも自分の枠は分からない。
   実際に効いている値は応答ヘッダに入っているので、そこを読めているかを検査する。
   あわせて 429 を他の失敗と混ぜないこと（上限に当たって読み上げが飛んだのに、
   原因が「TTS 429」だけでは分からない）を検査する。 */
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict');
const src=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8').replace(/\r\n/g,'\n');
const lines=src.split('\n');
function block(startsWith){
  const i=lines.findIndex(l=>l.startsWith(startsWith));
  assert.ok(i>=0,'block not found: '+startsWith);
  for(let j=i+1;j<lines.length;j++) if(lines[j]==='}'||lines[j]==='};') return lines.slice(i,j+1).join('\n');
  throw new Error('unterminated: '+startsWith);
}
/* 1行で書かれた関数や変数は block() では終端が取れないので、行ごと取り出す。 */
function line(startsWith){
  const l=lines.find(l=>l.startsWith(startsWith));
  assert.ok(l!==undefined,'line not found: '+startsWith);
  return l;
}
const logs=[];
const ctx={console,Date,String,Number,Object,Error,JSON,setTimeout,
  dlog:(...a)=>logs.push(a)};
const c=vm.createContext(ctx);
/* ttsRateWaitMs はプロバイダ表を引くので、表そのものではなく引き方だけを差し替える。 */
ctx.ttsProv=(mode)=>ctx.__providers[mode===undefined?ctx.__mode:mode]||{};
ctx.__providers={};ctx.__mode='aivis';
for(const b of ['var OPENAI_LAST_RATE=null;','var openaiRateWarned=false;',
                'var OPENAI_RATE_BLOCK_UNTIL=0;',
                block('function openaiRateBlock(ms){'),
                block('function ttsRateWaitMs(mode){'),
                block('function openaiRetryDelayMs(m){'),
                block('function openaiRateMeta(r){'),
                block('function openaiLogRate(r,where){'),
                block('function openaiTtsHttpError(r,raw,where){')]) vm.runInContext(b,c);

const tests=[],test=(n,f)=>{f();tests.push(n);};
/* fetch の Headers は大小文字を区別しないので、模擬も同じにする。 */
const res=(status,headers)=>({status:status,headers:{get:(n)=>{
  const k=String(n).toLowerCase();
  for(const key of Object.keys(headers||{})) if(key.toLowerCase()===k) return headers[key];
  return null;
}}});

test('the account rate limits are read from the response headers',()=>{
  const m=c.openaiRateMeta(res(200,{
    'x-ratelimit-limit-requests':'500','x-ratelimit-remaining-requests':'499',
    'x-ratelimit-reset-requests':'120ms','x-ratelimit-limit-tokens':'200000',
    'x-ratelimit-remaining-tokens':'199950','x-ratelimit-reset-tokens':'15ms'}));
  assert.equal(m.limitRequests,'500');
  assert.equal(m.remainingRequests,'499');
  assert.equal(m.resetRequests,'120ms');
  assert.equal(m.limitTokens,'200000');
  assert.equal(m.remainingTokens,'199950');
  assert.equal(m.resetTokens,'15ms');
});
test('header names are matched without case sensitivity, as fetch does',()=>{
  const m=c.openaiRateMeta(res(200,{'X-RateLimit-Limit-Requests':'50','Retry-After':'7'}));
  assert.equal(m.limitRequests,'50');
  assert.equal(m.retryAfter,'7');
});
test('a response with no rate headers is not logged, so the log stays readable',()=>{
  logs.length=0;c.OPENAI_LAST_RATE=null;
  c.openaiLogRate(res(200,{'content-type':'audio/wav'}),'speech-wav');
  assert.equal(logs.length,0);
  assert.equal(c.OPENAI_LAST_RATE,null,'and nothing is remembered');
});
test('the limits are logged and remembered so the diagnostics can show them',()=>{
  logs.length=0;c.OPENAI_LAST_RATE=null;
  c.openaiLogRate(res(200,{'x-ratelimit-limit-requests':'500',
    'x-ratelimit-remaining-requests':'498','x-ratelimit-reset-requests':'240ms'}),'speech-stream');
  assert.equal(logs.length,1);
  assert.equal(logs[0][1],'openai-ratelimit');
  assert.equal(logs[0][2].where,'speech-stream');
  assert.equal(logs[0][2].requests,'498/500','the actual account numbers, not a published table');
  assert.ok(c.OPENAI_LAST_RATE&&c.OPENAI_LAST_RATE.limitRequests==='500');
});
test('429 is not mixed in with other failures',()=>{
  const e=c.openaiTtsHttpError(res(429,{'retry-after':'12',
    'x-ratelimit-remaining-requests':'0','x-ratelimit-limit-requests':'500'}),'slow down','speech-wav');
  assert.equal(e.status,429);
  assert.equal(e.rateWait,'12');
  assert.match(e.message,/上限/,'the message has to say it was the limit');
  assert.match(e.message,/飛ばしました/,'and that a piece of audio was dropped');
});
test('the wait falls back to the reset headers when Retry-After is absent',()=>{
  assert.equal(c.openaiTtsHttpError(res(429,{'x-ratelimit-reset-requests':'1.5s'}),'','x').rateWait,'1.5s');
  assert.equal(c.openaiTtsHttpError(res(429,{'x-ratelimit-reset-tokens':'800ms'}),'','x').rateWait,'800ms');
  const bare=c.openaiTtsHttpError(res(429,{}),'','x');
  assert.equal(bare.status,429);
  assert.equal(bare.rateWait,'','no invented number when the server gave none');
});
test('other statuses keep their status and stay generic',()=>{
  const e=c.openaiTtsHttpError(res(401,{}),'{"error":{"message":"bad key"}}','speech-wav');
  assert.equal(e.status,401);
  assert.match(e.message,/^TTS 401/);
  assert.ok(!/上限/.test(e.message));
});
test('a long error body is truncated before it reaches the log or a toast',()=>{
  const e=c.openaiTtsHttpError(res(500,{}),'x'.repeat(5000),'speech-wav');
  assert.ok(e.message.length<200,'got '+e.message.length);
});
test('a 429 still records the limits, so the diagnostics show why it happened',()=>{
  logs.length=0;c.OPENAI_LAST_RATE=null;
  c.openaiTtsHttpError(res(429,{'x-ratelimit-limit-requests':'500',
    'x-ratelimit-remaining-requests':'0','retry-after':'20'}),'','speech-wav');
  assert.ok(logs.some(l=>l[1]==='openai-ratelimit'));
  assert.equal(c.OPENAI_LAST_RATE.remainingRequests,'0');
});

/* ── 上限中はブラウザ内蔵音声へ逃がす ─────────────────────────────────
   待つ設計では待ち行列が伸びる（実測で TTS 待ちが20〜40秒）。声は落ちるが
   間に合うほうを選ぶ、という判断。上限の見え方はプロバイダごとに違うので、
   「あと何ms 塞がっているか」の1つの形に揃えているかを検査する。 */
test('a provider with no rate limit of its own never diverts',()=>{
  ctx.__providers={browser:{label:'ブラウザ'}};ctx.__mode='browser';
  assert.equal(c.ttsRateWaitMs(),0,'no rateWait function means nothing to wait for');
});
test('the remaining block is read from the provider',()=>{
  ctx.__providers={aivis:{label:'Aivis',rateWait:()=>4200}};ctx.__mode='aivis';
  assert.equal(c.ttsRateWaitMs(),4200);
  ctx.__providers.aivis.rateWait=()=>0;
  assert.equal(c.ttsRateWaitMs(),0,'and zero once the window reopens');
});
test('a negative or broken rateWait is treated as open, not as a block',()=>{
  ctx.__providers={aivis:{rateWait:()=>-500}};ctx.__mode='aivis';
  assert.equal(c.ttsRateWaitMs(),0);
  ctx.__providers.aivis.rateWait=()=>null;
  assert.equal(c.ttsRateWaitMs(),0);
});
test('OpenAI is blocked only after a 429, since its ceiling is not knowable in advance',()=>{
  ctx.__providers={openai:{rateWait:()=>Math.max(0,c.OPENAI_RATE_BLOCK_UNTIL-Date.now())}};
  ctx.__mode='openai';
  c.OPENAI_RATE_BLOCK_UNTIL=0;
  assert.equal(c.ttsRateWaitMs(),0,'nothing is avoided until the server says so');
  c.openaiRateBlock(5000);
  assert.ok(c.ttsRateWaitMs()>4000);
});
test('a later block extends the wait but a shorter one never shortens it',()=>{
  c.OPENAI_RATE_BLOCK_UNTIL=0;
  c.openaiRateBlock(30000);const long=c.OPENAI_RATE_BLOCK_UNTIL;
  c.openaiRateBlock(1000);
  assert.equal(c.OPENAI_RATE_BLOCK_UNTIL,long,'a 1s hint must not cancel a 30s block');
});
test('the wait is parsed from whichever header the server sent',()=>{
  assert.equal(c.openaiRetryDelayMs({retryAfter:'12'}),12000,'Retry-After is in seconds');
  assert.equal(c.openaiRetryDelayMs({resetRequests:'120ms'}),120);
  assert.equal(c.openaiRetryDelayMs({resetRequests:'1.5s'}),1500);
  assert.equal(c.openaiRetryDelayMs({resetTokens:'800ms'}),800);
  assert.equal(c.openaiRetryDelayMs({retryAfter:'',resetRequests:'6s'}),6000,'an empty header is skipped');
});
test('an unparseable wait becomes a conservative minute, not zero',()=>{
  assert.equal(c.openaiRetryDelayMs({retryAfter:'Wed, 21 Oct 2026 07:28:00 GMT'}),60000,
    'an HTTP-date is not guessed at; zero would hammer the API');
  assert.equal(c.openaiRetryDelayMs({}),60000);
  assert.equal(c.openaiRetryDelayMs(null),60000);
});
test('a 429 both blocks the provider and keeps the limits for the diagnostics',()=>{
  c.OPENAI_RATE_BLOCK_UNTIL=0;logs.length=0;
  c.openaiTtsHttpError(res(429,{'retry-after':'20',
    'x-ratelimit-remaining-requests':'0','x-ratelimit-limit-requests':'500'}),'','speech-wav');
  assert.ok(c.OPENAI_RATE_BLOCK_UNTIL-Date.now()>19000,'the next utterance must not retry immediately');
  assert.equal(c.OPENAI_LAST_RATE.remainingRequests,'0');
});

/* ── Aivis：予測（こちら側の数え）と事実（429）を混ぜない ─────────────
   Aivis の公表値は60秒10回だが、上位プランでは超過分をクレジットで払う設定に
   できる。つまりこちら側の数えは上限そのものではなく予測でしかない。v1.49.10 は
   この予測で送信を止めてブラウザ内蔵音声へ回していたため、超過分の課金を許可
   しているアカウントでも声が替わっていた。予測と事実を分けられているかを検査する。 */
const mem={};
ctx.store={get:(k,d)=>(k in mem?mem[k]:d),set:(k,v)=>{mem[k]=String(v);},del:(k)=>{delete mem[k];}};
ctx.CFG={};
for(const b of [line('var AIVIS_RATE='),
                block('function aivisRateLoad(){'),
                line('function aivisRateSave(){'),
                block('function aivisOverLimitMode(){'),
                line('function aivisServerWait(){'),
                block('function aivisWindowWait(){'),
                block('function aivisRateWait(){'),
                block('function aivisFallbackWait(){')]) vm.runInContext(b,c);
/* n回ぶんの送信記録を「いま」に寄せて作る。10回で枠を使い切る。 */
const sentNow=(n,agoMs)=>{const now=Date.now();
  c.AIVIS_RATE.sent=[];c.AIVIS_RATE.blockedUntil=0;c.AIVIS_RATE.loaded=true;
  for(let i=0;i<n;i++) c.AIVIS_RATE.sent.push(now-(agoMs===undefined?100:agoMs));};

test('an unknown or empty policy is read as send, so a bad stored value cannot mute Aivis',()=>{
  ctx.CFG.aivisOverLimit='';       assert.equal(c.aivisOverLimitMode(),'send');
  ctx.CFG.aivisOverLimit='nonsense';assert.equal(c.aivisOverLimitMode(),'send');
  ctx.CFG.aivisOverLimit='browser'; assert.equal(c.aivisOverLimitMode(),'browser');
  ctx.CFG.aivisOverLimit='wait';    assert.equal(c.aivisOverLimitMode(),'wait');
});
test('by default the counted window never stops a request, because it is only a prediction',()=>{
  ctx.CFG.aivisOverLimit='send';sentNow(10);
  assert.ok(c.aivisWindowWait()>59000,'the window itself is exhausted');
  assert.equal(c.aivisRateWait(),0,'but sending is not held back');
  assert.equal(c.aivisFallbackWait(),0,'and the voice is not swapped for the browser one');
});
test('the browser policy diverts on the prediction without holding the request',()=>{
  ctx.CFG.aivisOverLimit='browser';sentNow(10);
  assert.ok(c.aivisFallbackWait()>59000,'the segment is read with the built-in voice');
  assert.equal(c.aivisRateWait(),0,'waiting would only lengthen the queue');
});
test('the wait policy restores the behaviour of v1.49.9 and earlier',()=>{
  ctx.CFG.aivisOverLimit='wait';sentNow(10);
  assert.ok(c.aivisRateWait()>59000,'the request waits for the window');
  assert.equal(c.aivisFallbackWait(),0,'and the voice never changes');
});
test('a 429 from Aivis is a fact, so it blocks under every policy',()=>{
  for(const mode of ['send','browser','wait']){
    ctx.CFG.aivisOverLimit=mode;sentNow(0);
    c.AIVIS_RATE.blockedUntil=Date.now()+5000;
    assert.ok(c.aivisServerWait()>4000,mode+': the server block is visible');
    if(mode==='wait') assert.ok(c.aivisRateWait()>4000,'wait: the request waits it out');
    else assert.ok(c.aivisFallbackWait()>4000,mode+': the segment goes to the built-in voice');
  }
});
test('the prediction can never shorten a server block',()=>{
  ctx.CFG.aivisOverLimit='wait';sentNow(10,59000);
  c.AIVIS_RATE.blockedUntil=Date.now()+120000;
  assert.ok(c.aivisWindowWait()<2000,'the window reopens in about a second');
  assert.ok(c.aivisRateWait()>119000,'but the server said two minutes');
});
test('records older than the window are dropped, so the count cannot grow forever',()=>{
  ctx.CFG.aivisOverLimit='browser';sentNow(10,61000);
  assert.equal(c.aivisFallbackWait(),0);
  assert.equal(c.AIVIS_RATE.sent.length,0,'and the old records are gone');
});
test('the wait is measured from the tenth request back, not from the newest one',()=>{
  ctx.CFG.aivisOverLimit='wait';
  const now=Date.now();c.AIVIS_RATE.sent=[];c.AIVIS_RATE.blockedUntil=0;
  for(let i=11;i>=0;i--) c.AIVIS_RATE.sent.push(now-i*1000);   /* 12回、1秒おき */
  const ms=c.aivisRateWait();
  assert.ok(ms>50000&&ms<52000,'expected about 51s, got '+ms);
});
test('the window survives a reload and future timestamps are discarded',()=>{
  const now=Date.now();
  mem['di.aivisRateWindow']=JSON.stringify({sent:[now-1000,now+600000],blockedUntil:now+3000});
  c.AIVIS_RATE.sent=[];c.AIVIS_RATE.blockedUntil=0;c.AIVIS_RATE.loaded=false;
  ctx.CFG.aivisOverLimit='send';
  assert.ok(c.aivisServerWait()>2000,'a block that outlived the reload still holds');
  assert.equal(c.AIVIS_RATE.sent.length,1,'a timestamp from the future is not trusted');
});
test('every option the UI offers is a policy the code understands',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../../index.html'),'utf8');
  const sel=html.match(/<select id="aivisOverLimit">([\s\S]*?)<\/select>/);
  assert.ok(sel,'the picker has to exist in the page');
  const values=[...sel[1].matchAll(/value="([^"]*)"/g)].map(m=>m[1]);
  assert.deepEqual(values,['send','browser','wait']);
  for(const v of values){ctx.CFG.aivisOverLimit=v;
    assert.equal(c.aivisOverLimitMode(),v,v+' must not silently fall back to another policy');}
  const schema=src.match(/\{ prop:"aivisOverLimit"[^\n]*\}/);
  assert.ok(schema&&/def:'send'/.test(schema[0]),
    'the default has to be send, or an account that pays for the overage gets muted');
});

console.log(JSON.stringify({passed:tests.length,tests},null,2));
