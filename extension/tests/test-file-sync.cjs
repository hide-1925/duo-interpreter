/* index.html と extension/app.js は同じロジックを手作業で同期している。ビルド手順が
   無いため、判断層のように多数の箇所へ触る変更では片側だけ直す事故が起きやすい。
   改行だけが違う（.gitattributes で拡張は LF 固定、HTML は CRLF）ので、空白を無視
   した一致で検査する。 */
const path=require('node:path'),fs=require('fs'),assert=require('node:assert/strict');

const html=fs.readFileSync(path.join(__dirname,'../../index.html'),'utf8').replace(/\r\n/g,'\n');
const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8').replace(/\r\n/g,'\n');
const squash=s=>s.replace(/[ \t]+/g,' ').replace(/ *\n */g,'\n').trim();

/* 列0の } / }; で閉じる規約に従って最上位ブロックを取り出す。 */
function block(src,startsWith,label){
  const lines=src.split('\n');
  const i=lines.findIndex(l=>l.startsWith(startsWith));
  assert.ok(i>=0,'missing in '+label+': '+startsWith);
  for(let j=i+1;j<lines.length;j++) if(lines[j]==='}'||lines[j]==='};') return lines.slice(i,j+1).join('\n');
  throw new Error('unterminated in '+label+': '+startsWith);
}

const SHARED=[
  'function duoValidateInputs(){',
  'var STT_ADAPTER_CAPABILITIES={',
  'function duoSessionConfig(presetId){',
  'function segDecision(input){',
  'function segSemanticDecision(input){',
  'function segSemanticTail(text,lang){',
  'function segCheck(e){',
  'function segPump(){',
  'function segReviseCommittedSource(e,s,replacement,revision){',
  'function segStartProgress(){',
  'function segCancelAll(why){',
  'function segAudioEvent(msg,data){',
  'function segAdaptiveState(e,debt){',
  'function segCorrectionCounts(e){',
  'var TurnProviders={',
  'var TurnDecision={',
  'var TurnTrace={',
  'ProsodyAnalyzer.prototype.peek=function(windowMs){'
];

const tests=[];
const test=(n,f)=>{f();tests.push(n);};

for(const start of SHARED)
  test('in sync: '+start.replace(/[={(].*$/,''),()=>{
    assert.equal(squash(block(html,start,'index.html')),squash(block(app,start,'app.js')));
  });

/* 一行もの・宣言は行単位で突き合わせる。 */
const LINES=[
  "function segEnabled(){",
  "function segSemanticEnabled(){",
  "function segVoice(seat,rms){",
  "var TURN_STATE_SCHEMA=",
  "  committedBySource:{provider:0,rules:0}, correctedBySource:{provider:0,rules:0}};"
];
for(const start of LINES)
  test('in sync (line): '+start.trim().replace(/[={(].*$/,''),()=>{
    const pick=src=>src.split('\n').filter(l=>l.startsWith(start)).map(squash);
    const a=pick(html),b=pick(app);
    assert.ok(a.length>0,'missing in index.html: '+start);
    assert.deepEqual(a,b);
  });

/* 判断層の設定はどちらのファイルにも同じ既定値で並んでいなければならない。 */
test('turnDecision config defaults match in both files',()=>{
  const pick=src=>(src.match(/\{ prop:"(turnDecision|turnFloor|turnInterrupt|turnTrace)[^\n]*\n/g)||[]).map(squash);
  const a=pick(html),b=pick(app);
  assert.ok(a.length>=15,'expected the turnDecision block, found '+a.length);
  assert.deepEqual(a,b);
});

/* 出荷時の既定は off でなければならない（§15 OFF互換の前提）。 */
test('turnDecisionMode and turnTraceMode ship as off in both files',()=>{
  for(const [src,label] of [[html,'index.html'],[app,'app.js']]){
    assert.match(src,/prop:"turnDecisionMode",[^\n]*def:'off'/,label);
    assert.match(src,/prop:"turnTraceMode",[^\n]*def:'off'/,label);
    assert.match(src,/prop:"turnDecisionProvider",[^\n]*def:'rules'/,label);
    assert.match(src,/prop:"turnDecisionContextTurns",[^\n]*def:'0'/,label);
  }
});

/* index.html は単一HTMLなので、構文エラーを出すと起動そのものが死ぬ。
   CRLF を含むためインラインスクリプトを取り出して構文検査する。 */
test('the index.html inline script parses',()=>{
  const blocks=html.match(/<script>\n([\s\S]*?)\n<\/script>/);
  assert.ok(blocks,'main <script> block not found');
  new (require('node:vm').Script)(blocks[1],{filename:'index.html:inline'});
});
test('extension/app.js parses',()=>{
  new (require('node:vm').Script)(app,{filename:'app.js'});
});

console.log(JSON.stringify({passed:tests.length,tests},null,2));
